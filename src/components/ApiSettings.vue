<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, inject, watch } from "vue";
import { useDocumentStore } from "../stores/document";
import { useMaterialStore } from "../stores/materialStore";
import { storeToRefs } from "pinia";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { UpdateState } from "../App.vue";
import pkg from "../../package.json";
import { loadCustomRecipes } from "../data/recipes";

const store = useDocumentStore();
const materialStore = useMaterialStore();
const { apiConfig, error, dataVersion, sidebarTab } = storeToRefs(store);

const testResult = ref<{ type: "success" | "failure"; message: string } | null>(null);
const saveResult = ref<{ type: "success" | "failure"; message: string } | null>(null);
const testing = ref(false);
const showHelpModal = ref(false);

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let testTimer: ReturnType<typeof setTimeout> | null = null;
let backupTimer: ReturnType<typeof setTimeout> | null = null;
const querying = ref(false);
const balanceAmount = ref("");

function showSaveResult(result: { type: "success" | "failure"; message: string }) {
  if (saveTimer) clearTimeout(saveTimer);
  saveResult.value = result;
  saveTimer = setTimeout(() => { saveResult.value = null; }, 5000);
}

function showTestResult(result: { type: "success" | "failure"; message: string }) {
  if (testTimer) clearTimeout(testTimer);
  testResult.value = result;
  testTimer = setTimeout(() => { testResult.value = null; }, 5000);
}

function showBackupResult(result: { type: "success" | "failure"; message: string }) {
  if (backupTimer) clearTimeout(backupTimer);
  backupResult.value = result;
  backupTimer = setTimeout(() => { backupResult.value = null; }, 5000);
}

// ── 数据管理状态 ──
const exporting = ref(false);
const importing = ref(false);
const backupResult = ref<{ type: "success" | "failure"; message: string } | null>(null);
const backupStats = ref<{ documents: number; knowledge_bases: number; materials: number; skills: number; interview_prompts: number; compose_recipes: number; folders: number }>({
  documents: 0,
  knowledge_bases: 0,
  materials: 0,
  skills: 0,
  interview_prompts: 0,
  compose_recipes: 0,
  folders: 0,
});

// 导出勾选项（默认全选）
const exportSelections = ref({
  documents: true,
  knowledge_bases: true,
  materials: true,
  skills: true,
  interview_prompts: true,
  compose_recipes: true,
});

interface ModelOption {
  value: string;
  label: string;
  desc: string;
}

