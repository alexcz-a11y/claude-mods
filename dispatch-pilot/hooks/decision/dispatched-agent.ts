// A dispatched agent's model and effort: the questions the decision model
// answers when the main agent starts an agent, and how the answers become the
// model it runs on and the effort of its steps (ADR 0015).
//
// Judgments from the decision model, decisions in code (TypeSafe's guide): the decision model answers one yes/no question
// (a Noul) for each judgment about the brief, and a table in code turns the verdicts into a model. The effort is the Score
// every effort question shares, read by the base rule and lifted by floors, as a message's is (decision/message-effort.ts).
//
//   model   1   a model the person named for the work                                         → that model
//           2   fable offered (agentFable) and frontier yes                                   → fable
//           3   any of stakes.undo, stakes.live, stakes.access, cause_unknown, design_open,
//               outside_facts, science_code yes                                               → opus
//           3b  none of those yes, one or more of them in the band                            → sonnet, effort max
//           4   writes no, few_steps yes and report_only yes                                  → haiku
//           5   otherwise                                                                     → sonnet
//           The first row that matches wins. A model the person ruled out is skipped for the nearest one allowed, the
//           next stronger first, else the next weaker. The main agent's pick (a Workflow call's: the script's) is kept
//           unless the table's model is stronger: a pick is raised, never lowered.
//   effort  the person's named effort as it is; else the Score's base (its position rounded, one level up when it is
//           two-peaked), lifted by the stakes (undo and live or access yes → max; any yes → xhigh; any in the band →
//           high), by the unknown cause (yes → xhigh; band → high), by row 3b (max) and by the model's floor (sonnet and
//           opus: medium). A floor only lifts; the highest stands.
//
// A Noul reads yes from 0.7 and no up to 0.3, the band between (decision/nouls.ts, TypeSafe's starting values); so do the
// person's named and ruled-out models and their named effort. A missing answer lifts nothing and makes no haiku.
//
// That is the table, the way of Jev and pplx (TypeSafe's guide). With d1-ultra the model is Liquid's routing instead (its
// guide, decision/guides.ts; ADR 0017): one Choice of a model tier (`route`: fast → haiku, standard → sonnet, powerful →
// opus, and frontier → fable while fable is offered), its top tier taken, and the strongest model allowed when its
// confidence is below 0.5 ("If the router is uncertain, fall back to the most capable tier"). A tier whose model the person
// ruled out gives way to the allowed tier the route rates highest. The person's named model comes first and the main agent's
// pick is raised, never lowered, as with the table. Its effort is read as the table's is, at Liquid's bars (yes above 0.8, no
// below 0.2) and with its rule for an unsure Score (confidence below 0.5: one level up); the stakes and the unknown cause are
// still asked for their floors, and there is no row 3b, so no floor of max.
//
// Pure (see system-one.ts). The input is the eval item's shape (subagent.jsonl's `zh` / `en`), so the eval (#15) builds the
// same request from an item as the mod builds from an agent.spawn (ADR 0005).

import { referenceField, type ReferenceReading } from './complexity.ts'
import { clipToTokens, estimateTokens, recentWithin, withinTokens } from './context.ts'
import {
  CAUSE_UNKNOWN,
  DEFAULT_ASK,
  EFFORTS,
  effortQuestion,
  higherEffort,
  levelsText,
  probsOf,
  readEffort,
  STAKES_ACCESS,
  STAKES_LIVE,
  STAKES_UNDO,
  traceEffort,
  type Effort,
  type EffortAsk,
  type EffortReading,
  type EffortStep,
  type Language,
} from './effort.ts'
import { failureText, type Failure } from './backend.ts'
import { causeFloor, stakesFloor } from './message-effort.ts'
import { TYPESAFE_GUIDE, type Guide, type NoulBars } from './guides.ts'
import { isYes, readNoul, verdictOrNo, type Verdict } from './nouls.ts'
import { redactSecrets } from './redact.ts'
import { SUMMARY_FIELD, type SummaryState } from './summary.ts'
import type { Answer, Part, Question, State } from './system-one.ts'
import { COUNT_FIELD } from './unresolved.ts'

/** The models a dispatched agent can run on, weakest (and cheapest) first: the Agent tool's own aliases. */
export const AGENT_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export type AgentModel = (typeof AGENT_MODELS)[number]
/** The models the table may give unless the person adds fable (`agentFable`). */
export const DEFAULT_AGENT_MODELS: readonly AgentModel[] = ['haiku', 'sonnet', 'opus']

/** One dispatched agent as its decision reads it: the eval item's fields. */
export type Dispatch = {
  /** The person's own words this turn; '' when there are none. */
  user_message: string
  /** The agent type (`general-purpose`, `Explore`, a plugin's agent); null when none was named. */
  agent_type: string | null
  /** The few words the main agent described the task with; null for a workflow's agent. */
  description: string | null
  /** The task the agent is given. */
  prompt: string
  /** The model the main agent asked for (an alias such as `sonnet`, or an id); null when it named none. */
  requested_model: string | null
  /** `agent` (the Agent tool, the default) or `workflow` (an `agent()` of a Workflow script). */
  kind?: 'agent' | 'workflow'
  /** What the workflow as a whole is for (a workflow's agent only). */
  workflow_description?: string | null
  /** The `agent()` call's label (a workflow's agent only). */
  label?: string | null
  /** The problem summary with its named fields (decision/summary.ts `summaryState`); the agent's background, never a rule. Absent when there is none. */
  problem_summary?: SummaryState
  /** How many times the person has said the problem is still unresolved; absent while it is 0 (#41). */
  unresolved_count?: number
  /** What the latest reference images of the session read as (#64): text only, never the images; a hint, in the state as `reference_complexity`. Absent when none has been read or image routing is off. */
  reference_complexity?: ReferenceReading
  /**
   * The conversation the agent was dispatched from, oldest first, a line per message (context.ts `recentLines`: the
   * text and the tools' names, never a tool's input or output): what the main agent worked from when it wrote the
   * brief. Sent in what the brief and the person's words leave of the budget, newest first. Absent: none is sent
   * (a backend whose `agentBackground` is off, BACKEND_DEFAULTS; the eval's items have none).
   */
  recent_context?: readonly string[]
}

/** How the questions are asked: their language and the effort question's primitive (eval variables; the mod asks in English, with a Score). */
export type DispatchAsk = EffortAsk
export const DEFAULT_DISPATCH_ASK: DispatchAsk = DEFAULT_ASK

/** What a request about one agent is built from, besides the agent; also what decides it (`DispatchSettings`). */
export type DispatchShape = {
  /** The models the table may give, weakest first; DEFAULT_AGENT_MODELS by default. With fable among them, `frontier` is asked. */
  models?: readonly AgentModel[]
  ask?: Partial<DispatchAsk>
  /** The part's name: question ids are `<part>.<id>`. `agent` by default. */
  part?: string
  /** The state field that holds the agent's brief. `brief` by default. */
  field?: string
  /** How the answers are read and the model chosen: the decision model's guide (decision/guides.ts); TypeSafe's, the table, unless given. */
  guide?: Guide
}

const AGENT_PART = 'agent'
export const BRIEF = 'brief'
/** The question ids within the part; a yes/no question about one model is `<prefix>.<model>`. */
export const EFFORT = 'effort'
export const NAMED = 'named'
export const BANNED = 'banned'
/** The question of which effort, if any, the person asks for; asked only when their words may name one (`mentionsEffort`). */
export const NAMED_EFFORT = 'named_effort'
/** The named-effort question's option for no effort asked for. */
const NO_EFFORT = 'none'

