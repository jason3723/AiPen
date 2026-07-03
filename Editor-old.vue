<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, Decoration, type DecorationSet, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { EditorState, type Extension, Compartment, StateEffect, StateField } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { defaultKeymap, history, historyKeymap, undo, redo } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle, foldGutter, foldKeymap, foldService } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { languages } from '@codemirror/language-data'
import { search, searchKeymap, openSearchPanel, closeSearchPanel } from '@codemirror/search'
import { open } from '@tauri-apps/plugin-dialog'
import { appLocalDataDir, join } from '@tauri-apps/api/path'
import { writeFile, mkdir } from '@tauri-apps/plugin-fs'
import { useDocumentStore } from '../stores/document'
import { useMaterialStore } from '../stores/materialStore'

const props = defineProps<{ modelValue: string; readonly?: boolean; editMode?: "document" | "material"; materialId?: string }>()
const emit = defineEmits<{
  'update:modelValue': [value: string];
  'clip-material': [text: string];
  'insert-to-chat': [text: string];
  'delete-material': [selectionStart: number];
  'remove-from-tag': [selectionStart: number];
}>()

const docStore = useDocumentStore();
const materialStore = useMaterialStore();

const editorRef = ref<HTMLDivElement>()
let view: EditorView | null = null
let syncing = false // 防循环标记
let _highlightTimer: ReturnType<typeof setTimeout> | null = null
const editableCompartment = new Compartment()
const themeCompartment = new Compartment()

// ── Diff 高亮装饰器 ──
const addHighlight = StateEffect.define<{ from: number; to: number }>()
const clearHighlights = StateEffect.define()

const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decos, tr) {
    for (const e of tr.effects) {
      if (e.is(clearHighlights)) return Decoration.none
      if (e.is(addHighlight)) {
        const mark = Decoration.mark({ class: 'cm-diff-highlight' })
        return Decoration.set([mark.range(e.value.from, e.value.to)])
      }
    }
    return decos
  },
  provide: (f) => EditorView.decorations.from(f),
})

// ── 左侧行号栏：高亮当前光标所在行 ────────────────────────────
const activeLineGutterHighlighter = ViewPlugin.fromClass(
  class {
    private el: HTMLElement | null = null
    constructor(readonly view: EditorView) {
      this.sync()
    }
    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged) {
        this.sync()
      }
    }
    sync() {
      if (this.el) {
        this.el.classList.remove('cm-activeLineGutter')
        this.el = null
      }
      const line = this.view.state.doc.lineAt(this.view.state.selection.main.head)
      const gutter = this.view.dom.querySelector('.cm-lineNumbers')
      if (!gutter) return
      const num = String(line.number)
      for (let i = 0; i < gutter.children.length; i++) {
        const child = gutter.children[i] as HTMLElement
        if (child.textContent === num) {
          this.el = child
          this.el.classList.add('cm-activeLineGutter')
          break
        }
      }
    }
    destroy() {
      if (this.el) this.el.classList.remove('cm-activeLineGutter')
    }
  },
)

// ── 字体大小调节 ──────────────────────────────────────────────
const fontSize = ref(Number(localStorage.getItem('editor-fontSize') || 14))
let fontSizeSaveTimer: ReturnType<typeof setTimeout> | null = null
function setFontSize(size: number) {
  const clamped = Math.max(10, Math.min(32, size))
  fontSize.value = clamped
  // 通知 CodeMirror 重新测量布局，确保行号与内容行高同步
  nextTick(() => view?.requestMeasure())
  if (fontSizeSaveTimer) clearTimeout(fontSizeSaveTimer)
  fontSizeSaveTimer = setTimeout(() => {
    localStorage.setItem('editor-fontSize', String(clamped))
  }, 300)
}
function zoomIn() { setFontSize(fontSize.value + 2) }
function zoomOut() { setFontSize(fontSize.value - 2) }

// ── 字体选择 ──────────────────────────────────────────────────
const fontOptions = [
  '等线',
  '微软雅黑',
  '宋体',
  '黑体',
  '楷体',
  '仿宋',
  '京華老宋体',
  '华文楷体',
  '华文宋体',
  '方正仿宋简体',
]
const fontFamily = ref(localStorage.getItem('editor-fontFamily') || '等线')
function setFontFamily(f: string) {
  fontFamily.value = f
  localStorage.setItem('editor-fontFamily', f)
  // 通知 CodeMirror 重新测量布局，确保行号与内容行高同步
  nextTick(() => view?.requestMeasure())
}

