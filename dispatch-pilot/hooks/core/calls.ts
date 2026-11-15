// Tool calls as the conversation's rows tell them (ADR 0028). The features that read each tool call as it ends
// (features/midrun-effort.ts, features/escalation.ts) do so in `tool.call`, an event Code Mode refuses a mod for: those
// hooks are bridged (core/bridge.ts) and run only with dispatch-pilot-extras loaded. Without it, the same facts are read
// here from `session.append`, which every session raises: a response's `tool_use` block names the call (its id, its
// tool, its arguments), and the `tool_result` row that follows says how it ended (`is_error`, and the error's text).
//
// In a Code Mode session the model's own calls are `REPL` (a script) and `Poll` (waiting for the script's events), and
// each tool call the script makes arrives as a pair of rows of its own (measured on 2.1.325: a response row whose model
// is `<synthetic>`, with the `tool_use`, then the `tool_result` under a `repl_…` id; a call that passed has no text, a
// failed one its error). So the calls read here are the script's, and `REPL` and `Poll` themselves are left out: what
// a script did is in the calls it made.
//
// What a script returned (or the error it stopped with) is a row of its own, `door: 'queue'`: the event the model then
// reads, as a `Poll`'s result or beside its next request. It comes before the rows of the script's calls (measured on
// 2.1.325), and may come twice; `scriptEnded` reads it.
//
// The calls named and not yet ended are kept in the module, the latest only: a hot reload loses them, and the calls
// then ending are not read (as a call whose `tool.call` hook was lost with its module is not).

import type { ApiContentBlock, On } from 'claude-code'
import { hasExtras } from './bridge.ts'

/** A tool call as its rows tell it, once it has ended. */
export type RowCall = {
  id: string
  tool: string
  input: Readonly<Record<string, unknown>>
  /** The loop the call was made in; absent on the main agent's. */
  agentId?: string
  isError: boolean
  /** What the tool said: an error's text; '' for a call of a script that passed (the script holds its result). */
  text: string
  /** From the row that named the call to the row that ended it. */
  durationMs: number
}

/** Code Mode's own tools: the script and the wait for its events. The calls a script makes are rows of their own. */
const PLUMBING: ReadonlySet<string> = new Set(['REPL', 'Poll'])
/** At most this many named calls are kept, the oldest dropped first. */
const MAX_USES = 256

const uses = new Map<string, { tool: string; input: Readonly<Record<string, unknown>>; at: number }>()

type Block = ApiContentBlock & { type: string; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown; text?: unknown }

/** Remembers the calls a response row names (`now`: when the row came). */
export function noteUses(blocks: readonly ApiContentBlock[], now: number): void {
  for (const block of blocks as readonly Block[]) {
    if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') continue
    uses.set(block.id, { tool: block.name, input: typeof block.input === 'object' && block.input !== null ? (block.input as Record<string, unknown>) : {}, at: now })
    while (uses.size > MAX_USES) uses.delete(uses.keys().next().value as string)
  }
}

/** A tool_result's content as text: the string it is, or its text blocks joined. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as { type?: unknown; text?: unknown }[]).flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])).join('\n')
}

/**
 * The calls a `tool-result` row ends, each with the call its `tool_use` named; one whose naming row was not seen (a hot
 * reload) and Code Mode's own `REPL` and `Poll` are left out. `tool`: the tool the row's origin names, for a call seen
 * by its result alone.
 */
export function callsEnded(row: { message: { content: readonly ApiContentBlock[] }; agentId?: string }, now: number): RowCall[] {
  const ended: RowCall[] = []
  for (const block of row.message.content as readonly Block[]) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    const use = uses.get(block.tool_use_id)
    if (use === undefined || PLUMBING.has(use.tool)) continue
    ended.push({
      id: block.tool_use_id,
      tool: use.tool,
      input: use.input,
      ...(row.agentId === undefined ? {} : { agentId: row.agentId }),
      isError: block.is_error === true,
      text: textOf(block.content),
      durationMs: Math.max(0, now - use.at),
    })
  }
  return ended
}

/** What a script came to, as the model reads it: the value it returned, or the error it stopped with. */
export type ScriptEnd = { eval: number; text: string; failed: boolean }

const SCRIPT_EVENT = /<event\b([^>]*)\bkind="repl-eval"([^>]*)>\s*<(result|error)>([\s\S]*)<\/\3>\s*<\/event>/
const ENTITIES: Readonly<Record<string, string>> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' }

/**
 * The script a `queue` row reports the end of (Code Mode): the number it was dispatched under (`(dispatched #n)`), what
 * it returned or the error it threw, as written for the model. Undefined for any other row.
 */
export function scriptEnded(row: { message: { content: unknown } }): ScriptEnd | undefined {
  const text = textOf(row.message.content)
  const found = SCRIPT_EVENT.exec(text)
  if (found === null) return undefined
  const number = /\beval="(\d+)"/.exec(`${found[1]} ${found[2]}`)
  return { eval: number === null ? -1 : Number(number[1]), text: (found[4] ?? '').replace(/&(?:lt|gt|quot|apos|amp);/g, (entity) => ENTITIES[entity] ?? entity).trim(), failed: found[3] === 'error' }
}

/** The Agent calls already matched to the agent they started. */
const taken = new Set<string>()

/**
 * The Agent call that started an agent, told by its task: the latest named call of the Agent tool whose `prompt` is
 * the text the agent's turn starts with, and that no agent has been matched to yet. Its arguments say what the main
 * agent asked for (the `model`, the `description`). Undefined when no such call was named before the agent started: in a
 * Code Mode session a script's calls are named only once its events are delivered, which may be after the agent began.
 */
export function takeAgentCall(prompt: string): { id: string; input: Readonly<Record<string, unknown>> } | undefined {
  const wanted = prompt.trim()
  if (wanted === '') return undefined
  const found = [...uses].reverse().find(([id, use]) => (use.tool === 'Agent' || use.tool === 'Task') && !taken.has(id) && typeof use.input.prompt === 'string' && use.input.prompt.trim() === wanted)
  if (found === undefined) return undefined
  taken.add(found[0])
  while (taken.size > MAX_USES) taken.delete(taken.values().next().value as string)
  return { id: found[0], input: found[1].input }
}

/** Whether a step's response made only Code Mode's wait (`Poll`): a step in which the model did no work of its own. */
export function onlyWaits(toolUses: readonly { name: string }[]): boolean {
  return toolUses.length > 0 && toolUses.every((use) => use.name === 'Poll')
}

export function registerCalls(on: On): void {
  // Every response row, while the other plugin is not there to hear the calls themselves.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    try {
      if (!(await hasExtras(() => $.dispatchPilotExtras.present()))) noteUses(e.message.content, await $.clock.now())
    } catch (error) {
      $.ui.log(`calls: a response row was not read: ${String(error)}`, { to: 'debug' })
    }
    return next(e)
  })
}
