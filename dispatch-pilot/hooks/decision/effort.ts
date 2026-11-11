// The questions of a message's effort part, and how the effort question's answer becomes one of Claude Code's five
// effort levels (ADR 0014).
//
// Pure (see system-one.ts). Written to TypeSafe's guide (docs.typesafe.ai: judgments from the model, decisions in code).
// The effort question is a Score that measures one thing only, how much step-by-step reasoning the work needs: each level
// describes a situation, never a degree, and the model never sees a level's name or number. What used to sit in its top
// level and is not reasoning (a failure that resisted earlier attempts, a mistake that is costly and hard to undo) is asked
// on its own: the stakes and the unknown cause below are yes/no questions (Nouls), the failures are facts the code keeps,
// and decision/message-effort.ts turns the answers into floors. All of this part's wording is here; the questions about
// the unresolved problem are in decision/unresolved.ts, the one about the person's lasting rules in decision/constraints.ts.

import { TYPESAFE_GUIDE, type ScoreUnsure } from './guides.ts'
import type { Answer, Part, Question } from './system-one.ts'

/** Claude Code's effort levels, cheapest first: index i is level i of the question. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

/** The language the questions are written in; the state keeps the person's own words either way. */
export type Language = 'en' | 'zh'
/** A five-level Score (lowest first) or a five-option Choice named low .. max. */
export type Primitive = 'score' | 'choice'
/** How effort is asked. Both are eval variables; English and a Score are what the mod sends (TypeSafe: English is Jev's best language). */
export type EffortAsk = { language: Language; primitive: Primitive }
export const DEFAULT_ASK: EffortAsk = { language: 'en', primitive: 'score' }

/** The message's effort part's name and its effort question's id: `effort.level` in the request. */
export const EFFORT_PART = 'effort'
export const LEVEL = 'level'
/** The ids of the stakes and the unknown cause in the effort part: `effort.stakes.undo` and so on. */
export const STAKES_UNDO = 'stakes.undo'
export const STAKES_LIVE = 'stakes.live'
export const STAKES_ACCESS = 'stakes.access'
export const CAUSE_UNKNOWN = 'cause_unknown'
export const STAKES = [STAKES_UNDO, STAKES_LIVE, STAKES_ACCESS] as const

/** One description per level, lowest first: what the work is, never what it risks or what happened before. */
const LEVELS: Record<Language, readonly string[]> = {
  en: [
    'A short answer from what is already known (a fact, a yes or no, a preference), or mechanical work with nothing to work out: a lookup, a single command, a rename or find-and-replace (even across many files), a search that lists what it finds, formatting, a one-line change.',
    'An ordinary, well-specified change to one or a few files, a direct question about code already in view, an explanation or advice given in words whatever its topic, or tests for a small piece of code whose cases are given.',
    'A change across several files that needs working out (moving or splitting code among them counts), a bug whose cause is described but has to be traced, tests whose cases or setup have to be worked out, or reviewing a diff or a short piece of code with care.',
    'Design across several components, a bug whose cause is unknown, a refactor that changes behaviour or interfaces many dependents rely on, or work that depends on careful reasoning about concurrency, performance or failure modes.',
    'Novel architecture, a proof, a hard concurrency problem, or an audit of the security or data integrity of a whole mechanism, reasoned through step by step.',
  ],
  zh: [
    '凭已知信息就能给出的简短回答（一个事实、是或否、一个偏好），或没有需要想清楚之处的机械性工作：查一个东西、执行一条命令、重命名或查找替换（即使跨很多文件）、列出搜索结果、格式化、改一行。',
    '对一个或几个文件做常规、需求明确的修改，针对眼前代码的直接提问，用文字给出的解释或建议（不论话题），或给一小段代码写用例已经给定的测试。',
    '跨多个文件、需要想清楚的修改（在文件之间搬动或拆分代码也算），原因已经描述但仍需追查的 bug，用例或准备工作需要想清楚的测试，或仔细审查一份 diff 或一小段代码。',
    '跨多个组件的设计，原因未知的 bug，改变很多依赖方所依赖的行为或接口的重构，或要靠仔细推敲并发、性能或故障模式才能做对的工作。',
    '全新的架构、证明、疑难的并发问题，或对一整套机制的安全或数据完整性做审计，要一步步推敲。',
  ],
}