/** The yes/no questions about the brief, by id within the part (ADR 0015); the stakes and the unknown cause keep a message's ids (decision/effort.ts). */
export const WRITES = 'writes'
export const FEW_STEPS = 'few_steps'
export const REPORT_ONLY = 'report_only'
export const DESIGN_OPEN = 'design_open'
export const OUTSIDE_FACTS = 'outside_facts'
export const SCIENCE_CODE = 'science_code'
export const FRONTIER = 'frontier'
/** The three that together make a lookup haiku can carry out (row 4). */
export const LOOKUP = [WRITES, FEW_STEPS, REPORT_ONLY] as const
/** Those whose yes sends the work to opus (row 3), and whose band to sonnet at max effort (row 3b). */
export const CAREFUL = [STAKES_UNDO, STAKES_LIVE, STAKES_ACCESS, CAUSE_UNKNOWN, DESIGN_OPEN, OUTSIDE_FACTS, SCIENCE_CODE] as const
/** Every Noul about the brief, in the order asked; `frontier` only while fable is offered. */
export const BRIEF_NOULS = [...LOOKUP, ...CAREFUL, FRONTIER] as const
export type BriefNoul = (typeof BRIEF_NOULS)[number]
/** The Nouls about the brief the route asks beside it (d1-ultra, ADR 0017): only those the effort's floors read. */
export const FLOOR_NOULS = [STAKES_UNDO, STAKES_LIVE, STAKES_ACCESS, CAUSE_UNKNOWN] as const

/** The question id of the model tier, with d1-ultra (Liquid's routing, ADR 0017). */
export const ROUTE = 'route'
/** The route's tiers, weakest first; `frontier` only while fable is offered. The names go to the model (Liquid's example's, and one more). */
export const ROUTE_TIERS = ['fast', 'standard', 'powerful', 'frontier'] as const
export type RouteTier = (typeof ROUTE_TIERS)[number]
/** The model each tier gives. The card and the log name a tier as Liquid's example does (fast, standard, powerful). */
export const TIER_MODELS: Readonly<Record<RouteTier, AgentModel>> = { fast: 'haiku', standard: 'sonnet', powerful: 'opus', frontier: 'fable' }

/**
 * Each Noul's field in the rules' working (the decision log and the card read it, ADR 0004), and its name for the person
 * (Chinese, as the card and the log speak).
 */
export const SIGNS: Readonly<Record<BriefNoul, { key: string; words: string }>> = {
  [WRITES]: { key: 'writes', words: '写入' },
  [FEW_STEPS]: { key: 'fewSteps', words: '一两步' },
  [REPORT_ONLY]: { key: 'reportOnly', words: '只汇报' },
  [STAKES_UNDO]: { key: 'undo', words: '难以挽回' },
  [STAKES_LIVE]: { key: 'live', words: '线上或真钱' },
  [STAKES_ACCESS]: { key: 'access', words: '权限' },
  [CAUSE_UNKNOWN]: { key: 'cause', words: '原因未知' },
  [DESIGN_OPEN]: { key: 'design', words: '方案未定' },
  [OUTSIDE_FACTS]: { key: 'outside', words: '仓库外事实' },
  [SCIENCE_CODE]: { key: 'science', words: '科学计算' },
  [FRONTIER]: { key: 'frontier', words: '前沿难题' },
}

/** One Noul's words: its question, and true and false as situations (TypeSafe: one concrete judgment, true meaning yes). */
type NoulText = { question: string; yes: string; no: string }

/** The Nouls about the brief in `field`, in `language`: each reads the agent's task, `<field>.prompt`. */
function briefWords(language: Language, field: string): Record<BriefNoul, NoulText> {
  const task = `\`${field}.prompt\``
  if (language === 'zh') {
    return {
      [WRITES]: {
        question: `${task} 是否要求 agent 创建、修改或删除文件，或者执行会改变什么的命令？`,
        yes: 'agent 会编辑、新建、移动或删除文件，提交或推送，安装或迁移东西，或者执行会改变文件、数据或系统的命令。',
        no: 'agent 只读、只搜索并汇报，或者只执行查看、检查类的命令，比如搜索、列目录、跑测试。',
      },
      [FEW_STEPS]: {
        question: `${task} 里的工作能否用一两次工具调用完成？`,
        yes: '一两次搜索、读文件、执行命令或查找就能得出答案。',
        no: '这项工作要连续多次工具调用：探查、跨文件追引用、试一下再检查，或者很多次分开的查找。',
      },
      [REPORT_ONLY]: {
        question: `${task} 的结果是否只是按要求收集并排版（列表、表格、计数），没有需要判断的东西？`,
        yes: 'agent 按要求交回它找到的东西：匹配项、文件路径、计数、命令输出或文件内容。',
        no: 'agent 要做判断、比较、推荐、解释原因、审查，或者产出计划、设计或修改。',
      },
      [STAKES_UNDO]: {
        question: `${task} 所要求的工作一旦出错，是否难以挽回，比如删掉的数据、已经发出的消息、已经发布的版本？`,
        yes: '这项工作会删除或覆盖数据、向外部的人或系统发送东西、发布或部署，或者任务里说了不能回滚。',
        no: '这项工作只改动可以撤回的文件，或者只是阅读、解释、规划。',
      },
      [STAKES_LIVE]: {
        question: `${task} 所要求的工作是否作用在线上生产系统或真钱上？`,
        yes: '它会在真实用户或付款依赖的服务器、数据库、账户上运行，或者转移、扣收真钱。',
        no: '它在本地、测试里、预发或沙箱系统上运行，或者只改代码、不在生产环境上运行。',
      },
      [STAKES_ACCESS]: {
        question: `${task} 所要求的工作是否改动权限、认证或密钥？`,
        yes: '它会改变谁能访问什么：角色、权限、登录或 token 处理、密钥、密码或其他 secret。',
        no: '它不涉及访问控制、认证或 secret。',
      },
      [CAUSE_UNKNOWN]: {
        question: `${task} 所要求的工作是否包括找出一个任务里没写明原因的故障？`,
        yes: '有东西出错或表现不对，而任务里没说为什么：agent 得追查原因。',
        no: '没有要解释的故障，或者任务里已经写明了原因，要做的是修。',
      },
      [DESIGN_OPEN]: {
        question: `${task} 是否要求 agent 自己选一个任务里没给出的做法？`,
        yes: '任务只给了目标或问题，做法留给 agent 定：采用哪种设计、结构、接口或取舍。',
        no: '任务已经说了怎么做（文件、步骤或做法），或者没有要设计的东西：查找、按给定标准检查，或原因已知的修复。',
      },
      [OUTSIDE_FACTS]: {
        question: `${task} 的结论是否取决于仓库之外、无法在仓库或文档里查证的事实，比如某个 API 的行为、某个标准、版本之间的差异？`,
        yes: '答案靠 agent 对外部库、服务、标准或版本的记忆，记错了也不会被发现。',
        no: '这项工作需要的东西都在仓库里、任务里，或者在 agent 能读到并核对的文档和网页里。',
      },
      [SCIENCE_CODE]: {
        question: `${task} 里的工作是否涉及数值、算法或科学计算代码？`,
        yes: '数值方法、需要推敲正确性或复杂度的算法、统计、模拟、几何、密码学或其他科学计算。',
        no: '普通的应用代码、配置、脚本、文档或文字，或者查找。',
      },
      [FRONTIER]: {
        question: `${task} 是否要求严格的证明，或者没有现成答案的全新算法或架构？`,
        yes: '必须成立的证明，或者还没人解决过的算法或架构：超出细心的资深工程师知道怎么做的范围。',
        no: '细心的资深工程师能做好的工作：设计、调试、重构、审查、安全或迁移，无论多重要。',
      },
    }
  }
  return {
    [WRITES]: {
      question: `Does ${task} ask the agent to create, change or delete files, or to run commands that change something?`,
      yes: 'The agent edits, creates, moves or deletes files, commits or pushes, installs or migrates something, or runs a command that changes files, data or a system.',
      no: 'The agent only reads, searches and reports, or runs commands that only look or check, such as a search, a listing or a test run.',
    },
    [FEW_STEPS]: {
      question: `Can the work in ${task} be done with one or two tool calls?`,
      yes: 'One or two searches, file reads, commands or lookups give the answer.',
      no: 'The work takes a run of tool calls: exploring, following references across files, trying something and checking it, or many separate lookups.',
    },
    [REPORT_ONLY]: {
      question: `Is the result of ${task} only gathered and laid out as asked (a list, a table, a count), with nothing to decide?`,
      yes: "The agent hands back what it found, as asked: matches, file paths, a count, a command's output or a file's contents.",
      no: 'The agent has to judge, compare, recommend, explain why, review, or produce a plan, a design or a change.',
    },
    [STAKES_UNDO]: {
      question: `Would a mistake in the work that ${task} asks for be hard to undo, such as deleted data, a sent message, or a published release?`,
      yes: 'The work deletes or overwrites data, sends something to people or systems outside, publishes or deploys, or the brief says it cannot be rolled back.',
      no: 'The work only changes files that can be reverted, or it reads, explains or plans.',
    },
    [STAKES_LIVE]: {
      question: `Does the work that ${task} asks for act on a live production system or on real money?`,
      yes: 'It runs against servers, databases or accounts that real users or payments depend on, or it moves or charges real money.',
      no: 'It runs locally, in tests, or on a staging or sandbox system, or it only edits code without running it against production.',
    },
    [STAKES_ACCESS]: {
      question: `Does the work that ${task} asks for change permissions, authentication, or secrets?`,
      yes: 'It changes who can access what: roles, permissions, login or token handling, keys, passwords or other secrets.',
      no: 'It does not touch access control, authentication or secrets.',
    },
    [CAUSE_UNKNOWN]: {
      question: `Does the work that ${task} asks for include finding the cause of a failure that the brief does not already name?`,
      yes: 'Something fails or misbehaves and the brief does not say why: the agent has to trace the cause.',
      no: 'There is no failure to explain, or the brief already names its cause and the work is to fix it.',
    },
    [DESIGN_OPEN]: {
      question: `Does ${task} ask the agent to choose an approach that the brief does not already give?`,
      yes: 'The brief gives a goal or a problem and leaves the approach open: which design, structure, interface or trade-off to take is for the agent to decide.',
      no: 'The brief already says how (the files, the steps or the approach), or there is nothing to design: a lookup, a check against given criteria, or a fix whose cause is known.',
    },
    [OUTSIDE_FACTS]: {
      question: `Does the conclusion of ${task} depend on facts from outside the repository, such as how an API behaves, a standard, or differences between versions, that cannot be checked in the repository or in documents?`,
      yes: 'The answer rests on what the agent recalls about an outside library, service, standard or version, and a wrong recollection would go unnoticed.',
      no: 'What the work needs is in the repository, in the brief, or in documents and pages the agent can read and check.',
    },
    [SCIENCE_CODE]: {
      question: `Does the work in ${task} involve numerical, algorithmic or scientific code?`,
      yes: 'Numerical methods, algorithms whose correctness or complexity has to be reasoned out, statistics, simulation, geometry, cryptography or other scientific computation.',
      no: 'Ordinary application code, configuration, scripts, documents or text, or a lookup.',
    },
    [FRONTIER]: {
      question: `Does ${task} ask for a rigorous proof, or for a new algorithm or architecture with no known answer?`,
      yes: 'A proof that has to hold, or an algorithm or architecture nobody has worked out yet: more than a careful senior engineer would know how to do.',
      no: 'Work a careful senior engineer can do: design, debugging, refactors, reviews, security or migrations, however important.',
    },
  }
}

