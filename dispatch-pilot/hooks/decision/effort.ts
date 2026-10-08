// The effort question the decision model answers, and how its answer becomes
// one of Claude Code's five effort levels.
//
// Pure (see system-one.ts). Written to TypeSafe's guide for Score and State
// (docs/research/typesafe-question-guide.md §2.3, §4.1): each level describes
// a situation, never a degree; the model never sees a level's name or number,
// so neither appears in the levels or the instructions. The wording of the
// levels and of `rate` comes from jev-pilot, which measured it on labelled
// requests (guide §5.1).

import type { Answer, Part, Question } from './system-one.ts'

/** Claude Code's effort levels, cheapest first: index i is level i of the question. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

/** The language the questions are written in; the state keeps the person's own words either way. */
export type Language = 'en' | 'zh'
/** A five-level Score (lowest first) or a five-option Choice named low .. max. */
export type Primitive = 'score' | 'choice'
/** How effort is asked. Both are eval variables (spec #70, guide §4.1); the defaults are the spec's. */
export type EffortAsk = { language: Language; primitive: Primitive }
export const DEFAULT_ASK: EffortAsk = { language: 'en', primitive: 'score' }

/** The turn-start effort part's name and its one question's id: `effort.level` in the request. */
export const EFFORT_PART = 'effort'
export const LEVEL = 'level'

/** One description per level, lowest first. */
const LEVELS: Record<Language, readonly string[]> = {
  en: [
    'Answered from what is already known, or mechanical work with nothing to work out: a lookup, a single command, a rename or find-and-replace (even across many files), a search that lists what it finds, formatting, a one-line change.',
    'An ordinary, well-specified change to one or a few files, or a direct question about code already in view.',
    'A change across several files that needs working out, a bug whose cause is described but has to be traced, writing tests, or reviewing a diff with care.',
    'Design across several components, a bug whose cause is unknown, a refactor with many dependents, or careful reasoning about concurrency, performance or failure modes.',
    'Novel architecture, a security or data-integrity question, a failure that resisted earlier attempts, or work where a subtle mistake is costly and hard to undo.',
  ],
  zh: [
    '凭已知信息就能回答，或没有需要想清楚之处的机械性工作：查一个东西、执行一条命令、重命名或查找替换（即使跨很多文件）、列出搜索结果、格式化、改一行。',
    '对一个或几个文件做常规、需求明确的修改，或针对眼前代码的直接提问。',
    '跨多个文件、需要想清楚的修改，原因已经描述但仍需追查的 bug，编写测试，或仔细审查一份 diff。',
    '跨多个组件的设计，原因未知的 bug，牵连很多依赖方的重构，或需要仔细推敲并发、性能或故障模式的工作。',
    '全新的架构，安全或数据完整性问题，之前多次尝试都没解决的故障，或一个细微错误就代价高昂且难以挽回的工作。',
  ],
}

