/** 写作流水线：类型定义 */

/** 标题风格（六型十四式 + 特殊选项） */
export type HeadingStyle =
  | '并列排比式' | '对仗工整式' | '统一后缀式'
  | '破立转换式' | '辩证统一式' | '层层递进式'
  | '生动比喻式' | '引用典故式' | '拟人动感式'
  | '化用热词式' | '概念组合式'
  | '点明宗旨式' | '鼓舞动员式'
  | '数字概括式'
  | '随机类型' | '不指定类型'

/** 提纲条目 */
export interface OutlineItem {
  id: string
  level: 2 | 3 // 二级标题 or 三级标题
  text: string
  parentId?: string // 三级标题归属的二级标题 id
  userRequirement?: string // 用户补充要求
}

/** 提纲数据 */
export interface OutlineData {
  /** 二级标题风格 */
  headingStyleL2: HeadingStyle
  /** 三级标题风格 */
  headingStyleL3: HeadingStyle
  /** 提纲条目列表 */
  items: OutlineItem[]
  /** AI 思考过程文本 */
  thinking: string
  /** 提纲可用风格列表 */
  availableStyles?: HeadingStyle[]
  /** 用户输入的文章结构/分段意图（阶段1.5输入） */
  outlineStructure?: string
}

/** 一个写作菜谱（流水线模板） */
export interface ComposeRecipe {
  id: string
  name: string
  description: string
  genre: string // 文体分类
  icon: string
  isBuiltin: boolean
  /** 默认关联的知识库 ID */
  knowledgeBaseIds: string[]
  /** 阶段定义 */
  stages: ComposeStage[]
}

/** 流水线阶段 */
export type ComposeStage = InterviewStage | OutlineStage | GenerateStage | ReviewStage | PolishStage

/** 阶段基础字段 */
interface StageBase {
  stageId: string
  stageLabel: string // 展示名称
  stageIcon: string // 图标/emoji
}

/** 阶段 1：互动问答 */
export interface InterviewStage extends StageBase {
  type: 'interview'
  /** 预制的问题列表 */
  questions: InterviewQuestion[]
  /** 系统提示词（给 AI 的整体角色设定） */
  systemPrompt: string
}

export interface InterviewQuestion {
  id: string
  question: string
  hint: string // 输入框占位提示
  required: boolean // true=必须回答, false=可跳过让AI自行判断
  maxLength?: number
  /** 选项模式：若有 options 则展示为快捷选择按钮 */
  options?: string[]
  /** 多选 */
  multiSelect?: boolean
}

/** 阶段 1.5：提纲生成（交互后、正文前的重头戏） */
export interface OutlineStage extends StageBase {
  type: 'outline'
  /** 文章结构引导问题 */
  structurePrompt: string
  /** 结构输入框提示 */
  structureHint: string
}

/** 阶段 2：正文生成 */
export interface GenerateStage extends StageBase {
  type: 'generate'
  /** 技能 ID（后端 skill） */
  skillId: string
  /** 生成温度 */
  temperature: number
}

/** 阶段 3：审查（逻辑/病句/规范） */
export interface ReviewStage extends StageBase {
  type: 'review'
  /** 依次执行的审查技能 ID 列表 */
  skillIds: string[]
  /** 是否自动修复发现的问题 */
  autoFix: boolean
}

/** 阶段 4：润色定稿 */
export interface PolishStage extends StageBase {
  type: 'polish'
  skillId: string
  temperature: number
}

// ─── 运行时状态 ────────────────────────────────

export type ComposePhase = 'idle' | 'interview' | 'outline_generating' | 'generating' | 'reviewing' | 'polishing' | 'done'

export interface ComposeState {
  active: boolean
  recipe: ComposeRecipe | null
  phase: ComposePhase
  currentStageIndex: number
  /** 问答结果：questionId → answer */
  interviewAnswers: Record<string, string>
  /** 当前问题索引（-1 = 未开始） */
  currentQuestionIndex: number
  /** AI 正在问的问题（动态生成时使用） */
  dynamicQuestion: string
  /** 每个阶段的日志行 */
  stageLogs: StageLogEntry[]
  /** 实时流式输出的文本 */
  streamingContent: string
  /** 最终生成的文稿 */
  finalContent: string
  /** 审查发现 */
  reviewFindings: ReviewFinding[]
  /** 是否所有阶段完成 */
  allStagesDone: boolean
  /** 总耗时（秒） */
  elapsedSeconds: number
  /** 提纲数据 */
  outline: OutlineData | null
}

export interface StageLogEntry {
  stageId: string
  stageLabel: string
  status: 'pending' | 'running' | 'done'
  detail: string
  /** 耗时（秒） */
  durationMs: number
}

export interface ReviewFinding {
  category: string // 'logic' | 'grammar' | 'style'
  severity: 'high' | 'medium' | 'low'
  description: string
  fixed: boolean
  fixDescription?: string
}

/** 向 AI 发起问答时使用的消息 */
export interface InterviewMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 流水线进度信息（emit 给父组件，用于进度条展示） */
export interface ComposeProgress {
  active: boolean
  recipeName: string
  phase: ComposePhase
  currentStep: number
  totalSteps: number
  stageLabel: string
  /** 审查中：当前正在执行的技能名称 */
  reviewSkillLabel?: string
  /** 审查中：发现的问题数 */
  reviewFindingsCount?: number
  /** 审查中：已修复的问题数 */
  reviewFixedCount?: number
}
