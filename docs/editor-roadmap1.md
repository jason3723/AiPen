# AiPen 富文本编辑器迁移技术路线图

> **目标**：从 CodeMirror 6 Markdown 编辑器迁移至 TipTap（ProseMirror）富文本编辑器，实现 Word 级 WYSIWYG 编辑体验，同时保持现有所有功能（流式 AI 更新、Diff 高亮、右键菜单等），并为高精度 Word 导出打下结构化数据基础。
>
> **核心原则**：旧编辑器不删，Phase 1 开始并行，用 feature flag 切换，随时可切回。等所有阶段稳定后才移除 CM6。
>
> **创建日期**：2026-07-03

---

## 1. 背景与动机

### 1.1 当前痛点

| 问题 | 现状 |
|---|---|
| 视觉体验 | CodeMirror 6 是源码编辑器，不渲染标题字号差异、不隐藏 Markdown 标记符号 |
| 表格编辑 | 竖线 + 横线字符，无法像 Word 一样可视化编辑 |
| 图片显示 | 只显示 `![alt](path)` 文本，不渲染预览 |
| Word 导出精度 | Markdown 是 plain text，解析器永远无法 100% 准确（**粗体跨行、嵌套列表、复杂表格都是坑**） |
| 排版设置 | 用户在 exportSettings 中设置的对齐/缩进/行距无法在编辑器中预览 |

### 1.2 目标体验

- ✅ 标题用实际字号 + 加粗呈现
- ✅ 粗体/斜体/删除线隐藏标记符号，直接显示格式化效果
- ✅ 表格可视化编辑（拖拽列宽、插入行列）
- ✅ 图片内联预览
- ✅ 导出 Word 时精确保留格式（字体、字号、对齐、缩进、行距）

---

## 2. 技术选型

### 2.1 选定方案：TipTap（基于 ProseMirror）

| 维度 | 评估 |
|---|---|
| Word 级 WYSIWYG | ✅ 标题/粗体/斜体/列表/表格/图片都有成熟扩展 |
| Vue 3 集成 | ✅ `@tiptap/vue-3`，与现有技术栈一致 |
| 流式 AI 更新 | ✅ ProseMirror 基于事务，天然支持增量应用 |
| Diff 高亮动画 | ✅ ProseMirror Decoration 系统（与 CM6 同机制，更易用） |
| Word 导出精度 | ✅ ProseMirror JSON → docx 结构化映射，远优于 Markdown 解析 |
| 生态 | ✅ 插件丰富（fontFamily、fontSize、textAlign、highlight、collaboration） |
| 许可证 | ✅ MIT |

### 2.2 对比方案

| | CodeMirror 6（当前） | TipTap（ProseMirror） | CKEditor 5 | Milkdown |
|---|---|---|---|---|
| 编辑体验 | 源码编辑器 | **WYSIWYG 富文本** | WYSIWYG 富文本 | 源码 + 部分 WYSIWYG |
| Vue 3 支持 | 手工封装 | ✅ 官方 `@tiptap/vue-3` | ✅ 官方 | 社区封装 |
| 数据模型 | flat string | **ProseMirror JSON tree** | 自定义 JSON | ProseMirror JSON |
| 流式更新 | startsWith 前缀判断 | setContent + step 增量 | 可增量但不为此设计 | 同 TipTap |
| Word 导出 | Markdown 正则解析 | **JSON → docx 映射** | 自定义导出 | Markdown 解析 |
| 许可证 | MIT | MIT | GPL-2.0（商用付费） | MIT |
| 表格 | 字符绘制 | `@tiptap/extension-table` | 原生支持 | 基础支持 |

### 2.3 数据模型变化

```
【当前】flat string
"I'm a Markdown string with **bold** and ## headings"

【目标】ProseMirror JSON tree
{
  type: "doc",
  content: [
    { type: "paragraph", content: [
      { type: "text", text: "I'm a Markdown string with " },
      { type: "text", text: "bold", marks: [{ type: "bold" }] },
      { type: "text", text: " and " }
    ]},
    { type: "heading", attrs: { level: 2 }, content: [
      { type: "text", text: "headings" }
    ]}
  ]
}
```

**影响范围**：