/** The question asked when the person sends a message; the state is `{ user_message, recent_context }`. */
const TURN_START: Record<Language, Readonly<Record<string, string>>> = {
  en: {
    question: 'How much step-by-step reasoning does the work that `user_message` asks for need, given `recent_context`?',
    rate: 'Rate the work the request asks for, not how important its topic sounds. Advice or an explanation given in words, even about architecture or security, is not design work.',
    short_replies:
      'When `user_message` only approves, continues or picks an option (such as "go ahead", "1", "继续"), rate the work it approves, as described at the end of `recent_context`.',
  },
  zh: {
    问题: '结合 `recent_context`，完成 `user_message` 所要求的工作需要多少逐步推理？',
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

/** The part a message's decision request carries for the main agent's effort: `effort.level`. */
export function turnStartEffortPart(ask: Partial<EffortAsk> = {}): Part {
  const asked = { ...DEFAULT_ASK, ...ask }
  return { part: EFFORT_PART, questions: { [LEVEL]: effortQuestion(TURN_START[asked.language], asked) } }
}

/** The probability of each level, lowest first (five numbers summing to 1), and the backend's confidence. */
export type EffortReading = { probabilities: readonly number[]; confidence: number | null }

/**
 * The level probabilities an effort answer gives: a Score's are keyed "0" ..
 * "4", a Choice's by level name. Normalized, since backends round them. Null
 * when the answer is missing or puts no probability on any level.
 */
export function readEffort(answer: Answer | undefined): EffortReading | null {
  if (answer === undefined || answer.type === 'noul') return null
  const keys: readonly string[] = answer.type === 'score' ? EFFORTS.map((_, i) => String(i)) : EFFORTS
  const raw = keys.map((key) => answer.probabilities[key] ?? 0)
  const sum = raw.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return null
  return { probabilities: raw.map((p) => p / sum), confidence: answer.confidence }
}

/**
 * The two thresholds of the effort rules, both the decision model's (core/setup.ts BACKEND_DEFAULTS and `Config`, whose
 * `thetaMax` and `roundUp` these are; the mod and the eval pass the same ones). `thetaMax`: `max` only when its own
 * probability reaches it. `roundUp`: the level above the most probable one is taken instead when it has at least this
 * probability: raising is easy (a level too low costs the work its quality, a level too high only tokens; AA's scores
 * fall steeply with effort, DEVELOPMENT.md, 「按 AA 基准校正」). `roundUp` is not an option: set from the stored answers
 * (eval/resummarize.ts), like the other internal values of the table.
 */
export type EffortRules = { thetaMax: number; roundUp: number }

/**
 * The level to use: the most probable one, a tie going to the higher level;
 * then the level above it when that one has at least `rules.roundUp` (once, never
 * further). `max` only when its own probability reaches `rules.thetaMax`, whether it
 * is the most probable level or the one a raise would reach; else the most
 * probable of the others.
 */
export function pickEffort(reading: EffortReading, rules: EffortRules): Effort {
  return traceEffort(reading, rules).effort
}

/**
 * One step of the effort rules, in the order they run. `level` is the level
 * after the step, `applied` whether the step changed or decided anything
 * (`top` always does). Data only: whoever draws the steps words them and
 * never recomputes them (ADR 0004).
 */
export type EffortStep =
  /** The most probable level; `tie`: another level had the same probability and the higher one won. */
  | { rule: 'top'; applied: true; level: Effort; p: number; tie: boolean }
  /** `max` held back: it was the most probable but `p` < `thetaMax`, so the most probable of the others is taken. */
  | { rule: 'max-gate'; applied: boolean; level: Effort; p: number; thetaMax: number }
  /** The level above (`above`, null at the top) taken when its `p` ≥ `threshold`; `blockedByMax`: it was `max`, enough for the threshold but under `thetaMax`. */
  | { rule: 'round-up'; applied: boolean; level: Effort; above: Effort | null; p: number; threshold: number; blockedByMax: boolean; thetaMax: number }
  /** The agent's model has a floor (sonnet and opus: medium; `floor` null for none) and the level was under it. */
  | { rule: 'model-floor'; applied: boolean; level: Effort; from: Effort; model: string; floor: Effort | null }
  /** The plan's floor, or a forced raise (`forced`), lifted the level. */
  | { rule: 'plan-floor'; applied: boolean; level: Effort; from: Effort; floor: Effort | null; forced: boolean }

/** The result of the effort rules and the steps that led to it (the last step's `level` is `effort`). */
export type EffortTrace = { effort: Effort; steps: EffortStep[] }

/** What lifts the picked level afterwards: the model's floor and the plan's floor or forced raise. Each step appears in the trace only when given. */
export type EffortLifts = {
  model?: { name: string; floor: Effort | null }
  plan?: { floor: Effort | null; forced?: boolean }
}

/**
 * `pickEffort` with its working: the steps the rules walked (`top`,
 * `max-gate`, `round-up`, then `model-floor` and `plan-floor` when `lifts`
 * gives them), each saying whether it took effect. `pickEffort` is this
 * function's `effort`: one set of rules, never two.
 */
export function traceEffort(reading: EffortReading, rules: EffortRules, lifts: EffortLifts = {}): EffortTrace {
  const { thetaMax, roundUp } = rules
  const p = reading.probabilities
  const at = (i: number): number => p[i] ?? 0
  const top = (count: number): number => {
    let best = 0
    for (let i = 1; i < count; i++) if (at(i) >= at(best)) best = i
    return best
  }
  const last = EFFORTS.length - 1
  const name = (i: number): Effort => EFFORTS[i] as Effort
  const steps: EffortStep[] = []
  let level = top(EFFORTS.length)
  steps.push({ rule: 'top', applied: true, level: name(level), p: at(level), tie: p.some((other, i) => i !== level && other === at(level)) })
  const gated = level === last && at(level) < thetaMax
  if (gated) level = top(last)
  steps.push({ rule: 'max-gate', applied: gated, level: name(level), p: at(last), thetaMax })
  const above = level + 1
  const aboveP = above <= last ? at(above) : 0
  const blockedByMax = above === last && aboveP >= roundUp && aboveP < thetaMax
  const raised = above <= last && aboveP >= roundUp && (above < last || aboveP >= thetaMax)
  if (raised) level = above
  steps.push({ rule: 'round-up', applied: raised, level: name(level), above: above <= last ? name(above) : null, p: aboveP, threshold: roundUp, blockedByMax, thetaMax })

  const lift = (from: number, floor: Effort | null): number => (floor !== null && EFFORTS.indexOf(floor) > from ? EFFORTS.indexOf(floor) : from)
  if (lifts.model !== undefined) {
    const from = level
    level = lift(level, lifts.model.floor)
    steps.push({ rule: 'model-floor', applied: level !== from, level: name(level), from: name(from), model: lifts.model.name, floor: lifts.model.floor })
  }
  if (lifts.plan !== undefined) {
    const from = level
    level = lift(level, lifts.plan.floor)
    steps.push({ rule: 'plan-floor', applied: level !== from, level: name(level), from: name(from), floor: lifts.plan.floor, forced: lifts.plan.forced === true })
  }
  return { effort: name(level), steps }
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
 * Every level's probability and the backend's confidence, as the decision log
 * gives them: `概率 low 0.00, medium 0.05, ...；置信度 0.80`, with `note`
 * (why a level was held back) between the two.
 */
export function readingText(reading: EffortReading, note?: string): string {
  return `概率 ${levelsText(reading)}${note === undefined ? '' : `；${note}`}；置信度 ${reading.confidence === null ? '没有' : reading.confidence.toFixed(2)}`
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