/** What every Noul about the brief reads, named (TypeSafe: a question names the fields it reads). */
function readsOf(language: Language, field: string): string {
  return language === 'zh' ? `根据 \`${field}\`（派给 agent 的任务）判断；\`user_message\` 是用户这一轮说的话。` : `Judge from \`${field}\`, the agent's task; \`user_message\` is what the person said this turn.`
}

/** The Nouls about the brief in `field`, by id: `ids` (every one, `frontier` only with `fable`, agentFable, unless given). */
function briefQuestions(language: Language, field: string, fable: boolean, only?: readonly BriefNoul[]): Record<string, Question> {
  const words = briefWords(language, field)
  const reads = readsOf(language, field)
  const key = language === 'zh' ? { question: '问题', reads: '依据' } : { question: 'question', reads: 'reads' }
  const ids = only ?? BRIEF_NOULS.filter((id) => fable || id !== FRONTIER)
  return Object.fromEntries(
    ids.map((id): [string, Question] => [id, { type: 'noul', instructions: { [key.question]: words[id].question, [key.reads]: reads }, criteria: { true: words[id].yes, false: words[id].no } }]),
  )
}

/**
 * The route (d1-ultra): Liquid's routing example ("Which model tier should handle this request?", its tiers fast, standard
 * and powerful) asked of the brief, each tier described by the work it fits; `frontier` only with `fable` (agentFable).
 */
function routeQuestion(language: Language, field: string, fable: boolean): Question {
  const task = `\`${field}.prompt\``
  const tiers: Record<Language, Record<RouteTier, string>> = {
    en: {
      fast: 'Gathering, finding or listing things and reporting them as asked: nothing to decide and nothing to change.',
      standard: 'Ordinary software work with a known approach: writing or changing code, running tests, reviewing or explaining.',
      powerful:
        'Work where a mistake is costly or hard to undo, the cause of a failure is unknown, an approach has to be chosen, the answer rests on facts from outside the repository, or the code is numerical or scientific.',
      frontier: 'A rigorous proof, or a new algorithm or architecture with no known answer.',
    },
    zh: {
      fast: '收集、查找或列出东西，按要求汇报：没有要决定的，也没有要改的。',
      standard: '做法已知的常规软件工作：写代码或改代码、跑测试、审查或解释。',
      powerful: '出错代价高或难以挽回、故障原因未知、要选做法、答案取决于仓库外的事实，或者数值、科学计算代码。',
      frontier: '严格的证明，或者没有现成答案的全新算法或架构。',
    },
  }
  const offered = ROUTE_TIERS.filter((tier) => fable || tier !== 'frontier')
  const instructions =
    language === 'zh'
      ? { 问题: `${task} 里的工作应该交给哪一档模型？`, 依据: readsOf(language, field) }
      : { question: `Which model tier should handle the work in ${task}?`, reads: readsOf(language, field) }
  return { type: 'choice', instructions, criteria: Object.fromEntries(offered.map((tier) => [tier, tiers[language][tier]])) }
}

/** The effort question's instructions (jev-pilot's SUBAGENT_EFFORT_INSTRUCTIONS: 14 real briefs rated xhigh went from 10 to 1; guide §4.2). */
function effortInstructions(language: Language, field: string): Record<string, string> {
  if (language === 'zh') {
    return {
      问题: `一个派出的 agent 要完成 \`${field}\`，需要多少逐步推理？`,
      执行: `如果 \`${field}\` 已经写明了要改的文件、步骤和测试，设计就已经做完了，照着做只是执行。只有它本身要求设计、原因未知，或需要尚未写出的推理时，才评得更高。`,
      评什么: '评的是工作本身，而不是话题听起来有多重要：审查一份小 diff 是常规工作，即使涉及安全。',
    }
  }
  return {
    question: `How much step-by-step reasoning does a dispatched agent need to carry out \`${field}\`?`,
    execution: `A brief that already names the files, the steps and the tests has done the design: carrying it out is execution. Rate higher only when \`${field}\` itself asks for design, an unknown cause, or reasoning that is not already written out.`,
    rate: 'Rate the work, not how important the topic sounds: reviewing a small diff is ordinary work, even for security.',
  }
}

/**
 * Whether the person asks for `model` to carry out the brief. A model's name
 * in their words is no request by itself: the decision model reads it in
 * context, so a mention as a product, as what wrote earlier code, as the one
 * not to use, or for another part of the work (the eval's traps) is a no.
 */
