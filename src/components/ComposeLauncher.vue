<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { ComposeRecipe, ComposeProgress, ComposePhase, InterviewQuestion } from '../types/compose'
import { builtinRecipes, customRecipesCache, loadCustomRecipes, saveCustomRecipe, deleteCustomRecipe } from '../data/recipes'

const props = defineProps<{
  activeProgress: ComposeProgress | null
}>()

const emit = defineEmits<{
  start: [recipe: ComposeRecipe]
}>()

// ── 菜谱列表 ──
const allRecipes = computed(() => [...builtinRecipes, ...customRecipesCache.value])
const loaded = ref(false)

onMounted(async () => {
  await loadCustomRecipes()
  loaded.value = true
})

// ── 新建自定义菜谱 ──
const showForm = ref(false)
const creating = ref(false)
const createStatus = ref('')
const showReviewPanel = ref(false)
const pendingName = ref('')
const pendingDescription = ref('')
const pendingSystemPrompt = ref('')
const pendingQuestions = ref<ExtendedQuestion[]>([])
const regenerating = ref(false)

/** 编辑中的问题（扩展了原始 InterviewQuestion） */
interface ExtendedQuestion extends InterviewQuestion {
  _optionsText?: string // 逗号分隔的选项文本，用于编辑
}

const newRecipe = ref({
  name: '',
  description: '',
  genre: '',
})

async function handleCreate() {
  if (!newRecipe.value.name.trim()) return
  creating.value = true
  createStatus.value = 'AI 正在分析需求，生成采访问题...'

  try {
    const generated = await invoke<{ system_prompt: string; questions: InterviewQuestion[] }>(
      'generate_interview_questions',
      { name: newRecipe.value.name.trim(), description: newRecipe.value.description.trim() }
    )

    // 暂存，进入确认编辑面板
    pendingName.value = newRecipe.value.name.trim()
    pendingDescription.value = newRecipe.value.description.trim()
    pendingSystemPrompt.value = generated.system_prompt
    pendingQuestions.value = generated.questions.map(q => ({
      ...q,
      _optionsText: q.options?.join('，') || '',
    }))
    showReviewPanel.value = true
  } catch (e) {
    console.error('生成采访问题失败:', e)
    createStatus.value = '生成失败，已使用默认问题创建'
    await createFallbackRecipe()
  } finally {
    creating.value = false
    createStatus.value = ''
  }
}

/** 重新生成问题 */
async function handleRegenerate() {
  regenerating.value = true
  try {
    const generated = await invoke<{ system_prompt: string; questions: InterviewQuestion[] }>(
      'generate_interview_questions',
      { name: pendingName.value, description: pendingDescription.value }
    )
    pendingSystemPrompt.value = generated.system_prompt
    pendingQuestions.value = generated.questions.map(q => ({
      ...q,
      _optionsText: q.options?.join('，') || '',
    }))
  } catch (e) {
    console.error('重新生成失败:', e)
  } finally {
    regenerating.value = false
  }
}

/** 确认并保存模板 */
async function handleConfirmReview() {
  // 将 _optionsText 转换回 options 数组
  const finalQuestions: InterviewQuestion[] = pendingQuestions.value.map(({ _optionsText, ...q }) => {
    const opts = _optionsText?.trim()
    return {
      ...q,
      options: opts ? opts.split(/[,，]/).map(s => s.trim()).filter(Boolean) : undefined,
    }
  })

  const recipe: ComposeRecipe = {
    id: `custom_${Date.now()}`,
    name: pendingName.value,
    description: pendingDescription.value || '自定义写作模板',
    genre: newRecipe.value.genre.trim() || '自定义',
    icon: '⚡',
    isBuiltin: false,
    knowledgeBaseIds: [],
    stages: [
      {
        type: 'interview',
        stageId: 'interview',
        stageLabel: '信息采集',
        stageIcon: '📝',
        systemPrompt: pendingSystemPrompt.value,
        questions: finalQuestions,
      },
      {
        type: 'outline',
        stageId: 'outline',
        stageLabel: '生成提纲',
        stageIcon: '📋',
        structurePrompt: '文章的结构如何安排？请大致描述各部分的侧重点。',
        structureHint: '例如：分成几个部分，每部分的重点是什么',
      },
      {
        type: 'generate',
        stageId: 'generate',
        stageLabel: '正文撰写',
        stageIcon: '✍️',
        skillId: '__compose_generate__',
        temperature: 0.7,
      },
      {
        type: 'review',
        stageId: 'review',
        stageLabel: '质量审查',
        stageIcon: '🔍',
        skillIds: ['skill_logic', 'skill_grammar', 'skill_official'],
        autoFix: true,
      },
      {
        type: 'polish',
        stageId: 'polish',
        stageLabel: '润色定稿',
        stageIcon: '✨',
        skillId: 'skill_concise',
        temperature: 0.6,
      },
    ],
  }
  customRecipesCache.value.push(recipe)
  await saveCustomRecipe(recipe)
  resetForm()
}

