<script setup lang="ts">
import { ref, watch, onBeforeUnmount, computed } from 'vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import { Mark, Extension } from '@tiptap/core'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { CellSelection } from 'prosemirror-tables'
import StarterKit from '@tiptap/starter-kit'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import ImageExt from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import { TextStyle } from '@tiptap/extension-text-style'
import FontFamily from '@tiptap/extension-font-family'
import Color from '@tiptap/extension-color'
import Superscript from '@tiptap/extension-superscript'
import Subscript from '@tiptap/extension-subscript'
import { Typography } from '@tiptap/extension-typography'
import { appLocalDataDir, join } from '@tauri-apps/api/path'
// fs 插件不再直接使用（图片读写通过 Rust 自定义命令，避免权限范围问题）
import { open } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { useDocumentStore } from '../stores/document'
import { useMaterialStore } from '../stores/materialStore'
import { useExportSettingsStore } from '../stores/exportSettings'
import { textToDocJson } from '../utils/textToDocJson'


/** 自定义 Mark：让 ProseMirror 识别 diff 高亮 span（否则会静默剥离） */
const DiffHighlight = Mark.create({
  name: 'diffHighlight',
  parseHTML() {
    return [{ tag: 'span.diff-change-highlight' }]
  },
  renderHTML() {
    return ['span', { class: 'diff-change-highlight' }, 0]
  },
})

/** 段落级行间距 + 缩进属性 */
const ParagraphExt = Extension.create({
  name: 'paragraphExt',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: el => el.style.lineHeight || null,
          renderHTML: attrs => {
            if (!attrs.lineHeight) return {}
            return { style: `line-height: ${attrs.lineHeight}` }
          },
        },
        textIndent: {
          default: null,
          parseHTML: el => el.style.textIndent || null,
          renderHTML: attrs => {
            if (!attrs.textIndent) return {}
            return { style: `text-indent: ${attrs.textIndent}` }
          },
        },
      },
    }]
  },
  addCommands() {
    return {
      setLineHeight: (value: string | null) => ({ chain }: { chain: any }) => {
        return chain().updateAttributes('paragraph', { lineHeight: value }).updateAttributes('heading', { lineHeight: value }).run()
      },
      setTextIndent: (value: number) => ({ chain }: { chain: any }) => {
        const v = value > 0 ? `${value}em` : null
        return chain()
          .updateAttributes('paragraph', { textIndent: v })
          .updateAttributes('heading', { textIndent: v })
          .run()
      },
    }
  },
})

/** 自定义 FontSize 扩展（选区级别字号，@tiptap/extension-font-size 在 v3 暂无稳定版） */
const FontSize = Extension.create({
  name: 'fontSize',
  addOptions() {
    return { types: ['textStyle'] }
  },
  addGlobalAttributes() {
    return [{
      types: this.options.types as string[],
      attributes: {
        fontSize: {
          default: null,
          parseHTML: el => el.style.fontSize?.replace(/['"]+/g, '') || null,
          renderHTML: attrs => {
            if (!attrs.fontSize) return {}
            return { style: `font-size: ${attrs.fontSize}` }
          },
        },
      },
    }]
  },
  addCommands() {
    return {
      setFontSize: (size: string) => ({ chain }: { chain: any }) => {
        return chain().setMark('textStyle', { fontSize: size }).run()
      },
      unsetFontSize: () => ({ chain }: { chain: any }) => {
        return chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run()
      },
    }
  },
})

/** 自定义 Image 扩展：
 *  - src：当前会话可显示的 asset URL（convertFileSrc）
 *  - localPath：持久化本地路径（导出 Word 时读取）
 *  策略：插入/粘贴时存双属性，渲染用 src，
 *  加载时从 localPath 重新生成 src。 */
const LocalImage = ImageExt.extend({
  name: 'image',
  addAttributes() {
    // ★ 必须继承父类属性（src/alt/title/width/height），
    //   否则 TipTap 不会自动合并，src 会被当作未知属性丢弃
    return {
      ...(this.parent?.() || {}),
      /** 持久化本地路径，用于重启恢复和 Word 导出 */
      localPath: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-local-path') || null,
        renderHTML: (attrs: Record<string, any>) => {
          if (!attrs.localPath) return {}
          return { 'data-local-path': attrs.localPath }
        },
      },
    }
  },
})

const props = defineProps<{
  modelValue: any // ProseMirror JSON 文档模型 或 素材纯文本字符串
  readonly?: boolean
  editMode?: 'document' | 'material'
  materialId?: string
}>()
const emit = defineEmits<{
  'update:modelValue': [value: any] // ProseMirror JSON 或 纯文本字符串
  'clip-material': [text: string]
  'insert-to-chat': [text: string]
  'delete-material': [selectionStart: number]
  'remove-from-tag': [selectionStart: number]
}>()

const docStore = useDocumentStore()
const materialStore = useMaterialStore()
const exportSettingsStore = useExportSettingsStore()

// ── 排版设置联动：字号与行间距 ──
const es = () => exportSettingsStore.settings

/** 正文基准字号 (pt) */
const bodyFontSizePt = computed(() => es().sizeBody)
/** 各标题字号 (pt) */
const h1FontSizePt = computed(() => es().sizeH1)
const h2FontSizePt = computed(() => es().sizeH2)
const h3FontSizePt = computed(() => es().sizeH3)
const h4FontSizePt = computed(() => es().sizeH4)

/** 字体家族（各样式独立，来自排版设置） */
const bodyFontFamily = computed(() => es().fontBody)
const h1FontFamily = computed(() => es().fontH1)
const h2FontFamily = computed(() => es().fontH2)
const h3FontFamily = computed(() => es().fontH3)
const h4FontFamily = computed(() => es().fontH4)

/** 基准行高 = lineSpacingPt / sizeBody（CSS 倍数） */
const bodyLineHeight = computed(() => {
  const sp = es().lineSpacingPt
  const sz = es().sizeBody
  return +(sp / sz).toFixed(2)
})
const h1LineHeight = computed(() => +(es().lineSpacingPt / es().sizeH1).toFixed(2))
const h2LineHeight = computed(() => +(es().lineSpacingPt / es().sizeH2).toFixed(2))
const h3LineHeight = computed(() => +(es().lineSpacingPt / es().sizeH3).toFixed(2))
const h4LineHeight = computed(() => +(es().lineSpacingPt / es().sizeH4).toFixed(2))

/** 标题加粗开关（来自排版设置） */
const h1FontWeight = computed(() => es().boldH1 ? 700 : 400)
const h2FontWeight = computed(() => es().boldH2 ? 700 : 400)
const h3FontWeight = computed(() => es().boldH3 ? 700 : 400)
const h4FontWeight = computed(() => es().boldH4 ? 700 : 400)

/** 工具栏样式下拉菜单预览的字号缩放（22pt 在下拉里过大，按比例缩放） */
const TOOLBAR_PREVIEW_SCALE = 0.7
/** 工具栏下拉中"正文"预览的样式（继承排版设置中的字体/字号/加粗） */
const previewBodyStyle = computed(() => ({
  fontFamily: bodyFontFamily.value,
  fontSize: `${es().sizeBody * TOOLBAR_PREVIEW_SCALE}pt`,
  fontWeight: es().boldBody ? 700 : 400,
}))
/** 工具栏下拉中"标题 1"预览的样式 */
const previewH1Style = computed(() => ({
  fontFamily: h1FontFamily.value,
  fontSize: `${es().sizeH1 * TOOLBAR_PREVIEW_SCALE}pt`,
  fontWeight: h1FontWeight.value,
}))
/** 工具栏下拉中"标题 2"预览的样式 */
const previewH2Style = computed(() => ({
  fontFamily: h2FontFamily.value,
  fontSize: `${es().sizeH2 * TOOLBAR_PREVIEW_SCALE}pt`,
  fontWeight: h2FontWeight.value,
}))
/** 工具栏下拉中"标题 3"预览的样式 */
const previewH3Style = computed(() => ({
  fontFamily: h3FontFamily.value,
  fontSize: `${es().sizeH3 * TOOLBAR_PREVIEW_SCALE}pt`,
  fontWeight: h3FontWeight.value,
}))
/** 工具栏下拉中"标题 4"预览的样式 */
const previewH4Style = computed(() => ({
  fontFamily: h4FontFamily.value,
  fontSize: `${es().sizeH4 * TOOLBAR_PREVIEW_SCALE}pt`,
  fontWeight: h4FontWeight.value,
}))

// ── 主题 ──
const isLight = ref(localStorage.getItem('editor-theme') === 'light')
function toggleTheme() {
  isLight.value = !isLight.value
  localStorage.setItem('editor-theme', isLight.value ? 'light' : 'dark')
}

// ── 字体（与排版设置对齐：各样式独立字体） ──
const fontOptions = [
  '方正小标宋简体', '方正黑体简体', '方正楷体简体', '方正仿宋简体',
  '宋体', '黑体', '楷体', '仿宋', '微软雅黑', 'Times New Roman',
]
/** 当前光标/选区处的字体（优先 inline mark，其次块级样式，最后排版设置） */
const fontFamily = computed(() => {
  const ed = editor.value
  if (!ed) return es().fontBody
  // 1. 选区级别 inline 字体（textStyle mark）
  const textAttrs = ed.getAttributes('textStyle')
  if (textAttrs.fontFamily) return textAttrs.fontFamily
  // 2. 块级样式字体（光标所在标题/正文）
  if (ed.isActive('heading', { level: 1 })) return es().fontH1
  if (ed.isActive('heading', { level: 2 })) return es().fontH2
  if (ed.isActive('heading', { level: 3 })) return es().fontH3
  if (ed.isActive('heading', { level: 4 })) return es().fontH4
  return es().fontBody
})
function setFontFamily(f: string) {
  editor.value?.chain().focus().setFontFamily(f).run()
}

// ── 字号（中文公文号数制，选区级别） ──
// ★ 对齐导出设置面板 fontSizeOptions，统一使用标准 pt 值
interface FontSizeEntry { label: string; px: number }
const fontSizeMap: FontSizeEntry[] = [
  { label: '一号', px: 26 },
  { label: '小一', px: 24 },
  { label: '二号', px: 22 },
  { label: '小二', px: 18 },
  { label: '三号', px: 16 },
  { label: '小三', px: 15 },
  { label: '四号', px: 14 },
  { label: '小四', px: 12 },
  { label: '五号', px: 10.5 },
  { label: '小五', px: 9 },
]

/** 获取当前上下文的字号 pt 值（优先 textStyle mark，其次标题块级，最后正文字号） */
function getContextFontSizePt(): number {
  const ed = editor.value
  if (!ed) return es().sizeBody
  // 1. textStyle mark 中的 fontSize
  const attrs = ed.getAttributes('textStyle')
  if (attrs.fontSize) {
    const px = parseFloat(attrs.fontSize)
    if (px) return px
  }
  // 2. 标题块级 fallback（与 fontFamily 逻辑一致）
  if (ed.isActive('heading', { level: 1 })) return es().sizeH1
  if (ed.isActive('heading', { level: 2 })) return es().sizeH2
  if (ed.isActive('heading', { level: 3 })) return es().sizeH3
  if (ed.isActive('heading', { level: 4 })) return es().sizeH4
  // 3. 正文基准
  return es().sizeBody
}

/** pt 值 → 最近的中文号数名称 */
function ptToFontSizeLabel(pt: number): string {
  if (!pt) return '三号'
  let best = fontSizeMap[4] // 默认三号
  let minDiff = Infinity
  for (const f of fontSizeMap) {
    const diff = Math.abs(f.px - pt)
    if (diff < minDiff) { minDiff = diff; best = f }
  }
  return best.label
}

/** 当前光标/选区处的字号名称（用于工具栏显示） */
const currentFontSizeLabel = computed(() => {
  return ptToFontSizeLabel(getContextFontSizePt())
})

function setFontSize(label: string) {
  const entry = fontSizeMap.find(f => f.label === label)
  if (!entry) return
  editor.value?.chain().focus().setFontSize(entry.px + 'pt').run()
}

/** 选区字号增大一档 */
function zoomIn() {
  const ed = editor.value
  if (!ed) return
  const curPx = getContextFontSizePt()
  const sortedByPx = [...fontSizeMap].sort((a, b) => a.px - b.px)
  const next = sortedByPx.find(f => f.px > curPx)
  if (next) ed.chain().focus().setFontSize(next.px + 'pt').run()
}

/** 选区字号减小一档 */
function zoomOut() {
  const ed = editor.value
  if (!ed) return
  const curPx = getContextFontSizePt()
  const sortedByPx = [...fontSizeMap].sort((a, b) => b.px - a.px)
  const prev = sortedByPx.find(f => f.px < curPx)
  if (prev) ed.chain().focus().setFontSize(prev.px + 'pt').run()
}

// ── 页面缩放（Ctrl+滚轮） ──
const pageZoom = ref(1.0)

// ── 表格格选面板 ──
const tablePickerOpen = ref(false)
const tablePickerRows = ref(4)
const tablePickerCols = ref(4)
const maxTableRows = 10
const maxTableCols = 10

function openTablePicker() {
  tablePickerOpen.value = true
  tablePickerRows.value = 4
  tablePickerCols.value = 4
}
function closeTablePicker() {
  tablePickerOpen.value = false
}
function insertTableAt(r: number, c: number) {
  focus()
  editor.value?.chain().insertTable({ rows: r, cols: c, withHeaderRow: true }).run()
  tablePickerOpen.value = false
}

// ── 表格操作状态 ──
const isInTable = computed(() => editor.value?.isActive('table') ?? false)

/** 是否为 CellSelection（Ctrl/Cmd + 点击 选中了一个或多个单元格） */
const isCellSelection = computed(() => {
  const ed = editor.value
  if (!ed) return false
  return ed.state.selection instanceof CellSelection
})

/** 是否可合并：选中了至少两个不同单元格 */
const canMergeCells = computed(() => {
  const ed = editor.value
  if (!ed) return false
  const sel = ed.state.selection
  if (!(sel instanceof CellSelection)) return false
  return sel.$anchorCell.pos !== sel.$headCell.pos
})

/** 是否可拆分：当前单元格 colspan > 1 或 rowspan > 1 */
const canSplitCell = computed(() => {
  const ed = editor.value
  if (!ed) return false
  const $pos = ed.state.doc.resolve(ed.state.selection.from)
  for (let d = 1; d <= $pos.depth; d++) {
    const node = $pos.node(d)
    if (node && (node.type.name === 'tableCell' || node.type.name === 'tableHeader')) {
      return node.attrs.colspan > 1 || node.attrs.rowspan > 1
    }
  }
  return false
})

// ── 表格操作命令 ──
function execAddRowBefore() { focus(); editor.value?.chain().addRowBefore().run() }
function execAddRowAfter() { focus(); editor.value?.chain().addRowAfter().run() }
function execAddColumnBefore() { focus(); editor.value?.chain().addColumnBefore().run() }
function execAddColumnAfter() { focus(); editor.value?.chain().addColumnAfter().run() }
function execDeleteRow() { focus(); editor.value?.chain().deleteRow().run() }
function execDeleteColumn() { focus(); editor.value?.chain().deleteColumn().run() }
function execDeleteTable() { focus(); editor.value?.chain().deleteTable().run() }
function execMergeCells() { focus(); if (canMergeCells.value) editor.value?.chain().mergeCells().run() }
function execSplitCell() { focus(); if (canSplitCell.value) editor.value?.chain().splitCell().run() }
function execToggleHeaderRow() { focus(); editor.value?.chain().toggleHeaderRow().run() }

// ── 搜索高亮 ProseMirror Plugin ──
const searchPluginKey = new PluginKey('searchHighlight')

const SearchHighlightExt = Extension.create({
  name: 'searchHighlightExt',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: searchPluginKey,
      state: {
        init() { return DecorationSet.empty },
        apply(tr, old) {
          const meta = tr.getMeta(searchPluginKey)
          if (meta !== undefined) return meta
          if (tr.docChanged) return old.map(tr.mapping, tr.doc)
          return old
        },
      },
      props: {
        decorations(state) { return this.getState(state) },
      },
    })]
  },
})

