# AiPen 架构重写 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 CLAUDE.md 规范完全重写 AiPen，基于 Vue 3 + Milkdown + Tauri 2 + SQLite 技术栈，实现文档编辑、版本管理、Diff 比对、AI 分析核心功能。

**Architecture:** 单体 Tauri 2 应用，后端 Rust 模块（db/diff/version/ai/commands）通过 IPC 向 Vue 3 前端暴露命令，前端使用 Pinia 管理唯一状态源，Milkdown 提供所见即所得 Markdown 编辑。

**Tech Stack:** Tauri 2.x / Vue 3.5 / TypeScript / Vite 6 / Milkdown 7.x / Pinia 3.x / TailwindCSS 4 / Rust ed2021 / sqlx 0.8 / similar 2.6 / reqwest 0.12 / thiserror 2 / uuid 1 / chrono 0.4

## Global Constraints

- 所有 Rust 模块使用 `thiserror` 定义私有错误类型，不直接返回 `String`
- 所有 Tauri 命令签名使用 `Result<T, String>`（Tauri 约束）
- 前端所有 API 调用通过 Pinia store 封装，组件不直接调用 `invoke()`
- Milkdown 编辑器通过 `v-model` 双向绑定，通过 `listener` 插件输出 Markdown
- 数据库路径固定为 `$APP_DATA_DIR/aipen.db`
- AI 配置持久化到 `app_config` 表
- 版本号从 1 开始递增

---

## 文件结构

```
aipen/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── capabilities/default.json
│   ├── icons/                          # 从模板生成
│   └── src/
│       ├── main.rs                     # 入口，调用 lib::run()
│       ├── lib.rs                      # AppState + Tauri Builder + 命令注册
│       ├── db.rs                       # SQLite CRUD
│       ├── diff.rs                     # similar 文本差异
│       ├── version.rs                  # 版本管理逻辑
│       ├── ai.rs                       # 多提供商 AI 引擎
│       └── commands.rs                 # Tauri 命令编排
├── src/
│   ├── main.ts                         # Vue 入口
│   ├── App.vue                         # 根组件
│   ├── styles/
│   │   └── main.css                    # TailwindCSS 入口
│   ├── stores/
│   │   └── document.ts                 # Pinia 状态管理
│   ├── views/
│   │   └── EditorView.vue             # 主页面
│   └── components/
│       ├── Editor.vue                  # Milkdown 封装
│       ├── DiffViewer.vue             # Diff 展示
│       ├── VersionList.vue            # 版本历史
│       ├── AIPanel.vue                # AI 分析面板
│       └── ApiSettings.vue            # API 配置弹窗
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tsconfig.node.json
└── tailwind.config.ts
```

---

### Task 1: 项目脚手架 — 初始化 Tauri + Vue 项目

**Files:**
- Create: `package.json`
- Create: `vite.config.ts`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `index.html`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/capabilities/default.json`
- Create: `src/main.ts` (占位)
- Create: `src/App.vue` (占位)
- Create: `src/styles/main.css` (占位)

**Interfaces:**
- Consumes: 无
- Produces: 可编译的空 Tauri 项目骨架

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "aipen",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "preview": "vite preview",
    "tauri": "tauri"
  },
  "dependencies": {
    "vue": "^3.5.0",
    "@milkdown/vue": "^7.6.0",
    "@milkdown/core": "^7.6.0",
    "@milkdown/preset-commonmark": "^7.6.0",
    "@milkdown/plugin-listener": "^7.6.0",
    "@tauri-apps/api": "^2.0.0",
    "@tauri-apps/plugin-opener": "^2.0.0",
    "pinia": "^3.0.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "@vitejs/plugin-vue": "^5.0.0",
    "typescript": "~5.8.0",
    "vue-tsc": "^2.0.0",
    "vite": "^6.0.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0"
  }
}
```

- [ ] **Step 2: 创建 vite.config.ts**

```typescript
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
```

- [ ] **Step 3: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "preserve",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*.ts", "src/**/*.vue"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 4: 创建 tsconfig.node.json**

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 5: 创建 index.html**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AiPen — AI 辅助文档写作</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 6: 创建 src-tauri/Cargo.toml**

```toml
[package]
name = "aipen"
version = "0.1.0"
description = "AiPen — AI 辅助文档写作"
authors = ["you"]
edition = "2021"

[lib]
name = "aipen_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
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

- [ ] **Step 7: 创建 src-tauri/tauri.conf.json**

```json
{
  "$schema": "https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-config-schema/schema.json",
  "productName": "AiPen",
  "version": "0.1.0",
  "identifier": "com.aipen.app",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "AiPen — AI 辅助文档写作",
        "width": 1200,
        "height": 800,
        "minWidth": 900,
        "minHeight": 600
      }
    ],
    "security": {
      "csp": null
    }
  }
}
```

- [ ] **Step 8: 创建 src-tauri/build.rs**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 9: 创建 src-tauri/capabilities/default.json**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default"
  ]
}
```

- [ ] **Step 10: 创建占位文件并验证编译**

写占位 `src/main.ts`:
```typescript
import { createApp } from "vue";
import App from "./App.vue";
import "./styles/main.css";

createApp(App).mount("#root");
```

写占位 `src/App.vue`:
```vue
<template>
  <div class="h-screen bg-gray-950 text-white flex items-center justify-center">
    <p class="text-lg">AiPen 加载中...</p>
  </div>
</template>
```

写占位 `src/styles/main.css`:
```css
@import "tailwindcss";
```

写占位 `src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    aipen_lib::run()
}
```

写占位 `src-tauri/src/lib.rs`:
```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

测试编译：
```bash
cd src-tauri && cargo check
cd .. && npm install
npm run tauri build -- --no-bundle  # 仅验证编译
```

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: scaffold Tauri + Vue 3 project"
```

---

### Task 2: 实现 db.rs — SQLite 数据库层

**Files:**
- Create: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/lib.rs` (添加 mod db)

**Interfaces:**
- Consumes: 无（独立模块）
- Produces: `init_db()`, `create_document()`, `get_document()`, `list_documents()`, `update_document_title()`, `create_version()`, `get_version()`, `get_version_content()`, `get_versions_by_doc()`, `get_latest_version()`, `save_analysis()`, `get_analysis()`, `get_config()`, `set_config()`, `get_all_configs()` + `DbError`

- [ ] **Step 1: 创建 db.rs — 错误类型 + 建表**

```rust
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::{ Pool, Sqlite, Row };
use serde::{Deserialize, Serialize};

// ─── 错误类型 ────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("数据库错误: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("记录未找到: {0}")]
    NotFound(String),
}

// ─── 模型 ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub title: String,
    pub project_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Version {
    pub id: String,
    pub doc_id: String,
    pub version_num: i64,
    pub commit_msg: String,
    pub content: String,
    pub parent_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIAnalysisRecord {
    pub id: String,
    pub version_id: String,
    pub old_version_id: Option<String>,
    pub analysis: String,  // JSON string of AIAnalysis
    pub created_at: String,
}
```

- [ ] **Step 2: 实现 init_db — 创建表**

```rust
pub async fn init_db(db_path: &str) -> Result<Pool<Sqlite>, DbError> {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(db_path)
        .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS documents (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            project_id  TEXT NOT NULL DEFAULT 'default',
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        )"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS versions (
            id          TEXT PRIMARY KEY,
            doc_id      TEXT NOT NULL,
            version_num INTEGER NOT NULL,
            commit_msg  TEXT NOT NULL DEFAULT '',
            content     TEXT NOT NULL,
            parent_id   TEXT,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE,
            FOREIGN KEY (parent_id) REFERENCES versions(id)
        )"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_versions_doc ON versions(doc_id)"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_doc_num ON versions(doc_id, version_num)"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS ai_analysis (
            id              TEXT PRIMARY KEY,
            version_id      TEXT NOT NULL,
            old_version_id  TEXT,
            analysis        TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (version_id) REFERENCES versions(id) ON DELETE CASCADE
        )"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_ai_analysis_version ON ai_analysis(version_id)"
    ).execute(&pool).await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS app_config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )"
    ).execute(&pool).await?;

    // 插入默认配置
    sqlx::query(
        "INSERT OR IGNORE INTO app_config (key, value) VALUES ('ai_provider', '\"openai\"')"
    ).execute(&pool).await?;
    sqlx::query(
        "INSERT OR IGNORE INTO app_config (key, value) VALUES ('ai_model', '\"gpt-4o\"')"
    ).execute(&pool).await?;
    sqlx::query(
        "INSERT OR IGNORE INTO app_config (key, value) VALUES ('ai_api_url', '\"https://api.openai.com/v1/chat/completions\"')"
    ).execute(&pool).await?;

    Ok(pool)
}
```

- [ ] **Step 3: 实现文档 CRUD**

```rust
pub async fn create_document(pool: &Pool<Sqlite>, title: &str) -> Result<Document, DbError> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO documents (id, title) VALUES (?, ?)")
        .bind(&id).bind(title)
        .execute(pool).await?;
    get_document(pool, &id).await
}

