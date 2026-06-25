<script setup lang="ts">
import { useDocumentStore } from "../stores/document";
import { storeToRefs } from "pinia";

const store = useDocumentStore();
const { diffResult, loading, hasSelectedVersions, canDiff, selectedOldVersionId, selectedNewVersionId, versions } =
  storeToRefs(store);

function getVersionLabel(versionId: string): string {
  const v = versions.value.find((v) => v.id === versionId);
  if (!v) return "";
  return v.commit_msg ? `v${v.version_num}: ${v.commit_msg}` : `v${v.version_num}`;
}

function handleCompare() {
  store.compareVersions();
}

function handleClear() {
  store.diffResult = null;
}

function getChangePercent(): string {
  if (!diffResult.value) return "0%";
  const total = diffResult.value.hunks.length;
  if (total === 0) return "0%";
  const changes = diffResult.value.additions + diffResult.value.deletions;
  return ((changes / total) * 100).toFixed(1) + "%";
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
        Diff 比对
      </h3>
      <button
        v-if="diffResult"
        class="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        @click="handleClear"
        title="清除对比结果"
      >
        清除
      </button>
    </div>

    <!-- 等待状态（未选择版本） -->
    <div
      v-if="!loading.diff && !diffResult && !hasSelectedVersions"
      class="text-center py-8 text-gray-500 text-sm"
    >
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
          d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
        />
      </svg>
      <p class="mb-1">选择两个版本进行对比</p>
      <p class="text-xs text-gray-600">在版本历史中分别选择旧版和新版</p>
    </div>

    <!-- 等待状态（已选版本，未触发比较） -->
    <div
      v-else-if="!loading.diff && !diffResult && hasSelectedVersions"
      class="text-center py-8 text-gray-500 text-sm"
    >
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
          d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
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
      <button
        class="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="!canDiff"
        @click="handleCompare"
      >
        开始对比
      </button>
      <p v-if="!canDiff && selectedOldVersionId === selectedNewVersionId" class="mt-2 text-xs text-yellow-500">
        请选择两个不同的版本
      </p>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading.diff" class="space-y-2 animate-pulse">
      <!-- 统计骨架 -->
      <div class="flex gap-2">
        <div class="h-8 w-16 bg-gray-800 rounded-lg"></div>
        <div class="h-8 w-16 bg-gray-800 rounded-lg"></div>
        <div class="h-8 w-16 bg-gray-800 rounded-lg"></div>
      </div>
      <!-- 行骨架 -->
      <div v-for="i in 6" :key="i" class="flex gap-2">
        <div
          class="h-5 rounded"
          :class="[
            i % 3 === 1 ? 'w-full bg-green-900/40' :
            i % 3 === 2 ? 'w-3/4 bg-red-900/40' :
            'w-5/6 bg-gray-800',
          ]"
        ></div>
      </div>
    </div>

    <!-- 空状态（对比完成，无差异） -->
    <div
      v-else-if="diffResult && diffResult.hunks.length === 0"
      class="text-center py-8 text-gray-500 text-sm"
    >
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
          d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      <p class="mb-1">两个版本内容相同</p>
      <p class="text-xs text-gray-600">未发现任何差异</p>
    </div>

    <!-- 正常状态（显示 Diff） -->
    <div v-else-if="diffResult && diffResult.hunks.length > 0" class="space-y-2">
      <!-- 统计信息 -->
      <div class="flex items-center gap-3 text-xs">
        <div class="flex items-center gap-1 px-2 py-1 rounded bg-green-900/30 text-green-400">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
          <span class="font-medium">{{ diffResult.additions }}</span>
          <span class="text-green-600">新增</span>
        </div>
        <div class="flex items-center gap-1 px-2 py-1 rounded bg-red-900/30 text-red-400">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
          </svg>
          <span class="font-medium">{{ diffResult.deletions }}</span>
          <span class="text-red-600">删除</span>
        </div>
        <div class="flex items-center gap-1 px-2 py-1 rounded bg-gray-800 text-gray-400">
          <span class="text-gray-600">变更率</span>
          <span class="font-medium">{{ getChangePercent() }}</span>
        </div>
      </div>

      <!-- 变更概览条 -->
      <div class="flex h-1.5 rounded-full overflow-hidden bg-gray-800">
        <div
          v-if="diffResult.additions > 0"
          class="bg-green-500 transition-all"
          :style="{ width: (diffResult.additions / (diffResult.additions + diffResult.deletions) * 100) + '%' }"
        ></div>
        <div
          v-if="diffResult.deletions > 0"
          class="bg-red-500 transition-all"
          :style="{ width: (diffResult.deletions / (diffResult.additions + diffResult.deletions) * 100) + '%' }"
        ></div>
      </div>

      <!-- 版本标签 -->
      <div class="flex items-center gap-2 text-xs text-gray-500">
        <span class="inline-flex items-center gap-1">
          <span class="w-2 h-2 rounded-full bg-blue-500"></span>
          旧版: {{ getVersionLabel(selectedOldVersionId) }}
        </span>
        <span class="text-gray-700">|</span>
        <span class="inline-flex items-center gap-1">
          <span class="w-2 h-2 rounded-full bg-green-500"></span>
          新版: {{ getVersionLabel(selectedNewVersionId) }}
        </span>
      </div>

      <!-- Diff 行 -->
      <div class="font-mono text-xs border border-gray-800 rounded-lg overflow-hidden">
        <div
          v-for="(hunk, i) in diffResult.hunks"
          :key="i"
          class="flex leading-5"
          :class="{
            'bg-green-950/40 border-l-2 border-green-600': hunk.tag === 'insert',
            'bg-red-950/40 border-l-2 border-red-600': hunk.tag === 'delete',
            'bg-transparent border-l-2 border-transparent hover:bg-gray-900/30': hunk.tag === 'equal',
          }"
        >
          <!-- 行号或符号 -->
          <span
            class="flex-shrink-0 w-7 text-right select-none"
            :class="{
              'text-green-500': hunk.tag === 'insert',
              'text-red-500': hunk.tag === 'delete',
              'text-gray-600': hunk.tag === 'equal',
            }"
          >
            {{ hunk.tag === 'insert' ? '+' : hunk.tag === 'delete' ? '-' : ' ' }}
          </span>
          <!-- 内容 -->
          <span
            class="flex-1 whitespace-pre-wrap px-1"
            :class="{
              'text-green-200': hunk.tag === 'insert',
              'text-red-200': hunk.tag === 'delete',
              'text-gray-300': hunk.tag === 'equal',
            }"
          >{{ hunk.content }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
