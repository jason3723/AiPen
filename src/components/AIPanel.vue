<script setup lang="ts">
import { ref, watch } from "vue";
import { useDocumentStore } from "../stores/document";
import { storeToRefs } from "pinia";
import type { AIConfig } from "../stores/document";

const store = useDocumentStore();
const {
  analysisResult,
  loading,
  canDiff,
  hasSelectedVersions,
  selectedOldVersionId,
  selectedNewVersionId,
  versions,
  apiConfig,
} = storeToRefs(store);

const showConfig = ref(false);
const testingConnection = ref(false);
const connectionStatus = ref<"idle" | "success" | "fail">("idle");
const editingConfig = ref<AIConfig>({ ...apiConfig.value });

/** Local error tracking scoped to analysis operations */
const analysisError = ref("");

// Watch for analysis completion to capture errors
watch(loading, (newVal) => {
  if (!newVal.analysis && store.error && analysisResult.value === null) {
    analysisError.value = store.error;
  }
  if (newVal.analysis) {
    analysisError.value = "";
  }
}, { deep: true });

function getVersionLabel(versionId: string): string {
  const v = versions.value.find((v) => v.id === versionId);
  if (!v) return "";
  return v.commit_msg ? `v${v.version_num}: ${v.commit_msg}` : `v${v.version_num}`;
}

function handleAnalyze() {
  analysisError.value = "";
  store.analyzeRevision();
}

function handleClear() {
  store.analysisResult = null;
  analysisError.value = "";
}

function toggleConfig() {
  showConfig.value = !showConfig.value;
  if (showConfig.value) {
    editingConfig.value = { ...apiConfig.value };
  }
}

async function handleTestConnection() {
  testingConnection.value = true;
  connectionStatus.value = "idle";
  try {
    await store.testApiConnection();
    connectionStatus.value = "success";
  } catch {
    connectionStatus.value = "fail";
  } finally {
    testingConnection.value = false;
  }
}

async function handleSaveConfig() {
  await store.saveApiConfig(editingConfig.value);
  showConfig.value = false;
}

