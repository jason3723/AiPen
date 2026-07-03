# AiPen 全局文档搜索设计方案

> 状态：方案设计阶段 | 日期：2025-06-28 | 版本：v1.0

---

## 一、目标与范围

### 1.1 核心目标

在 AiPen 中实现全局文档搜索，支持在**文档草稿**和**历史版本**中检索关键词，并提供从搜索到引用的完整写作辅助闭环。

### 1.2 搜索对象

| 来源 | 数据表 | 搜索字段 | 说明 |
|------|--------|---------|------|
| 当前草稿 | `documents` | `title` + `draft_content` | 正在编辑但尚未提交版本的内容 |
| 历史版本 | `versions` | `content` | 每个已提交的快照 |

> **不涉及**：知识库（`knowledge_bases`）、写作技能（`skills`）、对话记录（`chat_messages`）等其他数据表。

### 1.3 设计原则

- **搜→采→甄→用**四步闭环，不做"即搜即用"
- 跨搜索词候选累积，换词搜索不丢素材
- 不挤占编辑器主空间，避免右侧栏进一步拥挤
- AI 角色是"综合分析素材"，不是"自动替人写作"

---

## 二、数据库设计

### 2.1 FTS5 全文索引表

#### 文档草稿 FTS 表

```sql
-- 创建 FTS5 虚拟表
CREATE VIRTUAL TABLE documents_fts USING fts5(
    doc_id       UNINDEXED,       -- 关联 documents.id，不参与搜索
    title,                        -- 文档标题，可搜索
    draft_content,                -- 当前草稿内容，可搜索
    tokenize = 'unicode61'        -- unicode61 分词器，中文按字符 bigram 索引
);

-- INSERT 触发器：新建文档时自动同步
CREATE TRIGGER documents_fts_ai AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(doc_id, title, draft_content)
    VALUES (new.id, new.title, new.draft_content);
END;

-- UPDATE 触发器：文档更新时自动同步
CREATE TRIGGER documents_fts_au AFTER UPDATE ON documents BEGIN
    UPDATE documents_fts
    SET title = new.title, draft_content = new.draft_content
    WHERE doc_id = new.id;
END;

-- DELETE 触发器：文档删除时自动同步
CREATE TRIGGER documents_fts_ad AFTER DELETE ON documents BEGIN
    DELETE FROM documents_fts WHERE doc_id = old.id;
END;
```

#### 历史版本 FTS 表

```sql
-- 创建 FTS5 虚拟表
CREATE VIRTUAL TABLE versions_fts USING fts5(
    version_id    UNINDEXED,       -- 关联 versions.id
    doc_id        UNINDEXED,       -- 关联 documents.id
    version_num   UNINDEXED,       -- 版本序号
    created_at    UNINDEXED,       -- 版本创建时间
    content,                       -- 版本正文，可搜索
    tokenize = 'unicode61'
);

-- INSERT 触发器：版本记录只追加不修改，仅需 INSERT + DELETE
CREATE TRIGGER versions_fts_ai AFTER INSERT ON versions BEGIN
    INSERT INTO versions_fts(version_id, doc_id, version_num, created_at, content)
    VALUES (new.id, new.doc_id, new.version_num, new.created_at, new.content);
END;

-- DELETE 触发器
CREATE TRIGGER versions_fts_ad AFTER DELETE ON versions BEGIN
    DELETE FROM versions_fts WHERE version_id = old.id;
END;
```

### 2.2 存量数据回填

建完 FTS 表后，需要一次性将已有数据灌入索引：

```sql
-- 回填现有文档草稿
INSERT INTO documents_fts(doc_id, title, draft_content)
SELECT id, title, draft_content FROM documents
WHERE draft_content != '';

-- 回填现有历史版本
INSERT INTO versions_fts(version_id, doc_id, version_num, created_at, content)
SELECT id, doc_id, version_num, created_at, content FROM versions;
```

### 2.3 候选素材持久化表（可选）

用于保存用户 Pin 的高频复用段落：

