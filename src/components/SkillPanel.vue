<script setup lang="ts">
import { ref, onMounted, computed, nextTick, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDocumentStore } from "../stores/document";
import { useMaterialStore } from "../stores/materialStore";
import { storeToRefs } from "pinia";
import { computeDiff, type DiffChunk } from "../utils/diff";
import { useTheme } from "../stores/theme";

const { isDark } = useTheme();

// 呼吸灯带主题色
const breathTrackBg = computed(() => isDark.value ? 'rgba(30,41,59,0.6)' : 'rgba(0,0,0,0.08)');
const breathShimmer = computed(() => isDark.value ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.1)');
const breathSweepStyle = computed(() => `background: linear-gradient(90deg, transparent 0%, transparent 40%, ${breathShimmer.value} 50%, transparent 60%, transparent 100%); background-size: 200% 100%;`);

export interface Skill {
  id: string;
  name: string;
  category: string;
  prompt_template: string;
  output_format: string;
  temperature: number;
  is_builtin: boolean;
  is_review_use: boolean;
  sort_order: number;
  created_at: string;
}

import type { KnowledgeBase } from "../types/shared";
export type { KnowledgeBase };

const props = defineProps<{
  currentContent: string;
  selectedText?: string;
}>();

const emit = defineEmits<{
  /** 请求获取选中文本 */
  "request-selected-text": [];
}>();

const skills = ref<Skill[]>([]);
const knowledgeBases = ref<KnowledgeBase[]>([]);
const loading = ref({ list: false, run: "" });
const error = ref("");
const resultMap = ref<Record<string, string>>({});
const expandedMap = ref<Record<string, boolean>>({});

// 每个技能关联的知识库 ID 集合
const skillKbSelection = ref<Record<string, string[]>>({});
const showKbPicker = ref(""); // 正在显示 KB 选择器的技能 id

// 素材库标签（全局共享，不按技能区分）
const matStore = useMaterialStore();

// 新增技能表单
const showAddForm = ref(false);
const newSkillForm = ref({ name: "", category: "custom" as string, prompt_template: "", temperature: 0.7 });
const savingNew = ref(false);

// 编辑技能
const editingSkillId = ref("");
const editSkillForm = ref({ name: "", category: "custom", prompt_template: "", temperature: 0.7 });
const savingEdit = ref(false);

// ─── 技能组合管道 ───
const pipeline = ref<Skill[]>([]);
const pipelineExpanded = ref(false);
const pipelineRunning = ref(false);
const pipelineCurrentStep = ref(0);
const pipelineTotalSteps = ref(0);
const showPipelineSkillPicker = ref(false);
let pipelineUnlisten: (() => void) | null = null;
let pipelineInvokePromise: Promise<string> | null = null; // 跟踪后端调用是否结束

// 结束后才展示的单次 diff
const finalDiff = ref<{ diffChunks: DiffChunk[]; changeCount: number } | null>(null);

interface DiffSegment {
  text: string;
  red: boolean;
  strike: boolean;
}

/** 将 diff chunk 展平为显示片段，对 replace 块做子 diff 只标真正改变的字 */
function flattenDiffForDisplay(chunks: DiffChunk[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const c of chunks) {
    if (c.kind === "keep") {
      out.push({ text: c.oldText, red: false, strike: false });
    } else if (c.kind === "insert") {
      out.push({ text: c.newText, red: true, strike: false });
    } else if (c.kind === "delete") {
      out.push({ text: c.oldText, red: false, strike: true });
    } else {
      // replace → 子 diff，精确标红
      const subs = computeDiff(c.oldText, c.newText);
      for (const s of subs) {
        if (s.kind === "keep") {
          out.push({ text: s.oldText, red: false, strike: false });
        } else if (s.kind === "insert") {
          out.push({ text: s.newText, red: true, strike: false });
        } else if (s.kind === "delete") {
          out.push({ text: s.oldText, red: false, strike: true });
        } else {
          // 嵌套 replace
          if (s.oldText) out.push({ text: s.oldText, red: false, strike: true });
          if (s.newText) out.push({ text: s.newText, red: true, strike: false });
        }
      }
    }
  }
  return out;
}