function namedQuestion(model: AgentModel, language: Language, field: string): Question {
  const title = model.charAt(0).toUpperCase() + model.slice(1)
  if (language === 'zh') {
    return {
      type: 'noul',
      instructions: { 模型: model, 问题: `\`user_message\` 是否要求用 \`模型\` 来做 \`${field}\` 里的工作？` },
      criteria: {
        true: `用户要求这项工作（或所有派出的 agent）用这个模型，例如「用 ${model}」「这活儿 ${model} 就够了」「派个 ${model} 去查」「这次所有 agent 都用 ${model}」「用 ${title} 跑」。`,
        false: `只是提到这个模型：作为讨论或比较的产品、作为之前写某段代码的模型、作为不要用的模型，或者是给 \`${field}\` 以外的另一部分工作点名的模型。`,
      },
    }
  }
  return {
    type: 'noul',
    instructions: { model, question: `Does \`user_message\` ask for \`model\` to carry out the work in \`${field}\`?` },
    criteria: {
      true: `The person asks for this model for this work, or for every agent: "use ${model}", "${model} is enough for this", "send ${model} to look into it", "every agent uses ${model} this time", "run it on ${title}".`,
      false: `The model is only mentioned: as a product being discussed or compared, as what wrote some earlier code, as a model not to use, or as the model for a different part of the work than \`${field}\`.`,
    },
  }
}

/** Whether the person rules `model` out for the brief ("别用 opus"): the model is then not used for it. */
function bannedQuestion(model: AgentModel, language: Language, field: string): Question {
  if (language === 'zh') {
    return {
      type: 'noul',
      instructions: { 模型: model, 问题: `\`user_message\` 是否排除了用 \`模型\` 来做 \`${field}\` 里的工作？` },
      criteria: {
        true: `用户说这项工作（或所有派出的 agent）不要用这个模型，例如「别用 ${model}」「别再用 ${model} 了」「${model} 太贵了，换个便宜的」。`,
        false: `要求用这个模型、只是提到它，或者排除它的是 \`${field}\` 以外的另一部分工作。`,
      },
    }
  }
  return {
    type: 'noul',
    instructions: { model, question: `Does \`user_message\` rule out \`model\` for the work in \`${field}\`?` },
    criteria: {
      true: `The person says not to use this model for this work or for any agent: "don't use ${model}", "no more ${model}", "${model} is too expensive, use something cheaper".`,
      false: `The model is asked for, only mentioned, or ruled out for a different part of the work than \`${field}\`.`,
    },
  }
}

/**
 * Whether the person's words may name an effort: a cheap sign of text, only to
 * decide whether the named-effort question is worth its place in the request.
 * It is no judgment (spec #1): the decision model reads the words, and says
 * whether an effort is asked for and which. So it errs wide: a level's name,
 * "effort", or how hard to think, in either language.
 */
export function mentionsEffort(text: string): boolean {
  return EFFORT_WORDS.test(text)
}

/**
 * Words that may ask for an effort: a level's name, or a way of asking for
 * more (or less) thought. "think" and "reason" alone are everyday words ("I
 * think", "the reason"), so in English only a phrase counts ("think hard",
 * "more reasoning", "ultrathink").
 */
const EFFORT_WORDS =
  /effort|\bx-?high\b|extra[- ]high|\b(?:low|medium|high|max|maximum)\b|ultrathink|\bthink(?:ing)?\s+(?:hard|harder|deep(?:ly|er)?|long(?:er)?|carefully|more|less)\b|\b(?:more|less|deep(?:er)?|extra|maximum|minimal|careful)\s+(?:reasoning|thinking|thought)\b|\breasoning\s+(?:effort|level|budget)\b|推理|思考|思维|努力|强度|力度|档|拉满|开满|最低|最高|超高|极高/i

/**
 * Whether the person asks for an effort for the agent that carries out the
 * brief, and which: one of the five levels, or none. Like a model's name, a
 * level's name in their words is no request by itself; the decision model
 * reads it in context, and an effort asked for another part of the work is none.
 */
function namedEffortQuestion(language: Language, field: string): Question {
  if (language === 'zh') {
    return {
      type: 'choice',
      instructions: {
        问题: `\`user_message\` 是否明确要求 \`${field}\` 里的工作用某一档 effort（思考强度）？要求的是哪一档？`,
        范围: '为所有派出的 agent 或这一轮全部工作要求的档位，也管这项工作；只给 `' + field + '` 以外的另一部分工作要求的档位不管。',
        不算: '只说「多想想」「别想太久」而没点名档位、只是提到某一档（讨论、比较、以前的设置、不想要的档位），都选 none。',
      },
      criteria: {
        [NO_EFFORT]: '用户没有为这项工作要求任何一档 effort。',
        low: '用户要求这项工作（或所有派出的 agent）用 low 档，例如「effort 开 low」「用最低档思考」。',
        medium: '用户要求这项工作（或所有派出的 agent）用 medium 档，例如「effort 用 medium」「中档就行」。',
        high: '用户要求这项工作（或所有派出的 agent）用 high 档，例如「effort 开 high」「用高档」。',
        xhigh: '用户要求这项工作（或所有派出的 agent）用 xhigh 档，例如「effort 开 xhigh」「超高档」。',
        max: '用户要求这项工作（或所有派出的 agent）用 max 档，例如「effort 拉满」「用 max」「最高档」。',
      },
    }
  }
  return {
    type: 'choice',
    instructions: {
      question: `Does \`user_message\` explicitly ask for a particular effort level (how hard the agent thinks) for the work in \`${field}\`, and which one?`,
      scope: `A level asked for every agent, or for all the work this turn, covers this work too; a level asked only for a different part of the work than \`${field}\` does not.`,
      not_a_request: 'Asking to think more or less without naming a level, or mentioning a level only in passing (discussed or compared, an earlier setting, a level the person does not want), asks for none.',
    },
    criteria: {
      [NO_EFFORT]: 'The person asks for no effort level for this work.',
      low: 'The person asks for low effort for this work or for every agent: "effort low", "set effort to low", "run it at low effort".',
      medium: 'The person asks for medium effort for this work or for every agent: "effort medium", "medium effort is enough".',
      high: 'The person asks for high effort for this work or for every agent: "effort high", "use high effort".',
      xhigh: 'The person asks for xhigh (extra high) effort for this work or for every agent: "effort xhigh", "extra high effort".',
      max: 'The person asks for max effort for this work or for every agent: "effort max", "max effort", "all the way up".',
    },
  }
}

/** The models whose names `text` mentions, in any case and inside ids (`claude-sonnet-5-5`); weakest first. */
export function mentionedModels(text: string): AgentModel[] {
  const lower = text.toLowerCase()
  return AGENT_MODELS.filter((model) => lower.includes(model))
}

/** The questions about one dispatched agent, as one part of a request: the Nouls about the brief, the effort, and what the person's words may name. */
export function dispatchPart(dispatch: Dispatch, shape: DispatchShape = {}): Part {
  const ask = { ...DEFAULT_DISPATCH_ASK, ...shape.ask }
  const field = shape.field ?? BRIEF
  const models = shape.models ?? DEFAULT_AGENT_MODELS
  const fable = models.includes('fable')
  // The table's Nouls (Jev, pplx), or the route and the Nouls its effort's floors read (d1-ultra).
  const model = (shape.guide ?? TYPESAFE_GUIDE).agentModel === 'route' ? { [ROUTE]: routeQuestion(ask.language, field, fable), ...briefQuestions(ask.language, field, fable, FLOOR_NOULS) } : briefQuestions(ask.language, field, fable)
  const questions: Record<string, Question> = {
    ...model,
    [EFFORT]: effortQuestion(effortInstructions(ask.language, field), ask),
  }
  // Asked of every model the person's words mention, offered or not: a model they name is used even when the table would never give it.
  const mentioned = mentionedModels(dispatch.user_message)
  for (const model of mentioned) questions[`${NAMED}.${model}`] = namedQuestion(model, ask.language, field)
  for (const model of mentioned) questions[`${BANNED}.${model}`] = bannedQuestion(model, ask.language, field)
  // Asked when the person's words may name an effort: one they ask for is used.
  if (mentionsEffort(dispatch.user_message)) questions[NAMED_EFFORT] = namedEffortQuestion(ask.language, field)
  return { part: shape.part ?? AGENT_PART, questions }
}

/** The person's words take at most this share of the state's budget; the brief has the rest. */
export const WORDS_SHARE = 1 / 3
/** A text cut to fit keeps this share of its budget for its end. */
const TAIL_SHARE = 0.3