```sql
CREATE TABLE IF NOT EXISTS material_snippets (
    id         TEXT PRIMARY KEY,
    label      TEXT NOT NULL DEFAULT '',           -- 用户自定义标签
    content    TEXT NOT NULL,                      -- 素材内容
    source     TEXT,                               -- 来源标识："企业文化演讲稿 · v3"
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 三、核心搜索查询

### 3.1 联合搜索 SQL

```sql
-- 单次查询：同时搜索文档草稿和历史版本
SELECT * FROM (
    -- ========== 文档草稿匹配 ==========
    SELECT
        d.id                      AS doc_id,
        d.title                   AS doc_title,
        'draft'                   AS match_type,
        NULL                      AS version_id,
        NULL                      AS version_num,
        NULL                      AS version_created_at,
        snippet(documents_fts, 2, '<mark>', '</mark>', '...', 24) AS excerpt,
        rank
    FROM documents_fts
    JOIN documents d ON d.id = documents_fts.doc_id
    WHERE documents_fts MATCH $1
      AND d.draft_content != ''    -- 排除空草稿

    UNION ALL

    -- ========== 历史版本匹配 ==========
    SELECT
        v.doc_id                  AS doc_id,
        d.title                   AS doc_title,
        'version'                 AS match_type,
        v.id                      AS version_id,
        v.version_num             AS version_num,
        v.created_at              AS version_created_at,
        snippet(versions_fts, 4, '<mark>', '</mark>', '...', 24) AS excerpt,
        rank
    FROM versions_fts
    JOIN versions v ON v.id = versions_fts.version_id
    JOIN documents d ON d.id = v.doc_id
    WHERE versions_fts MATCH $1
)
ORDER BY rank
LIMIT 50;
```

**说明：**
- `snippet(table, column_index, left_tag, right_tag, ellipsis, token_count)` — FTS5 原生函数，返回关键词前后指定 token 数的上下文，自动包裹高亮标签
- `rank` — FTS5 的 BM25 相关性分数，值越小越相关
- `UNION ALL` — 合并两表结果，保持各表排名独立后全局排序

### 3.2 查询词安全处理（Rust 端）

```rust
/// 清洗用户输入，防止 FTS5 语法错误
/// FTS5 的 unicode61 分词器默认启用前缀匹配，加 * 实现模糊搜索
fn sanitize_query(raw: &str) -> String {
    // 过滤 FTS5 特殊字符
    let cleaned: String = raw
        .chars()
        .filter(|c| !matches!(c, '*' | '"' | '(' | ')' | '-' | '^' | ':'))
        .collect();

    // 每个词加前缀通配符，支持部分匹配
    let terms: Vec<String> = cleaned
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("{}*", t))
        .collect();

    terms.join(" ")
}

// 示例：
// 输入 "企业精神"  →  输出 "企业精神*"
// 输入 "创新 驱动" →  输出 "创新* 驱动*"
```

---

## 四、Rust 后端接口

### 4.1 数据结构

```rust
use serde::Serialize;
use sqlx::FromRow;

/// 数据库返回的原始搜索行
#[derive(FromRow)]
struct SearchRow {
    doc_id: String,
    doc_title: String,
    match_type: String,              // "draft" | "version"
    version_id: Option<String>,
    version_num: Option<i32>,
    version_created_at: Option<String>,
    excerpt: String,                 // 已包含 <mark> 标签
    rank: f64,
}

/// 单条搜索命中（前端渲染用）
#[derive(Serialize, Clone)]
struct SearchHit {
    match_type: String,
    version_id: Option<String>,
    version_num: Option<i32>,
    version_created_at: Option<String>,
    excerpt: String,                 // HTML 片段，已含 <mark>
    source_label: String,            // 展示标签："草稿" 或 "v3 · 2025-06-20"
}