function handleRetry() {
  handleAnalyze();
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
        AI 分析
      </h3>
      <div class="flex items-center gap-1">
        <button
          v-if="analysisResult"
          class="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          @click="handleClear"
          title="清除分析结果"
        >
          清除
        </button>
        <button
          class="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          @click="toggleConfig"
          title="API 配置"
        >
          {{ showConfig ? "收起" : "配置" }}
        </button>
      </div>
    </div>

    <!-- API 配置面板（可折叠） -->
    <div
      v-if="showConfig"
      class="space-y-2 p-3 bg-gray-900/50 border border-gray-800 rounded-lg text-sm"
    >
      <h4 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">API 配置</h4>

      <div class="space-y-2">
        <div>
          <label class="block text-xs text-gray-500 mb-0.5">提供商</label>
          <select
            v-model="editingConfig.provider"
            class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200 text-xs"
          >
            <option value="openai">OpenAI</option>
            <option value="claude">Claude</option>
            <option value="deepseek">DeepSeek</option>
            <option value="custom">自定义</option>
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-0.5">API URL</label>
          <input
            v-model="editingConfig.api_url"
            class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200 text-xs font-mono"
            placeholder="https://api.openai.com/v1/chat/completions"
            type="url"
          />
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-0.5">模型</label>
          <input
            v-model="editingConfig.model"
            class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200 text-xs font-mono"
            placeholder="gpt-4o"
          />
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-0.5">API Key</label>
          <input
            v-model="editingConfig.api_key"
            class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200 text-xs font-mono"
            placeholder="sk-..."
            type="password"
          />
        </div>
      </div>

      <div class="flex items-center gap-2">
        <button
          class="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="!editingConfig.api_key || !editingConfig.api_url"
          @click="handleSaveConfig"
        >
          保存
        </button>
        <button
          class="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="testingConnection"
          @click="handleTestConnection"
        >
          <template v-if="testingConnection">
            <span class="inline-block w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin mr-1 align-middle"></span>
            测试中...
          </template>
          <template v-else>测试连接</template>
        </button>
      </div>

      <!-- 连接测试结果 -->
      <div
        v-if="connectionStatus === 'success'"
        class="text-xs text-green-400 bg-green-900/30 px-2 py-1 rounded"
      >
        连接成功
      </div>
      <div
        v-if="connectionStatus === 'fail'"
        class="text-xs text-red-400 bg-red-900/30 px-2 py-1 rounded"
      >
        连接失败，请检查配置
      </div>
    </div>

    <!-- 加载状态（最高优先级） -->
    <template v-if="loading.analysis">
      <div class="space-y-2 animate-pulse">
        <!-- 分类骨架 -->
        <div class="space-y-1">
          <div class="h-4 w-16 bg-green-900/50 rounded mb-2"></div>
          <div class="h-5 bg-green-900/30 rounded"></div>
          <div class="h-5 w-5/6 bg-green-900/30 rounded"></div>
        </div>
        <div class="space-y-1 pt-2">
          <div class="h-4 w-16 bg-red-900/50 rounded mb-2"></div>
          <div class="h-5 bg-red-900/30 rounded"></div>
          <div class="h-5 w-3/4 bg-red-900/30 rounded"></div>
          <div class="h-5 w-4/5 bg-red-900/30 rounded"></div>
        </div>
        <div class="space-y-1 pt-2">
          <div class="h-4 w-16 bg-blue-900/50 rounded mb-2"></div>
          <div class="h-5 bg-blue-900/30 rounded"></div>
          <div class="h-5 w-5/6 bg-blue-900/30 rounded"></div>
        </div>
      </div>
    </template>

    <!-- 正常状态（分析结果） -->
    <template v-else-if="analysisResult">
      <div class="space-y-3">
        <!-- 分析总览 -->
        <div class="flex items-center gap-2 text-xs text-gray-400">
          <svg class="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
            />
          </svg>
          <span>AI 分析完成</span>
          <span class="text-gray-600">|</span>
          <span class="text-gray-500">
            {{ getVersionLabel(selectedOldVersionId) }}
            &rarr;
            {{ getVersionLabel(selectedNewVersionId) }}
          </span>
        </div>

        <!-- 优点（绿色） -->
        <div
          v-if="analysisResult.highlights && analysisResult.highlights.length > 0"
          class="space-y-1"
        >
          <div class="flex items-center gap-1.5 text-xs font-semibold text-green-400 uppercase tracking-wider">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
            </svg>
            优点
          </div>
          <ul class="space-y-1">
            <li
              v-for="(item, i) in analysisResult.highlights"
              :key="i"
              class="flex items-start gap-2 text-xs text-green-200 bg-green-950/30 px-3 py-2 rounded-lg border border-green-900/30"
            >
              <span class="flex-shrink-0 w-4 h-4 rounded-full bg-green-800/50 flex items-center justify-center text-green-400 text-[10px] font-bold mt-0.5">
                {{ i + 1 }}
              </span>
              <span>{{ item }}</span>
            </li>
          </ul>
        </div>

        <!-- 不足（红色） -->
        <div
          v-if="analysisResult.issues && analysisResult.issues.length > 0"
          class="space-y-1"
        >
          <div class="flex items-center gap-1.5 text-xs font-semibold text-red-400 uppercase tracking-wider">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
            不足
          </div>
          <ul class="space-y-1">
            <li
              v-for="(item, i) in analysisResult.issues"
              :key="i"
              class="flex items-start gap-2 text-xs text-red-200 bg-red-950/30 px-3 py-2 rounded-lg border border-red-900/30"
            >
              <span class="flex-shrink-0 w-4 h-4 rounded-full bg-red-800/50 flex items-center justify-center text-red-400 text-[10px] font-bold mt-0.5">
                {{ i + 1 }}
              </span>
              <span>{{ item }}</span>
            </li>
          </ul>
        </div>

        <!-- 建议（蓝色） -->
        <div
          v-if="analysisResult.suggestions && analysisResult.suggestions.length > 0"
          class="space-y-1"
        >
          <div class="flex items-center gap-1.5 text-xs font-semibold text-blue-400 uppercase tracking-wider">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            建议
          </div>
          <ul class="space-y-1">
            <li
              v-for="(item, i) in analysisResult.suggestions"
              :key="i"
              class="flex items-start gap-2 text-xs text-blue-200 bg-blue-950/30 px-3 py-2 rounded-lg border border-blue-900/30"
            >
              <span class="flex-shrink-0 w-4 h-4 rounded-full bg-blue-800/50 flex items-center justify-center text-blue-400 text-[10px] font-bold mt-0.5">
                {{ i + 1 }}
              </span>
              <span>{{ item }}</span>
            </li>
          </ul>
        </div>

        <!-- 空结果（分析完成但无具体内容） -->
        <div
          v-if="
            (!analysisResult.highlights || analysisResult.highlights.length === 0) &&
            (!analysisResult.issues || analysisResult.issues.length === 0) &&
            (!analysisResult.suggestions || analysisResult.suggestions.length === 0)
          "
          class="text-center py-6 text-gray-500 text-sm"
        >
          <svg class="w-8 h-8 mx-auto mb-2 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p>分析完成，未检测到具体建议</p>
          <p class="text-xs text-gray-600 mt-1">可能是修改内容较短或模型未返回结构化结果</p>
        </div>
      </div>
    </template>

    <!-- 等待状态（未选择版本） -->
    <template v-else-if="!hasSelectedVersions">
      <div class="text-center py-8 text-gray-500 text-sm">
        <svg
          class="w-10 h-10 mx-auto mb-3 text-gray-600"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.5"
            d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
          />
        </svg>
        <p class="mb-1">选择版本进行 AI 分析</p>
        <p class="text-xs text-gray-600">在版本历史中选择旧版和新版后，AI 将分析修改的优缺点</p>
      </div>
    </template>

    <!-- 等待状态（已选版本，可触发分析） -->
    <template v-else>
      <div class="text-center py-8 text-gray-500 text-sm">
        <svg
          class="w-10 h-10 mx-auto mb-3 text-gray-600"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.5"
            d="M13 10V3L4 14h7v7l9-11h-7z"
          />
        </svg>
        <p class="mb-2 text-xs text-gray-400">
          <span class="inline-block px-1.5 py-0.5 rounded bg-blue-800 text-blue-200 text-xs mr-1">旧版</span>
          {{ getVersionLabel(selectedOldVersionId) }}
        </p>
        <p class="mb-3 text-xs text-gray-400">
          <span class="inline-block px-1.5 py-0.5 rounded bg-green-800 text-green-200 text-xs mr-1">新版</span>
          {{ getVersionLabel(selectedNewVersionId) }}
        </p>

        <!-- API Key 未配置提示 -->
        <div
          v-if="!apiConfig.api_key"
          class="mb-3 text-xs text-yellow-500 bg-yellow-900/20 px-2 py-1.5 rounded"
        >
          请先配置 API Key
          <button
            class="underline hover:text-yellow-400 ml-1"
            @click="showConfig = true"
          >
            去配置
          </button>
        </div>

        <button
          class="px-4 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          :disabled="!canDiff || !apiConfig.api_key"
          @click="handleAnalyze"
        >
          AI 分析
        </button>
        <p
          v-if="!canDiff && selectedOldVersionId === selectedNewVersionId"
          class="mt-2 text-xs text-yellow-500"
        >
          请选择两个不同的版本
        </p>
      </div>

      <!-- 分析错误提示（内联在等待状态中） -->
      <div
        v-if="analysisError"
        class="flex items-start gap-2 text-xs text-red-400 bg-red-950/30 border border-red-900/30 px-3 py-2 rounded-lg"
      >
        <svg class="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
        <div class="flex-1 min-w-0">
          <p class="font-medium">分析失败</p>
          <p class="text-red-300/70 mt-0.5 break-words">{{ analysisError }}</p>
          <button
            class="mt-1.5 px-2 py-0.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded transition-colors"
            @click="handleRetry"
          >
            重试
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