const MODELS: ModelOption[] = [
  { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash（快速模式）", desc: "轻量快速，适合大多数任务" },
  { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro（专家模式）", desc: "深度品质，适合复杂写作" },
];

const REASONING_EFFORTS = [
  { value: "high", label: "高（high）" },
  { value: "max", label: "最强（max）" },
];

// 当前选中的模型信息
const currentModel = computed<ModelOption | undefined>(() =>
  MODELS.find(m => m.value === apiConfig.value.model)
);

// 思考开关是否被用户手动关闭（用于禁用思考强度）
const thinkingDisabled = computed(() => !apiConfig.value.thinking_enabled);

async function handleSave() {
  try {
    await store.saveApiConfig(apiConfig.value);
    showSaveResult({ type: "success", message: "设置已保存" });
  } catch (err) {
    showSaveResult({ type: "failure", message: String(err) });
  }
}

async function handleTest() {
  testing.value = true;
  try {
    await store.saveApiConfig(apiConfig.value);
    const result = await store.testApiConnection();
    showTestResult({ type: "success", message: result });
  } catch (err) {
    showTestResult({ type: "failure", message: String(err) });
  } finally {
    testing.value = false;
  }
}

async function handleQueryBalance() {
  querying.value = true;
  try {
    await store.saveApiConfig(apiConfig.value);
    const result = await invoke<string>("query_balance");
    // 提取第一行数字即可
    const m = result.match(/总余额:\s*([\d.]+)/);
    balanceAmount.value = m ? m[1] : "?";
  } catch {
    balanceAmount.value = "错误";
  } finally {
    querying.value = false;
  }
}

// ── 数据管理 ──

async function handleExport() {
  exporting.value = true;
  backupResult.value = null;
  try {
    const data = await invoke("export_selected_data", {
      exportDocuments: exportSelections.value.documents,
      exportKnowledgeBases: exportSelections.value.knowledge_bases,
      exportMaterials: exportSelections.value.materials,
      exportSkills: exportSelections.value.skills,
      exportInterviewPrompts: exportSelections.value.interview_prompts,
      exportComposeRecipes: exportSelections.value.compose_recipes,
    });
    const json = JSON.stringify(data, null, 2);
    const filePath = await save({
      defaultPath: `AiPen_backup_${new Date().toISOString().slice(0, 10)}_${String(new Date().getHours()).padStart(2, "0")}${String(new Date().getMinutes()).padStart(2, "0")}.aipen`,
      filters: [{ name: "AiPen 备份", extensions: ["aipen"] }],
    });
    if (!filePath) return;
    await writeTextFile(filePath, json);
    showBackupResult({ type: "success", message: `已导出到 ${filePath}` });
  } catch (err) {
    showBackupResult({ type: "failure", message: String(err) });
  } finally {
    exporting.value = false;
  }
}

async function handleImport() {
  importing.value = true;
  backupResult.value = null;
  try {
    const filePath = await open({
      multiple: false,
      filters: [{ name: "AiPen 备份", extensions: ["aipen"] }],
    });
    if (!filePath) return;
    const filePathStr = typeof filePath === "string" ? filePath : (filePath as { path: string }).path;
    const json = await readTextFile(filePathStr);
    const stats = await invoke<{ document_count: number; knowledge_base_count: number; material_count: number; skill_count: number; interview_prompt_count: number; compose_recipe_count: number; folder_count: number }>(
      "import_data",
      { dataJson: json }
    );
    backupStats.value = {
      documents: stats.document_count,
      knowledge_bases: stats.knowledge_base_count,
      materials: stats.material_count ?? 0,
      skills: stats.skill_count,
      interview_prompts: stats.interview_prompt_count,
      compose_recipes: stats.compose_recipe_count ?? 0,
      folders: stats.folder_count ?? 0,
    };
    const parts: string[] = [];
    if (stats.document_count > 0) parts.push(`${stats.document_count} 个文档`);
    if (stats.knowledge_base_count > 0) parts.push(`${stats.knowledge_base_count} 个知识库`);
    if ((stats.material_count ?? 0) > 0) parts.push(`${stats.material_count} 个素材`);
    if (stats.skill_count > 0) parts.push(`${stats.skill_count} 个技能`);
    if (stats.interview_prompt_count > 0) parts.push(`${stats.interview_prompt_count} 个采访提示`);
    if ((stats.compose_recipe_count ?? 0) > 0) parts.push(`${stats.compose_recipe_count} 个写作`);
    if ((stats.folder_count ?? 0) > 0) parts.push(`${stats.folder_count} 个文件夹`);
    showBackupResult({
      type: "success",
      message: `导入完成：${parts.join("、")}（已存在的已跳过）`,
    });
    // 重新加载素材并触发迁移（处理可能导入的旧格式纯文本素材）
    if (stats.material_count > 0) {
      await materialStore.init();
    }
    // 刷新自定义菜谱缓存
    await loadCustomRecipes();
    dataVersion.value++;
  } catch (err) {
    showBackupResult({ type: "failure", message: String(err) });
  } finally {
    importing.value = false;
  }
}

async function loadBackupStats() {
  try {
    const data = await invoke<{ documents: unknown[]; knowledge_bases: unknown[]; materials: unknown[]; skills: unknown[]; interview_prompts: unknown[]; compose_recipes: unknown[]; folders: unknown[] }>("export_data");
    backupStats.value = {
      documents: data.documents?.length ?? 0,
      knowledge_bases: data.knowledge_bases?.length ?? 0,
      materials: data.materials?.length ?? 0,
      skills: data.skills?.length ?? 0,
      interview_prompts: data.interview_prompts?.length ?? 0,
      compose_recipes: data.compose_recipes?.length ?? 0,
      folders: data.folders?.length ?? 0,
    };
  } catch {
    // 静默失败
  }
}

onMounted(() => {
  loadBackupStats();
});

// 切换到设置标签或数据导入后刷新统计数据
watch(sidebarTab, (tab) => {
  if (tab === 'settings') {
    loadBackupStats();
  }
});
watch(dataVersion, () => {
  loadBackupStats();
});

// ── 软件更新 ──
const updateState = inject<UpdateState>("updateState")!;
const checkingUpdate = ref(false);
const downloadingUpdate = ref(false);
const downloadProgress = ref(0);
const updateError = ref("");

// "已是最新版"提示 5 秒后自动消失
let upToDateTimer: ReturnType<typeof setTimeout> | null = null;
watch(() => updateState.phase, (phase) => {
  if (upToDateTimer) { clearTimeout(upToDateTimer); upToDateTimer = null; }
  if (phase === "up-to-date") {
    upToDateTimer = setTimeout(() => { updateState.phase = "idle"; }, 5000);
  }
});
onUnmounted(() => {
  if (upToDateTimer) clearTimeout(upToDateTimer);
  if (backupTimer) clearTimeout(backupTimer);
});

async function handleCheckUpdate() {
  checkingUpdate.value = true;
  updateError.value = "";
  updateState.errorMessage = "";
  updateState.gaveUp = false;
  try {
    const update = await check();
    updateState.lastCheckedAt = Date.now();
    if (update) {
      updateState.updateInfo = {
        version: update.version,
        body: update.body ?? null,
      };
      updateState.phase = "available";
    } else {
      updateState.phase = "up-to-date";
    }
  } catch (err) {
    const msg = String(err);
    updateError.value = msg.includes("network") || msg.includes("fetch") || msg.includes("connect")
      ? "网络连接异常，请检查网络后重试"
      : `检查更新失败: ${msg}`;
    updateState.phase = "error";
    updateState.errorMessage = updateError.value;
  } finally {
    checkingUpdate.value = false;
  }
}

async function handleDownload() {
  downloadingUpdate.value = true;
  downloadProgress.value = 0;
  updateError.value = "";
  try {
    const update = await check();
    if (!update) {
      updateState.phase = "up-to-date";
      return;
    }
    let totalBytes = 0;
    let downloadedBytes = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        totalBytes = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        if (totalBytes > 0) {
          downloadProgress.value = Math.min(99, Math.round((downloadedBytes / totalBytes) * 100));
        }
      }
    });
    // 安装完成，提示重启
    downloadProgress.value = 100;
    updateState.phase = "up-to-date";
    await relaunch();
  } catch (err) {
    updateError.value = `下载失败: ${String(err)}`;
  } finally {
    downloadingUpdate.value = false;
  }
}

