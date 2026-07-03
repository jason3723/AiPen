# AiPen Markdown 编辑器技术规范

> **文档目的**：本文档详细记录了当前 Markdown 编辑器的完整技术实现。当你对编辑器进行大规模修改后，可对照本文档恢复或参考原有设计。
>
> **创建日期**：2026-07-03
> **适用组件**：`src/components/Editor.vue`

---

## 1. 技术栈

| 层级 | 技术 | 说明 |
|---|---|---|
| 框架 | Vue 3 + Composition API + TypeScript | `<script setup lang="ts">` |
| 编辑器引擎 | **CodeMirror 6** | 非 TipTap / ProseMirror / Milkdown |
| 状态管理 | Pinia (`documentStore` + `materialStore`) | 文档内容和素材状态 |
| 样式方案 | Tailwind CSS + 内联 `<style>` 块 | 无独立 CSS 文件 |
| 桌面运行时 | Tauri v2 (`@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-fs`, `@tauri-apps/api/path`) | 图片保存、文件对话框 |

### 1.1 CodeMirror 6 依赖包

```
@codemirror/view           — EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, Decoration, ViewPlugin
@codemirror/state          — EditorState, Extension, Compartment, StateEffect, StateField
@codemirror/lang-markdown  — markdown(), markdownLanguage
@codemirror/commands       — defaultKeymap, history, historyKeymap, undo, redo
@codemirror/language       — syntaxHighlighting, defaultHighlightStyle, foldGutter, foldKeymap, foldService
@codemirror/theme-one-dark — oneDark (深色主题)
@codemirror/search         — search, searchKeymap, openSearchPanel, closeSearchPanel
@codemirror/language-data  — languages (代码语言数据，用于代码块语法高亮)
```

> **注意**：`package.json` 中残留了 `@milkdown/*` 依赖（core, plugin-listener, preset-commonmark, vue），这些包在当前源码中**未被使用**，属于遗留依赖。

---

## 2. 组件 Props

```ts
defineProps<{
  modelValue: string        // 编辑器内容（双向绑定）
  readonly?: boolean        // 只读模式
  editMode?: "document" | "material"  // 编辑模式：文档 / 素材
  materialId?: string       // 素材 ID（素材模式时使用）
}>()
```

## 3. 组件 Emits

```ts
defineEmits<{
  'update:modelValue': [value: string]    // v-model 双向绑定
  'clip-material': [text: string]         // 存入素材库
  'insert-to-chat': [text: string]        // 添加到 AI 对话
  'delete-material': [selectionStart: number]  // 删除素材
  'remove-from-tag': [selectionStart: number]  // 从标签移除
}>()
```

## 4. defineExpose（父组件可调用的公开方法）

| 方法 | 签名 | 说明 |
|---|---|---|
| `getSelectedText` | `() => string` | 获取当前选中文本 |
| `scrollToBottom` | `() => void` | 滚动到编辑器底部 |
| `scrollToPosition` | `(pos: number) => void` | 滚动到指定字符偏移位置（居中显示） |
| `highlightRange` | `(from: number, to: number, duration?: number) => void` | 临时高亮一段文本，默认 800ms 后自动取消 |
| `applyRangeChange` | `(from: number, to: number, insert: string) => void` | 在指定范围替换文本 |

---

## 5. 核心内部状态变量

```ts
const editorRef = ref<HTMLDivElement>()  // CodeMirror 挂载的 DOM 元素
let view: EditorView | null = null       // CodeMirror 编辑器实例
let syncing = false                       // 防循环标记（防止 watch 和 updateListener 相互触发）
let _highlightTimer: ReturnType<typeof setTimeout> | null = null  // Diff 高亮自动取消定时器

// Compartment（CodeMirror 动态扩展切换机制）
const editableCompartment = new Compartment()   // 可编辑/只读 切换
const themeCompartment = new Compartment()       // 主题 切换
```

---