const displayDiffSegments = computed(() => {
  if (!finalDiff.value) return [];
  return flattenDiffForDisplay(finalDiff.value.diffChunks);
});

const categoryLabels: Record<string, string> = {
  correction: "纠错",
  polish: "润色",
  creative: "创意",
  custom: "自定义",
};

const categoryColors: Record<string, string> = {
  correction: "text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-950/30",
  polish: "text-yellow-600 dark:text-yellow-400 bg-yellow-950/30",
  creative: "text-purple-600 dark:text-purple-400 bg-purple-100 dark:bg-purple-950/30",
  custom: "text-blue-400 dark:text-blue-300 bg-blue-100 dark:bg-blue-950/30",
};

const groupedSkills = computed(() => {
  const groups: Record<string, Skill[]> = {};
  for (const s of skills.value) {
    const cat = s.category || "custom";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(s);
  }
  return groups;
});

onMounted(async () => {
  await Promise.all([loadSkills(), loadKnowledgeBases(), matStore.loadTagWithCounts()]);
});

async function loadSkills() {
  loading.value.list = true;
  error.value = "";
  try {
    skills.value = await invoke<Skill[]>("list_skills");
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value.list = false;
  }
}

async function loadKnowledgeBases() {
  try {
    knowledgeBases.value = await invoke<KnowledgeBase[]>("list_knowledge_bases");
  } catch {
    // 知识库加载失败不阻塞主流程
  }
}

// 切换到「技能」Tab 时刷新知识库列表（用户在知识库面板增删后切回来可看到最新数据）
const docStore = useDocumentStore();
const { sidebarTab, dataVersion: skillDataVersion } = storeToRefs(docStore);
watch(sidebarTab, (tab) => {
  if (tab === "skills") {
    loadKnowledgeBases();
    matStore.loadTagWithCounts();
  }
});
watch(skillDataVersion, () => {
  loadSkills();
});

async function runSkill(skill: Skill) {
  if (!props.currentContent && !props.selectedText) return;

  // 先请求获取选中文本，等待 prop 更新
  emit("request-selected-text");
  await nextTick();

  loading.value.run = skill.id;
  error.value = "";
  // 流式初始化
  resultMap.value[skill.id] = '';
  expandedMap.value[skill.id] = true;

  try {
    const kbIds = skillKbSelection.value[skill.id] || [];
    const eventId = crypto.randomUUID()
    const unlisten = await listen<{ token?: string; done?: boolean }>(`ai-stream-${eventId}`, (event) => {
      if (event.payload.token && !event.payload.done) {
        resultMap.value[skill.id] += event.payload.token
      }
      if (event.payload.token && event.payload.done) {
        // 非流式一次性返回（如精神融入技能），直接覆盖
        resultMap.value[skill.id] = event.payload.token
      }
    })

    await invoke<string>("run_skill_streaming", {
      skillId: skill.id,
      content: props.currentContent,
      selectedText: props.selectedText || null,
      knowledgeBaseIds: kbIds.length > 0 ? kbIds : null,
      materialTagIds: matStore.selectedMaterialTagIds.length > 0 ? matStore.selectedMaterialTagIds : null,
      eventId,
    });

    unlisten()
  } catch (e) {
    error.value = String(e);
    resultMap.value[skill.id] = '（执行失败）';
  } finally {
    loading.value.run = "";
  }
}

function toggleKbPicker(skillId: string) {
  showKbPicker.value = showKbPicker.value === skillId ? "" : skillId;
}

function toggleKbForSkill(skillId: string, kbId: string) {
  if (!skillKbSelection.value[skillId]) {
    skillKbSelection.value[skillId] = [];
  }
  const arr = skillKbSelection.value[skillId];
  const idx = arr.indexOf(kbId);
  if (idx >= 0) {
    arr.splice(idx, 1);
  } else {
    arr.push(kbId);
  }
}

function getSelectedKbCount(skillId: string): number {
  return (skillKbSelection.value[skillId] || []).length;
}

