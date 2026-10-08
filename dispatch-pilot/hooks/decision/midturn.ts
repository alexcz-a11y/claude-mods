// The mid-turn effort decision: what the decision model is shown while a
// turn runs, the question it answers, and how its answer moves the turn's
// effort (#5).
//
// Pure (see system-one.ts). The input is the eval dataset's shape
// (effort-midturn: `message`, `step`, `current_effort`, `counts`,
// `recent_steps`), field for field, so the eval (#14) builds exactly the
// request the mod sends from a dataset row (spec #67).

import { clipToTokens, estimateTokens, messageText, withinTokens } from './context.ts'
import { DEFAULT_ASK, EFFORTS, effortQuestion, traceEffort, type Effort, type EffortAsk, type EffortReading, type EffortRules, type EffortTrace, type Language } from './effort.ts'
import { redactSecrets } from './redact.ts'
import type { Part, State } from './system-one.ts'
import { COUNT_FIELD, withHint } from './unresolved.ts'
import { SUMMARY_FIELD } from './summary.ts'

/** The mid-turn part's name and its one question's id: `midturn.level` in the request. */
export const MIDTURN_PART = 'midturn'
export const MIDTURN_LEVEL = 'level'

/** One tool call of a step: the tool's name and how it ended, in one line ("成功：…", "Failed: …"). */
export type MidturnTool = { name: string; result: string }
/** One step of the turn: the last text the main agent wrote in it and the tools it called. */
export type MidturnStep = { assistant_text: string; tools: readonly MidturnTool[] }
export type MidturnCounts = {
  /** Decisions made for the turn so far (the one at its start included). */
  judgments: number
  /** Times the turn's effort moved. */
  changes: number
  /** Tool calls that failed (hook blocks and denials not counted). */
  failures: number
  /** Tool calls a hook refused. */
  hook_blocks: number
}

/** What a mid-turn decision reads: the effort-midturn dataset's `zh` / `en` object, plus #7's `trouble`. */
export type MidturnInput = {
  /** The person's message the turn works on. */
  message: string
  /** The step the decision is for: the index of the `turn.step` about to be sent. */
  step: number
  /** The level the turn goes out at now. */
  current_effort: Effort
  counts: MidturnCounts
  /** The latest steps, oldest first. */
  recent_steps: readonly MidturnStep[]
  /** Why the turn is re-decided out of turn (a forced raise when it is stuck, #7); absent otherwise. */
  trouble?: string
  /** The problem summary, worded for the decision model (`renderSummary`); absent when there is none or the unresolved switch is off (#41). */
  problem_summary?: string
  /** How many times the person has said the problem is still unresolved; absent while it is 0 (#41). */
  unresolved_count?: number
}

/**
 * How a tool call ended: `ok`, `failed` (the tool reported an error),
 * `blocked` (a hook refused it), `denied` (the person, or a permission rule
 * for them, refused it). `running`: not ended yet; only a live request has
 * one, the call whose start sent it (the eval set has none).
 */
export type Outcome = 'ok' | 'failed' | 'blocked' | 'denied' | 'running'

/** The words a tool's line starts with, in the language of the turn (the eval set's two); a dataset row's result starts with them too. */
export const OUTCOME_WORDS: Readonly<Record<Language, Readonly<Record<Outcome, string>>>> = {
  zh: { ok: '成功', failed: '失败', blocked: '被 hook 拦截', denied: '用户拒绝', running: '进行中' },
  en: { ok: 'Success', failed: 'Failed', blocked: 'Blocked by hook', denied: 'Denied by user', running: 'Running' },
}

/** A tool's one-line result: "成功：src/a.ts", "Failed: Run the tests"; the outcome alone when there is nothing to name. */
export function resultLine(outcome: Outcome, detail: string, language: Language): string {
  const head = OUTCOME_WORDS[language][outcome]
  if (!detail) return head
  return language === 'zh' ? `${head}：${detail}` : `${head}: ${detail}`
}

