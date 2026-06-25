<script setup lang="ts">
import { useDocumentStore } from "../stores/document";
import { storeToRefs } from "pinia";

const store = useDocumentStore();
const { versions, loading, selectedOldVersionId, selectedNewVersionId } =
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
      <template v-else-if="selectedOldVersionId && !selectedNewVersionId">
        已选旧版，请再选择一个版本作为新版
      </template>
    </div>
  </div>
</template>
