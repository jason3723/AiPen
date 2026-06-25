# AiPen 架构重建设计规范

> 基于 CLAUDE.md 需求文档，完全重写为 Vue 3 + Milkdown + SQLite 技术栈

## 1. 概述

### 1.1 项目定位

AiPen 是一款基于 Tauri 的桌面端文档编辑与管理应用，核心功能：
- **文档编辑**：基于 Milkdown 的所见即所得 Markdown 编辑器
- **版本控制**：类似 Git 的 Commit 机制，每次提交保存完整内容快照
- **版本比对**：任意两个版本之间的行级 Diff 展示
- **AI 分析**：将旧版/新版/Diff 发送给 LLM，分析修改的优缺点并提供建议

### 1.2 技术栈

| 层级       | 技术                                                              |
| ---------- | ----------------------------------------------------------------- |
| 桌面框架   | Tauri 2.x                                                         |
| 前端框架   | Vue 3.5 + TypeScript                                              |
| 编辑器     | Milkdown 7.x (基于 ProseMirror)                                   |
| 样式       | TailwindCSS 4                                                     |
| 状态管理   | Pinia 3 (setup 语法)                                              |
| 后端语言   | Rust (edition 2021)                                               |
| 数据库     | SQLite via sqlx 0.8                                               |
| Diff 引擎  | similar 2.6                                                       |
| HTTP 客户端 | reqwest 0.12                                                     |
| 错误处理   | thiserror 2 + 自定义错误类型                                      |
| AI 提供商  | Claude / OpenAI / DeepSeek / 自定义（由前端配置）                 |

## 2. 总体架构

### 2.1 分层架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                       前端 (Vue 3 + Vite)                         │
│  ┌──────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐    │
│  │  Editor  │  │ DiffViewer │  │VersionList │  │ AIPanel   │    │
│  │(Milkdown)│  │  Diff展示   │  │ 版本历史    │  │ AI分析结果 │    │
│  └────┬─────┘  └─────┬──────┘  └─────┬──────┘  └─────┬─────┘    │
│       └──────────────┴───────────────┴───────────────┘           │
│                             │ Pinia Store                         │
│                      document.ts (集中状态)                       │
│                             │                                     │
│                    @tauri-apps/api/core.invoke()                  │
├────────────────────────────┼─────────────────────────────────────┤
│                      Tauri IPC Bridge                             │
├────────────────────────────┼─────────────────────────────────────┤
│                      后端 (Rust)                                  │
│  ┌────────────────────────┴──────────────────────────────────┐   │
│  │                     commands.rs                            │   │
│  │  编排层：接收前端调用，协调各模块，返回结果                   │   │
│  └───┬────────┬───────────┬───────────┬──────────────────────┘   │
│      │        │           │           │                          │
│  ┌───┴──┐ ┌──┴────┐ ┌───┴────┐ ┌───┴────────┐                  │
│  │db.rs │ │version│ │diff.rs │ │  ai.rs      │                  │
│  │SQLite│ │ .rs   │ │similar │ │  reqwest    │                  │
│  │ CRUD │ │ 逻辑   │ │ 算法    │ │  多提供商    │                  │
│  └──────┘ └───────┘ └────────┘ └────────────┘                  │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 核心数据流

```
编辑文档 → Commit(快照) → 选两个版本 → Diff比对 → AI分析
   ↑                                                        │
   └────────────────── 查看结果 ────────────────────────────┘
```

### 2.3 关键设计决策

1. **Milkdown 作为 WYSIWYG 编辑器**，输出 Markdown 源码存储到 SQLite
2. **SQLite 存储所有数据**：文档元数据、版本内容快照、AI 分析结果、应用配置
3. **`similar` crate** 做纯 Rust 端 Diff 计算，不依赖 Git CLI
4. **AI 多提供商支持**：Claude / OpenAI / DeepSeek / 自定义，由前端设置并持久化
5. **Pinia 作为唯一状态管理层**，组件只通过 Store 读写数据
6. **thiserror** 统一错误处理，前端按错误类型展示不同 UI

## 3. Rust 后端设计

### 3.1 模块结构

```
src-tauri/src/
├── main.rs           # Tauri 入口，调用 aipen_lib::run()
├── lib.rs            # 模块声明 + AppState + Tauri Builder + 命令注册
├── db.rs             # SQLite 初始化和所有 CRUD 操作
├── commands.rs       # Tauri 命令函数
├── version.rs        # 版本管理逻辑（版本号计算、parent 链）
├── diff.rs           # 文本差异比较（基于 similar crate）
└── ai.rs             # AI API 调用（多提供商支持）
```