/** How a line says its call ended, by the words it starts with (alone, or before `：` or `: `); null when it starts with none. */
export function outcomeOfLine(line: string): Outcome | null {
  for (const words of Object.values(OUTCOME_WORDS)) {
    for (const [outcome, head] of Object.entries(words)) {
      if (line === head || line.startsWith(`${head}：`) || line.startsWith(`${head}: `)) return outcome as Outcome
    }
  }
  return null
}

/** The language a turn is in, for the words around its content: Chinese once its message has a Han character. */
export function contentLanguage(text: string): Language {
  return /[㐀-鿿]/.test(text) ? 'zh' : 'en'
}

/** At most this many tokens name what a tool call worked on. */
const DETAIL_TOKENS = 24

/** The arguments `toolDetail` reads, in the order it takes them (the eval's dataset gives a call these and no others). */
export const DETAIL_KEYS = ['description', 'skill', 'name', 'file_path', 'notebook_path', 'pattern', 'query', 'url', 'command'] as const

/**
 * What a tool call worked on, from the few arguments that say so without
 * carrying content: the call's own `description` (the model's words), a
 * skill's or a workflow's name, the end of a file path, a search pattern or
 * query, a URL; else the first line of a shell command. Never what it wrote
 * (`content`, `new_string`) or anything it returned. Masked and cut short;
 * '' when nothing fits.
 */
export function toolDetail(input: Readonly<Record<string, unknown>>): string {
  const text = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string).trim() : '')
  const path = text('file_path') || text('notebook_path')
  const named =
    text('description') ||
    text('skill') ||
    text('name') ||
    (path ? path.split('/').filter(Boolean).slice(-2).join('/') : '') ||
    text('pattern') ||
    text('query') ||
    text('url') ||
    (text('command').split('\n')[0] ?? '')
  return clipToTokens(redactSecrets(named).replace(/\s+/g, ' ').trim(), DETAIL_TOKENS)
}

/** How a call ended, as the engine resolved `tool.call`: what the hooks beneath, the permission check and the tool said. */
export type ToolEnding = { deny?: string; isError?: boolean; text?: string }