## 6. 编辑器初始化 → `createEditor()`

### 6.1 扩展列表（按加载顺序）

```
1. themeCompartment.of(isLight ? lightTheme : oneDark)     ← 主题（Compartment 管理）
2. markdown({ base: markdownLanguage, codeLanguages: languages })  ← Markdown 语法
3. syntaxHighlighting(defaultHighlightStyle, { fallback: true })    ← 语法高亮
4. history()                                                         ← 撤销/重做历史
5. foldGutter()                                                      ← 折叠栏
6. headingFoldService                                                ← 自定义折叠服务（见 §7）
7. keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap])  ← 键盘快捷键
8. search({ top: true })                                             ← 搜索（面板放顶部）
9. EditorState.phrases.of({...})                                     ← 中文翻译
10. lineNumbers()                                                    ← 行号
11. highlightActiveLine()                                            ← 高亮当前行
12. activeLineGutterHighlighter                                      ← 行号栏高亮（ViewPlugin，见 §8）
13. drawSelection()                                                  ← 选区绘制
14. EditorView.lineWrapping                                          ← 自动换行
15. EditorState.tabSize.of(2)                                        ← Tab = 2 空格
16. editableCompartment.of(EditorView.editable.of(!props.readonly))  ← 可编辑性（Compartment）
17. highlightField                                                   ← Diff 高亮装饰器（StateField，见 §9）
18. EditorView.updateListener.of(...)                                ← 内容变更监听（v-model 同步）
19. EditorView.domEventHandlers({...})                               ← DOM 事件（粘贴/右键/滚轮，见 §10）
```

### 6.2 创建流程

```ts
const state = EditorState.create({
  doc: props.modelValue || '',
  extensions,
})
view = new EditorView({ state, parent: el })
```

在 `onMounted` 中通过 `requestAnimationFrame(createEditor)` 延迟创建，确保 DOM 就绪。

在 `onBeforeUnmount` 中调用 `view?.destroy()` 并置空 `view`。

---

## 7. 自定义折叠服务 → `headingFoldService`

基于 `foldService.of()` 实现，支持两种折叠：

### 7.1 标题折叠

- **触发条件**：行首匹配 `^(#{1,6})\s`，且该行前有空行或为文档首行
- **折叠范围**：从标题行尾到下一个同级或更高级标题之前
- **边界规则**：折叠终点遇到 `level ≤ 当前标题 level` 的同级/上级标题时停止
- **尾部空白处理**：去除末尾多余的换行符

### 7.2 段落折叠

- **触发条件**：非空行、非代码围栏、非标题的普通段落
- **折叠范围**：仅折叠本段（从 `line.from` 到 `line.to-1`，最后一行到 `line.to`）
- **空行跳过**：`!text.trim()` 的行不提供折叠

### 7.3 排除项

