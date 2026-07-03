<script setup lang="ts">
import { ref, watch } from "vue";
import { useDocumentStore } from "../stores/document";
import { storeToRefs } from "pinia";

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

/** Local error tracking scoped to analysis operations */
const analysisError = ref("");

// Watch for analysis start/complete to manage error display
watch(() => loading.value.analysis, (isLoading) => {
  if (!isLoading && store.error && analysisResult.value === null) {
    analysisError.value = store.error;
  }
  if (isLoading) {
    analysisError.value = "";
  }
});

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

function handleRetry() {
  handleAnalyze();
}

/** 切换到 API 设置 Tab */
function goToSettings() {
  store.sidebarTab = "settings";
}

/** 总体评议 verdict 样式 */
function verdictClass(verdict: string): string {
  if (verdict.includes("提升")) return "bg-green-900/50 text-green-300";
  if (verdict.includes("退步")) return "bg-red-900/50 text-red-300";
  if (verdict.includes("持平")) return "bg-gray-700 text-gray-300";
  return "bg-gray-700 text-gray-300";
}

/** 评分 delta 样式 */
function deltaClass(delta: string): string {
  if (delta.startsWith("+")) return "bg-green-900/50 text-green-300";
  if (delta.startsWith("-")) return "bg-red-900/50 text-red-300";
  return "bg-gray-700 text-gray-400";
}

/** 修改类型 badge 样式 */
function modBadgeClass(type: string): string {
  if (type === "优化型") return "bg-green-900/50 text-green-300";
  if (type === "退化型") return "bg-red-900/50 text-red-300";
  if (type === "冗余型") return "bg-gray-700 text-gray-400";
  return "bg-blue-900/50 text-blue-300"; // 调整型
}