/** The engine's own words when the person refuses a call, or a permission rule refuses it for them. */
const DENIED = /^(?:The user doesn't want to (?:proceed with this tool use|take this action)|Permission (?:to use|for this)\b)/

/**
 * A call's outcome: `blocked` when a hook refused it (`{ deny }` from a hook
 * beneath, or a PreToolUse settings hook, `blockedByHook`); `denied` when
 * the error is the engine's refusal on the person's behalf (matched on its
 * text, so never for an MCP tool, whose text is its own); `failed` for any
 * other error; else `ok`.
 */
export function outcomeOf(tool: string, ending: ToolEnding, blockedByHook: boolean): Exclude<Outcome, 'running'> {
  if (typeof ending.deny === 'string' || blockedByHook) return 'blocked'
  if (ending.isError !== true) return 'ok'
  if (!tool.startsWith('mcp__') && DENIED.test((ending.text ?? '').trim())) return 'denied'
  return 'failed'
}

export type MidturnLimits = {
  /** How many of the latest steps go along. */
  steps: number
  /** How many tokens the state may take as it is sent: the message's share first (at most half), the steps in what is left. */
  tokens: number
}

/** Which optional fields the state shows: eval variables (guide §4.1, §6 item 7), shown by default as the spec asks. */
export type MidturnShow = { currentEffort?: boolean; counts?: boolean }

/** A step's text keeps at most this many tokens, most of them from its end (what the agent is about to do). */
const STEP_TEXT_TOKENS = 120
/** A step's text cut to fit keeps this share of its budget for its end. */
const STEP_TAIL = 0.75
/** A tool's line keeps at most this many tokens. */
const RESULT_TOKENS = 80

/**
 * The state of a mid-turn decision request:
 * `{ user_message, trouble?, step, current_effort, counts, recent_steps }`.
 * Secrets are masked everywhere. Sizes are of the state as sent (its fields
 * and each step measured as JSON), so the whole of it keeps within
 * `limits.tokens`: no field is safe for coming first (a decision model may
 * sort a state's keys and read only its head; context.ts `withinTokens`). The message
 * takes at most half; the latest `limits.steps` steps fill what is left,
 * newest first, an older step dropped whole rather than squeezed; the newest
 * always goes, its text cut to fit. A dataset row short enough goes as it is.
 */
export function midturnState(input: MidturnInput, limits: MidturnLimits, show: MidturnShow = {}): State {
  return withinTokens((tokens) => midturnFields(input, { ...limits, tokens }, show), limits.tokens)
}

/** The fields of a mid-turn state within `limits.tokens`, each measured as it is sent (the newest step's text is cut by its own measure). */
function midturnFields(input: MidturnInput, limits: MidturnLimits, show: MidturnShow): State {
  const head = {
    user_message: messageText(input.message, Math.floor(limits.tokens / 2)),
    ...(input.trouble ? { trouble: input.trouble } : {}),
    ...(input.problem_summary ? { [SUMMARY_FIELD]: input.problem_summary } : {}),
    ...(input.unresolved_count ? { [COUNT_FIELD]: input.unresolved_count } : {}),
    step: input.step,
    ...(show.currentEffort === false ? {} : { current_effort: input.current_effort }),
    ...(show.counts === false ? {} : { counts: input.counts }),
  }
  let room = limits.tokens - estimateTokens(JSON.stringify({ ...head, recent_steps: [] }))
  const steps = input.recent_steps.slice(-Math.max(1, limits.steps)).map(cleanStep)
  const kept: MidturnStep[] = []
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i] as MidturnStep
    const size = estimateTokens(JSON.stringify(step)) + 1
    if (size <= room) {
      kept.unshift(step)
      room -= size
      continue
    }
    if (kept.length === 0) {
      const bare = estimateTokens(JSON.stringify({ ...step, assistant_text: '' })) + 1
      kept.unshift({ ...step, assistant_text: clipToTokens(step.assistant_text, room - bare, STEP_TAIL) })
    }
    break
  }
  return { ...head, recent_steps: kept }
}

/** A step as it goes: whitespace collapsed, secrets masked, its text and each tool's line cut to their caps. */
function cleanStep(step: MidturnStep): MidturnStep {
  const clean = (text: string, tokens: number, tail = 0) => clipToTokens(redactSecrets(text.replace(/\s+/g, ' ').trim()), tokens, tail)
  return {
    assistant_text: clean(step.assistant_text, STEP_TEXT_TOKENS, STEP_TAIL),
    tools: step.tools.map((tool) => ({ name: tool.name, result: clean(tool.result, RESULT_TOKENS) })),
  }
}

const MIDTURN: Record<EffortAsk['language'], { base: Readonly<Record<string, string>>; trouble: Readonly<Record<string, string>> }> = {
  en: {
    base: {
      question: 'How much step-by-step reasoning does the rest of the work on `user_message` need, given `recent_steps`?',
      rate: 'Rate the work still ahead, not the work already done or how important its topic sounds.',
    },
    trouble: { trouble: '`trouble` says what has gone wrong so far: rate what it takes to get past it.' },
  },
  zh: {
    base: {
      问题: '结合 `recent_steps`，`user_message` 剩下的工作还需要多少逐步推理？',
      评什么: '评的是接下来还要做的工作，不是已经做完的工作，也不是话题听起来有多重要。',
    },
    trouble: { 卡住: '`trouble` 说明目前出了什么问题：评的是解决它需要多少推理。' },
  },
}

/** The part a mid-turn request carries: `midturn.level`, the same five levels as at the turn's start. */
export function midturnEffortPart(ask: Partial<EffortAsk> = {}, options: { trouble?: boolean; hint?: boolean } = {}): Part {
  const asked = { ...DEFAULT_ASK, ...ask }
  const words = MIDTURN[asked.language]
  const instructions = options.trouble ? { ...words.base, ...words.trouble } : words.base
  const part = { part: MIDTURN_PART, questions: { [MIDTURN_LEVEL]: effortQuestion(instructions, asked) } }
  // The strong hint when the problem has gone round enough times (#41); like the message's, a sentence about the work, never a level.
  return options.hint === true ? withHint(part, asked.language) : part
}