/** The effort question beside a message; the state is `{ user_message, recent_context, ... }`. */
const TURN_START: Record<Language, Readonly<Record<string, string>>> = {
  en: {
    question: 'How much step-by-step reasoning does the work that `user_message` asks for need, given `recent_context`?',
    work: 'The work is everything the assistant does for `user_message` until it next stops and waits for the person.',
    rate: 'Rate the work the request asks for, not how important its topic sounds. Advice or an explanation given in words, even about architecture or security, is not design work.',
    short_replies:
      'When `user_message` only approves, continues or picks an option (such as "go ahead", "1", "继续"), rate the work it approves, as described at the end of `recent_context`.',
  },
  zh: {
    问题: '结合 `recent_context`，完成 `user_message` 所要求的工作需要多少逐步推理？',
    工作: '这项工作是助手为 `user_message` 做的全部事情，直到它下次停下来等用户。',
    评什么: '评的是请求要做的工作本身，而不是话题听起来有多重要。用文字给出的建议或解释，即使涉及架构或安全，也不算设计工作。',
    简短回复: '如果 `user_message` 只是同意、让继续或选一个选项（例如“go ahead”“1”“继续”），按它所同意的那项工作来评；那项工作写在 `recent_context` 的末尾。',
  },
}

/** An effort question with the given instructions, asked as `ask` says; the levels are the same in every variant. */
export function effortQuestion(instructions: Readonly<Record<string, string>>, ask: EffortAsk): Question {
  const levels = LEVELS[ask.language]
  if (ask.primitive === 'choice') {
    return { type: 'choice', instructions, criteria: Object.fromEntries(EFFORTS.map((name, i) => [name, levels[i] ?? null])) }
  }
  return { type: 'score', instructions, criteria: levels }
}

/** What the state of the request holds beyond `user_message` and `recent_context`, for the questions that read it. */
export type StateHas = { constraints?: boolean; lastTurn?: boolean }

type NoulWords = { question: string; reads: string; extra?: (has: StateHas) => string | null; yes: string; no: string }

/**
 * The stakes and the unknown cause: one concrete judgment each, yes meaning the stake is there (TypeSafe: write each Noul so
 * that true is yes, its criteria concrete situations). Each names the fields it reads; the fields a state may not have are
 * named only when it has them (`extra`).
 */