/// 按文档分组后的搜索结果（前端渲染用）
#[derive(Serialize)]
struct GroupedSearchResult {
    doc_id: String,
    doc_title: String,
    total_matches: usize,
    hits: Vec<SearchHit>,
}
```

### 4.2 Tauri Command

```rust
#[tauri::command]
async fn search_global(
    state: tauri::State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<GroupedSearchResult>, String> {
    let sanitized = sanitize_query(&query);
    let limit = limit.unwrap_or(50);

    // 执行搜索
    let rows: Vec<SearchRow> = sqlx::query_as(SEARCH_SQL)
        .bind(&sanitized)
        .fetch_all(&state.db)
        .await
        .map_err(|e| e.to_string())?;

    // 转换为 SearchHit
    let hits: Vec<SearchHit> = rows.into_iter().map(|r| {
        let source_label = match r.match_type.as_str() {
            "draft" => "草稿".to_string(),
            _ => {
                let num = r.version_num.unwrap_or(0);
                let date = r.version_created_at.as_deref().unwrap_or("");
                format!("v{} · {}", num, date)
            }
        };
        SearchHit {
            match_type: r.match_type,
            version_id: r.version_id,
            version_num: r.version_num,
            version_created_at: r.version_created_at,
            excerpt: r.excerpt,
            source_label,
        }
    }).collect();

    // 按 doc_id 分组
    let grouped = group_by_document(hits, limit);
    Ok(grouped)
}
```

### 4.3 命令注册

在 `src-tauri/src/lib.rs` 中注册：

```rust
.manage(app_state)
.invoke_handler(tauri::generate_handler![
    // ... 现有命令 ...
    search_global,
])
```

---

## 五、前端 UI 架构

### 5.1 空间布局总览

```
┌──────────────────────────────────────────────────────────────┐
│  [≡] AiPen          📄 演讲稿.docx          [⚙] [?]        │  工具栏
├──────────────────────────────────────────────────────────────┤
│  🔍 [________________] 搜索                                    │  ← 搜索条
│  在 N 篇文档的草稿和历史版本中搜索              × [Esc]        │     (Ctrl+Shift+F 呼出)
├──────────────────────────────────────────────────────────────┤
│  📄 企业文化演讲稿                              命中 3 处      │  ← 结果面板
│     草稿：弘扬<mark>企业精神</mark>为核心... [📋][📥]         │     (搜索条下方)
│     v3：  将<mark>企业精神</mark>融入日常... [📋][📥]         │     覆盖编辑器上部 ~30%
│  📄 年度工作总结                                命中 1 处      │
│     草稿：贯彻落实<mark>企业精神</mark>要求... [📋][📥]        │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   尊敬的各位领导、亲爱的同事们：                                │
│                                                              │
│   今天我要分享的主题是关于企业精神……                           │  ← 编辑器
│   ██                                                          │     (结果面板下方)
│                                                              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
                                          ┌──────────────────────┐
                                          │ 📥 候选库 (3)   [清空]│  ← 候选库
                                          │──────────────────────│    (右下角浮动)
                                          │ 1. 弘扬企业精神为... │
                                          │    企业文化演讲稿 · 草稿│
                                          │ 2. 将企业精神融入... │
                                          │    企业文化演讲稿 · v3 │
                                          │ 3. 贯彻落实企业精神..│
                                          │    年度工作总结 · 草稿  │
                                          │                      │
                                          │ [🧠 AI综合分析]      │
                                          │ [📋 全部复制]        │
                                          │ [📂 保存为素材]       │
                                          └──────────────────────┘
```

### 5.2 三大空间职责

| 空间 | 位置 | 展开方式 | 职责 |
|------|------|---------|------|
| **搜索条** | 顶部工具栏下方 | `Ctrl+Shift+F` 滑入 | 输入关键词，展示命中数量 |
| **结果面板** | 搜索条下方 | 搜索后自动展开 | 展示匹配列表，支持扫读、复制、采集 |
| **候选库** | 右下角浮动 | 始终可见 | 暂存选中的素材，AI 分析的输入源 |

**设计要点**：
- 搜索时编辑器仅被遮盖上方约 30%，仍可滚动和编辑
- 候选库为浮动面板，不改变文档区布局
- 三者互不阻塞：搜索时编辑器可用，候选库跨搜索词保留

### 5.3 候选库组件设计

#### 收起态（右下角悬浮图标）

```
    ┌──┐
    │📥│ 3      ← 有内容时显示计数角标，为空时隐藏
    └──┘
```

#### 展开态（右下角面板）

```
┌──────────────────────────────────────┐
│ 📥 候选库 (3)            [清空][─]  │
├──────────────────────────────────────┤
│                                      │
│ ① 弘扬企业精神为核心，坚持创新驱动    │
│    发展战略，在过去一年中……    [×]    │
│    企业文化演讲稿 · 草稿              │
│    ▸ 展开上下文                      │  ← 点击展开显示原文前后 5 行
│                                      │
│ ② 将企业精神融入日常管理之中，        │
│    形成了独具特色的……          [×]    │
│    企业文化演讲稿 · v3                │
│    ▸ 展开上下文                      │
│                                      │
│ ③ 贯彻落实企业精神要求，全面完成      │
│    各项经营指标……              [×]    │
│    年度工作总结 · 草稿                │
│    ▸ 展开上下文                      │
│                                      │
│ ── 拖拽排序 ──                       │
│                                      │
│ [🧠 AI综合分析]  [📋 全部复制]        │
│ [📂 保存为固定素材]                   │
└──────────────────────────────────────┘
```

#### 交互能力

| 操作 | 行为 |
|------|------|
| 点击 "▸ 展开上下文" | 显示该条素材原文前后各 5 行 |
| 点击 [×] | 从候选库移除该项，原文不受影响 |
| 拖拽排序 | 在候选库内拖动调整素材优先顺序 |
| 点击 [清空] | 二次确认后清空所有候选 |
| 点击 [📋 全部复制] | 将全部素材格式化拼接后写入剪贴板 |
| 点击 [📂 保存为素材] | 持久化到 `material_snippets` 表 |
| 点击 [─] | 收起为悬浮图标 📥(N) |

---

## 六、核心操作流程

### 6.1 搜索 & 采集

```
用户按 Ctrl+Shift+F
  ↓
搜索条从顶部滑入，自动聚焦输入框
  ↓
输入 "企业精神"，300ms 防抖后发起搜索
  ↓
结果面板出现匹配列表（按文档分组，相关性排序）
  ↓
用户扫读，对有价值的条目：
  · 点击 [📋] → 直接复制到剪贴板
  · 点击 [📥] → 加入候选库
  · 右键菜单 → "加入候选库"
  ↓
右下角浮动图标显示 📥(3)
```

### 6.2 换词继续搜（跨搜索累积）

```
用户清空搜索框 → 输入 "创新驱动"
  ↓
新搜索结果覆盖结果面板
  ↓
又采集了 2 条素材
  ↓
候选库自动累积：📥(5)  ← 跨搜索词不丢失
```

### 6.3 AI 综合分析

```
候选库攒够了素材 → 点击 [🧠 AI综合分析]
  ↓
弹出分析模式选择框
```

#### 分析模式选择

```
┌───────────────────────────────────────────┐
│  🧠 AI 综合分析                            │
│                                           │
│  你希望 AI 如何分析这 5 条候选素材？         │
│                                           │
│  ○ 📊 对比评估                             │
│    "逐一评价每条素材的优点和不足，           │
│     哪个最适合当前写作场景"                  │
│                                           │
│  ○ 🔀 精华融合                             │
│    "从多条素材中提取各自亮点，               │
│     融合成一个统一的新版本"                  │
│                                           │
│  ○ 🎨 风格匹配                             │
│    "对比当前草稿风格，推荐最匹配             │
│     的素材及其理由"                         │
│                                           │
│  ○ ✏️ 自定义                               │
│    [____________________________________]  │
│                                           │
│              [取消]   [开始分析]             │
└───────────────────────────────────────────┘
```

#### 分析结果展示

```
┌───────────────────────────────────────────┐
│ 🧠 分析完成                                │
│───────────────────────────────────────────│
│ 【逐条评价】                               │
│                                           │
│ ① "弘扬企业精神为核心，坚持创新驱动……"      │
│    来源：企业文化演讲稿 · 草稿               │
│    ✓ 优点：正式庄重，适合演讲开头            │
│    ✗ 不足：略空泛，缺少具体做法              │
│    → 建议用于：开场引入                     │
│                                           │
│ ② "将企业精神融入日常管理之中，形成了……"     │
│    来源：企业文化演讲稿 · v3                 │
│    ✓ 有落地感，具体可感知                    │
│    ✗ 偏管理报告口吻，情感张力不足            │
│    → 建议用于：主体论述段落                  │
│                                           │
│ ③ "贯彻落实企业精神要求，全面完成……"         │
│    来源：年度工作总结 · 草稿                 │
│    ✓ 政策性强，引用准确                     │
│    ✗ 公文腔太重，不适合口语演讲              │
│    → 建议用于：背景铺垫或数据引用            │
│                                           │
│ ──────────────────────────────────        │
│                                           │
│ 【融合建议】                               │
│                                           │
│ 建议以①为骨架，融入②的落地细节：            │
│                                           │
│ 弘扬企业精神为核心，将其融入日常管理之中。    │
│ 过去一年，我们在制度建设、团队培养等方面，     │
│ 始终坚持这一导向，形成了独具特色的发展模式。   │
│                                           │
│ [📋 复制融合版]  [📋 复制每条]  [💬 追问]   │
└───────────────────────────────────────────┘
```

#### AI 分析 Prompt 核心思路

AI 分析的 system prompt 需要包含：

1. **当前写作上下文**：正在编辑的文档标题、当前光标附近的内容（作为风格参考）
2. **候选素材列表**：已加入候选库的全部素材原文及来源
3. **分析指令**：根据用户选择的模式（对比/融合/匹配）执行对应分析
4. **输出格式**：结构化输出（逐条评价 + 融合建议）

---

## 七、编辑器内高亮

当用户从搜索结果中点击某条并希望查看完整上下文时，需要在该文档/版本的编辑器中高亮所有匹配位置。

### 7.1 CodeMirror SearchCursor 实现

```typescript
import { SearchCursor } from '@codemirror/search'
import {
    Decoration,
    DecorationSet,
    ViewPlugin,
    ViewUpdate,
    EditorView,
} from '@codemirror/view'
import { StateEffect, StateField } from '@codemirror/state'

// 高亮标记的 Decoration
const highlightMark = Decoration.mark({ class: 'search-highlight' })
const activeMark = Decoration.mark({ class: 'search-highlight-active' })

// StateEffect：设置高亮匹配位置
const setHighlights = StateEffect.define<{ ranges: { from: number; to: number }[] }>()

// StateField：存储当前高亮状态
const highlightField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none
    },
    update(decorations, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setHighlights)) {
                const marks = effect.value.ranges.map((r) =>
                    highlightMark.range(r.from, r.to)
                )
                return Decoration.set(marks)
            }
        }
        return decorations
    },
    provide: (field) => EditorView.decorations.from(field),
})

