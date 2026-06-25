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
