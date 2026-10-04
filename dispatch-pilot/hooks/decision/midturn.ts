// The mid-turn effort decision: what the decision model is shown while a
// turn runs, the question it answers, and how its answer moves the turn's
// effort (#5).
//
// Pure (see system-one.ts). The input is the eval dataset's shape
// (effort-midturn: `message`, `step`, `current_effort`, `counts`,
// `recent_steps`), field for field, so the eval (#14) builds exactly the
// request the mod sends from a dataset row (spec #67).

import { clipToTokens, messageText } from './context.ts'
import { DEFAULT_ASK, EFFORTS, effortQuestion, pickEffort, type Effort, type EffortAsk, type EffortReading, type Language } from './effort.ts'
import { redactSecrets } from './redact.ts'
import type { Part, State } from './system-one.ts'

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
}

/**
 * How a tool call ended: `ok`, `failed` (the tool reported an error),
 * `blocked` (a hook refused it), `denied` (the person, or a permission rule
 * for them, refused it). `running`: not ended yet; only a live request has
 * one, the call whose start sent it (the eval set has none).
 */
export type Outcome = 'ok' | 'failed' | 'blocked' | 'denied' | 'running'

/** The words a tool's line starts with, in the language of the turn (the eval set's two). */
const OUTCOME: Record<Language, Record<Outcome, string>> = {
  zh: { ok: '成功', failed: '失败', blocked: '被 hook 拦截', denied: '用户拒绝', running: '进行中' },
  en: { ok: 'Success', failed: 'Failed', blocked: 'Blocked by hook', denied: 'Denied by user', running: 'Running' },
}

/** A tool's one-line result: "成功：src/a.ts", "Failed: Run the tests"; the outcome alone when there is nothing to name. */
export function resultLine(outcome: Outcome, detail: string, language: Language): string {
  const head = OUTCOME[language][outcome]
  if (!detail) return head
  return language === 'zh' ? `${head}：${detail}` : `${head}: ${detail}`
}

/** The language a turn is in, for the words around its content: Chinese once its message has a Han character. */
export function contentLanguage(text: string): Language {
  return /[㐀-鿿]/.test(text) ? 'zh' : 'en'
}

/** At most this many tokens name what a tool call worked on. */
const DETAIL_TOKENS = 24

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
  /** How many tokens the state may take: the message first (at most half), the steps in what is left. */
  tokens: number
}

/** Which optional fields the state shows: eval variables (guide §4.1, §6 item 7), shown by default as the spec asks. */
export type MidturnShow = { currentEffort?: boolean; counts?: boolean }

/**
 * The state of a mid-turn decision request:
 * `{ user_message, trouble?, step, current_effort, counts, recent_steps }`,
 * the message first (Clef may read only the start of a state).
 */
export function midturnState(input: MidturnInput, limits: MidturnLimits, show: MidturnShow = {}): State {
  const message = messageText(input.message, Math.floor(limits.tokens / 2))
  const steps = input.recent_steps.slice(-Math.max(1, limits.steps))
  return {
    user_message: message,
    ...(input.trouble ? { trouble: input.trouble } : {}),
    step: input.step,
    ...(show.currentEffort === false ? {} : { current_effort: input.current_effort }),
    ...(show.counts === false ? {} : { counts: input.counts }),
    recent_steps: steps,
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
export function midturnEffortPart(ask: Partial<EffortAsk> = {}, options: { trouble?: boolean } = {}): Part {
  const asked = { ...DEFAULT_ASK, ...ask }
  const words = MIDTURN[asked.language]
  const instructions = options.trouble ? { ...words.base, ...words.trouble } : words.base
  return { part: MIDTURN_PART, questions: { [MIDTURN_LEVEL]: effortQuestion(instructions, asked) } }
}

export type MidturnRules = {
  /** Confidence a raise needs. */
  thetaUp: number
  /** Confidence a lowering needs (at least thetaUp); it lowers one level at most. */
  thetaDown: number
  /** `max` only when its own probability reaches this. */
  thetaMax: number
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

/** Why a decision left the level where it did. */
export type MidturnWhy = 'same' | 'up' | 'down' | 'unsure' | 'held'

/**
 * The level the turn goes on at after a mid-turn answer: the answer's level
 * (pickEffort: the most likely, max only past thetaMax) when it is higher and
 * the answer is sure enough (thetaUp); one level down when it is lower, the
 * answer surer still (thetaDown, never below thetaUp) and no raise happened
 * in the last holdSteps steps; else the current level. Sure enough means the
 * backend's confidence, or the most likely level's probability when the
 * backend gives none.
 */
export function judgeMidturn(reading: EffortReading, position: MidturnPosition, rules: MidturnRules): { effort: Effort; why: MidturnWhy } {
  const { current } = position
  const picked = pickEffort(reading, rules.thetaMax)
  const confidence = reading.confidence ?? Math.max(...reading.probabilities)
  const at = (level: Effort) => EFFORTS.indexOf(level)
  if (at(picked) > at(current)) return confidence >= rules.thetaUp ? { effort: picked, why: 'up' } : { effort: current, why: 'unsure' }
  if (at(picked) < at(current)) {
    if (position.sinceRaise !== null && position.sinceRaise < rules.holdSteps) return { effort: current, why: 'held' }
    return confidence >= Math.max(rules.thetaDown, rules.thetaUp) ? { effort: EFFORTS[at(current) - 1] as Effort, why: 'down' } : { effort: current, why: 'unsure' }
  }
  return { effort: current, why: 'same' }
}