const NOULS: Record<Language, Record<(typeof STAKES)[number] | typeof CAUSE_UNKNOWN, NoulWords>> = {
  en: {
    [STAKES_UNDO]: {
      question: 'Would a mistake in the work that `user_message` asks for be hard to undo, such as deleted data, a sent message, or a published release?',
      reads: 'Judge from `user_message` and `recent_context`.',
      extra: (has) => (has.constraints === true ? '`standing_constraints` holds rules the person set earlier, in their own words.' : null),
      yes: 'The assistant itself, in this work, deletes or overwrites data that is still needed (rewriting git history that others share counts), sends something to people or systems outside, publishes or deploys, or the person said the step cannot be rolled back.',
      no: 'The work only changes files that can be reverted, including code, configuration or a pipeline that would do such a thing later when someone runs it; or it reads, explains, reviews or plans; or what it deletes is throwaway (a temporary table, test data, build output).',
    },
    [STAKES_LIVE]: {
      question: 'Does the work that `user_message` asks for act on a live production system or on real money?',
      reads: 'Judge from `user_message` and `recent_context`.',
      extra: (has) => (has.constraints === true ? '`standing_constraints` holds rules the person set earlier, in their own words.' : null),
      yes: 'The assistant itself changes something on servers, databases or accounts that real users or payments depend on (a deploy, a restart, a migration, a write), or it moves or charges real money.',
      no: 'It runs locally, in tests, or on a staging or sandbox system; or it only reads from production (a setting, a log, a query that changes nothing); or it only edits files, even production configuration, that someone applies later.',
    },
    [STAKES_ACCESS]: {
      question: 'Does the work that `user_message` asks for change permissions, authentication, or secrets?',
      reads: 'Judge from `user_message` and `recent_context`.',
      extra: (has) => (has.constraints === true ? '`standing_constraints` holds rules the person set earlier, in their own words.' : null),
      yes: 'It changes who can access what: it edits roles, permissions, login or token handling, or it creates, rotates or exposes keys, passwords or other secrets.',
      no: 'It changes none of that. Reading, reviewing or explaining code about access is not a change to it, and neither is using a credential that is already set up.',
    },
    [CAUSE_UNKNOWN]: {
      question: 'Does the work that `user_message` asks for include finding the cause of a failure that `recent_context` has not already found?',
      reads: 'Judge from `user_message` and `recent_context`.',
      extra: (has) => (has.lastTurn === true ? "`last_turn` lists the tool calls that failed in the assistant's last turn." : null),
      yes: 'Something fails or misbehaves and nobody has said why yet: the work has to trace the cause.',
      no: 'There is no failure to explain; or its cause is already named in `recent_context` and the work is to fix it; or the person asks only for a set step (run a given command or search, collect or count what failed) and not for the reason.',
    },
  },
  zh: {
    [STAKES_UNDO]: {
      question: '`user_message` 所要求的工作一旦出错，是否难以挽回，比如删掉的数据、已经发出的消息、已经发布的版本？',
      reads: '根据 `user_message` 和 `recent_context` 判断。',
      extra: (has) => (has.constraints === true ? '`standing_constraints` 是用户早先定下的规矩，用户的原话。' : null),
      yes: '助手自己在这项工作里删除或覆盖还有用的数据（改写别人也在用的 git 历史也算）、向外部的人或系统发送东西、发布或部署，或者用户说过这一步不能回滚。',
      no: '这项工作只改动可以撤回的文件，包括以后有人运行时才会做这些事的代码、配置或流水线；或者只是阅读、解释、审查、规划；或者删掉的是用完即弃的东西（临时表、测试数据、构建产物）。',
    },
    [STAKES_LIVE]: {
      question: '`user_message` 所要求的工作是否作用在线上生产系统或真钱上？',
      reads: '根据 `user_message` 和 `recent_context` 判断。',
      extra: (has) => (has.constraints === true ? '`standing_constraints` 是用户早先定下的规矩，用户的原话。' : null),
      yes: '助手自己改动真实用户或付款依赖的服务器、数据库、账户上的东西（部署、重启、迁移、写入），或者转移、扣收真钱。',
      no: '它在本地、测试里、预发或沙箱系统上运行；或者只是从生产环境读东西（一个配置值、一份日志、一条不改任何东西的查询）；或者只改文件，即使是生产环境的配置，由别人之后去应用。',
    },
    [STAKES_ACCESS]: {
      question: '`user_message` 所要求的工作是否改动权限、认证或密钥？',
      reads: '根据 `user_message` 和 `recent_context` 判断。',
      extra: (has) => (has.constraints === true ? '`standing_constraints` 是用户早先定下的规矩，用户的原话。' : null),
      yes: '它会改变谁能访问什么：改角色、权限、登录或 token 处理，或者新建、轮换、暴露密钥、密码或其他 secret。',
      no: '这些它都不改。阅读、审查或解释和访问有关的代码不算改动，使用一个已经配好的凭证也不算。',
    },
    [CAUSE_UNKNOWN]: {
      question: '`user_message` 所要求的工作是否包括找出一个 `recent_context` 里还没找到原因的故障？',
      reads: '根据 `user_message` 和 `recent_context` 判断。',
      extra: (has) => (has.lastTurn === true ? '`last_turn` 列出了助手上一轮失败的工具调用。' : null),
      yes: '有东西出错或表现不对，而且还没有人说清原因：这项工作得追查原因。',
      no: '没有要解释的故障；或者原因已经写在 `recent_context` 里，要做的是修；或者用户只要一个定好的步骤（跑一条给定的命令或搜索、把出错的收集或统计出来），没有问原因。',
    },
  },
}

/** One of the Nouls above, as asked: the question, the fields it reads, true and false as situations. */
function noul(words: NoulWords, language: Language, has: StateHas): Question {
  const extra = words.extra?.(has) ?? null
  const key = language === 'zh' ? { question: '问题', reads: '依据' } : { question: 'question', reads: 'reads' }
  return {
    type: 'noul',
    instructions: { [key.question]: words.question, [key.reads]: extra === null ? words.reads : `${words.reads} ${extra}` },
    criteria: { true: words.yes, false: words.no },
  }
}