/** The brief of one agent as the decision model reads it: secrets masked, the prompt cut to `tokens`. */
export function dispatchBrief(dispatch: Dispatch, tokens: number): Record<string, string> {
  const brief: Record<string, string> = {}
  const short = (text: string, budget: number) => clipToTokens(redactSecrets(text).replace(/\s+/g, ' ').trim(), budget, TAIL_SHARE)
  if (dispatch.description) brief.description = short(dispatch.description, 60)
  if (dispatch.agent_type) brief.agent_type = short(dispatch.agent_type, 30)
  if (dispatch.workflow_description) brief.workflow_description = short(dispatch.workflow_description, 200)
  if (dispatch.label) brief.label = short(dispatch.label, 60)
  const used = Object.values(brief).reduce((sum, text) => sum + estimateTokens(text) + 4, 0)
  brief.prompt = clipToTokens(redactSecrets(dispatch.prompt), Math.max(tokens - used, 100), TAIL_SHARE)
  return brief
}

/**
 * The state of a request about one agent: `{ brief, user_message }`, the
 * brief first (what every question is about), within `tokens` as it is sent
 * (`withinTokens`). The person's words take at most a third of the budget;
 * the brief has the rest; the conversation it was dispatched from
 * (`recent_context`), when there is one, fills what the two leave.
 */
export function dispatchState(dispatch: Dispatch, tokens: number): State {
  return withinTokens((budget) => {
    const words = dispatchWords(dispatch.user_message, budget)
    const state: State = {
      [BRIEF]: dispatchBrief(dispatch, budget - estimateTokens(words)),
      user_message: words,
      ...backgroundState(dispatch),
    }
    const recent = recentWithin(dispatch.recent_context ?? [], budget - estimateTokens(JSON.stringify(state)))
    return recent === '' ? state : { ...state, recent_context: recent }
  }, tokens)
}

/**
 * The state fields that carry the background the main agent works from: the problem summary, the unresolved count (while
 * it is above 0) and the reference reading. Read by the decision model, never with a hint (#41, #64); a field is left out
 * when it is absent.
 */
export function backgroundState(background: Pick<Dispatch, 'problem_summary' | 'unresolved_count' | 'reference_complexity'>): State {
  return {
    ...(background.problem_summary ? { [SUMMARY_FIELD]: background.problem_summary } : {}),
    ...(background.unresolved_count ? { [COUNT_FIELD]: background.unresolved_count } : {}),
    ...referenceField(background.reference_complexity),
  }
}

/** The person's words as a request about an agent (or a Workflow's agents) reads them: secrets masked, at most a third of `tokens`. */
export function dispatchWords(text: string, tokens: number): string {
  return clipToTokens(redactSecrets(text), Math.floor(tokens * WORDS_SHARE), TAIL_SHARE)
}

/** What decides an agent's model and effort from the answers: the models the table or the route may give, how the questions were asked, and the decision model's guide (its bars, its way to the model). */
export type DispatchSettings = DispatchShape

/** What one Noul about the brief read as: its probability (null: not answered) and its verdict (a missing answer reads as no). */
export type SignRead = { p: number | null; verdict: Verdict }

/** The rows of the model table, in the order they are tried (the header above). */
export type ModelRow = '1' | '2' | '3' | '3b' | '4' | '5'

/**
 * Where the model came from: the person named it (row 1), the table gave it (the main agent named none, or ruled out by
 * the person, or the table's was stronger: `requested.outcome` upgraded), the route gave it (d1-ultra, the same cases), the
 * main agent's pick was kept, or nothing applies (no usable answer: the engine's choice stands).
 */
export type ModelSource = 'user' | 'table' | 'route' | 'requested' | 'none'

/** The table's reading: its row, the model the row gives (`wanted`), the model after any the person ruled out (null: none is left), the Nouls that settled the row. */
export type TableRead = { row: ModelRow; wanted: AgentModel; model: AgentModel | null; why: BriefNoul[] }

/**
 * The route's reading (d1-ultra): its top tier and that tier's probability, its confidence, whether it fell back to the
 * strongest model allowed (confidence below the guide's bar), the model it asks for (`wanted`: the top tier's, or the
 * strongest offered on a fall back), and the model after any the person ruled out (null: none is left). `replaced`: the tier
 * that stood in for one ruled out (the allowed tier rated highest); null when none had to.
 */
export type RouteRead = {
  tier: RouteTier
  p: number
  confidence: number | null
  below: number
  fellBack: boolean
  wanted: AgentModel
  model: AgentModel | null
  replaced: RouteTier | null
}

/** The floors that may lift an agent's decided effort. */
export type AgentFloor = 'stakes' | 'cause-unknown' | 'unsure' | 'model-floor'

type Fields = Record<string, string | number | boolean | null>

/**
 * One step of an agent's rules, in the order they run: the Nouls about the brief (`lookup-signs`, `careful-signs`), the
 * table's row (`model-table`), the main agent's pick against it (`main-pick`), the effort's base (decision/effort.ts), its
 * floors and the model's floor, and a named effort over all of them. Data only: the card words the steps and never works
 * them out again (ADR 0004).
 */
export type AgentStep =
  | EffortStep
  | ({ rule: 'lookup-signs' | 'careful-signs' | 'model-table' | 'route' | 'named-model' | 'main-pick'; applied: boolean } & Fields)
  | ({ rule: 'stakes' | 'cause-unknown' | 'unsure'; applied: boolean; level: Effort; floor: Effort | null } & Fields)
  | { rule: 'named-effort'; applied: true; level: Effort; decided: Effort | null }

export type DispatchDecision = {
  /** The model to start the agent on; null: no usable answer and no pick to keep, the engine's choice stands. */
  model: AgentModel | null
  /** The effort of the agent's steps; null without a usable answer. */
  effort: Effort | null
  source: ModelSource
  /** The model table's reading (row 1 when the person named the model, also with the route); null without a usable answer about the brief, or with the route. */
  table: TableRead | null
  /** The route's reading (d1-ultra); null with the table, when the person named the model, or without a usable answer. */
  route: RouteRead | null
  /**
   * The main agent's pick (a Workflow call's: the script's) against the table: kept, or upgraded to the table's stronger
   * model. Null when it named none, or its pick does not count (the person named a model, or ruled the pick out).
   */
  requested: { model: AgentModel; outcome: 'kept' | 'upgraded' } | null
  /** The models the person ruled out for this agent. */
  banned: AgentModel[]
  /** Each Noul about the brief that was asked, by id. */
  signs: Partial<Record<BriefNoul, SignRead>>
  /** The effort answer's level probabilities, also when the person named the effort; null without a usable answer. */
  reading: EffortReading | null
  /** False when neither a Noul about the brief nor the effort question got a usable answer: a failed request. */
  answered: boolean
  /** The effort the person asked for, as the decision model read their words; null when none. */
  namedEffort: Effort | null
  /** Whose the effort is: the person's (`user`, the one they named), the rules' (`decided`), or none (no usable answer). */
  effortSource: 'user' | 'decided' | 'none'
  /** The base level a floor lifted the decided effort from, and the floor that lifted it last; unset when none did, or the person named the effort. */
  lifted?: { from: Effort; by: AgentFloor }
  /** The rules' working, step by step. */
  steps: AgentStep[]
}

/** A model's place among the models, weakest first. */
function strength(model: AgentModel): number {
  return AGENT_MODELS.indexOf(model)
}

/**
 * The table's row for the brief's Nouls, rows 2 to 5 (row 1, a model the person named, is read before it), with the model
 * the row gives and the Nouls that settled it. `fable`: fable is offered (agentFable), so row 2 can match.
 */
export function tableRow(signs: Readonly<Partial<Record<BriefNoul, SignRead>>>, fable: boolean): { row: Exclude<ModelRow, '1'>; model: AgentModel; why: BriefNoul[] } {
  const verdict = (id: BriefNoul): Verdict => signs[id]?.verdict ?? 'no'
  if (fable && verdict(FRONTIER) === 'yes') return { row: '2', model: 'fable', why: [FRONTIER] }
  const yes = CAREFUL.filter((id) => verdict(id) === 'yes')
  if (yes.length > 0) return { row: '3', model: 'opus', why: yes }
  const band = CAREFUL.filter((id) => verdict(id) === 'band')
  if (band.length > 0) return { row: '3b', model: 'sonnet', why: band }
  // The cheaper model only on answers that say so: a missing one makes no haiku.
  const said = (id: BriefNoul): Verdict | null => (signs[id]?.p ?? null) === null ? null : verdict(id)
  if (said(WRITES) === 'no' && said(FEW_STEPS) === 'yes' && said(REPORT_ONLY) === 'yes') return { row: '4', model: 'haiku', why: [...LOOKUP] }
  return { row: '5', model: 'sonnet', why: [] }
}