// ── 查找替换 ──
const searchOpen = ref(false)
const searchInputRef = ref<HTMLInputElement | null>(null)
const searchQuery = ref('')
const replaceQuery = ref('')
const searchCount = ref(0)
const searchIdx = ref(0)
const caseSensitive = ref(false)
let _searchMatches: { from: number; to: number }[] = []

function applySearchDecorations() {
  const ed = editor.value
  if (!ed) return
  const decos = _searchMatches.length > 0
    ? DecorationSet.create(ed.state.doc, _searchMatches.map(r =>
        Decoration.inline(r.from, r.to, { class: 'search-highlight' })))
    : DecorationSet.empty
  ed.view.dispatch(ed.state.tr.setMeta(searchPluginKey, decos))
}

function toggleSearch() {
  searchOpen.value = !searchOpen.value
  if (searchOpen.value) {
    setTimeout(() => searchInputRef.value?.focus(), 50)
  } else {
    clearSearchHighlights()
  }
}
function doSearch() {
  clearSearchHighlights()
  const ed = editor.value
  if (!ed || !searchQuery.value) { searchCount.value = 0; searchIdx.value = 0; return }
  const q = caseSensitive.value ? searchQuery.value : searchQuery.value.toLowerCase()
  const results: { from: number; to: number }[] = []
  // ★ 遍历所有文本叶子节点，精确计算 ProseMirror 文档位置
  ed.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true
    const text = caseSensitive.value ? node.text : node.text.toLowerCase()
    let offset = 0
    while (offset < text.length) {
      const found = text.indexOf(q, offset)
      if (found === -1) break
      results.push({ from: pos + found, to: pos + found + q.length })
      offset = found + q.length
    }
    return true
  })
  _searchMatches = results
  searchCount.value = results.length
  searchIdx.value = results.length > 0 ? 1 : 0
  applySearchDecorations()
  if (results.length > 0) {
    goToResult(0)
  }
}
function doReplace() {
  const ed = editor.value
  if (!ed || !searchQuery.value || _searchMatches.length === 0) return
  const idx = searchIdx.value - 1
  if (idx < 0 || idx >= _searchMatches.length) return
  const { from, to } = _searchMatches[idx]
  ed.chain().focus().setTextSelection({ from, to }).insertContent(replaceQuery.value).run()
  // 替换后重新搜索
  setTimeout(() => doSearch(), 50)
}
function doReplaceAll() {
  const ed = editor.value
  if (!ed || !searchQuery.value) return
  const allResults = [..._searchMatches]
  // 从后往前替换，避免位置偏移
  for (let i = allResults.length - 1; i >= 0; i--) {
    const { from, to } = allResults[i]
    ed.chain().setTextSelection({ from, to }).insertContent(replaceQuery.value).run()
  }
  clearSearchHighlights()
  searchCount.value = 0
  searchIdx.value = 0
}
function goToResult(idx: number) {
  const ed = editor.value
  if (!ed || _searchMatches.length === 0) return
  const i = Math.max(0, Math.min(idx, _searchMatches.length - 1))
  searchIdx.value = i + 1
  const { from, to } = _searchMatches[i]
  ed.chain().focus().setTextSelection({ from, to }).run()
  // 滚动到视图
  const dom = ed.view.domAtPos(from)
  if (dom.node) {
    const el = (dom.node.nodeType === 3 ? dom.node.parentElement : dom.node) as HTMLElement | null
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}
function prevResult() {
  const newIdx = searchIdx.value <= 1 ? _searchMatches.length - 1 : searchIdx.value - 2
  goToResult(newIdx)
}
function nextResult() {
  goToResult(searchIdx.value < _searchMatches.length ? searchIdx.value : 0)
}
function clearSearchHighlights() {
  _searchMatches = []
  const ed = editor.value
  if (ed) {
    ed.view.dispatch(ed.state.tr.setMeta(searchPluginKey, DecorationSet.empty))
  }
  searchCount.value = 0
  searchIdx.value = 0
}

// ── 颜色（全部 computed，模板中只用 :style，杜绝 # 解析 bug） ──
const tbBg = computed(() => isLight.value ? '#f8f9fa' : '#1e1e2e')
const tbBorder = computed(() => isLight.value ? '#d9d9d9' : '#3b3b5c')
const tbSep = computed(() => isLight.value ? '#d9d9d9' : '#3b3b5c')
const btnText = computed(() => isLight.value ? '#4a4a5a' : '#a0a0c0')
const btnHoverBg = computed(() => isLight.value ? '#e9ecef' : '#2a2b3d')
const btnActiveBg = computed(() => isLight.value ? '#d0d5db' : 'rgba(59,130,246,0.2)')
const btnActiveText = computed(() => isLight.value ? '#1a56db' : '#60a5fa')
const ddBg = computed(() => isLight.value ? '#ffffff' : '#252540')
const ddBorder = computed(() => isLight.value ? '#d9d9d9' : '#3b3b5c')
const ddHoverBg = computed(() => isLight.value ? '#f3f4f6' : '#2a2b3d')
const contentBg = computed(() => isLight.value ? '#ffffff' : '#1a1b26')
const contentText = computed(() => isLight.value ? '#1a1a1a' : '#c0caf5')

// ── 素材卡片主题色 ──
const cardAccent = computed(() => isLight.value ? '#6366f1' : '#818cf8')
const cardTitleBg = computed(() => isLight.value ? 'linear-gradient(135deg, rgba(99,102,241,0.07) 0%, rgba(99,102,241,0.02) 100%)' : 'linear-gradient(135deg, rgba(129,140,248,0.1) 0%, rgba(129,140,248,0.03) 100%)')
const cardMetaColor = computed(() => isLight.value ? '#9ca3af' : '#565f89')
const cardDivider = computed(() => isLight.value ? 'linear-gradient(90deg, transparent 0%, rgba(209,213,219,0.5) 30%, rgba(209,213,219,0.7) 50%, rgba(209,213,219,0.5) 70%, transparent 100%)' : 'linear-gradient(90deg, transparent 0%, rgba(59,59,92,0.5) 30%, rgba(59,59,92,0.7) 50%, rgba(59,59,92,0.5) 70%, transparent 100%)')
const metaBg = computed(() => isLight.value ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.04)')
const dropdownItemColor = computed(() => isLight.value ? '#1f2937' : '#c0c0e0')

// ── 右键菜单状态 ──
const ctxMenuShow = ref(false)
const ctxMenuX = ref(0)
const ctxMenuY = ref(0)
const ctxMenuSelText = ref('')
const ctxMenuSelFrom = ref(0)
const ctxMenuSelTo = ref(0)

function closeCtxMenu() { ctxMenuShow.value = false }

function execCtxMenuCut() {
  const ed = editor.value
  if (!ed || !ctxMenuSelText.value) return
  navigator.clipboard.writeText(ctxMenuSelText.value)
  ed.chain().deleteSelection().run()
  ed.commands.focus()
  closeCtxMenu()
}
function execCtxMenuCopy() {
  const ed = editor.value
  if (!ed || !ctxMenuSelText.value) return
  navigator.clipboard.writeText(ctxMenuSelText.value)
  ed.commands.focus()
  closeCtxMenu()
}
async function execCtxMenuPaste() {
  const ed = editor.value
  if (!ed) return
  try {
    const text = await navigator.clipboard.readText()
    if (text) {
      ed.chain().focus().insertContent(text).run()
    }
  } catch { /* 剪贴板读取失败 */ }
  ed.commands.focus()
  closeCtxMenu()
}
function execCtxMenuClip() {
  if (ctxMenuSelText.value) {
    materialStore.openClipDialog(ctxMenuSelText.value)
    emit('clip-material', ctxMenuSelText.value)
  }
  closeCtxMenu()
}
function execCtxMenuAddToChat() {
  docStore.injectedChatText = ctxMenuSelText.value
  docStore.sidebarTab = 'chat'
  closeCtxMenu()
}
function execCtxMenuInsertToChat() {
  if (ctxMenuSelText.value) {
    emit('insert-to-chat', ctxMenuSelText.value)
  }
  closeCtxMenu()
}
function execCtxMenuDeleteMaterial() {
  emit('delete-material', ctxMenuSelFrom.value)
  closeCtxMenu()
}
function execCtxMenuRemoveFromTag() {
  emit('remove-from-tag', ctxMenuSelFrom.value)
  closeCtxMenu()
}

// ── 文字颜色 ──
const colorPalette = ['#000000','#444444','#888888','#cccccc','#ff0000','#ff6600','#ffcc00','#00cc00','#0066ff','#6600cc']
const colorPickerOpen = ref(false)
function toggleColorPicker() { closeAllPickers(); colorPickerOpen.value = !colorPickerOpen.value }
function setTextColor(color: string) {
  focus()
  editor.value?.chain().setColor(color).run()
  colorPickerOpen.value = false
}
function currentTextColor() {
  const attrs = editor.value?.getAttributes('textStyle')
  return attrs?.color || ''
}


// ── 工具栏下拉状态 ──
const headingDropdownOpen = ref(false)
const fontDropdownOpen = ref(false)
const fontSizeDropdownOpen = ref(false)

function closeAllPickers() {
  headingDropdownOpen.value = false
  fontDropdownOpen.value = false
  fontSizeDropdownOpen.value = false
  colorPickerOpen.value = false
}
function toggleHeadingDropdown() { closeAllPickers(); headingDropdownOpen.value = !headingDropdownOpen.value }
function toggleFontDropdown() { closeAllPickers(); fontDropdownOpen.value = !fontDropdownOpen.value }
function toggleFontSizeDropdown() { closeAllPickers(); fontSizeDropdownOpen.value = !fontSizeDropdownOpen.value }
function closeDropdowns() { closeAllPickers() }

// ── ProseMirror JSON 内容应用（原生格式，无 Markdown 转换）──

// ── 同步保护（核心：防止初始化竞态清空 content） ──
let syncing = false
let initialized = false

/** 将纯文本字符偏移映射为 ProseMirror 文档位置（1-based） */
function textOffsetToDocPos(ed: any, targetOffset: number): number {
  let accumulated = 0
  let result = 1
  ed.state.doc.descendants((node: any, pos: number) => {
    if (node.isText) {
      const len = (node.text || '').length
      if (accumulated <= targetOffset && accumulated + len >= targetOffset) {
        result = pos + (targetOffset - accumulated) + 1
        return false
      }
      accumulated += len
    }
    return true
  })
  return result
}

/** 将字节数组转为 data:image/...;base64,... URL */
async function bytesToDataUrl(bytes: Uint8Array | number[], ext: string): Promise<string> {
  const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' }
  const mime = mimeMap[ext] || 'image/png'
  const blob = new Blob([bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)], { type: mime })
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

/** 预处理 ProseMirror JSON：为有 localPath 但 src 失效的图片重新生成 data URL */
async function prepareContent(json: any): Promise<any> {
  if (!json || typeof json !== 'object' || !json.content) return json
  const doc = JSON.parse(JSON.stringify(json)) // deep clone
  await recoverImageNodes(doc)
  return doc
}

async function recoverImageNodes(node: any) {
  if (node.type === 'image' && node.attrs?.localPath && typeof node.attrs.localPath === 'string') {
    const src = node.attrs.src
    if (!src || (typeof src === 'string' && (src.startsWith('blob:') || src.startsWith('asset:')))) {
      try {
        const bytes = await invoke<number[]>('read_image_file', { path: node.attrs.localPath })
        const ext = node.attrs.localPath.split('.').pop()?.toLowerCase() || 'png'
        node.attrs.src = await bytesToDataUrl(new Uint8Array(bytes), ext)
      } catch (e) {
        console.error('[prepareContent] 图片恢复失败:', node.attrs.localPath, e)
      }
    }
  }
  if (node.content && Array.isArray(node.content)) {
    for (const child of node.content) {
      await recoverImageNodes(child)
    }
  }
}




/** 将内容注入编辑器：支持 ProseMirror JSON 对象 或 纯文本字符串 */
async function applyContent(content: any) {
  const ed = editor.value
  if (!ed) return
  syncing = true
  try {
    if (content && typeof content === 'object' && content.type === 'doc') {
      // 预处理：恢复图片 data URL（从 localPath 重新生成）
      const prepared = await prepareContent(content)
      ed.commands.setContent(prepared)
    } else if (typeof content === 'string' && content) {
      // 纯文本（素材模式 / 向后兼容旧数据）→ 按双换行拆分为多个段落
      ed.commands.setContent(textToDocJson(content))
    } else {
      // 空内容
      ed.commands.setContent({ type: 'doc', content: [] })
    }
  } catch {
    ed.commands.setContent({ type: 'doc', content: [] })
  }
  syncing = false
}

// ── 创建 TipTap 编辑器 ──
const editor = useEditor({
  content: '',
  editable: !props.readonly,
  extensions: [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      link: { openOnClick: false, HTMLAttributes: { class: 'text-blue-500 underline' } },
    }),
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify'] }),
    Table.configure({ resizable: true }),
    TableRow,
    TableCell,
    TableHeader,
    LocalImage.configure({ inline: false, allowBase64: false }),
    Placeholder.configure({ placeholder: '开始写作...' }),
    TextStyle,
    FontFamily,
    Color,
    Superscript,
    Subscript,
    ParagraphExt,
    FontSize,
    Typography,
    SearchHighlightExt,
    DiffHighlight,
  ],
  onCreate() {
    // 编辑器已创建，异步注入初始内容（含图片 data URL 恢复）
    applyContent(props.modelValue).then(() => {
      initialized = true
    })
  },
  onUpdate() {
    // ★ 核心保护：初始化期间 / 程序化同步期间，不 emit
    if (!initialized || syncing) return
    const ed = editor.value
    if (!ed) return

    if (props.editMode === 'material') {
      // 素材模式：发射 ProseMirror JSON（与文档模式一致，避免无限循环）
      const json = ed.getJSON()
      const current = typeof props.modelValue === 'object' ? props.modelValue : null
      if (JSON.stringify(json) !== JSON.stringify(current)) {
        emit('update:modelValue', json)
      }
    } else {
      // 文档模式：发射 ProseMirror JSON
      const json = ed.getJSON()
      const current = typeof props.modelValue === 'object' ? props.modelValue : null
      if (JSON.stringify(json) !== JSON.stringify(current)) {
        emit('update:modelValue', json)
      }
    }
  },
  editorProps: {
    attributes: {
      class: 'rich-editor-content',
    },
    handleDOMEvents: {
      keydown: (_view, event) => {
        const ke = event as KeyboardEvent
        if (ke.key === 'Backspace') {
          const ed = editor.value
          if (!ed) return false
          const { $from, empty } = ed.state.selection
          // 仅当光标折叠且在段落/标题的起始位置时生效
          if (!empty) return false
          if ($from.parentOffset !== 0) return false
          const attrs = ed.getAttributes('paragraph') || ed.getAttributes('heading')
          const indent = attrs.textIndent ? parseInt(attrs.textIndent) : 0
          if (indent > 0) {
            ke.preventDefault()
            ;(ed.commands as any).setTextIndent?.(Math.max(0, indent - INDENT_BACK_STEP))
            return true
          }
        }
        return false
      },
      wheel: (_view, event) => {
        if ((event as WheelEvent).ctrlKey) {
          event.preventDefault()
          pageZoom.value = Math.max(0.5, Math.min(2.0, pageZoom.value + ((event as WheelEvent).deltaY < 0 ? 0.05 : -0.05)))
          return true
        }
        return false
      },
      contextmenu: (_view, event) => {
        event.preventDefault()
        const ed = editor.value
        if (!ed) return false
        const { from, to } = ed.state.selection
        ctxMenuSelText.value = ed.state.doc.textBetween(from, to, ' ')
        ctxMenuSelFrom.value = from
        ctxMenuSelTo.value = to
        ctxMenuX.value = event.clientX
        ctxMenuY.value = event.clientY
        ctxMenuShow.value = true
        return true
      },
      paste: (_view, event) => {
        const items = event.clipboardData?.items
        if (!items) return false
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith('image/')) {
            event.preventDefault()
            handleImagePaste(items[i])
            return true
          }
        }
        return false
      },
    },
  },
})

