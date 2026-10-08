// Forced escalation (#7): the request a loop whose tool calls keep failing is
// asked about, what the loop is read from, and the rules that turn the answer
// into a level.
//
// Pure (see system-one.ts). The request is the mid-turn effort request
// (midturn.ts, with its `trouble`) and one more question: is what failed what
// the work expects at this point (a test written to fail first, a search that
// finds nothing), or is the work stuck? Written to TypeSafe's guide for Noul
// (docs/research/typesafe-question-guide.md §2.5): one yes/no question, a high
// value means yes, `criteria.true` is yes. The mod and the eval build it with
// `stuckRequest` (spec #67).

import { DEFAULT_ASK, EFFORTS, higherEffort, traceEffort, type Effort, type EffortAsk, type EffortReading, type EffortRules, type EffortStep, type Language } from './effort.ts'
import { midturnEffortPart, midturnState, outcomeOf, resultLine, toolDetail, type MidturnInput, type MidturnLimits, type MidturnStep, type MidturnTool, type Outcome } from './midturn.ts'
import { mergeParts, type Answer, type DecisionRequest, type Part, type Question } from './system-one.ts'
import { computedTask, isRelayedRequest } from './workflow-labels.ts'

/** The part's name and its one question's id: `escalation.expected` in a request. */
export const ESCALATION_PART = 'escalation'
export const EXPECTED = 'expected'

/**
 * How a forced raise moves the level: `one-level` goes up one level, never
 * past xhigh; `max` goes straight to max.
 */
export const RAISE_MODES = ['one-level', 'max'] as const
export type RaiseMode = (typeof RAISE_MODES)[number]

/** The level a forced raise goes to from `current`; null when there is nowhere to go (xhigh or max in `one-level`, max in `max`). */
export function forcedTarget(current: Effort, mode: RaiseMode): Effort | null {
  const at = EFFORTS.indexOf(current)
  const top = mode === 'max' ? EFFORTS.indexOf('max') : EFFORTS.indexOf('xhigh')
  const to = mode === 'max' ? top : Math.min(at + 1, top)
  return to > at ? (EFFORTS[to] as Effort) : null
}

/**
 * One step of a forced raise's working, besides the effort rules' own (`EffortStep`) that read the answer's pick.
 * Data only, like them (ADR 0004).
 */
export type RaiseStep =
  /** The failures force the loop from `from` to `level` (one level up, or max: `mode`). */
  | { rule: 'forced-raise'; applied: true; level: Effort; from: Effort; mode: RaiseMode }
  /** The answer's own pick counts only when it is sure enough: `confidence` >= `threshold` (thetaUp). */
  | { rule: 'theta-up'; applied: boolean; confidence: number; threshold: number }
  /** The higher of the forced level (`from`) and the answer's pick; `applied` when the pick was higher. */
  | { rule: 'higher-of'; applied: boolean; level: Effort; from: Effort }

/**
 * The level a forced raise ends at, with its working: `target` (the one level,
 * or max, the failures force, from `from`), or the decision model's own pick
 * when that is higher and its answer is sure enough (`thetaUp`, as for any
 * mid-turn raise); the level above the pick from `roundUp` and `max` only past `thetaMax`, as everywhere. The steps are the
 * forced raise, then (with an answer) the effort rules' walk to its pick, the
 * confidence check and the comparison.
 */
export function traceRaise(
  reading: EffortReading | null,
  forced: { from: Effort; target: Effort; mode: RaiseMode },
  rules: EffortRules & { thetaUp: number },
): { level: Effort; steps: (EffortStep | RaiseStep)[] } {
  const { target } = forced
  const steps: (EffortStep | RaiseStep)[] = [{ rule: 'forced-raise', applied: true, level: target, from: forced.from, mode: forced.mode }]
  if (reading === null) return { level: target, steps }
  const pick = traceEffort(reading, rules)
  const confidence = reading.confidence ?? Math.max(...reading.probabilities)
  const sure = confidence >= rules.thetaUp
  steps.push(...pick.steps, { rule: 'theta-up', applied: sure, confidence, threshold: rules.thetaUp })
  if (!sure) return { level: target, steps }
  const level = higherEffort(target, pick.effort) as Effort
  steps.push({ rule: 'higher-of', applied: level !== target, level, from: target })
  return { level, steps }
}