pub async fn get_document(pool: &Pool<Sqlite>, doc_id: &str) -> Result<Document, DbError> {
    let row = sqlx::query(
        "SELECT id, title, project_id, created_at, updated_at FROM documents WHERE id = ?"
    ).bind(doc_id).fetch_optional(pool).await?
        .ok_or_else(|| DbError::NotFound(format!("文档 {} 不存在", doc_id)))?;
    Ok(Document {
        id: row.get("id"),
        title: row.get("title"),
        project_id: row.get("project_id"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

pub async fn list_documents(pool: &Pool<Sqlite>) -> Result<Vec<Document>, DbError> {
    let rows = sqlx::query(
        "SELECT id, title, project_id, created_at, updated_at FROM documents ORDER BY updated_at DESC"
    ).fetch_all(pool).await?;
    Ok(rows.into_iter().map(|row| Document {
        id: row.get("id"),
        title: row.get("title"),
        project_id: row.get("project_id"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }).collect())
}

pub async fn update_document_title(pool: &Pool<Sqlite>, doc_id: &str, title: &str) -> Result<(), DbError> {
    let affected = sqlx::query(
        "UPDATE documents SET title = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(title).bind(doc_id).execute(pool).await?.rows_affected();
    if affected == 0 {
        return Err(DbError::NotFound(format!("文档 {} 不存在", doc_id)));
    }
    Ok(())
}
```

- [ ] **Step 4: 实现版本 CRUD**

```rust
pub async fn create_version(
    pool: &Pool<Sqlite>,
    doc_id: &str,
    content: &str,
    commit_msg: &str,
    version_num: i64,
    parent_id: Option<&str>,
) -> Result<Version, DbError> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO versions (id, doc_id, version_num, commit_msg, content, parent_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(&id).bind(doc_id).bind(version_num).bind(commit_msg).bind(content).bind(parent_id)
     .execute(pool).await?;
    get_version(pool, &id).await
}

pub async fn get_version(pool: &Pool<Sqlite>, version_id: &str) -> Result<Version, DbError> {
    let row = sqlx::query(
        "SELECT id, doc_id, version_num, commit_msg, content, parent_id, created_at FROM versions WHERE id = ?"
    ).bind(version_id).fetch_optional(pool).await?
        .ok_or_else(|| DbError::NotFound(format!("版本 {} 不存在", version_id)))?;
    Ok(Version {
        id: row.get("id"),
        doc_id: row.get("doc_id"),
        version_num: row.get("version_num"),
        commit_msg: row.get("commit_msg"),
        content: row.get("content"),
        parent_id: row.get("parent_id"),
        created_at: row.get("created_at"),
    })
}

pub async fn get_version_content(pool: &Pool<Sqlite>, version_id: &str) -> Result<String, DbError> {
    let row = sqlx::query("SELECT content FROM versions WHERE id = ?")
        .bind(version_id).fetch_optional(pool).await?
        .ok_or_else(|| DbError::NotFound(format!("版本 {} 不存在", version_id)))?;
    Ok(row.get::<String, _>("content"))
}

pub async fn get_versions_by_doc(pool: &Pool<Sqlite>, doc_id: &str) -> Result<Vec<Version>, DbError> {
    let rows = sqlx::query(
        "SELECT id, doc_id, version_num, commit_msg, content, parent_id, created_at FROM versions WHERE doc_id = ? ORDER BY version_num ASC"
    ).bind(doc_id).fetch_all(pool).await?;
    Ok(rows.into_iter().map(|row| Version {
        id: row.get("id"),
        doc_id: row.get("doc_id"),
        version_num: row.get("version_num"),
        commit_msg: row.get("commit_msg"),
        content: row.get("content"),
        parent_id: row.get("parent_id"),
        created_at: row.get("created_at"),
    }).collect())
}

pub async fn get_latest_version(pool: &Pool<Sqlite>, doc_id: &str) -> Result<Option<Version>, DbError> {
    let row = sqlx::query(
        "SELECT id, doc_id, version_num, commit_msg, content, parent_id, created_at FROM versions WHERE doc_id = ? ORDER BY version_num DESC LIMIT 1"
    ).bind(doc_id).fetch_optional(pool).await?;
    Ok(row.map(|r| Version {
        id: r.get("id"),
        doc_id: r.get("doc_id"),
        version_num: r.get("version_num"),
        commit_msg: r.get("commit_msg"),
        content: r.get("content"),
        parent_id: r.get("parent_id"),
        created_at: r.get("created_at"),
    }))
}
```

- [ ] **Step 5: 实现 AI 分析 + 配置 CRUD**

```rust
pub async fn save_analysis(
    pool: &Pool<Sqlite>,
    version_id: &str,
    old_version_id: Option<&str>,
    analysis: &str,
) -> Result<(), DbError> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO ai_analysis (id, version_id, old_version_id, analysis) VALUES (?, ?, ?, ?)"
    ).bind(&id).bind(version_id).bind(old_version_id).bind(analysis)
     .execute(pool).await?;
    Ok(())
}

pub async fn get_analysis(pool: &Pool<Sqlite>, version_id: &str) -> Result<Option<(String, Option<String>)>, DbError> {
    let row = sqlx::query(
        "SELECT analysis, old_version_id FROM ai_analysis WHERE version_id = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(version_id).fetch_optional(pool).await?;
    Ok(row.map(|r| (r.get("analysis"), r.get("old_version_id"))))
}

pub async fn get_config(pool: &Pool<Sqlite>, key: &str) -> Result<Option<String>, DbError> {
    let row = sqlx::query("SELECT value FROM app_config WHERE key = ?")
        .bind(key).fetch_optional(pool).await?;
    Ok(row.map(|r| r.get("value")))
}

pub async fn set_config(pool: &Pool<Sqlite>, key: &str, value: &str) -> Result<(), DbError> {
    sqlx::query(
        "INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)"
    ).bind(key).bind(value).execute(pool).await?;
    Ok(())
}

pub async fn get_all_configs(pool: &Pool<Sqlite>) -> Result<Vec<(String, String)>, DbError> {
    let rows = sqlx::query("SELECT key, value FROM app_config")
        .fetch_all(pool).await?;
    Ok(rows.into_iter().map(|r| (r.get("key"), r.get("value"))).collect())
}
```

- [ ] **Step 6: 注册模块到 lib.rs**

在 `src-tauri/src/lib.rs` 顶部添加：
```rust
mod db;
```

- [ ] **Step 7: 验证编译**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: implement SQLite database layer"
```

---

### Task 3: 实现 diff.rs — 文本差异引擎

**Files:**
- Create: `src-tauri/src/diff.rs`
- Modify: `src-tauri/src/lib.rs` (添加 mod diff)

**Interfaces:**
- Consumes: 无（纯函数）
- Produces: `DiffHunk`, `DiffResult`, `diff_documents(old, new) -> DiffResult`

- [ ] **Step 1: 创建 diff.rs**

```rust
use similar::{ChangeTag, TextDiff};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct DiffHunk {
    pub tag: String,      // "equal" | "insert" | "delete"
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffResult {
    pub hunks: Vec<DiffHunk>,
    pub additions: usize,
    pub deletions: usize,
    pub change_ratio: f64,
}

pub fn diff_documents(old: &str, new: &str) -> DiffResult {
    let diff = TextDiff::from_lines(old, new);
    let mut hunks = Vec::new();
    let mut additions = 0;
    let mut deletions = 0;

    for change in diff.iter_all_changes() {
        let tag = match change.tag() {
            ChangeTag::Equal => "equal",
            ChangeTag::Insert => { additions += 1; "insert" }
            ChangeTag::Delete => { deletions += 1; "delete" }
        };
        hunks.push(DiffHunk {
            tag: tag.to_string(),
            content: change.value().to_string(),
        });
    }

    let total = additions + deletions;
    let change_ratio = if total == 0 {
        0.0
    } else {
        total as f64 / (hunks.len().max(1) as f64)
    };

    DiffResult { hunks, additions, deletions, change_ratio }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_diff_identical() {
        let result = diff_documents("hello\nworld", "hello\nworld");
        assert_eq!(result.additions, 0);
        assert_eq!(result.deletions, 0);
        assert_eq!(result.change_ratio, 0.0);
    }

    #[test]
    fn test_diff_addition() {
        let result = diff_documents("hello", "hello\nworld");
        assert_eq!(result.additions, 1);
        assert_eq!(result.deletions, 0);
    }

    #[test]
    fn test_diff_deletion() {
        let result = diff_documents("hello\nworld", "hello");
        assert_eq!(result.additions, 0);
        assert_eq!(result.deletions, 1);
    }

    #[test]
    fn test_diff_both() {
        let result = diff_documents("hello\nfoo", "hello\nbar");
        assert_eq!(result.additions, 1);
        assert_eq!(result.deletions, 1);
    }
}
```

- [ ] **Step 2: 注册模块并运行测试**

```bash
# 在 lib.rs 添加 mod diff;
cd src-tauri && cargo test -- diff
```

预期输出:
```
running 4 tests
test diff::tests::test_diff_identical ... ok
test diff::tests::test_diff_addition ... ok
test diff::tests::test_diff_deletion ... ok
test diff::tests::test_diff_both ... ok
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: implement text diff engine with similar"
```

---

### Task 4: 实现 version.rs — 版本管理逻辑

**Files:**
- Create: `src-tauri/src/version.rs`
- Modify: `src-tauri/src/lib.rs` (添加 mod version)

**Interfaces:**
- Consumes: `db::create_version()`, `db::get_latest_version()`, `db::get_versions_by_doc()`, `db::get_version()` — 通过 Pool 调用
- Produces: `VersionError`, `create_new_version(pool, doc_id, content, commit_msg) -> Result<Version, VersionError>`, `get_version_tree(pool, doc_id) -> Result<Vec<Version>, VersionError>`

- [ ] **Step 1: 创建 version.rs**

```rust
use crate::db;
use sqlx::SqlitePool;

#[derive(Debug, thiserror::Error)]
pub enum VersionError {
    #[error("{0}")]
    Db(#[from] db::DbError),
    #[error("文档不存在: {0}")]
    DocNotFound(String),
}

/// 创建新版本
/// - 检查文档是否存在
/// - 获取最新版本号并 +1
/// - 记录 parent_id 为上一版本的 id
pub async fn create_new_version(
    pool: &SqlitePool,
    doc_id: &str,
    content: &str,
    commit_msg: &str,
) -> Result<db::Version, VersionError> {
    // 检查文档是否存在
    db::get_document(pool, doc_id).await.map_err(|_| VersionError::DocNotFound(doc_id.to_string()))?;

    // 获取当前最大版本号
    let latest = db::get_latest_version(pool, doc_id).await?;
    let (new_version_num, parent_id) = match latest {
        Some(v) => (v.version_num + 1, Some(v.id)),
        None => (1, None),
    };

    // 创建新版本
    let version = db::create_version(pool, doc_id, content, commit_msg, new_version_num, parent_id.as_deref()).await?;
    Ok(version)
}

/// 获取版本时间线（按版本号升序）
pub async fn get_version_tree(
    pool: &SqlitePool,
    doc_id: &str,
) -> Result<Vec<db::Version>, VersionError> {
    let versions = db::get_versions_by_doc(pool, doc_id).await?;
    Ok(versions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    async fn setup_test_db() -> SqlitePool {
        let pool = db::init_db("sqlite::memory:").await.unwrap();
        // 创建测试文档
        db::create_document(&pool, "测试文档").await.unwrap();
        pool
    }

    #[tokio::test]
    async fn test_create_first_version() {
        let pool = setup_test_db().await;
        let doc = db::list_documents(&pool).await.unwrap().into_iter().next().unwrap();

        let version = create_new_version(&pool, &doc.id, "# Hello", "初始版本").await.unwrap();
        assert_eq!(version.version_num, 1);
        assert_eq!(version.commit_msg, "初始版本");
        assert!(version.parent_id.is_none());
    }

    #[tokio::test]
    async fn test_create_second_version() {
        let pool = setup_test_db().await;
        let doc = db::list_documents(&pool).await.unwrap().into_iter().next().unwrap();

        let v1 = create_new_version(&pool, &doc.id, "# Hello", "v1").await.unwrap();
        let v2 = create_new_version(&pool, &doc.id, "# Hello World", "v2").await.unwrap();

        assert_eq!(v2.version_num, 2);
        assert_eq!(v2.parent_id, Some(v1.id));
    }

    #[tokio::test]
    async fn test_get_version_tree() {
        let pool = setup_test_db().await;
        let doc = db::list_documents(&pool).await.unwrap().into_iter().next().unwrap();

        create_new_version(&pool, &doc.id, "v1", "v1").await.unwrap();
        create_new_version(&pool, &doc.id, "v2", "v2").await.unwrap();
        create_new_version(&pool, &doc.id, "v3", "v3").await.unwrap();

        let tree = get_version_tree(&pool, &doc.id).await.unwrap();
        assert_eq!(tree.len(), 3);
        assert_eq!(tree[0].version_num, 1);
        assert_eq!(tree[2].version_num, 3);
    }
}
```

- [ ] **Step 2: 运行测试**

```bash
cd src-tauri && cargo test -- version
```

预期输出:
```
running 3 tests
test version::tests::test_create_first_version ... ok
test version::tests::test_create_second_version ... ok
test version::tests::test_get_version_tree ... ok
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: implement version management logic"
```

---

### Task 5: 实现 ai.rs — 多提供商 AI 引擎

**Files:**
- Create: `src-tauri/src/ai.rs`
- Modify: `src-tauri/src/lib.rs` (添加 mod ai)

**Interfaces:**
- Consumes: `DiffResult` (from diff.rs)
- Produces: `AIProvider`, `AIConfig`, `AIAnalysis`, `AIError`, `analyze_revision()`, `test_connection()`, `normalize_api_url()`

- [ ] **Step 1: 创建 ai.rs — 类型定义**

```rust
use serde::{Deserialize, Serialize};
use serde_json::json;

// ─── 类型 ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIConfig {
    pub provider: String,   // "claude" | "openai" | "deepseek" | "custom"
    pub api_key: String,
    pub api_url: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIAnalysis {
    pub highlights: Vec<String>,
    pub issues: Vec<String>,
    pub suggestions: Vec<String>,
}

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

- [ ] **Step 2: 实现 API URL 归一化 + 连通性测试**

```rust
/// 自动补全 API URL 路径
pub fn normalize_api_url(url: &str) -> String {
    let url = url.trim_end_matches('/');
    if url.contains("/chat/completions") || url.contains("/v1/messages") {
        return url.to_string();
    }
    if url.contains("anthropic.com") {
        format!("{}/v1/messages", url)
    } else {
        format!("{}/v1/chat/completions", url)
    }
}

/// 测试 API 连接
pub async fn test_connection(config: &AIConfig) -> Result<String, AIError> {
    if config.api_key.is_empty() {
        return Err(AIError::NotConfigured);
    }

    let client = reqwest::Client::new();
    let api_url = normalize_api_url(&config.api_url);
    let is_claude = api_url.contains("anthropic.com");

    let request_body = if is_claude {
        json!({
            "model": &config.model,
            "max_tokens": 20,
            "system": "只回复OK",
            "messages": [{"role": "user", "content": "连通性测试"}]
        })
    } else {
        json!({
            "model": &config.model,
            "max_tokens": 20,
            "messages": [
                {"role": "system", "content": "只回复OK"},
                {"role": "user", "content": "连通性测试"}
            ]
        })
    };

    let mut req = client.post(&api_url)
        .header("Content-Type", "application/json");

    if is_claude {
        req = req.header("x-api-key", &config.api_key)
            .header("anthropic-version", "2023-06-01");
    } else {
        req = req.header("Authorization", format!("Bearer {}", config.api_key));
    }

    let response = req.json(&request_body).send().await
        .map_err(|e| AIError::RequestFailed(e.to_string()))?;

    let status = response.status();
    if status.is_success() {
        Ok("✅ 连接成功！API 密钥有效。".to_string())
    } else {
        let body = response.text().await.unwrap_or_default();
        let msg = if body.len() > 200 {
            format!("{}...", &body[..200])
        } else {
            body
        };
        Err(AIError::ApiError { status: status.as_u16(), message: msg })
    }
}
```

- [ ] **Step 3: 实现核心 AI 分析函数**

```rust
/// 分析版本修订
pub async fn analyze_revision(
    old_content: &str,
    new_content: &str,
    diff_additions: usize,
    diff_deletions: usize,
    config: &AIConfig,
) -> Result<AIAnalysis, AIError> {
    if config.api_key.is_empty() {
        return Err(AIError::NotConfigured);
    }

    let prompt = build_analysis_prompt(old_content, new_content, diff_additions, diff_deletions);
    let response = call_ai_api(config, &prompt).await?;
    parse_analysis_response(&response)
}

/// 构建分析提示词
fn build_analysis_prompt(old: &str, new: &str, add: usize, del: usize) -> String {
    format!(
        r#"你是一位资深编辑。请分析以下文档修改：

## 修改前
{old}

## 修改后
{new}

## 修改摘要
新增 {add} 处，删除 {del} 处

请以严格 JSON 格式返回分析结果（只输出 JSON，不要包含其他文字）：
{{
  "highlights": ["修改的优点1", "修改的优点2"],
  "issues": ["存在的问题1", "存在的问题2"],
  "suggestions": ["改进建议1", "改进建议2"]
}}"#,
        old = old, new = new, add = add, del = del
    )
}
```

- [ ] **Step 4: 实现 AI API 调用 + 响应解析**

```rust
/// 调用 AI API
async fn call_ai_api(config: &AIConfig, prompt: &str) -> Result<String, AIError> {
    let client = reqwest::Client::new();
    let api_url = normalize_api_url(&config.api_url);
    let is_claude = api_url.contains("anthropic.com");

    let request_body = if is_claude {
        json!({
            "model": &config.model,
            "max_tokens": 4096,
            "system": "你是一位资深编辑，精通文档审阅与修改分析。请用中文回答，保持专业、客观、具体。",
            "messages": [{"role": "user", "content": prompt}]
        })
    } else {
        let mut body = serde_json::Map::new();
        body.insert("model".into(), json!(&config.model));
        body.insert("max_tokens".into(), json!(4096));
        body.insert("response_format".into(), json!({"type": "json_object"}));
        body.insert("messages".into(), json!([
            {"role": "system", "content": "你是一位资深编辑，精通文档审阅与修改分析。请用中文回答，保持专业、客观、具体。"},
            {"role": "user", "content": prompt}
        ]));
        if config.model.contains("deepseek") {
            body.insert("thinking".into(), json!({"type": "enabled"}));
            body.insert("reasoning_effort".into(), json!("high"));
        }
        serde_json::Value::Object(body)
    };

    let mut req = client.post(&api_url)
        .header("Content-Type", "application/json");

    if is_claude {
        req = req.header("x-api-key", &config.api_key)
            .header("anthropic-version", "2023-06-01");
    } else {
        req = req.header("Authorization", format!("Bearer {}", config.api_key));
    }

    let response = req.json(&request_body).send().await
        .map_err(|e| AIError::RequestFailed(e.to_string()))?;

    let status = response.status();
    let body = response.text().await.map_err(|e| AIError::RequestFailed(e.to_string()))?;

    if !status.is_success() {
        let msg = if body.len() > 200 { format!("{}...", &body[..200]) } else { body };
        return Err(AIError::ApiError { status: status.as_u16(), message: msg });
    }

    // 解析响应
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| AIError::ParseFailed(format!("JSON 解析失败: {}", e)))?;

    let content = parsed["content"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|c| c["text"].as_str())
        .or_else(|| {
            parsed["choices"]
                .as_array()
                .and_then(|arr| arr.first())
                .and_then(|c| c["message"]["content"].as_str())
        })
        .ok_or_else(|| AIError::ParseFailed("无法从响应中提取文本".to_string()))?;

    Ok(content.to_string())
}

/// 解析 AI 响应为结构化结果
fn parse_analysis_response(text: &str) -> Result<AIAnalysis, AIError> {
    // 尝试从 ```json 代码块提取
    let json_str = if let Some(start) = text.find("```json\n") {
        let s = start + "```json\n".len();
        if let Some(end) = text[s..].find("\n```") {
            &text[s..s + end]
        } else {
            text
        }
    } else {
        text
    };

    let analysis: AIAnalysis = serde_json::from_str(json_str)
        .map_err(|e| AIError::ParseFailed(format!("JSON 解析失败: {}", e)))?;

    Ok(analysis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_analysis_response() {
        let json = r#"{"highlights":["优点1"],"issues":["问题1"],"suggestions":["建议1"]}"#;
        let result = parse_analysis_response(json).unwrap();
        assert_eq!(result.highlights.len(), 1);
        assert_eq!(result.highlights[0], "优点1");
    }

    #[test]
    fn test_parse_with_code_block() {
        let text = "分析结果如下：\n```json\n{\"highlights\":[],\"issues\":[],\"suggestions\":[]}\n```";
        let result = parse_analysis_response(text).unwrap();
        assert_eq!(result.highlights.len(), 0);
    }

    #[test]
    fn test_normalize_api_url() {
        assert_eq!(
            normalize_api_url("https://api.openai.com"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            normalize_api_url("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            normalize_api_url("https://api.deepseek.com/v1/chat/completions"),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }
}
```

- [ ] **Step 5: 运行测试**

```bash
cd src-tauri && cargo test -- ai
```

预期输出:
```
running 3 tests
test ai::tests::test_parse_analysis_response ... ok
test ai::tests::test_parse_with_code_block ... ok
test ai::tests::test_normalize_api_url ... ok
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: implement multi-provider AI analysis engine"
```

---

### Task 6: 实现 commands.rs — Tauri 命令编排

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (注册命令)

**Interfaces:**
- Consumes: `db`, `diff`, `version`, `ai` 模块 + `AppState`
- Produces: 所有 Tauri 命令函数

- [ ] **Step 1: 创建 commands.rs**

```rust
use crate::{ai, db, diff, version};
use serde::{Deserialize, Serialize};
use tauri::State;

// ─── 文档命令 ────────────────────────────────────────────────

#[tauri::command]
pub async fn create_document(
    state: State<'_, crate::AppState>,
    title: String,
) -> Result<db::Document, String> {
    db::create_document(&state.db, &title).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_document(
    state: State<'_, crate::AppState>,
    doc_id: String,
) -> Result<db::Document, String> {
    db::get_document(&state.db, &doc_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_documents(
    state: State<'_, crate::AppState>,
) -> Result<Vec<db::Document>, String> {
    db::list_documents(&state.db).await.map_err(|e| e.to_string())
}

// ─── 版本命令 ────────────────────────────────────────────────

#[tauri::command]
pub async fn commit_version(
    state: State<'_, crate::AppState>,
    doc_id: String,
    content: String,
    commit_msg: String,
) -> Result<db::Version, String> {
    version::create_new_version(&state.db, &doc_id, &content, &commit_msg)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_versions(
    state: State<'_, crate::AppState>,
    doc_id: String,
) -> Result<Vec<db::Version>, String> {
    version::get_version_tree(&state.db, &doc_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_version(
    state: State<'_, crate::AppState>,
    version_id: String,
) -> Result<db::Version, String> {
    db::get_version(&state.db, &version_id)
        .await
        .map_err(|e| e.to_string())
}

// ─── Diff 命令 ───────────────────────────────────────────────

#[tauri::command]
pub async fn get_diff(
    state: State<'_, crate::AppState>,
    old_version_id: String,
    new_version_id: String,
) -> Result<diff::DiffResult, String> {
    let old = db::get_version_content(&state.db, &old_version_id)
        .await
        .map_err(|e| e.to_string())?;
    let new = db::get_version_content(&state.db, &new_version_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(diff::diff_documents(&old, &new))
}

// ─── AI 分析命令 ─────────────────────────────────────────────

#[tauri::command]
pub async fn analyze_revision(
    state: State<'_, crate::AppState>,
    old_version_id: String,
    new_version_id: String,
) -> Result<ai::AIAnalysis, String> {
    let config = {
        let cfg = state.ai_config.lock().map_err(|e| e.to_string())?;
        cfg.clone()
    };

    let old = db::get_version_content(&state.db, &old_version_id)
        .await
        .map_err(|e| e.to_string())?;
    let new = db::get_version_content(&state.db, &new_version_id)
        .await
        .map_err(|e| e.to_string())?;
    let diff_result = diff::diff_documents(&old, &new);

    let analysis = ai::analyze_revision(
        &old,
        &new,
        diff_result.additions,
        diff_result.deletions,
        &config,
    )
    .await
    .map_err(|e| e.to_string())?;

    // 持久化分析结果
    let analysis_json = serde_json::to_string(&analysis).map_err(|e| e.to_string())?;
    db::save_analysis(&state.db, &new_version_id, Some(&old_version_id), &analysis_json)
        .await
        .ok();

    Ok(analysis)
}

#[tauri::command]
pub async fn get_analysis(
    state: State<'_, crate::AppState>,
    version_id: String,
) -> Result<Option<ai::AIAnalysis>, String> {
    let result = db::get_analysis(&state.db, &version_id)
        .await
        .map_err(|e| e.to_string())?;
    match result {
        Some((analysis_json, _old_vid)) => {
            let analysis: ai::AIAnalysis = serde_json::from_str(&analysis_json)
                .map_err(|e| format!("解析分析结果失败: {}", e))?;
            Ok(Some(analysis))
        }
        None => Ok(None),
    }
}

// ─── 配置命令 ────────────────────────────────────────────────

#[tauri::command]
pub async fn get_api_config(
    state: State<'_, crate::AppState>,
) -> Result<ai::AIConfig, String> {
    let cfg = state.ai_config.lock().map_err(|e| e.to_string())?;
    Ok(cfg.clone())
}

#[tauri::command]
pub async fn set_api_config(
    state: State<'_, crate::AppState>,
    provider: String,
    api_key: String,
    api_url: String,
    model: String,
) -> Result<(), String> {
    let cfg = ai::AIConfig {
        provider: if provider.is_empty() { "openai".into() } else { provider },
        api_key,
        api_url: if api_url.is_empty() {
            "https://api.openai.com/v1/chat/completions".into()
        } else {
            api_url
        },
        model: if model.is_empty() { "gpt-4o".into() } else { model },
    };

    // 保存到内存
    {
        let mut stored = state.ai_config.lock().map_err(|e| e.to_string())?;
        *stored = cfg.clone();
    }

    // 持久化到数据库
    db::set_config(&state.db, "ai_provider", &format!("\"{}\"", cfg.provider))
        .await.map_err(|e| e.to_string())?;
    db::set_config(&state.db, "ai_model", &format!("\"{}\"", cfg.model))
        .await.map_err(|e| e.to_string())?;
    db::set_config(&state.db, "ai_api_url", &format!("\"{}\"", cfg.api_url))
        .await.map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn test_api_connection(
    state: State<'_, crate::AppState>,
) -> Result<String, String> {
    let cfg = state.ai_config.lock().map_err(|e| e.to_string())?.clone();
    ai::test_connection(&cfg).await.map_err(|e| e.to_string())
}
```

- [ ] **Step 2: 更新 lib.rs 注册模块和命令**

完整更新 `src-tauri/src/lib.rs`:

```rust
mod ai;
mod commands;
mod db;
mod diff;
mod version;

use std::sync::Mutex;

pub struct AppState {
    pub db: sqlx::SqlitePool,
    pub ai_config: Mutex<ai::AIConfig>,
}

fn load_config_from_db(pool: &sqlx::SqlitePool) -> ai::AIConfig {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let provider = rt.block_on(db::get_config(pool, "ai_provider"))
        .ok().flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| "openai".to_string());
    let model = rt.block_on(db::get_config(pool, "ai_model"))
        .ok().flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| "gpt-4o".to_string());
    let api_url = rt.block_on(db::get_config(pool, "ai_api_url"))
        .ok().flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| "https://api.openai.com/v1/chat/completions".to_string());

    ai::AIConfig {
        provider,
        api_key: String::new(),  // 密钥不持久化存储，每次由前端设置
        api_url,
        model,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 使用 tokio runtime 初始化数据库
    let rt = tokio::runtime::Runtime::new().unwrap();
    let db_path = dirs_next::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("aipen")
        .join("aipen.db");

    // 确保目录存在
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let pool = rt.block_on(db::init_db(db_path.to_str().unwrap()))
        .expect("数据库初始化失败");

    let ai_config = load_config_from_db(&pool);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            db: pool,
            ai_config: Mutex::new(ai_config),
        })
        .invoke_handler(tauri::generate_handler![
            // 文档
            commands::create_document,
            commands::get_document,
            commands::list_documents,
            // 版本
            commands::commit_version,
            commands::get_versions,
            commands::get_version,
            // Diff
            commands::get_diff,
            // AI
            commands::analyze_revision,
            commands::get_analysis,
            // 配置
            commands::get_api_config,
            commands::set_api_config,
            commands::test_api_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

注意: `dirs_next::config_dir()` 在 Cargo.toml 中需要添加依赖:
```toml
dirs-next = "2"
```

更新 Cargo.toml 的 `[dependencies]` 添加:
```toml
dirs-next = "2"
```

- [ ] **Step 3: 验证编译**

```bash
cd src-tauri && cargo check
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: implement Tauri commands and wire up backend"
```

---

### Task 7: 实现 Pinia Store — document.ts

**Files:**
- Create: `src/stores/document.ts`

**Interfaces:**
- Consumes: Tauri commands via `invoke()`
- Produces: `useDocumentStore()` — 供所有组件调用的 Pinia store

- [ ] **Step 1: 创建 document.ts**

```typescript
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";

// ─── 类型定义 ────────────────────────────────────────────────

export interface Document {
  id: string;
  title: string;
  project_id: string;
  created_at: string;
  updated_at: string;
}

export interface Version {
  id: string;
  doc_id: string;
  version_num: number;
  commit_msg: string;
  content: string;
  parent_id: string | null;
  created_at: string;
}

export interface DiffHunk {
  tag: "equal" | "insert" | "delete";
  content: string;
}

export interface DiffResult {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  change_ratio: number;
}

export interface AIAnalysis {
  highlights: string[];
  issues: string[];
  suggestions: string[];
}

export interface AIConfig {
  provider: string;
  api_key: string;
  api_url: string;
  model: string;
}

// ─── Store ───────────────────────────────────────────────────

export const useDocumentStore = defineStore("document", () => {
  // ── 文档状态 ──
  const currentDocId = ref("");
  const currentTitle = ref("新文档");
  const currentContent = ref("");

  // ── 版本状态 ──
  const versions = ref<Version[]>([]);
  const selectedOldVersionId = ref("");
  const selectedNewVersionId = ref("");

  // ── Diff 状态 ──
  const diffResult = ref<DiffResult | null>(null);

  // ── AI 分析状态 ──
  const analysisResult = ref<AIAnalysis | null>(null);

  // ── API 配置 ──
  const apiConfig = ref<AIConfig>({
    provider: "openai",
    api_key: "",
    api_url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o",
  });

  // ── UI 状态 ──
  const loading = ref({
    init: false,
    commit: false,
    versions: false,
    diff: false,
    analysis: false,
  });

  const error = ref("");

  // ── 计算属性 ──
  const hasSelectedVersions = computed(
    () => selectedOldVersionId.value !== "" && selectedNewVersionId.value !== ""
  );

  const canDiff = computed(
    () =>
      selectedOldVersionId.value !== "" &&
      selectedNewVersionId.value !== "" &&
      selectedOldVersionId.value !== selectedNewVersionId.value
  );

  // ── 操作 ──

  /** 初始化：创建新文档或加载已有文档 */
  async function initDocument(title?: string) {
    loading.value.init = true;
    error.value = "";
    try {
      // 创建默认文档
      const doc = await invoke<Document>("create_document", {
        title: title || "新文档",
      });
      currentDocId.value = doc.id;
      currentTitle.value = doc.title;
      currentContent.value = "";
      await loadVersions();
      await loadApiConfig();
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value.init = false;
    }
  }

  /** 加载已有文档 */
  async function loadDocument(docId: string) {
    loading.value.init = true;
    error.value = "";
    try {
      const doc = await invoke<Document>("get_document", { docId });
      currentDocId.value = doc.id;
      currentTitle.value = doc.title;
      currentContent.value = "";

      // 加载最新版本的内容
      await loadVersions();
      if (versions.value.length > 0) {
        const latest = versions.value[versions.value.length - 1];
        currentContent.value = latest.content;
      }

      await loadApiConfig();
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value.init = false;
    }
  }

  /** 提交新版本 */
  async function commitVersion(commitMsg: string) {
    if (!currentDocId.value || !commitMsg.trim()) return;
    loading.value.commit = true;
    error.value = "";
    try {
      await invoke<Version>("commit_version", {
        docId: currentDocId.value,
        content: currentContent.value,
        commitMsg: commitMsg.trim(),
      });
      await loadVersions();
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value.commit = false;
    }
  }

  /** 加载版本列表 */
  async function loadVersions() {
    if (!currentDocId.value) return;
    loading.value.versions = true;
    try {
      versions.value = await invoke<Version[]>("get_versions", {
        docId: currentDocId.value,
      });
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value.versions = false;
    }
  }

  /** 加载单个版本内容到编辑器 */
  async function loadVersionContent(versionId: string) {
    try {
      const version = await invoke<Version>("get_version", { versionId });
      currentContent.value = version.content;
    } catch (err) {
      error.value = String(err);
    }
  }

  /** 获取 Diff 对比结果 */
  async function compareVersions() {
    if (!canDiff.value) {
      error.value = "请选择两个不同的版本进行对比";
      return;
    }
    loading.value.diff = true;
    error.value = "";
    diffResult.value = null;
    try {
      diffResult.value = await invoke<DiffResult>("get_diff", {
        oldVersionId: selectedOldVersionId.value,
        newVersionId: selectedNewVersionId.value,
      });
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value.diff = false;
    }
  }

  /** AI 分析版本修订 */
  async function analyzeRevision() {
    if (!canDiff.value) {
      error.value = "请先选择两个版本进行对比";
      return;
    }
    loading.value.analysis = true;
    error.value = "";
    analysisResult.value = null;
    try {
      analysisResult.value = await invoke<AIAnalysis>("analyze_revision", {
        oldVersionId: selectedOldVersionId.value,
        newVersionId: selectedNewVersionId.value,
      });
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value.analysis = false;
    }
  }

  /** 加载已有分析结果 */
  async function loadExistingAnalysis(versionId: string) {
    try {
      const result = await invoke<AIAnalysis | null>("get_analysis", {
        versionId,
      });
      if (result) {
        analysisResult.value = result;
      }
    } catch {
      // 没有缓存结果，忽略
    }
  }

  /** 加载 API 配置 */
  async function loadApiConfig() {
    try {
      const cfg = await invoke<AIConfig>("get_api_config");
      apiConfig.value = cfg;
    } catch {
      // 使用默认值
    }
  }

  /** 保存 API 配置 */
  async function saveApiConfig(config: AIConfig) {
    error.value = "";
    try {
      await invoke("set_api_config", {
        provider: config.provider,
        apiKey: config.api_key,
        apiUrl: config.api_url,
        model: config.model,
      });
      apiConfig.value = config;
    } catch (err) {
      error.value = String(err);
    }
  }

  /** 测试 API 连接 */
  async function testApiConnection(): Promise<string> {
    return await invoke<string>("test_api_connection");
  }

  // 重置状态
  function reset() {
    currentDocId.value = "";
    currentTitle.value = "新文档";
    currentContent.value = "";
    versions.value = [];
    selectedOldVersionId.value = "";
    selectedNewVersionId.value = "";
    diffResult.value = null;
    analysisResult.value = null;
    error.value = "";
  }

  return {
    // 状态
    currentDocId,
    currentTitle,
    currentContent,
    versions,
    selectedOldVersionId,
    selectedNewVersionId,
    diffResult,
    analysisResult,
    apiConfig,
    loading,
    error,
    // 计算
    hasSelectedVersions,
    canDiff,
    // 操作
    initDocument,
    loadDocument,
    commitVersion,
    loadVersions,
    loadVersionContent,
    compareVersions,
    analyzeRevision,
    loadExistingAnalysis,
    loadApiConfig,
    saveApiConfig,
    testApiConnection,
    reset,
  };
});
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement Pinia document store"
```

---

### Task 8: 实现 Editor.vue — Milkdown 编辑器封装

**Files:**
- Create: `src/components/Editor.vue`

**Interfaces:**
- Consumes: `modelValue` (prop), store 状态
- Produces: `update:modelValue` (emit)

- [ ] **Step 1: 创建 Editor.vue**

```vue
<script setup lang="ts">
import { Milkdown, useEditor } from "@milkdown/vue";
import { Editor, rootCtx, defaultValueCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { listener, listenerCtx } from "@milkdown/plugin-listener";

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

useEditor((root) =>
  Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, props.modelValue);
      ctx.get(listenerCtx).markdownUpdated((_, markdown) => {
        emit("update:modelValue", markdown);
      });
    })
    .use(commonmark)
    .use(listener)
);
</script>

<template>
  <div class="h-full overflow-auto p-6">
    <Milkdown class="prose prose-invert max-w-none min-h-full" />
  </div>
</template>

<style scoped>
.prose {
  outline: none;
}
.prose:focus {
  outline: none;
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement Milkdown editor component"
```

---

### Task 9: 实现 VersionList.vue — 版本历史列表

**Files:**
- Create: `src/components/VersionList.vue`

**Interfaces:**
- Consumes: `useDocumentStore()`
- Produces: 版本选择状态（设置 selectedOldVersionId / selectedNewVersionId）

- [ ] **Step 1: 创建 VersionList.vue**

```vue
<script setup lang="ts">
import { useDocumentStore } from "../stores/document";
import { storeToRefs } from "pinia";

const store = useDocumentStore();
const { versions, loading, selectedOldVersionId, selectedNewVersionId, currentTitle } =
  storeToRefs(store);

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr.replace(" ", "T") + "Z");
    return d.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

function toggleVersionSelection(versionId: string) {
  if (selectedOldVersionId.value === versionId) {
    selectedOldVersionId.value = "";
    return;
  }
  if (selectedNewVersionId.value === versionId) {
    selectedNewVersionId.value = "";
    return;
  }
  // 如果还没有选中的版本，设为旧版
  if (!selectedOldVersionId.value) {
    selectedOldVersionId.value = versionId;
  } else if (!selectedNewVersionId.value) {
    // 确保新旧版本不同
    if (versionId !== selectedOldVersionId.value) {
      selectedNewVersionId.value = versionId;
    }
  } else {
    // 两个都选中了，重新开始：旧的变成新的，新选的变成旧的
    selectedOldVersionId.value = selectedNewVersionId.value;
    selectedNewVersionId.value = versionId;
  }
}

function isSelected(versionId: string): "old" | "new" | "none" {
  if (versionId === selectedOldVersionId.value) return "old";
  if (versionId === selectedNewVersionId.value) return "new";
  return "none";
}

function handleLoadVersion(versionId: string) {
  store.loadVersionContent(versionId);
}
</script>

<template>
  <div class="space-y-2">
    <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
      版本历史
    </h3>

    <!-- 空状态 -->
    <div
      v-if="!loading.versions && versions.length === 0"
      class="text-center py-8 text-gray-500 text-sm"
    >
      <p class="mb-1">暂无版本记录</p>
      <p class="text-xs">编辑文档后点击提交创建第一个版本</p>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading.versions" class="space-y-2 animate-pulse">
      <div v-for="i in 3" :key="i" class="h-16 bg-gray-800 rounded-lg"></div>
    </div>

    <!-- 版本列表 -->
    <div v-else class="space-y-1">
      <div
        v-for="v in versions"
        :key="v.id"
        class="group flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors"
        :class="{
          'bg-blue-900/30 border border-blue-700/50': isSelected(v.id) === 'old',
          'bg-green-900/30 border border-green-700/50': isSelected(v.id) === 'new',
          'hover:bg-gray-800/50 border border-transparent': isSelected(v.id) === 'none',
        }"
        @click="toggleVersionSelection(v.id)"
      >
        <!-- 版本号 -->
        <div
          class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
          :class="{
            'bg-blue-600 text-white': isSelected(v.id) === 'old',
            'bg-green-600 text-white': isSelected(v.id) === 'new',
            'bg-gray-700 text-gray-300': isSelected(v.id) === 'none',
          }"
        >
          v{{ v.version_num }}
        </div>

        <!-- 信息 -->
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <p class="text-sm font-medium text-gray-200 truncate">
              {{ v.commit_msg || `版本 ${v.version_num}` }}
            </p>
            <span
              v-if="isSelected(v.id) === 'old'"
              class="text-xs px-1.5 py-0.5 rounded bg-blue-800 text-blue-200"
            >
              旧版
            </span>
            <span
              v-if="isSelected(v.id) === 'new'"
              class="text-xs px-1.5 py-0.5 rounded bg-green-800 text-green-200"
            >
              新版
            </span>
          </div>
          <div class="flex items-center gap-2 mt-1">
            <span class="text-xs text-gray-500">{{ formatDate(v.created_at) }}</span>
            <button
              class="text-xs text-gray-500 hover:text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity"
              @click.stop="handleLoadVersion(v.id)"
              title="加载此版本内容到编辑器"
            >
              查看
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 选择提示 -->
    <div
      v-if="versions.length > 0"
      class="text-xs text-gray-500 bg-gray-800/50 rounded-lg p-2 text-center"
    >
      <template v-if="!selectedOldVersionId && !selectedNewVersionId">
        点击版本选择旧版，再点击另一个选择新版
      </template>
      <template v--if="selectedOldVersionId && !selectedNewVersionId">
        已选旧版，请再选择一个版本作为新版
      </template>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement version list component"
```

---

### Task 10: 实现 DiffViewer.vue — Diff 比对展示

**Files:**
- Create: `src/components/DiffViewer.vue`

**Interfaces:**
- Consumes: `useDocumentStore().diffResult`, `useDocumentStore().compareVersions()`

- [ ] **Step 1: 创建 DiffViewer.vue**

```vue
<script setup lang="ts">
import { useDocumentStore } from "../stores/document";
import { storeToRefs } from "pinia";

const store = useDocumentStore();
const { diffResult, loading, canDiff, selectedOldVersionId, selectedNewVersionId } =
  storeToRefs(store);
</script>

<template>
  <div class="space-y-3">
    <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
      Diff 对比
    </h3>

    <!-- 对比按钮 -->
    <div class="flex items-center gap-2">
      <button
        class="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
        :disabled="!canDiff || loading.diff"
        @click="store.compareVersions()"
      >
        <span v-if="loading.diff" class="flex items-center gap-2">
          <span class="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
          对比中...
        </span>
        <span v-else>对比 Diff</span>
      </button>
      <!-- 已选版本提示 -->
      <span v-if="!canDiff && (selectedOldVersionId || selectedNewVersionId)" class="text-xs text-yellow-500">
        请选择两个不同版本
      </span>
    </div>

    <!-- 等待选择状态 -->
    <div
      v-if="!diffResult && !loading.diff && !selectedOldVersionId"
      class="text-center py-8 text-gray-500 text-sm"
    >
      在版本历史中选择两个版本进行对比
    </div>

    <!-- 加载状态 -->
    <div v-if="loading.diff" class="space-y-1 animate-pulse">
      <div v-for="i in 5" :key="i" class="h-6 bg-gray-800 rounded"></div>
    </div>

    <!-- Diff 结果 -->
    <div v-if="diffResult && !loading.diff" class="space-y-2">
      <!-- 统计 -->
      <div class="flex items-center gap-3 text-sm">
        <span class="text-green-400 font-medium">+{{ diffResult.additions }}</span>
        <span class="text-red-400 font-medium">-{{ diffResult.deletions }}</span>
        <span class="text-gray-500 text-xs">
          变更率: {{ (diffResult.change_ratio * 100).toFixed(1) }}%
        </span>
      </div>

      <!-- Diff 行 -->
      <div class="font-mono text-xs border border-gray-700 rounded-lg overflow-hidden">
        <div
          v-for="(hunk, i) in diffResult.hunks"
          :key="i"
          class="px-3 py-0.5 leading-6 whitespace-pre-wrap"
          :class="{
            'bg-green-950/50 text-green-300': hunk.tag === 'insert',
            'bg-red-950/50 text-red-300': hunk.tag === 'delete',
            'text-gray-400': hunk.tag === 'equal',
          }"
        >
          <span class="select-none mr-2 opacity-40 w-4 inline-block text-right">
            {{ hunk.tag === "insert" ? "+" : hunk.tag === "delete" ? "−" : " " }}
          </span>
          {{ hunk.content }}
        </div>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement diff viewer component"
```

---

### Task 11: 实现 AIPanel.vue — AI 分析面板

**Files:**
- Create: `src/components/AIPanel.vue`

**Interfaces:**
- Consumes: `useDocumentStore().analysisResult`, `useDocumentStore().analyzeRevision()`

- [ ] **Step 1: 创建 AIPanel.vue**

```vue
<script setup lang="ts">
import { useDocumentStore } from "../stores/document";
import { storeToRefs } from "pinia";

const store = useDocumentStore();
const { analysisResult, loading, canDiff } = storeToRefs(store);
</script>

<template>
  <div class="space-y-3">
    <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
      AI 分析
    </h3>

    <!-- 分析按钮 -->
    <button
      class="w-full px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors"
      :disabled="!canDiff || loading.analysis"
      @click="store.analyzeRevision()"
    >
      <span v-if="loading.analysis" class="flex items-center justify-center gap-2">
        <span class="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
        AI 分析中...
      </span>
      <span v-else>🤖 AI 分析修改</span>
    </button>

    <!-- 空状态 -->
    <div
      v-if="!analysisResult && !loading.analysis"
      class="text-center py-8 text-gray-500 text-sm"
    >
      <p>选择两个版本后点击分析</p>
    </div>

    <!-- 加载骨架屏 -->
    <div v-if="loading.analysis" class="space-y-3 animate-pulse">
      <div class="space-y-2">
        <div class="h-4 w-16 bg-gray-800 rounded"></div>
        <div class="h-3 w-full bg-gray-800 rounded"></div>
        <div class="h-3 w-3/4 bg-gray-800 rounded"></div>
      </div>
      <div class="space-y-2">
        <div class="h-4 w-16 bg-gray-800 rounded"></div>
        <div class="h-3 w-full bg-gray-800 rounded"></div>
        <div class="h-3 w-2/3 bg-gray-800 rounded"></div>
      </div>
      <div class="space-y-2">
        <div class="h-4 w-16 bg-gray-800 rounded"></div>
        <div class="h-3 w-full bg-gray-800 rounded"></div>
      </div>
    </div>

    <!-- 分析结果 -->
    <div v-if="analysisResult && !loading.analysis" class="space-y-4">
      <!-- 优点 -->
      <div v-if="analysisResult.highlights.length > 0">
        <h4 class="text-xs font-semibold text-green-400 mb-2 flex items-center gap-1">
          <span>✅</span> 优点
        </h4>
        <ul class="space-y-1">
          <li
            v-for="(item, i) in analysisResult.highlights"
            :key="i"
            class="text-sm text-gray-300 bg-green-950/30 border border-green-900/30 rounded-lg px-3 py-2"
          >
            {{ item }}
          </li>
        </ul>
      </div>

      <!-- 问题 -->
      <div v-if="analysisResult.issues.length > 0">
        <h4 class="text-xs font-semibold text-red-400 mb-2 flex items-center gap-1">
          <span>⚠️</span> 存在的问题
        </h4>
        <ul class="space-y-1">
          <li
            v-for="(item, i) in analysisResult.issues"
            :key="i"
            class="text-sm text-gray-300 bg-red-950/30 border border-red-900/30 rounded-lg px-3 py-2"
          >
            {{ item }}
          </li>
        </ul>
      </div>

      <!-- 建议 -->
      <div v-if="analysisResult.suggestions.length > 0">
        <h4 class="text-xs font-semibold text-blue-400 mb-2 flex items-center gap-1">
          <span>💡</span> 改进建议
        </h4>
        <ul class="space-y-1">
          <li
            v-for="(item, i) in analysisResult.suggestions"
            :key="i"
            class="text-sm text-gray-300 bg-blue-950/30 border border-blue-900/30 rounded-lg px-3 py-2"
          >
            {{ item }}
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement AI analysis panel component"
```

---

### Task 12: 实现 ApiSettings.vue — API 配置组件

**Files:**
- Create: `src/components/ApiSettings.vue`

**Interfaces:**
- Consumes: `useDocumentStore().apiConfig`, `useDocumentStore().saveApiConfig()`, `useDocumentStore().testApiConnection()`

- [ ] **Step 1: 创建 ApiSettings.vue**

```vue
<script setup lang="ts">
import { ref } from "vue";
import { useDocumentStore } from "../stores/document";
import { storeToRefs } from "pinia";

const store = useDocumentStore();
const { apiConfig, error } = storeToRefs(store);

const testResult = ref<{ type: "success" | "failure"; message: string } | null>(null);
const testing = ref(false);

const PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "claude", label: "Anthropic Claude" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "custom", label: "自定义" },
];

const PROVIDER_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1/chat/completions",
  claude: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com",
};

function onProviderChange(value: string) {
  if (value !== "custom" && PROVIDER_URLS[value]) {
    apiConfig.value.api_url = PROVIDER_URLS[value];
  }
}

async function handleSave() {
  await store.saveApiConfig(apiConfig.value);
}

async function handleTest() {
  testing.value = true;
  testResult.value = null;
  try {
    // 先保存再测试
    await store.saveApiConfig(apiConfig.value);
    const result = await store.testApiConnection();
    testResult.value = { type: "success", message: result };
  } catch (err) {
    testResult.value = { type: "failure", message: String(err) };
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <div class="space-y-4">
    <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
      API 设置
    </h3>

    <!-- AI 提供商 -->
    <div>
      <label class="block text-xs text-gray-500 mb-1">AI 提供商</label>
      <select
        v-model="apiConfig.provider"
        class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:border-blue-500 focus:outline-none"
        @change="onProviderChange(($event.target as HTMLSelectElement).value)"
      >
        <option
          v-for="p in PROVIDERS"
          :key="p.value"
          :value="p.value"
        >
          {{ p.label }}
        </option>
      </select>
    </div>

    <!-- API 密钥 -->
    <div>
      <label class="block text-xs text-gray-500 mb-1">API 密钥</label>
      <input
        v-model="apiConfig.api_key"
        type="password"
        class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:border-blue-500 focus:outline-none"
        placeholder="sk-..."
      />
    </div>

    <!-- API 地址 -->
    <div>
      <label class="block text-xs text-gray-500 mb-1">API 地址</label>
      <input
        v-model="apiConfig.api_url"
        type="text"
        class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:border-blue-500 focus:outline-none"
      />
      <p class="text-xs text-gray-600 mt-1">
        {{ apiConfig.provider === "claude" ? "Claude 使用 /v1/messages" : "OpenAI 兼容格式 /v1/chat/completions" }}
      </p>
    </div>

    <!-- 模型 -->
    <div>
      <label class="block text-xs text-gray-500 mb-1">模型</label>
      <input
        v-model="apiConfig.model"
        type="text"
        class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:border-blue-500 focus:outline-none"
        :placeholder="apiConfig.provider === 'claude' ? 'claude-sonnet-4-20250514' : 'gpt-4o'"
      />
    </div>

    <!-- 操作按钮 -->
    <div class="flex gap-2">
      <button
        class="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
        @click="handleSave"
      >
        保存设置
      </button>
      <button
        class="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 text-sm rounded-lg transition-colors"
        :disabled="testing"
        @click="handleTest"
      >
        {{ testing ? "测试中..." : "测试连接" }}
      </button>
    </div>

    <!-- 测试结果 -->
    <div
      v-if="testResult"
      class="text-sm p-3 rounded-lg"
      :class="{
        'bg-green-950/50 border border-green-800 text-green-300': testResult.type === 'success',
        'bg-red-950/50 border border-red-800 text-red-300': testResult.type === 'failure',
      }"
    >
      <p class="whitespace-pre-wrap">{{ testResult.message }}</p>
    </div>

    <!-- 全局错误 -->
    <div
      v-if="error"
      class="text-sm text-red-400 bg-red-950/30 border border-red-900/30 rounded-lg px-3 py-2"
    >
      {{ error }}
    </div>
  </div>
</template>
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement API settings component"
```

---

### Task 13: 实现 EditorView.vue — 主页面布局

**Files:**
- Create: `src/views/EditorView.vue`

**Interfaces:**
- Consumes: 所有子组件 + useDocumentStore

- [ ] **Step 1: 创建 EditorView.vue**

```vue
<script setup lang="ts">
import { ref, onMounted } from "vue";
import Editor from "../components/Editor.vue";
import VersionList from "../components/VersionList.vue";
import DiffViewer from "../components/DiffViewer.vue";
import AIPanel from "../components/AIPanel.vue";
import ApiSettings from "../components/ApiSettings.vue";
import { useDocumentStore } from "../stores/document";
import { storeToRefs } from "pinia";

const store = useDocumentStore();
const { currentContent, currentTitle, loading, error } = storeToRefs(store);

const activeTab = ref<"versions" | "diff" | "analysis" | "settings">("versions");
const commitMsg = ref("");

onMounted(() => {
  store.initDocument();
});

async function handleCommit() {
  if (!commitMsg.value.trim()) return;
  await store.commitVersion(commitMsg.value);
  commitMsg.value = "";
}
</script>

<template>
  <div class="h-screen flex flex-col bg-gray-950 text-gray-100">
    <!-- 工具栏 -->
    <header class="flex items-center justify-between px-4 h-12 border-b border-gray-800 bg-gray-900/50 shrink-0">
      <div class="flex items-center gap-3">
        <h1 class="text-sm font-bold text-blue-400 tracking-wider">AiPen</h1>
        <span class="text-xs text-gray-600">|</span>
        <span class="text-sm text-gray-300">{{ currentTitle }}</span>
      </div>
      <div class="flex items-center gap-2">
        <!-- Commit 输入区域 -->
        <input
          v-model="commitMsg"
          type="text"
          placeholder="输入提交信息..."
          class="w-64 h-7 px-3 bg-gray-800 border border-gray-700 rounded text-xs text-gray-200 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
          @keyup.enter="handleCommit"
        />
        <button
          class="h-7 px-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs rounded transition-colors"
          :disabled="loading.commit || !commitMsg.trim()"
          @click="handleCommit"
        >
          {{ loading.commit ? "提交中..." : "提交版本" }}
        </button>
      </div>
    </header>

    <!-- 主内容区：左右分栏 -->
    <div class="flex flex-1 min-h-0">
      <!-- 左侧：编辑器 -->
      <main class="flex-1 min-w-0 border-r border-gray-800">
        <Editor v-model="currentContent" />
      </main>

      <!-- 右侧：面板区 -->
      <aside class="w-96 flex flex-col border-l border-gray-800 bg-gray-900/30 shrink-0">
        <!-- Tab 切换 -->
        <nav class="flex border-b border-gray-800">
          <button
            v-for="tab in [
              { key: 'versions', label: '版本' },
              { key: 'diff', label: 'Diff' },
              { key: 'analysis', label: 'AI 分析' },
              { key: 'settings', label: '设置' },
            ]"
            :key="tab.key"
            class="flex-1 py-2.5 text-xs font-medium transition-colors"
            :class="
              activeTab === tab.key
                ? 'text-blue-400 border-b-2 border-blue-500'
                : 'text-gray-500 hover:text-gray-300'
            "
            @click="activeTab = tab.key as typeof activeTab"
          >
            {{ tab.label }}
          </button>
        </nav>

        <!-- Tab 内容 -->
        <div class="flex-1 overflow-y-auto p-4">
          <!-- 全局错误 -->
          <div
            v-if="error"
            class="mb-3 text-sm text-red-400 bg-red-950/30 border border-red-900/30 rounded-lg px-3 py-2"
          >
            {{ error }}
            <button class="ml-2 text-xs underline hover:text-red-300" @click="store.error = ''">
              关闭
            </button>
          </div>

          <VersionList v-if="activeTab === 'versions'" />
          <DiffViewer v-if="activeTab === 'diff'" />
          <AIPanel v-if="activeTab === 'analysis'" />
          <ApiSettings v-if="activeTab === 'settings'" />
        </div>
      </aside>
    </div>

    <!-- 状态栏 -->
    <footer class="flex items-center justify-between px-4 h-7 border-t border-gray-800 bg-gray-900/50 shrink-0">
      <div class="flex items-center gap-3 text-xs text-gray-600">
        <span v-if="currentContent">
          字数: {{ currentContent.length }}
        </span>
      </div>
      <div class="flex items-center gap-2 text-xs text-gray-600">
        <span v-if="loading.init" class="text-blue-400">初始化中...</span>
      </div>
    </footer>
  </div>
</template>
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: implement main editor view layout"
```

---

### Task 14: 组装 App.vue + main.ts + 样式

**Files:**
- Modify: `src/App.vue`
- Modify: `src/main.ts`
- Modify: `src/styles/main.css`

- [ ] **Step 1: 更新 main.ts**

```typescript
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./styles/main.css";

const app = createApp(App);
app.use(createPinia());
app.mount("#root");
```

- [ ] **Step 2: 更新 App.vue**

```vue
<script setup lang="ts">
import EditorView from "./views/EditorView.vue";
</script>

<template>
  <EditorView />
</template>
```

- [ ] **Step 3: 更新 main.css**

```css
@import "tailwindcss";

/* 自定义滚动条 */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: #374151;
  border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
  background: #4b5563;
}

/* 确保 Milkdown 编辑区填满 */
.milkdown {
  min-height: 100%;
}

/* 编辑器占位符样式 */
.milkdown .editor-empty::before {
  content: "开始写作...";
  color: #6b7280;
  font-style: italic;
}
```

- [ ] **Step 4: 编译验证**

```bash
cd src-tauri && cargo check
cd .. && npx vue-tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: assemble app entry point and styles"
```

---

### Task 15: 端到端集成验证

**Files:**
- 无新文件，验证所有模块协同工作

- [ ] **Step 1: 构建应用**

```bash
npm run tauri build -- --no-bundle
```

预期结果：编译成功，生成可执行文件。

- [ ] **Step 2: 手动验证核心流程**

1. 启动应用 → 自动创建默认文档
2. 在 Milkdown 编辑器中输入内容
3. 提交版本 v1（输入提交信息，点击"提交版本"）
4. 继续编辑，提交版本 v2
5. 在右侧"版本"Tab 中看到两个版本
6. 点击选择 v1（旧版），再点击选择 v2（新版）
7. 切换到"Diff"Tab → 点击"对比 Diff" → 看到差异高亮
8. 切换到"AI 分析"Tab → 点击分析按钮 → 看到分析结果
9. 切换到"设置"Tab → 配置 API → 测试连接

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: complete end-to-end integration"
```