- 代码围栏行（匹配 `^(```|~~~)`）不提供自定义折叠，交由 markdown 内置折叠处理

---

## 8. 左侧行号栏高亮 → `activeLineGutterHighlighter`

### 8.1 类型

基于 `ViewPlugin.fromClass` 实现的 ViewPlugin。

### 8.2 工作流程

1. **构造函数**：调用 `this.sync()` 初始化
2. **update 钩子**：当 `update.selectionSet` 或 `update.docChanged` 时重新同步
3. **sync 逻辑**：
   - 获取当前光标所在行号 → `state.doc.lineAt(state.selection.main.head)`
   - 在 `.cm-lineNumbers` 容器中查找 `textContent === 行号` 的 DOM 元素
   - 为该元素添加 CSS class `cm-activeLineGutter`
4. **destroy**：移除之前的高亮 class

---

## 9. Diff 高亮装饰器 → `highlightField`

### 9.1 类型

基于 `StateField.define<DecorationSet>` 实现的 StateField。

### 9.2 Effect 定义

```ts
addHighlight    = StateEffect.define<{ from: number; to: number }>()  // 添加高亮
clearHighlights = StateEffect.define()                                  // 清除高亮
```

### 9.3 用法

- 调用 `defineExpose` 中的 `highlightRange(from, to, duration?)` 方法
- 该方法 dispatch `addHighlight` effect，高亮范围 `[from, to)` 内的文本
- 默认 800ms 后自动 dispatch `clearHighlights` 清除
- 高亮样式类：`.cm-diff-highlight`

### 9.4 CSS 动画

```css
.cm-diff-highlight {
  background: rgba(59, 130, 246, 0.25);
  border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.3);
  transition: background 0.3s ease;
}
```

---

## 10. DOM 事件处理 → `EditorView.domEventHandlers`

### 10.1 paste 事件

- **逻辑**：检测剪贴板中是否有 `image/*` 类型的数据
- **有图片**：阻止默认粘贴 → 调用 `handleImagePaste()` → 保存到本地 `{appLocalDataDir}/images/` → 插入 `![fileName](filePath)`
- **无图片**：返回 `false`，走 CodeMirror 默认粘贴逻辑

### 10.2 contextmenu 事件

- **逻辑**：阻止默认右键菜单 → 记录当前选区信息（`from`, `to`, 选中文本） → 记录鼠标坐标 → 设置 `ctxMenuShow = true` → 显示自定义右键菜单
- 右键菜单通过 `<Teleport to="body">` 渲染在 body 层级，避免 z-index 问题

### 10.3 wheel 事件

- **逻辑**：检测 `ctrlKey || metaKey` → 阻止默认滚动 → `setFontSize(fontSize + (deltaY > 0 ? -2 : 2))`
- 实现 Ctrl+滚轮 缩放字体功能
- 无 Ctrl 时返回 `false`，走正常滚动

---

## 11. 双向绑定同步机制

### 11.1 编辑器 → 外部（updateListener）

```ts
EditorView.updateListener.of((update) => {
  if (update.docChanged && !syncing) {
    emit('update:modelValue', update.state.doc.toString())
  }
})
```

- 仅在内容变化且非外部同步中时触发
- 通过 `syncing` 标志防止循环

### 11.2 外部 → 编辑器（watch modelValue）

```ts
watch(() => props.modelValue, async (newVal) => {
  if (!view) return
  await nextTick()
  const current = view.state.doc.toString()
  if (newVal !== current) {
    syncing = true
    // 流式追加优化：如果新内容以当前内容为前缀，只追加增量
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
})
```

- **流式追加优化**：如果新内容是当前内容的前缀扩展（AI 流式生成），只 dispatch 增量部分，避免全量替换，保持光标位置和滚动位置稳定
- **全量替换**：内容不匹配时完全替换

---

## 12. 只读状态同步

```ts
watch(() => props.readonly, (isReadonly) => {
  if (!view) return
  view.dispatch({
    effects: editableCompartment.reconfigure(EditorView.editable.of(!isReadonly)),
  })
})
```

通过 `editableCompartment.reconfigure()` 动态切换编辑器的可编辑状态，无需重建编辑器。

---

## 13. 主题系统

### 13.1 主题类型

| 主题 | 实现 | 存储 |
|---|---|---|
| Light | `EditorView.theme({...}, { dark: false })` 自定义配置 | `localStorage['editor-theme']` |
| Dark | `oneDark`（`@codemirror/theme-one-dark`） | `localStorage['editor-theme']` |

### 13.2 切换机制

```ts
function toggleTheme() {
  isLight.value = !isLight.value
  localStorage.setItem('editor-theme', isLight.value ? 'light' : 'dark')
  v.dispatch({ effects: themeCompartment.reconfigure(isLight.value ? lightTheme : oneDark) })
  // 轻触选中态强制 drawSelection 立即重绘光标
  const sel = v.state.selection.main
  v.dispatch({ selection: { anchor: sel.anchor, head: sel.head }, scrollIntoView: false })
  requestAnimationFrame(() => v.requestMeasure())
}
```

- 通过 `themeCompartment.reconfigure()` 切换主题扩展
- 切换后轻触选中态（重设相同 selection）触发光标重绘
- 调用 `requestAnimationFrame(() => v.requestMeasure())` 确保布局同步

### 13.3 浅色主题 CSS 变量覆盖（lightTheme）

浅色主题通过 `EditorView.theme()` 直接设置以下样式规则：

- `&` → `backgroundColor: #ffffff`
- `.cm-content` → 文字色 `#1a1a1a`，光标色 `#000000`
- `.cm-cursor` 系列 → `borderLeftColor: #000000`
- `.cm-selectionBackground` → `rgba(3, 102, 214, 0.15)`
- `.cm-activeLine` → `transparent`
- `.cm-gutters` → 背景 `#fafbfc`，文字 `#656d76`，右边框 `#d0d7de`
- `.cm-foldGutter` → `#8b949e`（默认）/ `#24292f`（hover）
- `.cm-activeLineGutter` → 背景 `rgba(59, 130, 246, 0.1)`，文字 `#2563eb`
- `.cm-search` → 面板背景、边框、输入框、标签、按钮完整配色

### 13.4 光标过渡消除

```css
.cm-container .cm-editor .cm-cursor,
.cm-container .cm-editor .cm-cursor-secondary,
.cm-container .cm-editor .cm-dropCursor {
  transition: none !important;
}
.cm-container .cm-editor .cm-cursorLayer {
  animation: none !important;
}
```

---

## 14. 字体系统

### 14.1 可选字体列表

```
等线, 微软雅黑, 宋体, 黑体, 楷体, 仿宋, 京華老宋体, 华文楷体, 华文宋体, 方正仿宋简体
```

### 14.2 存储

- `localStorage['editor-fontFamily']` → 字体名称（默认 `'等线'`）
- `localStorage['editor-fontSize']` → 字号（默认 `14`）

### 14.3 字体设置

- `setFontFamily(f)` → 写入 localStorage → `nextTick(() => view?.requestMeasure())`
- `setFontSize(size)` → 限制范围 `[10, 32]` → 300ms 防抖写入 localStorage → `nextTick(() => view?.requestMeasure())`
- `zoomIn()` / `zoomOut()` → 步长 ±2

### 14.4 CSS 变量应用

```css
.cm-container .cm-editor {
  font-size: var(--cm-font-size, 14px);
}
.cm-container .cm-editor .cm-content {
  font-family: var(--cm-font-family, '等线'), 'Microsoft YaHei', '微软雅黑', sans-serif;
  font-size: var(--cm-font-size, 14px);
}
```

CSS 变量通过 template 中的 style 绑定设置：

```html
<div ref="editorRef" :style="{ '--cm-font-size': fontSize + 'px', '--cm-font-family': fontFamily }" />
```

---

## 15. 工具栏 → `execCmd(cmd)`

### 15.1 工具栏按钮定义

```ts
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
```

### 15.2 工具栏布局

```
[B] [I] [S̶] [`] [H1] [H2] [H3] [•] [1.] [❝] [—] [▦] [🖼] [↩] [↪] | [🌙/☀] | [字体选择] [A⁺] [A⁻] | [🔍 查找替换] .......... [语法说明]
```

分隔符：`w-px h-4` 竖线，浅色 `bg-gray-300`，深色 `bg-gray-700`。

### 15.3 命令实现

| 命令 | 操作 | 实现方式 |
|---|---|---|
| `bold` | 粗体 | `wrap('**', '**')` |
| `italic` | 斜体 | `wrap('*', '*')` |
| `strike` | 删除线 | `wrap('~~', '~~')` |
| `code` | 行内代码 | `wrap('`', '`')` |
| `h1` | 一级标题 | `prefixLines('# ')` |
| `h2` | 二级标题 | `prefixLines('## ')` |
| `h3` | 三级标题 | `prefixLines('### ')` |
| `bullet` | 无序列表 | `prefixLines('- ')` |
| `ordered` | 有序列表 | `prefixLines('1. ')` |
| `blockquote` | 引用 | `prefixLines('> ')` |
| `hr` | 分割线 | `state.replaceSelection('\n\n---\n\n')` |
| `table` | 插入表格 | 插入 3 列表格骨架 |
| `image` | 插入图片 | 弹出文件对话框，插入 `![name](path)` |
| `undo` | 撤销 | `undo(view)` |
| `redo` | 重做 | `redo(view)` |

#### wrap 辅助函数

```ts
function wrap(prefix: string, suffix: string) {
  const insert = prefix + sel + suffix
  const anchor = from + prefix.length
  const head = anchor + sel.length
  view!.dispatch({
    changes: { from, to, insert },
    selection: sel ? { anchor, head } : undefined,
  })
}
```

- 有选中文本时：包裹选中文本并保持选区
- 无选中时：在光标位置插入，不设置 selection

#### prefixLines 辅助函数

```ts
function prefixLines(prefix: string) {
  const lineFrom = doc.lineAt(from)
  const lineTo = doc.lineAt(to)
  const changes: { from: number; insert: string }[] = []
  for (let i = lineFrom.number; i <= lineTo.number; i++) {
    changes.push({ from: doc.line(i).from, insert: prefix })
  }
  view!.dispatch({ changes })
}
```

- 对选区覆盖的每一行头部插入前缀
- 使用 dispatch 一次提交所有更改

---

## 16. 右键菜单系统

### 16.1 状态

```ts
const ctxMenuShow = ref(false)
const ctxMenuX = ref(0)        // 鼠标 X 坐标
const ctxMenuY = ref(0)        // 鼠标 Y 坐标
const ctxMenuSelStart = ref(0) // 选区起始位置
const ctxMenuSelEnd = ref(0)   // 选区结束位置
const ctxMenuSelText = ref('') // 选中文本内容
```

### 16.2 渲染方式

通过 `<Teleport to="body">` 渲染在 body 层级，包含：
- 上下文菜单容器（`position: fixed; z-index: 10000`）
- 透明遮罩层（`z-index: 9999`，点击关闭菜单）

### 16.3 菜单项

#### 文档模式（`editMode` 为 `undefined` 或 `'document'`）

| 菜单项 | 快捷键提示 | 条件 |
|---|---|---|
| 剪切 | Ctrl+X | 始终显示 |
| 复制 | Ctrl+C | 始终显示 |
| 粘贴 | Ctrl+V | 始终显示 |
| --- 分隔线 --- | | |
| 📦 存入素材库 | | 有选中文本 |
| 💬 添加到 AI 对话 | | 有选中文本 |

#### 素材模式（`editMode === 'material'`）

| 菜单项 | 快捷键提示 | 条件 |
|---|---|---|
| 复制 | Ctrl+C | 始终显示 |
| 💬 添加到 AI 对话 | | 有选中文本 |
| --- 分隔线 --- | | |
| 🗑 删除素材 | | 有 `materialId`（单素材视图） |
| 🔗 从此标签中移除 | | 无 `materialId` + 有选中文本（标签视图） |
| 🗑 从素材库中删除 | | 无 `materialId` + 有选中文本（标签视图） |

### 16.4 右键菜单样式

```css
.ctx-menu           → position: fixed; z-index: 10000; background: #1e1e2e; border: 1px solid #3b3b5c
.ctx-menu-item      → flex; justify-content: space-between; padding: 5px 12px; color: #c0caf5
.ctx-menu-item:hover → background: #29293d
.ctx-menu-item-danger → color: #ef4444 !important
.ctx-menu-item-danger:hover → background: rgba(239, 68, 68, 0.15) !important
.ctx-shortcut       → color: #565f89; font-size: 11px; margin-left: 16px
.ctx-separator      → height: 1px; background: #3b3b5c; margin: 3px 0
.ctx-overlay        → position: fixed; inset: 0; z-index: 9999
```

---

## 17. 查找替换面板

### 17.1 状态管理

```ts
let searchOpen = false  // 非响应式变量
```

### 17.2 面板生命周期

- `toggleSearch()` → 切换开关
- 打开时：`openSearchPanel(view)` + 监听 `.cm-panels` 的 `MutationObserver` 检测面板被关闭
- 关闭时：`closeSearchPanel(view)`
- 面板位置：`search({ top: true })`，在编辑器顶部

### 17.3 中文翻译

搜索面板内置文本通过 `EditorState.phrases.of()` 翻译为中文：
查找、替换、下一个、上一个、全部、区分大小写、正则、全词匹配、替换、全部替换、关闭、跳到行、跳转、当前匹配等。

---

## 18. 图片粘贴处理 → `handleImagePaste()`

### 18.1 触发条件

粘贴事件中检测到 `item.type.startsWith('image/')`

### 18.2 处理流程

```
粘贴图片
  → 从 DataTransferItem 获取 Blob
  → 读取 ArrayBuffer → Uint8Array
  → 扩展名处理：jpeg → jpg
  → 拼接路径：{appLocalDataDir}/images/img_{timestamp}_{uuid}.{ext}
  → mkdir(imagesDir, { recursive: true })
  → writeFile(filePath, data)
  → 选区位置插入：![fileName](filePath)
  → 错误时 console.error
```

### 18.3 文件命名格式

```
img_{Date.now()}_{crypto.randomUUID().slice(0, 8)}.{ext}
```

---

## 19. 语法说明弹窗

### 19.1 触发

工具栏右侧「语法说明」按钮，点击设置 `showSyntaxGuide = true`

### 19.2 渲染

通过 `<Teleport to="body">` 渲染，包含：
- 模糊背景遮罩（`bg-black/40 backdrop-blur-md`）
- 弹窗容器（`max-w-2xl, max-h-[85vh]`，深色主题 `bg-gray-900`）
- 标题栏：「📝 Markdown 语法教程」+ 关闭按钮
- 内容区（7 个章节）：标题、文字样式、列表、引用、链接与图片、表格、分割线与代码块、快捷操作
- 底部版权：「© 2026 AiPen. All rights reserved.」

### 19.3 关闭方式

- 点击 ✕ 按钮
- 点击遮罩区域（`@click.self`）

---

## 20. 全局 CSS 规范

### 20.1 CodeMirror 容器

```css
.cm-container { min-height: 0; overflow: hidden; }
.cm-container .cm-editor { height: 100%; font-size: var(--cm-font-size, 14px); line-height: 1.5; }
.cm-container .cm-editor .cm-scroller { padding: 0 0.75rem 0 0; }  /* 顶部 0，右侧 0.75rem */
.cm-container .cm-editor .cm-gutters { padding-right: 4px; }
```

### 20.2 行号栏

```css
.cm-container .cm-editor .cm-lineNumbers .cm-gutterElement {
  border-left: 3px solid transparent;
  padding-left: 2px;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
```

### 20.3 行号高亮

```css
.cm-activeLineGutter {
  border-left: 3px solid #3b82f6;
  padding-left: 2px !important;
  transition: background 0.15s ease, color 0.15s ease;
}
```

### 20.4 搜索面板

```css
.cm-search           → padding: 6px 8px; flex; flex-wrap: wrap; gap: 4px
.cm-search input     → height: 24px; padding: 2px 6px; font-size: 12px; border-radius: 3px; min-width: 120px
.cm-search input:focus → border-color: #3b82f6
.cm-search label      → font-size: 9px
.cm-search button     → height: 24px; padding: 2px 8px; font-size: 11px; border-radius: 3px
```

### 20.5 光标

```css
/* 消除切换主题时的过渡延迟 */
.cm-cursor, .cm-cursor-secondary, .cm-dropCursor { transition: none !important; }
.cm-cursorLayer { animation: none !important; }
```

---

## 21. 编辑器关键架构决策

### 21.1 Compartment 动态切换

- **为什么用 Compartment**：避免重建编辑器实例，实现热切换扩展
- **使用场景**：
  - `editableCompartment`：只读 / 可编辑切换
  - `themeCompartment`：浅色 / 深色主题切换

### 21.2 流式追加优化

- **场景**：AI 生成内容时，新内容是当前内容的渐进追加
- **实现**：`newVal.startsWith(current)` 时只 dispatch 增量部分
- **好处**：保持光标位置、滚动位置、选区状态不被覆盖

### 21.3 syncing 防循环机制

- `syncing = true` 时 `updateListener` 不触发 `emit`
- 仅在外部 `watch(modelValue)` 驱动编辑器更新时设为 `true`
- 编辑器内部编辑时 `syncing` 为 `false`，正常触发 emit

### 21.4 EditorView.theme() vs 外部 CSS

- **规则**：主题颜色（特别是光标颜色 `caretColor`、`borderLeftColor`）通过 `EditorView.theme()` 内置管理，不依赖外部 CSS
- **原因**：外部 CSS 时序不可控，会造成浅/深色切换时光标颜色闪现错误
- **外部 CSS**：仅用于布局（padding、margin、尺寸、动画过渡等）和主题无关的样式

---

## 22. 相关文件索引

### 编辑器核心

| 文件 | 说明 |
|---|---|
| `src/components/Editor.vue` | **本文档对应的组件**，CodeMirror 6 编辑器完整实现 |

### 编辑器使用者

| 文件 | 说明 |
|---|---|
| `src/views/EditorView.vue` | 主视图容器，引用 Editor 组件并协调整体布局 |

### 与编辑器交互的子组件

| 文件 | 说明 |
|---|---|
| `src/components/SkillPanel.vue` | 写作技能面板，通过 `selectedText` 获取编辑器选中文本 |
| `src/components/ChatPanel.vue` | AI 对话面板，接收编辑器注入文本 |
| `src/components/ComposeWorkbench.vue` | 智能写作工作台，向编辑器流式推送 AI 生成内容 |
| `src/components/MaterialPanel.vue` | 素材面板，切换编辑器为素材编辑模式 |
| `src/components/MaterialClipDialog.vue` | 素材剪藏弹窗（编辑器右键"存入素材库"触发） |

### 工具层

| 文件 | 说明 |
|---|---|
| `src/utils/diff.ts` | Myers 差分算法，驱动 Diff 回放动画 |
| `src/utils/exportWord.ts` | Markdown → Word (.docx) 导出 |

### 状态管理

| 文件 | 说明 |
|---|---|
| `src/stores/document.ts` | 文档内容/版本/Diff/AI 分析状态 |
| `src/stores/materialStore.ts` | 素材内容/标签状态 |

### 全局样式

| 文件 | 说明 |
|---|---|
| `src/styles/main.css` | 全局 Tailwind + 滚动条样式 |

---

## 23. 已知问题 & 注意事项

1. **`@milkdown/*` 遗留依赖**：`package.json` 中声明但未使用，清理时需注意
2. **searchOpen 非响应式**：`let searchOpen = false` 不是 `ref`，MutationObserver 关闭检测依赖 DOM 变化
3. **右键菜单无浅色主题适配**：右键菜单始终使用深色配色（`#1e1e2e` 背景）
4. **语法说明弹窗始终深色**：弹窗固定使用 `bg-gray-900` 深色主题，未跟随编辑器主题切换
5. **图片路径使用本地绝对路径**：`{appLocalDataDir}/images/` 下的文件路径直接写入 Markdown，跨设备迁移需注意
6. **highlightRange 的高亮定时器**：连续调用时旧的定时器会被清除，以最后一次调用为准