/** `wanted` when it is allowed; else the nearest allowed model, the next stronger first, else the next weaker; null when none is allowed. */
export function nearestAllowed(wanted: AgentModel, allowed: readonly AgentModel[]): AgentModel | null {
  if (allowed.includes(wanted)) return wanted
  const at = strength(wanted)
  const stronger = AGENT_MODELS.find((model) => strength(model) > at && allowed.includes(model))
  const weaker = [...AGENT_MODELS].reverse().find((model) => strength(model) < at && allowed.includes(model))
  return stronger ?? weaker ?? null
}

/** A probability as the steps keep it (three places); null stays null. */
function kept(p: number | null | undefined): number | null {
  return p === null || p === undefined ? null : Math.round(p * 1000) / 1000
}

/** The Nouls `ids` as one step's fields: each one's probability under its key, its verdict under `<key>Verdict`, and the bars. */
function signFields(ids: readonly BriefNoul[], signs: Readonly<Partial<Record<BriefNoul, SignRead>>>, bars: NoulBars): Fields {
  const fields: Fields = {}
  for (const id of ids) {
    const sign = signs[id]
    if (sign === undefined) continue
    fields[SIGNS[id].key] = kept(sign.p)
    fields[`${SIGNS[id].key}Verdict`] = sign.verdict
  }
  return { ...fields, yes: bars.yes, no: bars.no, inclusive: bars.inclusive }
}

/**
 * The route's reading of its answer (d1-ultra, ADR 0017), among the tiers whose model is `offered`: the top tier; on a
 * confidence below `below`, the strongest model allowed (Liquid's "fall back to the most capable tier"); a tier whose model
 * is not `allowed` (the person ruled it out) gives way to the allowed tier rated highest. Null without a usable answer.
 */
export function readRoute(answer: Answer | undefined, offered: readonly AgentModel[], allowed: readonly AgentModel[], below: number): RouteRead | null {
  if (answer === undefined || answer.type !== 'choice') return null
  const tiers = ROUTE_TIERS.filter((tier) => offered.includes(TIER_MODELS[tier]))
  const sum = tiers.reduce((total, tier) => total + (answer.probabilities[tier] ?? 0), 0)
  if (!(sum > 0)) return null
  const share = (tier: RouteTier) => (answer.probabilities[tier] ?? 0) / sum
  // The highest share; on a tie the stronger tier (a tie is no reason to go cheaper).
  const best = (among: readonly RouteTier[]) => among.reduce<RouteTier | null>((top, tier) => (top === null || share(tier) >= share(top) ? tier : top), null)
  const tier = best(tiers) as RouteTier
  const confidence = answer.confidence
  const fellBack = confidence !== null && confidence < below
  const strongest = (models: readonly AgentModel[]) => [...AGENT_MODELS].reverse().find((model) => models.includes(model)) ?? null
  if (fellBack) {
    const wanted = strongest(offered) as AgentModel
    return { tier, p: share(tier), confidence, below, fellBack, wanted, model: strongest(allowed.filter((model) => offered.includes(model))), replaced: null }
  }
  const wanted = TIER_MODELS[tier]
  if (allowed.includes(wanted)) return { tier, p: share(tier), confidence, below, fellBack, wanted, model: wanted, replaced: null }
  const replaced = best(tiers.filter((one) => allowed.includes(TIER_MODELS[one])))
  return { tier, p: share(tier), confidence, below, fellBack, wanted, model: replaced === null ? null : TIER_MODELS[replaced], replaced }
}

/**
 * The model and effort for one agent, from its part's answers (by their ids within the part, as `answersFor` gives them),
 * by the rules in the header: the person's named model, else the table on the Nouls about the brief, a model they ruled
 * out skipped, the main agent's pick raised and never lowered; the effort they named, else the base lifted by the floors.
 */
export function decideDispatch(answers: Readonly<Record<string, Answer>>, dispatch: Dispatch, settings: DispatchSettings): DispatchDecision {
  const guide = settings.guide ?? TYPESAFE_GUIDE
  const bars = guide.noul
  const routed = guide.agentModel === 'route'
  const offered = settings.models ?? DEFAULT_AGENT_MODELS
  const fable = offered.includes('fable')
  const named = mostLikely(answers, NAMED, bars)
  const banned = AGENT_MODELS.filter((model) => isYes(readNoul(answers[`${BANNED}.${model}`]) ?? 0, bars) && model !== named)
  const allowed = offered.filter((model) => !banned.includes(model))
  const signs: Partial<Record<BriefNoul, SignRead>> = {}
  for (const id of routed ? FLOOR_NOULS : BRIEF_NOULS) {
    if (id === FRONTIER && !fable) continue
    const p = readNoul(answers[id])
    signs[id] = { p, verdict: verdictOrNo(p, bars) }
  }
  const heardSigns = Object.values(signs).some((sign) => sign.p !== null)
  // The table (Jev, pplx) on the Nouls about the brief, or the route (d1-ultra) on its own answer; neither when the person named the model.
  const row = !routed && heardSigns ? tableRow(signs, fable) : null
  const route = routed && named === null ? readRoute(answers[ROUTE], offered, allowed, guide.routeFallbackBelow) : null
  const table: TableRead | null =
    named !== null ? { row: '1', wanted: named, model: named, why: [] } : row === null ? null : { row: row.row, wanted: row.model, model: nearestAllowed(row.model, allowed), why: row.why }
  const heard = heardSigns || route !== null
  // The main agent's pick counts unless the person ruled it out; it is kept unless the rules' model is stronger.
  const asked = modelFamily(dispatch.requested_model)
  const pick = asked !== null && !banned.includes(asked) ? asked : null
  const given = route?.model ?? table?.model ?? null
  let model: AgentModel | null = null
  let source: ModelSource = 'none'
  let requested: DispatchDecision['requested'] = null
  if (named !== null) {
    model = named
    source = 'user'
  } else if (pick !== null && (given === null || strength(given) <= strength(pick))) {
    model = pick
    source = 'requested'
    requested = { model: pick, outcome: 'kept' }
  } else if (given !== null) {
    model = given
    source = routed ? 'route' : 'table'
    if (pick !== null) requested = { model: pick, outcome: 'upgraded' }
  }

  const steps: AgentStep[] = []
  if (heardSigns && !routed) {
    const at = table?.row
    steps.push({ rule: 'lookup-signs', applied: at === '4', ...signFields(LOOKUP, signs, bars) })
    steps.push({ rule: 'careful-signs', applied: at === '2' || at === '3' || at === '3b', ...signFields([...CAREFUL, FRONTIER], signs, bars) })
  }
  if (routed && named !== null) steps.push({ rule: 'named-model', applied: true, model: named })
  else if (table !== null) {
    steps.push({ rule: 'model-table', applied: true, row: table.row, wanted: table.wanted, model: table.model, why: table.why.map((id) => SIGNS[id].key).join(',') || null, banned: banned.join(',') || null })
  }
  if (route !== null) {
    steps.push({
      rule: 'route',
      applied: true,
      tier: route.tier,
      p: kept(route.p),
      confidence: kept(route.confidence),
      below: route.below,
      fellBack: route.fellBack,
      wanted: route.wanted,
      model: route.model,
      replaced: route.replaced,
      banned: banned.join(',') || null,
    })
  }
  if (requested !== null) {
    steps.push({ rule: 'main-pick', applied: true, asker: dispatch.kind === 'workflow' ? 'script' : 'main', requested: requested.model, table: given, by: routed ? 'route' : 'table', model, outcome: requested.outcome })
  }

  // The effort: the base, then each floor in order; the person's named effort over the result, untouched by any floor.
  const reading = readEffort(answers[EFFORT])
  const namedEffort = readNamedEffort(answers[NAMED_EFFORT], bars)
  let decided: Effort | null = null
  let lifted: DispatchDecision['lifted']
  if (reading !== null) {
    const base = traceEffort(reading, {}, guide.scoreUnsure)
    steps.push(...base.steps)
    let level = base.effort
    let by: AgentFloor | null = null
    const floorStep = (rule: 'stakes' | 'cause-unknown' | 'unsure', floor: Effort | null, fields: Fields) => {
      const after = higherEffort(level, floor) as Effort
      if (after !== level) by = rule
      steps.push({ rule, applied: after !== level, level: after, floor, ...fields })
      level = after
    }
    const verdict = (id: BriefNoul): Verdict => signs[id]?.verdict ?? 'no'
    const held = { yes: bars.yes, no: bars.no, inclusive: bars.inclusive }
    floorStep('stakes', stakesFloor(verdict(STAKES_UNDO), verdict(STAKES_LIVE), verdict(STAKES_ACCESS)), {
      undo: kept(signs[STAKES_UNDO]?.p),
      undoVerdict: verdict(STAKES_UNDO),
      live: kept(signs[STAKES_LIVE]?.p),
      liveVerdict: verdict(STAKES_LIVE),
      access: kept(signs[STAKES_ACCESS]?.p),
      accessVerdict: verdict(STAKES_ACCESS),
      ...held,
    })
    floorStep('cause-unknown', causeFloor(verdict(CAUSE_UNKNOWN)), { p: kept(signs[CAUSE_UNKNOWN]?.p), verdict: verdict(CAUSE_UNKNOWN), ...held })
    // Row 3b's max: the table's only (the route has no such row).
    if (!routed) floorStep('unsure', table?.row === '3b' ? 'max' : null, { row: table?.row ?? null })
    const floor = effortFloor(model)
    const from = level
    level = higherEffort(level, floor) as Effort
    if (level !== from) by = 'model-floor'
    steps.push({ rule: 'model-floor', applied: level !== from, level, from, model: model ?? 'none', floor })
    decided = level
    if (by !== null && namedEffort === null && level !== base.effort) lifted = { from: base.effort, by }
  }
  if (namedEffort !== null) steps.push({ rule: 'named-effort', applied: true, level: namedEffort, decided })
  const effort = namedEffort ?? decided
  return {
    model,
    effort,
    source,
    table,
    route,
    requested,
    banned,
    signs,
    reading,
    answered: heard || reading !== null,
    namedEffort,
    effortSource: effort === null ? 'none' : namedEffort !== null ? 'user' : 'decided',
    ...(lifted === undefined ? {} : { lifted }),
    steps,
  }
}