### 3.2 AppState

```rust
pub struct AppState {
    pub db: sqlx::SqlitePool,          // SQLite 连接池，全局共享
    pub ai_config: Mutex<AIConfig>,    // AI 配置，由前端设置并持久化
}
```

- `db` — 使用 sqlx 连接池管理 SQLite 连接
- `ai_config` — Mutex 包裹，支持运行时由前端修改

### 3.3 db.rs — 数据持久化

#### 核心接口

```rust
// 初始化
pub async fn init_db(db_path: &str) -> Result<sqlx::SqlitePool, DbError>

// 文档 CRUD
pub async fn create_document(pool: &Pool, title: &str, project_id: &str) -> Result<Document, DbError>
pub async fn get_document(pool: &Pool, doc_id: &str) -> Result<Document, DbError>
pub async fn list_documents(pool: &Pool) -> Result<Vec<Document>, DbError>
pub async fn update_document_title(pool: &Pool, doc_id: &str, title: &str) -> Result<(), DbError>

// 版本 CRUD
pub async fn create_version(pool: &Pool, doc_id: &str, content: &str, commit_msg: &str) -> Result<Version, DbError>
pub async fn get_version(pool: &Pool, version_id: &str) -> Result<Version, DbError>
pub async fn get_version_content(pool: &Pool, version_id: &str) -> Result<String, DbError>
pub async fn get_versions_by_doc(pool: &Pool, doc_id: &str) -> Result<Vec<Version>, DbError>
pub async fn get_latest_version(pool: &Pool, doc_id: &str) -> Result<Option<Version>, DbError>

// AI 分析 CRUD
pub async fn save_analysis(pool: &Pool, version_id: &str, old_version_id: &str, analysis: &str) -> Result<(), DbError>
pub async fn get_analysis(pool: &Pool, version_id: &str) -> Result<Option<AIAnalysis>, DbError>

// 应用配置
pub async fn get_config(pool: &Pool, key: &str) -> Result<Option<String>, DbError>
pub async fn set_config(pool: &Pool, key: &str, value: &str) -> Result<(), DbError>
pub async fn get_all_configs(pool: &Pool) -> Result<Vec<(String, String)>, DbError>
```

#### 错误类型

```rust
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("数据库错误: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("记录未找到: {0}")]
    NotFound(String),
}
```

### 3.4 version.rs — 版本管理

```rust
/// 创建新版本
/// - 自动计算 version_num（当前最大 + 1）
/// - 自动设置 parent_id（上一个版本的 ID）
pub async fn create_new_version(
    pool: &Pool,
    doc_id: &str,
    content: &str,
    commit_msg: &str,
) -> Result<Version, VersionError>;

/// 获取版本时间线
/// - 按 created_at 排序
pub async fn get_version_tree(
    pool: &Pool,
    doc_id: &str,
) -> Result<Vec<Version>, VersionError>;
```

版本模型：
```rust
pub struct Version {
    pub id: String,          // UUID
    pub doc_id: String,
    pub version_num: i64,    // 从 1 递增
    pub commit_msg: String,
    pub content: String,     // 完整 Markdown 快照
    pub parent_id: Option<String>,
    pub created_at: String,  // ISO 8601
}
```

### 3.5 diff.rs — 文本差异分析

使用 `similar` crate 的 `TextDiff::from_lines()` 进行行级比较：

```rust
use similar::{ChangeTag, TextDiff};

#[derive(Serialize, Clone)]
pub struct DiffHunk {
    tag: String,       // "equal" | "insert" | "delete"
    content: String,
}

#[derive(Serialize)]
pub struct DiffResult {
    hunks: Vec<DiffHunk>,
    additions: usize,
    deletions: usize,
    change_ratio: f64,      // 变更比例，用于前端展示
}

pub fn diff_documents(old: &str, new: &str) -> DiffResult;
```

### 3.6 ai.rs — AI 分析引擎

#### 多提供商架构

```rust
/// AI 提供商枚举
pub enum AIProvider {
    Claude,
    OpenAI,
    DeepSeek,
    Custom(String),
}

/// AI 配置（由前端传入并持久化到 app_config 表）
pub struct AIConfig {
    pub provider: AIProvider,
    pub api_key: String,
    pub api_url: String,
    pub model: String,
}

/// 核心分析函数
pub async fn analyze_revision(
    old_content: &str,
    new_content: &str,
    diff: &DiffResult,
    config: &AIConfig,
) -> Result<AIAnalysis, AIError>;

/// 测试 API 连接
pub async fn test_connection(config: &AIConfig) -> Result<String, AIError>;
```