| 模块 | 当前 | 迁移后 |
|---|---|---|
| `documentStore.content` | `string` | `object`（JSON）或双字段 |
| `materialStore.content` | `string` | `object` 或双字段 |
| `exportWord.ts` | Markdown 正则解析器 | JSON → docx 映射器 |
| `diff.ts` | 字符级 diff（Myers） | ProseMirror JSON diff |
| AI 流水线 | AI 输出 Markdown | AI 仍输出 Markdown，TipTap 自动解析 |

---

## 3. 分阶段实施计划

### Phase 1：原型验证 + 双编辑器并行 🟢 当前阶段

**目标**：RichEditor.vue 跑通基本编辑能力，旧编辑器保留，开关切换。

#### 3.1.1 依赖安装

```bash
npm install @tiptap/vue-3 @tiptap/starter-kit @tiptap/extension-placeholder \
  @tiptap/extension-font-family @tiptap/extension-font-size \
  @tiptap/extension-text-align @tiptap/extension-highlight \
  @tiptap/extension-table @tiptap/extension-table-row \
  @tiptap/extension-table-cell @tiptap/extension-table-header \
  @tiptap/extension-image @tiptap/extension-link \
  @tiptap/extension-typography @tiptap/extension-history \
  @tiptap/extension-underline
```

#### 3.1.2 新建 RichEditor.vue

> 位置：`src/components/RichEditor.vue`

**必须实现的接口（与 Editor.vue 对等）**：

| 接口 | 类型 | 说明 |
|---|---|---|
| Props: `modelValue` | `string` | v-model 双向绑定（仍用 string 格式过渡） |
| Props: `readonly` | `boolean` | 只读模式 |
| Props: `editMode` | `"document" \| "material"` | 编辑模式 |
| Props: `materialId` | `string` | 素材 ID |
| Emit: `update:modelValue` | `(value: string) => void` | v-model |
| Emit: `clip-material` | `(text: string) => void` | 存入素材库 |
| Emit: `insert-to-chat` | `(text: string) => void` | 添加到对话 |
| Emit: `delete-material` | `(selStart: number) => void` | 删除素材 |
| Emit: `remove-from-tag` | `(selStart: number) => void` | 从标签移除 |
| Expose: `getSelectedText()` | `() => string` | 获取选中文本 |
| Expose: `scrollToBottom()` | `() => void` | 滚动到底部 |
| Expose: `scrollToPosition(pos)` | `(pos: number) => void` | 滚动到指定位置 |
| Expose: `highlightRange(f,t,d?)` | `(from, to, dur?) => void` | 高亮范围 |
| Expose: `applyRangeChange(f,t,ins)` | `(from, to, insert) => void` | 替换文本 |

**第一阶段 TipTap 扩展清单**：

```ts
import StarterKit from '@tiptap/starter-kit'
import TextAlign from '@tiptap/extension-text-align'
import Highlight from '@tiptap/extension-highlight'
import FontFamily from '@tiptap/extension-font-family'
import FontSize from '@tiptap/extension-font-size'
import Underline from '@tiptap/extension-underline'
import Placeholder from '@tiptap/extension-placeholder'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Typography from '@tiptap/extension-typography'
import History from '@tiptap/extension-history'
```

#### 3.1.3 EditorView.vue 编辑器切换

**全局开关**：

```ts
// src/stores/document.ts 中添加
const useRichEditor = ref(localStorage.getItem('editor-engine') === 'tiptap')

function toggleEditorEngine() {
  useRichEditor.value = !useRichEditor.value
  localStorage.setItem('editor-engine', useRichEditor.value ? 'tiptap' : 'codemirror')
}
```

**模板切换**：

```vue
<RichEditor
  v-if="useRichEditor"
  ref="editorRef"
  v-model="displayedContent"
  :readonly="..."
  :editMode="editMode"
  ...
/>
<Editor
  v-else
  ref="editorRef"
  v-model="displayedContent"
  :readonly="..."
  :editMode="editMode"
  ...
/>
```

**关键约束**：`editorRef` 的 `ref` 类型需要 union type 或做类型适配，确保 `.getSelectedText()`、`.scrollToPosition()` 等方法在两个编辑器上都可用。

#### 3.1.4 验证清单

