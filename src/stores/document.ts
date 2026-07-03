import { defineStore } from "pinia";
import { ref, computed, watch, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { textToDocJson } from "../utils/textToDocJson";
import { useExportSettingsStore } from "./exportSettings";


// ─── 类型定义 ────────────────────────────────────────────────

export interface Document {
  id: string;
  title: string;
  project_id: string;
  folder_name?: string;
  export_settings: string;
  created_at: string;
  updated_at: string;
}

export interface Folder {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
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

export interface InlineChange {
  tag: "equal" | "insert" | "delete";
  content: string;
}

export interface DiffHunk {
  tag: "equal" | "insert" | "delete";
  content: string;
  inline_changes?: InlineChange[];
}

export interface DiffResult {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface OverallAssessment {
  verdict: string;
  summary: string;
  score_old: string;
  score_new: string;
  delta: string;
}

export interface IdeologicalAnalysis {
  elevation: string;
  positioning: string;
  depth: string;
  risk: string;
}

export interface LogicAnalysis {
  strengths: string[];
  weaknesses: string[];
}

export interface InsightAnalysis {
  added_value: string[];
  hollow_parts: string[];
}

export interface ExpressionAnalysis {
  highlights: string[];
  issues: string[];
}

export interface ModificationBreakdown {
  type: string;
  example: string;
  reason: string;
}

export interface RevisionSuggestion {
  target: string;
  advice: string;
  rationale: string;
  priority: string;
  category: string;
}

export interface DimensionScore {
  name: string;
  score: number;
  comment: string;
}

export interface DocumentScore {
  total_score: number;
  encouragement: string;
  dimensions: DimensionScore[];
  top_suggestion: string;
}

export interface AIAnalysis {
  overall_assessment: OverallAssessment;
  ideological_analysis: IdeologicalAnalysis;
  logic_analysis: LogicAnalysis;
  insight_analysis: InsightAnalysis;
  expression_analysis: ExpressionAnalysis;
  modification_breakdown: ModificationBreakdown[];
  comparison: string[];
  revision_suggestions: RevisionSuggestion[];
}

export interface AIConfig {
  api_key: string;
  api_url: string;
  model: string;
  thinking_enabled: boolean;
  reasoning_effort: string;  // "high" | "max"
}

// ─── 工具函数 ────────────────────────────────────────────────

/** 从 DB 加载 ProseMirror JSON 内容（兼容旧 markdown 格式自动转换） */
function parseContent(raw: string | null | undefined): any {
  if (!raw) return { type: "doc", content: [] }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.type === 'doc') {
      return parsed
    }
  } catch {
    // JSON 解析失败，说明是旧 markdown 格式
  }
  // 非 ProseMirror JSON → 按 markdown 规则转换为 doc
  console.warn("[parseContent] 非 ProseMirror JSON 格式，自动转换为 doc:", raw.slice(0, 80))
  return textToDocJson(raw)
}

/** 序列化内容用于存储：ProseMirror JSON 对象 → JSON 字符串 */
function serializeContent(content: any): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content // 向后兼容（不应出现）
  return JSON.stringify(content)
}

function formatTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// ─── Store ───────────────────────────────────────────────────