#### 输出结构

```rust
pub struct AIAnalysis {
    pub highlights: Vec<String>,    // 修改优点
    pub issues: Vec<String>,        // 存在的问题
    pub suggestions: Vec<String>,   // 改进建议
}
```

#### 错误类型

```rust
#[derive(Debug, thiserror::Error)]
pub enum AIError {
    #[error("API 请求失败: {0}")]
    RequestFailed(String),
    #[error("API 返回错误 ({status}): {message}")]
    ApiError { status: u16, message: String },
    #[error("解析响应失败: {0}")]
    ParseFailed(String),
    #[error("API 密钥未配置")]
    NotConfigured,
}
```

#### Prompt 策略

- Prompt 模板独立为字符串常量，便于测试和修改
- 使用 `response_format: { "type": "json_object" }` 确保结构化输出
- 适配 Claude 的 Messages API 和 OpenAI/DeepSeek 的 Chat Completions API
- DeepSeek 额外启用 think 标签 (reasoning_effort: high)

#### 重试策略

```
call_ai_api()
  ├── 成功 → 解析 JSON 返回 AIAnalysis
  ├── 网络错误 → 自动重试 1 次（间隔 2s）
  ├── 401/403 → 立即返回 "API 密钥无效"
  ├── 429 → 等待 3s 后重试 1 次
  └── JSON 解析失败 → 尝试从 ```json 代码块提取