/** 优先级样式 */
function priorityClass(priority: string): string {
  if (priority === "高") return "bg-red-900/50 text-red-300";
  if (priority === "中") return "bg-amber-900/50 text-amber-300";
  return "bg-gray-700 text-gray-400";
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider">
        AI 分析
      </h3>
      <button
        v-if="analysisResult"
        class="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        @click="handleClear"
        title="清除分析结果"
      >
        清除
      </button>
    </div>

    <!-- 加载状态 -->
    <template v-if="loading.analysis">
      <div class="space-y-3 animate-pulse">
        <div class="space-y-1">
          <div class="h-5 w-20 bg-purple-900/50 rounded mb-2"></div>
          <div class="h-10 bg-purple-900/30 rounded-xl"></div>
        </div>
        <div class="space-y-1">
          <div class="h-4 w-16 bg-green-900/50 rounded mb-2"></div>
          <div class="h-5 bg-green-900/30 rounded"></div>
          <div class="h-5 w-5/6 bg-green-900/30 rounded"></div>
        </div>
        <div class="space-y-1">
          <div class="h-4 w-16 bg-red-900/50 rounded mb-2"></div>
          <div class="h-5 bg-red-900/30 rounded"></div>
          <div class="h-5 w-3/4 bg-red-900/30 rounded"></div>
        </div>
        <div class="space-y-1">
          <div class="h-4 w-16 bg-blue-900/50 rounded mb-2"></div>
          <div class="h-5 bg-blue-900/30 rounded"></div>
          <div class="h-5 w-5/6 bg-blue-900/30 rounded"></div>
        </div>
      </div>
    </template>

    <!-- 分析结果 -->
    <template v-else-if="analysisResult">
      <div class="space-y-3">
        <!-- ── 总体评议 ── -->
        <div class="bg-gradient-to-br from-purple-950/40 to-gray-950/30 rounded-xl border border-purple-800/30 overflow-hidden">
          <div class="px-3 py-1.5 bg-purple-900/30 flex items-center justify-between">
            <div class="flex items-center gap-1.5 text-xs font-semibold text-purple-300">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              总体评议
            </div>
            <span
              class="text-[11px] px-1.5 py-0.5 rounded font-medium"
              :class="verdictClass(analysisResult.overall_assessment.verdict)"
            >
              {{ analysisResult.overall_assessment.verdict }}
            </span>
          </div>
          <div class="p-3 space-y-2">
            <!-- 评分对比 -->
            <div class="flex items-center justify-center gap-2">
              <div class="flex flex-col items-center">
                <span class="text-[10px] text-gray-500">旧版</span>
                <span class="text-xl font-bold text-gray-300">{{ analysisResult.overall_assessment.score_old }}</span>
              </div>
              <svg class="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
              <div class="flex flex-col items-center">
                <span class="text-[10px] text-gray-500">新版</span>
                <span class="text-xl font-bold text-purple-300">{{ analysisResult.overall_assessment.score_new }}</span>
              </div>
              <span
                class="text-xs px-1.5 py-0.5 rounded font-mono ml-1"
                :class="deltaClass(analysisResult.overall_assessment.delta)"
              >
                {{ analysisResult.overall_assessment.delta }}
              </span>
            </div>
            <p class="text-xs text-gray-300 leading-relaxed">{{ analysisResult.overall_assessment.summary }}</p>
          </div>
        </div>

        <!-- ── 主旨与思想站位 ── -->
        <div class="bg-indigo-950/20 rounded-lg border border-indigo-800/20 p-3 space-y-2">
          <div class="flex items-center gap-1.5 text-xs font-semibold text-indigo-300">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
            主旨与思想站位
          </div>
          <div class="space-y-1.5 text-xs text-gray-300">
            <div v-if="analysisResult.ideological_analysis.elevation !== '无明显变化'">
              <span class="text-indigo-400 font-medium">主旨提升：</span>{{ analysisResult.ideological_analysis.elevation }}
            </div>
            <div>
              <span class="text-indigo-400 font-medium">站位评价：</span>{{ analysisResult.ideological_analysis.positioning }}
            </div>
            <div>
              <span class="text-indigo-400 font-medium">深度视野：</span>{{ analysisResult.ideological_analysis.depth }}
            </div>
            <div v-if="analysisResult.ideological_analysis.risk !== '无'" class="flex items-start gap-1 text-yellow-300">
              <svg class="w-3 h-3 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <span><span class="font-medium">风险提示：</span>{{ analysisResult.ideological_analysis.risk }}</span>
            </div>
          </div>
        </div>

        <!-- ── 逻辑分析 ── -->
        <div v-if="(analysisResult.logic_analysis.strengths?.length || analysisResult.logic_analysis.weaknesses?.length)" class="space-y-2">
          <div class="flex items-center gap-1.5 text-xs font-semibold text-cyan-300">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
            </svg>
            逻辑分析
          </div>
          <ul v-if="analysisResult.logic_analysis.strengths?.length" class="space-y-1">
            <li v-for="(item, i) in analysisResult.logic_analysis.strengths" :key="'ls'+i" class="flex items-start gap-1.5 text-xs text-green-200">
              <span class="text-green-400 mt-0.5">✓</span><span>{{ item }}</span>
            </li>
          </ul>
          <ul v-if="analysisResult.logic_analysis.weaknesses?.length" class="space-y-1">
            <li v-for="(item, i) in analysisResult.logic_analysis.weaknesses" :key="'lw'+i" class="flex items-start gap-1.5 text-xs text-red-200">
              <span class="text-red-400 mt-0.5">✗</span><span>{{ item }}</span>
            </li>
          </ul>
        </div>

        <!-- ── 深度洞察 ── -->
        <div v-if="(analysisResult.insight_analysis.added_value?.length || analysisResult.insight_analysis.hollow_parts?.length)" class="bg-emerald-950/20 rounded-lg border border-emerald-800/20 p-3 space-y-2">
          <div class="flex items-center gap-1.5 text-xs font-semibold text-emerald-300">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            深度洞察
          </div>
          <div v-if="analysisResult.insight_analysis.added_value?.length" class="space-y-1">
            <div class="text-[10px] text-emerald-400 font-medium">新增洞见</div>
            <ul class="space-y-0.5">
              <li v-for="(item, i) in analysisResult.insight_analysis.added_value" :key="'av'+i" class="flex items-start gap-1.5 text-xs text-emerald-200">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 mt-1.5 flex-shrink-0"></span><span>{{ item }}</span>
              </li>
            </ul>
          </div>
          <div v-if="analysisResult.insight_analysis.hollow_parts?.length" class="space-y-1">
            <div class="text-[10px] text-orange-400 font-medium">空话/套话</div>
            <ul class="space-y-0.5">
              <li v-for="(item, i) in analysisResult.insight_analysis.hollow_parts" :key="'hp'+i" class="flex items-start gap-1.5 text-xs text-orange-200">
                <span class="w-1.5 h-1.5 rounded-full bg-orange-400 mt-1.5 flex-shrink-0"></span><span>{{ item }}</span>
              </li>
            </ul>
          </div>
        </div>

        <!-- ── 表达分析 ── -->
        <div v-if="(analysisResult.expression_analysis.highlights?.length || analysisResult.expression_analysis.issues?.length)" class="space-y-2">
          <div class="flex items-center gap-1.5 text-xs font-semibold text-rose-300">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
            </svg>
            表达分析
          </div>
          <ul v-if="analysisResult.expression_analysis.highlights?.length" class="space-y-1">
            <li v-for="(item, i) in analysisResult.expression_analysis.highlights" :key="'eh'+i" class="flex items-start gap-1.5 text-xs text-green-200 bg-green-950/30 px-2 py-1.5 rounded border border-green-900/20">
              <span class="text-green-400 mt-0.5">✦</span><span>{{ item }}</span>
            </li>
          </ul>
          <ul v-if="analysisResult.expression_analysis.issues?.length" class="space-y-1">
            <li v-for="(item, i) in analysisResult.expression_analysis.issues" :key="'ei'+i" class="flex items-start gap-1.5 text-xs text-red-200 bg-red-950/30 px-2 py-1.5 rounded border border-red-900/20">
              <span class="text-red-400 mt-0.5">✦</span><span>{{ item }}</span>
            </li>
          </ul>
        </div>

        <!-- ── 修改分类 ── -->
        <div v-if="analysisResult.modification_breakdown?.length" class="space-y-2">
          <div class="flex items-center gap-1.5 text-xs font-semibold text-gray-300">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            修改分类
          </div>
          <div class="space-y-1.5">
            <div v-for="(mod, i) in analysisResult.modification_breakdown" :key="'mb'+i" class="bg-gray-900/60 rounded-lg border border-gray-800 px-2.5 py-2 space-y-1">
              <div class="flex items-start gap-1.5">
                <span
                  class="text-[10px] px-1 py-0 rounded font-medium flex-shrink-0 mt-0.5"
                  :class="modBadgeClass(mod.type)"
                >
                  {{ mod.type }}
                </span>
                <span class="text-xs text-gray-300 break-words leading-relaxed">{{ mod.example }}</span>
              </div>
              <p class="text-[11px] text-gray-500 leading-relaxed">{{ mod.reason }}</p>
            </div>
          </div>
        </div>

        <!-- ── 维度对比 ── -->
        <div v-if="analysisResult.comparison?.length" class="space-y-1.5">
          <div class="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
            </svg>
            维度对比
          </div>
          <ul class="space-y-1">
            <li v-for="(item, i) in analysisResult.comparison" :key="'cmp'+i" class="flex items-start gap-1.5 text-xs text-gray-300 bg-amber-950/20 px-2.5 py-1.5 rounded border border-amber-900/20">
              <span class="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 flex-shrink-0"></span><span>{{ item }}</span>
            </li>
          </ul>
        </div>

        <!-- ── 改进建议 ── -->
        <div v-if="analysisResult.revision_suggestions?.length" class="space-y-2">
          <div class="flex items-center gap-1.5 text-xs font-semibold text-sky-300">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            改进建议
          </div>
          <div class="space-y-2">
            <div v-for="(sug, i) in analysisResult.revision_suggestions" :key="'sug'+i" class="bg-sky-950/20 rounded-lg border border-sky-800/20 p-2.5 space-y-1.5">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span
                  class="text-[10px] px-1 py-0 rounded font-medium"
                  :class="priorityClass(sug.priority)"
                >
                  {{ sug.priority }}
                </span>
                <span
                  class="text-[10px] px-1 py-0 rounded bg-gray-700 text-gray-300"
                >
                  {{ sug.category }}
                </span>
                <span class="text-[10px] text-gray-500 truncate flex-1">{{ sug.target }}</span>
              </div>
              <p class="text-xs text-sky-200 leading-relaxed">{{ sug.advice }}</p>
              <p class="text-[11px] text-gray-500 leading-relaxed">{{ sug.rationale }}</p>
            </div>
          </div>
        </div>

        <!-- 版本信息 -->
        <div class="flex items-center gap-2 text-[10px] text-gray-600 pt-1 border-t border-gray-800">
          <span>{{ getVersionLabel(selectedOldVersionId) }} &rarr; {{ getVersionLabel(selectedNewVersionId) }}</span>
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
            @click="goToSettings"
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

      <!-- 分析错误提示 -->
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