/** The stakes and the unknown cause, by id, asked in `language`, naming only the state fields `has` says are there. */
export function stakeQuestions(language: Language, has: StateHas = {}): Record<string, Question> {
  const words = NOULS[language]
  const ids: readonly ((typeof STAKES)[number] | typeof CAUSE_UNKNOWN)[] = [...STAKES, CAUSE_UNKNOWN]
  return Object.fromEntries(ids.map((id) => [id, noul(words[id], language, has)]))
}

/** The five level descriptions, lowest first, in `language`: the same wherever an effort is asked (a message, an agent, a running loop). */
export function effortLevels(language: Language): readonly string[] {
  return LEVELS[language]
}

/**
 * What a yes and a no are for each stake, in English: the mid-run stakes (decision/midrun.ts) ask about the work still ahead
 * and hold it to the same situations as a message's.
 */
export function stakeSituations(id: (typeof STAKES)[number]): { yes: string; no: string } {
  const { yes, no } = NOULS.en[id]
  return { yes, no }
}

/**
 * The part a message's decision request carries for the main agent's effort: `effort.level` and, unless `stakes` is false,
 * the stakes and the unknown cause. The questions about the unresolved problem and the person's rules join it in
 * decision/turn-start.ts.
 */
export function turnStartEffortPart(ask: Partial<EffortAsk> = {}, options: { stakes?: boolean; has?: StateHas } = {}): Part {
  const asked = { ...DEFAULT_ASK, ...ask }
  const level = { [LEVEL]: effortQuestion(TURN_START[asked.language], asked) }
  return { part: EFFORT_PART, questions: options.stakes === false ? level : { ...level, ...stakeQuestions(asked.language, options.has) } }
}

/** The probability of each level, lowest first (five numbers summing to 1), and the backend's confidence (on record only). */
export type EffortReading = { probabilities: readonly number[]; confidence: number | null }

/**
 * The level probabilities an effort answer gives: a Score's are keyed "0" .. "4", a Choice's by level name. Normalized, since
 * backends round them. Null when the answer is missing or puts no probability on any level.
 */
export function readEffort(answer: Answer | undefined): EffortReading | null {
  if (answer === undefined || answer.type === 'noul' || answer.type === 'box') return null
  const keys: readonly string[] = answer.type === 'score' ? EFFORTS.map((_, i) => String(i)) : EFFORTS
  const raw = keys.map((key) => answer.probabilities[key] ?? 0)
  const sum = raw.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return null
  return { probabilities: raw.map((p) => p / sum), confidence: answer.confidence }
}

/**
 * The probability a level two or more above the base needs for the answer to count as two-peaked (TypeSafe: a Score's
 * position can be pulled toward the middle and hide a second peak). TypeSafe's starting value for "not a no" (a Noul's 0.3),
 * not one of the eval's; Jev's and pplx's rule (decision/guides.ts). The Liquid models' answer has no such rule.
 */
export const SECOND_PEAK = TYPESAFE_GUIDE.scoreUnsure.rule === 'two-peaked' ? TYPESAFE_GUIDE.scoreUnsure.secondPeak : 0.3

/**
 * One step of the rules, in the order they run. `level` is the level after the step, `applied` whether the step changed or
 * decided anything (`position` always does). Data only: whoever draws the steps words them and never recomputes them (ADR 0004).
 * The steps of a message's floors are decision/message-effort.ts's.
 */
export type EffortStep =
  /** The base: the answer's probability-weighted position (0 to 4), rounded to the nearest level. */
  | { rule: 'position'; applied: true; level: Effort; position: number }
  /** A level `peak` two or more above the base had `p` ≥ `threshold`: the base went one level up. `peak` null: none did. (TypeSafe's rule.) */
  | { rule: 'two-peaked'; applied: boolean; level: Effort; peak: Effort | null; p: number; threshold: number }
  /** The agent's model has a floor (sonnet and opus: medium; `floor` null for none) and the level was under it. */
  | { rule: 'model-floor'; applied: boolean; level: Effort; from: Effort; model: string; floor: Effort | null }

/** The result of the rules and the steps that led to it (the last step's `level` is `effort`). */
export type EffortTrace = { effort: Effort; steps: EffortStep[] }

