<script setup lang="ts">
import { ref, reactive, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  ComposeRecipe, ComposeState, ComposePhase, ComposeProgress,
  InterviewStage, InterviewQuestion, OutlineItem, HeadingStyle,
  ReviewFinding, GenerateStage, ReviewStage, PolishStage,
} from '../types/compose'
import { diffChars, chunkDiffOps } from '../utils/diff'
import { useMaterialStore } from '../stores/materialStore'

// ── Props & Emits ──
const props = defineProps<{ recipe: ComposeRecipe }>()

const emit = defineEmits<{
  close: []
  done: [content: string]
  progress: [info: ComposeProgress]
  requestClose: []
  stream: [
    payload:
      | { type: 'append' | 'replace'; text: string }
      | { type: 'diff_playback'; oldText: string; newText: string },
  ]
}>()

// ── SSE 流式调用助手 ──
interface StreamEvent { token?: string; done?: boolean }

async function invokeStream(
  command: string,
  args: Record<string, unknown>,
  onToken: (token: string) => void,
): Promise<string> {
  const eventId = crypto.randomUUID()
  const unlisten = await listen<StreamEvent>(`ai-stream-${eventId}`, (event) => {
    if (event.payload.token && !event.payload.done) {
      onToken(event.payload.token)
    }
  })
  try {
    return await invoke<string>(command, { ...args, eventId })
  } finally {
    unlisten()
  }
}

// ── 状态 ──
const state = reactive<ComposeState>({
  active: false, recipe: null, phase: 'idle', currentStageIndex: -1,
  interviewAnswers: {}, currentQuestionIndex: -1, dynamicQuestion: '',
  stageLogs: [], streamingContent: '', finalContent: '', reviewFindings: [],
  allStagesDone: false, elapsedSeconds: 0, outline: null,
})

const userInput = ref('')
const loading = ref(false)
const error = ref('')
const chatContainer = ref<HTMLDivElement>()
const dialogVisible = ref(true)
let elapsedTimer: ReturnType<typeof setInterval> | null = null
let awaitingPlaybackComplete = false // 只有润色阶段自己 emit 的 diff_playback 完成后才 finish

// ── 审查子步骤结果（用于最终附到正文后） ──
interface ReviewStepResult {
  skillId: string
  skillLabel: string
  rawResult: string  // AI 审查的完整返回（修正前）
  findingsCount: number
  fixed: boolean
  oldContent: string  // 修正前原文
  newContent: string  // 修正后全文
}
const reviewStepResults = ref<ReviewStepResult[]>([])

// ── 润色结果（用于最终附到正文后） ──
interface PolishStepInfo {
  skillId: string
  skillLabel: string
  oldContent: string
  newContent: string
}
const polishStepInfo = ref<PolishStepInfo | null>(null)

// ── 采访流程：问题 → 补充说明 → 摘要确认 ──
const showSupplementaryQuestion = ref(false) // 最后一道题答完后，在同一个聊天窗口显示补充说明
const showSummary = ref(false)            // 补充说明提交后，新窗口展示全部信息

// ── 提纲状态 ──
const showOutlineModal = ref(false)
const outlineConfigExpanded = ref(true) // 风格配置是否展开
const outlineThinkingExpanded = ref(false)
const outlineItems = ref<OutlineItem[]>([])
const outlineL2Style = ref<HeadingStyle>('并列排比式')
const outlineL3Style = ref<HeadingStyle>('层层递进式')
const outlineThinking = ref('')
const outlineGenerating = ref(false)
const outlineThinkingDone = ref(false)
const outlineFeedback = ref('') // 用户对整体提纲的不满意反馈
const outlineStructure = ref('') // 用户输入的文章结构/分段意图
const editingItemId = ref('') // 当前正在内联编辑的条目 ID
const editingItemText = ref('') // 编辑中的文本
const outlineThinkingReady = ref(false) // 思考文本已从流中提取完毕，正在等待条目

// ── 常用提示词（自定义快捷输入） ──
interface InterviewPromptOut { id: string; recipe_id: string; question_id: string; label: string; content: string; sort_order: number }
const interviewPrompts = ref<InterviewPromptOut[]>([])
const allRecipePrompts = ref<InterviewPromptOut[]>([]) // 此菜谱的全部提示词，用于补充说明步骤
const showPromptEditor = ref(false)
const editingPrompt = reactive<{ id: string; label: string; content: string }>({ id: '', label: '', content: '' })

const allHeadingStyles: HeadingStyle[] = [
  '并列排比式', '对仗工整式', '统一后缀式',
  '破立转换式', '辩证统一式', '层层递进式',
  '生动比喻式', '引用典故式', '拟人动感式',
  '化用热词式', '概念组合式',
  '点明宗旨式', '鼓舞动员式',
  '数字概括式',
]

const headingStyleGroups: { group: string; styles: { value: HeadingStyle; label: string; desc: string; color: string }[] }[] = [
  { group: '结构强化型', styles: [
    { value: '并列排比式', label: '并列排比', desc: '统一动词+不同宾语', color: 'from-blue-500 to-cyan-400' },
    { value: '对仗工整式', label: '对仗工整', desc: '动宾A+动宾B对称', color: 'from-blue-400 to-indigo-400' },
    { value: '统一后缀式', label: '统一后缀', desc: '内容+式/化/型/力', color: 'from-cyan-400 to-teal-400' },
  ]},
  { group: '逻辑关系型', styles: [
    { value: '破立转换式', label: '破立转换', desc: '破除A树立B', color: 'from-orange-500 to-red-400' },
    { value: '辩证统一式', label: '辩证统一', desc: '既要A又要B', color: 'from-orange-400 to-amber-400' },
    { value: '层层递进式', label: '层层递进', desc: '基础→中级→高级', color: 'from-amber-400 to-yellow-400' },
  ]},
  { group: '意象赋能型', styles: [
    { value: '生动比喻式', label: '生动比喻', desc: '借物喻理', color: 'from-purple-500 to-indigo-400' },
    { value: '引用典故式', label: '引用典故', desc: '名言+当代', color: 'from-purple-400 to-pink-400' },
    { value: '拟人动感式', label: '拟人动感', desc: '让对象"活"起来', color: 'from-pink-400 to-rose-400' },
  ]},
  { group: '词汇创新型', styles: [
    { value: '化用热词式', label: '化用热词', desc: '时代热词俗语', color: 'from-green-500 to-emerald-400' },
    { value: '概念组合式', label: '概念组合', desc: '概念A+概念B', color: 'from-emerald-400 to-teal-400' },
  ]},
  { group: '价值引领型', styles: [
    { value: '点明宗旨式', label: '点明宗旨', desc: '理念+推动工作', color: 'from-gray-400 to-gray-300' },
    { value: '鼓舞动员式', label: '鼓舞动员', desc: '态度+奋力实现', color: 'from-gray-300 to-stone-300' },
  ]},
  { group: '数字统领型', styles: [
    { value: '数字概括式', label: '数字概括', desc: '聚焦+数字+核心词', color: 'from-sky-500 to-blue-400' },
  ]},
]

const specialStyleOptions: { value: HeadingStyle; label: string; icon: string }[] = [
  { value: '随机类型', label: '随机类型', icon: '🎲' },
  { value: '不指定类型', label: '不指定类型', icon: '📋' },
]

// ── 摘要页：可编辑答案 + 补充信息 + 知识库 + 素材库 ──
const materialStore = useMaterialStore()
interface KbInfo { id: string; name: string; is_builtin: boolean; category: string }
const supplementaryText = ref('')
const availableKbs = ref<KbInfo[]>([])
const selectedKbIds = ref<string[]>([])
const loadingKbs = ref(false)
const editableAnswers = ref<{ id: string; answer: string }[]>([])

async function loadKnowledgeBases() {
  loadingKbs.value = true
  try {
    const kbs = await invoke<KbInfo[]>('list_knowledge_bases')
    availableKbs.value = kbs
    // 默认选中菜谱关联的知识库
    selectedKbIds.value = props.recipe?.knowledgeBaseIds?.slice() || []
  } catch (e) {
    console.error('[Compose] 加载知识库失败:', e)
  } finally {
    loadingKbs.value = false
  }
}

/** 补充说明的提示词（仅 question_id === '__supplementary__' 的提示词） */
const supplementaryPrompts = computed(() =>
  allRecipePrompts.value.filter(p => p.question_id === '__supplementary__')
)

/** 从补充说明退回到最后一题 */
function goBackFromSupplementary() {
  showSupplementaryQuestion.value = false
  if (interviewStage.value) {
    state.currentQuestionIndex = interviewStage.value.questions.length - 1
  }
  nextTick(() => scrollChatBottom())
  loadInterviewPrompts()
}

/** 提交补充说明 → 跳转摘要页 */
async function submitSupplementary() {
  const text = userInput.value.trim()
  supplementaryText.value = text
  state.interviewAnswers['__supplementary__'] = text || '（无补充）'
  showSupplementaryQuestion.value = false
  userInput.value = ''
  // 加载知识库 + 素材标签 + 准备可编辑答案
  editableAnswers.value = qaSummary.value.map(qa => ({ id: qa.id, answer: qa.answer }))
  await loadKnowledgeBases()
  await loadMaterialTags()
  showSummary.value = true
  dialogVisible.value = false
  emitProgress()
}

/** 跳过补充说明 → 跳转摘要页 */
async function skipSupplementary() {
  supplementaryText.value = ''
  state.interviewAnswers['__supplementary__'] = '（无补充）'
  showSupplementaryQuestion.value = false
  userInput.value = ''
  editableAnswers.value = qaSummary.value.map(qa => ({ id: qa.id, answer: qa.answer }))
  await loadKnowledgeBases()
  await loadMaterialTags()
  showSummary.value = true
  dialogVisible.value = false
  emitProgress()
}

function toggleKb(kbId: string) {
  const idx = selectedKbIds.value.indexOf(kbId)
  if (idx >= 0) {
    selectedKbIds.value.splice(idx, 1)
  } else {
    selectedKbIds.value.push(kbId)
  }
}

// ── 阶段进度发射 ──
function emitProgress() {
  if (!state.recipe) return
  const total = state.recipe.stages.length
  const stageLabels = state.recipe.stages.map(s => s.stageLabel)
  const idx = state.currentStageIndex >= 0 ? state.currentStageIndex + 1 : 0
  emit('progress', {
    active: true,
    recipeName: state.recipe.name,
    phase: state.phase,
    currentStep: idx,
    totalSteps: total,
    stageLabel: stageLabels[state.currentStageIndex] || '',
  })
}

// ── 计算属性 ──
const interviewStage = computed(() => {
  if (!state.recipe) return null
  return state.recipe.stages.find(s => s.type === 'interview') as InterviewStage | null
})

const currentQuestion = computed((): InterviewQuestion | null => {
  if (!interviewStage.value || state.currentQuestionIndex < 0) return null
  return interviewStage.value.questions[state.currentQuestionIndex] || null
})

const isLastQuestion = computed(() => {
  if (!interviewStage.value) return false
  return state.currentQuestionIndex >= interviewStage.value.questions.length - 1
})

const qaSummary = computed(() => {
  if (!interviewStage.value) return []
  return interviewStage.value.questions.map(q => ({
    question: q.question,
    answer: state.interviewAnswers[q.id] || '（未提供）',
    id: q.id,
  }))
})

// ── 初始化 ──
function init(recipe: ComposeRecipe) {
  Object.assign(state, {
    active: true, recipe, phase: 'interview' as ComposePhase,
    currentStageIndex: 0, interviewAnswers: {}, currentQuestionIndex: 0,
    dynamicQuestion: '', stageLogs: [],
    streamingContent: '', finalContent: '', reviewFindings: [],
    allStagesDone: false, elapsedSeconds: 0, outline: null,
  })
  userInput.value = ''
  error.value = ''
  showSupplementaryQuestion.value = false
  showSummary.value = false
  dialogVisible.value = true
  showOutlineModal.value = false
  outlineConfigExpanded.value = true
  outlineThinkingExpanded.value = false
  outlineItems.value = []
  outlineL2Style.value = '并列排比式'
  outlineL3Style.value = '层层递进式'
  outlineGenerating.value = false
  awaitingPlaybackComplete = false
  outlineFeedback.value = ''
  outlineStructure.value = ''
  editingItemId.value = ''
  editingItemText.value = ''
  outlineThinkingReady.value = false
  reviewStepResults.value = []
  polishStepInfo.value = null
  startTimer()
  emitProgress()
  nextTick(() => loadInterviewPrompts())
}

