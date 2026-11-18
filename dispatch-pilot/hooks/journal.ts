// Reads the rows the engine appends to the session (session.append) into a small record of the current
// turn: which steps ran, with which tools, whether they failed and how their results began. Task 8 decides
// from it when to judge the effort again. Pure: no $ calls. The row shapes are the engine's, measured on
// 2.1.326/2.1.327 (design 3.2, E7 and E13); only main-loop rows count, a subagent's row is 'other'.
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

export type RowKind = 'receipt' | 'script-result-poll' | 'script-result-delivery' | 'inner-call' | 'tool-result' | 'new-input' | 'assistant' | 'other'

const STEPS_KEEP = 6
const STATED_NEXT_TOKENS = 200
// The longest any decision state quotes a step's result (midrunState's latest); more would only weigh on $.state.
const RESULT_TOKENS = 600
const ERROR_TOKENS = 200

const RECEIPT = /^\(dispatched #\d+\)$/
// A script's result event. The quotes may arrive backslash-escaped (text that was JSON-encoded on the way).
const SCRIPT_EVENT = /kind=\\?"repl-eval\\?"/g
const EDITS = new Set(['Edit', 'Write', 'NotebookEdit'])
// How a failed call inside a script shows in its step's tools: the journal has no other place to keep it.
const ERROR_MARK = ' (error)'

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

function hasScriptEvent(text: string): boolean {
  SCRIPT_EVENT.lastIndex = 0
  return SCRIPT_EVENT.test(text)
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
      if (row.tool === 'REPL') return RECEIPT.test(row.text.trim()) ? 'receipt' : 'other'
      // A Poll that returns while the script still runs has no result event and ends nothing.
      if (row.tool === 'Poll') return hasScriptEvent(row.text) ? 'script-result-poll' : 'other'
      return 'tool-result'
    case 'delivery':
      if (row.role !== 'user') return 'other'
      if (hasScriptEvent(row.text)) return 'script-result-delivery'
      return row.text.trim() !== '' ? 'new-input' : 'other'
    case 'prompt':
      return 'new-input'
    default:
      return 'other'
  }
}

/**
 * The result of the first script event in the text: what its <result> or <error> holds, not its <log> lines.
 * The first, not the last: a result may itself quote such events (a script that read a log of them).
 */
export function scriptResult(text: string): { ok: boolean; result: string } | null {
  SCRIPT_EVENT.lastIndex = 0
  const marker = SCRIPT_EVENT.exec(text)
  if (marker === null) return null
  const event = text.slice(marker.index)
  const open = /<(result|error)>/.exec(event)
  if (open === null) return null
  const tag = open[1]!
  const body = event.slice(open.index + open[0].length)
  // The event's own closing: the tag right before </event>. Failing that, the last closing tag, else the rest.
  const ownEnd = new RegExp(`</${tag}>(?:\\s|\\\\n)*</event>`).exec(body)
  const end = ownEnd !== null ? ownEnd.index : body.lastIndexOf(`</${tag}>`)
  return { ok: tag === 'result', result: end < 0 ? body : body.slice(0, end) }
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
  const next = { ...j }
  const said = row.text.trim()
  if (said !== '') next.statedNext = clip(said, STATED_NEXT_TOKENS)
  for (const use of row.toolUses) {
    if (EDITS.has(use.name) || use.name === 'REPL') next.editedSinceError = true
    // A REPL step's tools stay empty until its receipt: an empty list means "asked for, not yet dispatched".
    if (use.name === 'REPL') next.open = { did: use.description.trim() || 'REPL', tools: [] }
    // A Poll beside a REPL only waits for that script's result: it opens no step of its own.
    else if (use.name === 'Poll') next.open = next.open ?? { did: 'Poll', tools: ['Poll'] }
    else next.open = { did: use.name, tools: [use.name] }
  }
  return next
}

// The script is dispatched: its step now holds REPL first, which is what makes it a work step.
function onReceipt(j: TurnJournal): TurnJournal {
  let open = j.open
  if (open !== null && open.tools.length === 0) open = { did: open.did, tools: ['REPL'] }
  else if (open === null || open.tools[0] !== 'REPL') open = { did: 'REPL', tools: ['REPL'] }
  return { ...j, open, editedSinceError: true }
}

function onInnerCall(j: TurnJournal, row: Row): TurnJournal {
  const name = row.tool ?? 'unknown'
  let next = { ...j }
  if (EDITS.has(name)) next.editedSinceError = true
  if (next.open !== null) next.open = { did: next.open.did, tools: addTool(next.open.tools, row.isError ? name + ERROR_MARK : name) }
  if (row.isError) next = noteError(next, firstLine(row.text))
  return next
}

// Ends the open step with its result. work: a step the model did (a script dispatched, a tool called).
function endStep(j: TurnJournal, step: StepRecord, work: boolean, errorLine: string | null): TurnJournal {
  let next: TurnJournal = { ...j, open: null, steps: [...j.steps, step].slice(-STEPS_KEEP) }
  if (work) next.workSteps += 1
  if (step.ok) return { ...next, consecutiveFailures: 0, sameErrorRepeated: false }
  if (work) next.failedSteps += 1
  next.consecutiveFailures += 1
  if (errorLine !== null) next = noteError(next, errorLine)
  return next
}

function onScriptResult(j: TurnJournal, row: Row): TurnJournal {
  const res = scriptResult(row.text) ?? { ok: true, result: '' }
  const open = j.open
  // Only a script whose receipt came is a work step; a Poll that only waited is not.
  const work = open !== null && open.tools[0] === 'REPL'
  const tools = open !== null && open.tools.length > 0 ? open.tools : ['REPL']
  const innerFailed = tools.some((t) => t.endsWith(ERROR_MARK))
  let errorLine = res.ok ? null : firstLine(res.result)
  // The script's error repeating its failed call's is that same failure, already noted.
  if (innerFailed && errorLine === j.lastError) errorLine = null
  const step = { did: open?.did ?? 'REPL', tools, ok: res.ok && !innerFailed, result: clip(res.result, RESULT_TOKENS) }
  return { ...endStep(j, step, work, errorLine), scriptResults: j.scriptResults + 1 }
}

function onToolResult(j: TurnJournal, row: Row): TurnJournal {
  const name = row.tool ?? 'unknown'
  const step = { did: name, tools: [name], ok: !row.isError, result: clip(row.text, RESULT_TOKENS) }
  return endStep(j, step, true, row.isError ? firstLine(row.text) : null)
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