```

### 3.7 commands.rs — Tauri 命令

```
┌───────────────────────────────────────────────────────────────┐
│                       commands.rs                              │
│                                                               │
│  文档相关:                                                     │
│  - create_document(title) → Document                          │
│  - get_document(doc_id) → Document                            │
│  - list_documents() → Vec<Document>                           │
│  - save_document(doc_id, content) → ()                        │
│                                                               │
│  版本相关:                                                     │
│  - commit_version(doc_id, content, commit_msg) → Version      │
│  - get_versions(doc_id) → Vec<Version>                        │
│  - get_version(version_id) → Version                          │
│                                                               │
│  Diff 相关:                                                    │
│  - get_diff(old_version_id, new_version_id) → DiffResult      │
│                                                               │
│  AI 分析相关:                                                  │
│  - analyze_revision(old_version_id, new_version_id) → AIAnalysis│
│  - test_api_connection() → String                             │
│                                                               │
│  配置相关:                                                     │
│  - get_api_config() → AIConfig                                │
│  - set_api_config(api_key, api_url, model) → ()               │
└───────────────────────────────────────────────────────────────┘
```

### 3.8 Cargo.toml 依赖

```toml
[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sqlx = { version = "0.8", features = ["sqlite", "runtime-tokio", "chrono"] }
similar = "2.6"
reqwest = { version = "0.12", features = ["json"] }
tokio = { version = "1", features = ["full"] }
uuid = { version = "1", features = ["v4"] }
chrono = { version = "0.4", features = ["serde"] }
thiserror = "2"
```

## 4. 数据库设计

### 4.1 建表 SQL

```sql
-- 文档表
CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    project_id  TEXT NOT NULL DEFAULT 'default',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_documents_project ON documents(project_id);

-- 版本快照表
CREATE TABLE IF NOT EXISTS versions (
    id          TEXT PRIMARY KEY,
    doc_id      TEXT NOT NULL,
    version_num INTEGER NOT NULL,
    commit_msg  TEXT NOT NULL DEFAULT '',
    content     TEXT NOT NULL,
    parent_id   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES versions(id)
);

CREATE INDEX idx_versions_doc ON versions(doc_id);
CREATE UNIQUE INDEX idx_versions_doc_num ON versions(doc_id, version_num);

-- AI 分析结果表
CREATE TABLE IF NOT EXISTS ai_analysis (
    id              TEXT PRIMARY KEY,
    version_id      TEXT NOT NULL,
    old_version_id  TEXT,
    analysis        TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE
);

CREATE INDEX idx_ai_analysis_version ON ai_analysis(version_id);

-- 应用配置表
CREATE TABLE IF NOT EXISTS app_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO app_config (key, value) VALUES
    ('ai_provider', '"openai"'),
    ('ai_model', '"gpt-4o"'),
    ('ai_api_url', '"https://api.openai.com/v1/chat/completions"');
```

### 4.2 表关系

```
documents  1────N  versions  1────0..1  ai_analysis
                │
                └──── parent_id (自引用)
```

### 4.3 与 CLAUDE.md 设计的差异

| CLAUDE.md | 本设计 | 原因 |
|-----------|--------|------|
| 3 张表 | 4 张表 | 增加 `app_config` 持久化 AI 设置 |
| 无索引 | 4 个索引 + 1 个唯一索引 | 查询效率保障 |
| 无 CASCADE | ON DELETE CASCADE | 数据完整性 |
| ai_analysis 无 old_version_id | 增加 | 方便追溯对比版本 |
| 日期无索引 | 索引 | 版本列表按时间排序 |

## 5. Vue 3 前端设计

### 5.1 组件树

```
App.vue
└── EditorView.vue (主页面，左右分栏布局)
    │
    ├── 左侧：编辑区
    │   ├── 工具栏
    │   │   ├── 文档标题
    │   │   ├── Commit 按钮 + 输入框
    │   │   └── 版本号指示器
    │   └── Editor.vue (Milkdown 编辑器)
    │       ├── WYSIWYG 编辑区
    │       └── 状态栏（字数、保存状态）
    │
    └── 右侧：面板区 (Tab 切换)
        ├── VersionList.vue (版本历史)
        │   ├── 时间线列表
        │   ├── 选择对比版本（单选 + 复选框）
        │   └── 版本详情（时间、消息、哈希）
        │
        ├── DiffViewer.vue (Diff 比对)
        │   ├── 统计栏（+N / -M）
        │   ├── 差异列表（绿底新增 / 红底删除）
        │   └── 空状态提示
        │
        └── AIPanel.vue (AI 分析)
            ├── 加载态（骨架屏）
            ├── 优点列表（绿色）
            ├── 问题列表（红色）
            ├── 建议列表（蓝色）
            └── 空状态 / 错误状态
```

### 5.2 路由设计

单页面应用，无路由。所有切换通过 Tab 控制（而非 vue-router）。

如需多文档支持，后续可加：
```
/                    → 默认编辑器页
/documents           → 文档列表
/documents/:id       → 编辑指定文档
```

### 5.3 Pinia Store (document.ts)

```typescript
// 状态
export const useDocumentStore = defineStore('document', () => {
  // ── 文档状态 ──
  const currentDocId = ref('')
  const currentTitle = ref('新文档')
  const currentContent = ref('')

  // ── 版本状态 ──
  const versions = ref<Version[]>([])
  const selectedOldVersion = ref<Version | null>(null)
  const selectedNewVersion = ref<Version | null>(null)

  // ── Diff 状态 ──
  const diffResult = ref<DiffResult | null>(null)

  // ── AI 分析状态 ──
  const analysisResult = ref<AIAnalysis | null>(null)

  // ── UI 状态 ──
  const loading = ref({
    init: false,
    commit: false,
    versions: false,
    diff: false,
    analysis: false,
  })
  const error = ref<string | null>(null)

  // ── 操作 ──
  async function initDocument(docId?: string) { ... }
  async function commitVersion(commitMsg: string) { ... }
  async function loadVersions() { ... }
  async function compareVersions(oldId: string, newId: string) { ... }
  async function analyzeRevision() { ... }

  return {
    currentDocId, currentTitle, currentContent,
    versions, selectedOldVersion, selectedNewVersion,
    diffResult, analysisResult,
    loading, error,
    initDocument, commitVersion, loadVersions,
    compareVersions, analyzeRevision,
  }
})
```

### 5.4 UI 状态规范

每个组件统一处理以下状态：

| 状态   | 展示方式                     | 触发条件               |
| ------ | ---------------------------- | ---------------------- |
| 初始态 | 引导提示 / 空状态插画        | 无数据、首次加载       |
| 加载中 | 骨架屏 / Spinner + 文字提示   | loading 对应字段为 true |
| 成功   | 正常数据渲染                 | 数据返回成功           |
| 空数据 | "暂无记录" + 操作引导         | 数据数组为空            |
| 错误   | 错误消息 + 重试按钮           | error 有值             |

### 5.5 Milkdown 编辑器封装

```vue
<script setup lang="ts">
import { Milkdown, useEditor } from '@milkdown/vue'
import { Editor, rootCtx, defaultValueCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { listener, listenerCtx } from '@milkdown/plugin-listener'

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits(['update:modelValue'])

useEditor((root) =>
  Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root)
      ctx.set(defaultValueCtx, props.modelValue)
      ctx.get(listenerCtx).markdownUpdated((_, markdown) => {
        emit('update:modelValue', markdown)
      })
    })
    .use(commonmark)
    .use(listener)
)
</script>

<template>
  <Milkdown />