// ── 主题切换 ────────────────────────────────────────────────
const isLight = ref(localStorage.getItem('editor-theme') === 'light')

// ★ 浅色主题：通过 EditorView.theme() 与 oneDark 同机制管理，确保光标颜色

const lightTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#ffffff' },
    '.cm-content': { color: '#1a1a1a', caretColor: '#000000' },
    '.cm-cursor, .cm-cursor-secondary, .cm-dropCursor': { borderLeftColor: '#000000' },
    '.cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'rgba(3, 102, 214, 0.15)' },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-gutters': { backgroundColor: '#fafbfc', color: '#656d76', borderRight: '1px solid #d0d7de !important' },
    '.cm-foldGutter .cm-gutterElement': { color: '#8b949e' },
    '.cm-foldGutter .cm-gutterElement:hover': { color: '#24292f' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(59, 130, 246, 0.1)', color: '#2563eb' },
    '.cm-search': { backgroundColor: '#f6f8fa', borderBottom: '1px solid #d0d7de' },
    '.cm-search input[type="text"]': { backgroundColor: '#fff', borderColor: '#d0d7de', color: '#24292f' },
    '.cm-search label': { color: '#24292f' },
    '.cm-search button': { backgroundColor: '#f6f8fa', borderColor: '#d0d7de', color: '#24292f' },
    '.cm-search button:hover': { backgroundColor: '#eaeef2' },
  },
  { dark: false },
)

function toggleTheme() {
  isLight.value = !isLight.value
  localStorage.setItem('editor-theme', isLight.value ? 'light' : 'dark')
  if (!view) return
  const v = view
  // 主题扩展由 Compartment 统一管理：浅色=lightTheme，深色=oneDark
  // 这样光标（cm-cursor/cm-cursor-secondary）颜色由 CodeMirror 内部主题系统
  // 保证，不会出现外部 CSS 时序不一致导致的忽黑忽白问题
  v.dispatch({ effects: themeCompartment.reconfigure(isLight.value ? lightTheme : oneDark) })
  // 轻触选中态强制 drawSelection 立即重绘光标
  const sel = v.state.selection.main
  v.dispatch({ selection: { anchor: sel.anchor, head: sel.head }, scrollIntoView: false })
  requestAnimationFrame(() => v.requestMeasure())
}

// ── 右键菜单状态（Teleport 渲染替代原生 DOM 拼接） ────────────
const ctxMenuShow = ref(false)
const ctxMenuX = ref(0)
const ctxMenuY = ref(0)
const ctxMenuSelStart = ref(0)
const ctxMenuSelEnd = ref(0)
const ctxMenuSelText = ref('')

function closeCtxMenu() { ctxMenuShow.value = false }

function execCtxMenuCut() {
  if (!view || !ctxMenuSelText.value) return
  navigator.clipboard.writeText(ctxMenuSelText.value)
  view.dispatch({ changes: { from: ctxMenuSelStart.value, to: ctxMenuSelEnd.value } })
  view.focus()
  closeCtxMenu()
}
function execCtxMenuCopy() {
  if (!view || !ctxMenuSelText.value) return
  navigator.clipboard.writeText(ctxMenuSelText.value)
  view.focus()
  closeCtxMenu()
}
async function execCtxMenuPaste() {
  if (!view) return
  try {
    const text = await navigator.clipboard.readText()
    if (text) {
      const sel = view.state.selection.main
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text } })
    }
  } catch { /* 剪贴板读取失败 */ }
  view.focus()
  closeCtxMenu()
}
function execCtxMenuAddToChat() {
  docStore.injectedChatText = ctxMenuSelText.value
  docStore.sidebarTab = 'chat'
  closeCtxMenu()
}

function execCtxMenuClip() {
  if (ctxMenuSelText.value) {
    materialStore.openClipDialog(ctxMenuSelText.value)
  }
  closeCtxMenu()
}

function execCtxMenuInsertToChat() {
  if (ctxMenuSelText.value) {
    emit('insert-to-chat', ctxMenuSelText.value)
  }
  closeCtxMenu()
}

function execCtxMenuDeleteMaterial() {
  emit('delete-material', ctxMenuSelStart.value)
  closeCtxMenu()
}
function execCtxMenuRemoveFromTag() {
  emit('remove-from-tag', ctxMenuSelStart.value)
  closeCtxMenu()
}