/**
 * 在编辑器中搜索并高亮所有匹配位置
 * @param view   CodeMirror EditorView 实例
 * @param query  搜索关键词
 * @returns      匹配到的位置数组
 */
function highlightMatches(view: EditorView, query: string): { from: number; to: number }[] {
    const ranges: { from: number; to: number }[] = []
    const cursor = new SearchCursor(view.state.doc, query)

    while (!cursor.next().done) {
        ranges.push({
            from: cursor.value.from,
            to: cursor.value.to,
        })
    }

    // 注入高亮 decoration
    view.dispatch({
        effects: setHighlights.of({ ranges }),
    })

    // 如果有匹配，滚动到第一个匹配位置
    if (ranges.length > 0) {
        view.dispatch({
            selection: { anchor: ranges[0].from, head: ranges[0].to },
            scrollIntoView: true,
        })
    }

    return ranges
}

// 在匹配结果之间跳转
let currentMatchIndex = 0

function goToNextMatch(view: EditorView, matches: { from: number; to: number }[]) {
    if (matches.length === 0) return
    currentMatchIndex = (currentMatchIndex + 1) % matches.length
    const m = matches[currentMatchIndex]
    view.dispatch({
        selection: { anchor: m.from, head: m.to },
        scrollIntoView: true,
    })
}
```

### 7.2 高亮样式

```css
.search-highlight {
    background-color: #fef08a;   /* 暖黄色背景 */
    border-radius: 2px;
    border-bottom: 2px solid #f59e0b;  /* 橙色底线，突出但不刺眼 */
}

