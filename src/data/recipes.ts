/**
 * 内置写作菜谱定义
 * 自定义菜谱存储在 SQLite 数据库中（通过 Rust invoke），导入导出完整。
 */
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { ComposeRecipe } from '../types/compose'

/** 全文种共享的写作规范，附加到各菜谱 Interview 阶段 systemPrompt 末尾 */
const SHARED_WRITING_RULES = `
写作规范：
1. 语言务实朴实，忌生造新词和时髦套话，双引号（""）使用要有克制，仅用于确有必要引用的专有名词或原文，避免通篇引号泛滥；
2. 标题干净凝练，不使用破折号（——）和冒号（：）等标点，保持标题的识别力和整体感。`

export const builtinRecipes: ComposeRecipe[] = [
  // ═══════════════════════════════════════════════════════════════
  // 一、述职报告
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'recipe_report',
    name: '述职报告',
    description: '个人年度/任期/班子/党建/安全等各类述职报告，突出履职成效与问题剖析',
    genre: '述职报告',
    icon: '🏛️',
    isBuiltin: true,
    knowledgeBaseIds: ['kb_003', 'kb_006', 'kb_007'],
    stages: [
      {
        type: 'interview',
        stageId: 'interview',
        stageLabel: '信息采集',
        stageIcon: '📝',
        systemPrompt: `你是一位央企人事组织部门的笔杆子，正在协助撰写一份述职报告。
你的任务是逐项采集关键信息，覆盖述职类型、履职业绩、问题不足和改进方向。
语气严肃庄重、专业干练，注意央企用语规范和政治站位。
当用户跳过或表示不清楚时，你要基于已有信息和知识库自行判断补充。${SHARED_WRITING_RULES}`,
        questions: [
          { id: 'q_type', question: '这是什么类型的述职？（个人年度/任期/试用期/班子/党建/专项工作/安全环保）', hint: '', required: true },
          { id: 'q_role', question: '述职人姓名、职务、职级及分管的具体业务板块？（勘探开发/炼化销售/管道/新能源/工程技术/机关职能）', hint: '', required: true },
          { id: 'q_period', question: '述职时间范围？（如：2025年度、2025年3月至9月）', hint: '例如：2025年度', required: true },
          { id: 'q_occasion', question: '述职场合和听众？（年度考核会/职代会/上级检查/党组织会议/安全述职）', hint: '', required: false },
          { id: 'q_kpi', question: '本周期核心生产经营指标完成情况？（产量、销量、效益、成本、投资等，请尽量量化）', hint: '', required: false },
          { id: 'q_efficiency', question: '在提质增效、亏损治理、降本控费方面有哪些具体举措和成效？', hint: '', required: false },
          { id: 'q_highlights', question: '最突出的亮点或创新举措？（如技术攻关、管理创新、市场开拓、数字化转型）', hint: '', required: false },
          { id: 'q_hse', question: '安全环保（HSE）责任履行情况？（事故、隐患、环保指标、体系审核）', hint: '', required: false },
          { id: 'q_party', question: '党建与生产经营融合情况？（"三基本"建设、主题教育、党纪学习教育、巡察整改）', hint: '', required: false },
          { id: 'q_integrity', question: '廉洁自律和"一岗双责"履行情况？', hint: '', required: false },
          { id: 'q_shortcomings', question: '存在的主要不足或短板？（建议2-3条，含原因分析）', hint: '', required: false },
          { id: 'q_plan', question: '下一步改进措施和重点计划？', hint: '', required: false },
          { id: 'q_spirit', question: '是否有上级最新精神、集团公司工作会议部署或考核指标需要重点呼应？', hint: '', required: false },
          { id: 'q_leader_hint', question: '领导或上级对本次述职有无特殊指示或必须体现的表述？', hint: '', required: false },
          { id: 'q_format', question: '完成时限和格式要求？（是否有模板、字数限制、密级要求）', hint: '', required: false },
        ],
      },
      {
        type: 'outline', stageId: 'outline', stageLabel: '生成提纲', stageIcon: '📋',
        structurePrompt: '述职报告的结构如何安排？请大致描述一下各部分的侧重点。',
        structureHint: '例如：履职情况→亮点与创新→问题剖析→改进方向',
      },
      { type: 'generate', stageId: 'generate', stageLabel: '正文撰写', stageIcon: '✍️', skillId: '__compose_generate__', temperature: 0.5 },
      { type: 'review', stageId: 'review', stageLabel: '质量审查', stageIcon: '🔍', skillIds: ['skill_logic', 'skill_grammar', 'skill_official'], autoFix: true },
      { type: 'polish', stageId: 'polish', stageLabel: '润色定稿', stageIcon: '✨', skillId: 'skill_spirit', temperature: 0.7 },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // 二、领导讲话
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'recipe_speech',
    name: '领导讲话',
    description: '动员部署、主旨主题、会议总结、调研座谈等各类领导讲话稿',
    genre: '领导讲话',
    icon: '📋',
    isBuiltin: true,
    knowledgeBaseIds: ['kb_001', 'kb_002', 'kb_003', 'kb_004'],
    stages: [
      {
        type: 'interview',
        stageId: 'interview',
        stageLabel: '信息采集',
        stageIcon: '📝',
        systemPrompt: `你是一位资深央企党办笔杆子，正在协助领导准备一篇讲话稿。
你的任务是逐步收集写作素材，覆盖讲话类型、听众、核心内容和个性风格。
语气专业、干练。根据用户的回答敏锐判断还需了解什么，但每次只问一个问题。
当用户跳过时，你要基于已有信息和知识库自行判断补充。${SHARED_WRITING_RULES}`,
        questions: [
          { id: 'q_type', question: '这是什么类型的讲话？（动员部署/主旨主题/会议总结/调研座谈/党课廉政/安全环保/生产调度/其他）', hint: '', required: true },
          { id: 'q_speaker', question: '讲话人姓名、职务？（集团公司领导/专业公司领导/地区公司领导/二级单位领导）', hint: '', required: true },
          { id: 'q_event', question: '会议/活动主题全称？（如：2025年工作会议、主题教育动员会、安全生产月启动会）', hint: '', required: true },
          { id: 'q_audience', question: '听众构成？（机关部门/二级单位/基层站队/外部嘉宾/承包商）', hint: '', required: false },
          { id: 'q_purpose', question: '本次讲话的核心目的？（部署任务/传达精神/统一思想/表彰激励/警示教育/推动落实）', hint: '', required: false },
          { id: 'q_spirit', question: '集团公司或上级单位对此项工作的最新要求、会议精神或领导批示？', hint: '', required: false },
          { id: 'q_situation', question: '当前本单位/本领域的形势判断？（生产经营/安全环保/市场/改革/队伍，各简述要点）', hint: '', required: false },
          { id: 'q_content', question: '需要重点阐述的核心内容？（分3-4个方面列出，如产量效益、安全环保、改革创新、党的建设）', hint: '', required: false },
          { id: 'q_data', question: '是否有必须引用的数据、案例、讲话原文或政策文件？', hint: '', required: false },
          { id: 'q_focus', question: '在提质增效、新能源新业务、数字化转型、绿色低碳等方面需要强调哪些要点？', hint: '', required: false },
          { id: 'q_demand', question: '对听众提出的具体要求、希望或号召？（如"四个抓落实"、"马上就办"）', hint: '', required: false },
          { id: 'q_duration', question: '讲话时长要求？（10分钟/20分钟/30分钟/不限）', hint: '', required: false, options: ['10分钟', '20分钟', '30分钟', '不限'] },
          { id: 'q_case', question: '是否需要引用典型案例？（正面/反面/不需要）', hint: '', required: false, options: ['正面案例', '反面案例', '不需要'] },
          { id: 'q_style', question: '领导个人风格偏好？（务实型/鼓舞型/警示型/娓娓道来）', hint: '', required: false, options: ['务实型', '鼓舞型', '警示型', '娓娓道来'] },
          { id: 'q_format', question: '完成时限和密级要求？', hint: '', required: false },
        ],
      },
      {
        type: 'outline', stageId: 'outline', stageLabel: '生成提纲', stageIcon: '📋',
        structurePrompt: '讲话稿的结构如何安排？请大致描述各部分的侧重点。',
        structureHint: '例如：形势分析→回顾成绩→部署任务→提出要求→号召动员',
      },
      { type: 'generate', stageId: 'generate', stageLabel: '正文撰写', stageIcon: '✍️', skillId: '__compose_generate__', temperature: 0.7 },
      { type: 'review', stageId: 'review', stageLabel: '质量审查', stageIcon: '🔍', skillIds: ['skill_logic', 'skill_grammar', 'skill_official'], autoFix: true },
      { type: 'polish', stageId: 'polish', stageLabel: '润色定稿', stageIcon: '✨', skillId: 'skill_golden', temperature: 0.8 },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // 三、工作总结
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'recipe_summary',
    name: '工作总结',
    description: '年度/半年/季度/专项工作总结，全面回顾生产经营与党建工作',
    genre: '工作总结',
    icon: '📈',
    isBuiltin: true,
    knowledgeBaseIds: ['kb_003', 'kb_004', 'kb_005'],
    stages: [
      {
        type: 'interview',
        stageId: 'interview',
        stageLabel: '信息采集',
        stageIcon: '📝',
        systemPrompt: `你是一位央企办公室的笔杆子，正在协助撰写一份工作总结。
逐项采集经营指标、重点任务、亮点成绩和问题不足等关键信息。
语气专业、务实。用户跳过的项目你将根据常识和知识库自行补充。${SHARED_WRITING_RULES}`,
        questions: [
          { id: 'q_type', question: '这是什么类型的总结？（年度/半年/季度/专项工作/巡视巡察整改/安全环保/主题教育/其他）', hint: '', required: true },
          { id: 'q_subject', question: '总结主体是谁？（集团公司/专业公司/地区公司/二级单位/部门/项目部）', hint: '', required: true },
          { id: 'q_period', question: '总结的时间范围？', hint: '例如：2025年度', required: true },
          { id: 'q_kpi', question: '年初/期初确定的主要生产经营目标及完成情况？（产量、销量、收入、利润、成本、投资，逐项对照）', hint: '', required: false },
          { id: 'q_tasks', question: '本周期完成的重点工作任务？（按业务板块分类：勘探开发、炼油化工、销售、管道、新能源、工程技术、机关职能）', hint: '', required: false },
          { id: 'q_efficiency', question: '在提质增效、亏损治理、降本控费方面取得的具体成效？（量化数据）', hint: '', required: false },
          { id: 'q_highlights', question: '最突出的亮点成绩或获得的荣誉表彰？（省部级、集团公司级、行业级）', hint: '', required: false },
          { id: 'q_hse', question: '安全环保（HSE）工作总体情况？（事故指标、隐患治理、环保达标、体系审核结果）', hint: '', required: false },
          { id: 'q_gaps', question: '未完成或滞后的工作及原因分析？', hint: '', required: false },
          { id: 'q_innovation', question: '工作中的创新举措、经验做法及可复制性？（如管理创新、技术创新、数字化应用）', hint: '', required: false },
          { id: 'q_party', question: '党建与生产经营融合情况？（主题教育、巡察整改、"三基本"建设、党风廉政建设）', hint: '', required: false },
          { id: 'q_challenges', question: '当前面临的内外部形势和挑战？（市场、政策、资源、安全、队伍）', hint: '', required: false },
          { id: 'q_plan', question: '下一步工作的总体思路、重点安排和主要目标？', hint: '', required: false },
          { id: 'q_spirit', question: '是否需要体现集团公司最新工作部署的贯彻落实情况？', hint: '', required: false },
          { id: 'q_format', question: '完成时限、格式模板、密级及报送范围？', hint: '', required: false },
        ],
      },
      {
        type: 'outline', stageId: 'outline', stageLabel: '生成提纲', stageIcon: '📋',
        structurePrompt: '工作总结的结构如何安排？请大致描述各部分的侧重点。',
        structureHint: '例如：总体情况→重点工作→亮点创新→问题不足→形势分析→下步计划',
      },
      { type: 'generate', stageId: 'generate', stageLabel: '正文撰写', stageIcon: '✍️', skillId: '__compose_generate__', temperature: 0.5 },
      { type: 'review', stageId: 'review', stageLabel: '质量审查', stageIcon: '🔍', skillIds: ['skill_logic', 'skill_grammar', 'skill_official'], autoFix: true },
      { type: 'polish', stageId: 'polish', stageLabel: '润色定稿', stageIcon: '✨', skillId: 'skill_concise', temperature: 0.5 },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // 四、研讨材料
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'recipe_discussion',
    name: '研讨材料',
    description: '理论学习中心组、民主生活会、专题研讨等发言材料，理论联系实际',
    genre: '研讨材料',
    icon: '💡',
    isBuiltin: true,
    knowledgeBaseIds: ['kb_006', 'kb_001'],
    stages: [
      {
        type: 'interview',
        stageId: 'interview',
        stageLabel: '信息采集',
        stageIcon: '📝',
        systemPrompt: `你是一位央企党务工作者，正在协助撰写一份研讨发言材料。
逐项采集学习主题、核心体会、问题剖析和改进思路。
语气庄重严谨，注重政治站位和理论联系实际。
当用户跳过时，基于已有信息和知识库自行补充。${SHARED_WRITING_RULES}`,
        questions: [
          { id: 'q_type', question: '这是什么类型的研讨？（理论学习中心组/民主生活会/组织生活会/专题研讨/安全环保研讨/其他）', hint: '', required: true },
          { id: 'q_topic', question: '研讨主题和指定学习材料？（如：党的二十大精神、集团公司工作会议、党纪学习教育、习近平总书记重要指示）', hint: '', required: true },
          { id: 'q_role', question: '您的姓名、职务及分管业务板块？', hint: '', required: true },
          { id: 'q_understanding', question: '对指定材料的核心理解和体会？（3-5点，结合石油行业实际）', hint: '', required: false },
          { id: 'q_relevance', question: '结合分管工作，学习材料对实际工作的指导意义？（如：保障能源安全、绿色低碳转型、科技自立自强）', hint: '', required: false },
          { id: 'q_problems', question: '当前分管领域存在的主要问题及深层原因？（生产经营、安全环保、管理、队伍、党建）', hint: '', required: false },
          { id: 'q_measures', question: '运用学习成果改进工作的具体思路和措施？（可落地、可量化）', hint: '', required: false },
          { id: 'q_criticism', question: '是否需要开展批评与自我批评？如有，请简述本人问题及对他人的意见建议', hint: '', required: false },
          { id: 'q_feedback', question: '会前征求意见中涉及本人的主要问题？（民主生活会/组织生活会用）', hint: '', required: false },
          { id: 'q_benchmark', question: '是否需要对标集团公司党组要求或行业先进找差距？', hint: '', required: false },
          { id: 'q_theme', question: '在"转观念、勇担当、高质量、创一流"方面有哪些思考？', hint: '', required: false },
          { id: 'q_format', question: '完成时限、格式要求及密级？', hint: '', required: false },
        ],
      },
      {
        type: 'outline', stageId: 'outline', stageLabel: '生成提纲', stageIcon: '📋',
        structurePrompt: '研讨材料的结构如何安排？请大致描述各部分的侧重点。',
        structureHint: '例如：学习体会→联系实际→查摆问题→改进措施',
      },
      { type: 'generate', stageId: 'generate', stageLabel: '正文撰写', stageIcon: '✍️', skillId: '__compose_generate__', temperature: 0.6 },
      { type: 'review', stageId: 'review', stageLabel: '质量审查', stageIcon: '🔍', skillIds: ['skill_logic', 'skill_grammar', 'skill_official'], autoFix: true },
      { type: 'polish', stageId: 'polish', stageLabel: '润色定稿', stageIcon: '✨', skillId: 'skill_spirit', temperature: 0.7 },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // 五、通讯简报
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'recipe_news',
    name: '通讯简报',
    description: '工作动态、会议报道、经验交流等各类简报，简洁高效、图文并茂',
    genre: '新闻通讯',
    icon: '📰',
    isBuiltin: true,
    knowledgeBaseIds: ['kb_001', 'kb_008', 'kb_013'],
    stages: [
      {
        type: 'interview',
        stageId: 'interview',
        stageLabel: '信息采集',
        stageIcon: '📝',
        systemPrompt: `你是一位中国石油内部通讯社的编辑记者，正在采写一篇企业简报。
遵循5W1H原则逐项确认信息，同时关注中石油战略定位和行业特色。
语气简洁高效。缺乏的关键信息将由你自行判断补充。${SHARED_WRITING_RULES}`,
        questions: [
          { id: 'q_type', question: '这是什么类型的简报？（工作动态/会议报道/经验交流/信息专报/安全环保通报/其他）', hint: '', required: true },
          { id: 'q_5w1h', question: '事件/活动/会议的时间、地点、参与人员？（领导姓名、职务务必准确）', hint: '', required: true },
          { id: 'q_content', question: '事件/活动的背景和核心内容？（如：重大油气发现、装置投产、技术突破、应急演练、党建活动）', hint: '', required: true },
          { id: 'q_highlights', question: '最突出的亮点、创新点或感人细节？（数据支撑、典型人物、关键节点）', hint: '', required: false },
          { id: 'q_quote', question: '相关领导的讲话要点或重要指示？（原文引用需准确）', hint: '', required: false },
          { id: 'q_result', question: '取得的成效、数据或社会反响？（产量、效益、技术指标、媒体报道）', hint: '', required: false },
          { id: 'q_audience', question: '报送对象和范围？（集团公司/专业公司/内部/公开/上级部委）', hint: '', required: false },
          { id: 'q_secret', question: '密级要求？（公开/内部/秘密）', hint: '', required: false, options: ['公开', '内部', '秘密'] },
          { id: 'q_photo', question: '是否需要配发图片？图片内容说明？', hint: '', required: false },
          { id: 'q_deadline', question: '时效性要求？（即时/当日/次日）', hint: '', required: false, options: ['即时', '当日', '次日'] },
          { id: 'q_strategy', question: '是否需要体现"保障国家能源安全""绿色低碳"等战略定位？', hint: '', required: false },
          { id: 'q_format', question: '完成时限和审批流程要求？', hint: '', required: false },
        ],
      },
      {
        type: 'outline', stageId: 'outline', stageLabel: '生成提纲', stageIcon: '📋',
        structurePrompt: '简报的结构如何安排？请大致描述各部分的侧重点。',
        structureHint: '例如：导语/概述→详细经过→亮点数据→各方反应→意义展望',
      },
      { type: 'generate', stageId: 'generate', stageLabel: '正文撰写', stageIcon: '✍️', skillId: '__compose_generate__', temperature: 0.6 },
      { type: 'review', stageId: 'review', stageLabel: '质量审查', stageIcon: '🔍', skillIds: ['skill_logic', 'skill_grammar', 'skill_official'], autoFix: true },
      { type: 'polish', stageId: 'polish', stageLabel: '润色定稿', stageIcon: '✨', skillId: 'skill_concise', temperature: 0.4 },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // 六、课题研究
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'recipe_research',
    name: '课题研究',
    description: '调研报告、课题研究、可行性研究、对标分析等深度研究报告',
    genre: '课题研究',
    icon: '🔬',
    isBuiltin: true,
    knowledgeBaseIds: ['kb_003', 'kb_004', 'kb_005'],
    stages: [
      {
        type: 'interview',
        stageId: 'interview',
        stageLabel: '信息采集',
        stageIcon: '📝',
        systemPrompt: `你是一位央企研究院的专家，正在协助撰写一份课题研究报告。
逐项采集研究背景、方法路径、数据发现和对策建议等关键信息。
语气专业、客观、严谨。用户跳过的项目你将基于知识和常识合理推演补充。${SHARED_WRITING_RULES}`,
        questions: [
          { id: 'q_type', question: '这是什么类型的研究？（调研报告/课题研究报告/可行性研究/对标分析/政策研究/技术攻关总结/其他）', hint: '', required: true },
          { id: 'q_title', question: '课题/报告的名称和立项背景？（是否集团公司级、省部级或自立课题）', hint: '', required: true },
          { id: 'q_purpose', question: '研究目的和需要回答的核心问题？（如：如何提升采收率、如何开拓新能源市场、如何优化组织架构）', hint: '', required: false },
          { id: 'q_method', question: '研究的时间、范围、对象及方法？（问卷/访谈/座谈/实地考察/数据分析/实验验证）', hint: '', required: false },
          { id: 'q_data', question: '收集的主要数据、现状描述和关键发现？（生产经营数据、行业数据、对标数据）', hint: '', required: false },
          { id: 'q_analysis', question: '存在的主要问题及深层原因分析？（技术、管理、市场、政策、体制）', hint: '', required: false },
          { id: 'q_suggestion', question: '提出的对策建议、方案或结论？（需具备可操作性和经济可行性）', hint: '', required: false },
          { id: 'q_value', question: '研究成果的应用价值、经济效益或推广前景？', hint: '', required: false },
          { id: 'q_audience', question: '报告的用途和报送对象？（决策参考/上报/公开发表/立项审批/评审验收）', hint: '', required: false },
          { id: 'q_reference', question: '是否有必须引用的政策文件、行业标准、集团公司规划或对标数据？', hint: '', required: false },
          { id: 'q_secret', question: '是否涉及敏感数据或技术秘密？密级如何界定？', hint: '', required: false },
          { id: 'q_format', question: '完成时限、格式规范及字数要求？', hint: '', required: false },
        ],
      },
      {
        type: 'outline', stageId: 'outline', stageLabel: '生成提纲', stageIcon: '📋',
        structurePrompt: '研究报告的结构如何安排？请大致描述各部分的侧重点。',
        structureHint: '例如：研究背景→现状分析→问题诊断→对策建议→结论与展望',
      },
      { type: 'generate', stageId: 'generate', stageLabel: '正文撰写', stageIcon: '✍️', skillId: '__compose_generate__', temperature: 0.4 },
      { type: 'review', stageId: 'review', stageLabel: '质量审查', stageIcon: '🔍', skillIds: ['skill_logic', 'skill_grammar', 'skill_official'], autoFix: true },
      { type: 'polish', stageId: 'polish', stageLabel: '润色定稿', stageIcon: '✨', skillId: 'skill_concise', temperature: 0.5 },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // 七、工作通知
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'recipe_notice',
    name: '工作通知',
    description: '工作部署、会议通知、任免通知等各类正式通知，格式规范、执行明确',
    genre: '工作通知',
    icon: '📢',
    isBuiltin: true,
    knowledgeBaseIds: ['kb_003'],
    stages: [
      {
        type: 'interview',
        stageId: 'interview',
        stageLabel: '信息采集',
        stageIcon: '📝',
        systemPrompt: `你是一位央企办公室文书，正在起草一份正式通知。
逐项确认通知类型、接收范围、具体事项和执行要求等关键要素。
语气正式、准确、无歧义。用户跳过的项目你将合理补充。${SHARED_WRITING_RULES}`,
        questions: [
          { id: 'q_type', question: '这是什么类型的通知？（工作部署/会议通知/任免通知/转发通知/事项通知/安全环保通知/其他）', hint: '', required: true },
          { id: 'q_unit', question: '发文单位和背景？（为何发文，是否落实集团公司部署）', hint: '', required: true },
          { id: 'q_recipient', question: '主送/接收范围？（集团公司/专业公司/地区公司/二级单位/机关部门/全体员工）', hint: '', required: false },
          { id: 'q_content', question: '需要传达或部署的具体内容？（逐项列出，如：开展主题教育、组织安全检查、调整机构）', hint: '', required: false },
          { id: 'q_execution', question: '执行标准、完成时限和责任分工？（牵头部门、配合部门、责任人）', hint: '', required: false },
          { id: 'q_requirement', question: '工作要求、纪律约束或注意事项？（如：按时报送、严禁弄虚作假、纳入考核）', hint: '', required: false },
          { id: 'q_attachment', question: '是否需要附件？（方案/表格/模板/原文/任务清单）', hint: '', required: false },
          { id: 'q_relation', question: '与现有制度的衔接关系？（替代/补充/废止/无）', hint: '', required: false },
          { id: 'q_basis', question: '发文依据？（上级文件/集团公司决定/领导批示/会议决议/工作需要）', hint: '', required: false },
          { id: 'q_sensitive', question: '是否涉及安全环保、资金、人事等敏感事项？需履行何种审批程序？', hint: '', required: false },
          { id: 'q_secret', question: '密级和发布范围？', hint: '', required: false },
          { id: 'q_format', question: '完成时限和签发人要求？', hint: '', required: false },
        ],
      },
      {
        type: 'outline', stageId: 'outline', stageLabel: '生成提纲', stageIcon: '📋',
        structurePrompt: '通知的结构如何安排？请大致描述各部分的侧重点。',
        structureHint: '例如：发文依据→工作事项→执行要求→责任分工→附件说明',
      },
      { type: 'generate', stageId: 'generate', stageLabel: '正文撰写', stageIcon: '✍️', skillId: '__compose_generate__', temperature: 0.3 },
      { type: 'review', stageId: 'review', stageLabel: '质量审查', stageIcon: '🔍', skillIds: ['skill_logic', 'skill_grammar', 'skill_official'], autoFix: true },
      { type: 'polish', stageId: 'polish', stageLabel: '润色定稿', stageIcon: '✨', skillId: 'skill_concise', temperature: 0.3 },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // 八、规章制度
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'recipe_regulation',
    name: '规章制度',
    description: '管理办法、实施细则、操作规程、应急预案等制度文件',
    genre: '规章制度',
    icon: '📜',
    isBuiltin: true,
    knowledgeBaseIds: ['kb_003'],
    stages: [
      {
        type: 'interview',
        stageId: 'interview',
        stageLabel: '信息采集',
        stageIcon: '📝',
        systemPrompt: `你是一位央企合规管理专家，正在协助起草一份规章制度。
逐项确认制度类型、适用范围、管理流程和合规要求等关键要素。
语气正式严谨，条款清晰，权责分明。用户跳过的项目你将合理推演补充。${SHARED_WRITING_RULES}`,
        questions: [
          { id: 'q_type', question: '这是什么类型的制度？（管理办法/实施细则/操作规程/应急预案/HSE制度/党建制度/其他）', hint: '', required: true },
          { id: 'q_name', question: '制度的名称及制定/修订背景？（是否响应集团公司制度修订要求或监管新规）', hint: '', required: true },
          { id: 'q_scope', question: '适用范围？（集团公司/专业公司/地区公司/二级单位/部门/岗位/项目/承包商）', hint: '', required: false },
          { id: 'q_principle', question: '管理目标和核心原则？（如：合规经营、安全环保、提质增效、权责对等）', hint: '', required: false },
          { id: 'q_responsibility', question: '涉及的职责分工？（牵头部门/配合部门/执行岗位/监督部门/审计/纪检）', hint: '', required: false },
          { id: 'q_process', question: '管理的主要内容和关键环节？（按业务流程梳理，如：立项-审批-执行-监督-考核）', hint: '', required: false },
          { id: 'q_prohibition', question: '禁止性规定、限制性条款或风险控制点？（特别是安全环保、廉洁、资金、采购等红线）', hint: '', required: false },
          { id: 'q_supervision', question: '监督考核、奖惩措施或责任追究机制？（是否与绩效考核、干部任用挂钩）', hint: '', required: false },
          { id: 'q_relation', question: '与现有制度的衔接关系？（替代/补充/废止哪些制度）', hint: '', required: false },
          { id: 'q_approval', question: '征求意见、合法性审查、合规审核及审批程序情况？（是否经党委会/总经理办公会审议）', hint: '', required: false },
          { id: 'q_effective', question: '生效日期、过渡期安排及宣贯培训计划？', hint: '', required: false },
          { id: 'q_legal', question: '是否涉及国家法律法规、行业标准或集团公司上位制度？引用依据是什么？', hint: '', required: false },
          { id: 'q_secret', question: '密级和发布范围？', hint: '', required: false },
          { id: 'q_format', question: '完成时限和签发层级要求？', hint: '', required: false },
        ],
      },
      {
        type: 'outline', stageId: 'outline', stageLabel: '生成提纲', stageIcon: '📋',
        structurePrompt: '制度文件的结构如何安排？请大致描述各部分的侧重点。',
        structureHint: '例如：总则（目的/依据/范围）→职责分工→管理内容→监督考核→附则',
      },
      { type: 'generate', stageId: 'generate', stageLabel: '正文撰写', stageIcon: '✍️', skillId: '__compose_generate__', temperature: 0.3 },
      { type: 'review', stageId: 'review', stageLabel: '质量审查', stageIcon: '🔍', skillIds: ['skill_logic', 'skill_grammar', 'skill_official'], autoFix: true },
      { type: 'polish', stageId: 'polish', stageLabel: '润色定稿', stageIcon: '✨', skillId: 'skill_concise', temperature: 0.3 },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // 九、经验材料
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'recipe_experience',
    name: '经验材料',
    description: '工作汇报、经验交流、典型发言、成果展示等经验材料，突出可复制性',
    genre: '经验材料',
    icon: '⭐',
    isBuiltin: true,
    knowledgeBaseIds: ['kb_007', 'kb_008', 'kb_009'],
    stages: [
      {
        type: 'interview',
        stageId: 'interview',
        stageLabel: '信息采集',
        stageIcon: '📝',
        systemPrompt: `你是一位央企宣传部门的笔杆子，正在协助撰写一份经验交流材料。
逐项采集主题定位、问题挑战、创新做法、成效数据等关键信息。
语气生动有力，注重故事性和可推广性。用户跳过的项目你将合理补充完善。${SHARED_WRITING_RULES}`,
        questions: [
          { id: 'q_type', question: '这是什么类型的经验材料？（工作汇报/经验交流/典型发言/成果展示/其他）', hint: '', required: true },
          { id: 'q_occasion', question: '经验材料的使用场合？（上级会议/集团公司交流/行业会议/内部推广/媒体宣传）', hint: '', required: false },
          { id: 'q_theme', question: '经验材料的核心主题是什么？（如：党建引领、提质增效、技术创新、安全管理、市场开拓、数字化转型）', hint: '', required: true },
          { id: 'q_basic', question: '本单位/本部门的基本情况？（单位性质、业务板块、人员规模、主要职能）', hint: '', required: false },
          { id: 'q_problem', question: '面临的主要问题或挑战是什么？（请具体描述，如：产量递减、成本压力、安全隐患、队伍老化）', hint: '', required: false },
          { id: 'q_approach', question: '解决问题的核心思路和创新做法？（分步骤或分层次描述，突出"怎么做"）', hint: '', required: false },
          { id: 'q_practice', question: '关键举措的具体做法和操作流程？（可复制、可推广的"干货"）', hint: '', required: false },
          { id: 'q_result', question: '取得的具体成效？（尽量量化：产量提升、成本降低、事故减少、效率提高、收入增长等）', hint: '', required: false },
          { id: 'q_honor', question: '获得的荣誉、认可或推广情况？（上级表扬、行业奖项、兄弟单位学习、媒体报道）', hint: '', required: false },
          { id: 'q_value', question: '经验的核心价值或启示？（提炼几条可借鉴的规律性认识）', hint: '', required: false },
          { id: 'q_plan', question: '下一步深化或推广的计划？', hint: '', required: false },
          { id: 'q_strategy', question: '是否需要体现集团公司战略部署的贯彻落实？（如："转观念、勇担当、高质量、创一流"）', hint: '', required: false },
          { id: 'q_case', question: '是否有典型案例、人物故事或数据支撑？（增强感染力和说服力）', hint: '', required: false },
          { id: 'q_leader_hint', question: '领导或上级对本次经验交流有无特殊指示或必须体现的表述？', hint: '', required: false },
          { id: 'q_format', question: '完成时限、时长要求（如发言10分钟/15分钟）、格式模板及密级？', hint: '', required: false },
        ],
      },
      {
        type: 'outline', stageId: 'outline', stageLabel: '生成提纲', stageIcon: '📋',
        structurePrompt: '经验材料的结构如何安排？请大致描述各部分的侧重点。',
        structureHint: '例如：背景与挑战→创新思路→具体做法→成效数据→经验启示→推广计划',
      },
      { type: 'generate', stageId: 'generate', stageLabel: '正文撰写', stageIcon: '✍️', skillId: '__compose_generate__', temperature: 0.7 },
      { type: 'review', stageId: 'review', stageLabel: '质量审查', stageIcon: '🔍', skillIds: ['skill_logic', 'skill_grammar', 'skill_official'], autoFix: true },
      { type: 'polish', stageId: 'polish', stageLabel: '润色定稿', stageIcon: '✨', skillId: 'skill_golden', temperature: 0.7 },
    ],
  },

  // ═══════════════════════════════════════════════════════════════
  // 十、工作汇报
  // ═══════════════════════════════════════════════════════════════
  {
    id: 'recipe_report_work',
    name: '工作汇报',
    description: '向上级领导或会议汇报综合工作、专项任务或项目进展，数据准确、重点突出、诉求明确',
    genre: '工作汇报',
    icon: '📊',
    isBuiltin: true,
    knowledgeBaseIds: ['kb_003', 'kb_004', 'kb_005'],
    stages: [
      {
        type: 'interview',
        stageId: 'interview',
        stageLabel: '信息采集',
        stageIcon: '📝',
        systemPrompt: `你是一位央企办公室笔杆子，正在协助撰写一份工作汇报材料。
逐项采集汇报类型、工作进展、成效数据、问题困难和需要上级协调解决的事项等关键信息。
语气专业干练、数据驱动、重点突出，注意央企用语规范和政治站位。
当用户跳过时，你要基于已有信息和知识库自行判断补充。${SHARED_WRITING_RULES}`,
        questions: [
          { id: 'q_type', question: '这是什么类型的汇报？（综合工作/专项任务/项目进展/迎检汇报/安全环保/经营管理/党建/其他）', hint: '', required: true },
          { id: 'q_subject', question: '汇报主体？（集团公司/专业公司/地区公司/二级单位/部门/项目部）', hint: '', required: true },
          { id: 'q_period', question: '汇报的时间范围或截止节点？', hint: '例如：2025年1-9月、第三季度', required: true },
          { id: 'q_audience', question: '汇报对象？（集团公司领导/专业公司领导/上级部委/检查组/评审组/调研组/其他）', hint: '', required: false },
          { id: 'q_occasion', question: '汇报场合？（党组会/总经理办公会/专业会议/现场检查/视频连线/专题汇报/其他）', hint: '', required: false },
          { id: 'q_kpi', question: '核心生产经营指标完成进度？（产量、销量、收入、利润、成本、投资，已完成/年度目标/同比增幅）', hint: '', required: false },
          { id: 'q_tasks_done', question: '本周期已完成的重点工作任务？（按业务板块分类，简述措施和成效）', hint: '', required: false },
          { id: 'q_tasks_ongoing', question: '正在推进中的重点工作和当前进度？（列出节点和预计完成时间）', hint: '', required: false },
          { id: 'q_highlights', question: '最突出的亮点成绩或阶段性突破？（技术创新、管理提升、市场开拓、数字化转型等）', hint: '', required: false },
          { id: 'q_hse', question: '安全环保（HSE）总体态势？（事故/隐患/环保指标/体系运行情况）', hint: '', required: false },
          { id: 'q_party', question: '党建工作推进情况？（主题教育、巡视巡察整改、"三基本"建设、党风廉政建设）', hint: '', required: false },
          { id: 'q_difficulties', question: '当前面临的主要困难和突出问题？（生产经营/资金/技术/市场/队伍/政策，各简述要点）', hint: '', required: false },
          { id: 'q_requests', question: '需要上级协调解决或批示的具体事项？（资源调配、政策支持、部门协调、审批等）', hint: '', required: false },
          { id: 'q_spirit', question: '是否需要体现集团公司最新工作部署、会议精神或领导指示的贯彻落实情况？', hint: '', required: false },
          { id: 'q_next', question: '下一步重点安排和预期目标？', hint: '', required: false },
          { id: 'q_data', question: '是否有必须引用的权威数据、典型案例或政策文件？', hint: '', required: false },
          { id: 'q_format', question: '完成时限、汇报时长（如10分钟/20分钟）、格式模板及密级要求？', hint: '', required: false },
        ],
      },
      {
        type: 'outline', stageId: 'outline', stageLabel: '生成提纲', stageIcon: '📋',
        structurePrompt: '工作汇报的结构如何安排？请大致描述各部分的侧重点。',
        structureHint: '例如：总体进展→重点任务→亮点成效→困难问题→需协调事项→下步安排',
      },
      { type: 'generate', stageId: 'generate', stageLabel: '正文撰写', stageIcon: '✍️', skillId: '__compose_generate__', temperature: 0.5 },
      { type: 'review', stageId: 'review', stageLabel: '质量审查', stageIcon: '🔍', skillIds: ['skill_logic', 'skill_grammar', 'skill_official'], autoFix: true },
      { type: 'polish', stageId: 'polish', stageLabel: '润色定稿', stageIcon: '✨', skillId: 'skill_concise', temperature: 0.5 },
    ],
  },
]

/** 根据 ID 查找菜谱 */
export function findRecipe(id: string): ComposeRecipe | undefined {
  return builtinRecipes.find((r) => r.id === id)
}

// ─── 运行时缓存 ──────────────────────────────────────────────

/** 自定义菜谱的运行时缓存（从 DB 加载后存于此） */
export const customRecipesCache = ref<ComposeRecipe[]>([])

interface ComposeRecipeRow {
  id: string; name: string; is_builtin: boolean;
  config: string; sort_order: number; created_at: string; updated_at: string;
}

/** 从 DB 加载所有自定义菜谱到缓存 */
export async function loadCustomRecipes(): Promise<ComposeRecipe[]> {
  try {
    const rows = await invoke<ComposeRecipeRow[]>('list_compose_recipes')
    const recipes: ComposeRecipe[] = rows
      .filter(r => !r.is_builtin)
      .map(r => {
        const cfg = JSON.parse(r.config)
        return { id: r.id, name: r.name, isBuiltin: false, ...cfg } as ComposeRecipe
      })
    customRecipesCache.value = recipes
    return recipes
  } catch {
    return []
  }
}

/** 保存单个自定义菜谱（新增或更新） */
export async function saveCustomRecipe(recipe: ComposeRecipe): Promise<void> {
  const { id, name, isBuiltin, ...config } = recipe
  const configJson = JSON.stringify(config)
  await invoke('save_compose_recipe', { id, name, config: configJson })
  // 更新缓存
  const idx = customRecipesCache.value.findIndex(r => r.id === id)
  if (idx >= 0) {
    customRecipesCache.value[idx] = recipe
  } else {
    customRecipesCache.value.push(recipe)
  }
}

/** 删除自定义菜谱 */
export async function deleteCustomRecipe(id: string): Promise<void> {
  await invoke('delete_compose_recipe', { id })
  customRecipesCache.value = customRecipesCache.value.filter(r => r.id !== id)
}

/** 同步获取所有菜谱（内置 + 缓存） */
export function getAllRecipes(): ComposeRecipe[] {
  return [...builtinRecipes, ...customRecipesCache.value]
}

// ─── localStorage → DB 迁移 ──────────────────────────────────

const CUSTOM_RECIPES_KEY = 'aipen_custom_recipes'

/** 应用启动时调用：迁移 localStorage 中的旧菜谱到 DB */
export async function migrateRecipesToDb(): Promise<void> {
  // 先加载现有 DB 菜谱
  await loadCustomRecipes()
  // 检查 localStorage 是否有旧数据
  try {
    const raw = localStorage.getItem(CUSTOM_RECIPES_KEY)
    if (!raw) return
    const oldRecipes: ComposeRecipe[] = JSON.parse(raw)
    if (oldRecipes.length === 0) return
    for (const recipe of oldRecipes) {
      // 按 id 检查是否已在 DB 中
      if (customRecipesCache.value.some(r => r.id === recipe.id)) continue
      await saveCustomRecipe(recipe)
    }
    // 迁移完毕，清除 localStorage
    localStorage.removeItem(CUSTOM_RECIPES_KEY)
    await loadCustomRecipes()
    console.log(`已迁移 ${oldRecipes.length} 个自定义菜谱到数据库`)
  } catch { /* 忽略 */ }
}