/** 取消确认面板，回到表单 */
function handleCancelReview() {
  showReviewPanel.value = false
}

/** 重置所有表单状态 */
function resetForm() {
  newRecipe.value = { name: '', description: '', genre: '' }
  showForm.value = false
  showReviewPanel.value = false
  pendingName.value = ''
  pendingDescription.value = ''
  pendingSystemPrompt.value = ''
  pendingQuestions.value = []
}

/** 编辑问题列表操作 */
function addQuestion() {
  const idx = pendingQuestions.value.length + 1
  pendingQuestions.value.push({
    id: `q_${String(idx).padStart(2, '0')}`,
    question: '',
    hint: '',
    required: false,
    _optionsText: '',
  })
}

function removeQuestion(index: number) {
  pendingQuestions.value.splice(index, 1)
}

function toggleRequired(index: number) {
  pendingQuestions.value[index].required = !pendingQuestions.value[index].required
}

async function createFallbackRecipe() {
  const recipe: ComposeRecipe = {
    id: `custom_${Date.now()}`,
    name: newRecipe.value.name.trim(),
    description: newRecipe.value.description.trim() || '自定义写作模板',
    genre: newRecipe.value.genre.trim() || '自定义',
    icon: '⚡',
    isBuiltin: false,
    knowledgeBaseIds: [],
    stages: [
      {
        type: 'interview',
        stageId: 'interview',
        stageLabel: '信息采集',
        stageIcon: '📝',
        systemPrompt: `你是一位专业的写作助手，正在帮助用户撰写一篇「${newRecipe.value.name.trim()}」。请逐步询问关键信息。每次只问一个问题。用户跳过的问题你将自行补充。`,
        questions: [
          { id: 'q_title', question: '请描述一下写作主题和目的？', hint: '例如：汇报年度工作成果', required: true },
          { id: 'q_context', question: '有什么特别需要强调的内容吗？（可选）', hint: '', required: false },
          { id: 'q_extra', question: '还有其他补充信息吗？（可选）', hint: '', required: false },
        ],
      },
      {
        type: 'outline', stageId: 'outline', stageLabel: '生成提纲', stageIcon: '📋',
        structurePrompt: '文章的结构如何安排？请大致描述各部分的侧重点。',
        structureHint: '例如：分成几个部分，每部分的重点是什么',
      },
      { type: 'generate', stageId: 'generate', stageLabel: '正文撰写', stageIcon: '✍️', skillId: '__compose_generate__', temperature: 0.7 },
      { type: 'review', stageId: 'review', stageLabel: '质量审查', stageIcon: '🔍', skillIds: ['skill_logic', 'skill_grammar', 'skill_official'], autoFix: true },
      { type: 'polish', stageId: 'polish', stageLabel: '润色定稿', stageIcon: '✨', skillId: 'skill_concise', temperature: 0.6 },
    ],
  }
  customRecipesCache.value.push(recipe)
  await saveCustomRecipe(recipe)
  resetForm()
}

async function handleDelete(recipe: ComposeRecipe) {
  await deleteCustomRecipe(recipe.id)
}

// ── 分组 ──
const groupedRecipes = computed(() => {
  const groups: Record<string, ComposeRecipe[]> = {}
  for (const r of allRecipes.value) {
    const key = r.genre
    if (!groups[key]) groups[key] = []
    groups[key].push(r)
  }
  return groups
})

// ── 活跃任务进度条（内联在菜谱卡片下） ──
const progressPercent = computed(() => {
  if (!props.activeProgress) return 0
  return Math.round((props.activeProgress.currentStep / props.activeProgress.totalSteps) * 100)
})