export type MidturnRules = EffortRules & {
  /** Confidence a raise needs. */
  thetaUp: number
  /** Confidence a lowering needs (at least thetaUp); it lowers one level at most. */
  thetaDown: number
  /** No lowering within this many steps after a raise. */
  holdSteps: number
}

export type MidturnPosition = {
  /** The level the turn goes out at now. */
  current: Effort
  /** Steps since the turn's effort last went up mid-turn; null when it has not. */
  sinceRaise: number | null
  /** The lowest level the result may take (a forced raise, or the turn's floor); null for none. */
  atLeast?: Effort | null
}

/** Why a decision left the level where it did; `lifted`: brought up to `atLeast`. */
export type MidturnWhy = 'same' | 'up' | 'down' | 'unsure' | 'held' | 'lifted'

/**
 * One step of a mid-turn decision, in the order the rules ran; only the steps
 * reached are there (a held lowering never gets to the threshold). `applied`:
 * the step let the move through (a threshold passed) or changed the level
 * (a hold, a floor). Data only, like `EffortStep`.
 */
export type MidturnRuleStep =
  /** The answer's level against the current one. */
  | { rule: 'suggest'; applied: true; picked: Effort; current: Effort; direction: 'up' | 'down' | 'same' }
  /** A lowering waits `holdSteps` after a raise: `applied` while it still waits, `remaining` steps more (0 when not). */
  | { rule: 'hold'; applied: boolean; sinceRaise: number | null; holdSteps: number; remaining: number }
  /** A raise needs `confidence` >= `threshold` (thetaUp); `applied` when it has it. */
  | { rule: 'theta-up'; applied: boolean; confidence: number; threshold: number }
  /** A lowering needs `confidence` >= `threshold` (the higher of thetaDown and thetaUp). */
  | { rule: 'theta-down'; applied: boolean; confidence: number; threshold: number }
  /** A lowering goes one level only: from the current level to `level`. */
  | { rule: 'one-step'; applied: true; from: Effort; level: Effort }
  /** The least level (a forced raise, or the turn's floor); `applied` when it lifted `from` to `level`. */
  | { rule: 'floor'; applied: boolean; floor: Effort; from: Effort; level: Effort }

/** A mid-turn decision's working: how the answer's level was picked, the confidence used, the steps after it, and the result. */
export type MidturnTrace = {
  pick: EffortTrace
  confidence: { value: number; from: 'backend' | 'probability' }
  steps: MidturnRuleStep[]
  result: Effort
}

/** A mid-turn decision: the level to go on at and why, with what the answer said (its pick and how sure it was) and the rules' working. */
export type MidturnVerdict = { effort: Effort; why: MidturnWhy; picked: Effort; confidence: number; trace: MidturnTrace }

/**
 * The level the turn goes on at after a mid-turn answer: the answer's level
 * (pickEffort: the most likely, the level above it from roundUp, max only past thetaMax) when it is higher and
 * the answer is sure enough (thetaUp); one level down when it is lower, the
 * answer surer still (thetaDown, never below thetaUp) and no raise happened
 * in the last holdSteps steps; else the current level. Sure enough means the
 * backend's confidence, or the most likely level's probability when the
 * backend gives none. Whatever the answer, never below `atLeast` (a forced
 * raise: #7 asks for one level above the turn's when it is stuck).
 */