- [ ] 基本文本输入编辑
- [ ] 粗体 / 斜体 / 删除线 / 行内代码
- [ ] 标题 H1-H6
- [ ] 有序 / 无序列表（含嵌套）
- [ ] 引用块
- [ ] 分割线
- [ ] 表格创建与编辑
- [ ] 图片粘贴 + 显示
- [ ] 撤销 / 重做
- [ ] 深色 / 浅色主题
- [ ] 字体 / 字号选择
- [ ] 只读模式
- [ ] 文档内容加载（从现有 Markdown 数据初始化）
- [ ] 素材模式内容显示
- [ ] 右键菜单（剪切/复制/粘贴/存入素材库/添加到AI对话）
- [ ] 查找替换（可暂用浏览器原生 Ctrl+F）
- [ ] 通过开关切回 CodeMirror 6，功能正常

---

### Phase 2：数据模型适配 ⏳

**目标**：documentStore 支持 ProseMirror JSON 存储，新旧格式平滑过渡。

#### 3.2.1 双字段存储

```ts
interface Document {
  // ...
  content: string              // Markdown（向后兼容 CM6）
  contentJSON: object | null   // ProseMirror JSON（TipTap 使用）
}
```

#### 3.2.2 加载逻辑

```ts
// 加载文档时
if (doc.contentJSON) {
  richEditor.commands.setContent(doc.contentJSON)
  cmEditor.setValue(doc.content || proseMirrorToMarkdown(doc.contentJSON))
} else if (doc.content) {
  cmEditor.setValue(doc.content)
  richEditor.commands.setContent(doc.content) // TipTap 自动解析 Markdown
}
```

#### 3.2.3 保存逻辑

```ts
// 保存时双写
async function save() {
  doc.content = richEditor.getHTML()  // 或用 Markdown serializer
  doc.contentJSON = richEditor.getJSON()
  // 保留 content 字段供 CM6 和旧版本使用
}
```

#### 3.2.4 素材库适配

- `materialStore.content` 同理：双字段
- 素材检索/搜索需支持从 JSON 提取纯文本

---

### Phase 3：高级功能迁移 ⏳

**目标**：流式 AI 更新、Diff 回放动画在 TipTap 上实现。

#### 3.3.1 流式内容更新

**方案 1（优先）**：全量替换
```ts
// AI 每次输出新内容
editor.commands.setContent(newContent)
// TipTap 内部做高效的 DOM diff
```
适用场景：短内容；不需要精确光标保持。

**方案 2（高级）**：增量 step 应用
- 对相邻两次 AI 输出做文本 diff
- 将 diff 转换为 ProseMirror Transform steps
- 通过 `editor.view.dispatch(tr)` 增量应用
- 保持光标位置和滚动位置

#### 3.3.2 Diff 高亮动画

```ts
// ProseMirror Decoration 实现
const diffHighlight = Decoration.inline(from, to, {
  class: 'diff-highlight',
})
```
- 与 CM6 的 StateField 机制类似，但 API 更直观
- 高亮动画可复用现有 CSS

#### 3.3.3 scrollEditor() 适配

当前 `scrollEditor()` 直接查询 `.cm-scroller` DOM：
```ts
function scrollEditor() {
  const scroller = document.querySelector('.cm-scroller')
  scroller.scrollTop = scroller.scrollHeight
}
```
改为通过 `editorRef.value.scrollToBottom()` 调用，两个编辑器都实现此方法。

---

### Phase 4：Word 导出重写 ⏳

**目标**：JSON → docx 映射器，exportSettings 精确应用。

**这是迁移的最大收益点。**

#### 3.4.1 架构对比

```
【当前】Markdown string
  → exportWord.ts（手写正则解析）  ← 问题多、精度差
  → docx 对象
  → .docx 文件

【目标】ProseMirror JSON
  → richExportWord.ts（结构化遍历） ← 精确、可预期
  → docx 对象
  → .docx 文件
```

#### 3.4.2 映射规则

| ProseMirror Node | docx 对象 | 可应用的 exportSettings |
|---|---|---|
| `doc` | `new Document()` | 纸张大小、页边距 |
| `heading(level: N)` | `new HeadingLevel(N)` | 字体、字号、颜色 |
| `paragraph` | `new Paragraph()` | 首行缩进、段前段后间距、行距、对齐 |
| `text(mark: bold)` | `new TextRun({ bold: true })` | 字体、字号、颜色 |
| `text(mark: italic)` | `new TextRun({ italics: true })` | 同上 |
| `table` → `tableRow` → `tableCell` | `new Table()` 系列 | 列宽、边框样式 |
| `image` | `new ImageRun()` | 缩放、对齐 |

#### 3.4.3 精度优势