// ── 监听外部 modelValue 变更（父组件 → 编辑器） ──
watch(
  () => props.modelValue,
  async (newVal) => {
    if (!editor.value || syncing) return
    // 比较当前编辑器内容与外部传入值
    const ed = editor.value
    if (!ed) return

    if (props.editMode === 'material') {
      // 素材模式：比较 ProseMirror JSON（与文档模式一致）
      const currentJson = ed.getJSON()
      if (typeof newVal === 'object' && JSON.stringify(newVal) !== JSON.stringify(currentJson)) {
        syncing = true
        const prepared = await prepareContent(newVal)
        ed.commands.setContent(prepared)
        syncing = false
      } else if (typeof newVal === 'string') {
        // 向后兼容：纯文本字符串 → 按段落拆分为 JSON 后设置
        syncing = true
        await applyContent(newVal)
        syncing = false
      }
    } else {
      // 文档模式：比较 ProseMirror JSON
      const currentJson = ed.getJSON()
      if (typeof newVal === 'object' && JSON.stringify(newVal) !== JSON.stringify(currentJson)) {
        syncing = true
        const prepared = await prepareContent(newVal)
        ed.commands.setContent(prepared)
        syncing = false
      } else if (typeof newVal === 'string') {
        // 向后兼容：纯文本字符串 → 按段落拆分为 JSON 后设置
        syncing = true
        await applyContent(newVal)
        syncing = false
      }
    }
  },
)

