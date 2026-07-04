# AiPen — AI 辅助公文写作桌面应用

<p align="center">
  <img src="public/WJH.png" alt="AiPen 截图" width="720" />
</p>

<p align="center">
  <strong>专为中文公文写作深度定制的 AI 协作工具</strong><br>
  提问采集 → 提纲生成 → 正文撰写 → 质量审查 → 润色定稿，五阶段流水线一站完成
</p>

<p align="center">
  <a href="#-下载安装"><img src="https://img.shields.io/badge/platform-Windows-blue.svg" /></a>
  <a href="https://github.com/jason3723/AiPen/releases/latest"><img src="https://img.shields.io/github/v/release/jason3723/AiPen" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Proprietary-red.svg" /></a>
</p>

---

## 为什么选择 AiPen？

AiPen **不是** ChatGPT 套壳。它是为机关、企事业单位公文写作者量身打造的**完整 AI 协作写作工作流**。

| 维度 | 普通 AI 聊天工具 | AiPen |
|------|-----------------|-------|
| 工作方式 | 一问一答，零散对话 | 五阶段结构化流水线 |
| 文种支持 | 需自行设计提示词 | 10 种内置菜谱，每种有专属调查问卷 |
| 质量控制 | 无系统审查 | 逻辑 / 语法 / 规范 triple 审查 |
| 版本管理 | 无 | 完整历史记录 + Diff 对比 + 一键回退 |
| 排版导出 | 手动排版 | 一键按公文规范导出 Word |
| 知识沉淀 | 无 | 知识库 + 素材库，AI 写作时自动调用 |

---

## 核心功能

### 📝 五阶段智能写作流水线

1. **Interview 问答采集** — 按文种定制问题，AI 引导你梳理写作要素
2. **Outline 提纲生成** — 自动生成结构化提纲，支持风格随机与层级编辑
3. **Generate 正文撰写** — 流式输出正文，逐段生成可随时调整
4. **Review 质量审查** — 逻辑一致性、语法规范、格式标准三重审查
5. **Polish 润色定稿** — 语言润色、语气统一、格式打磨

### 📋 内置 10 种公文菜谱

工作报告 · 讲话稿 · 汇报材料 · 调研报告 · 通知公告 · 规章制度 · 计划总结 · 请示批复 · 会议纪要 · 简报信息

### ✍️ 专业富文本编辑器

基于 **TipTap**（ProseMirror），支持真实 Word 排版体验：
- 字体 / 字号 / 颜色 / 加粗 / 斜体 / 下划线 / 删除线
- 上标 / 下标 / 高亮 / 对齐 / 缩进 / 列表
- 表格插入编辑 · 图片插入 · 链接 · 查找替换
- 深色 / 浅色双主题，无白闪启动

### 📚 素材库与知识库

- **素材库**：摘录、收集、整理写作素材，拖拽即可插入正文
- **知识库**：上传 .docx 作为 AI 参考背景，写作时自动引用
- 支持文件夹分类与标签管理

### 🔄 版本管理与 Diff 对比

- 每次保存自动创建版本快照
- 任意两个版本可视化 Diff（增删改着色标注）
- 一键回退到历史版本

### 🤖 AI 技能系统

- 内置 20+ 可组合 AI 技能（扩写、缩写、改写、润色、翻译……）
- 自由编排技能组合（串联），一次执行多条指令
- 支持选区处理与全文处理双模式

### 📤 Word 导出

- 自定义排版设置（字体、字号、页边距、行距、首行缩进）
- 一键导出规范 .docx，符合公文格式标准

### 🌐 内嵌浏览器

集成网页浏览与内容剪藏，写作时不离开应用

---

## 🚀 下载安装

前往 [Releases](https://github.com/jason3723/AiPen/releases/latest) 下载最新版本 `AiPen_x64-setup.exe`。

> **系统要求**：Windows 10 1803+ (x64)

安装后按以下步骤开始使用：

1. 注册 [DeepSeek 开放平台](https://platform.deepseek.com) 账号并实名认证
2. 充值（建议 10~50 元，价格低廉，几十元可生成大量文本）
3. 创建 API Key，填入 AiPen 设置面板
4. 打开内置「📖 AiPen 使用手册」文档，跟随教程开始写作

---

## 🛠️ 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | **[Tauri v2](https://v2.tauri.app/)** (Rust) |
| 前端框架 | **Vue 3** (Composition API) |
| 类型系统 | **TypeScript** (strict) |
| 编辑器 | **TipTap** (ProseMirror) |
| 状态管理 | **Pinia** |
| 样式方案 | **Tailwind CSS v4** |
| AI 引擎 | **DeepSeek API** |
| Word 导出 | **docx.js** |
| 打包分发 | **NSIS** (Windows Installer) |

---

## 🧑‍💻 本地开发

### 前置要求

- **Node.js** ≥ 18
- **Rust** 工具链（[rustup](https://rustup.rs/)）
- **pnpm** 或 npm

### 启动

```bash
# 克隆
git clone https://github.com/jason3723/AiPen.git
cd AiPen

# 安装依赖
npm install

# 启动开发服务器
npm run tauri dev
```

### 构建

```bash
npm run tauri build
```

产物位于 `src-tauri/target/release/bundle/nsis/`。

---

## 📖 文档

- **[完整使用手册](docs/USER_GUIDE.md)** — 安装后也会作为内置文档自动创建
- **[更新日志](docs/CHANGELOG.md)** — 每个版本的详细变更

---

## 📄 许可证

本软件为专有软件。保留所有权利。

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/jason3723">jason3723</a>
</p>