.search-highlight-active {
    background-color: #fcd34d;
    border-bottom: 2px solid #ea580c;
    outline: 1px solid #ea580c;
}
```

---

## 八、交互细节汇总

### 8.1 快捷键

| 快捷键 | 作用 |
|--------|------|
| `Ctrl+Shift+F` | 呼出 / 隐藏搜索 |
| `↑` `↓` | 结果列表中移动焦点 |
| `Enter` | 展开当前焦点结果的上下文预览 |
| `Ctrl+Enter` | 将焦点结果加入候选库（或直接复制） |
| `Esc` | 关闭搜索条 |
| `Ctrl+Shift+B` | 展开 / 收起候选库面板 |

### 8.2 右键菜单

在搜索结果条目上右键：

```
┌─────────────────────┐
│ 📥 加入候选库        │
│ 📋 复制             │
│ 📄 查看完整原文      │
│ 📂 保存为固定素材    │
└─────────────────────┘
```

### 8.3 复制策略

| 来源 | 行为 |
|------|------|
| 结果面板 snippet | 只复制那段 snippet 原始文本（不含 `<mark>` 标签） |
| "全部复制" | 所有候选素材格式化拼接，每条前标注序号和来源 |
| 展开上下文 | 可选中上下文内的任意文本，Ctrl+C |
| 完整预览 | 同普通编辑器的选择复制行为 |

### 8.4 格式化拼接示例（全部复制）

```
══════════════════════════════════
📋 来自搜索 "企业精神" 的 5 条素材
══════════════════════════════════

