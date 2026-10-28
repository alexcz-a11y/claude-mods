// Forced escalation (#7, ADR 0013): how a tool call ended, which model a
// dispatched agent whose calls keep failing goes on as, what is kept of the
// main agent's turn for the next message, and how an agent's transcript reads.
//
// Pure (see system-one.ts). Claude Code 2.1.312 keeps a model's effort from
// one message with input to the next: an effort written on a step whose new
// input is tool results does not go out, a model written on any step does
// (measured, DEVELOPMENT.md 「已实测的引擎行为」). So nothing here raises an
// effort mid-turn or asks the decision model: a failing dispatched agent goes
// on as the next model up, and the main agent's turn leaves its facts
// (`TurnFacts`) for the next message's decision.

import { clipToTokens, withoutReminders } from './context.ts'
import { AGENT_MODELS, modelFamily, type AgentModel, type Terms } from './dispatched-agent.ts'
import type { Effort } from './effort.ts'
import { modelId, type ResolvedModel } from './model-ids.ts'
import { redactSecrets } from './redact.ts'
import { computedTask, isRelayedRequest } from './workflow-labels.ts'

/**
 * How a tool call ended: `ok`, `failed` (the tool reported an error),
 * `blocked` (a hook refused it), `denied` (the person, or a permission rule
 * for them, refused it).
 */
export type Outcome = 'ok' | 'failed' | 'blocked' | 'denied'

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
export function outcomeOf(tool: string, ending: ToolEnding, blockedByHook: boolean): Outcome {
  if (typeof ending.deny === 'string' || blockedByHook) return 'blocked'
  if (ending.isError !== true) return 'ok'
  if (!tool.startsWith('mcp__') && DENIED.test((ending.text ?? '').trim())) return 'denied'
  return 'failed'
}

/** Where a failing agent goes: the model it steps up to (`note`: why not the usual one), or why it stays on the one it has. */
export type StepUp = { to: ResolvedModel; note: string } | { why: string }

/** What a step-up reads of the settings: escalateHaikuTo resolved (null: names no model) and as written, the models agents may run on. */
export type StepUpSettings = { haikuTo: ResolvedModel | null; haikuToWritten: string; models: readonly AgentModel[] }

/**
 * The model a dispatched agent whose calls keep failing goes on as: one rung up.
 * A haiku agent goes to `escalateHaikuTo` (sonnet unless the person set
 * another); any other agent to the next model up of those agents may run on
 * (fable only with `agentFable`). A model the person ruled out for the work is
 * passed over for the next one up. None, with why: the person named the
 * agent's model, its model is of no family the mod knows, it is at the top, or
 * every model up is ruled out or off.
 */
export function stepUp(model: string, settings: StepUpSettings, terms: Terms | null): StepUp {
  if (terms?.model != null) return { why: `${terms.model} 是你给它点名的模型` }
  const family = modelFamily(model)
  if (family === null) return { why: `${model === '' ? '它的模型' : model} 不属于 haiku、sonnet、opus、fable，不知道往哪升` }
  const banned = terms?.banned ?? []
  const above = (from: AgentModel) => AGENT_MODELS.slice(AGENT_MODELS.indexOf(from) + 1).find((up) => settings.models.includes(up) && !banned.includes(up))
  if (family === 'haiku') {
    const to = settings.haikuTo
    if (to === null) return { why: settings.haikuToWritten === '' ? '没有设置失败的 haiku 改用哪个模型' : `设置的改用模型 ${JSON.stringify(settings.haikuToWritten)} 这个 mod 不认识` }
    if (!banned.includes(to.family)) return { to, note: '' }
    const up = above(to.family)
    if (up !== undefined) return { to: { family: up, id: modelId(up) }, note: `（${to.family} 被你排除了）` }
    return { why: `haiku 以上的模型都被你排除了（${AGENT_MODELS.filter((one) => one !== 'haiku' && banned.includes(one)).join('、')}）` }
  }
  const up = above(family)
  if (up !== undefined) return { to: { family: up, id: modelId(up) }, note: '' }
  const ruledOut = AGENT_MODELS.slice(AGENT_MODELS.indexOf(family) + 1).filter((one) => settings.models.includes(one) && banned.includes(one))
  if (ruledOut.length > 0) return { why: `${family} 以上的模型都被你排除了（${ruledOut.join('、')}）` }
  return { why: family === 'opus' && !settings.models.includes('fable') ? '已经是 opus（fable 要打开 agentFable）' : `已经是最高一档的 ${family}` }
}

/**
 * What the main agent's turn did, kept on its turn record when a turn the
 * person's own message started ends (`facts` in types/index.d.ts): the next
 * message's decision reads it, since an effort raised in the middle of a turn
 * no longer goes out (ADR 0013).
 */
export type TurnFacts = {
  /** The effort the turn's steps went out at (its last step's, as the core sent it); null for a model without one. */
  effort: Effort | null
  /** Tool calls that ended in the turn (a plugin's refusal not counted), those that failed, and those a hook refused. */
  calls: number
  failed: number
  blocked: number
  /** Whether the failures counted toward escalating (hook blocks only with `hook-block-failures` on) reached `escalateAfter`. */
  stuck: boolean
  /** The last failed or blocked calls, at most `MAX_ERRORS`, oldest first: each the tool and the first line it said, masked and clipped. */
  errors: string[]
}

/** At most this many error lines are kept. */
export const MAX_ERRORS = 2
/** An error line keeps at most this many tokens. */
const ERROR_TOKENS = 40
/** A line that only says a call failed, not why: passed over for the next one. */
const NOISE = /^(?:exit code -?\d+|errors?:?)$/i

/** A failed or blocked call in one line: `Bash: npm ERR! missing script: test`, secrets masked, then cut; the tool alone when it said nothing. */
export function errorLine(tool: string, text: string | undefined): string {
  const line = (text ?? '').split('\n').map((one) => one.trim()).find((one) => one !== '' && !NOISE.test(one)) ?? ''
  return clipToTokens(redactSecrets(line === '' ? tool : `${tool}: ${line}`), ERROR_TOKENS)
}

/** The error lines kept with `line` added last, the oldest dropped past MAX_ERRORS. */
export function withError(errors: readonly string[], line: string): string[] {
  return [...errors, line].slice(-MAX_ERRORS)
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
  return withoutReminders(text).trim()
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