function toggleResult(skillId: string) {
  expandedMap.value[skillId] = !expandedMap.value[skillId];
}

// ─── 技能组合管道操作 ───

function addToPipeline(skill: Skill) {
  pipeline.value.push(skill);
  showPipelineSkillPicker.value = false;
  pipelineExpanded.value = true;
}

function removeFromPipeline(idx: number) {
  pipeline.value.splice(idx, 1);
}

function clearPipeline() {
  pipeline.value = [];
  pipelineCurrentStep.value = 0;
  finalDiff.value = null;
}

async function runPipeline() {
  if (!props.currentContent && !props.selectedText) return;
  if (pipeline.value.length === 0) return;
  if (pipelineRunning.value) return; // 防止并发执行

  emit("request-selected-text");
  await nextTick();

  pipelineRunning.value = true;
  pipelineCurrentStep.value = 0;
  pipelineTotalSteps.value = pipeline.value.length;
  finalDiff.value = null;
  pipelineExpanded.value = true;

  const originalText = props.selectedText || props.currentContent;
  let accumulated = "";

  const eventId = crypto.randomUUID();
  const eventName = `ai-pipeline-${eventId}`;
  pipelineUnlisten = await listen<{
    step_start?: { step: number; total: number; skillId: string };
    step_done?: { step: number; total: number };
    token?: string;
    done?: boolean;
  }>(eventName, (event) => {
    const p = event.payload;
    if (p.step_start) {
      pipelineCurrentStep.value = p.step_start.step;
      accumulated = ""; // 每个步骤清空累加，避免多步骤内容叠加
    }
    if (p.token && !p.done) {
      accumulated += p.token;
    }
    if (p.done) {
      pipelineRunning.value = false;
      const chunks = computeDiff(originalText, accumulated);
      finalDiff.value = {
        diffChunks: chunks,
        changeCount: chunks.filter(c => c.kind !== 'keep').length,
      };
    }
  });

  try {
    pipelineInvokePromise = invoke<string>("run_skill_pipeline_streaming", {
      eventId,
      skillIds: pipeline.value.map((s) => s.id),
      content: props.currentContent,
      selectedText: props.selectedText || null,
      knowledgeBaseIds: null,
      materialTagIds: matStore.selectedMaterialTagIds.length > 0 ? matStore.selectedMaterialTagIds : null,
    });
    await pipelineInvokePromise;
  } catch (e) {
    pipelineRunning.value = false;
  }

  if (pipelineUnlisten) {
    pipelineUnlisten();
    pipelineUnlisten = null;
  }
  pipelineInvokePromise = null;
}

async function stopPipeline() {
  pipelineRunning.value = false;
  finalDiff.value = null;
  if (pipelineUnlisten) {
    pipelineUnlisten();
    pipelineUnlisten = null;
  }
  // 等待后端 invoke 彻底结束，避免下次执行时并发冲突
  if (pipelineInvokePromise) {
    await pipelineInvokePromise.catch(() => {});
    pipelineInvokePromise = null;
  }
}

async function handleDelete(skill: Skill) {
  try {
    await invoke("delete_skill", { skillId: skill.id });
    skills.value = skills.value.filter((s) => s.id !== skill.id);
    delete resultMap.value[skill.id];
    delete expandedMap.value[skill.id];
    delete skillKbSelection.value[skill.id];
  } catch (e) {
    error.value = String(e);
  }
}

function startEditSkill(skill: Skill) {
  editingSkillId.value = skill.id;
  editSkillForm.value = {
    name: skill.name,
    category: skill.category,
    prompt_template: skill.prompt_template,
    temperature: skill.temperature,
  };
}

async function saveEditSkill() {
  const f = editSkillForm.value;
  if (!f.name.trim() || !f.prompt_template.trim() || !editingSkillId.value) return;
  savingEdit.value = true;
  error.value = "";
  try {
    await invoke("update_skill", {
      skillId: editingSkillId.value,
      name: f.name.trim(),
      category: f.category,
      promptTemplate: f.prompt_template.trim(),
      temperature: f.temperature,
    });
    await loadSkills();
    editingSkillId.value = "";
  } catch (e) {
    error.value = String(e);
  } finally {
    savingEdit.value = false;
  }
}