【1】企业文化演讲稿 · 草稿
弘扬企业精神为核心，坚持创新驱动发展战略，在过去一年中取得了显著成效。

【2】企业文化演讲稿 · v3 (2025-06-20)
将企业精神融入日常管理之中，形成了独具特色的企业文化和团队氛围。

【3】年度工作总结 · 草稿
贯彻落实企业精神要求，全面完成各项经营指标，实现了高质量发展。

══════════════════════════════════
```

---

## 九、实现路线

### Phase 1：数据库层（~1h）

- [ ] 创建 `documents_fts` 和 `versions_fts` FTS5 虚拟表
- [ ] 创建对应的 INSERT/UPDATE/DELETE 触发器
- [ ] 存量数据全量回填
- [ ] 数据库迁移脚本（通过 `db.rs` 中的 `init_db` 扩展）

### Phase 2：后端接口（~2h）

- [ ] 实现 `sanitize_query()` 查询词清洗函数
- [ ] 实现 `search_global` Tauri Command
- [ ] 定义 `SearchHit` / `GroupedSearchResult` 数据结构
- [ ] 在 `lib.rs` 中注册命令
- [ ] 端到端测试（前端 invoke 调用）

### Phase 3：搜索 UI（~3h）

- [ ] 新建 `SearchBar.vue` 组件（顶部搜索条）
- [ ] 新建 `SearchResults.vue` 组件（结果面板）
- [ ] 新建 `CandidateDrawer.vue` 组件（候选库浮动面板）
- [ ] 集成到 `EditorView.vue` 中
- [ ] 搜索条的滑入/滑出动画
- [ ] 300ms 防抖搜索

### Phase 4：候选库交互（~2h）

- [ ] Pinia store：`searchStore`（管理搜索结果、候选库状态、搜索历史）
- [ ] 候选库的添加/移除/清空/排序
- [ ] "全部复制"格式化拼接逻辑
- [ ] "保存为固定素材"（写入 `material_snippets` 表 + 相应 Tauri command）
- [ ] 右键菜单集成

### Phase 5：编辑器高亮（~2h）

- [ ] CodeMirror `SearchCursor` + `StateField` + `Decoration` 高亮
- [ ] 匹配位置跳转（上一个/下一个）
- [ ] 高亮样式

### Phase 6：AI 综合分析（~2h）

- [ ] AI 分析模式选择弹窗组件
- [ ] 三种预设分析 prompt 模板（对比/融合/匹配）+ 自定义
- [ ] 流式展示 AI 分析结果
- [ ] 结果中的复制操作

### Phase 7：体验优化（~1h）

- [ ] 快捷键注册
- [ ] 搜索历史记录
- [ ] 空状态、无结果、错误状态的 UI 处理
- [ ] 性能优化（大量结果时的虚拟滚动）

**总计预估：~13 小时**

---

## 十、技术注意事项

### 10.1 FTS5 与 sqlx 兼容性

FTS5 是 SQLite 标准扩展，`sqlx` 完全兼容。`snippet()` 等 FTS 特有函数可在 raw SQL 中正常使用。

### 10.2 中文搜索精度

`unicode61` 分词器将中文文本按字符 bigram 索引。这意味着：

- 搜索 "企业" → 匹配 "企业"、"企业家"、"国有企业" ✅
- 搜索 "企业精神" → 匹配 "企业精神"、"企业精神的" ✅
- 这种模糊匹配对中文写作辅助场景是合理且有益的

如果需要精确分词（如"企业精神"作为不可拆分的整体），需要引入 jieba 分词 + 自定义 tokenizer，但当前场景下 unicode61 足够。

### 10.3 性能预估

- FTS5 搜索在数千篇文档规模下仍在毫秒级
- 触发器同步开销极小（仅在 INSERT/UPDATE/DELETE 时触发）
- 前端防抖（300ms）避免高频请求

### 10.4 数据一致性

- FTS 表通过触发器自动与主表同步，无需手动维护
- 如果触发器遗漏（如直接 SQL 操作），需要提供重建索引的工具
- 可在应用启动时校验 FTS 表完整性（可选）

---

## 十一、文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `src-tauri/src/db.rs` | 修改 | 添加 FTS 表创建 + 触发器 + 存量回填 + `material_snippets` 表 |
| `src-tauri/src/commands.rs` | 修改 | 添加 `search_global` 命令 + `save_material_snippet` 命令 |
| `src-tauri/src/lib.rs` | 修改 | 注册新命令 |
| `src/components/SearchBar.vue` | 新建 | 顶部搜索条组件 |
| `src/components/SearchResults.vue` | 新建 | 搜索结果面板组件 |
| `src/components/CandidateDrawer.vue` | 新建 | 候选库浮动面板组件 |
| `src/components/AIAnalysisModal.vue` | 新建 | AI 综合分析模式选择 + 结果展示 |
| `src/stores/search.ts` | 新建 | 搜索状态管理 Pinia Store |
| `src/views/EditorView.vue` | 修改 | 集成搜索条 + 候选库 + 编辑器高亮 |
| `src/components/Editor.vue` | 修改 | 添加 `highlightMatches` 功能 |

---

## 十二、附录：候选库状态管理示意

```typescript
// src/stores/search.ts