export function judgeMidturn(reading: EffortReading, position: MidturnPosition, rules: MidturnRules): MidturnVerdict {
  const { current } = position
  const pick = traceEffort(reading, rules)
  const picked = pick.effort
  const confidence = reading.confidence ?? Math.max(...reading.probabilities)
  const at = (level: Effort) => EFFORTS.indexOf(level)
  const floor = position.atLeast ?? null
  const direction = at(picked) > at(current) ? 'up' : at(picked) < at(current) ? 'down' : 'same'
  const steps: MidturnRuleStep[] = [{ rule: 'suggest', applied: true, picked, current, direction }]
  const verdict = (effort: Effort, why: MidturnWhy): MidturnVerdict => {
    let result = effort
    let final = why
    if (floor !== null) {
      const lifted = at(effort) < at(floor)
      steps.push({ rule: 'floor', applied: lifted, floor, from: effort, level: lifted ? floor : effort })
      if (lifted) {
        result = floor
        final = 'lifted'
      }
    }
    return { effort: result, why: final, picked, confidence, trace: { pick, confidence: { value: confidence, from: reading.confidence === null ? 'probability' : 'backend' }, steps, result } }
  }
  if (direction === 'up') {
    const sure = confidence >= rules.thetaUp
    steps.push({ rule: 'theta-up', applied: sure, confidence, threshold: rules.thetaUp })
    return sure ? verdict(picked, 'up') : verdict(current, 'unsure')
  }
  if (direction === 'down') {
    const held = position.sinceRaise !== null && position.sinceRaise < rules.holdSteps
    steps.push({ rule: 'hold', applied: held, sinceRaise: position.sinceRaise, holdSteps: rules.holdSteps, remaining: held ? rules.holdSteps - (position.sinceRaise as number) : 0 })
    if (held) return verdict(current, 'held')
    const needed = Math.max(rules.thetaDown, rules.thetaUp)
    const sure = confidence >= needed
    steps.push({ rule: 'theta-down', applied: sure, confidence, threshold: needed })
    if (!sure) return verdict(current, 'unsure')
    const level = EFFORTS[at(current) - 1] as Effort
    steps.push({ rule: 'one-step', applied: true, from: current, level })
    return verdict(level, 'down')
  }
  return verdict(current, 'same')
}

/**
 * What a verdict says for the board: the level the answer suggested, the one the turn was at, where it ended;
 * the confidence the move needed (`threshold`: thetaUp for a raise, thetaDown for a lowering; none when the
 * answer was the level itself, or a held lowering never got to it); and for a held lowering why and how many
 * steps are left of the wait (`remaining`).
 */
export function midturnRecord(verdict: MidturnVerdict, position: MidturnPosition, rules: MidturnRules): { current: Effort; picked: Effort; result: Effort; threshold?: number; held?: string; remaining?: number } {
  const steps = verdict.trace.steps
  const needed = steps.find((step) => step.rule === 'theta-up' || step.rule === 'theta-down')
  const hold = steps.find((step): step is Extract<MidturnRuleStep, { rule: 'hold' }> => step.rule === 'hold' && step.applied)
  return {
    current: position.current,
    picked: verdict.picked,
    result: verdict.effort,
    ...(needed === undefined ? {} : { threshold: needed.threshold }),
    ...(hold === undefined ? {} : { held: verdictReason(verdict, position, rules), remaining: hold.remaining }),
  }
}

/** Why a verdict went where it did, in a few words for the decision log: `升档`, `防抖中：2 步前升过档（3 步内不降）`. */
export function verdictReason(verdict: MidturnVerdict, position: MidturnPosition, rules: MidturnRules): string {
  switch (verdict.why) {
    case 'up':
      return '升档'
    case 'down':
      return `降一档，朝 ${verdict.picked}`
    case 'held':
      return `防抖中：${position.sinceRaise ?? 0} 步前升过档（${rules.holdSteps} 步内不降）`
    case 'unsure': {
      const up = EFFORTS.indexOf(verdict.picked) > EFFORTS.indexOf(position.current)
      const needed = up ? rules.thetaUp : Math.max(rules.thetaDown, rules.thetaUp)
      return `${verdict.picked} 把握不够（需要${up ? '升档' : '降档'}门槛 ${needed.toFixed(2)}）`
    }
    case 'same':
      return '档位不变'
    case 'lifted':
      return `抬到 ${verdict.effort}，下限要求的最低一档`
  }
}