// ── 监听 readonly ──
watch(() => props.readonly, (v) => {
  editor.value?.setEditable(!v)
})

// ── 清理 ──
onBeforeUnmount(() => {
  editor.value?.destroy()
})

// ── 工具栏操作 ──
function focus() { editor.value?.chain().focus().run() }

function execBold() { focus(); editor.value?.chain().toggleBold().run() }
function execItalic() { focus(); editor.value?.chain().toggleItalic().run() }
function execUnderline() { focus(); editor.value?.chain().toggleUnderline().run() }
function execStrike() { focus(); editor.value?.chain().toggleStrike().run() }
function execHighlight() { focus(); editor.value?.chain().toggleHighlight().run() }
function execSuperscript() { focus(); editor.value?.chain().toggleSuperscript().run() }
function execSubscript() { focus(); editor.value?.chain().toggleSubscript().run() }
function execClearFormat() { focus(); editor.value?.chain().clearNodes().unsetAllMarks().run() }

/** 每次缩进步进 = 2 个字符宽度（em） */
const INDENT_STEP = 2
/** Backspace 回退步进 = 1 个字符宽度（em） */
const INDENT_BACK_STEP = 1

function execIndent() {
  focus()
  const ed = editor.value
  if (!ed) return
  const attrs = ed.getAttributes('paragraph') || ed.getAttributes('heading')
  const current = attrs.textIndent ? parseInt(attrs.textIndent) : 0
  ;(ed.commands as any).setTextIndent?.(current + INDENT_STEP)
}
function execOutdent() {
  focus()
  const ed = editor.value
  if (!ed) return
  const attrs = ed.getAttributes('paragraph') || ed.getAttributes('heading')
  const current = attrs.textIndent ? parseInt(attrs.textIndent) : 0
  if (current > 0) {
    ;(ed.commands as any).setTextIndent?.(Math.max(0, current - INDENT_STEP))
  }
}

function execHeading(level: number) {
  focus()
  const ed = editor.value
  if (!ed) { headingDropdownOpen.value = false; return }

  // 加粗映射（仅 bold 是语义标记，字号/字体由 CSS v-bind 控制）
  const boldMap: Record<number, boolean> = { 1: es().boldH1, 2: es().boldH2, 3: es().boldH3, 4: es().boldH4 }

  if (level === 0) {
    // 正文：清除标题节点，清除行内字号/字体标记让 CSS 接管
    ed.chain().setParagraph().run()
    ed.chain().focus().unsetFontSize().unsetFontFamily().run()
    if (es().boldBody) ed.chain().focus().setBold().run()
    else ed.chain().focus().unsetBold().run()
  } else {
    const wasActive = ed.isActive('heading', { level })
    ed.chain().toggleHeading({ level: level as 1 | 2 | 3 | 4 }).run()

    if (!wasActive) {
      // 切进标题：清除已有的行内字号/字体标记，让 CSS 通过 h1-h4 规则控制视觉
      ed.chain().focus().unsetFontSize().unsetFontFamily().run()
      if (boldMap[level]) ed.chain().focus().setBold().run()
      else ed.chain().focus().unsetBold().run()
    } else {
      // 切回正文：同样清除行内标记，让 CSS 正文规则接管
      ed.chain().focus().unsetFontSize().unsetFontFamily().run()
      if (es().boldBody) ed.chain().focus().setBold().run()
      else ed.chain().focus().unsetBold().run()
    }
  }
  headingDropdownOpen.value = false
}

function execAlign(dir: 'left' | 'center' | 'right' | 'justify') {
  focus(); editor.value?.chain().setTextAlign(dir).run()
}
function execBullet() { focus(); editor.value?.chain().toggleBulletList().run() }
function execOrdered() { focus(); editor.value?.chain().toggleOrderedList().run() }
function execHr() { focus(); editor.value?.chain().setHorizontalRule().run() }
function execUndo() { focus(); editor.value?.chain().undo().run() }
function execRedo() { focus(); editor.value?.chain().redo().run() }

