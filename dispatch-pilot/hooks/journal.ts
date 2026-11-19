// Reads the rows the engine appends to the session (session.append) into a small record of the current
// turn: which steps ran, with which tools, whether they failed and how their results began. midrun.ts decides
// from it when to judge the effort again. Pure: no $ calls. The row shapes are the engine's, measured on
// 2.1.326/2.1.327 (design 3.2, E7 and E13; the rows of a real Code Mode turn in docs/research/dispatch-pilot-real-rows.md); only
// main-loop rows count, a subagent's row is 'other'.
import { clip } from './statebuild.ts'
import type { StepRecord } from './statebuild.ts'
import type { TurnJournal } from './state.ts'

export { emptyJournal } from './state.ts'
export type { TurnJournal } from './state.ts'

export type Row = {
  door: string
  tool: string | null
  role: 'user' | 'assistant' | null
  type: string
  agentId: string | null
  text: string
  isError: boolean
  toolUses: { name: string; description: string }[]
}

/** new-input: a prompt row (the person's message) during a turn; delivered-input: other input that came on a delivery row. */
export type RowKind =
  | 'receipt'
  | 'script-result-poll'
  | 'script-result-delivery'
  | 'inner-call'
  | 'tool-result'
  | 'new-input'
  | 'delivered-input'
  | 'assistant'
  | 'other'

const STEPS_KEEP = 6
const STATED_NEXT_TOKENS = 200
// The longest any decision state quotes a step's result (midrunState's latest); more would only weigh on $.state.
const RESULT_TOKENS = 600
const ERROR_TOKENS = 200