// ── 计时器 ──
function startTimer() { stopTimer(); elapsedTimer = setInterval(() => { state.elapsedSeconds++ }, 1000) }
function stopTimer() { if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null } }
function formatTime(s: number): string {
  const m = Math.floor(s / 60); const sec = s % 60
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
}

// ── 问答 ──
async function handleSubmit() {
  if (loading.value) return
  const q = currentQuestion.value
  if (!q) return
  const answer = userInput.value.trim()
  state.interviewAnswers[q.id] = answer || '（由AI自行判断）'
  userInput.value = ''
  advanceQuestion()
}

function handleSkip() {
  if (loading.value) return
  const q = currentQuestion.value
  if (!q) return
  state.interviewAnswers[q.id] = '（由AI自行判断）'
  userInput.value = ''
  advanceQuestion()
}

async function advanceQuestion() {
  if (isLastQuestion.value) {
    // 进入补充说明（同一个聊天窗口接着往下走）
    showSupplementaryQuestion.value = true
    supplementaryText.value = ''
    userInput.value = ''
    emitProgress()
    await nextTick()
    scrollChatBottom()
    loadInterviewPrompts() // 刷新全部提示词（供 supplementaryPrompts 使用）
  } else {
    state.currentQuestionIndex++
    emitProgress()
    await nextTick()
    scrollChatBottom()
    loadInterviewPrompts()
  }
}

function goPreviousQuestion() {
  if (state.currentQuestionIndex <= 0) return
  // 保存当前输入（如果有的话）到答案记录
  const curQ = currentQuestion.value
  if (curQ && userInput.value.trim()) {
    state.interviewAnswers[curQ.id] = userInput.value.trim()
  }
  // 退回上一题
  state.currentQuestionIndex--
  // 恢复上一题的答案到输入框
  const prevQ = interviewStage.value?.questions[state.currentQuestionIndex]
  if (prevQ) {
    userInput.value = state.interviewAnswers[prevQ.id] || ''
  }
  nextTick(() => scrollChatBottom())
  loadInterviewPrompts()
}

function handleSelectOption(option: string) {
  if (loading.value) return
  const q = currentQuestion.value
  if (!q) return
  state.interviewAnswers[q.id] = option
  if (isLastQuestion.value) {
    showSupplementaryQuestion.value = true
    supplementaryText.value = ''
    userInput.value = ''
    emitProgress()
    nextTick(() => scrollChatBottom())
    loadInterviewPrompts()
  } else {
    state.currentQuestionIndex++
    emitProgress()
    nextTick(() => scrollChatBottom())
  }
}

function scrollChatBottom() {
  nextTick(() => {
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight
    }
  })
}

// ── 常用提示词 CRUD ──
async function loadInterviewPrompts() {
  const recipeId = state.recipe?.id
  const q = currentQuestion.value
  if (!recipeId) { interviewPrompts.value = []; allRecipePrompts.value = []; return }
  try {
    const all = await invoke<InterviewPromptOut[]>('list_interview_prompts', { recipeId })
    allRecipePrompts.value = all
    // 按当前问题过滤
    if (!q) { interviewPrompts.value = [] }
    else { interviewPrompts.value = all.filter(p => p.question_id === q.id) }
  } catch (e) {
    console.error('[Compose] 加载提示词失败:', e)
  }
}

function startAddPrompt() {
  editingPrompt.id = ''
  editingPrompt.label = ''
  editingPrompt.content = ''
  showPromptEditor.value = true
}

function startEditPrompt(prompt: InterviewPromptOut) {
  editingPrompt.id = prompt.id
  editingPrompt.label = prompt.label
  editingPrompt.content = prompt.content
  showPromptEditor.value = true
}

function cancelEditPrompt() {
  showPromptEditor.value = false
  editingPrompt.id = ''
  editingPrompt.label = ''
  editingPrompt.content = ''
}

async function savePrompt() {
  const recipeId = state.recipe?.id
  // 确定当前 questionId：补充模式用 '__supplementary__'，否则用当前问题 id
  const questionId = showSupplementaryQuestion.value ? '__supplementary__' : currentQuestion.value?.id ?? null
  if (!recipeId || !questionId) return
  if (!editingPrompt.label.trim() || !editingPrompt.content.trim()) return
  try {
    await invoke<InterviewPromptOut>('save_interview_prompt', {
      promptId: editingPrompt.id || null,
      recipeId,
      questionId,
      label: editingPrompt.label.trim(),
      content: editingPrompt.content.trim(),
    })
    cancelEditPrompt()
    await loadInterviewPrompts()
  } catch (e) {
    console.error('[Compose] 保存提示词失败:', e)
  }
}

async function deletePrompt(promptId: string) {
  try {
    await invoke('delete_interview_prompt', { promptId })
    await loadInterviewPrompts()
  } catch (e) {
    console.error('[Compose] 删除提示词失败:', e)
  }
}

function applyPrompt(content: string) {
  if (!userInput.value.trim()) {
    userInput.value = content
  } else {
    userInput.value = userInput.value.trimEnd() + '；' + content
  }
}

function goBackToQuestions() {
  // 摘要页编辑的值同步回 interviewAnswers
  for (const ea of editableAnswers.value) {
    state.interviewAnswers[ea.id] = ea.answer
  }
  // 回到第一题，用户可从头修改
  showSupplementaryQuestion.value = false
  showSummary.value = false
  dialogVisible.value = true
  if (interviewStage.value) {
    state.currentQuestionIndex = 0
  }
  userInput.value = ''
  nextTick(() => scrollChatBottom())
  loadInterviewPrompts()
}

// ── 解析用户选择的知识库 ID ──
function getKbIds(): string[] {
  try {
    return JSON.parse(state.interviewAnswers['__kb_ids__'] || '[]')
  } catch {
    return []
  }
}

// ── 解析用户选择的素材标签 ID ──
function getMaterialTagIds(): string[] {
  try {
    return JSON.parse(state.interviewAnswers['__material_tag_ids__'] || '[]')
  } catch {
    return []
  }
}

// ── 获取要传给后端的 materialTagIds（有标签返回标签列表，无标签返回 null） ──
function getMaterialTagIdsForInvoke(): string[] | null {
  const ids = getMaterialTagIds()
  return ids.length > 0 ? ids : null
}

// ── 加载素材标签列表 ──
async function loadMaterialTags() {
  await materialStore.loadTagWithCounts()
}

// ── 流式提取 thinking 字段 ──
/**
 * 从部分 JSON 字符串中提取 "thinking" 字段的值。
 * 处理转义字符（\\n → 换行、\\" → 引号等）。
 * 返回 null 表示尚未找到 thinking 字段（继续等待）。
 */
function extractThinking(raw: string): string | null {
  // 查找 "thinking" 键
  const keyIdx = raw.indexOf('"thinking"')
  if (keyIdx === -1) return null

  // 找到 thinking 值起始位置（跳过 "thinking":" 或 "thinking": "）
  const colonIdx = raw.indexOf(':', keyIdx + 10)
  if (colonIdx === -1) return null
  let start = colonIdx + 1
  while (start < raw.length && raw[start] === ' ') start++
  if (start >= raw.length || raw[start] !== '"') return null
  start++ // 跳过开头的 "

  // 从 start 开始逐字符解析，处理转义
  let result = ''
  let i = start
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '\\') {
      // 转义序列：检查下一个字符
      if (i + 1 < raw.length) {
        const next = raw[i + 1]
        switch (next) {
          case 'n': result += '\n'; break
          case 't': result += '\t'; break
          case 'r': result += '\r'; break
          case '\\': result += '\\'; break
          case '"': result += '"'; break
          case '/': result += '/'; break
          case 'u': {
            // Unicode 转义 \uXXXX
            if (i + 5 < raw.length) {
              const hex = raw.slice(i + 2, i + 6)
              const code = parseInt(hex, 16)
              if (!isNaN(code)) result += String.fromCodePoint(code)
              i += 4
            } else {
              result += next // 不完整，保留原字符
            }
            break
          }
          default: result += next; break
        }
        i += 2
        continue
      }
    }
    if (ch === '"') {
      // 找到结束引号 → thinking 字段已完整
      return result
    }
    result += ch
    i++
  }

  // 尚未找到结束引号，返回已提取的部分
  return result
}

// ── 构建简报 ──
function buildBrief(): string {
  const answers = state.interviewAnswers
  const recipeName = state.recipe?.name || ''
  let brief = `## 写作任务：${recipeName}\n\n以下是通过问答收集到的信息：\n\n`
  for (const stage of state.recipe?.stages || []) {
    if (stage.type === 'interview') {
      for (const q of stage.questions) {
        brief += `**${q.question}**\n${answers[q.id] || '（未提供）'}\n\n`
      }
    }
  }
  // 补充说明
  const supplementary = answers['__supplementary__']
  if (supplementary) {
    brief += `## 用户补充说明\n${supplementary}\n\n`
  }
  brief += '\n请根据以上信息，撰写一篇完整的文稿。要求结构清晰、内容充实、语言得体。'
  return brief
}

// ── 阶段：生成提纲 ──
const outlineThinkingEl = ref<HTMLDivElement>()

function randomizeStyle(isL2: boolean) {
  const pick = allHeadingStyles[Math.floor(Math.random() * allHeadingStyles.length)]
  if (isL2) outlineL2Style.value = pick
  else outlineL3Style.value = pick
}


function toggleOutlineConfig() {
  outlineConfigExpanded.value = !outlineConfigExpanded.value
}