async function execImage() {
  try {
    console.log('[execImage] 开始选择图片...')
    const selected = await open({
      title: '选择图片',
      multiple: false,
      filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }],
    })
    const sourcePath: string | null = Array.isArray(selected) ? selected[0] : selected
    console.log('[execImage] 选择的文件:', sourcePath)
    if (!sourcePath) return
    console.log('[execImage] 正在保存到本地目录...')
    const result = await saveImageToLocalDir(sourcePath)
    console.log('[execImage] 保存成功, savedPath:', result.savedPath, 'imageUrl:', result.imageUrl)
    focus()
    console.log('[execImage] 正在插入到编辑器...')
    ;(editor.value?.chain() as any).setImage({ src: result.imageUrl, localPath: result.savedPath }).run()
    console.log('[execImage] 插入完成')
  } catch (e) {
    console.error('[execImage] 插入图片失败:', e)
    alert('插入图片失败: ' + (e instanceof Error ? e.message : String(e)))
  }
}



/** 复制图片到本地持久化目录，返回 本地路径 + data URL */
async function saveImageToLocalDir(sourcePath: string): Promise<{ savedPath: string; imageUrl: string }> {
  console.log('[saveImageToLocalDir] 读取原始文件:', sourcePath)
  const ext = sourcePath.split('.').pop()?.toLowerCase() || 'png'
  const dir = await join(await appLocalDataDir(), 'images')
  const fileName = `img_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`
  const savedPath = await join(dir, fileName)
  console.log('[saveImageToLocalDir] 保存到:', savedPath)
  // 通过 Rust 命令 读 + 存，绕过 fs 插件权限范围问题
  const bytes = await invoke<number[]>('save_image_file', { sourcePath, destPath: savedPath })
  console.log('[saveImageToLocalDir] 保存完成, 字节数:', bytes?.length ?? 0)
  if (!bytes || bytes.length === 0) throw new Error('保存的图片数据为空')
  const dataUrl = await bytesToDataUrl(new Uint8Array(bytes), ext)
  return { savedPath, imageUrl: dataUrl }
}


/** 粘贴图片 → 保存到本地持久化目录 + 双属性存储 */
async function handleImagePaste(item: DataTransferItem) {
  const file = item.getAsFile()
  if (!file) return
  try {
    const buf = await file.arrayBuffer()
    let ext = file.type.split('/')[1] || 'png'
    if (ext === 'jpeg') ext = 'jpg'
    const dir = await join(await appLocalDataDir(), 'images')
    const fileName = `img_${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`
    const filePath = await join(dir, fileName)
    // 通过 Rust 命令写文件，绕过 fs 插件权限范围问题
    await invoke('save_image_bytes', { path: filePath, data: Array.from(new Uint8Array(buf)) })
    const dataUrl = await bytesToDataUrl(new Uint8Array(buf), ext)
    focus()
    ;(editor.value?.chain() as any).setImage({ src: dataUrl, localPath: filePath }).run()
  } catch (e) {
    console.error('图片粘贴失败:', e)
  }
}



// ── 活动状态 ──
const active = computed(() => ({
  bold: editor.value?.isActive('bold') ?? false,
  italic: editor.value?.isActive('italic') ?? false,
  underline: editor.value?.isActive('underline') ?? false,
  strike: editor.value?.isActive('strike') ?? false,
  highlight: editor.value?.isActive('highlight') ?? false,
  superscript: editor.value?.isActive('superscript') ?? false,
  subscript: editor.value?.isActive('subscript') ?? false,
  bullet: editor.value?.isActive('bulletList') ?? false,
  ordered: editor.value?.isActive('orderedList') ?? false,
  alignLeft: editor.value?.isActive({ textAlign: 'left' }) ?? false,
  alignCenter: editor.value?.isActive({ textAlign: 'center' }) ?? false,
  alignRight: editor.value?.isActive({ textAlign: 'right' }) ?? false,
  alignJustify: editor.value?.isActive({ textAlign: 'justify' }) ?? false,
  heading1: editor.value?.isActive('heading', { level: 1 }) ?? false,
  heading2: editor.value?.isActive('heading', { level: 2 }) ?? false,
  heading3: editor.value?.isActive('heading', { level: 3 }) ?? false,
  heading4: editor.value?.isActive('heading', { level: 4 }) ?? false,
  paragraph: editor.value ? !editor.value.isActive('heading') : true,
}))

const currentHeadingLabel = computed(() => {
  if (active.value.heading1) return 'H1'
  if (active.value.heading2) return 'H2'
  if (active.value.heading3) return 'H3'
  if (active.value.heading4) return 'H4'
  return '正文'
})

// ── 暴露给父组件 ──
defineExpose({
  getSelectedText: () => {
    const ed = editor.value
    if (!ed) return ''
    const { from, to } = ed.state.selection
    return ed.state.doc.textBetween(from, to, ' ')
  },
  /** 获取当前 ProseMirror 文档的 JSON */
  getPMJson: () => {
    const ed = editor.value
    if (!ed) return null
    return ed.getJSON()
  },
  scrollToBottom: () => {
    const el = document.querySelector('.rich-editor-content')?.parentElement
    if (el) el.scrollTop = el.scrollHeight
  },
  scrollToPosition: (pos: number) => {
    const el = document.querySelector('.rich-editor-content')?.parentElement
    if (!el) return
    // 根据位置比例滚动
    const ed = editor.value
    if (!ed) { el.scrollTop = el.scrollHeight; return }
    const ratio = Math.min(1, Math.max(0, pos / Math.max(1, ed.state.doc.content.size)))
    el.scrollTop = ratio * (el.scrollHeight - el.clientHeight)
  },
  highlightRange: (_from: number, _to: number, _duration = 800) => {
    // ProseMirror 中基于字符偏移的高亮通过 setContentWithHighlight 实现
  },
  applyRangeChange: (_from: number, _to: number, insertJson: any) => {
    const ed = editor.value
    if (!ed) return
    syncing = true
    if (insertJson && typeof insertJson === 'object' && insertJson.type === 'doc') {
      ed.commands.setContent(insertJson)
    }
    syncing = false
  },
  /** 直接设置 ProseMirror JSON 内容（绕过 v-model），用于 diff 回放高亮 */
  setContentDirect: (json: any) => {
    const ed = editor.value
    if (!ed) return
    syncing = true
    if (json && typeof json === 'object') {
      ed.commands.setContent(json)
    }
    syncing = false
  },
  /** 设置干净的 JSON 内容（等同 applyContent，供父组件在 diff 回放中清除高亮） */
  setContentClean: (json: any) => {
    const ed = editor.value
    if (!ed) return
    syncing = true
    if (json && typeof json === 'object') {
      ed.commands.setContent(json)
    }
    syncing = false
  },
  /** 设置 JSON 内容并在指定区间包裹高亮（用于 diff 逐操作回放） */
  setContentWithHighlight: (json: any, hlStart: number, hlEnd: number) => {
    const ed = editor.value
    if (!ed) return
    syncing = true
    try {
      if (json && typeof json === 'object') {
        ed.commands.setContent(json)
      }
      // 如果有有效的高亮区间，应用 diffHighlight mark
      if (hlStart >= 0 && hlEnd > hlStart) {
        const docPosFrom = textOffsetToDocPos(ed, hlStart)
        const docPosTo = textOffsetToDocPos(ed, hlEnd)
        if (docPosFrom > 0 && docPosTo > docPosFrom) {
          ed.chain().setTextSelection({ from: docPosFrom, to: docPosTo }).setMark('diffHighlight').run()
        }
      }
    } catch { /* 忽略高亮失败 */ }
    syncing = false
  },
})