const RECEIPT = /^\(dispatched #\d+\)$/
// A script's result event, and the status event of a script still running. The quotes may arrive
// backslash-escaped (text that was JSON-encoded on the way).
const SCRIPT_EVENT = /kind=\\?"repl-eval\\?"/
const STATUS_EVENT = /kind=\\?"repl-status\\?"/
const EDITS = new Set(['Edit', 'Write', 'NotebookEdit'])

// A row whose message is not the shape the types promise: kindOf classes it as 'other'.
const UNREADABLE: Row = { door: '', tool: null, role: null, type: '', agentId: null, text: '', isError: false, toolUses: [] }

function blockText(b: any): string {
  if (b === null || typeof b !== 'object') return ''
  if (b.type === 'text' && typeof b.text === 'string') return b.text
  if (b.type === 'tool_result') {
    if (typeof b.content === 'string') return b.content
    if (Array.isArray(b.content)) return b.content.map(blockText).filter((t: string) => t !== '').join('\n')
  }
  return ''
}

export function rowOf(e: { door: string; origin: { kind: string; tool?: string }; agentId?: string; message: { type: string; role?: string; content: readonly any[] } }): Row {
  try {
    const content: unknown = e?.message?.content
    if (!Array.isArray(content)) return UNREADABLE
    const role = e.message.role === 'user' || e.message.role === 'assistant' ? e.message.role : null
    const origin: any = e.origin
    const toolUses: Row['toolUses'] = []
    for (const b of content) {
      if (b === null || typeof b !== 'object' || b.type !== 'tool_use' || typeof b.name !== 'string') continue
      const description = typeof b.input?.description === 'string' ? b.input.description : ''
      toolUses.push({ name: b.name, description })
    }
    return {
      door: typeof e.door === 'string' ? e.door : '',
      tool: origin !== null && typeof origin === 'object' && origin.kind === 'tool' && typeof origin.tool === 'string' ? origin.tool : null,
      role,
      type: typeof e.message.type === 'string' ? e.message.type : '',
      agentId: typeof e.agentId === 'string' ? e.agentId : null,
      text: content.map(blockText).filter((t) => t !== '').join('\n'),
      isError: content.some((b) => b !== null && typeof b === 'object' && b.type === 'tool_result' && b.is_error === true),
      toolUses,
    }
  } catch {
    return UNREADABLE
  }
}

export function kindOf(row: Row): RowKind {
  if (row.agentId !== null) return 'other'
  switch (row.door) {
    case 'response':
      // The response rows of calls inside a script carry no role; only the main loop's are the assistant's.
      return row.role === 'assistant' ? 'assistant' : 'other'
    case 'tool-result':
      if (row.role === null) return 'inner-call'
      if (row.role !== 'user') return 'other'
      // A REPL row that is no receipt (a refused or failed call) ends its step like any tool result.
      if (row.tool === 'REPL') return RECEIPT.test(row.text.trim()) ? 'receipt' : 'tool-result'
      // A Poll that returns while the script still runs (or with late output only) has no result and ends nothing.
      if (row.tool === 'Poll') return scriptResult(row.text) !== null ? 'script-result-poll' : 'other'
      return 'tool-result'
    case 'delivery':
      if (row.role !== 'user') return 'other'
      if (scriptResult(row.text) !== null) return 'script-result-delivery'
      // A script's events with no result (a status, late output) are no input either.
      if (SCRIPT_EVENT.test(row.text) || STATUS_EVENT.test(row.text)) return 'other'
      // Input, but told apart from a prompt row: a delivery row cannot carry a shift (design E13).
      return row.text.trim() !== '' ? 'delivered-input' : 'other'
    case 'prompt':
      return 'new-input'
    default:
      return 'other'
  }
}

/**
 * The result of the first script event in the text that has one: what its <result> or <error> holds, not its <log>
 * lines. An event with neither (output logged after the script ended) is passed over. The first, not the last: a
 * result may itself quote such events (a script that read a log of them).
 */
export function scriptResult(text: string): { ok: boolean; result: string } | null {
  let rest = text
  for (let marker = SCRIPT_EVENT.exec(rest); marker !== null; marker = SCRIPT_EVENT.exec(rest)) {
    const event = rest.slice(marker.index)
    // Whichever this event reaches first: its result or error, or its own end.
    const first = /<(result|error)>|<\/event>/.exec(event)
    if (first === null) return null
    const tag = first[1]
    if (tag === undefined) {
      rest = event.slice(first.index + first[0].length)
      continue
    }
    const body = event.slice(first.index + first[0].length)
    // The event's own closing: the tag right before </event>. Failing that, the last closing tag, else the rest.
    const ownEnd = new RegExp(`</${tag}>(?:\\s|\\\\n)*</event>`).exec(body)
    const end = ownEnd !== null ? ownEnd.index : body.lastIndexOf(`</${tag}>`)
    return { ok: tag === 'result', result: end < 0 ? body : body.slice(0, end) }
  }
  return null
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  return clip(line.trim() || 'error', ERROR_TOKENS)
}

// An error seen: it repeats when it equals the last one and something was changed in between.
function noteError(j: TurnJournal, line: string): TurnJournal {
  return { ...j, lastError: line, editedSinceError: false, sameErrorRepeated: j.lastError === line && j.editedSinceError }
}

function addTool(tools: string[], name: string): string[] {
  return tools.includes(name) ? tools : [...tools, name]
}

function onAssistant(j: TurnJournal, row: Row): TurnJournal {
  // A response: the results after it are a step of their own.
  const next = { ...j, joins: null }
  const said = row.text.trim()
  // No longer sent (calibration, 2026-11-19), still kept: the calibration's miner reads it for its first pass's variants.
  if (said !== '') next.statedNext = clip(said, STATED_NEXT_TOKENS)
  for (const use of row.toolUses) {
    if (EDITS.has(use.name) || use.name === 'REPL') next.editedSinceError = true
    // A REPL step's tools stay empty until its receipt: an empty list means "asked for, not yet dispatched".
    if (use.name === 'REPL') next.open = { did: use.description.trim() || 'REPL', tools: [], failed: false }
    // A Poll beside a REPL only waits for that script's result: it opens no step of its own.
    else if (use.name === 'Poll') next.open = next.open ?? { did: 'Poll', tools: ['Poll'], failed: false }
    else next.open = { did: use.name, tools: [use.name], failed: false }
  }
  return next
}

// The script is dispatched: its step now holds REPL first, which is what makes it a work step.
function onReceipt(j: TurnJournal): TurnJournal {
  let open = j.open
  if (open !== null && open.tools.length === 0) open = { ...open, tools: ['REPL'] }
  else if (open === null || open.tools[0] !== 'REPL') open = { did: 'REPL', tools: ['REPL'], failed: false }
  return { ...j, open, editedSinceError: true, joins: null }
}

function onInnerCall(j: TurnJournal, row: Row): TurnJournal {
  const name = row.tool ?? 'unknown'
  let next = { ...j }
  if (EDITS.has(name)) next.editedSinceError = true
  if (next.open !== null) next.open = { did: next.open.did, tools: addTool(next.open.tools, name), failed: next.open.failed || row.isError }
  if (row.isError) next = noteError(next, firstLine(row.text))
  return next
}

// Ends the open step with its result. work: a step the model did (a script dispatched, a tool called).
function endStep(j: TurnJournal, step: StepRecord, work: boolean, errorLine: string | null): TurnJournal {
  let next: TurnJournal = { ...j, open: null, steps: [...j.steps, step].slice(-STEPS_KEEP), joins: null }
  if (work) next.workSteps += 1
  if (step.ok) return { ...next, consecutiveFailures: 0, sameErrorRepeated: false }
  if (work) next.failedSteps += 1
  next.consecutiveFailures += 1
  if (errorLine !== null) next = noteError(next, errorLine)
  return next
}

function onScriptResult(j: TurnJournal, row: Row): TurnJournal {
  const res = scriptResult(row.text)
  // An event with neither a result nor an error ends nothing.
  if (res === null) return { ...j }
  const open = j.open
  // Only a script whose receipt came is a work step; a Poll that only waited is not.
  const work = open !== null && open.tools[0] === 'REPL'
  const tools = open !== null && open.tools.length > 0 ? open.tools : ['REPL']
  const innerFailed = open?.failed === true
  let errorLine = res.ok ? null : firstLine(res.result)
  // The script's error repeating its failed call's is that same failure, already noted.
  if (innerFailed && errorLine === j.lastError) errorLine = null
  const step = { did: open?.did ?? 'REPL', tools, ok: res.ok && !innerFailed, result: clip(res.result, RESULT_TOKENS) }
  return { ...endStep(j, step, work, errorLine), scriptResults: j.scriptResults + 1 }
}

// An ordinary session's tool result. The first after a response ends its step; the others of the same response (parallel
// calls: no response row between their results) join it, so a response is one work step (GLOSSARY, design 5.14).
function onToolResult(j: TurnJournal, row: Row): TurnJournal {
  const name = row.tool ?? 'unknown'
  const last = j.steps.at(-1)
  if (j.joins !== null && j.open === null && last !== undefined) return joinStep(j, last, row, name, j.joins.failuresBefore)
  // A refused REPL call keeps the description its tool_use gave the step.
  const did = name === 'REPL' && j.open !== null && j.open.tools.length === 0 ? j.open.did : name
  const step = { did, tools: [name], ok: !row.isError, result: clip(row.text, RESULT_TOKENS) }
  return { ...endStep(j, step, true, row.isError ? firstLine(row.text) : null), joins: { failuresBefore: j.consecutiveFailures } }
}

// A further result of the step's response: its tool joins the step, which fails if any of its results failed and keeps
// the failed one's text (else the last's). Counted once: a failure turns an ok step failed (one failed step more, and
// the consecutive failures it would have made), a second failure adds nothing.
function joinStep(j: TurnJournal, last: StepRecord, row: Row, name: string, failuresBefore: number): TurnJournal {
  const step: StepRecord = { did: last.did, tools: addTool(last.tools, name), ok: last.ok && !row.isError, result: last.ok ? clip(row.text, RESULT_TOKENS) : last.result }
  const next: TurnJournal = { ...j, steps: [...j.steps.slice(0, -1), step] }
  if (!(last.ok && row.isError)) return next
  return noteError({ ...next, failedSteps: j.failedSteps + 1, consecutiveFailures: failuresBefore + 1 }, firstLine(row.text))
}

/** The journal after one more row; a new object, the input is left as it was (the engine compares state values). */
export function applyRow(j: TurnJournal, row: Row, kind: RowKind): TurnJournal {
  switch (kind) {
    case 'assistant':
      return onAssistant(j, row)
    case 'receipt':
      return onReceipt(j)
    case 'inner-call':
      return onInnerCall(j, row)
    case 'script-result-poll':
    case 'script-result-delivery':
      return onScriptResult(j, row)
    case 'tool-result':
      return onToolResult(j, row)
    default:
      return { ...j }
  }
}