</template>
```

### 5.6 前端依赖

```json
{
  "dependencies": {
    "vue": "^3.5",
    "@milkdown/vue": "^7.6",
    "@milkdown/core": "^7.6",
    "@milkdown/preset-commonmark": "^7.6",
    "@milkdown/plugin-listener": "^7.6",
    "@tauri-apps/api": "^2",
    "pinia": "^3.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2",
    "typescript": "~5.8",
    "vite": "^6",
    "@vitejs/plugin-vue": "^5",
    "tailwindcss": "^4",
    "autoprefixer": "^10"
  }
}
```

### 5.7 与当前实现的关键差异

| 当前 (React) | 新设计 (Vue 3) | 原因 |
|-------------|----------------|------|
| React 19 + CodeMirror | Vue 3 + Milkdown | 遵循 CLAUDE.md，WYSIWYG 体验更好 |
| 无状态管理 | Pinia | 解决 props 层层传递问题 |
| 全量 CSS 文件 | TailwindCSS | 开发效率更高，一致性更好 |
| Git CLI 依赖 | 纯 Rust 实现 | 不依赖外部程序，跨平台更可靠 |

## 6. 错误处理策略

### 6.1 后端错误 → 前端

```
Rust Err(String) → Tauri serializes as string → invoke().catch(err)
```

每个 invoke 调用的通用错误处理：

```typescript
async function safeInvoke<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    store.error = String(err)
    return null
  }
}
```

### 6.2 错误分类展示

| 错误类型 | 用户提示                         |
|----------|----------------------------------|
| 数据库错误 | "数据读写失败，请重试"           |
| API 密钥未配置 | "请先在设置中配置 API 密钥"      |
| API 连接失败 | "无法连接到 AI 服务，请检查网络和配置" |
| Diff 为空 | "请选择两个不同的版本进行对比"    |
| 版本不存在 | "所选版本不存在，请刷新列表"      |

## 7. 开发步骤

### 第一阶段：项目初始化

1. 使用 `npm create tauri-app@latest` 创建 Vue + Rust 项目（或手动搭建）
2. 配置 Vite、TypeScript、TailwindCSS
3. 配置 Rust 依赖（Cargo.toml）

### 第二阶段：后端核心

4. 实现 `db.rs` — SQLite 建表 + CRUD
5. 实现 `diff.rs` — similar 文本比较
6. 实现 `version.rs` — 版本管理逻辑
7. 实现 `ai.rs` — AI 多提供商调用
8. 实现 `commands.rs` — 编排所有命令
9. 在 `lib.rs` 中组装 AppState + 注册命令

### 第三阶段：前端核心

10. 安装前端依赖（Vue、Milkdown、Pinia、TailwindCSS）
11. 实现 `Editor.vue` — Milkdown 封装
12. 实现 `document.ts` — Pinia Store
13. 实现 `EditorView.vue` — 主页布局
14. 实现 `VersionList.vue` — 版本历史
15. 实现 `DiffViewer.vue` — Diff 展示
16. 实现 `AIPanel.vue` — AI 分析面板
17. 实现 `ApiSettings.vue` — API 配置

### 第四阶段：集成测试

18. 端到端流程：编辑 → Commit → Diff → AI 分析
19. 错误处理验证
20. 多 AI 提供商测试

## 8. 与 CLAUDE.md 的一致性对照

| CLAUDE.md 条目 | 本设计状态 | 说明 |
|---------------|-----------|------|
| Vue 3 + TypeScript + Vite + TailwindCSS | ✅ 一致 | |
| Milkdown 编辑器 | ✅ 一致 | |
| Rust Tauri 2.x | ✅ 一致 | |
| SQLite (sqlx) | ✅ 一致 | sqlx 0.8 |
| `similar` crate Diff | ✅ 一致 | |
| `reqwest` HTTP | ✅ 一致 | |
| 数据库 3 表 | ✅ 增强为 4 表 | 增加 app_config |
| `commands.rs` 命令 | ✅ 完全实现 | 补全所有 todo!() |
| `ai.rs` 分析 | ✅ 增强 | 多提供商支持 |
| 编辑器封装 | ✅ 一致 | Milkdown useEditor |
| DiffViewer 展示 | ✅ 一致 | |
| 版本列表 | ✅ 一致 | |
| 开发步骤 | ✅ 遵循 | |

## 9. 未纳入范围

以下功能在本次架构重建中不包含（来自当前 React 项目的功能）：

- 技能系统（Skill Panel）— 未来可扩展
- 写作复盘（Writing Review）— 未来可扩展
- DOCX 导出（Export）— 未来可扩展
- 项目管理（Project Dialog）— 未来可扩展
- Git 状态栏（Git Status Bar）— 使用内置版本管理替代
- Git post-commit hook — 不需要（纯本地版本管理）