// ── SVG 图标 ──
const svg = {
  undo: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
  redo: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
  bold: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></svg>`,
  italic: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg>`,
  underline: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"/><line x1="4" y1="21" x2="20" y2="21"/></svg>`,
  strike: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 11.5H6.5"/><path d="M15 6.5a4 4 0 0 0-4-4c-2.5 0-4.5 2-4.5 4.5 0 1.7.8 3.2 2.1 4"/><path d="M9 17.5a4 4 0 0 0 4 4c2.5 0 4.5-2 4.5-4.5 0-1.7-.8-3.2-2.1-4"/></svg>`,
  highlighter: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2 2-1.4 1.4-2 5.2 5.2a2 2 0 0 1 0 2.8L22 12z"/></svg>`,
  alignLeft: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="17" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>`,
  alignCenter: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="10" x2="6" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="18" y1="14" x2="6" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>`,
  alignRight: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="7" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>`,
  alignJustify: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="3" y2="18"/></svg>`,
  bulletList: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  orderedList: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>`,
  hr: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="12" x2="20" y2="12"/></svg>`,
  table: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>`,
  image: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
  search: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  sun: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`,
  moon: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  chevronDown: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
  close: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  superscript: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19l8-8"/><path d="M12 19l-8-8"/><path d="M20 12h-4c1-2 2-3 2-4 0-1-.8-2-2-2s-2 1-2 2"/></svg>`,
  subscript: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19l8-8"/><path d="M12 19l-8-8"/><path d="M20 20h-4c1-2 2-3 2-4 0-1-.8-2-2-2s-2 1-2 2"/></svg>`,
  textColor: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9.6 3.3h4.8L20 21h-2.8l-1.2-3.6H8l-1.2 3.6H4L9.6 3.3zm-1 11.7h6.8L12 5.7l-1.4 4.5z"/></svg>`,
  clearFormat: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20H7l-4-4 4-4h13"/><path d="M6.5 13.5l4-8"/><path d="M10 6h2"/><path d="M14 10v8"/></svg>`,
  indent: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/><polyline points="7 10 9 12 7 14"/></svg>`,
  outdent: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/><polyline points="17 10 15 12 17 14"/></svg>`,
  // ── 表格操作图标 ──
  addRowAbove: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="8 9 12 5 16 9"/><line x1="4" y1="21" x2="20" y2="21"/><line x1="4" y1="17" x2="20" y2="17"/></svg>`,
  addRowBelow: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="3" x2="20" y2="3"/><line x1="4" y1="7" x2="20" y2="7"/><line x1="12" y1="19" x2="12" y2="5"/><polyline points="8 15 12 19 16 15"/></svg>`,
  addColumnLeft: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="9 8 5 12 9 16"/><line x1="3" y1="4" x2="3" y2="20"/><line x1="7" y1="4" x2="7" y2="20"/></svg>`,
  addColumnRight: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="4" x2="17" y2="20"/><line x1="21" y1="4" x2="21" y2="20"/><line x1="5" y1="12" x2="19" y2="12"/><polyline points="15 8 19 12 15 16"/></svg>`,
  deleteRow: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="4" x2="20" y2="20"/><line x1="4" y1="20" x2="20" y2="4"/><line x1="9" y1="8" x2="21" y2="8"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="16" x2="21" y2="16"/></svg>`,
  deleteColumn: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="4" x2="20" y2="20"/><line x1="4" y1="20" x2="20" y2="4"/><line x1="8" y1="5" x2="8" y2="19"/><line x1="12" y1="5" x2="12" y2="19"/><line x1="16" y1="5" x2="16" y2="19"/></svg>`,
  deleteTable: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="4" y1="4" x2="20" y2="20"/><line x1="4" y1="20" x2="20" y2="4"/></svg>`,
  mergeCells: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="7" height="6" rx="1"/><rect x="14" y="5" width="7" height="6" rx="1"/><rect x="3" y="13" width="18" height="6" rx="1"/><line x1="10" y1="8" x2="14" y2="8"/></svg>`,
  splitCell: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="8" height="16" rx="1"/><rect x="13" y="4" width="8" height="16" rx="1"/><line x1="11" y1="8" x2="13" y2="8"/><line x1="11" y1="12" x2="13" y2="12"/><line x1="11" y1="16" x2="13" y2="16"/></svg>`,
  toggleHeader: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="21"/><line x1="15" y1="9" x2="15" y2="21"/><rect x="5" y="5" width="2" height="2" fill="currentColor" stroke="none"/></svg>`,
}

// ── 按钮辅助 ──
function btnClass(active: boolean) {
  return active ? 'rich-btn rich-btn-active' : 'rich-btn'
}
</script>