/** What went wrong, in one English sentence for the decision model's state (`trouble`): `2 tool calls have failed while working on this request`. */
export function troubleText(counted: { failures: number; hookBlocks: number }): string {
  const n = counted.failures + counted.hookBlocks
  const how = counted.hookBlocks > 0 ? 'failed or been blocked by a hook' : 'failed'
  return `${n} tool call${n === 1 ? ' has' : 's have'} ${how} while working on this request`
}

const EXPECTED_QUESTION: Record<Language, Question> = {
  en: {
    type: 'noul',
    instructions: 'Are the failed tool calls in `recent_steps` what the work on `user_message` expects at this point, rather than a sign that the work is stuck?',
    criteria: {
      true: 'The failures are part of how the work goes: a test written first and run to watch it fail, a search or check that exits with an error because it found nothing or has something to report, a command run to find out whether something exists or works.',
      false: 'The failures are obstacles: the same call failing again and again, a command, path or tool that does not exist or is used wrongly, an error in code just written, or a fix that did not take.',
    },
  },
  zh: {
    type: 'noul',
    instructions: '`recent_steps` 里失败的工具调用，是不是 `user_message` 这项工作此时本来就会遇到的，而不是工作卡住的迹象？',
    criteria: {
      true: '失败本来就是工作的一部分：先写下并运行、要看它失败的测试；因为没找到东西或有东西要报告而以错误退出的搜索或检查；为了弄清某样东西是否存在、能否运行而执行的命令。',
      false: '失败是障碍：同一个调用一再失败；命令、路径或工具不存在或用法不对；刚写的代码有错误；修复没有生效。',
    },
  },
}

/** The part a stuck re-decision adds to its request: `escalation.expected`. */
export function expectedFailurePart(ask: Partial<EffortAsk> = {}): Part {
  const asked = { ...DEFAULT_ASK, ...ask }
  return { part: ESCALATION_PART, questions: { [EXPECTED]: EXPECTED_QUESTION[asked.language] } }
}

/** The probability that the failures were expected (the answer's `noul`); null without a usable answer. */
export function readExpected(answers: Readonly<Record<string, Answer>>): number | null {
  const answer = answers[EXPECTED]
  return answer?.type === 'noul' ? answer.noul : null
}

/** A stuck re-decision's request, and its parts to read the answers back with. */
export type StuckRequest = { request: DecisionRequest; effortPart: Part | null; expectedPart: Part }

/**
 * The request a stuck loop's re-decision sends (`input` with its `trouble`):
 * the mid-turn state and effort question, with the trouble flag, and whether
 * the failures were expected. A loop that takes no effort level (a haiku
 * agent) is asked the second only, its state without a current level.
 */
export function stuckRequest(input: MidturnInput, options: { limits: MidturnLimits; ask?: Partial<EffortAsk>; effort: boolean }): StuckRequest {
  const effortPart = options.effort ? midturnEffortPart(options.ask, { trouble: true }) : null
  const expectedPart = expectedFailurePart(options.ask)
  const state = midturnState(input, options.limits, options.effort ? {} : { currentEffort: false })
  return { request: mergeParts(state, effortPart === null ? [expectedPart] : [effortPart, expectedPart]), effortPart, expectedPart }
}

/** A transcript row as `$.session.messages()` gives it (the part read here); `rowsFromTranscript` reads an agent's transcript file to the same shape. */
export type TranscriptRow = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: readonly { tool_use_id?: string; tool: string; input?: Readonly<Record<string, unknown>>; text?: string; isError?: true }[]
  toolResults?: readonly unknown[]
}

/** A row's words without what the engine wraps in <system-reminder> (not something anyone said). */
function unwrapped(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').trim()
}

/** The task an agent was given: the first thing said to it in its transcript ('' when there is none). */
export function briefOf(rows: readonly TranscriptRow[]): string {
  for (const row of rows) {
    const words = row.role === 'user' ? unwrapped(row.text) : ''
    if (words !== '') return words
  }
  return ''
}