async function generateOutline() {
  outlineGenerating.value = true
  outlineThinkingDone.value = false
  outlineThinking.value = ''
  outlineItems.value = []
  outlineThinkingExpanded.value = true
  outlineConfigExpanded.value = false // 生成后自动折叠配置区

  const scopeAnswer = outlineStructure.value || ''
  const recipeName = state.recipe?.name || ''
  const feedback = outlineFeedback.value.trim()
  outlineFeedback.value = '' // 清空反馈

  const feedbackPrompt = feedback
    ? `\n\n## 用户对上次提纲不满意，新的要求\n${feedback}\n\n请根据此反馈重新构思提纲。`
    : ''

  // 构建风格描述，处理特殊选项
  const l2IsRandom = outlineL2Style.value === '随机类型'
  const l3IsRandom = outlineL3Style.value === '随机类型'
  const l2IsAuto = outlineL2Style.value === '不指定类型'
  const l3IsAuto = outlineL3Style.value === '不指定类型'
  const allStyleList = allHeadingStyles.join('、')
  const l2StyleDesc = l2IsRandom
    ? `随机类型（每次为不同标题从 [${allStyleList}] 中随机选一种）`
    : l2IsAuto
    ? '不指定类型（由你自由选择最合适的招式）'
    : outlineL2Style.value
  const l3StyleDesc = l3IsRandom
    ? `随机类型（每次为不同标题从 [${allStyleList}] 中随机选一种）`
    : l3IsAuto
    ? '不指定类型（由你自由选择最合适的招式）'
    : outlineL3Style.value

  const systemPrompt = `你是公文提纲智能构建引擎，请根据用户需求和写作主题，生成结构化的文章提纲。

## 六型十四式招式库

**结构强化型**：1.并列排比式(统一动词+不同宾语) 2.对仗工整式(动宾A+动宾B对称) 3.统一后缀式(内容+式/化/型/力)
**逻辑关系型**：4.破立转换式(破除A树立B) 5.辩证统一式(既要A又要B) 6.层层递进式(基础→中级→高级)
**意象赋能型**：7.生动比喻式(压舱石/牛鼻子/先手棋) 8.引用典故式(名言+当代精神) 9.拟人动感式(让数据说话)
**词汇创新型**：10.化用热词式(新质生产力/最后一公里) 11.概念组合式(概念A+概念B+后缀)
**价值引领型**：12.点明宗旨式(践行理念+推动工作) 13.鼓舞动员式(以昂扬斗志奋力开创)
**数字统领型**：14.数字概括式(实施"三大工程"、打好"四大攻坚战")

## SCAR 要素
S(情境)：什么时空/条件/范畴？ C(驱动)：为什么必须行动？ A(行动)：做什么/怎么做？ R(结果)：什么效果/价值？
映射法则：C2(问题短板)→A2(策略) 优先 破立/辩证式 | A3(行动)→R2(目标) 优先 排比/数字式 | S1(时空)→C1(风险) 优先 比喻/对仗式

## 构建约束
1. 一级标题3-5个，确立统一主干句式模板，强制所有一级标题严格复用同一句式
2. 每个一级标题下2-4个二级标题，MECE原则，同组内强制统一子句式
3. 用强动词（筑牢/锻造/拧紧/激活/扫清）替换平庸动词（加强/推进/做好）
4. 剔除万能废话，补充特定主体/方向/阶段特征
5. **标题严禁使用冒号（：）和破折号（——）**，保持标题的识别力和整体感

## 输出格式（严格 JSON）
{"thinking":"构思过程…","items":[{"level":2,"text":"二级标题","parentId":null},{"level":3,"text":"三级标题","parentId":"上一级二级标题的临时ID(如item_0)"},…]}

## 风格要求
- 二级标题：${l2StyleDesc}，侧重 S+C 或 C+A 组合
- 三级标题：${l3StyleDesc}，侧重 A+R 或 A 组合
- thinking 中体现招式选择和 SCAR 推理过程`

  const userContent = `## 写作主题
${recipeName}

## 用户想要的结构
${scopeAnswer}

## 问卷结果
${buildBrief()}${feedbackPrompt}

请根据以上信息，按 ${l2StyleDesc} + ${l3StyleDesc} 风格生成提纲。`

  try {
    // SSE 流式调用 AI 生成提纲
    console.log('[Compose] 开始生成提纲（流式）...')
    const startTime = Date.now()
    const kbIds = getKbIds()
    const rawBuffer: string[] = []
    // 流式期间从原始 JSON 中实时提取 thinking 字段，边收边渲染
    outlineThinking.value = 'AI 正在思考，请稍候…'
    let thinkingDone = false
    const result = await invokeStream('ai_compose_streaming', {
      systemPrompt,
      userContent,
      temperature: feedback ? 0.8 : 0.7,
      knowledgeBaseIds: kbIds.length > 0 ? kbIds : null,
      materialTagIds: getMaterialTagIdsForInvoke(),
    }, (_token) => {
      rawBuffer.push(_token)
      if (!thinkingDone) {
        const partialThinking = extractThinking(rawBuffer.join(''))
        if (partialThinking !== null) {
          outlineThinking.value = partialThinking || 'AI 正在思考…'
          if (!outlineThinkingReady.value) outlineThinkingReady.value = true
          nextTick(() => {
            const el = outlineThinkingEl.value
            if (el) el.scrollTop = el.scrollHeight
          })
        }
      }
    })
    thinkingDone = true
    console.log(`[Compose] 提纲生成完成，耗时 ${Date.now() - startTime}ms`)

    // 解析 AI 返回
    let parsed: { thinking?: string; items?: Array<{ level: number; text: string; parentId?: string | null }> } | null = null
    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/)
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0])
    } catch { /* ignore */ }

    // 替换为提取的真实思考文本（不再需要打字机效果，流式已经够快）
    const realThinking = parsed?.thinking || 'AI 构思完成，未返回思考过程。'
    outlineThinking.value = realThinking
    outlineThinkingDone.value = true
    outlineThinkingExpanded.value = false

    if (parsed?.items && parsed.items.length > 0) {
      const parentMap = new Map<number, string>()
      let idCounter = 0
      outlineItems.value = parsed.items.map((item: { level: number; text: string; parentId?: string | null }) => {
        const id = `outline_${idCounter++}`
        let parentId: string | undefined
        if (item.level === 2) {
          parentMap.set(idCounter - 1, id)
        } else if (item.level === 3 && item.parentId) {
          // Find the corresponding level 2 parent
          const parentIdx = parseInt(item.parentId.replace('item_', ''))
          parentId = parentMap.get(parentIdx)
        }
        return {
          id,
          level: item.level as 2 | 3,
          text: item.text,
          parentId,
        }
      })
    } else {
      // 降级：手动解析 markdown 标题
      outlineItems.value = parseOutlineFromText(result)
    }
  } catch (e: any) {
    console.error('[Compose] 提纲生成失败:', e)
    error.value = `提纲生成失败: ${String(e)}`
  } finally {
    outlineGenerating.value = false
  }
}

function parseOutlineFromText(text: string): OutlineItem[] {
  const items: OutlineItem[] = []
  const lines = text.split('\n')
  let idCounter = 0
  let lastH2Id = ''
  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)/)
    const h3Match = line.match(/^###\s+(.+)/)
    if (h2Match) {
      const id = `outline_${idCounter++}`
      lastH2Id = id
      items.push({ id, level: 2, text: h2Match[1].trim() })
    } else if (h3Match) {
      const id = `outline_${idCounter++}`
      items.push({ id, level: 3, text: h3Match[1].trim(), parentId: lastH2Id })
    }
  }
  return items
}

