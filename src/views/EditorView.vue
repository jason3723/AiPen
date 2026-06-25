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