<template>
  <div class="flex flex-col h-full min-h-0 rich-editor-wrapper" :class="{ 'is-material': editMode === 'material' }" :style="{ backgroundColor: contentBg }">
    <!-- 工具栏 -->
    <div
      class="rich-toolbar flex items-center gap-0.5 px-1.5 py-1 border-b shrink-0 flex-wrap select-none"
      :style="{ backgroundColor: tbBg, borderColor: tbBorder }"
    >
      <!-- 撤销/重做 -->
      <button title="撤销 Ctrl+Z" class="rich-btn" @mousedown.prevent="execUndo" v-html="svg.undo" />
      <button title="重做 Ctrl+Y" class="rich-btn" @mousedown.prevent="execRedo" v-html="svg.redo" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- 文字格式 -->
      <button title="粗体" :class="btnClass(active.bold)" @mousedown.prevent="execBold" v-html="svg.bold" />
      <button title="斜体" :class="btnClass(active.italic)" @mousedown.prevent="execItalic" v-html="svg.italic" />
      <button title="下划线" :class="btnClass(active.underline)" @mousedown.prevent="execUnderline" v-html="svg.underline" />
      <button title="删除线" :class="btnClass(active.strike)" @mousedown.prevent="execStrike" v-html="svg.strike" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- 上标/下标 -->
      <button title="上标" :class="btnClass(active.superscript)" @mousedown.prevent="execSuperscript" v-html="svg.superscript" />
      <button title="下标" :class="btnClass(active.subscript)" @mousedown.prevent="execSubscript" v-html="svg.subscript" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- 文字颜色 -->
      <div class="relative">
        <button
          title="文字颜色"
          class="rich-btn"
          @mousedown.prevent="toggleColorPicker"
          v-html="svg.textColor"
          :style="{ color: currentTextColor() || undefined }"
        />
        <div
          v-if="colorPickerOpen"
          class="rich-dropdown absolute top-full left-0 mt-1 p-2 z-50"
          :style="{ backgroundColor: ddBg, borderColor: ddBorder }"
          @click.stop
        >
          <div class="rich-color-grid">
            <button
              v-for="c in colorPalette"
              :key="c"
              class="rich-color-swatch"
              :style="{ backgroundColor: c }"
              :title="c"
              @mousedown.prevent="setTextColor(c)"
            />
          </div>
          <div
            class="rich-dropdown-item text-[11px] justify-center mt-1"
            @mousedown.prevent="setTextColor('')"
          >
            默认颜色
          </div>
        </div>
        <div v-if="colorPickerOpen" class="fixed inset-0 z-40" @mousedown="closeDropdowns" />
      </div>

      <!-- 高亮 -->
      <button title="高亮" :class="btnClass(active.highlight)" @mousedown.prevent="execHighlight" v-html="svg.highlighter" />

      <!-- 清除格式 -->
      <button title="清除格式" class="rich-btn" @mousedown.prevent="execClearFormat" v-html="svg.clearFormat" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- 缩进：左减少，右增加 -->
      <button title="减少缩进" class="rich-btn" @mousedown.prevent="execOutdent" v-html="svg.outdent" />
      <button title="增加缩进" class="rich-btn" @mousedown.prevent="execIndent" v-html="svg.indent" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- 样式预设（标题下拉 - Word 风格命名） -->
      <div class="relative">
        <button
          class="rich-btn min-w-[64px] flex items-center gap-0.5"
          @mousedown.prevent="toggleHeadingDropdown"
        >
          <span class="text-xs font-medium">{{ currentHeadingLabel }}</span>
          <span v-html="svg.chevronDown" class="flex items-center" :class="{ 'rotate-180': headingDropdownOpen }" />
        </button>
        <div
          v-if="headingDropdownOpen"
          class="rich-dropdown absolute top-full left-0 mt-1 w-36 py-1 z-50"
          :style="{ backgroundColor: ddBg, borderColor: ddBorder }"
          @click.stop
        >
          <div class="rich-dropdown-item" :class="{ 'rich-dropdown-active': active.paragraph }" @mousedown.prevent="execHeading(0)">
            <span class="text-xs leading-none" :style="previewBodyStyle">正文</span>
            <span class="text-[10px] opacity-50 shrink-0">{{ bodyFontSizePt }}pt</span>
          </div>
          <div class="rich-dropdown-item" :class="{ 'rich-dropdown-active': active.heading1 }" @mousedown.prevent="execHeading(1)">
            <span class="leading-none" :style="previewH1Style">标题 1</span>
            <span class="text-[10px] opacity-50 shrink-0">{{ h1FontSizePt }}pt</span>
          </div>
          <div class="rich-dropdown-item" :class="{ 'rich-dropdown-active': active.heading2 }" @mousedown.prevent="execHeading(2)">
            <span class="leading-none" :style="previewH2Style">标题 2</span>
            <span class="text-[10px] opacity-50 shrink-0">{{ h2FontSizePt }}pt</span>
          </div>
          <div class="rich-dropdown-item" :class="{ 'rich-dropdown-active': active.heading3 }" @mousedown.prevent="execHeading(3)">
            <span class="leading-none" :style="previewH3Style">标题 3</span>
            <span class="text-[10px] opacity-50 shrink-0">{{ h3FontSizePt }}pt</span>
          </div>
          <div class="rich-dropdown-item" :class="{ 'rich-dropdown-active': active.heading4 }" @mousedown.prevent="execHeading(4)">
            <span class="leading-none" :style="previewH4Style">标题 4</span>
            <span class="text-[10px] opacity-50 shrink-0">{{ h4FontSizePt }}pt</span>
          </div>
        </div>
        <div v-if="headingDropdownOpen" class="fixed inset-0 z-40" @mousedown="closeDropdowns" />
      </div>

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- 对齐 -->
      <button title="左对齐" :class="btnClass(active.alignLeft)" @mousedown.prevent="execAlign('left')" v-html="svg.alignLeft" />
      <button title="居中" :class="btnClass(active.alignCenter)" @mousedown.prevent="execAlign('center')" v-html="svg.alignCenter" />
      <button title="右对齐" :class="btnClass(active.alignRight)" @mousedown.prevent="execAlign('right')" v-html="svg.alignRight" />
      <button title="两端对齐" :class="btnClass(active.alignJustify)" @mousedown.prevent="execAlign('justify')" v-html="svg.alignJustify" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- 列表 -->
      <button title="无序列表" :class="btnClass(active.bullet)" @mousedown.prevent="execBullet" v-html="svg.bulletList" />
      <button title="有序列表" :class="btnClass(active.ordered)" @mousedown.prevent="execOrdered" v-html="svg.orderedList" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- 分割线 -->
      <button title="分割线" class="rich-btn" @mousedown.prevent="execHr" v-html="svg.hr" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- 插入表格（格选面板） -->
      <div class="relative">
        <button title="插入表格" class="rich-btn" @mousedown.prevent="openTablePicker" v-html="svg.table" />
        <div
          v-if="tablePickerOpen"
          class="rich-table-picker absolute top-full left-0 mt-1 z-50 p-2"
          :style="{ backgroundColor: ddBg, borderColor: ddBorder }"
          @click.stop
        >
          <div class="text-[10px] mb-1.5 text-center" :style="{ color: btnText }">
            {{ tablePickerRows }} × {{ tablePickerCols }} 表格
          </div>
          <div class="rich-table-grid">
            <template v-for="r in maxTableRows" :key="r">
              <div
                v-for="c in maxTableCols"
                :key="`${r}-${c}`"
                class="rich-table-cell"
                :class="{
                  'rich-table-cell-active': r <= tablePickerRows && c <= tablePickerCols,
                  'rich-table-cell-header': r === 1 && c <= tablePickerCols
                }"
                @mouseenter="tablePickerRows = r; tablePickerCols = c"
                @click="insertTableAt(r, c)"
              />
            </template>
          </div>
        </div>
        <div v-if="tablePickerOpen" class="fixed inset-0 z-40" @mousedown="closeTablePicker" />
      </div>

      <!-- 表格操作（仅当光标在表格内时显示） -->
      <template v-if="isInTable">
        <span class="rich-sep" :style="{ backgroundColor: tbSep }" />
        <button title="上方插入行" class="rich-btn" @mousedown.prevent="execAddRowBefore" v-html="svg.addRowAbove" />
        <button title="下方插入行" class="rich-btn" @mousedown.prevent="execAddRowAfter" v-html="svg.addRowBelow" />
        <button title="左侧插入列" class="rich-btn" @mousedown.prevent="execAddColumnBefore" v-html="svg.addColumnLeft" />
        <button title="右侧插入列" class="rich-btn" @mousedown.prevent="execAddColumnAfter" v-html="svg.addColumnRight" />
        <button title="删除行" class="rich-btn" @mousedown.prevent="execDeleteRow" v-html="svg.deleteRow" />
        <button title="删除列" class="rich-btn" @mousedown.prevent="execDeleteColumn" v-html="svg.deleteColumn" />
        <button title="删除表格" class="rich-btn" @mousedown.prevent="execDeleteTable" v-html="svg.deleteTable" />
        <span class="rich-sep" :style="{ backgroundColor: tbSep }" />
        <button
          title="合并单元格（先 Ctrl+点击 选中多个单元格）"
          class="rich-btn"
          :class="{ 'rich-btn-active': isCellSelection }"
          :disabled="!canMergeCells"
          :style="{ opacity: canMergeCells ? 1 : 0.35, cursor: canMergeCells ? 'pointer' : 'default' }"
          @mousedown.prevent="execMergeCells"
          v-html="svg.mergeCells"
        />
        <button
          title="拆分单元格"
          class="rich-btn"
          :disabled="!canSplitCell"
          :style="{ opacity: canSplitCell ? 1 : 0.35, cursor: canSplitCell ? 'pointer' : 'default' }"
          @mousedown.prevent="execSplitCell"
          v-html="svg.splitCell"
        />
        <button
          title="切换标题行/列"
          class="rich-btn"
          @mousedown.prevent="execToggleHeaderRow"
          v-html="svg.toggleHeader"
        />
      </template>

      <!-- 插入图片 -->
      <button title="插入图片" class="rich-btn" @mousedown.prevent="execImage" v-html="svg.image" />

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- 查找替换 -->
      <button title="查找替换 Ctrl+F" class="rich-btn" :class="{ 'rich-btn-active': searchOpen }" @mousedown.prevent="toggleSearch" v-html="svg.search" />

      <!-- 右侧：字体 / 大小 / 主题 -->
      <div class="flex-1" />

      <!-- 字体选择 -->
      <div class="relative">
        <button
          class="rich-btn min-w-[100px] flex items-center gap-0.5 text-[11px]"
          @mousedown.prevent="toggleFontDropdown"
        >
          <span class="whitespace-nowrap">{{ fontFamily }}</span>
          <span v-html="svg.chevronDown" class="flex items-center shrink-0" :class="{ 'rotate-180': fontDropdownOpen }" />
        </button>
        <div
          v-if="fontDropdownOpen"
          class="rich-dropdown absolute top-full right-0 mt-1 w-36 py-1 z-50 max-h-48 overflow-y-auto"
          :style="{ backgroundColor: ddBg, borderColor: ddBorder }"
          @click.stop
        >
          <div
            v-for="f in fontOptions"
            :key="f"
            class="rich-dropdown-item text-[11px]"
            :class="{ 'rich-dropdown-active': fontFamily === f }"
            @mousedown.prevent="setFontFamily(f); fontDropdownOpen = false"
          >
            {{ f }}
          </div>
        </div>
        <div v-if="fontDropdownOpen" class="fixed inset-0 z-40" @mousedown="closeDropdowns" />
      </div>

      <!-- 字号下拉 + A+ A- -->
      <div class="relative flex items-center gap-0">
        <div class="relative">
          <button
            class="rich-btn min-w-[44px] flex items-center gap-0.5 text-[11px]"
            @mousedown.prevent="toggleFontSizeDropdown"
          >
            <span>{{ currentFontSizeLabel }}</span>
            <span v-html="svg.chevronDown" class="flex items-center" :class="{ 'rotate-180': fontSizeDropdownOpen }" />
          </button>
          <div
            v-if="fontSizeDropdownOpen"
            class="rich-dropdown absolute top-full right-0 mt-1 w-16 py-1 z-50"
            :style="{ backgroundColor: ddBg, borderColor: ddBorder }"
            @click.stop
          >
            <div
              v-for="s in fontSizeMap"
              :key="s.label"
              class="rich-dropdown-item text-[11px] justify-center"
              :class="{ 'rich-dropdown-active': currentFontSizeLabel === s.label }"
              @mousedown.prevent="setFontSize(s.label); fontSizeDropdownOpen = false"
            >
              {{ s.label }}
            </div>
          </div>
        </div>
        <div v-if="fontSizeDropdownOpen" class="fixed inset-0 z-40" @mousedown="closeDropdowns" />
        <button title="缩小字号" class="rich-btn text-xs" @mousedown.prevent="zoomOut">A⁻</button>
        <button title="放大字号" class="rich-btn text-xs" @mousedown.prevent="zoomIn">A⁺</button>
      </div>

      <span class="rich-sep" :style="{ backgroundColor: tbSep }" />

      <!-- 主题 -->
      <button
        :title="isLight ? '切换深色主题' : '切换浅色主题'"
        class="rich-btn"
        @mousedown.prevent="toggleTheme"
        v-html="isLight ? svg.moon : svg.sun"
      />
    </div>

    <!-- 查找替换面板 -->
    <div
      v-if="searchOpen"
      class="rich-search-panel flex items-center gap-1.5 px-2 py-1.5 border-b shrink-0"
      :style="{ backgroundColor: tbBg, borderColor: tbBorder }"
    >
      <input
        ref="searchInputRef"
        v-model="searchQuery"
        type="text"
        placeholder="查找..."
        class="rich-search-input text-[11px] px-2 py-1 rounded outline-none"
        :style="{
          backgroundColor: contentBg,
          color: contentText,
          border: `1px solid ${tbBorder}`,
          width: '160px'
        }"
        @input="doSearch"
        @keydown.enter="doSearch"
      />
      <input
        v-model="replaceQuery"
        type="text"
        placeholder="替换为..."
        class="rich-search-input text-[11px] px-2 py-1 rounded outline-none"
        :style="{
          backgroundColor: contentBg,
          color: contentText,
          border: `1px solid ${tbBorder}`,
          width: '140px'
        }"
        @keydown.enter="doSearch"
      />
      <button
        class="rich-search-btn text-[10px] font-bold"
        :class="{ 'rich-btn-active': caseSensitive }"
        title="区分大小写"
        @click="caseSensitive = !caseSensitive; doSearch()"
      >Aa</button>
      <span class="text-[10px] shrink-0" :style="{ color: btnText }" v-if="searchCount > 0">
        {{ searchIdx }}/{{ searchCount }}
      </span>
      <button class="rich-search-btn text-[10px]" @click="prevResult" :disabled="searchCount === 0">◀</button>
      <button class="rich-search-btn text-[10px]" @click="nextResult" :disabled="searchCount === 0">▶</button>
      <button class="rich-search-btn text-[10px]" @click="doReplace" :disabled="searchCount === 0">替换</button>
      <button class="rich-search-btn text-[10px]" @click="doReplaceAll" :disabled="searchCount === 0">全部替换</button>
      <div class="flex-1" />
      <button class="rich-search-btn text-[10px]" @click="toggleSearch" v-html="svg.close" />
    </div>

    <!-- TipTap 编辑区 -->
    <EditorContent :editor="editor" class="flex-1 overflow-y-auto rich-content" :style="{ color: contentText }" />

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
    <div v-if="ctxMenuShow" class="ctx-overlay" @mousedown="closeCtxMenu" @contextmenu.prevent="closeCtxMenu" />
  </Teleport>
  </div>
</template>