function isActiveRecipe(recipe: ComposeRecipe): boolean {
  return !!(props.activeProgress?.active && props.activeProgress.recipeName === recipe.name)
}

const phaseLabelMap: Record<ComposePhase, string> = {
  idle: '', interview: '问答采集中', outline_generating: '生成提纲中', generating: '正文撰写中', reviewing: '质量审查中', polishing: '润色定稿中', done: '创建成功 ✓',
}

const progressPhaseColor = computed(() => {
  const p = props.activeProgress?.phase
  if (p === 'interview') return 'blue'
  if (p === 'outline_generating') return 'violet'
  if (p === 'generating') return 'emerald'
  if (p === 'reviewing') return 'amber'
  if (p === 'polishing') return 'purple'
  if (p === 'done') return 'green'
  return 'gray'
})

const progressBgClass = computed(() => {
  const c = progressPhaseColor.value
  return {
    'bg-blue-100 dark:bg-blue-950/15': c === 'blue',
    'bg-violet-950/15': c === 'violet',
    'bg-emerald-950/15': c === 'emerald',
    'bg-amber-950/15': c === 'amber',
    'bg-purple-100 dark:bg-purple-950/15': c === 'purple',
    'bg-green-100 dark:bg-green-950/15': c === 'green',
    'bg-gray-900/20': c === 'gray',
  }
})

const progressTrackClass = computed(() => {
  const c = progressPhaseColor.value
  return {
    'bg-blue-100 dark:bg-blue-950/40': c === 'blue', 'bg-violet-950/40': c === 'violet',
    'bg-emerald-950/40': c === 'emerald',
    'bg-amber-950/40': c === 'amber', 'bg-purple-100 dark:bg-purple-950/40': c === 'purple',
    'bg-green-100 dark:bg-green-950/40': c === 'green', 'bg-gray-100/70 dark:bg-gray-800/60': c === 'gray',
  }
})

const marqueeBarClass = computed(() => {
  const c = progressPhaseColor.value
  return {
    'bg-gradient-to-r from-blue-500 via-blue-400 to-blue-500 bg-[length:200%_100%] animate-shimmer': c === 'blue',
    'bg-gradient-to-r from-violet-500 via-purple-400 to-violet-500 bg-[length:200%_100%] animate-shimmer': c === 'violet',
    'bg-gradient-to-r from-emerald-500 via-emerald-400 to-emerald-500 bg-[length:200%_100%] animate-shimmer': c === 'emerald',
    'bg-gradient-to-r from-amber-500 via-amber-400 to-amber-500 bg-[length:200%_100%] animate-shimmer': c === 'amber',
    'bg-gradient-to-r from-purple-500 via-purple-400 to-purple-500 bg-[length:200%_100%] animate-shimmer': c === 'purple',
    'bg-gradient-to-r from-green-500 via-green-400 to-green-500 bg-[length:200%_100%] animate-shimmer': c === 'green',
    'bg-gray-300 dark:bg-gray-600': c === 'gray',
  }
})

const marqueeGlareClass = computed(() => {
  const c = progressPhaseColor.value
  return {
    'bg-gradient-to-r from-transparent via-blue-300/40 to-transparent': c === 'blue',
    'bg-gradient-to-r from-transparent via-violet-300/40 to-transparent': c === 'violet',
    'bg-gradient-to-r from-transparent via-emerald-300/40 to-transparent': c === 'emerald',
    'bg-gradient-to-r from-transparent via-amber-300/40 to-transparent': c === 'amber',
    'bg-gradient-to-r from-transparent via-purple-300/40 to-transparent': c === 'purple',
    'bg-gradient-to-r from-transparent via-green-300/40 to-transparent': c === 'green',
    'bg-gradient-to-r from-transparent via-gray-300/20 to-transparent': c === 'gray',
  }
})

const progressDotClass = computed(() => {
  const c = progressPhaseColor.value
  return {
    'bg-blue-400 animate-pulse': c === 'blue',
    'bg-violet-400 animate-pulse': c === 'violet',
    'bg-emerald-400 animate-pulse': c === 'emerald',
    'bg-amber-400 animate-pulse': c === 'amber',
    'bg-purple-400 animate-pulse': c === 'purple',
    'bg-green-400': c === 'green',
    'bg-gray-500': c === 'gray',
  }
})