/**
 * The least effort an agent on `model` goes at; null for none (haiku and fable
 * have no floor: Haiku 5.5 takes an effort, any level of it). Raising is easy, lowering is hard: on AA's
 * Intelligence Index (v4.3.2) Sonnet 5.5 scores 36 at low, 41 at medium, 47 at
 * high (Terminal-Bench 20.7%, 29.8%, 43.9%) and Opus 5.5 42, 51, 54
 * (Terminal-Bench 31.3%, 52.5%, 56.6%): both lose most below medium, so both
 * go at medium at least. (0.2.2 first held sonnet at high; on the eval the
 * dataset's gold, the cheapest level that does the work, was passed by 10
 * points more often, results/subagent/2026-10-05-jev-aa-routing.json, and the
 * floor went down to medium.) Not settings: set from the AA numbers
 * (docs/research/aa-benchmarks-2026-10.md).
 */
export function effortFloor(model: AgentModel | null): Effort | null {
  return model === 'sonnet' || model === 'opus' ? 'medium' : null
}

/**
 * The effort the person asks for: the level the named-effort answer favours,
 * when it beats "none" and its probability reaches the guide's yes bar (as a
 * Noul's would: TypeSafe's 0.7, Liquid's above 0.8); null otherwise (no answer,
 * none asked for, or too unsure).
 */
function readNamedEffort(answer: Answer | undefined, bars: NoulBars): Effort | null {
  if (answer === undefined || answer.type !== 'choice') return null
  const sum = [NO_EFFORT, ...EFFORTS].reduce((total, name) => total + (answer.probabilities[name] ?? 0), 0)
  if (!(sum > 0)) return null
  let best: Effort | null = null
  let top = 0
  for (const level of EFFORTS) {
    const p = (answer.probabilities[level] ?? 0) / sum
    if (p > top) {
      best = level
      top = p
    }
  }
  const none = (answer.probabilities[NO_EFFORT] ?? 0) / sum
  return best !== null && isYes(top, bars) && top > none ? best : null
}

/**
 * The person's own terms for one agent's work, as the decision model read
 * their words: the model they named (点名) and the effort they named, the
 * models they ruled out (排除). Kept in the agent's plan (core/plans.ts), so
 * that whatever changes its model or effort later keeps to them.
 */
export type Terms = {
  /** The model they named for the work; null for none. */
  model: AgentModel | null
  /** The effort they named for the work, whether or not its model takes one; null for none. */
  effort: Effort | null
  /** The models they ruled out for the work. */
  banned: AgentModel[]
}

/** The terms a decision read from the person's words; null when they named nothing and ruled nothing out. */
export function termsOf(decision: DispatchDecision): Terms | null {
  const model = decision.source === 'user' ? decision.model : null
  const effort = decision.namedEffort
  if (model === null && effort === null && decision.banned.length === 0) return null
  return { model, effort, banned: [...decision.banned] }
}

/**
 * What the decision log keeps of a decision beyond its words, for the card that shows why: the effort levels'
 * probabilities and the rules' working. Each is left out when the decision has none.
 */
export function dispatchEvidence(decision: DispatchDecision): { probs?: Record<Effort, number>; trace?: AgentStep[] } {
  return {
    ...(decision.reading === null ? {} : { probs: probsOf(decision.reading) }),
    ...(decision.steps.length === 0 ? {} : { trace: decision.steps }),
  }
}

/** What each floor is called in the decision log (Chinese: the person's words). */
const FLOOR_WORDS: Readonly<Record<AgentFloor, string>> = {
  stakes: '出错代价',
  'cause-unknown': '原因未知',
  unsure: '拿不准要不要 opus（第 3b 行）',
  'model-floor': '模型下限',
}

/** The route in the log's words: `路由 powerful 62%（置信度 0.71）→ opus`, `路由拿不准（置信度 0.43 < 0.5）→ 最强的 opus`, and what stood in for a model ruled out. */
function routeWords(route: RouteRead): string {
  const confidence = route.confidence === null ? '没有' : route.confidence.toFixed(2)
  if (route.fellBack) {
    const skipped = route.model === route.wanted ? '' : route.model === null ? `；${route.wanted} 被你排除，没有别的可用` : `；${route.wanted} 被你排除，取次强的 ${route.model}`
    return `路由拿不准（置信度 ${confidence} < ${route.below}）→ 最强的 ${route.wanted}${skipped}`
  }
  const head = `路由 ${route.tier} ${Math.round(route.p * 100)}%（置信度 ${confidence}）→ ${route.wanted}`
  if (route.model === route.wanted) return head
  return route.model === null || route.replaced === null ? `${head}；${route.wanted} 被你排除，没有别的可用` : `${head}；${route.wanted} 被你排除，取可用的里概率最高的 ${route.replaced}（${route.model}）`
}

/** A table row in the log's words: `模型表第 3 行（原因未知、方案未定）→ opus`, and what stood in for a model ruled out. */
function rowWords(table: TableRead): string {
  if (table.row === '1') return `你在消息里点名了 ${table.wanted}`
  const why = table.why.length === 0 ? '' : `（${table.why.map((id) => SIGNS[id].words).join('、')}${table.row === '3b' ? '拿不准' : ''}）`
  const effort = table.row === '3b' ? '，effort 至少 max' : ''
  const skipped = table.model === table.wanted ? '' : table.model === null ? `；${table.wanted} 被你排除，没有别的可用` : `；${table.wanted} 被你排除，取最近的 ${table.model}`
  return `模型表第 ${table.row} 行${why} → ${table.wanted}${effort}${skipped}`
}