<style>
/* ── 编辑器内容区 ── */
.rich-content .ProseMirror {
  min-height: 100%;
  padding: 1rem 1.5rem;
  outline: none;
  font-size: calc(v-bind(bodyFontSizePt) * 1pt * v-bind(pageZoom));
  font-family: v-bind(bodyFontFamily), 'Microsoft YaHei', sans-serif;
  line-height: v-bind(bodyLineHeight);
  text-align: justify;
}
.rich-content .ProseMirror p.is-editor-empty:first-child::before {
  content: attr(data-placeholder);
  float: left;
  color: #6b7280;
  pointer-events: none;
  height: 0;
}
.rich-content .ProseMirror h1 { font-family: v-bind(h1FontFamily); font-size: calc(v-bind(h1FontSizePt) * 1pt * v-bind(pageZoom)); line-height: v-bind(h1LineHeight); font-weight: v-bind(h1FontWeight); margin: 0.67em 0; }
.rich-content .ProseMirror h2 { font-family: v-bind(h2FontFamily); font-size: calc(v-bind(h2FontSizePt) * 1pt * v-bind(pageZoom)); line-height: v-bind(h2LineHeight); font-weight: v-bind(h2FontWeight); margin: 0.6em 0; }
.rich-content .ProseMirror h3 { font-family: v-bind(h3FontFamily); font-size: calc(v-bind(h3FontSizePt) * 1pt * v-bind(pageZoom)); line-height: v-bind(h3LineHeight); font-weight: v-bind(h3FontWeight); margin: 0.5em 0; }
.rich-content .ProseMirror h4 { font-family: v-bind(h4FontFamily); font-size: calc(v-bind(h4FontSizePt) * 1pt * v-bind(pageZoom)); line-height: v-bind(h4LineHeight); font-weight: v-bind(h4FontWeight); margin: 0.4em 0; }
.rich-content .ProseMirror blockquote {
  border-left: 3px solid #3b82f6;
  padding-left: 1em;
  margin: 0.5em 0;
  color: #6b7280;
}
.rich-content .ProseMirror pre {
  background: rgba(0,0,0,0.1);
  padding: 0.75em 1em;
  border-radius: 4px;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 0.9em;
  overflow-x: auto;
}
.rich-content .ProseMirror code {
  background: rgba(0,0,0,0.08);
  padding: 0.1em 0.3em;
  border-radius: 3px;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 0.9em;
}
.rich-content .ProseMirror ul,
.rich-content .ProseMirror ol { padding-left: 1.5em; margin: 0.3em 0; }
.rich-content .ProseMirror li { margin: 0.15em 0; }
.rich-content .ProseMirror hr { border: none; border-top: 1px solid; margin: 1em 0; opacity: 0.3; }
.rich-content .ProseMirror img {
  display: block;
  max-width: 100%;
  width: auto;
  height: auto;
  border-radius: 4px;
  margin: 0.75em auto;
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
  cursor: pointer;
  outline: 2px solid transparent;
  outline-offset: 2px;
  transition: outline-color 0.15s;
}
/* 图片被选中时（点击选中）的蓝色高亮 */
.rich-content .ProseMirror img.ProseMirror-selectednode,
.rich-content .ProseMirror .ProseMirror-selectednode img {
  outline-color: rgba(59, 130, 246, 0.7);
  box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.15), 0 2px 8px rgba(0,0,0,0.1);
  border-radius: 4px;
}
.rich-content .ProseMirror table { border-collapse: collapse; margin: 0.5em 0; width: 100%; table-layout: fixed; }
.rich-content .ProseMirror th,
.rich-content .ProseMirror td { border: 1px solid; padding: 0.4em 0.6em; text-align: left; overflow-wrap: break-word; word-break: break-word; }
.rich-content .ProseMirror th { font-weight: 600; }
/* 表格单元格选中高亮（Ctrl/Cmd+点击选中单元格时） */
.rich-content .ProseMirror .selectedCell {
  background: rgba(59, 130, 246, 0.18);
  outline: 2px solid rgba(59, 130, 246, 0.45);
  outline-offset: -1px;
  position: relative;
}
.rich-content .ProseMirror .selectedCell::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(59, 130, 246, 0.06);
  pointer-events: none;
}
.rich-content .ProseMirror a { color: #3b82f6; text-decoration: underline; cursor: pointer; }
.rich-content .ProseMirror s { text-decoration: line-through; opacity: 0.7; }
.rich-content .ProseMirror mark { background: rgba(251, 191, 36, 0.3); padding: 0 2px; border-radius: 2px; }
.rich-content .ProseMirror p { margin: 0.3em 0; }

/* ── 素材卡片视图 ── */
.rich-editor-wrapper.is-material .ProseMirror {
  font-family: 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', sans-serif;
  line-height: 1.85;
  padding: 1.5rem 2rem;
  max-width: 860px;
  margin: 0 auto;
}
/* 卡片标题 h2 */
.rich-editor-wrapper.is-material .ProseMirror h2 {
  font-size: 1.05em;
  font-weight: 700;
  margin: 1.6em 0 0.7em 0;
  padding: 0.55em 0.8em;
  background: v-bind(cardTitleBg);
  border-left: 3.5px solid v-bind(cardAccent);
  border-radius: 0 8px 8px 0;
  color: v-bind(cardAccent);
  letter-spacing: 0.02em;
}
.rich-editor-wrapper.is-material .ProseMirror h2:first-child {
  margin-top: 0.2em;
}
/* 素材间分隔线 */
.rich-editor-wrapper.is-material .ProseMirror hr {
  border: none;
  height: 2px;
  background: v-bind(cardDivider);
  margin: 1.8em 0;
  opacity: 1;
}
/* 元信息（斜体文本） */
.rich-editor-wrapper.is-material .ProseMirror em {
  font-style: normal;
  font-size: 0.82em;
  color: v-bind(cardMetaColor);
  display: inline-block;
  padding: 0.25em 0.55em;
  background: v-bind(metaBg);
  border-radius: 4px;
  letter-spacing: 0.01em;
}

/* ── Diff 回放高亮 ── */
.rich-content .ProseMirror .diff-change-highlight {
  background: linear-gradient(180deg, rgba(59,130,246,0.15) 0%, rgba(59,130,246,0.25) 100%);
  border-bottom: 2px solid rgba(59,130,246,0.5);
  padding: 1px 2px;
  border-radius: 2px;
}
/* 高亮内的 mark 保留原样式 */
.rich-content .ProseMirror .diff-change-highlight mark {
  background: inherit;
}

/* ── 搜索高亮 ── */
.rich-content .ProseMirror .search-highlight {
  background: rgba(255, 193, 7, 0.4);
  border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(255, 193, 7, 0.3);
}

/* ── 工具栏按钮 ── */
.rich-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  width: 26px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  background: transparent;
  color: v-bind(btnText);
  transition: background 0.15s, color 0.15s;
}
.rich-btn:hover {
  background: v-bind(btnHoverBg);
}
.rich-btn-active {
  background: v-bind(btnActiveBg) !important;
  color: v-bind(btnActiveText) !important;
}

/* ── 分隔符 ── */
.rich-sep {
  display: inline-block;
  width: 1px;
  height: 16px;
  margin: 0 3px;
}

/* ── 下拉菜单 ── */
.rich-dropdown {
  position: absolute;
  border: 1px solid;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
}
.rich-dropdown-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 10px;
  cursor: pointer;
  transition: background 0.1s;
  color: v-bind(dropdownItemColor);
}
.rich-dropdown-item:hover {
  background: v-bind(ddHoverBg);
}
.rich-dropdown-active {
  background: v-bind(btnActiveBg);
  color: v-bind(btnActiveText);
}

/* ── 颜色选择器 ── */
.rich-color-grid {
  display: grid;
  grid-template-columns: repeat(5, 20px);
  gap: 6px;
}
.rich-color-swatch {
  width: 20px;
  height: 20px;
  border-radius: 3px;
  border: 1px solid rgba(0,0,0,0.12);
  cursor: pointer;
  padding: 0;
  transition: transform 0.1s, box-shadow 0.1s;
}
.rich-color-swatch:hover {
  transform: scale(1.1);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.35);
  z-index: 1;
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

/* ── 表格格选面板 ── */
.rich-table-picker {
  border: 1px solid;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.3);
}
.rich-table-grid {
  display: grid;
  grid-template-columns: repeat(10, 18px);
  grid-template-rows: repeat(10, 18px);
  gap: 2px;
}
.rich-table-cell {
  width: 18px;
  height: 18px;
  border: 1px solid v-bind(tbBorder);
  border-radius: 2px;
  cursor: pointer;
  transition: background 0.1s;
}
.rich-table-cell-active {
  background: rgba(59, 130, 246, 0.25);
  border-color: rgba(59, 130, 246, 0.5);
}
.rich-table-cell-header {
  background: rgba(59, 130, 246, 0.15);
}

/* ── 表格列控手柄 ── */
.rich-content .ProseMirror .column-resize-handle {
  position: absolute;
  right: -2px;
  top: 0;
  bottom: 0;
  width: 4px;
  background: rgba(59, 130, 246, 0.4);
  cursor: col-resize;
  z-index: 1;
  pointer-events: auto;
}

/* ── 查找替换面板 ── */
.rich-search-panel {
  gap: 4px;
}
.rich-search-input {
  border: 1px solid;
}
.rich-search-input:focus {
  border-color: #3b82f6 !important;
}
.rich-search-btn {
  height: 24px;
  padding: 0 6px;
  border-radius: 3px;
  border: 1px solid v-bind(tbBorder);
  cursor: pointer;
  background: transparent;
  color: v-bind(btnText);
  transition: background 0.15s;
  display: inline-flex;
  align-items: center;
}
.rich-search-btn:hover:not(:disabled) {
  background: v-bind(btnHoverBg);
}
.rich-search-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
</style>