const progressHint = computed(() => {
  const p = props.activeProgress?.phase
  if (p === 'interview') return 'AI 正在向你了解写作需求...'
  if (p === 'outline_generating') return '正在基于你的需求生成文章提纲...'
  if (p === 'generating') return '文字正逐字流入编辑器，请关注编辑区...'
  if (p === 'reviewing') return '审查中发现问题将自动修复并更新...'
  if (p === 'polishing') return '最后润色中，即将完成...'
  if (p === 'done') return '已创建成功，请在编辑器中查看和编辑'
  return ''
})
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- 标题栏 -->
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-semibold text-gray-700 dark:text-gray-300">智能写作</h3>
      <button
        class="text-xs text-blue-400 hover:text-blue-300 transition-colors"
        @click="showForm = !showForm"
      >
        {{ showForm ? '取消' : '+ 自定义' }}
      </button>
    </div>

    <!-- 新建表单 -->
    <Transition name="fade-up">
      <div v-if="showForm && !showReviewPanel" class="mb-3 p-3 rounded-lg bg-gray-100/60 dark:bg-gray-800/50 border border-gray-300/50 dark:border-gray-700/50 space-y-2">
        <input
          v-model="newRecipe.name"
          type="text"
          placeholder="模板名称（如：专题研讨发言）"
          class="w-full bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-xs text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 outline-none focus:border-blue-500"
          @keyup.enter="handleCreate"
        />
        <input
          v-model="newRecipe.description"
          type="text"
          placeholder="简要描述（AI 将根据描述自动生成问题采集）"
          class="w-full bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-xs text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 outline-none focus:border-blue-500"
          @keyup.enter="handleCreate"
        />
        <!-- 创建状态提示 -->
        <div v-if="createStatus" class="flex items-center gap-2 text-[11px] text-blue-400">
          <svg class="animate-spin w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          {{ createStatus }}
        </div>
        <button
          class="w-full py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-not-allowed text-white text-xs rounded transition-colors flex items-center justify-center gap-1.5"
          :disabled="!newRecipe.name.trim() || creating"
          @click="handleCreate"
        >
          <svg v-if="creating" class="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          {{ creating ? 'AI 生成中...' : '创建模板' }}
        </button>
      </div>
    </Transition>

    <!-- ═══ 问题确认编辑面板 ═══ -->
    <div v-if="showReviewPanel" class="mb-3 p-3 rounded-lg bg-gray-100/60 dark:bg-gray-800/50 border border-blue-700/40 space-y-2.5 max-h-[60vh] flex flex-col">
      <!-- 标题 -->
      <div class="flex items-center justify-between shrink-0">
        <div class="flex items-center gap-1.5">
          <span class="text-xs">📋</span>
          <span class="text-xs font-semibold text-gray-800 dark:text-gray-200">{{ pendingName }}</span>
          <span class="text-[10px] px-1 py-0.5 rounded-full bg-blue-400/25 text-gray-800 dark:text-gray-200">确认修改</span>
        </div>
        <span class="text-[10px] text-gray-400 dark:text-gray-500">{{ pendingQuestions.length }} 个问题</span>
      </div>

      <!-- 系统提示词 -->
      <div class="shrink-0">
        <label class="text-[10px] text-gray-400 dark:text-gray-500 block mb-1">AI 角色设定（systemPrompt）</label>
        <textarea
          v-model="pendingSystemPrompt"
          rows="2"
          class="w-full bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded px-2 py-1.5 text-[11px] text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-600 outline-none focus:border-blue-500 transition-colors resize-none"
        ></textarea>
      </div>

      <!-- 问题列表（可滚动） -->
      <div class="flex-1 overflow-y-auto space-y-2 min-h-0">
        <label class="text-[10px] text-gray-400 dark:text-gray-500 block">采集问题列表</label>
        <div
          v-for="(q, idx) in pendingQuestions"
          :key="idx"
          class="p-2 rounded-lg bg-gray-900/60 border border-gray-700/30 space-y-1.5 group"
        >
          <!-- 标题行 -->
          <div class="flex items-center gap-1.5">
            <span class="text-[10px] text-gray-500 dark:text-gray-600 shrink-0 w-4">{{ idx + 1 }}</span>
            <input
              v-model="q.question"
              type="text"
              placeholder="问题文本"
              class="flex-1 bg-transparent text-[11px] text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-600 outline-none border-b border-transparent focus:border-gray-600 transition-colors"
            />
            <!-- required 切换 -->
            <button
              class="h-5 px-1.5 text-[9px] rounded border transition-all shrink-0"
              :class="q.required
                ? 'bg-red-100 dark:bg-red-950/30 border-red-300 dark:border-red-800/50 text-red-600 dark:text-red-400'
                : 'bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-500 dark:text-gray-600 hover:text-gray-400'"
              @click="toggleRequired(idx)"
              :title="q.required ? '必填' : '选填'"
            >
              {{ q.required ? '必填' : '选填' }}
            </button>
            <button
              class="h-5 w-5 flex items-center justify-center rounded text-gray-500 dark:text-gray-600 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-950/20 transition-all shrink-0"
              @click="removeQuestion(idx)"
              title="删除"
            >
              ✕
            </button>
          </div>
          <!-- hint -->
          <input
            v-model="q.hint"
            type="text"
            placeholder="输入框提示（可为空）"
            class="w-full bg-white/80 dark:bg-gray-950/50 border border-gray-200 dark:border-gray-800 rounded px-1.5 py-1 text-[10px] text-gray-600 dark:text-gray-400 placeholder-gray-700 outline-none focus:border-gray-600 transition-colors"
          />
          <!-- options（逗号分隔） -->
          <input
            v-model="q._optionsText"
            type="text"
            placeholder="选项（逗号分隔，如：选项A，选项B）"
            class="w-full bg-white/80 dark:bg-gray-950/50 border border-gray-200 dark:border-gray-800 rounded px-1.5 py-1 text-[10px] text-amber-600 dark:text-amber-400/70 placeholder-gray-700 outline-none focus:border-amber-800/50 transition-colors"
            @input="() => {}"
          />
        </div>
      </div>

      <!-- 操作按钮区 -->
      <div class="space-y-2 shrink-0">
        <!-- 添加问题 -->
        <button
          class="w-full h-7 flex items-center justify-center gap-1 text-[11px] text-gray-400 dark:text-gray-500 hover:text-blue-400 border border-dashed border-gray-300/50 dark:border-gray-700/50 hover:border-blue-700/50 rounded-lg transition-all"
          @click="addQuestion"
        >
          <span>＋</span> 添加问题
        </button>

        <!-- 底部操作 -->
        <div class="flex items-center gap-2">
          <button
            class="h-7 px-3 text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-700/30 rounded-lg transition-colors shrink-0"
            @click="handleCancelReview"
          >
            取消
          </button>
          <button
            class="h-7 px-3 text-[11px] text-blue-400 hover:text-blue-300 border border-blue-300 dark:border-blue-800/40 hover:border-blue-600/60 rounded-lg transition-all shrink-0 flex items-center gap-1"
            :disabled="regenerating"
            @click="handleRegenerate"
          >
            <svg v-if="regenerating" class="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            <span v-else>🔄</span>
            {{ regenerating ? '生成中...' : '重新生成' }}
          </button>
          <div class="flex-1" />
          <button
            class="h-8 px-5 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white text-xs font-semibold rounded-lg transition-all shadow-[0_0_12px_rgba(59,130,246,0.3)] hover:shadow-[0_0_18px_rgba(59,130,246,0.5)] active:scale-95"
            @click="handleConfirmReview"
          >
            ✓ 确认创建
          </button>
        </div>
      </div>
    </div>

    <!-- 菜谱列表（按文体分组） -->
    <div class="flex-1 overflow-y-auto space-y-4">
      <div v-for="(recipes, genre) in groupedRecipes" :key="genre">
        <!-- 分组标题 -->
        <div class="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">
          {{ genre }}
        </div>

        <!-- 卡片 -->
        <div
          v-for="recipe in recipes"
          :key="recipe.id"
          class="mb-2 rounded-lg border transition-all group overflow-hidden"
          :class="[
            recipe.isBuiltin
              ? 'bg-white dark:bg-gray-800/40 border-gray-200 dark:border-gray-700/50 hover:border-blue-400 dark:hover:border-blue-500/50 hover:bg-blue-50 dark:hover:bg-gray-800/70'
              : 'bg-gray-50 dark:bg-gray-800/20 border-dashed border-gray-200 dark:border-gray-700/30 hover:border-purple-400 dark:hover:border-purple-500/50 hover:bg-purple-50 dark:hover:bg-gray-800/50',
            isActiveRecipe(recipe) ? 'border-blue-500/60 shadow-[0_0_12px_rgba(59,130,246,0.15)]' : '',
          ]"
          @click="emit('start', recipe)"
        >
          <div class="p-3 cursor-pointer">
            <div class="flex items-start justify-between">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5 mb-1">
                  <span class="text-sm">{{ recipe.icon }}</span>
                  <span class="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">{{ recipe.name }}</span>
                  <span
                    v-if="!recipe.isBuiltin"
                    class="text-[10px] px-1 py-0.5 rounded bg-purple-50/50 dark:bg-purple-900/50 text-purple-600 dark:text-purple-400"
                  >自定义</span>
                </div>
                <p class="text-[11px] text-gray-400 dark:text-gray-500 leading-relaxed line-clamp-2">
                  {{ recipe.description }}
                </p>
              </div>
              <!-- 删除（仅自定义） -->
              <button
                v-if="!recipe.isBuiltin"
                class="hidden group-hover:block text-xs text-gray-500 dark:text-gray-600 hover:text-red-600 dark:hover:text-red-400 transition-colors ml-2 shrink-0"
                title="删除"
                @click.stop="handleDelete(recipe)"
              >
                ✕
              </button>
            </div>
          </div>

          <!-- 活跃任务内联进度条（跑马灯） -->
          <Transition name="expand-down">
            <div
              v-if="isActiveRecipe(recipe)"
              class="px-3 pb-3 border-t border-gray-700/30 pt-2.5"
              :class="isActiveRecipe(recipe) ? progressBgClass : ''"
            >
              <!-- 标题行 -->
              <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="w-1.5 h-1.5 rounded-full" :class="progressDotClass"></span>
                  <span class="text-[11px] font-medium text-gray-700 dark:text-gray-300 truncate">{{ phaseLabelMap[props.activeProgress!.phase] }}</span>
                </div>
                <span class="text-[10px] tabular-nums shrink-0 ml-2 text-gray-400 dark:text-gray-500">
                  {{ props.activeProgress!.currentStep }}/{{ props.activeProgress!.totalSteps }}
                </span>
              </div>

              <!-- 跑马灯进度条 -->
              <div class="h-1.5 rounded-full relative overflow-hidden" :class="progressTrackClass">
                <div
                  class="h-full rounded-full"
                  :class="marqueeBarClass"
                  :style="{ width: progressPercent + '%' }"
                ></div>
                <!-- 跑马灯光条 -->
                <div
                  class="absolute inset-y-0 w-8 rounded-full animate-marquee"
                  :class="marqueeGlareClass"
                  :style="{ left: progressPercent + '%' }"
                ></div>
              </div>

              <!-- 阶段说明 -->
              <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-1.5">{{ progressHint }}</p>
            </div>
          </Transition>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-if="Object.keys(groupedRecipes).length === 0" class="text-center py-8 text-gray-500 dark:text-gray-600 text-xs">
        <p>暂无写作模板</p>
        <p class="text-blue-500 dark:text-blue-400 cursor-pointer hover:underline mt-1" @click="showForm = true">
          创建第一个
        </p>
      </div>
    </div>

  </div>
</template>

<style scoped>
.fade-up-enter-active { transition: all 0.4s ease-out; }
.fade-up-leave-active { transition: all 0.3s ease-in; }
.fade-up-enter-from { opacity: 0; transform: translateY(8px); }
.fade-up-leave-to { opacity: 0; transform: translateY(-4px); }

/* 内联进度展开动画 */
.expand-down-enter-active { transition: all 0.35s ease-out; }
.expand-down-leave-active { transition: all 0.25s ease-in; }
.expand-down-enter-from,
.expand-down-leave-to { opacity: 0; max-height: 0; padding-top: 0; padding-bottom: 0; }

/* 跑马灯着色动画 */
@keyframes shimmer {
  0% { background-position: 200% center; }
  100% { background-position: -200% center; }
}
.animate-shimmer { animation: shimmer 2s linear infinite; }

/* 光条滑动 */
@keyframes marquee-glide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
.animate-marquee { animation: marquee-glide 1.5s ease-in-out infinite; }
</style>