/**
 * Why an agent goes out as it does, for the decision log (Chinese: the person's
 * words): whose model it is (`asker` is whose pick a kept one was: "主 agent
 * 指定的" for a dispatched agent, "脚本指定的" for a Workflow's), the table's
 * row, what was ruled out, how the effort was lifted, the effort answer.
 */
export function dispatchReason(decision: DispatchDecision, requested: string | null, asker: string): string {
  const parts: string[] = []
  const { table } = decision
  const { route } = decision
  const rules = route !== null ? routeWords(route) : table !== null ? rowWords(table) : null
  if (decision.source === 'user') parts.push('你在消息里点名了模型')
  else if (decision.source === 'requested') parts.push(`沿用${asker} ${requested}${rules === null ? '（决策模型没回答关于任务的题）' : `（${rules}，不比它强）`}`)
  else if ((decision.source === 'table' || decision.source === 'route') && rules !== null) {
    parts.push(rules)
    if (decision.requested?.outcome === 'upgraded') parts.push(`${asker} ${decision.requested.model} 升级到 ${decision.model}`)
  } else parts.push('沿用引擎的模型')
  if (decision.banned.length > 0) parts.push(`排除了 ${decision.banned.join('、')}`)
  if (decision.lifted !== undefined && decision.effort !== null) parts.push(`effort 从 ${decision.lifted.from} 抬到 ${decision.effort}（${FLOOR_WORDS[decision.lifted.by]}）`)
  if (decision.namedEffort !== null) parts.push(`你在消息里点名了 effort（${decision.namedEffort}）`)
  if (decision.reading !== null) parts.push(`effort 概率 ${levelsText(decision.reading)}`)
  return parts.join('；')
}

/** What each row says of the work, for the main agent (English: the model's words). */
const ROW_WHY: Readonly<Record<ModelRow, string>> = {
  '1': 'the model the user named',
  '2': 'a rigorous proof, or a new algorithm or architecture with no known answer',
  '3': 'work that needs careful judgment',
  '3b': 'work that may need careful judgment',
  '4': 'a read-only lookup of a step or two whose result is only reported',
  '5': 'ordinary work',
}

/** How the table read the brief, for the main agent: `it read the brief as work that needs careful judgment (cause_unknown), which gets opus`. */
export function tableWhy(table: TableRead): string {
  const why = table.why.length === 0 ? '' : ` (${table.why.join(', ')})`
  const skipped = table.model === table.wanted ? '' : `; the user ruled ${table.wanted} out, so ${table.model ?? 'no model is left'}`
  return `its rules read the brief as ${ROW_WHY[table.row]}${why}, which gets ${table.wanted}${table.row === '3b' ? ' at max effort' : ''}${skipped}`
}

/** What each tier says of the work, for the main agent (English: the model's words). */
const TIER_WHY: Readonly<Record<RouteTier, string>> = {
  fast: 'gathering or listing things with nothing to decide',
  standard: 'ordinary software work with a known approach',
  powerful: 'work where a mistake is costly or the answer is not known yet',
  frontier: 'a rigorous proof, or a new algorithm or architecture with no known answer',
}

/** How the route read the brief, for the main agent: `its router rated the brief as ... (powerful, 0.62), which gets opus`. */
export function routeWhy(route: RouteRead): string {
  const confidence = route.confidence === null ? 'none' : route.confidence.toFixed(2)
  const skipped = route.model === route.wanted ? '' : `; the user ruled ${route.wanted} out, so ${route.model ?? 'no model is left'}`
  if (route.fellBack) return `its router was unsure (confidence ${confidence}, below ${route.below}), so it took the strongest model, ${route.wanted}${skipped}`
  return `its router rated the brief as ${TIER_WHY[route.tier]} (${route.tier}, ${route.p.toFixed(2)}), which gets ${route.wanted}${skipped}`
}

/** How the rules read the brief, for the main agent: the route's reading (d1-ultra), else the table's; null with neither. */
export function rulesWhy(decision: Pick<DispatchDecision, 'table' | 'route'>): string | null {
  return decision.route !== null ? routeWhy(decision.route) : decision.table !== null ? tableWhy(decision.table) : null
}

/** Why a floor lifted the effort, for the main agent. */
export function floorWhy(by: AgentFloor, model: string): string {
  if (by === 'stakes') return 'a mistake in this work would be costly'
  if (by === 'cause-unknown') return 'the work includes finding a cause nobody has named'
  if (by === 'unsure') return 'it is unclear whether the work needs careful judgment'
  return `the floor for ${model}`
}

/**
 * What the main agent reads after the Agent tool's result (#34; the model's words, English): the model and the
 * effort its agent started with and whose choice the model was, or that the agent was not routed and why.
 * `started` is the model the engine reports it started on (an alias or an id); `requested` the main agent's pick
 * (by family).
 */
export type DispatchNote =
  | { routed: true; decision: DispatchDecision; started: string; requested: AgentModel | null }
  | { routed: false; started: string; why: { failure: Failure; backend: string } | 'off' }

export function dispatchNote(note: DispatchNote): string {
  const head = "Dispatch Pilot (the user's routing plugin)"
  const model = modelFamily(note.started) ?? note.started
  if (!note.routed) {
    const why = note.why === 'off' ? 'has its dispatched-agents feature switched off, so it did not route this agent' : `did not route this agent (${failureText(note.why.backend, note.why.failure)})`
    return `${head} ${why}: it started as you asked, on ${model}, at the session's effort.`
  }
  const { decision } = note
  const on = decision.effort === null ? `on ${model}` : `on ${model} at effort ${decision.effort}`
  const policy = "This is the user's routing policy: a model the user names is used as named, and a model you ask for is kept unless the work calls for a stronger one."
  return `${head} started this agent ${on}. Model: ${modelWhose(note)}. Effort: ${effortWhose(decision, model)}. ${policy}`
}

/** Whose choice an agent's model was, for the main agent. */
function modelWhose({ decision, requested }: Extract<DispatchNote, { routed: true }>): string {
  const why = rulesWhy(decision)
  const given = decision.route?.model ?? decision.table?.model ?? null
  if (decision.source === 'user') return 'the user named it'
  if (decision.source === 'requested') return why === null || given === requested ? `kept the ${requested} you asked for` : `kept the ${requested} you asked for (${why}, which is not stronger)`
  if (decision.source === 'none' || why === null) return "the engine's"
  if (decision.requested?.outcome === 'upgraded') return `raised from the ${requested} you asked for: ${why}`
  if (requested !== null && decision.banned.includes(requested)) return `the user ruled out the ${requested} you asked for; ${why}`
  return why
}

/** Whose choice an agent's effort was, for the main agent. */
function effortWhose(decision: DispatchDecision, model: string): string {
  if (decision.effort === null) return "the session's"
  if (decision.effortSource === 'user') return 'the user named it'
  if (decision.lifted !== undefined) return `${decision.lifted.from} lifted to ${decision.effort}, as ${floorWhy(decision.lifted.by, model)}`
  return 'chosen by its decision model'
}

/** The model whose `<prefix>.<model>` yes/no answer is highest and reads yes at `bars`; null when none does. */
function mostLikely(answers: Readonly<Record<string, Answer>>, prefix: string, bars: NoulBars): AgentModel | null {
  let best: AgentModel | null = null
  let top = 0
  for (const model of AGENT_MODELS) {
    const p = readNoul(answers[`${prefix}.${model}`])
    if (p !== null && isYes(p, bars) && (best === null || p > top)) {
      best = model
      top = p
    }
  }
  return best
}

/** The model family an alias or id names (`claude-sonnet-5-5` is sonnet); null for none or an unknown one. */
export function modelFamily(model: string | null | undefined): AgentModel | null {
  if (!model) return null
  const lower = model.toLowerCase()
  return AGENT_MODELS.find((family) => lower.includes(family)) ?? null
}