interface CandidateItem {
    id: string
    content: string           // 原始文本
    excerpt: string           // 带 <mark> 的 snippet
    docId: string
    docTitle: string
    sourceLabel: string       // "草稿" 或 "v3 · 2025-06-20"
    versionId?: string
    versionNum?: number
}

export const useSearchStore = defineStore('search', () => {
    // 搜索状态
    const query = ref('')
    const results = ref<GroupedSearchResult[]>([])
    const totalHits = ref(0)
    const isSearching = ref(false)
    const isSearchPanelVisible = ref(false)

    // 候选库状态
    const candidates = ref<CandidateItem[]>([])
    const isDrawerExpanded = ref(false)

    // 搜索历史
    const history = ref<string[]>([])

    const candidateCount = computed(() => candidates.value.length)

    // 操作
    function addCandidate(item: CandidateItem) { ... }
    function removeCandidate(id: string) { ... }
    function clearCandidates() { ... }
    function reorderCandidates(fromIndex: number, toIndex: number) { ... }
    function copyAllCandidates() { ... }
    async function search(queryStr: string) { ... }
    function toggleSearchPanel() { ... }
    function toggleDrawer() { ... }

    return {
        query, results, totalHits, isSearching, isSearchPanelVisible,
        candidates, isDrawerExpanded, candidateCount, history,
        addCandidate, removeCandidate, clearCandidates,
        reorderCandidates, copyAllCandidates,
        search, toggleSearchPanel, toggleDrawer,
    }
})
```

---

> 文档版本：v1.0 | 最后更新：2025-06-28