/**
 * What a loop has done since the last thing a person said, as the decision
 * model reads it: the steps, oldest first, each the text the agent wrote and
 * its tool calls with how they ended (the mid-turn request's `recent_steps`).
 * The transcript gives a response one row per block and the tool results rows
 * of their own, so a step is the run of assistant rows between two user rows.
 * `ended` says how a call ended when it was seen ending (a call that has just
 * ended has no result in the transcript yet, and a hook's refusal reads as
 * any error there); the transcript says it for the rest.
 */
export function stepsFromRows(rows: readonly TranscriptRow[], options: { language: Language; ended?: (toolUseId: string) => Exclude<Outcome, 'running'> | undefined }): MidturnStep[] {
  const said = (row: TranscriptRow) => row.role === 'user' && unwrapped(row.text) !== '' && (row.toolResults?.length ?? 0) === 0
  const from = rows.findLastIndex(said) + 1
  const steps: MidturnStep[] = []
  let texts: string[] = []
  let tools: MidturnTool[] = []
  const close = () => {
    if (texts.length > 0 || tools.length > 0) steps.push({ assistant_text: texts.join('\n'), tools })
    texts = []
    tools = []
  }
  for (const row of rows.slice(from)) {
    if (row.role === 'user') {
      close()
      continue
    }
    if (row.text.trim() !== '') texts.push(row.text.trim())
    for (const use of row.toolUses ?? []) {
      const outcome = (use.tool_use_id === undefined ? undefined : options.ended?.(use.tool_use_id)) ?? outcomeOf(use.tool, { isError: use.isError, text: use.text }, false)
      tools.push({ name: use.tool, result: resultLine(outcome, toolDetail(use.input ?? {}), options.language) })
    }
  }
  close()
  return steps
}

/**
 * An agent's transcript file (`agent-<agentId>.jsonl`, one JSON object a line,
 * as Claude Code writes it) as transcript rows: its task (a workflow agent's
 * framed task unframed; the user's request the engine may relay before it is
 * left out), what it wrote and called, and what came back, each call with how
 * it ended. Lines that are not messages (attachments) are skipped.
 */
export function rowsFromTranscript(jsonl: string): TranscriptRow[] {
  type Block = { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown }
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = []
  for (const line of jsonl.split('\n')) {
    let row: { type?: unknown; message?: { role?: unknown; content?: unknown } }
    try {
      row = JSON.parse(line) as typeof row
    } catch {
      continue
    }
    const role = row.message?.role
    if ((row.type === 'user' || row.type === 'assistant') && (role === 'user' || role === 'assistant')) messages.push({ role, content: row.message?.content })
  }
  const blocks = (content: unknown): Block[] => (Array.isArray(content) ? content.filter((block): block is Block => typeof block === 'object' && block !== null) : [])
  const textOf = (content: unknown): string => (typeof content === 'string' ? content : blocks(content).map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join(''))
  // How each call ended, by its id: what came back for it.
  const results = new Map<string, { text: string; isError: boolean }>()
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const block of blocks(message.content)) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') results.set(block.tool_use_id, { text: textOf(block.content), isError: block.is_error === true })
    }
  }
  const rows: TranscriptRow[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      const answered = blocks(message.content).filter((block) => block.type === 'tool_result')
      if (answered.length > 0) {
        rows.push({ role: 'user', text: '', toolResults: answered })
        continue
      }
      const text = textOf(message.content)
      if (isRelayedRequest(text)) continue
      rows.push({ role: 'user', text: computedTask(text) ?? text })
      continue
    }
    const uses = blocks(message.content).flatMap((block) => {
      if (block.type !== 'tool_use' || typeof block.name !== 'string') return []
      const id = typeof block.id === 'string' ? block.id : undefined
      const result = id === undefined ? undefined : results.get(id)
      const input = typeof block.input === 'object' && block.input !== null ? (block.input as Record<string, unknown>) : {}
      return [{ ...(id === undefined ? {} : { tool_use_id: id }), tool: block.name, input, ...(result === undefined ? {} : { text: result.text, ...(result.isError ? { isError: true as const } : {}) }) }]
    })
    rows.push({ role: 'assistant', text: textOf(message.content), ...(uses.length > 0 ? { toolUses: uses } : {}) })
  }
  return rows
}
