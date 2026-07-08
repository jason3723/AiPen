<p align="center">
  <img src="icon.png" alt="AiPen LOGO" width="192" />
</p>

<h1 align="center">AiPen</h1>
<p align="center">
  <strong>✨ AI 驱动的中文公文写作工作站</strong><br>
  <sub>问 — 纲 — 写 — 审 — 润，五阶流水线，一站定稿</sub>
</p>

<p align="center">
  <a href="#-下载安装"><img src="https://img.shields.io/badge/🪟_Windows-10_1803+-blue.svg" /></a>
  <a href="https://github.com/jason3723/AiPen/releases/latest"><img src="https://img.shields.io/github/v/release/jason3723/AiPen?color=%238b5cf6" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Proprietary-red.svg" /></a>
  <a href="#-技术栈"><img src="https://img.shields.io/badge/Tauri-v2-ffc131?logo=tauri" /></a>
  <a href="#-技术栈"><img src="https://img.shields.io/badge/Vue-3-4fc08d?logo=vuedotjs" /></a>
</p>

---

## 🤔 为什么是 AiPen？

AiPen **不是**又一个 AI 聊天窗口。它是专为机关、企事业单位写作者打造的**端到端 AI 协作写作引擎**——把"套提示词→复制粘贴→手动排版"的低效流程，变成一条一气呵成的自动化流水线。

<table>
  <tr>
    <th width="160">🧩 维度</th>
    <th width="230">💬 普通 AI 对话</th>
    <th width="230">🚀 AiPen</th>
  </tr>
  <tr>
    <td><strong>写作流程</strong></td>
    <td>一问一答，来回试探提示词</td>
    <td>五阶段流水线，按步骤推进</td>
  </tr>
  <tr>
    <td><strong>文种适配</strong></td>
    <td>每次手写 prompt，效果靠运气</td>
    <td>10 种内置菜谱，每种有专属问卷引导</td>
  </tr>
  <tr>
    <td><strong>质量管控</strong></td>
    <td>无系统审查，全靠自己校</td>
    <td>逻辑 · 语法 · 规范 三重 AI 审查</td>
  </tr>
  <tr>
    <td><strong>版控追溯</strong></td>
    <td>无</td>
    <td>自动快照 + 可视化 Diff + 一键回退</td>
  </tr>
  <tr>
    <td><strong>导出排版</strong></td>
    <td>手动调格式</td>
    <td>一键导出规范 .docx，符合公文标准</td>
  </tr>
  <tr>
    <td><strong>知识沉淀</strong></td>
    <td>无</td>
    <td>知识库 + 素材库，AI 写作时自动引用</td>
  </tr>
</table>

---

## ✨ 核心功能

### 🧭 五阶段智能写作流水线

| 阶段 | 做什么 | 怎么帮 |
|:---:|------|------|
| **❶ Interview** | 📋 问答采集 | 按文种定制问卷，AI 引导你理清写作要素 |
| **❷ Outline** | 🗂️ 提纲生成 | 自动生成多级提纲，风格随机、层级自由编辑 |
| **❸ Generate** | ✍️ 正文撰写 | 流式逐段输出，随时暂停调整方向 |
| **❹ Review** | 🔍 质量审查 | 逻辑一致性 + 语法规范 + 格式标准 三重把关 |
| **❺ Polish** | 💎 润色定稿 | 语言润色、语气统一、格式精修 |

### 📋 10 种内置公文菜谱

<p align="center">
  <code>📊 工作报告</code> &nbsp; <code>🎤 讲话稿</code> &nbsp; <code>📈 汇报材料</code> &nbsp; <code>🔬 调研报告</code> &nbsp; <code>📢 通知公告</code><br>
  <code>📜 规章制度</code> &nbsp; <code>📅 计划总结</code> &nbsp; <code>📨 请示批复</code> &nbsp; <code>📝 会议纪要</code> &nbsp; <code>📰 简报信息</code>
</p>

> 💡 每种菜谱都配有一套专属的 AI 引导问卷——你不用学 prompt engineering，AI 来问你。

### ✍️ 专业富文本编辑器

基于 **TipTap** / ProseMirror 内核，贴近 Word 习惯：

| 🎨 文字样式 | 📐 段落排版 | 📎 富媒体 |
|:---|:---|:---|
| 字体 · 字号 · 颜色 | 对齐 · 缩进 · 行距 | 📊 表格 |
| **B** 粗 · *I* 斜 · <u>U</u> 下划线 · ~~S~~ 删除 | 有序/无序列表 | 🖼️ 图片 |
| 上标 · 下标 · 高亮 | 首行缩进 | 🔗 超链接 |
| 批注内联高亮 | 深色/浅色双主题 | 🔎 查找替换 |

