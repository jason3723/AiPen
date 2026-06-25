Tauri 文档版本管理与 AI 分析应用 - 开发需求文档
1. 项目概述
开发一个基于 Tauri 的桌面端文档编辑与管理应用。核心目标是在提供优秀写作体验（类似新华妙笔）的基础上，增加 Git 风格的版本管理、多版本 Diff 比对，并接入 LLM API 对修改之处进行优缺点分析及建议。

核心功能
文档编辑：基于 Markdown 的所见即所得编辑器。
版本控制：类似 Git 的 Commit 机制，记录每次重大更新的快照。
版本比对：任意两个版本之间的内容 Diff（新增/删除行高亮）。
AI 分析：将旧版、新版及 Diff 结果发送给 LLM，分析修改的优缺点并提供改进建议。
本地存储：所有数据保存在本地 SQLite 及文件系统中，保证数据隐私。
2. 技术栈
前端：Vue 3 + TypeScript + Vite + TailwindCSS
编辑器：Milkdown (基于 ProseMirror)
后端：Rust (Tauri 2.x)
数据库：SQLite (通过 sqlx 库)
Diff 算法：similar (Rust)
HTTP 客户端：reqwest (用于调用 LLM API)
3. 项目目录结构
doc-version-manager/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs           # Tauri 入口
│   │   ├── db.rs             # SQLite 初始化及基础 CRUD
│   │   ├── commands.rs       # 暴露给前端的 Tauri Commands
│   │   ├── version.rs        # 版本管理逻辑
│   │   ├── diff.rs           # 文本 Diff 逻辑
│   │   └── ai.rs             # LLM API 调用与 Prompt
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/
│   ├── components/
│   │   ├── Editor.vue        # Milkdown 编辑器封装
│   │   ├── DiffViewer.vue    # Diff 结果展示组件
│   │   ├── VersionList.vue   # 版本历史列表
│   │   └── AIPanel.vue       # AI 分析结果展示面板
│   ├── views/
│   │   └── EditorView.vue    # 主编辑页面
│   ├── stores/
│   │   └── document.ts       # Pinia 状态管理
│   ├── App.vue
│   └── main.ts
├── package.json
└── vite.config.ts

4. 数据库设计
使用 SQLite 存储元数据和版本内容。


-- 文档表
CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    project_id  TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 版本快照表
CREATE TABLE IF NOT EXISTS versions (
    id          TEXT PRIMARY KEY,
    doc_id      TEXT NOT NULL,
    version_num INTEGER NOT NULL,
    commit_msg  TEXT,
    content     TEXT NOT NULL,       -- 完整内容快照
    parent_id   TEXT,                -- 父版本 ID
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (doc_id) REFERENCES documents(id)
);

-- AI 分析结果表
CREATE TABLE IF NOT EXISTS ai_analysis (
    id          TEXT PRIMARY KEY,
    version_id  TEXT NOT NULL,       -- 新版本的 ID
    analysis    TEXT NOT NULL,       -- JSON 字符串: {highlights, issues, suggestions}
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
5. Rust 后端核心实现
5.1 依赖配置 (Cargo.toml)

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sqlx = { version = "0.7", features = ["sqlite", "runtime-tokio"] }
similar = "2.4"
reqwest = { version = "0.12", features = ["json"] }
tokio = { version = "1", features = ["full"] }
uuid = { version = "1", features = ["v4"] }
chrono = "0.4"
5.2 Diff 算法 (diff.rs)
使用 similar 库对比文本，返回结构化的 Diff 结果供前端渲染。


use similar::{ChangeTag, TextDiff};
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct DiffHunk {
    tag: String,      // "equal" | "insert" | "delete"
    content: String,
}

#[derive(Serialize)]
pub struct DiffResult {
    hunks: Vec<DiffHunk>,
    additions: usize,
    deletions: usize,
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

    DiffResult { hunks, additions, deletions }
}
5.3 AI 分析模块 (ai.rs)
调用 LLM API 分析修改内容，使用 JSON 模式要求模型返回固定格式。


use reqwest::Client;
use serde::{Deserialize, Serialize};
use crate::diff::DiffResult;

#[derive(Debug, Serialize, Deserialize)]
pub struct AIAnalysis {
    highlights: Vec<String>,
    issues: Vec<String>,
    suggestions: Vec<String>,
}

pub async fn analyze_revision(
    old_content: &str,
    new_content: &str,
    diff: &DiffResult,
    api_key: &str,
) -> Result<AIAnalysis, String> {
    let prompt = format!(
        r#"你是一位资深编辑。请分析以下文档修改：

## 修改前
{old}

## 修改后
{new}

## 修改摘要
新增 {add} 处，删除 {del} 处

请以严格JSON格式返回分析结果：
{{
  "highlights": ["优点1", "优点2"],
  "issues": ["不足1", "不足2"],
  "suggestions": ["建议1", "建议2"]
}}"#,
        old = old_content, new = new_content, add = diff.additions, del = diff.deletions
    );

    let client = Client::new();
    // 这里以 OpenAI 为例，可替换为其他兼容 API
    let resp = client.post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&serde_json::json!({
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": prompt}],
            "response_format": {"type": "json_object"}
        }))
        .send().await.map_err(|e| e.to_string())?;

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let content_str = json["choices"][0]["message"]["content"].as_str().ok_or("Invalid API response")?;
    
    let analysis: AIAnalysis = serde_json::from_str(content_str).map_err(|e| e.to_string())?;
    Ok(analysis)
}
5.4 Tauri 命令 (commands.rs)
暴露给前端调用的接口：


