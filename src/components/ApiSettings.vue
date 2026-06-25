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