- **字体/字号**：存储在 `text.marks[].attrs.fontFamily` / `fontSize`，导出时直接读取，无解析误差
- **段落排版**：存储在 `paragraph.attrs`（textAlign, indent, lineSpacing），导出时直接应用
- **嵌套列表**：ProseMirror JSON 天然表达层级，不会出现 Markdown 解析器难以处理的嵌套缩进
- **复杂表格**：表格、行、单元格都是结构化 node，列宽、合并单元格均可精确表达

---

### Phase 5：清理与收敛 ⏳

**目标**：确认 TipTap 稳定后移除旧编辑器。

#### 3.5.1 移除清单

- [ ] 删除 `src/components/Editor.vue`
- [ ] 从 `package.json` 移除 CM6 依赖（`@codemirror/*` 系列）
- [ ] 从 `package.json` 移除 Milkdown 遗留依赖
- [ ] 简化 `EditorView.vue` 中的编辑器切换逻辑
- [ ] 移除 `editor-engine` localStorage 开关
- [ ] 更新 `docs/editor-spec.md` → 替换为 TipTap 版技术规范

#### 3.5.2 保留

- [ ] `src/utils/exportWord.ts` → 保留为 fallback，新建 `richExportWord.ts`
- [ ] `src/utils/diff.ts` → 可能需要替换为 JSON diff 版本

---

## 4. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| TipTap 表格不支持合并单元格 | Word 导出质量 | `@tiptap/extension-table` 支持 colspan/rowspan |
| 流式内容性能不如 CM6 | AI 生成体验 | Phase 1 先全量替换；Phase 3 按需优化为增量 step |
| JSON 格式数据库占用增加 | 存储/加载速度 | JSON 可压缩存储；实际增长可控（< 2x） |
| 素材检索需要适配 JSON | 素材库功能 | Phase 2 同时升级检索逻辑 |
| 大文档编辑性能 | 卡顿 | ProseMirror 对大文档有成熟优化；必要时切分渲染 |

---

## 5. 里程碑

```
        Phase 1           Phase 2           Phase 3          Phase 4         Phase 5
        ─────────────────────────────────────────────────────────────────────────────────→
Week:   1-2               3-4               5-6              7-8             9+
        │                 │                 │                │               │
    EditorPage.vue    双字段存储        Diff回放          JSON→docx       CM6移除
    RichEditor.vue    JSON→MD互转       流式优化          exportSettings  依赖清理
    开关切换          素材库适配        右键菜单          高精度导出       spec文档更新
                                       scrollEditor
                                       getSelectedText
        │                 │                 │                │               │
    ────┼─────────────────┼─────────────────┼────────────────┼───────────────┼────
        │                 │                 │                │               │
    Editor.vue 不变    Editor.vue      Editor.vue       Editor.vue      Editor.vue
    继续使用           继续可用         继续可用         继续可用         🗑 删除

    用户可以随时通过 localStorage 开关切换回 CodeMirror 6
```

---

## 6. 开发须知

### 6.1 编辑器切换

- **开关位置**：设置面板底部或工具栏右上角
- **持久化**：`localStorage['editor-engine']` = `'codemirror'` | `'tiptap'`
- **默认值**：`'codemirror'`（保守策略，Phase 1 不改变默认编辑器）
- **目标默认**：Phase 4 完成后改为 `'tiptap'`

### 6.2 代码约定

- `RichEditor.vue` 必须实现与 `Editor.vue` **完全相同**的 Props/Emits/Expose 接口
- 两个组件可以共享部分工具栏逻辑（可抽取为 composable）
- 样式保持与现有编辑器一致的视觉风格（主题色、圆角、间距）

### 6.3 测试要求

- 每个 Phase 结束时：在 CM6 和 TipTap 下各跑一遍核心流程
- Word 导出对比：同一份文档在两个编辑器下导出 → 对比差异
- AI 写作流水线：完整跑一遍 Interview → Outline → Generate → Review → Polish

---

## 7. 相关文档

| 文档 | 说明 |
|---|---|
| `docs/editor-spec.md` | 当前 CM6 编辑器技术规范（回滚参考） |
| `docs/editor-roadmap.md` | **本文档** |
| `https://tiptap.dev/docs/editor/getting-started/install/vue-3` | TipTap 官方 Vue 3 文档 |
| `https://prosemirror.net/docs/ref/` | ProseMirror API 文档 |