use crate::{db, version, diff, ai};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
pub struct Version {
    id: String,
    doc_id: String,
    version_num: i64,
    commit_msg: String,
    content: String,
    created_at: String,
}

#[tauri::command]
pub async fn save_document(doc_id: String, title: String, content: String) -> Result<(), String> {
    // 实现保存逻辑
    Ok(())
}

#[tauri::command]
pub async fn commit_version(doc_id: String, content: String, commit_msg: String) -> Result<Version, String> {
    // 实现版本提交逻辑，将内容写入 versions 表
    todo!()
}

#[tauri::command]
pub async fn get_versions(doc_id: String) -> Result<Vec<Version>, String> {
    // 获取该文档的所有历史版本
    todo!()
}

#[tauri::command]
pub async fn get_diff(old_version_id: String, new_version_id: String) -> Result<diff::DiffResult, String> {
    let old = db::get_version_content(&old_version_id).await.map_err(|e| e.to_string())?;
    let new = db::get_version_content(&new_version_id).await.map_err(|e| e.to_string())?;
    Ok(diff::diff_documents(&old, &new))
}

#[tauri::command]
pub async fn analyze_revision(old_version_id: String, new_version_id: String, api_key: String) -> Result<ai::AIAnalysis, String> {
    let old = db::get_version_content(&old_version_id).await.map_err(|e| e.to_string())?;
    let new = db::get_version_content(&new_version_id).await.map_err(|e| e.to_string())?;
    let diff_result = diff::diff_documents(&old, &new);
    ai::analyze_revision(&old, &new, &diff_result, &api_key).await
}
6. 前端核心实现
6.1 Milkdown 编辑器封装 (Editor.vue)
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
  <Milkdown class="prose max-w-none" />
</template>
6.2 Diff 展示组件 (DiffViewer.vue)
<script setup lang="ts">
defineProps<{
  hunks: { tag: string; content: string }[]
}>()
</script>

<template>
  <div class="font-mono text-sm border rounded-md overflow-hidden">
    <div v-for="(hunk, i) in hunks" :key="i" 
         :class="['px-2 py-0.5 whitespace-pre-wrap', 
                   hunk.tag === 'insert' ? 'bg-green-100 text-green-800' : 
                   hunk.tag === 'delete' ? 'bg-red-100 text-red-800' : '']">
      <span class="select-none mr-2 opacity-50">
        {{ hunk.tag === 'insert' ? '+' : hunk.tag === 'delete' ? '-' : ' ' }}
      </span>
      {{ hunk.content }}
    </div>
  </div>
</template>
6.3 主页面逻辑 (EditorView.vue)
负责协调编辑器、版本列表和 AI 面板。
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import Editor from '../components/Editor.vue'
import DiffViewer from '../components/DiffViewer.vue'

const content = ref('')
const versions = ref<any[]>([])
const diffResult = ref<any>(null)
const aiAnalysis = ref<any>(null)

// 选中的对比版本
const oldVersionId = ref('')
const newVersionId = ref('')