// ── 粘贴图片处理 ────────────────────────────────────────────
async function handleImagePaste(item: DataTransferItem, editorView: EditorView) {
  const blob = item.getAsFile()
  if (!blob) return

  const ext = item.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
  const buffer = await blob.arrayBuffer()
  const data = new Uint8Array(buffer)

  try {
    const baseDir = await appLocalDataDir()
    const imagesDir = await join(baseDir, 'images')
    await mkdir(imagesDir, { recursive: true })

    const fileName = `img_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`
    const filePath = await join(imagesDir, fileName)
    await writeFile(filePath, data)

    const { from, to } = editorView.state.selection.main
    editorView.dispatch({
      changes: { from, to, insert: `![${fileName}](${filePath})` },
    })
  } catch (e) {
    console.error('图片保存失败:', e)
  }
}

// ── 自定义 Markdown 折叠服务（标题 + 段落）──
const headingFoldService = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart)
  const text = line.text

  // 跳过空行
  if (!text.trim()) return null

  // 跳过代码围栏（交给 markdown 内置折叠处理）
  if (/^(```|~~~)/.test(text)) return null

  // ▸ 标题折叠：折叠所属全部子内容（仅在段首生效）
  const heading = text.match(/^(#{1,6})\s/)
  if (heading) {
    // 标题折叠只在该行为段首时提供
    if (line.number > 1) {
      const prev = state.doc.line(line.number - 1)
      if (prev.text.trim()) return null
    }
    const level = heading[1].length
    const from = line.to
    let to = state.doc.length
    for (let i = line.number + 1; i <= state.doc.lines; i++) {
      const nl = state.doc.line(i)
      const nm = nl.text.match(/^(#{1,6})\s/)
      if (nm && nm[1].length <= level) { to = nl.from; break }
    }
    while (to > from && state.doc.sliceString(to - 1, to) === '\n') to--
    if (to <= from) return null
    return { from, to }
  }

  // ▸ 普通段折叠：折叠本段自身（保留换行符，避免显示错位）
  const to = line.number < state.doc.lines ? line.to - 1 : line.to
  if (to <= line.from) return null
  return { from: line.from, to }
})

// ── 创建 CodeMirror 编辑器 ──────────────────────────────────
function createEditor() {
  const el = editorRef.value
  if (!el || view) return

  const extensions: Extension[] = [
    themeCompartment.of(isLight.value ? lightTheme : oneDark),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    history(),
    foldGutter(),
    headingFoldService,
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap]),
    search({ top: true }),
    EditorState.phrases.of({
      "Find": "查找",
      "Replace": "替换",
      "next": "下一个",
      "previous": "上一个",
      "all": "全部",
      "match case": "区分大小写",
      "regexp": "正则",
      "by word": "全词匹配",
      "replace": "替换",
      "replace all": "全部替换",
      "close": "关闭",
      "Go to line": "跳到行",
      "go": "跳转",
      "current match": "当前匹配",
      "on line": "行",
      "replaced match on line $": "已替换第 $ 行的匹配项",
      "replaced $ matches": "已替换 $ 处",
    }),
    lineNumbers(),
    highlightActiveLine(),
    activeLineGutterHighlighter,
    drawSelection(),
    EditorView.lineWrapping,
    EditorState.tabSize.of(2),
    editableCompartment.of(EditorView.editable.of(!props.readonly)),
    highlightField,
    EditorView.updateListener.of((update) => {
      if (update.docChanged && !syncing) {
        emit('update:modelValue', update.state.doc.toString())
      }
    }),
    // 图片粘贴：截图/Ctrl+V → 保存到本地 → 插入 ![fileName](path)
    EditorView.domEventHandlers({
      paste(event, editorView) {
        const items = event.clipboardData?.items
        if (!items) return false
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith('image/')) {
            event.preventDefault()
            handleImagePaste(items[i], editorView).catch(err => console.error('图片粘贴失败:', err))
            return true
          }
        }
        return false
      },
      contextmenu(event, editorView) {
        event.preventDefault()
        const sel = editorView.state.selection.main
        ctxMenuSelStart.value = sel.from
        ctxMenuSelEnd.value = sel.to
        ctxMenuSelText.value = editorView.state.sliceDoc(sel.from, sel.to)
        ctxMenuX.value = event.clientX
        ctxMenuY.value = event.clientY
        ctxMenuShow.value = true
        return true
      },
      wheel(event, _editorView) {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault()
          setFontSize(fontSize.value + (event.deltaY > 0 ? -2 : 2))
          return true
        }
        return false
      },
    }),
  ]

  const state = EditorState.create({
    doc: props.modelValue || '',
    extensions,
  })

  view = new EditorView({ state, parent: el })
}

onMounted(() => {
  // 延迟创建，确保 DOM 就绪
  requestAnimationFrame(createEditor)
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

// ── 响应外部 content 变更（切换文档、加载版本等） ──────────────
watch(
  () => props.modelValue,
  async (newVal) => {
    if (!view) return
    await nextTick()
    if (!view) return
    const current = view.state.doc.toString()
    if (newVal !== current) {
      syncing = true
      // 流式追加优化：如果新内容以当前内容为前缀，只追加增量部分
      if (newVal && newVal.startsWith(current)) {
        view.dispatch({
          changes: { from: current.length, insert: newVal.slice(current.length) },
        })
      } else {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: newVal || '' },
        })
      }
      syncing = false
    }
  },
)

// ── 响应只读状态变更 ──────────────────────────────────────────
watch(
  () => props.readonly,
  (isReadonly) => {
    if (!view) return
    view.dispatch({
      effects: editableCompartment.reconfigure(EditorView.editable.of(!isReadonly)),
    })
  },
)

// ── 工具栏：直接插入 Markdown 语法 ──────────────────────────
async function execCmd(cmd: string) {
  if (!view) return
  const { state } = view
  const { from, to } = state.selection.main
  const sel = state.sliceDoc(from, to)

  // 选中文本 / 无选中时光标位置
  function wrap(prefix: string, suffix: string) {
    const insert = prefix + sel + suffix
    const anchor = from + prefix.length
    const head = anchor + sel.length
    view!.dispatch({
      changes: { from, to, insert },
      selection: sel ? { anchor, head } : undefined,
    })
    view!.focus()
  }

  // 在每行首部插入
  function prefixLines(prefix: string) {
    const doc = state.doc
    const lineFrom = doc.lineAt(from)
    const lineTo = doc.lineAt(to)
    const changes: { from: number; insert: string }[] = []
    for (let i = lineFrom.number; i <= lineTo.number; i++) {
      const line = doc.line(i)
      changes.push({ from: line.from, insert: prefix })
    }
    view!.dispatch({ changes })
    view!.focus()
  }

  switch (cmd) {
    case 'bold':         wrap('**', '**'); break
    case 'italic':       wrap('*', '*'); break
    case 'strike':       wrap('~~', '~~'); break
    case 'code':         wrap('`', '`'); break
    case 'h1':           prefixLines('# '); break
    case 'h2':           prefixLines('## '); break
    case 'h3':           prefixLines('### '); break
    case 'bullet':       prefixLines('- '); break
    case 'ordered':      prefixLines('1. '); break
    case 'blockquote':   prefixLines('> '); break
    case 'hr': {
      view.dispatch(state.replaceSelection('\n\n---\n\n'))
      view.focus()
      break
    }
    case 'table': {
      const tpl = '\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|     |     |     |\n'
      view.dispatch(state.replaceSelection(tpl))
      view.focus()
      break
    }
    case 'image': {
      // 弹出文件选择对话框 → 插入 ![文件名](路径)
      const selected = await open({
        title: '选择图片',
        filters: [{
          name: '图片文件',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'],
        }],
      })
      if (selected && typeof selected === 'string') {
        const name = selected.split(/[/\\]/).pop() || '图片'
        const insert = `![${name}](${selected})`
        view.dispatch({
          changes: { from, to, insert },
        })
      }
      view.focus()
      break
    }
    case 'undo': undo(view); break
    case 'redo': redo(view); break
  }
}

// 暴露给父组件：获取当前选中文本
defineExpose({
  getSelectedText: () => {
    if (!view) return ''
    const sel = view.state.selection.main
    return view.state.sliceDoc(sel.from, sel.to)
  },
  scrollToBottom: () => {
    if (!view) return
    const scroller = view.dom.querySelector('.cm-scroller') as HTMLElement | null
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  },
  /** 滚动到指定字符偏移位置（居中显示） */
  scrollToPosition(pos: number) {
    if (!view) return
    const docLen = view.state.doc.length
    const clamped = Math.max(0, Math.min(pos, docLen))
    view.dispatch({
      effects: EditorView.scrollIntoView(clamped, { y: 'center' }),
    })
  },
  /** 临时高亮一段文本，duration 毫秒后自动取消 */
  highlightRange(from: number, to: number, duration = 800) {
    if (!view) return
    if (to <= from) return
    const docLen = view.state.doc.length
    const clampedFrom = Math.max(0, Math.min(from, docLen))
    const clampedTo = Math.max(clampedFrom, Math.min(to, docLen))
    view.dispatch({
      effects: addHighlight.of({ from: clampedFrom, to: clampedTo }),
    })
    // 自动清除高亮
    if (_highlightTimer) clearTimeout(_highlightTimer)
    _highlightTimer = setTimeout(() => {
      if (view) {
        view.dispatch({ effects: clearHighlights.of(null) })
      }
    }, duration)
  },
  /** 在编辑器中替换一段文本 */
  applyRangeChange(from: number, to: number, insert: string) {
    if (!view) return
    const docLen = view.state.doc.length
    const clampedFrom = Math.max(0, Math.min(from, docLen))
    const clampedTo = Math.max(clampedFrom, Math.min(to, docLen))
    view.dispatch({
      changes: { from: clampedFrom, to: clampedTo, insert },
    })
  },
})

// ── 查找替换 ──────────────────────────────────────────────────
let searchOpen = false
function toggleSearch() {
  if (!view) return
  if (searchOpen) {
    closeSearchPanel(view)
    searchOpen = false
  } else {
    openSearchPanel(view)
    searchOpen = true
    const panel = view.dom.querySelector('.cm-panels')
    if (panel) {
      const observer = new MutationObserver(() => {
        if (!view || !view.dom.querySelector('.cm-search')) {
          searchOpen = false
          observer.disconnect()
        }
      })
      observer.observe(panel, { childList: true })
    }
  }
}

// ── 语法说明弹窗 ──────────────────────────────────────────────
const showSyntaxGuide = ref(false)

const toolbarButtons = [
  { label: 'B',  title: '粗体',        cmd: 'bold' },
  { label: 'I',  title: '斜体',        cmd: 'italic' },
  { label: 'S̶',  title: '删除线',      cmd: 'strike' },
  { label: '`',  title: '行内代码',    cmd: 'code' },
  { label: 'H1', title: '一级标题',    cmd: 'h1' },
  { label: 'H2', title: '二级标题',    cmd: 'h2' },
  { label: 'H3', title: '三级标题',    cmd: 'h3' },
  { label: '•',  title: '无序列表',    cmd: 'bullet' },
  { label: '1.', title: '有序列表',    cmd: 'ordered' },
  { label: '❝',  title: '引用',        cmd: 'blockquote' },
  { label: '—',  title: '分割线',      cmd: 'hr' },
  { label: '▦',  title: '插入表格',    cmd: 'table' },
  { label: '🖼',  title: '插入图片',    cmd: 'image' },
  { label: '↩',  title: '撤销 Ctrl+Z', cmd: 'undo' },
  { label: '↪',  title: '重做 Ctrl+Y', cmd: 'redo' },
]
</script>

<template>
  <div class="flex flex-col h-full min-h-0" :data-theme="isLight ? 'light' : 'dark'">
    <!-- 工具栏 -->
    <div
      class="flex items-center gap-0.5 px-2 py-1.5 border-b shrink-0 flex-wrap transition-colors"
      :class="isLight
        ? 'bg-white border-gray-200'
        : 'bg-[#21252b] border-gray-800'"
    >
      <button
        v-for="btn in toolbarButtons"
        :key="btn.cmd"
        :title="btn.title"
        class="h-7 px-2 text-xs rounded transition-colors"
        :class="isLight
          ? 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'
          : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700'"
        @mousedown.prevent="execCmd(btn.cmd)"
      >
        {{ btn.label }}
      </button>
      <!-- 分隔 -->
      <span class="w-px h-4 mx-1" :class="isLight ? 'bg-gray-300' : 'bg-gray-700'" />
      <!-- 主题切换按钮 -->
      <button
        :title="isLight ? '切换深色背景' : '切换浅色背景'"
        class="h-7 px-2 text-xs rounded transition-colors"
        :class="isLight
          ? 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'
          : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700'"
        @click="toggleTheme"
      >
        {{ isLight ? '🌙' : '☀' }}
      </button>
      <!-- 字体选择 -->
      <span class="w-px h-4 mx-1" :class="isLight ? 'bg-gray-300' : 'bg-gray-700'" />
      <select
        :value="fontFamily"
        class="h-7 px-1.5 text-[11px] rounded border-none focus:outline-none cursor-pointer"
        :class="isLight
          ? 'bg-gray-100 text-gray-700'
          : 'bg-gray-800 text-gray-400'"
        @change="setFontFamily(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="f in fontOptions" :key="f" :value="f">{{ f }}</option>
      </select>
      <!-- 字体大小 -->
      <button
        title="放大字体 Ctrl+滚轮"
        class="h-7 w-7 flex items-center justify-center text-xs rounded transition-colors"
        :class="isLight
          ? 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'
          : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700'"
        @click="zoomIn"
      >A⁺</button>
      <button
        title="缩小字体 Ctrl+滚轮"
        class="h-7 w-7 flex items-center justify-center text-xs rounded transition-colors"
        :class="isLight
          ? 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'
          : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700'"
        @click="zoomOut"
      >A⁻</button>
      <!-- 分隔 -->
      <span class="w-px h-4 mx-1" :class="isLight ? 'bg-gray-300' : 'bg-gray-700'" />
      <!-- 查找替换 -->
      <button
        title="查找替换 (Ctrl+F)"
        class="h-7 px-2 text-xs rounded transition-colors"
        :class="isLight
          ? 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'
          : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700'"
        @click="toggleSearch"
      >
        🔍 查找替换
      </button>
      <!-- 语法说明按钮 -->
      <button
        title="Markdown 语法教程"
        class="h-7 px-2 text-xs rounded transition-colors ml-auto"
        :class="isLight
          ? 'text-blue-600 hover:text-blue-800 hover:bg-blue-100'
          : 'text-blue-400 hover:text-blue-200 hover:bg-blue-900/30'"
        @click="showSyntaxGuide = true"
      >
        语法说明
      </button>
    </div>
    <!-- CodeMirror 容器 -->
    <div ref="editorRef" class="flex-1 overflow-hidden cm-container" :style="{ '--cm-font-size': fontSize + 'px', '--cm-font-family': fontFamily }" />

    <!-- 语法说明弹窗 -->
    <Teleport to="body">
      <div
        v-if="showSyntaxGuide"
        class="fixed inset-0 z-[10001] flex items-center justify-center"
        @click.self="showSyntaxGuide = false"
      >
        <!-- 遮罩 -->
        <div class="absolute inset-0 bg-black/40 backdrop-blur-md" />
        <!-- 弹窗 -->
        <div class="relative w-full max-w-2xl max-h-[85vh] rounded-xl shadow-2xl flex flex-col bg-gray-900 text-gray-200 border border-gray-800">
          <!-- 标题栏 -->
          <div class="flex items-center justify-between px-5 py-3.5 border-b border-gray-800 shrink-0 rounded-t-xl">
            <h2 class="text-base font-semibold">📝 Markdown 语法教程</h2>
            <button
              class="h-7 w-7 flex items-center justify-center rounded text-lg leading-none text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
              @click="showSyntaxGuide = false"
            >✕</button>
          </div>
          <!-- 内容区 -->
          <div class="px-5 py-4 overflow-y-auto text-sm leading-relaxed space-y-5">
            <!-- 标题 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-400">标题</h3>
              <p class="text-gray-400 text-xs leading-relaxed break-all">
                使用 # 号标记标题等级：<br/>
                • <b class="text-gray-200"># 一级标题</b> — 文档大标题<br/>
                • <b class="text-gray-200">## 二级标题</b> — 章节标题<br/>
                • <b class="text-gray-200">### 三级标题</b> — 子章节<br/>
                • 支持 #### 五级、##### 六级逐层细化
              </p>
            </div>

            <!-- 文字样式 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-400">文字样式</h3>
              <p class="text-gray-400 text-xs leading-relaxed break-all">
                通过符号包裹实现格式：<br/>
                • <b class="text-gray-200">**粗体**</b> → 粗体强调<br/>
                • <b class="text-gray-200">*斜体*</b> → 斜体表达<br/>
                • <b class="text-gray-200">~~删除线~~</b> → 划掉内容<br/>
                • <b class="text-gray-200">`行内代码`</b> → 等宽字体代码片段
              </p>
            </div>

            <!-- 列表 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-400">列表</h3>
              <p class="text-gray-400 text-xs leading-relaxed break-all">
                • <b class="text-gray-200">无序列表</b>：使用 - 或 * 开头，如 <code class="text-gray-300 bg-gray-800 px-1 rounded">- 项目</code><br/>
                • <b class="text-gray-200">有序列表</b>：数字加点，如 <code class="text-gray-300 bg-gray-800 px-1 rounded">1. 第一步</code><br/>
                • <b class="text-gray-200">嵌套列表</b>：子项缩进 2 空格即可
              </p>
            </div>

            <!-- 引用 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-400">引用</h3>
              <p class="text-gray-400 text-xs leading-relaxed break-all">
                使用 <code class="text-gray-300 bg-gray-800 px-1 rounded">&gt;</code> 开头创建引用块，适合引用他人言论或突出重要提示。
              </p>
            </div>

            <!-- 链接与图片 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-400">链接与图片</h3>
              <p class="text-gray-400 text-xs leading-relaxed break-all">
                • <b class="text-gray-200">链接</b>：<code class="text-gray-300 bg-gray-800 px-1 rounded">[显示文字](URL)</code><br/>
                • <b class="text-gray-200">图片</b>：<code class="text-gray-300 bg-gray-800 px-1 rounded">![描述](图片路径)</code><br/>
                • 图片支持本地路径和网络 URL，截图后 Ctrl+V 自动保存并插入
              </p>
            </div>

            <!-- 表格 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-400">表格</h3>
              <p class="text-gray-400 text-xs leading-relaxed break-all">
                使用竖线和短横线绘制表格结构，第二行为分隔符。工具栏「插入表格」可一键生成骨架。
              </p>
            </div>

            <!-- 分割线与代码块 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-400">分割线与代码块</h3>
              <p class="text-gray-400 text-xs leading-relaxed break-all">
                • <b class="text-gray-200">分割线</b>：单独一行输入 <code class="text-gray-300 bg-gray-800 px-1 rounded">---</code><br/>
                • <b class="text-gray-200">代码块</b>：用三个反引号包围，可指定语言高亮：<code class="text-gray-300 bg-gray-800 px-1 rounded">\`\`\`python</code>
              </p>
            </div>

            <!-- 快捷操作 -->
            <div>
              <h3 class="font-semibold mb-1.5 text-gray-400">快捷操作</h3>
              <p class="text-gray-400 text-xs leading-relaxed">
                📌 截图后 <b class="text-gray-200">Ctrl+V</b> 直接粘贴图片<br/>
                🔍 <b class="text-gray-200">Ctrl+F</b> 打开查找替换面板<br/>
                🔤 <b class="text-gray-200">Ctrl+滚轮</b> 放大/缩小编辑器字体<br/>
                🌓 点击工具栏 ☀/🌙 按钮切换主题
              </p>
            </div>
          </div>
          <!-- 底部版权 -->
          <div class="px-5 py-3 border-t border-gray-800 shrink-0 rounded-b-xl text-center text-xs text-gray-600">
            © 2026 AiPen. All rights reserved.
          </div>
        </div>
      </div>
    </Teleport>
  </div>

  <!-- 右键菜单 (Teleport to body) -->
  <Teleport to="body">
    <div
      v-if="ctxMenuShow"
      class="ctx-menu"
      :style="{ left: ctxMenuX + 'px', top: ctxMenuY + 'px' }"
    >
      <!-- 文档模式菜单 -->
      <template v-if="!editMode || editMode === 'document'">
        <div class="ctx-menu-item" @click.stop="execCtxMenuCut">
          <span>剪切</span><span class="ctx-shortcut">Ctrl+X</span>
        </div>
        <div class="ctx-menu-item" @click.stop="execCtxMenuCopy">
          <span>复制</span><span class="ctx-shortcut">Ctrl+C</span>
        </div>
        <div class="ctx-menu-item" @click.stop="execCtxMenuPaste">
          <span>粘贴</span><span class="ctx-shortcut">Ctrl+V</span>
        </div>
        <template v-if="ctxMenuSelText">
          <div class="ctx-separator" />
          <div class="ctx-menu-item" @click.stop="execCtxMenuClip">
            <span>📦 存入素材库</span><span class="ctx-shortcut" />
          </div>
          <div class="ctx-menu-item" @click.stop="execCtxMenuAddToChat">
            <span>💬 添加到 AI 对话</span><span class="ctx-shortcut" />
          </div>
        </template>
      </template>
      <!-- 素材模式菜单 -->
      <template v-if="editMode === 'material'">
        <div class="ctx-menu-item" @click.stop="execCtxMenuCopy">
          <span>复制</span><span class="ctx-shortcut">Ctrl+C</span>
        </div>
        <template v-if="ctxMenuSelText">
          <div class="ctx-separator" />
          <div class="ctx-menu-item" @click.stop="execCtxMenuInsertToChat">
            <span>💬 添加到 AI 对话</span><span class="ctx-shortcut" />
          </div>
        </template>
        <div class="ctx-separator" />
        <!-- 单素材视图：直接删除 -->
        <template v-if="materialId">
          <div class="ctx-menu-item ctx-menu-item-danger" @click.stop="execCtxMenuDeleteMaterial">
            <span>🗑 删除素材</span><span class="ctx-shortcut" />
          </div>
        </template>
        <!-- 标签视图：需选中文本才能操作 -->
        <template v-else-if="ctxMenuSelText">
          <div class="ctx-menu-item ctx-menu-item-danger" @click.stop="execCtxMenuRemoveFromTag">
            <span>🔗 从此标签中移除</span><span class="ctx-shortcut" />
          </div>
          <div class="ctx-menu-item ctx-menu-item-danger" @click.stop="execCtxMenuDeleteMaterial">
            <span>🗑 从素材库中删除</span><span class="ctx-shortcut" />
          </div>
        </template>
      </template>
    </div>
    <!-- 透明遮罩，点击任意处关闭菜单 -->
    <div v-if="ctxMenuShow" class="ctx-overlay" @click="closeCtxMenu" @contextmenu.prevent="closeCtxMenu" />
  </Teleport>
</template>

<style>
/* ── Diff 回放高亮动画 ── */
.cm-diff-highlight {
  background: rgba(59, 130, 246, 0.25);
  border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.3);
  transition: background 0.3s ease;
}

/* ── CodeMirror 容器基础 ── */
.cm-container {
  min-height: 0;
  overflow: hidden;
}
.cm-container .cm-editor {
  height: 100%;
  font-size: var(--cm-font-size, 14px);
  line-height: 1.5;
}
.cm-container .cm-editor .cm-scroller {
  padding: 0 0.75rem 0 0;
}
.cm-container .cm-editor .cm-gutters {
  padding-right: 4px;
}
.cm-container .cm-editor .cm-lineNumbers .cm-gutterElement {
  border-left: 3px solid transparent;
  padding-left: 2px;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.cm-container .cm-editor .cm-content {
  font-family: var(--cm-font-family, '等线'), 'Microsoft YaHei', '微软雅黑', sans-serif;
  font-size: var(--cm-font-size, 14px);
}

/* ── 光标通用 ── */
/* 消除切换主题时的过渡延迟 */
.cm-container .cm-editor .cm-cursor,
.cm-container .cm-editor .cm-cursor-secondary,
.cm-container .cm-editor .cm-dropCursor {
  transition: none !important;
}
.cm-container .cm-editor .cm-cursorLayer {
  animation: none !important;
}

/* ── 行号栏高亮（通用边框） ── */
.cm-activeLineGutter {
  border-left: 3px solid #3b82f6;
  padding-left: 2px !important;
  transition: background 0.15s ease, color 0.15s ease;
}

/* ── 搜索面板布局（通用） ── */
.cm-container .cm-search {
  padding: 6px 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.cm-container .cm-search input[type="text"] {
  height: 24px;
  padding: 2px 6px;
  font-size: 12px;
  border-radius: 3px;
  border: 1px solid;
  outline: none;
  min-width: 120px;
}
.cm-container .cm-search input[type="text"]:focus {
  border-color: #3b82f6;
}
.cm-container .cm-search label {
  font-size: 9px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.cm-container .cm-search button {
  height: 24px;
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 3px;
  border: 1px solid;
  cursor: pointer;
  transition: background 0.15s;
}
.cm-container .cm-search .cm-button[name="close"] {
  background: transparent;
  border: none;
}

/* ── 右键菜单 ── */
.ctx-menu {
  position: fixed;
  z-index: 10000;
  background: #1e1e2e;
  border: 1px solid #3b3b5c;
  border-radius: 6px;
  padding: 4px 0;
  min-width: 200px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  font-size: 12px;
}
.ctx-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 12px;
  cursor: pointer;
  color: #c0caf5;
  transition: background 0.1s;
}
.ctx-menu-item:hover {
  background: #29293d;
}
.ctx-menu-item-danger {
  color: #ef4444 !important;
}
.ctx-menu-item-danger:hover {
  background: rgba(239, 68, 68, 0.15) !important;
}
.ctx-shortcut {
  color: #565f89;
  font-size: 11px;
  margin-left: 16px;
}
.ctx-separator {
  height: 1px;
  background: #3b3b5c;
  margin: 3px 0;
}
.ctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
}
</style>