function cancelEditSkill() {
  editingSkillId.value = "";
}

async function handleAddSkill() {
  const f = newSkillForm.value;
  if (!f.name.trim() || !f.prompt_template.trim()) return;
  savingNew.value = true;
  error.value = "";
  try {
    const skill = await invoke<Skill>("create_skill", {
      name: f.name.trim(),
      category: f.category,
      promptTemplate: f.prompt_template.trim(),
      temperature: f.temperature,
    });
    skills.value.push(skill);
    showAddForm.value = false;
    newSkillForm.value = { name: "", category: "custom", prompt_template: "", temperature: 0.7 };
  } catch (e) {
    error.value = String(e);
  } finally {
    savingNew.value = false;
  }
}

function renderMarkdown(text: string) {
  // 简单 Markdown 渲染（粗体、标题、列表、代码块）
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong class='font-bold text-gray-900 dark:text-gray-100'>$1</strong>")
    .replace(/### (.+)/g, "<h4 class='text-sm font-bold text-gray-800 dark:text-gray-200 mt-3 mb-1'>$1</h4>")
    .replace(/## (.+)/g, "<h3 class='text-sm font-bold text-blue-700 dark:text-blue-300 mt-4 mb-1'>$1</h3>")
    .replace(/# (.+)/g, "<h2 class='text-base font-bold text-blue-700 dark:text-blue-300 mt-4 mb-2'>$1</h2>")
    .replace(/^\- (.+)/gm, "<li class='ml-4 text-gray-700 dark:text-gray-300'>• $1</li>")
    .replace(/^(\d+)\. (.+)/gm, "<li class='ml-4 text-gray-700 dark:text-gray-300'>$1. $2</li>")
    .replace(/`([^`]+)`/g, "<code class='bg-gray-100 dark:bg-gray-800 text-yellow-700 dark:text-yellow-300 px-1 rounded text-xs'>$1</code>")
    .replace(/\n\n/g, "<br><br>")
    .replace(/\n/g, "<br>");
}
</script>

<template>
  <div class="flex flex-col h-full text-sm">
    <!-- 错误 -->
    <div
      v-if="error"
      class="mb-2 text-xs text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-950/30 border border-red-300 dark:border-red-900/30 rounded px-3 py-2"
    >
      {{ error }}
      <button class="ml-2 underline hover:text-red-600 dark:hover:text-red-300" @click="error = ''">关闭</button>
    </div>

    <!-- 提示：选中文本 vs 全文 -->
    <div class="mb-3 text-xs text-gray-400 dark:text-gray-500 bg-gray-100/60 dark:bg-gray-800/50 rounded px-3 py-2 leading-relaxed">
      <span v-if="selectedText">将对 <strong class="text-blue-400 dark:text-blue-300">选中文本</strong> 执行技能操作</span>
      <span v-else>将对 <strong class="text-gray-700 dark:text-gray-300">全文</strong> 执行技能操作</span>
      <span class="text-gray-500 dark:text-gray-600 ml-1">（在编辑器中选中文本后回此面板运行技能）</span>
    </div>

    <!-- 技能组合管道 -->
    <div class="mb-3 border border-gray-700/40 rounded-lg bg-gray-100/30 dark:bg-gray-800/20">
      <!-- 折叠头 -->
      <button
        class="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-800/30 transition-colors"
        @click="pipelineExpanded = !pipelineExpanded"
      >
        <span class="text-xs text-gray-700 dark:text-gray-300">
          🔧 技能组合
          <span v-if="pipeline.length > 0" class="text-gray-400 dark:text-gray-500 ml-1">({{ pipeline.length }})</span>
        </span>
        <span class="text-[10px] text-gray-500 dark:text-gray-600">{{ pipelineExpanded ? "收起 ▲" : "展开 ▼" }}</span>
      </button>

      <!-- 展开区 -->
      <div v-if="pipelineExpanded" class="border-t border-gray-700/40 px-3 py-2 space-y-2">
        <!-- 管道胶囊 -->
        <div class="flex flex-wrap items-center gap-1 min-h-[24px]">
          <template v-for="(step, idx) in pipeline" :key="idx">
            <span
              class="flex items-center gap-1 px-2 py-0.5 rounded text-[10px]"
              :class="pipelineRunning && pipelineCurrentStep === idx + 1
                ? 'bg-blue-50 dark:bg-blue-600/40 text-blue-600 dark:text-blue-200 border border-blue-500/30'
                : pipelineRunning && pipelineCurrentStep > idx + 1
                  ? 'bg-green-50 dark:bg-green-900/30 text-green-800 dark:text-green-300 border border-green-700/30'
                  : 'bg-gray-200/60 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300 border border-gray-600/30'"
            >
              {{ step.name }}
              <button
                v-if="!pipelineRunning"
                class="text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 leading-none"
                @click="removeFromPipeline(idx)"
              >×</button>
              <span v-else-if="pipelineCurrentStep > idx + 1" class="text-green-600 dark:text-green-400">✓</span>
              <span v-else-if="pipelineCurrentStep === idx + 1" class="animate-pulse">⏳</span>
            </span>
            <span v-if="idx < pipeline.length - 1" class="text-gray-500 dark:text-gray-600 text-[10px]">→</span>
          </template>
          <span v-if="pipeline.length === 0" class="text-[10px] text-gray-500 dark:text-gray-600">
            从下方技能添加，构建处理流水线
          </span>
        </div>

        <!-- 操作栏 -->
        <div class="flex items-center gap-2">
          <!-- + 添加技能 下拉 -->
          <div class="relative">
            <button
              class="h-6 px-2 text-[10px] bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded disabled:opacity-40 transition-colors"
              :disabled="pipelineRunning"
              @click="showPipelineSkillPicker = !showPipelineSkillPicker"
            >
              + 添加技能
            </button>
            <div
              v-if="showPipelineSkillPicker"
              class="absolute top-full left-0 mt-1 w-40 max-h-40 overflow-y-auto bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg shadow-lg z-10"
            >
              <button
                v-for="skill in skills"
                :key="skill.id"
                class="w-full text-left px-2.5 py-1.5 text-[10px] text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-white flex items-center gap-1.5 transition-colors"
                @click="addToPipeline(skill)"
              >
                <span
                  class="w-1.5 h-1.5 rounded-full shrink-0"
                  :class="
                    skill.category === 'correction' ? 'bg-red-400' :
                    skill.category === 'polish' ? 'bg-yellow-400' :
                    skill.category === 'creative' ? 'bg-purple-400' : 'bg-blue-400'
                  "
                ></span>
                {{ skill.name }}
              </button>
            </div>
          </div>

          <button
            v-if="pipeline.length > 0 && !pipelineRunning"
            class="h-6 px-2 text-[10px] text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
            @click="clearPipeline"
          >清空</button>

          <button
            v-if="pipelineRunning"
            class="h-6 px-3 text-[10px] bg-red-600 hover:bg-red-500 text-white rounded ml-auto transition-colors"
            @click="stopPipeline"
          >
            ■ 停止
          </button>
          <button
            v-else
            class="h-6 px-3 text-[10px] bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded ml-auto transition-colors"
            :disabled="pipeline.length === 0 || (!currentContent && !selectedText)"
            @click="runPipeline"
          >
            ▶ 执行组合
          </button>
        </div>

        <!-- 结果区 -->
        <div
          v-if="pipelineRunning || finalDiff"
          class="border-t border-gray-700/40 pt-2"
        >
          <!-- 执行中：呼吸灯带跑马灯 -->
          <div v-if="pipelineRunning" class="py-1.5 space-y-1">
            <div class="flex items-center gap-2">
              <span class="text-[10px] text-gray-400 dark:text-gray-500">步骤 {{ pipelineCurrentStep }}/{{ pipelineTotalSteps }}</span>
              <span class="text-[10px] text-gray-500 dark:text-gray-600">
                {{ pipeline[pipelineCurrentStep - 1]?.name || "处理中" }}
              </span>
            </div>
            <!-- 呼吸灯带 -->
            <div class="relative h-1.5 rounded-full overflow-hidden" :style="{ background: breathTrackBg }">
              <!-- 底光：整体呼吸脉动 -->
              <div class="absolute inset-0 rounded-full animate-breath-pulse"
                style="background: linear-gradient(90deg, #3b82f6, #8b5cf6, #06b6d4, #3b82f6); background-size: 300% 100%;">
              </div>
              <!-- 流光：呼吸式扫过 -->
              <div class="absolute inset-0 rounded-full animate-breath-sweep" :style="breathSweepStyle">
              </div>
            </div>
          </div>

          <!-- 完成：只展示改后文字，改动标红 -->
          <div
            v-if="finalDiff"
            class="border border-gray-700/40 rounded-lg bg-gray-800/10 px-2.5 py-2"
          >
            <div class="flex items-center justify-between mb-1.5">
              <span class="text-[10px] text-green-600 dark:text-green-400">✓ 处理完成</span>
              <span class="text-[9px] text-gray-500 dark:text-gray-600">{{ finalDiff.changeCount }}处改动</span>
            </div>
            <div class="text-xs text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto">
              <span v-for="seg in displayDiffSegments" :key="seg.text" :class="seg.red ? 'text-red-600 dark:text-red-400' : seg.strike ? 'text-emerald-600 dark:text-emerald-400 line-through decoration-emerald-400/60' : ''">{{ seg.text }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 加载中 -->
    <div v-if="loading.list" class="text-gray-400 dark:text-gray-500 text-xs text-center py-8">加载技能列表...</div>

    <!-- 技能列表（按分类分组） -->
    <div v-else class="flex-1 overflow-y-auto space-y-4">
      <div v-for="(groupSkills, category) in groupedSkills" :key="category">
        <div class="flex items-center gap-2 mb-2">
          <span
            class="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded"
            :class="categoryColors[category] || categoryColors.custom"
          >
            {{ categoryLabels[category] || category }}
          </span>
        </div>

        <div class="space-y-2">
          <div v-for="skill in groupSkills" :key="skill.id" class="border border-gray-300/50 dark:border-gray-700/50 rounded-lg bg-gray-100/50 dark:bg-gray-800/30">
            <!-- 技能头部 -->
            <div class="flex items-center justify-between px-3 py-2.5">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5">
                  <span class="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">{{ skill.name }}</span>
                  <span v-if="skill.is_builtin" class="text-[10px] text-gray-500 dark:text-gray-600 border border-gray-300 dark:border-gray-700 px-1 rounded">内置</span>
                  <span v-else class="text-[10px] text-blue-500 dark:text-blue-400 border border-blue-300 dark:border-blue-800/50 px-1 rounded">自定义</span>
                  <span v-if="skill.is_review_use" class="text-[10px] text-gray-500 dark:text-gray-600 border border-gray-300 dark:border-gray-700 px-1 rounded">慎用</span>
                </div>
              </div>
              <div class="flex items-center gap-1 shrink-0 ml-2">
                <!-- 自定义技能：删除 -->
                <button
                  v-if="!skill.is_builtin"
                  class="h-6 w-6 flex items-center justify-center text-[10px] text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
                  title="删除技能"
                  @click="handleDelete(skill)"
                >
                  ✕
                </button>
                <!-- 自定义技能：编辑 -->
                <button
                  v-if="!skill.is_builtin"
                  class="h-6 w-6 flex items-center justify-center text-[10px] text-gray-400 dark:text-gray-500 hover:text-blue-400 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
                  title="编辑技能"
                  @click="startEditSkill(skill)"
                >
                  ✎
                </button>
                <!-- 自定义技能：知识库 -->
                <button
                  v-if="!skill.is_builtin && (knowledgeBases.length > 0 || matStore.tagWithCounts.length > 0)"
                  class="h-6 px-1.5 flex items-center justify-center gap-0.5 text-[10px] rounded transition-colors"
                  :class="(getSelectedKbCount(skill.id) + matStore.selectedMaterialTagIds.length) > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'"
                  title="选择引用知识库与素材库"
                  @click="toggleKbPicker(skill.id)"
                >
                  📚{{ (getSelectedKbCount(skill.id) + matStore.selectedMaterialTagIds.length) > 0 ? (getSelectedKbCount(skill.id) + matStore.selectedMaterialTagIds.length) : '' }}
                </button>
                <!-- 执行按钮（最右侧） -->
                <button
                  class="h-6 px-2 text-[10px] bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded transition-colors"
                  :title="skill.name"
                  :disabled="loading.run === skill.id || (!currentContent && !selectedText)"
                  @click="runSkill(skill)"
                >
                  {{ loading.run === skill.id ? "执行中..." : "执行" }}
                </button>
              </div>
            </div>

            <!-- 知识库与素材库选择器（仅自定义技能） -->
            <div v-if="showKbPicker === skill.id && !skill.is_builtin" class="border-t border-gray-300/50 dark:border-gray-700/50 px-3 py-2 space-y-2">
              <!-- 知识库 -->
              <div v-if="knowledgeBases.length > 0">
                <div class="text-[10px] text-amber-600/70 dark:text-amber-400/70 mb-1.5">知识库</div>
                <div class="flex flex-wrap gap-1">
                  <button
                    v-for="kb in knowledgeBases"
                    :key="kb.id"
                    class="text-[10px] px-2 py-0.5 rounded transition-colors"
                    :class="(skillKbSelection[skill.id] || []).includes(kb.id) ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700/50' : 'text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 hover:text-gray-700 dark:hover:text-gray-300'"
                    @click="toggleKbForSkill(skill.id, kb.id)"
                  >
                    {{ kb.name }}
                  </button>
                </div>
              </div>
              <!-- 分隔符 -->
              <div v-if="knowledgeBases.length > 0 && matStore.tagWithCounts.length > 0" class="border-t border-gray-300/50 dark:border-gray-700/50"></div>
              <!-- 素材库标签 -->
              <div v-if="matStore.tagWithCounts.length > 0">
                <div class="text-[10px] text-emerald-600/70 dark:text-emerald-400/70 mb-1.5">素材库标签</div>
                <div class="flex flex-wrap gap-1">
                  <button
                    v-for="tag in matStore.tagWithCounts"
                    :key="tag.id"
                    class="text-[10px] px-2 py-0.5 rounded transition-colors"
                    :class="matStore.selectedMaterialTagIds.includes(tag.id) ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-700/50' : 'text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 hover:text-gray-700 dark:hover:text-gray-300'"
                    @click="matStore.toggleMaterialTag(tag.id)"
                  >
                    {{ tag.name }} ({{ tag.material_count }})
                  </button>
                </div>
              </div>
            </div>

            <!-- 编辑技能表单（仅自定义技能） -->
            <div v-if="editingSkillId === skill.id && !skill.is_builtin" class="border-t border-gray-300/50 dark:border-gray-700/50 px-3 py-2 space-y-2">
              <input
                v-model="editSkillForm.name"
                type="text"
                placeholder="技能名称"
                class="w-full h-7 px-2 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded text-xs text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:border-blue-500 focus:outline-none"
              />
              <textarea
                v-model="editSkillForm.prompt_template"
                placeholder="提示词模板"
                rows="3"
                class="w-full px-2 py-1.5 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded text-xs text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:border-blue-500 focus:outline-none resize-none"
              />
              <div class="flex items-center gap-2">
                <span class="text-[10px] text-gray-400 dark:text-gray-500">温度：</span>
                <input
                  v-model.number="editSkillForm.temperature"
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  class="flex-1 h-4"
                />
                <span class="text-[10px] text-gray-600 dark:text-gray-400 w-6">{{ editSkillForm.temperature }}</span>
              </div>
              <div class="flex gap-2">
                <button
                  class="flex-1 h-7 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors"
                  :disabled="savingEdit || !editSkillForm.name.trim() || !editSkillForm.prompt_template.trim()"
                  @click="saveEditSkill"
                >
                  {{ savingEdit ? "保存中..." : "保存修改" }}
                </button>
                <button
                  class="h-7 px-3 text-xs bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded transition-colors"
                  @click="cancelEditSkill"
                >
                  取消
                </button>
              </div>
            </div>

            <!-- 执行结果 -->
            <div v-if="resultMap[skill.id]" class="border-t border-gray-300/50 dark:border-gray-700/50">
              <button
                class="w-full flex items-center justify-between px-3 py-1.5 text-[10px] text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100/50 dark:hover:bg-gray-800/50 transition-colors"
                @click="toggleResult(skill.id)"
              >
                <span>{{ expandedMap[skill.id] ? "▼ 收起结果" : "▶ 展开结果" }}</span>
                <span class="text-gray-500 dark:text-gray-600">{{ resultMap[skill.id].length }} 字</span>
              </button>
              <div
                v-if="expandedMap[skill.id]"
                class="px-3 pb-3 text-xs text-gray-700 dark:text-gray-300 leading-relaxed max-h-80 overflow-y-auto"
              >
                <div
                  class="prose prose-invert prose-xs max-w-none"
                  v-html="renderMarkdown(resultMap[skill.id])"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-if="skills.length === 0" class="text-center py-8 text-gray-500 dark:text-gray-600 text-xs">
        暂无技能
      </div>
    </div>

    <!-- 添加自定义技能 -->
    <div class="border-t border-gray-200 dark:border-gray-800 pt-3 mt-auto">
      <button
        v-if="!showAddForm"
        class="w-full h-8 text-xs text-blue-400 dark:text-blue-300 hover:text-blue-300 hover:bg-gray-100/50 dark:hover:bg-gray-800/50 rounded transition-colors"
        @click="showAddForm = true"
      >
        + 添加自定义技能
      </button>

      <div v-else class="space-y-2">
        <input
          v-model="newSkillForm.name"
          type="text"
          placeholder="技能名称，如：标题优化"
          class="w-full h-8 px-2 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded text-xs text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:border-blue-500 focus:outline-none"
        />
        <select
          v-model="newSkillForm.category"
          class="w-full h-8 px-2 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded text-xs text-gray-800 dark:text-gray-200 focus:border-blue-500 focus:outline-none"
        >
          <option value="custom">自定义</option>
          <option value="correction">纠错</option>
          <option value="polish">润色</option>
          <option value="creative">创意</option>
        </select>
        <textarea
          v-model="newSkillForm.prompt_template"
          placeholder="提示词模板，如：你是文案优化专家，请优化以下文本..."
          rows="3"
          class="w-full px-2 py-1.5 bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded text-xs text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 focus:border-blue-500 focus:outline-none resize-none"
        />
        <div class="flex items-center gap-2">
          <span class="text-[10px] text-gray-400 dark:text-gray-500">温度：</span>
          <input
            v-model.number="newSkillForm.temperature"
            type="range"
            min="0"
            max="2"
            step="0.1"
            class="flex-1 h-4"
          />
          <span class="text-[10px] text-gray-600 dark:text-gray-400 w-6">{{ newSkillForm.temperature }}</span>
        </div>
        <div class="flex gap-2">
          <button
            class="flex-1 h-7 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors"
            :disabled="savingNew || !newSkillForm.name.trim() || !newSkillForm.prompt_template.trim()"
            @click="handleAddSkill"
          >
            {{ savingNew ? "保存中..." : "保存" }}
          </button>
          <button
            class="h-7 px-3 text-xs bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded transition-colors"
            @click="showAddForm = false"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 呼吸脉动：整体渐隐渐现 */
@keyframes breath-pulse {
  0%, 100% { opacity: 0.5; }
  50%      { opacity: 1; }
}

/* 流光扫过：平滑呼吸式滑动 */
@keyframes breath-sweep {
  0%   { background-position: 200% 0; opacity: 0; }
  20%  { opacity: 1; }
  80%  { opacity: 1; }
  100% { background-position: -100% 0; opacity: 0; }
}

.animate-breath-pulse {
  animation: breath-pulse 2.5s ease-in-out infinite;
}

.animate-breath-sweep {
  animation: breath-sweep 2.5s ease-in-out infinite;
}
</style>