// 提交当前版本
async function handleCommit() {
  const msg = prompt('请输入版本提交信息') // 实际项目用 UI 弹窗
  if (!msg) return
  await invoke('commit_version', { docId: 'doc-1', content: content.value, commitMsg: msg })
  await loadVersions()
}

// 获取 Diff
async function handleGetDiff() {
  diffResult.value = await invoke('get_diff', {
    oldVersionId: oldVersionId.value,
    newVersionId: newVersionId.value
  })
}

// 获取 AI 分析
async function handleAnalyze() {
  aiAnalysis.value = await invoke('analyze_revision', {
    oldVersionId: oldVersionId.value,
    newVersionId: newVersionId.value,
    apiKey: 'YOUR_API_KEY' // 实际应从设置中读取
  })
}

async function loadVersions() {
  versions.value = await invoke('get_versions', { docId: 'doc-1' })
}

onMounted(loadVersions)
</script>

<template>
  <div class="flex h-screen">
    <!-- 左侧：编辑器 -->
    <div class="flex-1 p-4 border-r overflow-auto">
      <button @click="handleCommit" class="mb-2 px-4 py-1 bg-blue-500 text-white rounded">Commit 版本</button>
      <Editor v-model="content" />
    </div>

    <!-- 右侧：版本与分析面板 -->
    <div class="w-1/3 p-4 overflow-auto bg-gray-50">
      <h3 class="font-bold mb-2">版本历史</h3>
      <select v-model="oldVersionId" class="block w-full mb-2 p-1 border">
        <option v-for="v in versions" :value="v.id" :key="v.id">v{{ v.version_num }}: {{ v.commit_msg }}</option>
      </select>
      <select v-model="newVersionId" class="block w-full mb-2 p-1 border">
        <option v-for="v in versions" :value="v.id" :key="v.id">v{{ v.version_num }}: {{ v.commit_msg }}</option>
      </select>
      
      <button @click="handleGetDiff" class="px-3 py-1 bg-gray-800 text-white text-sm rounded mr-2">对比 Diff</button>
      <button @click="handleAnalyze" class="px-3 py-1 bg-purple-600 text-white text-sm rounded">AI 分析</button>

      <div v-if="diffResult" class="mt-4">
        <h3 class="font-bold mb-2">Diff 结果 (+{{diffResult.additions}} / -{{diffResult.deletions}})</h3>
        <DiffViewer :hunks="diffResult.hunks" />
      </div>

      <div v-if="aiAnalysis" class="mt-4 p-3 bg-white rounded shadow">
        <h3 class="font-bold mb-2 text-purple-700">AI 修改分析</h3>
        <p class="text-xs font-bold text-green-600">优点：</p>
        <ul class="list-disc ml-5 text-xs mb-2">
          <li v-for="(h, i) in aiAnalysis.highlights" :key="i">{{ h }}</li>
        </ul>
        <p class="text-xs font-bold text-red-600">不足：</p>
        <ul class="list-disc ml-5 text-xs mb-2">
          <li v-for="(iss, i) in aiAnalysis.issues" :key="i">{{ iss }}</li>
        </ul>
        <p class="text-xs font-bold text-blue-600">建议：</p>
        <ul class="list-disc ml-5 text-xs">
          <li v-for="(s, i) in aiAnalysis.suggestions" :key="i">{{ s }}</li>
        </ul>
      </div>
    </div>
  </div>
</template>
7. 开发步骤建议 (供 Agent 执行)
初始化项目：使用 npm create tauri-app@latest 创建 Vue + Rust 项目。
配置 Rust 依赖：在 src-tauri/Cargo.toml 中添加上述所有依赖。
实现数据库层：编写 db.rs，实现 SQLite 的初始化、建表以及基础的 CRUD 查询函数。
实现 Diff 与 AI 逻辑：编写 diff.rs 和 ai.rs，可直接复用上述代码。
实现 Tauri Commands：在 commands.rs 中组装逻辑，并在 main.rs 的 invoke_handler 中注册所有命令。
安装前端依赖：npm install @milkdown/vue @milkdown/core @milkdown/preset-commonmark @milkdown/plugin-listener pinia。
构建前端界面：按照上述 Vue 组件代码实现编辑器和右侧面板。
打通数据流：确保前端 invoke 能正确调用 Rust 命令，完成“编辑 -> 提交 -> 对比 -> 分析”的闭环。