/** What lifts the base level afterwards: the model's floor (an agent's). Its step appears in the trace only when given. */
export type EffortLifts = {
  model?: { name: string; floor: Effort | null }
}

/** The answer's position: each level's index times its probability, summed (TypeSafe's `score`, worked out from the probabilities). */
export function positionOf(reading: EffortReading): number {
  return reading.probabilities.reduce((sum, p, i) => sum + i * p, 0)
}

/**
 * The base level of an effort answer (the decision model's guide, decision/guides.ts; none of it tuned on our evals): the
 * position rounded to the nearest level, half going up; then, on TypeSafe's guide (the default), one level higher when a level
 * two or more above that has at least `SECOND_PEAK`. Liquid's guide has no such rule (`none`): its "confidence below 0.5,
 * take the strongest" is its router's, and read onto the effort answer it put 13 to 18 in 100 messages a level too high
 * (effort-submit, ADR 0022). The model's floor lifts the level afterwards when `lifts` gives one (an agent's).
 */
export function traceEffort(reading: EffortReading, lifts: EffortLifts = {}, unsure: ScoreUnsure = TYPESAFE_GUIDE.scoreUnsure): EffortTrace {
  const last = EFFORTS.length - 1
  const name = (i: number): Effort => EFFORTS[i] as Effort
  const at = (i: number): number => reading.probabilities[i] ?? 0
  const position = positionOf(reading)
  let level = Math.min(Math.floor(position + 0.5), last)
  const steps: EffortStep[] = [{ rule: 'position', applied: true, level: name(level), position }]
  if (unsure.rule === 'two-peaked') {
    let peak: number | null = null
    for (let i = level + 2; i <= last; i++) if (at(i) >= unsure.secondPeak && (peak === null || at(i) > at(peak))) peak = i
    if (peak !== null) level = Math.min(level + 1, last)
    steps.push({ rule: 'two-peaked', applied: peak !== null, level: name(level), peak: peak === null ? null : name(peak), p: peak === null ? 0 : at(peak), threshold: unsure.secondPeak })
  }
  if (lifts.model !== undefined) {
    const from = level
    const floor = lifts.model.floor
    if (floor !== null && EFFORTS.indexOf(floor) > level) level = EFFORTS.indexOf(floor)
    steps.push({ rule: 'model-floor', applied: level !== from, level: name(level), from: name(from), model: lifts.model.name, floor })
  }
  return { effort: name(level), steps }
}

/** The base level alone (`traceEffort` without lifts). */
export function baseEffort(reading: EffortReading, unsure: ScoreUnsure = TYPESAFE_GUIDE.scoreUnsure): Effort {
  return traceEffort(reading, {}, unsure).effort
}

/** Every level's probability, as the decision log gives them: `low 0.00, medium 0.05, ...`. */
export function levelsText(reading: EffortReading): string {
  return EFFORTS.map((level, i) => `${level} ${(reading.probabilities[i] ?? 0).toFixed(2)}`).join(', ')
}

/** Every level's probability, by level, for the board's data. */
export function probsOf(reading: EffortReading): Record<Effort, number> {
  return Object.fromEntries(EFFORTS.map((level, i) => [level, reading.probabilities[i] ?? 0])) as Record<Effort, number>
}

/**
 * Every level's probability and the backend's confidence, as the decision log gives them: `概率 low 0.00, medium 0.05, ...；
 * 位置 1.40；置信度 0.80（只记录）`, with `note` before the confidence. `confidenceRead`: a rule read the confidence (a running
 * loop's lowering, decision/midrun.ts), so it is not 「只记录」.
 */
export function readingText(reading: EffortReading, note?: string, confidenceRead = false): string {
  const confidence = reading.confidence === null ? '没有' : reading.confidence.toFixed(2)
  return `概率 ${levelsText(reading)}；位置 ${positionOf(reading).toFixed(2)}${note === undefined ? '' : `；${note}`}；置信度 ${confidence}${confidenceRead ? '' : '（只记录）'}`
}

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value)
}

/** The higher of two levels; null only when both are. */
export function higherEffort(a: Effort | null, b: Effort | null): Effort | null {
  if (a === null) return b
  if (b === null) return a
  return EFFORTS.indexOf(a) >= EFFORTS.indexOf(b) ? a : b
}