async function regenerateOutlineItem(itemId: string) {
  const idx = outlineItems.value.findIndex(o => o.id === itemId)
  if (idx < 0) return

  const item = outlineItems.value[idx]
  const scopeAnswer = outlineStructure.value || ''
  // 特殊选项处理：随机类型→随机选一种，不指定类型→让AI自由发挥
  const globalStyle = item.level === 2 ? outlineL2Style.value : outlineL3Style.value
  const style: HeadingStyle = globalStyle === '随机类型'
    ? allHeadingStyles[Math.floor(Math.random() * allHeadingStyles.length)]
    : globalStyle === '不指定类型'
    ? allHeadingStyles[Math.floor(Math.random() * allHeadingStyles.length)] // 不指定时也随机给一种
    : globalStyle

  const prompt = `请重新生成下面这个${item.level === 2 ? '二级' : '三级'}标题，用${style}风格：

原标题：${item.text}

写作主题：${state.recipe?.name || ''}
用户意图：${scopeAnswer}

只输出一个新的标题文本，不要加任何解释或标记。`

  try {
    const kbIds = getKbIds()
    const result = await invoke<string>('ai_compose', {
      systemPrompt: `你是一位标题润色专家，专门撰写${style}风格的标题。请直接输出标题文本。`,
      userContent: prompt,
      temperature: 0.8,
      knowledgeBaseIds: kbIds.length > 0 ? kbIds : null,
      materialTagIds: getMaterialTagIdsForInvoke(),
    })
    const newText = result.replace(/^["'「『]|["'」』]$/g, '').replace(/^#+\s*/, '').trim() || item.text
    outlineItems.value[idx] = { ...item, text: newText }
  } catch (e: any) {
    console.error('[Compose] 标题再生失败:', e)
  }
}

async function refineOutlineItem(itemId: string) {
  const idx = outlineItems.value.findIndex(o => o.id === itemId)
  if (idx < 0) return

  const item = outlineItems.value[idx]
  if (!item.userRequirement?.trim()) return

  const globalStyle = item.level === 2 ? outlineL2Style.value : outlineL3Style.value
  const style: HeadingStyle = globalStyle === '随机类型'
    ? allHeadingStyles[Math.floor(Math.random() * allHeadingStyles.length)]
    : globalStyle === '不指定类型'
    ? allHeadingStyles[Math.floor(Math.random() * allHeadingStyles.length)]
    : globalStyle

  const prompt = `请根据用户要求优化这个${item.level === 2 ? '二级' : '三级'}标题：

原标题：${item.text}
用户要求：${item.userRequirement}
标题风格：${style}

只输出优化后的标题文本，不要加任何解释。`

  try {
    const kbIds = getKbIds()
    const result = await invoke<string>('ai_compose', {
      systemPrompt: '你是一位标题优化专家。请直接输出标题文本。',
      userContent: prompt,
      temperature: 0.7,
      knowledgeBaseIds: kbIds.length > 0 ? kbIds : null,
      materialTagIds: getMaterialTagIdsForInvoke(),
    })
    const newText = result.replace(/^["'「『]|["'」』]$/g, '').replace(/^#+\s*/, '').trim() || item.text
    outlineItems.value[idx] = { ...item, text: newText, userRequirement: '' }
  } catch (e: any) {
    console.error('[Compose] 标题优化失败:', e)
  }
}

// ── 提纲内联编辑 ──
function startEditingItem(itemId: string) {
  const item = outlineItems.value.find(o => o.id === itemId)
  if (!item) return
  editingItemId.value = itemId
  editingItemText.value = item.text
}

function confirmEditItem() {
  if (!editingItemId.value) return
  const idx = outlineItems.value.findIndex(o => o.id === editingItemId.value)
  if (idx >= 0 && editingItemText.value.trim()) {
    outlineItems.value[idx] = { ...outlineItems.value[idx], text: editingItemText.value.trim() }
  }
  editingItemId.value = ''
  editingItemText.value = ''
}

function cancelEditItem() {
  editingItemId.value = ''
  editingItemText.value = ''
}

// ── 提纲增删 ──
let _outlineIdCounter = 1000
function addOutlineItem(level: 2 | 3, parentId?: string) {
  const id = `outline_man_${_outlineIdCounter++}`
  if (level === 2 || !parentId) {
    outlineItems.value.push({ id, level: 2, text: '新标题' })
  } else {
    outlineItems.value.push({ id, level: 3, text: '新子标题', parentId })
  }
}

function deleteOutlineItem(itemId: string) {
  const item = outlineItems.value.find(o => o.id === itemId)
  if (!item) return
  // 删二级标题时连子标题一起删
  if (item.level === 2) {
    outlineItems.value = outlineItems.value.filter(o => o.id !== itemId && o.parentId !== itemId)
  } else {
    outlineItems.value = outlineItems.value.filter(o => o.id !== itemId)
  }
}

function confirmOutline() {
  // 保存提纲数据（含结构意图和用户逐项要求，供生成阶段使用）
  state.outline = {
    headingStyleL2: outlineL2Style.value,
    headingStyleL3: outlineL3Style.value,
    items: outlineItems.value,
    thinking: outlineThinking.value,
    outlineStructure: outlineStructure.value || undefined,
  }
  showOutlineModal.value = false
  // 同步提示词中的提纲
  state.interviewAnswers['__outline_json__'] = JSON.stringify(state.outline)
  nextTick(async () => {
    await startGenerate()
  })
}

function buildOutlinePrompt(): string {
  if (!state.outline || state.outline.items.length === 0) return ''

  let outline = '## 文章提纲\n\n'
  // 用户整体结构意图（最优先约束）
  if (state.outline.outlineStructure) {
    outline += `**整体结构要求**：${state.outline.outlineStructure}\n\n`
  }
  // 逐项标题 + 用户对每项的特别要求
  for (const item of state.outline.items) {
    if (item.level === 2) {
      outline += `## ${item.text}\n\n`
    } else {
      outline += `### ${item.text}\n\n`
    }
    if (item.userRequirement?.trim()) {
      outline += `> 用户对此部分的要求：${item.userRequirement}\n\n`
    }
  }
  outline += `\n二级标题风格：${state.outline.headingStyleL2}\n三级标题风格：${state.outline.headingStyleL3}\n`
  outline += '\n请严格按照以上提纲结构、用户整体结构要求、各标题内容要求及标题风格撰写文章正文。保持标题不变，为每个标题补充充实的内容。'
  return outline
}

// ── 阶段：生成 ──
async function confirmStartOutline() {
  // 同步摘要页编辑的答案
  for (const ea of editableAnswers.value) {
    state.interviewAnswers[ea.id] = ea.answer
  }
  // 保存补充说明和知识库 ID（安全冗余）
  state.interviewAnswers['__supplementary__'] = supplementaryText.value
  state.interviewAnswers['__kb_ids__'] = JSON.stringify(selectedKbIds.value)
  state.interviewAnswers['__material_tag_ids__'] = JSON.stringify(materialStore.selectedMaterialTagIds)

  showSummary.value = false
  dialogVisible.value = false
  state.phase = 'outline_generating'
  emitProgress()
  showOutlineModal.value = true
  await nextTick()
}

/** 跳过提纲阶段，直接进入正文撰写 */
async function confirmDirectGenerate() {
  for (const ea of editableAnswers.value) {
    state.interviewAnswers[ea.id] = ea.answer
  }
  state.interviewAnswers['__supplementary__'] = supplementaryText.value
  state.interviewAnswers['__kb_ids__'] = JSON.stringify(selectedKbIds.value)
  state.interviewAnswers['__material_tag_ids__'] = JSON.stringify(materialStore.selectedMaterialTagIds)

  // 无提纲模式
  state.outline = null
  showSummary.value = false
  dialogVisible.value = false
  showOutlineModal.value = false

  state.phase = 'generating'
  emitProgress()
  await nextTick()
  await startGenerate()
}

async function startGenerate() {
  state.phase = 'generating'
  state.currentStageIndex = state.recipe?.stages.findIndex(s => s.type === 'generate') ?? 2
  emitProgress()
  loading.value = true

  try {
    const genStage = state.recipe?.stages.find(s => s.type === 'generate') as GenerateStage | undefined
    const systemPrompt = buildGeneratePrompt()
    const hasOutline = state.outline && state.outline.items.length > 0
    let prompt = buildBrief() + '\n\n## 任务\n'
    if (hasOutline) {
      prompt += buildOutlinePrompt()
      prompt += '\n\n请根据提纲和以上信息，撰写一篇完整的文稿。'
    } else {
      prompt += '\n\n请根据以上信息，撰写一篇完整的文稿。要求结构清晰、内容充实、语言得体。'
    }

    const kbIds = getKbIds()

    console.log('[Compose] 开始生成（流式），温度:', genStage?.temperature ?? 0.7, '知识库:', kbIds, hasOutline ? `提纲条目数:${state.outline!.items.length}` : '无提纲')
    const startTime = Date.now()

    // 清空编辑器，准备流式写入
    emit('stream', { type: 'replace', text: '' })

    const result = await invokeStream('ai_compose_streaming', {
      systemPrompt,
      userContent: prompt,
      temperature: genStage?.temperature ?? 0.7,
      knowledgeBaseIds: kbIds.length > 0 ? kbIds : null,
      materialTagIds: getMaterialTagIdsForInvoke(),
    }, (token) => {
      emit('stream', { type: 'append', text: token })
    })
    console.log(`[Compose] 生成完成，耗时 ${Date.now() - startTime}ms，${result.length} 字符`)

    state.streamingContent = result
  } catch (e: any) {
    console.error('[Compose] 生成失败:', e)
    error.value = String(e)
  } finally {
    loading.value = false
  }

  await startReview()
}

function buildGeneratePrompt(): string {
  const recipeName = state.recipe?.name || ''
  const interviewSys =
    (state.recipe?.stages.find(s => s.type === 'interview') as InterviewStage)?.systemPrompt || ''
  return `你是一位专业的公文写作专家，擅长撰写${recipeName}。

## 写作要求
1. 严格遵循${recipeName}的文体规范和格式要求
2. 结构严谨、逻辑清晰、层次分明
3. 语言庄重得体、表达精准有力
4. 使用 Markdown 格式输出

## 参考风格
${interviewSys}

请直接输出完整的文稿内容，包含标题、正文各段落。`
}

// ── 阶段：审查 ──
async function startReview() {
  state.phase = 'reviewing'
  state.currentStageIndex = state.recipe?.stages.findIndex(s => s.type === 'review') ?? 3
  emitProgress()
  loading.value = true
  state.reviewFindings = []

  const reviewStage = state.recipe?.stages.find(
    (s): s is ReviewStage => s.type === 'review'
  )
  if (!reviewStage || reviewStage.type !== 'review') {
    console.log('[Compose] 跳过审查阶段：无 review stage')
    loading.value = false
    await startPolish()
    return
  }

  const skillLabelMap: Record<string, string> = {
    skill_logic: '逻辑审查', skill_grammar: '病句检查',
    skill_concise: '冗余精简', skill_official: '文体规范',
  }

  console.log(`[Compose] 开始审查，技能数: ${reviewStage.skillIds.length}`, reviewStage.skillIds)

  for (let i = 0; i < reviewStage.skillIds.length; i++) {
    const skillId = reviewStage.skillIds[i]
    const skillLabel = skillLabelMap[skillId] || skillId
    console.log(`[Compose] 审查子步骤 ${i + 1}/${reviewStage.skillIds.length}: ${skillId}`)

    // 开始审查，尚无发现
    emit('progress', {
      active: true,
      recipeName: state.recipe?.name || '',
      phase: 'reviewing',
      currentStep: i + 1,
      totalSteps: reviewStage.skillIds.length,
      stageLabel: reviewStage.stageLabel,
      reviewSkillLabel: skillLabel,
      reviewFindingsCount: -1, // -1 表示「正在检查」
      reviewFixedCount: 0,
    })

    try {
      const startTime = Date.now()
      const result = await invoke<string>('compose_review', {
        skillId,
        content: state.streamingContent,
        materialTagIds: getMaterialTagIdsForInvoke(),
      })
      console.log(`[Compose] ${skillId} 审查完成，耗时 ${Date.now() - startTime}ms，返回 ${result.length} 字符`)

      const findings = parseFindings(result, skillId)
      console.log(`[Compose] ${skillId} 发现问题: ${findings.length}`, findings.map(f => f.severity))

      state.reviewFindings.push(...findings)

      // 保存修复前的原文（用于最终附件）
      const contentBeforeFix = state.streamingContent
      let actualFindingsCount = findings.length // 默认用 AI 自报数，修复后会被实际 diff 数覆盖

      // 通知进度：发现 N 个问题
      emit('progress', {
        active: true,
        recipeName: state.recipe?.name || '',
        phase: 'reviewing',
        currentStep: i + 1,
        totalSteps: reviewStage.skillIds.length,
        stageLabel: reviewStage.stageLabel,
        reviewSkillLabel: skillLabel,
        reviewFindingsCount: findings.length,
        reviewFixedCount: 0,
      })

      if (reviewStage.autoFix) {
        // 智能门控：审查返回太短（< 100 字符）说明确实无问题，跳过修复
        if (findings.length === 0 && result.length < 100) {
          console.log(`[Compose] ${skillId} 审查返回极短（${result.length} 字符），确认无问题，跳过修复`)
          emit('progress', {
            active: true,
            recipeName: state.recipe?.name || '',
            phase: 'reviewing',
            currentStep: i + 1,
            totalSteps: reviewStage.skillIds.length,
            stageLabel: reviewStage.stageLabel,
            reviewSkillLabel: skillLabel,
            reviewFindingsCount: 0,
            reviewFixedCount: 0,
          })
          actualFindingsCount = 0
        } else {
        console.log(`[Compose] ${skillId} 开始自动修复（AI 自报 ${findings.length} 个问题）...`)

        // 通知进度：正在修复
        emit('progress', {
          active: true,
          recipeName: state.recipe?.name || '',
          phase: 'reviewing',
          currentStep: i + 1,
          totalSteps: reviewStage.skillIds.length,
          stageLabel: reviewStage.stageLabel,
          reviewSkillLabel: skillLabel,
          reviewFindingsCount: findings.length,
          reviewFixedCount: -1, // -1 表示「正在修复」
        })

        const fixStartTime = Date.now()
        const kbIds = getKbIds()
        const oldContent = state.streamingContent  // 保存修复前的原文
        // 使用 invokeStream 获取修正全文，实时更新 token 进度
        let fixTokenCount = 0
        const fixed = await invokeStream('ai_compose_streaming', {
          systemPrompt:
            '你是一位专业的文档修正专家。请根据审查意见修正以下文档中的问题。只输出修正后的完整文档，不要解释。',
          userContent: `## 审查意见\n${result}\n\n## 原始文档\n${oldContent}\n\n请根据审查意见修正所有问题，输出完整修正文档。`,
          temperature: 0.3,
          knowledgeBaseIds: kbIds.length > 0 ? kbIds : null,
          materialTagIds: getMaterialTagIdsForInvoke(),
        }, (_token) => {
          fixTokenCount++
          // 每 30 个 token 更新进度条
          if (fixTokenCount % 30 === 0) {
            emit('progress', {
              active: true,
              recipeName: state.recipe?.name || '',
              phase: 'reviewing',
              currentStep: i + 1,
              totalSteps: reviewStage.skillIds.length,
              stageLabel: reviewStage.stageLabel,
              reviewSkillLabel: `${skillLabel}（已接收 ${fixTokenCount} tokens）`,
              reviewFindingsCount: findings.length,
              reviewFixedCount: -1,
            })
          }
        })
        console.log(`[Compose] ${skillId} 修复完成，耗时 ${Date.now() - fixStartTime}ms`)
        state.streamingContent = fixed

        // 用 diff 计算实际改动数（比 AI 自报的 "问题 X 个" 更准确）
        const fixOps = diffChars(contentBeforeFix, fixed)
        const fixChunks = chunkDiffOps(fixOps)
        const actualFixCount = fixChunks.filter(c => c.kind !== 'keep').length
        console.log(`[Compose] ${skillId} 修复 diff: ${actualFixCount} 处改动`, fixChunks.filter(c => c.kind !== 'keep').map(c => ({ kind: c.kind, old: c.oldText.length, new: c.newText.length })))

        // 原文不动，逐操作回放 diff（改哪看哪，原文高亮 + 新文闪烁）
        emit('stream', {
          type: 'diff_playback',
          oldText: contentBeforeFix,
          newText: fixed,
        })
        for (const f of findings) {
          f.fixed = true
          f.fixDescription = '已自动修复'
        }

        // 通知进度：修复完成（用实际改动数）
        emit('progress', {
          active: true,
          recipeName: state.recipe?.name || '',
          phase: 'reviewing',
          currentStep: i + 1,
          totalSteps: reviewStage.skillIds.length,
          stageLabel: reviewStage.stageLabel,
          reviewSkillLabel: skillLabel,
          reviewFindingsCount: actualFixCount,
          reviewFixedCount: actualFixCount,
        })

        // 保存实际改动数（用于最终附件）
        actualFindingsCount = actualFixCount
      } // 关闭 else (findings.length > 0 || result.length >= 100)
      }

      // 保存本子步骤结果（用于最终附件）
      reviewStepResults.value.push({
        skillId,
        skillLabel,
        rawResult: result,
        findingsCount: actualFindingsCount,
        fixed: reviewStage.autoFix && actualFindingsCount > 0,
        oldContent: contentBeforeFix,
        newContent: state.streamingContent,
      })
    } catch (e: any) {
      console.error(`[Compose] ${skillId} 执行失败:`, e)
      const msg = `审查技能 ${skillId} 执行失败: ${String(e)}`
      error.value = msg

      emit('progress', {
        active: true,
        recipeName: state.recipe?.name || '',
        phase: 'reviewing',
        currentStep: i + 1,
        totalSteps: reviewStage.skillIds.length,
        stageLabel: reviewStage.stageLabel,
        reviewSkillLabel: skillLabel,
        reviewFindingsCount: 0,
        reviewFixedCount: -2, // -2 表示「执行失败」
      })

      setTimeout(() => {
        if (error.value === msg) error.value = ''
      }, 8000)
    }
  }

  console.log('[Compose] 审查阶段完成，开始润色')
  loading.value = false
  await startPolish()
}

function parseFindings(text: string, skillId: string): ReviewFinding[] {
  // 多格式容忍解析：AI 可能返回 问题N、- 条目、数字列表等多种形式
  const categoryMap: Record<string, string> = { skill_logic: 'logic', skill_grammar: 'grammar', skill_official: 'style', skill_concise: 'style' }
  const sevMap: [RegExp, ReviewFinding['severity']][] = [
    [/高|严重|关键|重大|致命|🔴/i, 'high' as const],
    [/低|轻微|建议|可选|🟢/i, 'low' as const],
  ]
  
  // ── 尝试结构化解析 ──
  const structured = parseStructured(text, skillId, categoryMap, sevMap)
  if (structured.length > 0) return structured
  
  // ── 回退：按段落拆分，每个有意义段落计为一个 finding ──
  const findings: ReviewFinding[] = []
  const paragraphs = text.split(/\n{2,}/).filter(p => {
    const t = p.trim()
    return t.length > 8 && !/^(no|没有|无|none|不需要)/i.test(t)
  })
  for (const para of paragraphs) {
    const desc = para.replace(/\n/g, ' ').trim()
    if (desc.length < 5) continue
    let sev: ReviewFinding['severity'] = 'medium'
    if (/高|严重|关键|必须|重大|重要|致命|🔴/.test(desc)) sev = 'high'
    else if (/低|轻微|建议|可选|可以|🟢/.test(desc)) sev = 'low'
    findings.push({ category: categoryMap[skillId] || 'style', severity: sev, description: desc.length > 150 ? desc.slice(0, 150) : desc, fixed: false })
  }
  return findings
}

/** 从 AI 返回文本中提取结构化问题列表（容忍多种格式） */
function parseStructured(
  text: string, skillId: string,
  categoryMap: Record<string, string>,
  sevMap: [RegExp, ReviewFinding['severity']][],
): ReviewFinding[] {
  const findings: ReviewFinding[] = []
  // 按 "问题N"、"- "、"数字. " 作为条目分隔
  const blocks = text.split(/(?:^|\n)\s*(?:问题\s*\d+[：:]*|[-*•]\s*|(?<!\d)\d+[.、)]\s*)/gm).filter(b => b.trim().length > 5)
  const items = blocks.length > 1 ? blocks : [text] // 至少整体作为一个条目

  for (const item of items) {
    const desc0 = item.replace(/\n/g, ' ').replace(/\*\*/g, '').trim()
    if (desc0.length < 5) continue
    // 判定严重程度
    let severity: ReviewFinding['severity'] = 'medium'
    for (const [re, sev] of sevMap) {
      if (re.test(desc0)) { severity = sev; break }
    }
    // 去掉严重程度关键词和前缀符号后的纯文本
    let desc = desc0
      .replace(/[🔴🟡🟢]\s*(?:高|中|低|严重|一般|轻微)\s*[：:]*\s*/g, '')
      .replace(/^(?:问题\s*\d+[：:]*|[-*•]|\d+[.、)])\s*/g, '')
      .trim()
    if (!desc) desc = desc0 // 如果去掉后为空，用原文
    findings.push({ category: categoryMap[skillId] || 'style', severity, description: desc.length > 150 ? desc.slice(0, 150) : desc, fixed: false })
  }
  return findings
}

// ── 阶段：润色 ──
async function startPolish() {
  state.phase = 'polishing'
  state.currentStageIndex = state.recipe?.stages.findIndex(s => s.type === 'polish') ?? 4
  emitProgress()
  loading.value = true

  const polishStage = state.recipe?.stages.find(
    (s): s is PolishStage => s.type === 'polish'
  )
  if (!polishStage || polishStage.type !== 'polish') {
    console.log('[Compose] 跳过润色阶段：无 polish stage')
    loading.value = false
    finish()
    return
  }

  const polishSkillLabelMap: Record<string, string> = {
    skill_spirit: '精神融入',
    skill_golden: '金句评估',
    skill_concise: '冗余精简',
  }
  const polishSkillLabel = polishSkillLabelMap[polishStage.skillId] || polishStage.skillId

  try {
    console.log('[Compose] 开始润色，技能:', polishStage.skillId)
    const startTime = Date.now()
    const oldContent = state.streamingContent  // 保存润色前原文

    // 通知进度：正在润色
    emit('progress', {
      active: true,
      recipeName: state.recipe?.name || '',
      phase: 'polishing',
      currentStep: 1,
      totalSteps: 1,
      stageLabel: polishStage.stageLabel,
      reviewSkillLabel: polishSkillLabel,
      reviewFindingsCount: -1,
      reviewFixedCount: -1,
    })

    // 第一步：调用技能获取诊断意见（流式，保持进度动画）
    let tokenCount = 0
    const diagnostic = await invokeStream('compose_review_streaming', {
      skillId: polishStage.skillId,
      content: oldContent,
      materialTagIds: getMaterialTagIdsForInvoke(),
    }, (_token) => {
      tokenCount++
      if (tokenCount % 30 === 0) {
        emit('progress', {
          active: true,
          recipeName: state.recipe?.name || '',
          phase: 'polishing',
          currentStep: 1,
          totalSteps: 1,
          stageLabel: polishStage.stageLabel,
          reviewSkillLabel: `${polishSkillLabel}（分析中，已输出 ${tokenCount} tokens）`,
          reviewFindingsCount: -1,
          reviewFixedCount: -1,
        })
      }
    })
    console.log(`[Compose] 润色诊断完成，耗时 ${Date.now() - startTime}ms，${diagnostic.length} 字符`)

    // 第二步：将诊断意见 + 原文交给修复器，输出润色后的完整全文
    const kbIds = getKbIds()
    let fixTokenCount = 0
    const result = await invokeStream('ai_compose_streaming', {
      systemPrompt:
        '你是一位专业的文档润色专家。请根据润色意见对文档进行修改，只输出修改后的完整文档，不要解释。如果审查意见说明无需修改，则原样输出原文。',
      userContent: `## 润色意见\n${diagnostic}\n\n## 原始文档\n${oldContent}\n\n请根据润色意见修改文档，输出完整修改文档。`,
      temperature: polishStage.temperature ?? 0.7,
      knowledgeBaseIds: kbIds.length > 0 ? kbIds : null,
      materialTagIds: getMaterialTagIdsForInvoke(),
    }, (_token) => {
      fixTokenCount++
      if (fixTokenCount % 30 === 0) {
        emit('progress', {
          active: true,
          recipeName: state.recipe?.name || '',
          phase: 'polishing',
          currentStep: 1,
          totalSteps: 1,
          stageLabel: polishStage.stageLabel,
          reviewSkillLabel: `${polishSkillLabel}（润色中，已输出 ${fixTokenCount} tokens）`,
          reviewFindingsCount: -1,
          reviewFixedCount: -1,
        })
      }
    })
    console.log(`[Compose] 润色完成，耗时 ${Date.now() - startTime}ms，${result.length} 字符`)

    // 用 diff 计算润色实际改动数
    const polishOps = diffChars(oldContent, result)
    const polishChunks = chunkDiffOps(polishOps)
    const polishChangeCount = polishChunks.filter(c => c.kind !== 'keep').length
    console.log(`[Compose] 润色 diff: ${polishChangeCount} 处改动`)

    // 通知进度：发现 N 处可改进点
    emit('progress', {
      active: true,
      recipeName: state.recipe?.name || '',
      phase: 'polishing',
      currentStep: 1,
      totalSteps: 1,
      stageLabel: polishStage.stageLabel,
      reviewSkillLabel: polishSkillLabel,
      reviewFindingsCount: polishChangeCount,
      reviewFixedCount: 0,
    })

    state.streamingContent = result

    // 原文不动，逐操作回放 diff
    emit('stream', {
      type: 'diff_playback',
      oldText: oldContent,
      newText: result,
    })

    // 进度：正在润色修正中
    emit('progress', {
      active: true,
      recipeName: state.recipe?.name || '',
      phase: 'polishing',
      currentStep: 1,
      totalSteps: 1,
      stageLabel: polishStage.stageLabel,
      reviewSkillLabel: polishSkillLabel,
      reviewFindingsCount: polishChangeCount,
      reviewFixedCount: -1, // -1 表示「正在修正」
    })

    // 标记：润色阶段的 diff 回放完成后，父组件回调才允许 finish
    awaitingPlaybackComplete = true

    // 保存润色结果（用于最终附件）
    polishStepInfo.value = {
      skillId: polishStage.skillId,
      skillLabel: polishSkillLabel,
      oldContent: oldContent,
      newContent: result,
    }
  } catch (e: any) {
    console.error('[Compose] 润色失败:', e)
    error.value = String(e)
    awaitingPlaybackComplete = false // 失败时无需等待回放
    finish() // 立即完成

    emit('progress', {
      active: true,
      recipeName: state.recipe?.name || '',
      phase: 'polishing',
      currentStep: 1,
      totalSteps: 1,
      stageLabel: polishStage.stageLabel,
      reviewSkillLabel: polishSkillLabel,
      reviewFindingsCount: 0,
      reviewFixedCount: -2,
    })
  } finally {
    loading.value = false
  }

  // 正常路径：不立即 finish()，等待父组件 diff_playback 动画完成后回调
}

// ── 格式化润色差异文本 ──
/**
 * 对比润色前后全文，生成人类可读的修改摘要。
 * 只展示有实际改动的部分（替换/新增/删除），最多展示 maxItems 条。
 * 返回 { text, count }，方便调用方先展示醒目摘要。
 */
function formatPolishDiff(oldText: string, newText: string, maxItems = 30): { text: string; count: number } {
  const ops = diffChars(oldText, newText)
  const chunks = chunkDiffOps(ops)
  const changedChunks = chunks.filter(c => c.kind !== 'keep')

  if (changedChunks.length === 0) {
    return { text: '（无实质改动）', count: 0 }
  }

  const lines: string[] = [`**共 ${changedChunks.length} 处改动：**\n`]

  const displayChunks = changedChunks.slice(0, maxItems)
  let itemIndex = 0

  for (const c of displayChunks) {
    itemIndex++
    const truncate = (s: string, max = 60) =>
      s.length > max ? s.slice(0, max) + '…' : s

    switch (c.kind) {
      case 'replace':
        lines.push(`${itemIndex}. **修改：**`)
        lines.push(`   - 旧：\`${truncate(c.oldText)}\``)
        lines.push(`   - 新：\`${truncate(c.newText)}\``)
        break
      case 'insert':
        lines.push(`${itemIndex}. **新增：** + \`${truncate(c.newText)}\``)
        break
      case 'delete':
        lines.push(`${itemIndex}. **删除：** - \`${truncate(c.oldText)}\``)
        break
    }
    lines.push('')
  }

  if (changedChunks.length > maxItems) {
    lines.push(`*（共 ${changedChunks.length} 处改动，仅展示前 ${maxItems} 项）*`)
  }

  return { text: lines.join('\n'), count: changedChunks.length }
}

// ── 完成 ──
function finish() {
  state.phase = 'done'

  // 构建附件：阶段4审查记录 + 阶段5润色记录
  let appendix = ''

  // ── 阶段4：审查记录 ──
  if (reviewStepResults.value.length > 0) {
    appendix += '\n\n---\n\n## 质量审查记录\n'

    for (let i = 0; i < reviewStepResults.value.length; i++) {
      const step = reviewStepResults.value[i]
      appendix += `\n### ${i + 1}. ${step.skillLabel}\n`

      const statusText = step.fixed
        ? `（发现 ${step.findingsCount} 个问题，已自动修复）`
        : step.findingsCount > 0
        ? `（发现 ${step.findingsCount} 个问题）`
        : '（未发现问题）'
      appendix += `${statusText}\n`

      // AI 审查意见
      if (step.rawResult) {
        appendix += `\n**审查意见：**\n${step.rawResult}\n`
      }

      // 如果有修复，展示修改差异
      if (step.fixed && step.oldContent !== step.newContent) {
        const diff = formatPolishDiff(step.oldContent, step.newContent, 15)
        appendix += `\n**修复详情：**\n${diff.text}\n`
      }
    }
  }

  // ── 阶段5：润色记录 ──
  if (polishStepInfo.value) {
    const p = polishStepInfo.value
    appendix += `\n---\n\n## 润色定稿记录\n`
    appendix += `\n**润色技能：** ${p.skillLabel}\n`

    if (p.oldContent !== p.newContent) {
      const diff = formatPolishDiff(p.oldContent, p.newContent, 30)
      const statusText = diff.count > 0
        ? `（发现 ${diff.count} 处可改进点，已自动润色）`
        : '（未发现需要润色的内容）'
      appendix += `${statusText}\n`
      if (diff.count > 0) {
        appendix += `\n**修改内容：**\n${diff.text}\n`
      }
    } else {
      appendix += '\n（润色后无实质改动）\n'
    }
  }

  state.finalContent = state.streamingContent + appendix
  state.allStagesDone = true
  stopTimer()
  emitProgress()
  setTimeout(() => {
    emit('done', state.finalContent)
  }, 800)
}

function handleEndTask() {
  emit('requestClose')
}

// 由父组件在 diff_playback 动画全部结束后调用
// 只有润色阶段自己发出的 diff_playback 才会触发 finish
function onPlaybackComplete() {
  console.log(`[Compose] onPlaybackComplete called, flag=${awaitingPlaybackComplete}`)
  if (awaitingPlaybackComplete) {
    awaitingPlaybackComplete = false
    finish()
  }
}

// ── 阶段标签 ──
const phaseLabels: Record<ComposePhase, string> = {
  idle: '',
  interview: '问答采集中',
  outline_generating: '生成提纲中',
  generating: '正文撰写中',
  reviewing: '质量审查中',
  polishing: '润色定稿中',
  done: '已完成',
}

// ── 生命周期 ──
onMounted(() => {
  init(props.recipe)
})
onBeforeUnmount(() => {
  stopTimer()
})

defineExpose({ onPlaybackComplete })
</script>

<template>
  <!-- ═══════ 问答阶段：Teleport 弹窗 ═══════ -->
  <Teleport to="body">
    <div
      v-if="dialogVisible && state.phase === 'interview'"
      class="fixed inset-0 z-[10000] flex items-center justify-center"
    >
      <!-- 遮罩 -->
      <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      <!-- 弹窗主体：固定高度，避免窗口跳动；内容超出时聊天区独立滚动 -->
      <div
        class="relative w-full max-w-lg h-[65vh] max-h-[85vh] min-h-[420px] rounded-xl shadow-2xl flex flex-col bg-gray-900 border border-gray-700/50 overflow-hidden"
      >
        <!-- 标题栏（紧凑） -->
        <header
          class="flex items-center justify-between px-3 py-2 border-b border-gray-800 shrink-0 bg-gray-900/80 backdrop-blur-sm"
        >
          <div class="flex items-center gap-1.5">
            <span class="text-sm">{{ state.recipe?.icon }}</span>
            <span class="text-xs font-semibold text-gray-200">{{ state.recipe?.name }}</span>
            <span
              class="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-950/50 text-blue-400 border border-blue-800/30"
            >
              {{ showSummary ? '信息确认' : showSupplementaryQuestion ? '补充说明' : phaseLabels[state.phase] }}
            </span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-[10px] text-gray-600 tabular-nums">{{ formatTime(state.elapsedSeconds) }}</span>
            <button
              class="h-6 px-2.5 text-[11px] text-red-400/70 bg-red-950/20 border border-red-900/30 hover:text-red-300 hover:bg-red-900/30 hover:border-red-800/50 rounded transition-colors"
              @click="handleEndTask"
            >
              结束
            </button>
          </div>
        </header>

        <!-- ═══ 聊天问答视图 ═══ -->
        <div ref="chatContainer" class="flex-1 overflow-y-auto px-3 py-2.5 space-y-2.5 [scrollbar-gutter:stable]">
          <!-- AI 开场白 -->
          <Transition appear name="fade-up">
            <div class="flex gap-2.5">
              <div
                class="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shrink-0 mt-0.5 shadow-[0_0_10px_rgba(59,130,246,0.3)]"
              >
                <span class="text-[11px] font-bold text-white">AI</span>
              </div>
              <div class="flex-1">
                <div
                  class="bg-gray-800/70 rounded-2xl rounded-tl-sm px-4 py-2.5 text-xs text-gray-200 leading-relaxed border border-gray-700/30"
                >
                  <p>
                    好的，我来帮你撰写一篇<strong class="text-blue-400">{{ state.recipe?.name }}</strong
                    >。
                  </p>
                  <p class="mt-1.5 text-gray-400">我先了解一下关键信息，不清楚的地方我会自己判断。</p>
                </div>
              </div>
            </div>
          </Transition>

          <!-- 已回答的问题 -->
          <TransitionGroup name="fade-up">
            <div v-for="qi in state.currentQuestionIndex" :key="'qa-' + qi">
              <div class="flex gap-2.5 mb-1.5">
                <div
                  class="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shrink-0 mt-0.5 shadow-[0_0_10px_rgba(59,130,246,0.3)]"
                >
                  <span class="text-[11px] font-bold text-white">AI</span>
                </div>
                <div class="flex-1">
                  <div
                    class="bg-gray-800/70 rounded-2xl rounded-tl-sm px-4 py-2.5 text-xs text-gray-300 border border-gray-700/30"
                  >
                    {{ interviewStage?.questions[qi - 1]?.question }}
                  </div>
                </div>
              </div>
              <div class="flex gap-2.5 ml-auto justify-end max-w-[80%]">
                <div class="flex-1">
                  <div
                    class="bg-blue-950/30 border border-blue-800/30 rounded-2xl rounded-tr-sm px-4 py-2.5 text-xs text-gray-200"
                  >
                    {{ state.interviewAnswers[interviewStage?.questions[qi - 1]?.id || ''] || '...' }}
                  </div>
                </div>
              </div>
            </div>
          </TransitionGroup>

          <!-- 当前问题 -->
          <div v-if="currentQuestion" class="flex gap-2.5">
            <div
              class="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shrink-0 mt-0.5 shadow-[0_0_10px_rgba(59,130,246,0.4)] animate-pulse"
            >
              <span class="text-[11px] font-bold text-white">AI</span>
            </div>
            <div class="flex-1">
              <div
                class="bg-gray-800/70 rounded-2xl rounded-tl-sm px-4 py-2.5 text-xs text-gray-200 border border-blue-800/20"
              >
                <p class="mb-2.5">{{ currentQuestion.question }}</p>
                <!-- 选项按钮 -->
                <div v-if="currentQuestion.options" class="flex flex-wrap gap-1.5">
                  <button
                    v-for="opt in currentQuestion.options"
                    :key="opt"
                    class="px-3 py-1.5 text-[11px] rounded-full border transition-all duration-300 hover:scale-105"
                    :class="
                      state.interviewAnswers[currentQuestion.id] === opt
                        ? 'bg-blue-600/30 border-blue-500 text-blue-300 shadow-[0_0_8px_rgba(59,130,246,0.3)]'
                        : 'bg-gray-800/80 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                    "
                    @click="handleSelectOption(opt)"
                  >
                    {{ opt }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 补充说明问题（最后一道题答完后，同一个聊天窗口接着往下走） -->
          <div v-if="showSupplementaryQuestion" class="flex gap-2.5">
            <div
              class="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shrink-0 mt-0.5 shadow-[0_0_10px_rgba(59,130,246,0.4)] animate-pulse"
            >
              <span class="text-[11px] font-bold text-white">AI</span>
            </div>
            <div class="flex-1">
              <div
                class="bg-gray-800/70 rounded-2xl rounded-tl-sm px-4 py-2.5 text-xs text-gray-200 border border-purple-800/20"
              >
                <p>采访内容已经收集完毕。</p>
                <p class="mt-1.5 text-purple-400 font-medium">📝 你还有什么补充说明吗？</p>
                <p class="mt-1 text-gray-500">（任何额外的背景、要求、想法等，没有可直接跳过）</p>
              </div>
            </div>
          </div>
        </div>

        <!-- 输入区 -->
        <div class="px-3 py-2.5 border-t border-gray-800/50 bg-gray-900/50 shrink-0">
          <!-- 选项式问题：简洁提示 + 标准按钮栏 -->
          <div v-if="currentQuestion?.options && !showSupplementaryQuestion" class="space-y-2">
            <p class="text-[10px] text-gray-600 text-center">请从上方选择一个选项；不选择则跳过</p>
            <div class="flex items-center gap-2">
              <button
                v-if="state.currentQuestionIndex > 0"
                class="h-7 px-3 text-[11px] text-gray-500 hover:text-blue-400 hover:bg-blue-950/30 rounded-lg transition-colors shrink-0"
                @click="goPreviousQuestion"
              >
                ← 上一步
              </button>
              <div class="flex-1" />
              <button
                class="h-7 px-4 text-[11px] text-gray-400 hover:text-gray-300 hover:bg-gray-700/30 border border-gray-700/50 rounded-lg transition-colors shrink-0"
                @click="handleSkip"
              >
                跳过
              </button>
              <span class="text-[11px] text-gray-600 shrink-0 tabular-nums">
                {{ state.currentQuestionIndex + 1 }}/{{ interviewStage?.questions.length || 0 }}
              </span>
            </div>
          </div>

          <!-- 补充说明：同上窗口，带提示词支持 -->
          <div v-else-if="showSupplementaryQuestion" class="space-y-2">
            <textarea
              v-model="userInput"
              rows="3"
              placeholder="输入补充说明（可选）..."
              class="w-full bg-gray-800/80 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-purple-500 focus:bg-gray-800 transition-all resize-none"
              @keydown.enter.exact.prevent="submitSupplementary"
            ></textarea>
            <!-- 提示词 chips（仅 __supplementary__ 专用提示词） -->
            <div class="flex items-center gap-1.5 flex-wrap">
              <button class="h-6 px-1.5 text-[10px] text-gray-500 hover:text-gray-300 hover:bg-gray-700/50 rounded transition-colors flex items-center gap-0.5 shrink-0" @click="startAddPrompt" title="新增常用提示词">
                <span class="text-[11px]">+</span> 添加快捷提示
              </button>
              <div v-for="prompt in supplementaryPrompts" :key="prompt.id" class="h-6 px-2 text-[10px] bg-gray-800/80 border border-gray-700/50 hover:border-purple-600/50 hover:bg-purple-950/20 rounded-full transition-all shrink-0 cursor-pointer group flex items-center gap-0.5" :title="prompt.content" @click="applyPrompt(prompt.content)">
                <span class="text-gray-300 group-hover:text-purple-300 transition-colors">{{ prompt.label }}</span>
                <span class="text-[9px] text-gray-600 hover:text-amber-400 opacity-0 group-hover:opacity-100 transition-opacity" @click.stop="startEditPrompt(prompt)" title="编辑">✎</span>
                <span class="text-[9px] text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity" @click.stop="deletePrompt(prompt.id)" title="删除">×</span>
              </div>
            </div>
            <!-- 提示词编辑器 -->
            <Transition name="expand">
              <div v-if="showPromptEditor" class="p-2 rounded-lg border border-purple-800/30 bg-purple-950/10 space-y-1.5">
                <div class="flex items-center gap-2">
                  <input v-model="editingPrompt.label" placeholder="快捷名称" class="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 placeholder-gray-600 outline-none focus:border-purple-500" maxlength="20" />
                  <button class="h-6 px-2.5 text-[10px] bg-purple-600/80 hover:bg-purple-500/80 text-white rounded transition-all shrink-0" @click="savePrompt">保存</button>
                  <button class="h-6 px-2 text-[10px] text-gray-500 hover:text-gray-300 rounded transition-colors shrink-0" @click="cancelEditPrompt">取消</button>
                </div>
                <textarea v-model="editingPrompt.content" rows="2" placeholder="提示词内容…" class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[11px] text-gray-200 placeholder-gray-600 outline-none focus:border-purple-500 transition-colors resize-none"></textarea>
              </div>
            </Transition>
            <!-- 按钮行 -->
            <div class="flex items-center gap-2">
              <button class="h-7 px-3 text-[11px] text-gray-500 hover:text-blue-400 hover:bg-blue-950/30 rounded-lg transition-colors shrink-0" @click="goBackFromSupplementary">
                ← 上一步
              </button>
              <div class="flex-1" />
              <button class="h-7 px-4 bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-500 hover:to-purple-400 text-white text-xs font-medium rounded-lg transition-all shadow-[0_0_8px_rgba(139,92,246,0.25)] hover:shadow-[0_0_12px_rgba(139,92,246,0.4)] active:scale-95" @click="submitSupplementary">
                确认 →
              </button>
              <button class="h-7 px-3 text-[11px] text-gray-500 hover:text-gray-400 hover:bg-gray-700/30 rounded-lg transition-colors shrink-0" @click="skipSupplementary">
                跳过
              </button>
            </div>
          </div>

          <!-- 普通文本输入 -->
          <div v-else class="space-y-2">
            <!-- 文本输入 -->
            <div class="relative">
              <textarea
                v-model="userInput"
                rows="2"
                :placeholder="currentQuestion?.hint || '输入回答...'"
                class="w-full bg-gray-800/80 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-blue-500 focus:bg-gray-800 transition-all resize-none"
                :disabled="loading"
                @keydown.enter.exact.prevent="handleSubmit"
              ></textarea>
            </div>

            <!-- 常用提示词 chips -->
            <div class="flex items-center gap-1.5 flex-wrap">
              <button
                class="h-6 px-1.5 text-[10px] text-gray-500 hover:text-gray-300 hover:bg-gray-700/50 rounded transition-colors flex items-center gap-0.5 shrink-0"
                @click="startAddPrompt"
                title="新增常用提示词"
              >
                <span class="text-[11px]">+</span> 添加快捷提示
              </button>
              <div
                v-for="prompt in interviewPrompts"
                :key="prompt.id"
                class="h-6 px-2 text-[10px] bg-gray-800/80 border border-gray-700/50 hover:border-blue-600/50 hover:bg-blue-950/20 rounded-full transition-all shrink-0 cursor-pointer group flex items-center gap-0.5"
                :title="prompt.content"
                @click="applyPrompt(prompt.content)"
              >
                <span class="text-gray-300 group-hover:text-blue-300 transition-colors">{{ prompt.label }}</span>
                <span
                  class="text-[9px] text-gray-600 hover:text-amber-400 opacity-0 group-hover:opacity-100 transition-opacity"
                  @click.stop="startEditPrompt(prompt)"
                  title="编辑"
                >✎</span>
                <span
                  class="text-[9px] text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                  @click.stop="deletePrompt(prompt.id)"
                  title="删除"
                >×</span>
              </div>
            </div>

            <!-- 提示词编辑器（展开式） -->
            <Transition name="expand">
              <div v-if="showPromptEditor" class="p-2 rounded-lg border border-blue-800/30 bg-blue-950/10 space-y-1.5">
                <div class="flex items-center gap-2">
                  <input
                    v-model="editingPrompt.label"
                    placeholder="快捷名称（如：标准回复）"
                    class="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 placeholder-gray-600 outline-none focus:border-blue-500"
                    maxlength="20"
                  />
                  <button
                    class="h-6 px-2.5 text-[10px] bg-blue-600/80 hover:bg-blue-500/80 text-white rounded transition-all shrink-0"
                    @click="savePrompt"
                  >
                    保存
                  </button>
                  <button
                    class="h-6 px-2 text-[10px] text-gray-500 hover:text-gray-300 rounded transition-colors shrink-0"
                    @click="cancelEditPrompt"
                  >
                    取消
                  </button>
                </div>
                <textarea
                  v-model="editingPrompt.content"
                  rows="2"
                  placeholder="提示词内容…"
                  class="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[11px] text-gray-200 placeholder-gray-600 outline-none focus:border-blue-500 transition-colors resize-none"
                ></textarea>
              </div>
            </Transition>

            <!-- 按钮行 -->
            <div class="flex items-center gap-2">
              <button
                v-if="state.currentQuestionIndex > 0"
                class="h-7 px-3 text-[11px] text-gray-500 hover:text-blue-400 hover:bg-blue-950/30 rounded-lg transition-colors shrink-0"
                @click="goPreviousQuestion"
              >
                ← 上一步
              </button>
              <div class="flex-1" />
              <button
                class="h-7 px-5 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white text-xs font-medium rounded-lg transition-all shadow-[0_0_12px_rgba(59,130,246,0.3)] hover:shadow-[0_0_18px_rgba(59,130,246,0.5)] active:scale-95"
                :disabled="loading"
                @click="handleSubmit"
              >
                提交
              </button>
              <button
                class="h-7 px-3 text-[11px] text-gray-500 hover:text-gray-400 hover:bg-gray-800/50 rounded-lg transition-colors shrink-0"
                :disabled="loading"
                @click="handleSkip"
                title="跳过此题，由AI自行判断"
              >
                跳过
              </button>
              <span class="text-[11px] text-gray-600 shrink-0 tabular-nums">
                {{ state.currentQuestionIndex + 1 }}/{{ interviewStage?.questions.length || 0 }}
              </span>
            </div>
          </div>
          <p class="text-[10px] text-gray-600 mt-1.5 text-center">Enter 发送 · Shift+Enter 换行 · 跳过则由 AI 自行判断</p>
        </div>

        <!-- 错误提示 -->
        <div v-if="error" class="px-5 pb-3 shrink-0">
          <div
            class="text-xs text-red-400 bg-red-950/30 border border-red-900/30 rounded-lg px-3 py-2"
          >
            {{ error }}
            <button class="ml-2 underline hover:text-red-300" @click="error = ''">关闭</button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- ═══════ 信息确认窗口（独立弹窗） ═══════ -->
  <Teleport to="body">
    <div
      v-if="showSummary"
      class="fixed inset-0 z-[10000] flex items-center justify-center"
    >
      <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        class="relative w-full max-w-lg max-h-[85vh] rounded-xl shadow-2xl flex flex-col bg-gray-900 border border-gray-700/50 overflow-hidden"
      >
        <!-- 标题栏 -->
        <header class="flex items-center justify-between px-3 py-2.5 border-b border-gray-800 shrink-0 bg-gray-900/80 backdrop-blur-sm">
          <div class="flex items-center gap-1.5">
            <span class="text-sm">{{ state.recipe?.icon }}</span>
            <span class="text-xs font-semibold text-gray-200">{{ state.recipe?.name }}</span>
            <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-950/50 text-purple-400 border border-purple-800/30">信息确认</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-[10px] text-gray-600 tabular-nums">{{ formatTime(state.elapsedSeconds) }}</span>
            <button class="h-6 px-2.5 text-[11px] text-red-400/70 bg-red-950/20 border border-red-900/30 hover:text-red-300 hover:bg-red-900/30 hover:border-red-800/50 rounded transition-colors" @click="handleEndTask">结束</button>
          </div>
        </header>

        <!-- 可滚动内容 -->
        <div class="flex-1 overflow-y-auto px-3 py-2.5 space-y-2">
          <p class="text-[11px] text-gray-400">请确认以下信息：</p>

          <!-- 问答对 -->
          <div v-for="(ea, i) in editableAnswers" :key="ea.id" class="p-2 rounded-lg bg-gray-800/50 border border-gray-700/30 space-y-1">
            <label class="text-[11px] text-blue-400 font-medium block">{{ i + 1 }}. {{ qaSummary[i]?.question || ea.id }}</label>
            <textarea v-model="ea.answer" rows="2" class="w-full bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-blue-500 transition-colors resize-none" placeholder="输入答案..."></textarea>
          </div>

          <!-- 补充说明摘要 -->
          <div class="p-2 rounded-lg bg-gray-800/30 border border-dashed border-purple-800/30 space-y-1">
            <label class="text-[11px] text-purple-400 font-medium block">📝 补充说明</label>
            <p class="text-[11px] text-gray-400 italic">{{ supplementaryText || '（无补充）' }}</p>
          </div>
        </div>

        <!-- 知识库与素材库选择（固定，不随滚动） -->
        <div v-if="availableKbs.length > 0 || materialStore.tagWithCounts.length > 0" class="shrink-0 px-3 py-2 border-t border-gray-800/50 bg-gray-900/50">
          <label class="text-[11px] text-amber-400 font-medium block mb-1.5">📚 引用知识库与素材库（勾选后注入 AI 上下文）</label>
          <!-- 知识库 -->
          <div v-if="availableKbs.length > 0" class="flex flex-wrap gap-1.5 mb-2">
            <button v-for="kb in availableKbs" :key="kb.id"
              class="text-[10px] px-2.5 py-1 rounded-full border transition-all flex items-center gap-1"
              :class="selectedKbIds.includes(kb.id)
                ? 'bg-amber-900/40 border-amber-500/60 text-amber-300 shadow-[0_0_4px_rgba(245,158,11,0.15)]'
                : 'bg-gray-900/50 border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300'"
              @click="toggleKb(kb.id)"
            >
              {{ kb.name }}
            </button>
          </div>
          <!-- 分隔符 -->
          <div v-if="availableKbs.length > 0 && materialStore.tagWithCounts.length > 0" class="border-t border-gray-700/50 mb-2"></div>
          <!-- 素材库标签 -->
          <div v-if="materialStore.tagWithCounts.length > 0" class="flex flex-wrap gap-1.5">
            <button v-for="tag in materialStore.tagWithCounts" :key="tag.id"
              class="text-[10px] px-2.5 py-1 rounded-full border transition-all flex items-center gap-1"
              :class="materialStore.selectedMaterialTagIds.includes(tag.id)
                ? 'bg-emerald-900/40 border-emerald-500/60 text-emerald-300 shadow-[0_0_4px_rgba(16,185,129,0.15)]'
                : 'bg-gray-900/50 border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300'"
              @click="materialStore.toggleMaterialTag(tag.id)"
            >
              {{ tag.name }}
              <span class="text-[9px] opacity-60">({{ tag.material_count }})</span>
            </button>
          </div>
        </div>

        <!-- 固定底部操作栏 -->
        <div class="shrink-0 px-3 py-2.5 border-t border-gray-800/50 bg-gray-900/80 backdrop-blur-sm">
          <div class="flex items-center gap-3">
            <!-- 左：返回修改（弱按钮） -->
            <button class="h-8 px-3 text-[11px] text-gray-500 hover:text-blue-400 hover:bg-blue-950/20 border border-gray-700/50 hover:border-blue-600/40 rounded-lg transition-all shrink-0" @click="goBackToQuestions">
              ← 返回修改
            </button>
            <!-- 中间弹性空间 -->
            <div class="flex-1" />
            <!-- 右：直接生成正文（次要操作） -->
            <button
              class="h-8 px-3 text-[11px] text-gray-400 hover:text-gray-200 hover:bg-gray-700/30 border border-gray-700/50 hover:border-gray-500 rounded-lg transition-all shrink-0"
              :disabled="loading"
              @click="confirmDirectGenerate"
            >
              无需提纲，直接生成正文
            </button>
            <!-- 右：生成提纲（主操作） -->
            <button
              class="h-9 px-5 bg-gradient-to-r from-violet-600 to-purple-500 hover:from-violet-500 hover:to-purple-400 text-white text-xs font-semibold rounded-lg transition-all shadow-[0_0_12px_rgba(139,92,246,0.35)] hover:shadow-[0_0_20px_rgba(139,92,246,0.5)] active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="loading"
              @click="confirmStartOutline"
            >
              {{ loading ? '准备中...' : '📋 生成提纲' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- ═══════ 生成提纲阶段：Teleport 弹窗 ═══════ -->
  <Teleport to="body">
    <Transition name="fade-modal">
      <div
        v-if="showOutlineModal"
        class="fixed inset-0 z-[10001] flex items-center justify-center"
      >
        <!-- 遮罩 -->
        <div class="absolute inset-0 bg-black/70 backdrop-blur-md" />

        <!-- 弹窗主体（紧凑） -->
        <div
          class="relative w-full max-w-2xl max-h-[84vh] rounded-xl shadow-2xl flex flex-col bg-gray-900 border border-purple-800/30 overflow-hidden"
        >
          <!-- 标题栏（紧凑） -->
          <header
            class="flex items-center justify-between px-4 py-2.5 border-b border-gray-800 shrink-0 bg-gray-900/80 backdrop-blur-sm"
          >
            <div class="flex items-center gap-1.5">
              <span class="text-lg">📋</span>
              <span class="text-xs font-semibold text-gray-200">生成提纲</span>
              <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-950/50 text-purple-400 border border-purple-800/40 breathing-text">思考中</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-[10px] text-gray-600 tabular-nums">{{ formatTime(state.elapsedSeconds) }}</span>
              <button class="h-6 px-2.5 text-[11px] text-red-400/70 bg-red-950/20 border border-red-900/30 hover:text-red-300 hover:bg-red-900/30 hover:border-red-800/50 rounded transition-colors" @click="handleEndTask">结束</button>
            </div>
          </header>

          <div class="flex-1 overflow-y-auto px-4 py-3 space-y-3">

            <!-- ═══ 可折叠：风格配置 ═══ -->
            <div>
              <button
                class="flex items-center gap-1.5 text-[11px] text-gray-500 hover:text-purple-400 transition-colors w-full text-left mb-2"
                @click="toggleOutlineConfig"
              >
                <span class="transition-transform text-[10px]" :class="outlineConfigExpanded ? 'rotate-90' : ''">▶</span>
                文章结构与标题风格
              </button>

              <Transition name="expand">
                <div v-if="outlineConfigExpanded" class="space-y-2.5 p-3 rounded-lg border border-gray-800/50 bg-gray-900/30">
                  <!-- 文章结构输入 -->
                  <div>
                    <label class="text-[11px] font-semibold text-purple-400 block mb-1.5">
                      📐 {{ (state.recipe?.stages.find(s => s.type === 'outline') as any)?.structurePrompt || '你想把文章分成哪几个部分？' }}
                    </label>
                    <textarea
                      v-model="outlineStructure"
                      rows="2"
                      class="w-full bg-gray-900 border border-gray-700 rounded-md px-3 py-2 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-purple-500 transition-colors resize-none"
                      :placeholder="(state.recipe?.stages.find(s => s.type === 'outline') as any)?.structureHint || '例如：第一部分回顾成绩、第二部分分析形势…'"
                    ></textarea>
                  </div>

                  <!-- 二级标题风格 --><div class="mb-3">
                    <div class="flex items-center gap-2 mb-1.5">
                      <label class="text-xs font-semibold text-purple-400">二级标题</label>
                      <button class="text-[11px] text-orange-400 hover:text-orange-300 px-1.5 py-0.5 rounded hover:bg-orange-950/20 transition-colors" @click="randomizeStyle(true)" title="随机选一种">🎲</button>
                      <button
                        v-for="opt in specialStyleOptions" :key="'l2s_' + opt.value"
                        class="text-[11px] px-2 py-0.5 rounded border transition-all duration-200"
                        :class="outlineL2Style === opt.value
                          ? opt.value === '随机类型' ? 'border-orange-500/50 bg-orange-950/30 text-orange-300 shadow-[0_0_6px_rgba(249,115,22,0.15)]' : 'border-gray-400/50 bg-gray-700/30 text-gray-300 shadow-[0_0_6px_rgba(156,163,175,0.15)]'
                          : 'border-gray-700/50 bg-gray-800/30 text-gray-500 hover:border-gray-500 hover:text-gray-300'"
                        @click="outlineL2Style = opt.value"
                      >{{ opt.icon }} {{ opt.label }}</button>
                    </div>
                    <div class="flex flex-wrap gap-x-3 gap-y-1">
                      <div v-for="group in headingStyleGroups" :key="'l2g_' + group.group" class="flex items-center gap-1">
                        <span class="text-[9px] text-gray-600 whitespace-nowrap">{{ group.group.slice(0,2) }}</span>
                        <button
                          v-for="hs in group.styles"
                          :key="'l2_' + hs.value"
                          class="px-1.5 py-0.5 rounded border text-[11px] leading-tight transition-all duration-200"
                          :class="outlineL2Style === hs.value
                            ? 'border-purple-500/60 bg-purple-950/30 text-purple-300 shadow-[0_0_8px_rgba(139,92,246,0.15)]'
                            : 'border-gray-700/50 bg-gray-800/30 text-gray-500 hover:border-gray-500 hover:text-gray-300'"
                          @click="outlineL2Style = hs.value"
                        >{{ hs.label }}</button>
                      </div>
                    </div>
                  </div>

                  <!-- 三级标题风格 --><div>
                    <div class="flex items-center gap-2 mb-1.5">
                      <label class="text-xs font-semibold text-emerald-400">三级标题</label>
                      <button class="text-[11px] text-orange-400 hover:text-orange-300 px-1.5 py-0.5 rounded hover:bg-orange-950/20 transition-colors" @click="randomizeStyle(false)" title="随机选一种">🎲</button>
                      <button
                        v-for="opt in specialStyleOptions" :key="'l3s_' + opt.value"
                        class="text-[11px] px-2 py-0.5 rounded border transition-all duration-200"
                        :class="outlineL3Style === opt.value
                          ? opt.value === '随机类型' ? 'border-orange-500/50 bg-orange-950/30 text-orange-300 shadow-[0_0_6px_rgba(249,115,22,0.15)]' : 'border-gray-400/50 bg-gray-700/30 text-gray-300 shadow-[0_0_6px_rgba(156,163,175,0.15)]'
                          : 'border-gray-700/50 bg-gray-800/30 text-gray-500 hover:border-gray-500 hover:text-gray-300'"
                        @click="outlineL3Style = opt.value"
                      >{{ opt.icon }} {{ opt.label }}</button>
                    </div>
                    <div class="flex flex-wrap gap-x-3 gap-y-1">
                      <div v-for="group in headingStyleGroups" :key="'l3g_' + group.group" class="flex items-center gap-1">
                        <span class="text-[9px] text-gray-600 whitespace-nowrap">{{ group.group.slice(0,2) }}</span>
                        <button
                          v-for="hs in group.styles"
                          :key="'l3_' + hs.value"
                          class="px-1.5 py-0.5 rounded border text-[11px] leading-tight transition-all duration-200"
                          :class="outlineL3Style === hs.value
                            ? 'border-emerald-500/60 bg-emerald-950/30 text-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.15)]'
                            : 'border-gray-700/50 bg-gray-800/30 text-gray-500 hover:border-gray-500 hover:text-gray-300'"
                          @click="outlineL3Style = hs.value"
                        >{{ hs.label }}</button>
                      </div>
                    </div>
                  </div>


                  <!-- 生成按钮 -->
                  <div class="flex justify-center pt-1">
                    <button
                      class="h-9 px-6 bg-gradient-to-r from-purple-600 via-pink-500 to-orange-500 hover:from-purple-500 hover:via-pink-400 hover:to-orange-400 text-white text-xs font-bold rounded-lg transition-all shadow-[0_0_16px_rgba(139,92,246,0.35)] hover:shadow-[0_0_24px_rgba(139,92,246,0.5)] active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                      :disabled="outlineGenerating"
                      @click="generateOutline"
                    >
                      <span v-if="outlineGenerating" class="flex items-center gap-2">
                        <svg class="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                        正在构思...
                      </span>
                      <span v-else>✨ 生成提纲</span>
                    </button>
                  </div>
                </div>
              </Transition>
            </div>

            <!-- ═══ 思考过程 ═══ -->
            <Transition name="expand">
              <div v-if="outlineThinking" class="rounded-lg border overflow-hidden" :class="outlineThinkingDone ? 'border-purple-800/30 bg-purple-950/10' : 'border-blue-800/30 bg-blue-950/10'">
                <button v-if="outlineThinkingDone" class="w-full flex items-center justify-between px-3 py-2 hover:bg-purple-950/20 transition-colors" @click="outlineThinkingExpanded = !outlineThinkingExpanded">
                  <div class="flex items-center gap-1.5">
                    <span class="text-xs">🧠</span>
                    <span class="text-[11px] font-semibold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">AI 思考过程</span>
                    <span class="text-[10px] text-purple-500/70 bg-purple-950/40 px-1 py-0.5 rounded-full border border-purple-800/30">{{ outlineThinkingExpanded ? '收起' : '查看' }}</span>
                  </div>
                  <span class="text-[10px] text-purple-400 transition-transform" :class="outlineThinkingExpanded ? 'rotate-180' : ''">▼</span>
                </button>
                <div v-else class="flex items-center gap-1.5 px-3 py-2">
                  <span class="text-xs animate-pulse">🧠</span>
                  <span class="text-[11px] font-semibold bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent animate-pulse">AI 正在思考...</span>
                </div>
                <div v-if="outlineThinkingExpanded || !outlineThinkingDone" ref="outlineThinkingEl" class="px-3 pb-3 max-h-40 overflow-y-auto">
                  <pre class="text-[11px] whitespace-pre-wrap font-mono leading-relaxed" :class="outlineThinkingDone ? 'text-purple-300/80' : 'text-blue-300/80'">{{ outlineThinking }}</pre>
                </div>
              </div>
            </Transition>

            <!-- ═══ 提纲条目生成中（思考已完成，等待条目出现） ═══ -->
            <div
              v-if="outlineThinkingReady && !outlineThinkingDone && outlineItems.length === 0 && outlineGenerating"
              class="flex items-center justify-center gap-2 py-3"
            >
              <svg class="animate-spin w-4 h-4 text-purple-400" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
              <span class="text-[11px] text-purple-400/70 animate-pulse">正在生成提纲条目…</span>
            </div>

            <!-- ═══ 提纲条目（可内联编辑） ═══ -->
            <div v-if="outlineItems.length > 0" class="space-y-1.5">
              <template v-for="item in outlineItems" :key="item.id">
                <div
                  class="rounded-lg border overflow-hidden transition-all duration-300"
                  :class="item.level === 2 ? 'border-purple-800/30 bg-purple-950/10' : 'border-emerald-800/20 bg-emerald-950/5 ml-5'"
                >
                  <div class="flex items-start gap-2 px-3 py-2">
                    <span class="shrink-0 w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold mt-px select-none"
                      :class="item.level === 2 ? 'bg-purple-900/50 text-purple-400 border border-purple-700/30' : 'bg-emerald-900/50 text-emerald-400 border border-emerald-700/30'"
                    >{{ item.level === 2 ? 'H2' : 'H3' }}</span>

                    <!-- 内联编辑 / 显示切换 -->
                    <div class="flex-1 min-w-0" @dblclick="startEditingItem(item.id)">
                      <input
                        v-if="editingItemId === item.id"
                        v-model="editingItemText"
                        class="w-full bg-gray-800 border border-purple-600 rounded px-2 py-0.5 text-xs text-gray-100 outline-none"
                        :class="item.level === 2 ? 'font-semibold text-purple-200' : 'text-emerald-200'"
                        @keydown.enter="confirmEditItem"
                        @keydown.escape="cancelEditItem"
                        @blur="confirmEditItem"
                      />
                      <p v-else class="text-xs leading-snug cursor-text hover:bg-white/5 rounded px-1 -mx-1 py-0.5 transition-colors"
                        :class="item.level === 2 ? 'text-purple-200 font-semibold' : 'text-emerald-200'"
                        :title="'双击编辑标题'"
                      >{{ item.text }}</p>
                    </div>

                    <!-- 操作按钮 -->
                    <div class="flex items-center gap-0.5 shrink-0" :class="editingItemId === item.id ? 'invisible' : ''">
                      <button class="h-6 w-6 flex items-center justify-center rounded text-[11px] text-gray-500 hover:text-purple-400 hover:bg-purple-950/30 transition-all active:scale-95" title="AI重新生成此标题" @click="regenerateOutlineItem(item.id)">🔄</button>
                      <button v-if="item.level === 2" class="h-6 w-6 flex items-center justify-center rounded text-[11px] text-gray-500 hover:text-emerald-400 hover:bg-emerald-950/30 transition-all active:scale-95" title="添加子标题" @click="addOutlineItem(3, item.id)">➕</button>
                      <button class="h-6 w-6 flex items-center justify-center rounded text-[11px] text-gray-500 hover:text-red-400 hover:bg-red-950/30 transition-all active:scale-95" title="删除此标题" @click="deleteOutlineItem(item.id)">🗑️</button>
                    </div>
                  </div>
                  <!-- 标题补充要求 -->
                  <div class="px-3 pb-2 flex items-start gap-1.5">
                    <textarea
                      v-model="item.userRequirement"
                      rows="1"
                      class="flex-1 bg-gray-800/80 border border-gray-700 rounded-md px-2.5 py-1 text-[10px] text-gray-300 placeholder-gray-600 outline-none focus:border-purple-500 transition-colors resize-none"
                      :placeholder="'可对此标题提出细化要求，如：用数据案例支撑…'"
                      @keydown.enter.exact.prevent="refineOutlineItem(item.id)"
                    ></textarea>
                    <button v-if="item.userRequirement?.trim()" class="h-6 px-2.5 text-[10px] bg-purple-600/80 hover:bg-purple-500/80 text-white rounded transition-all active:scale-95 shrink-0" @click="refineOutlineItem(item.id)">优化</button>
                  </div>
                </div>
              </template>
              <!-- 添加大标题 -->
              <button class="w-full h-8 flex items-center justify-center gap-1 text-[11px] text-gray-500 hover:text-purple-400 border border-dashed border-gray-700/50 hover:border-purple-700/50 rounded-lg transition-all" @click="addOutlineItem(2)">
                <span>＋</span> 添加大标题
              </button>
            </div>
          </div>

          <!-- ═══ 底部：反馈 + 重新生成 / 确认 ═══ -->
          <div v-if="outlineItems.length > 0" class="px-4 py-2.5 space-y-2 border-t border-gray-800/50 bg-gray-900/50 shrink-0">
            <div class="flex items-start gap-2">
              <textarea
                v-model="outlineFeedback" rows="1"
                class="flex-1 bg-gray-800/80 border border-gray-700 rounded-md px-3 py-1.5 text-xs text-gray-300 placeholder-gray-600 outline-none focus:border-orange-500/70 transition-colors resize-none"
                placeholder="📝 对整体提纲不满意？写出改进要求（Enter 提交）"
                @keydown.enter.exact.prevent="generateOutline"
              ></textarea>
              <button class="h-7 px-3 text-[11px] bg-gradient-to-r from-orange-600 to-orange-500 hover:from-orange-500 hover:to-orange-400 text-white rounded-md transition-all active:scale-95 shrink-0 font-medium" :disabled="outlineGenerating" @click="generateOutline">🔄 重新生成</button>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-[10px] text-gray-500">共 {{ outlineItems.filter(o => o.level === 2).length }} 个大标题，{{ outlineItems.filter(o => o.level === 3).length }} 个子标题</span>
              <button class="h-8 px-5 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white text-xs font-bold rounded-lg transition-all shadow-[0_0_12px_rgba(16,185,129,0.35)] hover:shadow-[0_0_20px_rgba(16,185,129,0.5)] active:scale-95" @click="confirmOutline">✓ 确认提纲，开始创作</button>
            </div>
          </div>

          <!-- 错误提示 -->
          <div v-if="error" class="px-4 pb-2 shrink-0">
            <div class="text-[11px] text-red-400 bg-red-950/30 border border-red-900/30 rounded-lg px-3 py-1.5">{{ error }} <button class="ml-2 underline hover:text-red-300" @click="error = ''">关闭</button></div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-up-enter-active {
  transition: all 0.4s ease-out;
}
.fade-up-leave-active {
  transition: all 0.3s ease-in;
}
.fade-up-enter-from {
  opacity: 0;
  transform: translateY(12px);
}
.fade-up-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* 提纲模态框淡入 */
.fade-modal-enter-active {
  transition: all 0.35s ease-out;
}
.fade-modal-leave-active {
  transition: all 0.25s ease-in;
}
.fade-modal-enter-from {
  opacity: 0;
  transform: scale(0.95);
}
.fade-modal-leave-to {
  opacity: 0;
  transform: scale(0.95);
}

/* 思考过程展开 */
.expand-enter-active {
  transition: all 0.4s ease-out;
}
.expand-leave-active {
  transition: all 0.3s ease-in;
}
.expand-enter-from,
.expand-leave-to {
  opacity: 0;
  max-height: 0;
}

/* 思考文字打字机光标 */
.thinking-text {
  position: relative;
}

/* 呼吸动画 */
@keyframes breathe {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}
.breathing-text {
  animation: breathe 2s ease-in-out infinite;
}
</style>