export const useDocumentStore = defineStore("document", () => {
  // ── 文档列表状态 ──
  const documents = ref<Document[]>([]);
  const currentDocId = ref("");
  const currentTitle = ref("新文档");
  /** 当前文档内容（ProseMirror JSON 文档模型——编辑器原生格式） */
  const currentContent = ref<any>({ type: "doc", content: [] });
  const draftLoaded = ref(false); // 标记草稿是否已从数据库恢复

  // ── 文件夹状态 ──
  const folders = ref<Folder[]>([]);
  const currentFolderFilter = ref<string>("all"); // "all" | folder_id

  // ── 计算：筛选后的文档列表 ──
  const filteredDocuments = computed(() => {
    if (currentFolderFilter.value === "all") return documents.value;
    return documents.value.filter(d => d.project_id === currentFolderFilter.value);
  });

  // ── 版本状态 ──
  const versions = ref<Version[]>([]);
  const selectedOldVersionId = ref("");
  const selectedNewVersionId = ref("");
  const viewingVersionId = ref(""); // 正在查看的历史版本 ID

  // ── Diff 状态 ──
  const diffResult = ref<DiffResult | null>(null);

  // ── AI 分析状态 ──
  const analysisResult = ref<AIAnalysis | null>(null);

  // ── 文档评分状态 ──
  const documentScores = ref<Record<string, DocumentScore>>({});
  const scoreLoading = ref(false);
  /** 当前评分上下文 key：draft → doc_{docId}_draft，版本 → {versionId} */
  const scoreContextKey = computed(() => {
    if (!currentDocId.value) return '';
    if (viewingVersionId.value) return viewingVersionId.value;
    return `doc_${currentDocId.value}_draft`;
  });
  const documentScore = computed(() => {
    const key = scoreContextKey.value;
    return key ? (documentScores.value[key] ?? null) : null;
  });

  // ── API 配置 ──
  const apiConfig = ref<AIConfig>({
    api_key: "",
    api_url: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    thinking_enabled: false,
    reasoning_effort: "high",
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
  const sidebarTab = ref<"docs" | "versions" | "diff" | "analysis" | "chat" | "skills" | "compose" | "knowledge" | "settings">("versions");
  const dataVersion = ref(0); // 数据导入后 +1，触发知识库/技能列表刷新

  // ── AI 对话 & 技能：跨组件通信 ──
  const injectedChatText = ref(""); // 从编辑器右键添加到 AI 对话的文本

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

  /** 正在查看的历史版本标签 */
  const viewingVersionLabel = computed(() => {
    if (!viewingVersionId.value) return "";
    const v = versions.value.find((v) => v.id === viewingVersionId.value);
    if (!v) return "";
    return v.commit_msg ? `v${v.version_num}: ${v.commit_msg}` : `v${v.version_num}`;
  });

  /** 当前是否在查看历史版本（而非最新草稿） */
  const isViewingHistory = computed(() => viewingVersionId.value !== "");

  // ── 自动保存草稿（防抖 1 秒） ──
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let _suppressDraftSave = false; // 阻止程序化 content 变更触发自动保存

  /** 自动保存状态：idle(无变更) | pending(等待防抖) | saving(写入中) | saved(已保存) | error(失败) */
  const draftSaveStatus = ref<"idle" | "pending" | "saving" | "saved" | "error">("idle");
  /** 最后一次保存成功的时间文本，格式如 "23:10" */
  const lastSaveTime = ref("");

  /** 封装 suppressDraftSave 模式，防止新增函数遗漏标志设置 */
  async function withSuppressDraftSave<T>(fn: () => Promise<T>): Promise<T> {
    _suppressDraftSave = true;
    try {
      return await fn();
    } finally {
      await nextTick();
      _suppressDraftSave = false;
    }
  }

  watch(currentContent, (newVal) => {
    if (!currentDocId.value || !draftLoaded.value) {
      draftSaveStatus.value = "idle";
      return;
    }

    // 程序化加载内容（查看历史、恢复草稿等）时不触发自动保存
    if (_suppressDraftSave) {
      draftSaveStatus.value = "idle";
      return;
    }

    // 查看历史版本时编辑器只读，不应收到用户编辑事件；保险起见不保存
    if (viewingVersionId.value) return;

    // 内容变更 → 进入等待防抖状态
    draftSaveStatus.value = "pending";

    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(async () => {
      draftSaveStatus.value = "saving";
      try {
        await invoke("save_draft", {
          docId: currentDocId.value,
          content: serializeContent(newVal),
        });
        draftSaveStatus.value = "saved";
        const now = new Date();
        lastSaveTime.value =
          String(now.getHours()).padStart(2, "0") + ":" +
          String(now.getMinutes()).padStart(2, "0") + ":" +
          String(now.getSeconds()).padStart(2, "0");
      } catch {
        draftSaveStatus.value = "error";
      }
    }, 1000);
  });

  // ── 操作 ──

  /** 初始化：列出已有文档或创建新文档 */
  async function initDocument() {
    loading.value.init = true;
    error.value = "";
    try {
      await loadApiConfig();
      await loadFolders();
      const docs = await invoke<Document[]>("list_documents");

      if (docs.length > 0) {
        documents.value = docs;
        // 自动加载最近更新的文档
        const latest = documents.value[0];
        await switchDocument(latest.id);
      } else {
        // 创建第一个文档
        await createNewDocument();
      }
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value.init = false;
    }
  }

  /** 仅刷新文档列表，不切换文档 */
  async function reloadDocuments() {
    try {
      await loadFolders();
      const docs = await invoke<Document[]>("list_documents");
      documents.value = docs;
    } catch (err) {
      console.error("刷新文档列表失败:", err);
    }
  }

  // ── 文件夹操作 ──

  /** 加载文件夹列表 */
  async function loadFolders() {
    try {
      folders.value = await invoke<Folder[]>("list_folders");
    } catch (err) {
      console.error("加载文件夹列表失败:", err);
    }
  }

  /** 创建文件夹 */
  async function createFolder(name: string): Promise<Folder> {
    const folder = await invoke<Folder>("create_folder", { name });
    folders.value.push(folder);
    folders.value.sort((a, b) => a.sort_order - b.sort_order);
    return folder;
  }

  /** 重命名文件夹 */
  async function renameFolder(folderId: string, newName: string) {
    await invoke("rename_folder", { folderId, newName });
    const f = folders.value.find(f => f.id === folderId);
    if (f) f.name = newName;
  }

  /** 删除文件夹 */
  async function deleteFolder(folderId: string) {
    await invoke("delete_folder", { folderId });
    folders.value = folders.value.filter(f => f.id !== folderId);
    // 如果当前正在筛选该文件夹，切回"全部"
    if (currentFolderFilter.value === folderId) {
      currentFolderFilter.value = "all";
    }
    // 刷新文档列表（文档 project_id 已在后端重置）
    await reloadDocuments();
  }

  /** 移动文档到文件夹 */
  async function moveDocument(docId: string, folderId: string) {
    await invoke("move_document", { docId, folderId });
    await reloadDocuments();
    await loadFolders();
  }

  /** 将文档移出文件夹（未分类） */
  async function removeDocumentFromFolder(docId: string) {
    await invoke("remove_document_from_folder", { docId });
    await reloadDocuments();
    await loadFolders();
  }

  /** 切换文件夹筛选 */
  function setFolderFilter(folderId: string) {
    currentFolderFilter.value = folderId;
  }

  /** 创建新文档 */
  async function createNewDocument(title?: string) {
    loading.value.init = true;
    error.value = "";
    try {
      const doc = await invoke<Document>("create_document", {
        title: title || "新文档",
      });
      documents.value.unshift(doc);
      await switchDocument(doc.id);
    } catch (err) {
      error.value = String(err);
    } finally {
      loading.value.init = false;
    }
  }

  /** 切换到指定文档 */
  async function switchDocument(docId: string) {
    error.value = "";
    draftLoaded.value = false;
    viewingVersionId.value = ""; // 切换文档时退出历史版本查看
    try {
      const doc = await invoke<Document>("get_document", { docId });
      currentDocId.value = doc.id;
      currentTitle.value = doc.title;

      // 加载该文档的排版设置（per-document）
      const exportSettingsStore = useExportSettingsStore();
      await exportSettingsStore.loadForDocument(docId);

      // 先尝试恢复草稿内容
      const draft = await invoke<string | null>("get_draft", { docId });
      if (draft) {
        currentContent.value = parseContent(draft);
      } else {
        // 没有草稿，获取最新版本内容
        const list = await invoke<Version[]>("get_versions", { docId });
        currentContent.value = parseContent(list.length > 0 ? list[list.length - 1].content : null);
      }

      await loadVersions();
      loadDocumentScore(); // 异步加载评分，不阻塞
      sidebarTab.value = "versions";
      draftLoaded.value = true;
    } catch (err) {
      error.value = String(err);
    }
  }

  /** 重命名文档（docId 可选，默认当前文档） */
  async function renameDocument(newTitle: string, docId?: string) {
    const targetId = docId || currentDocId.value;
    if (!targetId || !newTitle.trim()) return;
    try {
      await invoke("update_document_title", {
        docId: targetId,
        title: newTitle.trim(),
      });
      // 如果是当前文档，更新标题显示
      if (targetId === currentDocId.value) {
        currentTitle.value = newTitle.trim();
      }
      // 更新列表中的标题
      const doc = documents.value.find((d) => d.id === targetId);
      if (doc) doc.title = newTitle.trim();
    } catch (err) {
      error.value = String(err);
    }
  }

  /** 删除文档 */
  async function deleteDocument(docId: string) {
    if (!docId) return;
    try {
      await invoke("delete_document", { docId });
      // 从列表中移除
      documents.value = documents.value.filter((d) => d.id !== docId);
      // 如果删除的是当前文档，切换到其他文档
      if (currentDocId.value === docId) {
        if (documents.value.length > 0) {
          await switchDocument(documents.value[0].id);
        } else {
          await createNewDocument();
        }
      }
    } catch (err) {
      error.value = String(err);
    }
  }

  /** 提交新版本（commit_msg 可选，默认时间命名） */
  async function commitVersion(commitMsg?: string) {
    if (!currentDocId.value) return;
    loading.value.commit = true;
    error.value = "";
    try {
      const msg = commitMsg?.trim() || formatTimestamp();
      await invoke<Version>("commit_version", {
        docId: currentDocId.value,
        content: serializeContent(currentContent.value),
        commitMsg: msg,
      });
      // 提交后清除草稿（内容已保存为版本）
      await invoke("save_draft", {
        docId: currentDocId.value,
        content: "",
      }).catch(() => {});
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

  async function loadVersionContent(versionId: string) {
    await withSuppressDraftSave(async () => {
      const version = await invoke<Version>("get_version", { versionId });
      // 防止快速切换文档导致版本内容错配到非所属文档
      if (version.doc_id !== currentDocId.value) return;
      currentContent.value = parseContent(version.content);
      viewingVersionId.value = versionId;
      loadDocumentScore();
    }).catch((err) => { error.value = String(err); });
  }

  /** 重命名版本 */
  async function renameVersion(versionId: string, newMsg: string) {
    error.value = "";
    try {
      await invoke("rename_version", { versionId, commitMsg: newMsg });
      await loadVersions();
      // 更新 viewingVersionLabel（如果正在查看该版本）
    } catch (err) {
      error.value = String(err);
    }
  }

  /** 删除版本 */
  async function deleteVersion(versionId: string) {
    error.value = "";
    try {
      await invoke("delete_version", { versionId });
      if (selectedOldVersionId.value === versionId) selectedOldVersionId.value = "";
      if (selectedNewVersionId.value === versionId) selectedNewVersionId.value = "";
      if (viewingVersionId.value === versionId) viewingVersionId.value = "";
      await loadVersions();
    } catch (err) {
      error.value = String(err);
    }
  }

  /** 退出历史版本查看，恢复最新草稿到编辑器 */
  async function exitHistoryView() {
    await withSuppressDraftSave(async () => {
      const draft = await invoke<string | null>("get_draft", {
        docId: currentDocId.value,
      });
      if (draft) {
        currentContent.value = parseContent(draft);
      } else {
        // 没有草稿时回退到最新版本内容
        const vs = await invoke<Version[]>("get_versions", {
          docId: currentDocId.value,
        });
        if (vs.length > 0) {
          currentContent.value = parseContent(vs[vs.length - 1].content);
        } else {
          currentContent.value = { type: "doc", content: [] };
        }
      }
      viewingVersionId.value = "";
      loadDocumentScore();
    }).catch((err) => { error.value = String(err); });
  }

  /** 回滚：将指定历史版本内容恢复为当前草稿 */
  async function rollbackToVersion(versionId: string) {
    error.value = "";
    await withSuppressDraftSave(async () => {
      const version = await invoke<Version>("get_version", { versionId });
      const parsed = parseContent(version.content);
      currentContent.value = parsed;
      viewingVersionId.value = "";
      // 立即保存为草稿（保证后续编辑基于此版本）
      await invoke("save_draft", {
        docId: currentDocId.value,
        content: serializeContent(parsed),
      });
    }).catch((err) => { error.value = String(err); });
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
        temperature: 0.3,
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
        apiKey: config.api_key,
        apiUrl: config.api_url,
        model: config.model,
        thinkingEnabled: config.thinking_enabled,
        reasoningEffort: config.reasoning_effort,
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

  /** 单文档/版本 AI 评分 */
  async function scoreDocument() {
    const content = currentContent.value;
    if (!content || (typeof content === 'object' && (!content.content || content.content.length === 0))) {
      error.value = "文档内容为空，无法评分";
      return;
    }
    const key = scoreContextKey.value;
    if (!key) return;
    scoreLoading.value = true;
    error.value = "";
    try {
      const result = await invoke<DocumentScore>("score_document", {
        contextKey: key,
        content: serializeContent(currentContent.value),
        title: currentTitle.value,
      });
      documentScores.value[key] = result;
    } catch (err) {
      error.value = String(err);
    } finally {
      scoreLoading.value = false;
    }
  }

  /** 加载当前文档/版本的已保存评分 */
  async function loadDocumentScore() {
    const key = scoreContextKey.value;
    if (!key) return;
    // 避免重复加载
    if (documentScores.value[key]) return;
    try {
      const cached = await invoke<DocumentScore | null>("get_document_score", {
        contextKey: key,
      });
      if (cached) {
        documentScores.value[key] = cached;
      }
    } catch {
      // 静默忽略
    }
  }

  // 重置状态
  function reset() {
    documents.value = [];
    currentDocId.value = "";
    currentTitle.value = "新文档";
    currentContent.value = { type: "doc", content: [] };
    versions.value = [];
    selectedOldVersionId.value = "";
    selectedNewVersionId.value = "";
    viewingVersionId.value = "";
    diffResult.value = null;
    analysisResult.value = null;
    error.value = "";
    draftLoaded.value = false;
  }

  return {
    // 状态
    documents,
    currentDocId,
    currentTitle,
    currentContent,
    folders,
    currentFolderFilter,
    filteredDocuments,
    versions,
    selectedOldVersionId,
    selectedNewVersionId,
    viewingVersionId,
    diffResult,
    analysisResult,
    documentScore,
    scoreLoading,
    apiConfig,
    loading,
    error,
    sidebarTab,
    dataVersion,
    draftLoaded,
    draftSaveStatus,
    lastSaveTime,
    injectedChatText,
    // 计算
    hasSelectedVersions,
    canDiff,
    viewingVersionLabel,
    isViewingHistory,
    // 操作
    initDocument,
    reloadDocuments,
    loadFolders,
    createFolder,
    renameFolder,
    deleteFolder,
    moveDocument,
    removeDocumentFromFolder,
    setFolderFilter,
    createNewDocument,
    switchDocument,
    renameDocument,
    deleteDocument,
    commitVersion,
    loadVersions,
    loadVersionContent,
    renameVersion,
    deleteVersion,
    exitHistoryView,
    rollbackToVersion,
    compareVersions,
    analyzeRevision,
    scoreDocument,
    loadDocumentScore,
    loadExistingAnalysis,
    loadApiConfig,
    saveApiConfig,
    testApiConnection,
    reset,
  };
});
