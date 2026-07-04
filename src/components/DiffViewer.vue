<script setup lang="ts">
import { computed } from "vue";
import { useDocumentStore } from "../stores/document";
import { storeToRefs } from "pinia";
import type { DiffHunk } from "../stores/document";

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

/// 变更块：收集连续 delete → 收集连续 insert → 1:1 配对，多余独立
interface ChangeBlock {
  kind: "modified" | "deleted" | "inserted";
  deleted?: DiffHunk;
  inserted?: DiffHunk;
}

const changeBlocks = computed<ChangeBlock[]>(() => {
  if (!diffResult.value) return [];
  const hunks = diffResult.value.hunks;
  const blocks: ChangeBlock[] = [];
  let i = 0;

  while (i < hunks.length) {
    // 跳过前导 equal 行
    while (i < hunks.length && hunks[i].tag === "equal") { i++; }
    if (i >= hunks.length) break;

    // 收集同一组变更内的所有 delete 和 insert（忽略中间的 equal 行）
    const deletes: DiffHunk[] = [];
    const inserts: DiffHunk[] = [];
    let merging = true;

    while (merging && i < hunks.length) {
      while (i < hunks.length && hunks[i].tag === "delete") { deletes.push(hunks[i++]); }
      while (i < hunks.length && hunks[i].tag === "insert") { inserts.push(hunks[i++]); }

      // 向前看：跳过 equal 后是否还有 delete/insert 需要合并？
      let peek = i;
      while (peek < hunks.length && hunks[peek].tag === "equal") { peek++; }
      if (peek < hunks.length && (hunks[peek].tag === "delete" || hunks[peek].tag === "insert")) {
        i = peek; // 跳过中间的 equal 上下文，继续收集
      } else {
        merging = false;
      }
    }

    // 跳过尾部 equal 行
    while (i < hunks.length && hunks[i].tag === "equal") { i++; }

    // 配对
    const paired = Math.min(deletes.length, inserts.length);
    for (let p = 0; p < paired; p++) {
      blocks.push({ kind: "modified", deleted: deletes[p], inserted: inserts[p] });
    }
    for (let p = paired; p < deletes.length; p++) {
      blocks.push({ kind: "deleted", deleted: deletes[p] });
    }
    for (let p = paired; p < inserts.length; p++) {
      blocks.push({ kind: "inserted", inserted: inserts[p] });
    }
  }

  return blocks;
});
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wider">
        Diff 比对
      </h3>
      <button
        v-if="diffResult"
        class="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
        @click="handleClear"
        title="清除对比结果"
      >
        清除
      </button>
    </div>

    <!-- 等待状态（未选择版本） -->
    <div
      v-if="!loading.diff && !diffResult && !hasSelectedVersions"
      class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm"
    >
      <svg class="w-10 h-10 mx-auto mb-3 text-gray-500 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
          d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
        />
      </svg>
      <p class="mb-1">选择两个版本进行对比</p>
      <p class="text-xs text-gray-500 dark:text-gray-600">在版本历史中分别选择旧版和新版</p>
    </div>

    <!-- 等待状态（已选版本，未触发比较） -->
    <div
      v-else-if="!loading.diff && !diffResult && hasSelectedVersions"
      class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm"
    >
      <svg class="w-10 h-10 mx-auto mb-3 text-gray-500 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
          d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
        />
      </svg>
      <p class="mb-2 text-xs text-gray-600 dark:text-gray-400">
        <span class="inline-block px-1.5 py-0.5 rounded bg-blue-400/25 text-gray-800 dark:text-gray-200 text-xs mr-1">旧版</span>
        {{ getVersionLabel(selectedOldVersionId) }}
      </p>
      <p class="mb-3 text-xs text-gray-600 dark:text-gray-400">
        <span class="inline-block px-1.5 py-0.5 rounded bg-green-400/25 text-gray-800 dark:text-gray-200 text-xs mr-1">新版</span>
        {{ getVersionLabel(selectedNewVersionId) }}
      </p>
      <button
        class="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        :disabled="!canDiff"
        @click="handleCompare"
      >
        开始对比
      </button>
      <p v-if="!canDiff && selectedOldVersionId === selectedNewVersionId" class="mt-2 text-xs text-yellow-700 dark:text-yellow-500">
        请选择两个不同的版本
      </p>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading.diff" class="space-y-2 animate-pulse">
      <div class="flex gap-2">
        <div class="h-7 w-16 rounded bg-gray-100 dark:bg-gray-800"></div>
        <div class="h-7 w-16 rounded bg-gray-100 dark:bg-gray-800"></div>
        <div class="h-7 w-14 rounded bg-gray-100 dark:bg-gray-800"></div>
      </div>
      <div class="space-y-1.5">
        <div v-for="i in 5" :key="i" class="h-10 rounded bg-gray-100 dark:bg-slate-800/40"></div>
      </div>
    </div>

    <!-- 空状态（无差异） -->
    <div
      v-else-if="diffResult && diffResult.hunks.length === 0"
      class="text-center py-8 text-gray-400 dark:text-gray-500 text-sm"
    >
      <svg class="w-10 h-10 mx-auto mb-3 text-gray-500 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <p class="mb-1">两个版本内容相同</p>
      <p class="text-xs text-gray-500 dark:text-gray-600">未发现任何差异</p>
    </div>

    <!-- 正常状态（显示 Diff） -->
    <div v-else-if="diffResult && diffResult.hunks.length > 0" class="space-y-2">
      <!-- 统计信息 + 版本 + 分割线 -->
      <div class="space-y-2">
        <!-- 统计信息：三列平均分布 -->
        <div class="grid grid-cols-3 gap-2">
          <div class="flex items-center justify-center gap-1 px-2 py-1 rounded text-xs bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-500/20">
            <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
            <span class="font-semibold">{{ diffResult.additions }}</span>
            <span class="text-amber-600 dark:text-amber-400/70 whitespace-nowrap">新增</span>
          </div>
          <div class="flex items-center justify-center gap-1 px-2 py-1 rounded text-xs bg-emerald-100 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-500/20">
            <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
            </svg>
            <span class="font-semibold">{{ diffResult.deletions }}</span>
            <span class="text-emerald-600 dark:text-emerald-400/70 whitespace-nowrap">删除</span>
          </div>
          <div class="flex items-center justify-center gap-1 px-2 py-1 rounded text-xs bg-gray-100 dark:bg-slate-700/30 text-gray-700 dark:text-slate-300 border border-gray-200 dark:border-slate-600/30">
            <span class="text-gray-400 dark:text-slate-500 whitespace-nowrap">变更</span>
            <span class="font-semibold">{{ changeBlocks.length }}</span>
            <span class="text-gray-400 dark:text-slate-500 whitespace-nowrap">处</span>
          </div>
        </div>

        <!-- 版本流向：无底色 -->
        <div class="flex items-center justify-center">
          <span class="inline-flex items-center gap-1.5 text-[10px] text-gray-400 dark:text-slate-400 whitespace-nowrap">
            {{ getVersionLabel(selectedOldVersionId) }}
            <span class="text-gray-500 dark:text-slate-600">→</span>
            {{ getVersionLabel(selectedNewVersionId) }}
          </span>
        </div>

        <!-- 分割线 -->
        <div class="h-px bg-gradient-to-r from-transparent via-gray-300 dark:via-slate-600/30 to-transparent"></div>
      </div>

      <!-- 变更列表 -->
      <div class="flex flex-col gap-1.5 pr-1">
        <div
          v-for="(block, bi) in changeBlocks"
          :key="bi"
          class="rounded-md border border-gray-200 dark:border-slate-700/30 overflow-hidden bg-gray-50 dark:bg-slate-800/20"
        >
          <!-- 修改块：先删后增 -->
          <template v-if="block.kind === 'modified' && block.deleted && block.inserted">
            <!-- 删除行：翠绿 -->
            <div class="flex items-stretch text-[13px] leading-relaxed border-b border-emerald-300 dark:border-emerald-500/10 bg-emerald-100 dark:bg-emerald-500/[0.03]">
              <div class="w-6 flex items-start justify-center border-l-2 border-emerald-300 dark:border-emerald-500 py-1.5">
                <span class="text-emerald-600/80 dark:text-emerald-400/80 font-medium select-none">-</span>
              </div>
              <div class="flex-1 py-1.5 pr-3 font-mono text-gray-600 dark:text-slate-300 whitespace-pre-wrap break-all">
                <template v-if="block.deleted.inline_changes && block.deleted.inline_changes.length > 0">
                  <span
                    v-for="(chunk, ci) in block.deleted.inline_changes"
                    :key="ci"
                    :class="{
                      'bg-emerald-400/20 text-emerald-800 dark:text-emerald-100 px-0.5 rounded line-through decoration-emerald-500/50': chunk.tag === 'delete',
                      'text-gray-400 dark:text-slate-500': chunk.tag === 'equal',
                    }"
                  >{{ chunk.content }}</span>
                </template>
                <span v-else class="line-through decoration-emerald-500/40 text-gray-400 dark:text-slate-500">{{ block.deleted.content }}</span>
              </div>
            </div>
            <!-- 新增行：琥珀 -->
            <div class="flex items-stretch text-[13px] leading-relaxed bg-amber-100 dark:bg-amber-500/[0.03]">
              <div class="w-6 flex items-start justify-center border-l-2 border-amber-300 dark:border-amber-500 py-1.5">
                <span class="text-amber-600/80 dark:text-amber-400/80 font-medium select-none">+</span>
              </div>
              <div class="flex-1 py-1.5 pr-3 font-mono text-gray-700 dark:text-slate-200 whitespace-pre-wrap break-all">
                <template v-if="block.inserted.inline_changes && block.inserted.inline_changes.length > 0">
                  <span
                    v-for="(chunk, ci) in block.inserted.inline_changes"
                    :key="ci"
                    :class="{
                      'bg-amber-400/20 text-amber-800 dark:text-amber-100 px-0.5 rounded': chunk.tag === 'insert',
                      'text-gray-400 dark:text-slate-500': chunk.tag === 'equal',
                    }"
                  >{{ chunk.content }}</span>
                </template>
                <span v-else>{{ block.inserted.content }}</span>
              </div>
            </div>
          </template>

          <!-- 纯删除块：翠绿 -->
          <template v-else-if="block.kind === 'deleted' && block.deleted">
            <div class="flex items-stretch text-[13px] leading-relaxed bg-emerald-100 dark:bg-emerald-500/[0.03]">
              <div class="w-6 flex items-start justify-center border-l-2 border-emerald-300 dark:border-emerald-500 py-1.5">
                <span class="text-emerald-600/80 dark:text-emerald-400/80 font-medium select-none">-</span>
              </div>
              <div class="flex-1 py-1.5 pr-3 font-mono text-gray-600 dark:text-slate-300 whitespace-pre-wrap break-all">
                <template v-if="block.deleted.inline_changes && block.deleted.inline_changes.length > 0">
                  <span
                    v-for="(chunk, ci) in block.deleted.inline_changes"
                    :key="ci"
                    :class="{
                      'bg-emerald-400/20 text-emerald-800 dark:text-emerald-100 px-0.5 rounded': chunk.tag === 'delete',
                      'text-gray-400 dark:text-slate-500': chunk.tag === 'equal',
                    }"
                  >{{ chunk.content }}</span>
                </template>
                <span v-else class="text-gray-400 dark:text-slate-500">{{ block.deleted.content }}</span>
              </div>
            </div>
          </template>

          <!-- 纯新增块：琥珀 -->
          <template v-else-if="block.kind === 'inserted' && block.inserted">
            <div class="flex items-stretch text-[13px] leading-relaxed bg-amber-100 dark:bg-amber-500/[0.03]">
              <div class="w-6 flex items-start justify-center border-l-2 border-amber-300 dark:border-amber-500 py-1.5">
                <span class="text-amber-600/80 dark:text-amber-400/80 font-medium select-none">+</span>
              </div>
              <div class="flex-1 py-1.5 pr-3 font-mono text-gray-700 dark:text-slate-200 whitespace-pre-wrap break-all">
                <template v-if="block.inserted.inline_changes && block.inserted.inline_changes.length > 0">
                  <span
                    v-for="(chunk, ci) in block.inserted.inline_changes"
                    :key="ci"
                    :class="{
                      'bg-amber-400/20 text-amber-800 dark:text-amber-100 px-0.5 rounded': chunk.tag === 'insert',
                      'text-gray-400 dark:text-slate-500': chunk.tag === 'equal',
                    }"
                  >{{ chunk.content }}</span>
                </template>
                <span v-else>{{ block.inserted.content }}</span>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