/** 当前 app 版本 */
const appVersion = pkg.version;
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-2">
      <h3 class="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">
        DeepSeek API 设置
      </h3>
      <button
        class="text-gray-400 dark:text-gray-500 hover:text-blue-400 transition-colors flex-shrink-0 leading-none"
        title="帮助"
        @click="showHelpModal = true"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M12 17h.01" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      </button>
    </div>

    <!-- API 密钥 -->
    <div>
      <label class="block text-xs text-gray-400 dark:text-gray-500 mb-1">API 密钥</label>
      <input
        v-model="apiConfig.api_key"
        type="password"
        class="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-800 dark:text-gray-200 font-mono focus:border-blue-500 focus:outline-none"
        placeholder="sk-..."
      />
    </div>

    <!-- 模型 -->
    <div>
      <label class="block text-xs text-gray-400 dark:text-gray-500 mb-1">模型</label>
      <select
        v-model="apiConfig.model"
        class="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-800 dark:text-gray-200 focus:border-blue-500 focus:outline-none"
      >
        <option
          v-for="m in MODELS"
          :key="m.value"
          :value="m.value"
        >
          {{ m.label }}
        </option>
      </select>
      <p class="text-xs text-gray-500 dark:text-gray-600 mt-1">
        {{ currentModel?.desc }}
      </p>
    </div>

    <!-- 思考模式开关 -->
    <div>
      <div class="flex items-center justify-between">
        <label class="text-xs text-gray-400 dark:text-gray-500">思考模式</label>
        <button
          type="button"
          class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none"
          :class="apiConfig.thinking_enabled ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-700'"
          @click="apiConfig.thinking_enabled = !apiConfig.thinking_enabled"
        >
          <span
            class="inline-block h-4 w-4 transform rounded-full bg-white transition-transform"
            :class="apiConfig.thinking_enabled ? 'translate-x-[1.1rem]' : 'translate-x-0.5'"
          />
        </button>
      </div>
      <p class="text-xs text-gray-500 dark:text-gray-600 mt-1">
        开启后模型会展示推理过程，输出更可靠但速度稍慢
      </p>
    </div>

    <!-- 思考强度控制 -->
    <div>
      <label class="block text-xs mb-1" :class="thinkingDisabled ? 'text-gray-300 dark:text-gray-700' : 'text-gray-400 dark:text-gray-500'">思考强度</label>
      <select
        v-model="apiConfig.reasoning_effort"
        :disabled="thinkingDisabled"
        class="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed"
        :class="thinkingDisabled ? 'text-gray-500 dark:text-gray-600' : 'text-gray-800 dark:text-gray-200'"
      >
        <option
          v-for="e in REASONING_EFFORTS"
          :key="e.value"
          :value="e.value"
        >
          {{ e.label }}
        </option>
      </select>
      <p class="text-xs mt-1" :class="thinkingDisabled ? 'text-gray-300 dark:text-gray-700' : 'text-gray-500 dark:text-gray-600'">
        思考强度仅思考模式开启时生效
      </p>
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
        class="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50 text-gray-800 dark:text-gray-200 text-sm rounded-lg transition-colors"
        :disabled="testing"
        @click="handleTest"
      >
        {{ testing ? "测试中..." : "测试连接" }}
      </button>
    </div>

    <!-- 保存结果 -->
    <div
      v-if="saveResult"
      class="text-sm p-3 rounded-lg"
      :class="{
        'bg-green-100 dark:bg-green-950/50 border border-green-300 dark:border-green-800 text-green-700 dark:text-green-300': saveResult.type === 'success',
        'bg-red-100 dark:bg-red-950/50 border border-red-300 dark:border-red-800 text-red-600 dark:text-red-300': saveResult.type === 'failure',
      }"
    >
      <p class="whitespace-pre-wrap">{{ saveResult.message }}</p>
    </div>

    <!-- 测试结果 -->
    <div
      v-if="testResult"
      class="text-sm p-3 rounded-lg"
      :class="{
        'bg-green-100 dark:bg-green-950/50 border border-green-300 dark:border-green-800 text-green-700 dark:text-green-300': testResult.type === 'success',
        'bg-red-100 dark:bg-red-950/50 border border-red-300 dark:border-red-800 text-red-600 dark:text-red-300': testResult.type === 'failure',
      }"
    >
      <p class="whitespace-pre-wrap break-all">{{ testResult.message }}</p>
    </div>

    <!-- 费用查询 -->
    <div class="flex items-center gap-1.5 text-xs">
      <span class="text-gray-400 dark:text-gray-500">查询余额</span>
      <span v-if="balanceAmount" class="text-gray-700 dark:text-gray-300 font-mono">{{ balanceAmount }} 元</span>
      <button
        class="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-30 transition-colors leading-none"
        :disabled="querying || !apiConfig.api_key"
        @click="handleQueryBalance"
        title="刷新余额"
      >
        {{ querying ? "⏳" : "↻" }}
      </button>
    </div>

    <!-- 全局错误 -->
    <div
      v-if="error"
      class="text-sm text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-950/30 border border-red-300 dark:border-red-900/30 rounded-lg px-3 py-2"
    >
      {{ error }}
    </div>

    <!-- 分隔线 -->
    <hr class="border-gray-300/50 dark:border-gray-700/50" />

    <!-- 数据管理 -->
    <div>
      <h3 class="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider mb-4">
        数据管理
      </h3>

      <!-- 勾选项：带统计数字 -->
      <div class="grid grid-cols-3 gap-2 mb-3">
        <button
          v-for="item in [
            { key: 'documents' as const, label: '文档' },
            { key: 'knowledge_bases' as const, label: '知识库' },
            { key: 'materials' as const, label: '素材' },
            { key: 'skills' as const, label: '技能' },
            { key: 'interview_prompts' as const, label: '采访提示' },
            { key: 'compose_recipes' as const, label: '写作' },
          ]"
          :key="item.key"
          type="button"
          class="inline-flex items-center justify-center px-1 py-[6px] text-[10px] leading-none rounded-md cursor-pointer select-none transition-all duration-150 whitespace-nowrap border"
          :class="exportSelections[item.key]
            ? 'bg-amber-100 dark:bg-amber-500/15 text-amber-800 dark:text-amber-200 border-amber-300 dark:border-amber-500/40 font-medium'
            : 'bg-gray-100/60 dark:bg-gray-800/50 text-gray-600 dark:text-gray-400 border-gray-300/60 dark:border-gray-700/60 hover:bg-gray-200/60 dark:hover:bg-gray-700/60 hover:text-gray-700 dark:hover:text-gray-300'"
          @click.prevent="exportSelections[item.key] = !exportSelections[item.key]"
        >
          {{ item.label }} {{ backupStats[item.key] }}
        </button>
      </div>

      <!-- 操作按钮：与上方等宽 grid -->
      <div class="grid grid-cols-5 gap-2 mb-1">
        <button
          class="col-span-3 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs rounded-lg transition-colors whitespace-nowrap font-medium"
          :disabled="exporting"
          @click="handleExport"
        >
          📦 {{ exporting ? "导出中..." : "导出选中数据" }}
        </button>
        <button
          class="col-span-2 px-3 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50 text-gray-800 dark:text-gray-200 text-xs rounded-lg transition-colors whitespace-nowrap"
          :disabled="importing"
          @click="handleImport"
        >
          📥 {{ importing ? "导入中..." : "导入数据" }}
        </button>
      </div>

      <p class="text-[11px] text-gray-500 dark:text-gray-600 pl-0.5">增量导入 · 不含密钥</p>

      <!-- 备份结果 -->
      <div
        v-if="backupResult"
        class="text-sm p-3 rounded-lg mt-3"
        :class="{
          'bg-green-100 dark:bg-green-950/50 border border-green-300 dark:border-green-800 text-green-700 dark:text-green-300': backupResult.type === 'success',
          'bg-red-100 dark:bg-red-950/50 border border-red-300 dark:border-red-800 text-red-600 dark:text-red-300': backupResult.type === 'failure',
        }"
      >
        <p class="whitespace-pre-wrap break-all">{{ backupResult.message }}</p>
      </div>
    </div>

    <!-- 分隔线 -->
    <hr class="border-gray-300/50 dark:border-gray-700/50" />

    <!-- 软件更新 -->
    <div>
      <h3 class="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider mb-3">
        软件更新
      </h3>

      <!-- 当前版本 -->
      <p class="text-xs text-gray-400 dark:text-gray-500 mb-3">
        当前版本
        <span class="text-gray-700 dark:text-gray-300 font-mono">{{ appVersion }}</span>
        <span v-if="updateState.lastCheckedAt" class="text-gray-500 dark:text-gray-600 ml-2">
          · 上次检查 {{ new Date(updateState.lastCheckedAt).toLocaleString("zh-CN") }}
        </span>
      </p>

      <!-- checking -->
      <div v-if="updateState.phase === 'checking' || checkingUpdate" class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 py-2">
        <svg class="animate-spin w-4 h-4 text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        正在检查更新...
      </div>

      <!-- up-to-date -->
      <div v-else-if="updateState.phase === 'up-to-date'" class="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-950/30 border border-green-900/30 rounded-lg px-3 py-2 mb-2">
        <svg class="w-4 h-4 flex-shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        <span>已是最新版</span>
      </div>

      <!-- available -->
      <div v-else-if="updateState.phase === 'available' && updateState.updateInfo" class="bg-blue-100 dark:bg-blue-950/30 border border-blue-300 dark:border-blue-900/30 rounded-lg p-3 space-y-3">
        <div class="flex items-center gap-2">
          <span class="text-lg">🎉</span>
          <span class="text-sm font-semibold text-blue-700 dark:text-blue-300">
            发现新版本 v{{ updateState.updateInfo.version }}
          </span>
        </div>

        <!-- 更新日志 -->
        <div v-if="updateState.updateInfo.body" class="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto bg-gray-100/80 dark:bg-gray-900/50 rounded-lg p-2 border border-gray-200 dark:border-gray-800">
          {{ updateState.updateInfo.body }}
        </div>

        <!-- 下载进度 -->
        <div v-if="downloadingUpdate" class="space-y-1">
          <div class="w-full h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
            <div
              class="h-full bg-blue-500 rounded-full transition-all duration-300"
              :style="{ width: downloadProgress + '%' }"
            />
          </div>
          <p class="text-xs text-gray-400 dark:text-gray-500 text-right">{{ downloadProgress }}%</p>
        </div>

        <div class="flex gap-2">
          <button
            class="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors"
            :disabled="downloadingUpdate"
            @click="handleDownload"
          >
            {{ downloadingUpdate ? "下载中..." : "立即更新" }}
          </button>
          <button
            class="px-3 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50 text-gray-700 dark:text-gray-300 text-sm rounded-lg transition-colors"
            :disabled="downloadingUpdate"
            @click="updateState.phase = 'up-to-date'"
          >
            跳过此版本
          </button>
        </div>
      </div>

      <!-- error -->
      <div v-else-if="updateState.phase === 'error'" class="bg-red-100 dark:bg-red-950/30 border border-red-300 dark:border-red-900/30 rounded-lg px-3 py-2 space-y-2">
        <p class="text-sm text-red-600 dark:text-red-400 break-all">{{ updateState.errorMessage || updateError }}</p>
        <button
          class="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50 text-gray-800 dark:text-gray-200 text-sm rounded-lg transition-colors"
          :disabled="checkingUpdate"
          @click="handleCheckUpdate"
        >
          {{ checkingUpdate ? "检查中..." : "重试" }}
        </button>
      </div>

      <!-- manual check button (idle or up-to-date states) -->
      <div v-if="updateState.phase === 'idle' || updateState.phase === 'up-to-date'" class="mt-2">
        <button
          class="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50 text-gray-800 dark:text-gray-200 text-xs rounded-lg transition-colors"
          :disabled="checkingUpdate"
          @click="handleCheckUpdate"
        >
          {{ checkingUpdate ? "检查中..." : "检查更新" }}
        </button>
      </div>
    </div>

    <!-- 帮助弹窗 -->
    <Teleport to="body">
      <div
        v-if="showHelpModal"
        class="fixed inset-0 z-50 flex items-center justify-center"
        @click.self="showHelpModal = false"
      >
        <!-- 遮罩 -->
        <div class="absolute inset-0 bg-black/40 backdrop-blur-md"></div>
        <!-- 弹窗内容 -->
        <div class="relative bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-xl shadow-2xl w-[560px] mx-4">
          <!-- 标题栏 -->
          <div class="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-800">
            <h2 class="text-base font-semibold text-gray-800 dark:text-gray-200">API 设置帮助</h2>
            <button
              class="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              @click="showHelpModal = false"
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <!-- 内容区 -->
          <div class="px-5 py-3 space-y-3 text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
            <!-- DeepSeek 密钥申请 -->
            <section>
              <h3 class="text-sm font-semibold text-blue-400 mb-2">如何申请 DeepSeek API 密钥</h3>
              <ol class="list-decimal list-inside space-y-1 ml-1">
                <li>访问 DeepSeek 开放平台：<a href="https://platform.deepseek.com" target="_blank" class="text-blue-400 hover:text-blue-300 underline">platform.deepseek.com</a></li>
                <li>注册/登录账号（支持手机号或邮箱注册）</li>
                <li>完成<b>实名认证</b>（设置 → 实名认证，按提示提交身份信息）</li>
                <li>完成<b>账户充值</b>（设置 → 充值，最低可充少量金额）</li>
                <li>进入控制台，点击左侧菜单「API Keys」</li>
                <li>点击「创建 API Key」，输入名称后点击创建</li>
                <li>复制生成的密钥（格式为 <code class="text-xs bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-gray-700 dark:text-gray-300">sk-xxxxxxxxxxxxxxxx</code>）</li>
                <li class="text-yellow-800/80 dark:text-yellow-400/80">⚠ 密钥仅显示一次，请妥善保管！</li>
              </ol>
            </section>

            <!-- 如何填写 -->
            <section>
              <h3 class="text-sm font-semibold text-blue-400 mb-2">如何填写设置</h3>
              <ul class="space-y-1.5 ml-1">
                <li>
                  <span class="font-medium text-gray-800 dark:text-gray-200">API 密钥：</span>
                  <span class="text-gray-600 dark:text-gray-400">粘贴上一步复制的 <code class="text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded">sk-...</code> 密钥</span>
                </li>
                <li>
                  <span class="font-medium text-gray-800 dark:text-gray-200">模型：</span>
                  <span class="text-gray-600 dark:text-gray-400"><b>V4 Flash</b> 轻量快速，适合日常使用；<b>V4 Pro</b> 深度品质，适合复杂写作任务</span>
                </li>
              </ul>
            </section>

            <!-- 思考模式说明 -->
            <section>
              <h3 class="text-sm font-semibold text-blue-400 mb-2">思考模式与强度</h3>
              <ul class="space-y-1.5 ml-1">
                <li>
                  <span class="font-medium text-gray-800 dark:text-gray-200">思考模式：</span>
                  <span class="text-gray-600 dark:text-gray-400">开启后模型会在回答前进行深度推理，输出质量更高但响应稍慢</span>
                </li>
                <li>
                  <span class="font-medium text-gray-800 dark:text-gray-200">思考强度 high：</span>
                  <span class="text-gray-600 dark:text-gray-400">适合大多数场景，兼顾质量与速度</span>
                </li>
                <li>
                  <span class="font-medium text-gray-800 dark:text-gray-200">思考强度 max：</span>
                  <span class="text-gray-600 dark:text-gray-400">适合复杂写作任务，推理更充分</span>
                </li>
              </ul>
            </section>
          </div>
          <!-- 底部 -->
          <div class="border-t border-gray-200 dark:border-gray-800 px-5 py-3 flex justify-end">
            <button
              class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors"
              @click="showHelpModal = false"
            >
              知道了
            </button>
          </div>
        </div>
      </div>
    </Teleport>


  </div>
</template>