### 💬 批注系统

- 🖊️ 选中任意文字即写批注，侧栏统一查阅
- 🏷️ 正文内联高亮标记，不干扰原文排版
- 💾 批注独立存储，导出 Word 时可自由选择是否保留

### 🔎 全局搜索

- 🌐 跨文档 + 素材库全文检索，**jieba 分词 + FTS 全文索引**
- ⚡ 毫秒级响应，精准命中关键词
- 🎯 搜索结果一键跳转到文档对应位置

### 📚 素材库 & 知识库

| | 📥 素材库 | 🧠 知识库 |
|:---|:---|:---|
| 用途 | 收集、整理写作片段 | 上传 .docx 作为 AI 参考背景 |
| 使用 | 拖拽插入正文 | 写作时自动引用 |
| 管理 | 标签分类 + 文件夹 | 文件夹管理 |

### 🔄 版本管理 & Diff

- 💿 每次保存自动生成版本快照
- 🎨 任意两版本可视化 Diff（增/删/改 着色标注）
- ⏪ 一键回退到任意历史版本

### 🤖 AI 技能组合系统

- 🧰 内置 **20+** 可组合 AI 技能：扩写 · 缩写 · 改写 · 润色 · 翻译 · 总结 · ……
- 🔗 自由串联多个技能，一次执行多条指令
- 🎯 选区处理 / 全文处理 双模式切换

### 📤 Word 导出

- ⚙️ 自定义排版：字体、字号、页边距、行距、首行缩进
- 📄 一键导出标准 .docx，符合党政机关公文格式
- 📎 支持图片内嵌（WebP / SVG 自动转 PNG）

### 🌐 内嵌浏览器

- 🧭 内置 WebView 浏览器，写作时不用切窗口
- ✂️ 网页右键剪藏文字 → 一键存入素材库

---

## 🚀 下载安装

<p align="center">
  <a href="https://github.com/jason3723/AiPen/releases/latest">
    <img src="https://img.shields.io/badge/⬇️_下载最新版-AiPen_x64--setup.exe-8b5cf6?style=for-the-badge" />
  </a>
</p>

> 🪟 **系统要求**：Windows 10 1803+（64 位）

**🔑 三步上手：**

| 步骤 | 操作 |
|:---:|------|
| **1** | 注册 [DeepSeek 开放平台](https://platform.deepseek.com) 账号并实名认证 |
| **2** | 充值（ 💰 建议 10~50 元，API 单价极低，几十元足够生成海量文本） |
| **3** | 创建 API Key → 填入 AiPen 设置面板 → 打开内置「📖 AiPen 使用手册」开始写作 |

---

## 🛠️ 技术栈

| 🔧 层级 | 🧱 技术选型 | 💬 说明 |
|:---|:---|:---|
| 🏗️ 桌面框架 | **Tauri v2**（Rust） | 轻量、安全、系统级能力 |
| 🎨 前端框架 | **Vue 3**（Composition API） | 响应式 UI，组件化开发 |
| 📝 编辑器 | **TipTap**（ProseMirror） | 专业富文本编辑内核 |
| 🧠 AI 引擎 | **DeepSeek API** | 高性价比中文大模型 |
| 🗃️ 状态管理 | **Pinia** | Vue 3 官方状态库 |
| 🎀 样式方案 | **Tailwind CSS v4** | 原子化 CSS，深浅主题 |
| 📄 Word 导出 | **docx.js** | 纯 JS 生成 .docx |
| 📦 打包分发 | **NSIS** | Windows 原生安装包 |

---

## 🧑‍💻 本地开发

```bash
# 📥 克隆仓库
git clone https://github.com/jason3723/AiPen.git && cd AiPen

# 📦 安装依赖
npm install

# 🚧 启动开发模式（热更新）
npm run tauri dev

# 🏗️ 构建生产包
npm run tauri build
# → 产物在 src-tauri/target/release/bundle/nsis/
```

> ⚙️ **前置要求**：Node.js ≥ 18 · Rust 工具链（[rustup](https://rustup.rs/)） · npm / pnpm

---

## 📖 文档

| 📑 文档 | 📌 说明 |
|:---|:---|
| [完整使用手册](docs/USER_GUIDE.md) | 安装后自动创建为内置文档 |
| [更新日志](docs/CHANGELOG.md) | 每个版本的详细变更记录 |

---

<p align="center">
  <sub>© 2026 AiPen · 专有软件 · 保留所有权利</sub><br><br>
  <strong>🧡 Made by <a href="https://github.com/jason3723">jason3723</a></strong>
</p>
