// What a running loop's tool calls say about it, kept as the calls end (ADR 0020): the latest steps the decision model is
// shown, the counts the state gives as facts, and the events at which the code asks again. The events are the run's own, never
// a timer: 0.8.x asked every few steps, and of the answers that should have kept the level three in ten moved it.
//
//   failure    a command failed again after a fix was tried (a file was edited since it last failed), a command that
//              passed earlier fails after an edit, or the same first error line came back on the next failing step.
//              A command is a shell command by its class, or an MCP server's tool by its name (a build, a test run).
//              One failure alone is none: most are a refused call or a mistyped command, mended in a step.
//   resolved   the command a raise was for passes again (no question asked: the code takes the raise back)
//   skill      a skill was loaded: its instructions are the work ahead
//   handback   a dispatched agent or a Workflow ran in the foreground and handed its result back with its call (one only
//              launched answers at once, and its result comes later as a report: features/midrun-effort.ts)
//   todo       the assistant's task list moved to another item (TodoWrite, TaskUpdate, a host's plan tool)
//
// A call a hook or the person refused is nobody's failure and moves nothing here.
//
// Pure (see system-one.ts).

import { clipToTokens } from './context.ts'
import { errorLine } from './escalation.ts'
import { toolTarget, type CallOutcome, type MidrunStep, type MidrunTool } from './midrun.ts'
import { redactSecrets } from './redact.ts'

/** Steps kept for the state (it shows the latest eight), and the tool calls kept of one step (the latest; the state shows fewer). */
const MAX_RECENT = 10
const STEP_CALLS = 24
/** Commands remembered at most, the one seen longest ago dropped first. */
const MAX_CLASSES = 16
/** A dispatched agent or a Workflow that took at least this long ran in the foreground: its call's result is its hand-back (a background launch answers at once). */
const FOREGROUND_MS = 5000
/** The task list is not read as moving on before this step: the first item of a turn is what the message was just decided for. */
const TODO_FROM_STEP = 6
/** An item of the task list is kept this long. */
const ITEM_KEY_TOKENS = 120

/** What is kept of one command (decision/midrun-track.ts `commandClass`). */
export type CommandRecord = {
  /** Times it passed and failed in this loop. */
  ok: number
  failed: number
  /** How it last ended. */
  last: 'ok' | 'failed'
  /** The loop's count of file edits when it last ended: more since then means something was tried in between. */
  editsAtLast: number
  /** Times in a row it failed again after an edit. */
  refails: number
  /** Its latest failure's first line, masked and clipped; '' when it never failed. */
  error: string
  /** The step it was last seen in. */
  seenAt: number
}

/** One loop's record while it runs (`midrun` in types/index.d.ts): the main agent's for one turn. */
export type MidrunRecord = {
  turnId: string
  /** The loop's latest step, the engine's own effort on it (null for a model without one), and the tool calls that ended in it so far. */
  step: number
  engine: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  toolsInStep: number
  /** The tool calls the latest step's response asked for; null until the response is in. A step that asked for none and is followed by another in the same turn was followed by input. */
  uses: number | null
  /** Tool calls that ended since the loop began, and those that failed. */
  calls: number
  failed: number
  /** The latest steps, oldest first. */
  recent: MidrunStep[]
  /** The commands seen, by class. */
  commands: Record<string, CommandRecord>
  /** File edits that went through. */
  edits: number
  /** The latest failing step's first error line, its key and its step; null before any. */
  lastError: { line: string; key: string; step: number } | null
  /** The item of the task list in progress when it was last written; null before any. */
  todo: string | null
  /** The command a raise was for (null: the level is not raised for a failure), the step it was raised at, and whether that command has passed since. */
  raisedFor: string | null
  raisedAt: number | null
  resolved: boolean
  /** A red flag raised the loop this turn: nothing lowers it under its base again. */
  ratchet: boolean
  /** A failure of this turn already read as one whose cause is not found. */
  stuck: boolean
  /** The highest level the stakes asked for this turn (null: none): a raise taken back when its command passes goes no lower. */
  stakesFloor: MidrunRecord['engine']
  /** Rows appended for a switch this turn, and the step of the last. */
  switches: number
  switchedAt: number | null
  /** Times the decision model was asked this turn, and the step of the last. */
  judged: number
  judgedAt: number | null
}

export function newRecord(turnId: string): MidrunRecord {
  return { turnId, step: 0, engine: null, toolsInStep: 0, uses: null, calls: 0, failed: 0, recent: [], commands: {}, edits: 0, lastError: null, todo: null, raisedFor: null, raisedAt: null, resolved: false, ratchet: false, stuck: false, stakesFloor: null, switches: 0, switchedAt: null, judged: 0, judgedAt: null }
}

/** An event of the run at which the level is looked at again. */
export type MidrunEvent =
  | { kind: 'failure'; command: string; why: 'refail' | 'regression' | 'same-line'; refails: number; latest: string; earlier: string | null }
  | { kind: 'resolved'; command: string }
  | { kind: 'skill'; name: string }
  | { kind: 'handback'; tool: string; what: string }
  | { kind: 'todo'; item: string; done: number; total: number }

/** A tool call as it ended. */
export type CallEnd = {
  tool: string
  input: Readonly<Record<string, unknown>>
  outcome: CallOutcome
  /** What the tool said (a failure's text is read for its first line; nothing else of it is kept). */
  text?: string
  /** The step it was made in, and how long it ran. */
  step: number
  durationMs: number
}

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** An MCP tool that changes files or settings, by the last part of its name (`mcp__xcode__XcodeUpdate`, `…__write_file`). */
const MCP_EDIT = /write|edit|update|patch|replace/i
/** A shell command that writes files: a here-document, an in-place `sed` or `perl`, a patch, a git command that rewrites the tree, an output sent to a file. */
const SHELL_WRITES = /<<-?\s*['"]?\w|\bsed\s+(?:-\w+\s+)*-\w*i|\bperl\s+-\w*i|\bgit\s+(?:apply|am|checkout|restore|revert|stash\s+pop)\b|\bpatch\s|(?:^|[^0-9&>])>>?\s*(?!\/dev\/null|&)[\w.~/-]/
const DISPATCH_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'Workflow'])
/** What a dispatch tool answers when it only started its agent or Workflow (`Async agent launched successfully`, `Workflow launched in background`): nothing has come back with it, however long the call took (the mod's own routing of the dispatch waits inside it). */
const LAUNCHED = /^.{0,60}\blaunched\b/is
/** The tools an assistant keeps its task list with: Claude Code's own, and a host's plan tool (`mcp__…__update_plan`). */
const LIST_TOOL = /^(?:TodoWrite|TaskUpdate)$|(?:^|__)update_plan$/

/** Whether a tool changes files: Claude Code's edit tools, or an MCP server's by its name. */
function isEdit(tool: string): boolean {
  return EDIT_TOOLS.has(tool) || (tool.startsWith('mcp__') && MCP_EDIT.test(tool.slice(tool.lastIndexOf('__') + 2)))
}

/** Words a command starts with that say nothing of what it runs; their own options and a duration go with them. */
const WRAPPERS: ReadonlySet<string> = new Set(['time', 'sudo', 'command', 'env', 'nohup', 'exec', 'timeout', 'gtimeout', 'nice', 'stdbuf', 'caffeinate', 'xcrun'])
const SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'zsh'])
const INTERPRETERS: ReadonlySet<string> = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'deno', 'bun', 'php'])
/** Segments that only set the scene for the command after them. */
const SCENE = /^(?:(?:cd|pushd|popd|export|source|set|unset|ulimit|umask)\b|\.\s)/
/** A redirection (`2>&1`, `>out.txt`, `<in`, `&>log`): where the output goes, not what runs. */
const REDIRECT = /^(?:\d*[<>]|&>)/
/** A class is this many words of a command at most. */
const CLASS_WORDS = 4

/**
 * The class of a shell command: the first four words of what it runs, masked and lowercased. What it runs is the first
 * segment, on any line, that is not `cd …`, `export …`, `source …`; before a pipe; without redirections, `NAME=value`, a
 * wrapper in front (`time`, `timeout 60`, `sudo`) or a shell handed the command (`bash -lc "…"`), and without its options
 * (`pnpm --filter api test` and `pnpm --filter api build` are two classes, `pnpm test auth --watch` and `pnpm test auth`
 * one). '' when nothing is left, and for a script written on the spot (a here-document, `python -c`): no two of those are
 * the same command.
 */
export function commandClass(command: string): string {
  if (/<<-?\s*['"]?\w/.test(command)) return ''
  const segments = command
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .flatMap((line) => line.split(/&&|\|\||;/))
    .map((segment) => segment.trim().replace(/^[({]+\s*/, '').replace(/\s*[)}]+$/, ''))
    .filter((segment) => segment !== '')
  const run = segments.find((segment) => !SCENE.test(segment)) ?? ''
  const wordsOf = (text: string): string[] => text.split(/\s+/).filter((word) => word !== '' && !REDIRECT.test(word))
  let words = wordsOf(run.split('|')[0] ?? '')
  for (;;) {
    const first = words[0]
    if (first === undefined) break
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) words.shift()
    else if (WRAPPERS.has(first)) {
      words.shift()
      while (words[0] !== undefined && (words[0].startsWith('-') || /^\d+(?:\.\d+)?[smhd]?$/.test(words[0]))) words.shift()
    } else if (SHELLS.has(first) && /^-\w*c$/.test(words[1] ?? '')) words = wordsOf(words.slice(2).join(' ').replace(/^['"]/, '').replace(/['"]$/, ''))
    else break
  }
  if (INTERPRETERS.has(words[0] ?? '') && words.some((word) => word === '-c' || word === '-e' || word === '-')) return ''
  return redactSecrets(words.filter((word) => !word.startsWith('-')).slice(0, CLASS_WORDS).join(' ')).toLowerCase().slice(0, 80)
}

/** What a failed call said, without the tool's name `errorLine` puts in front of it; '' when it said nothing (the line is the tool alone). */
function saidOf(line: string): string {
  const colon = line.indexOf(': ')
  return colon < 0 ? '' : line.slice(colon + 2).trim()
}

/** An error line as two failures are compared by it: numbers and hex runs out, whitespace collapsed, lowercased. '' for a call that said nothing. */
export function errorKey(line: string): string {
  return saidOf(line).toLowerCase().replace(/0x[0-9a-f]+/g, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
}

/** Error lines every failure may end in, which say nothing of what went wrong: two of them are not one fault. */
const GENERIC = /^(?:shell cwd was reset|command timed out|request timed out|exit (?:status|code) #$|(?:command )?failed$|errors?:?$|permission denied$|killed$|terminated$|operation not permitted$|interrupted|traceback \(most recent call last\)|npm (?:err!|error)(?: code \S+)?$|[=*_~>-]{3,}|usage:|warning:)/

/** The record with a tool call's ending added to its step (the steps kept oldest first, the latest `MAX_RECENT`). */
function withTool(record: MidrunRecord, step: number, tool: MidrunTool): MidrunStep[] {
  const at = record.recent.findIndex((one) => one.step === step)
  const recent = [...record.recent]
  if (at >= 0) {
    const one = recent[at] as MidrunStep
    const tools = [...one.tools, tool]
    const over = tools.length - STEP_CALLS
    recent[at] = over > 0 ? { ...one, earlier_calls_not_shown: (one.earlier_calls_not_shown ?? 0) + over, tools: tools.slice(over) } : { ...one, tools }
  } else recent.push({ step, assistant_text: '', tools: [tool] })
  return recent.sort((a, b) => a.step - b.step).slice(-MAX_RECENT)
}

/** The record with what the assistant wrote in a step, once the step has streamed whole. */
export function withText(record: MidrunRecord, step: number, text: string): MidrunRecord {
  const at = record.recent.findIndex((one) => one.step === step)
  const recent = [...record.recent]
  if (at >= 0) recent[at] = { ...(recent[at] as MidrunStep), assistant_text: text }
  else if (text.trim() !== '') recent.push({ step, assistant_text: text, tools: [] })
  return { ...record, recent: recent.sort((a, b) => a.step - b.step).slice(-MAX_RECENT) }
}

/** The record as a step of the loop starts: where it is, the engine's own effort, no call ended in it yet and its response not in. */
export function atStep(record: MidrunRecord, step: number, engine: MidrunRecord['engine']): MidrunRecord {
  return { ...record, step, engine, toolsInStep: 0, uses: null }
}

/** The record with a step's response, once it has streamed whole: what the assistant wrote, and how many tool calls it asked for. */
export function withResponse(record: MidrunRecord, step: number, text: string, uses: number): MidrunRecord {
  const written = text.trim() === '' ? record : withText(record, step, text)
  return written.step === step ? { ...written, uses } : written
}

/** The commands with one more, the one seen longest ago dropped past `MAX_CLASSES`. */
function withCommand(commands: Readonly<Record<string, CommandRecord>>, name: string, kept: CommandRecord): Record<string, CommandRecord> {
  const next = { ...commands, [name]: kept }
  const names = Object.keys(next)
  if (names.length <= MAX_CLASSES) return next
  const oldest = names.filter((one) => one !== name).sort((a, b) => (next[a] as CommandRecord).seenAt - (next[b] as CommandRecord).seenAt)[0] as string
  const { [oldest]: _dropped, ...rest } = next
  return rest
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * A task list's move as a list tool's call tells it: the item now in progress ('' when the call does not name it), a key the
 * same item keeps from call to call, and how far the list is (`total` 0 when the call does not carry the list).
 *
 *   TodoWrite, a plan tool's `items`   the whole list: the item whose status is `in_progress`
 *   a plan tool's `start`              the item it names
 *   a plan tool's `advance`            the next item, unnamed
 *   TaskUpdate to `in_progress`        one task by its id; named only when the call also gives its subject
 */
function listMove(tool: string, input: Readonly<Record<string, unknown>>, step: number): { key: string; item: string; done: number; total: number } | null {
  const rows = Array.isArray(input.todos) ? (input.todos as unknown[]) : Array.isArray(input.items) ? (input.items as unknown[]) : null
  if (rows !== null) {
    const items = rows.filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null)
    const doing = items.find((one) => one.status === 'in_progress')
    const item = textOf(doing?.content) || textOf(doing?.subject) || textOf(doing?.title) || textOf(doing?.text)
    return item === '' ? null : { key: item, item, done: items.filter((one) => one.status === 'completed' || one.status === 'done').length, total: items.length }
  }
  const start = textOf(input.start)
  if (start !== '') return { key: start, item: start, done: Array.isArray(input.done) ? input.done.length : 0, total: 0 }
  if (input.advance !== undefined && input.advance !== null && input.advance !== false) return { key: `advance@${step}`, item: '', done: 0, total: 0 }
  if (tool === 'TaskUpdate' && input.status === 'in_progress') {
    const item = textOf(input.subject) || textOf(input.activeForm)
    const id = textOf(input.taskId)
    return item === '' && id === '' ? null : { key: item !== '' ? item : `#${id}`, item, done: 0, total: 0 }
  }
  return null
}

/**
 * The record with a call that ended, and the event it makes of the run, if any. A refused call (a hook's, the person's) is
 * counted as a call and changes nothing else.
 */
export function noteCall(record: MidrunRecord, call: CallEnd): { record: MidrunRecord; event: MidrunEvent | null } {
  const target = toolTarget(call.input)
  const failedLine = call.outcome === 'failed' ? errorLine(call.tool, call.text) : ''
  const shown: MidrunTool = { tool: call.tool, target, outcome: call.outcome, ...(saidOf(failedLine) === '' ? {} : { error: saidOf(failedLine) }) }
  let next: MidrunRecord = { ...record, calls: record.calls + 1, failed: record.failed + (call.outcome === 'failed' ? 1 : 0), toolsInStep: record.toolsInStep + 1, recent: withTool(record, call.step, shown) }
  if (call.outcome === 'blocked' || call.outcome === 'denied') return { record: next, event: null }
  const ok = call.outcome === 'ok'

  if (call.tool === 'Skill') {
    const name = typeof call.input.skill === 'string' ? call.input.skill.trim() : ''
    return { record: next, event: ok && name !== '' ? { kind: 'skill', name: clipToTokens(redactSecrets(name), 24) } : null }
  }
  if (DISPATCH_TOOLS.has(call.tool)) {
    const handedBack = ok && call.durationMs >= FOREGROUND_MS && !LAUNCHED.test((call.text ?? '').trim())
    return { record: next, event: handedBack ? { kind: 'handback', tool: call.tool, what: target } : null }
  }
  if (LIST_TOOL.test(call.tool)) {
    const list = ok ? listMove(call.tool, call.input, call.step) : null
    if (list === null) return { record: next, event: null }
    const key = clipToTokens(redactSecrets(list.key), ITEM_KEY_TOKENS)
    const moved = record.todo !== null && record.todo !== key && call.step >= TODO_FROM_STEP
    return { record: { ...next, todo: key }, event: moved ? { kind: 'todo', item: clipToTokens(redactSecrets(list.item), ITEM_KEY_TOKENS), done: list.done, total: list.total } : null }
  }
  if (isEdit(call.tool)) {
    if (ok) next = { ...next, edits: next.edits + 1 }
    return { record: next, event: null }
  }
  // What is run and can fail again: a shell command by its class, an MCP server's tool by its name (a build, a test run).
  const shell = call.tool === 'Bash' ? (typeof call.input.command === 'string' ? call.input.command : '') : null
  if (shell === null && !call.tool.startsWith('mcp__')) return { record: next, event: null }
  // A shell command that wrote files is a fix tried, like an edit.
  if (shell !== null && ok && SHELL_WRITES.test(shell)) next = { ...next, edits: next.edits + 1 }
  const name = shell === null ? call.tool.toLowerCase().slice(0, 80) : commandClass(shell)
  if (name === '') return { record: next, event: null }
  const seen = record.commands[name]
  // An MCP tool is followed only once it has failed: the many that never do would crowd the commands out.
  if (shell === null && ok && seen === undefined) return { record: next, event: null }
  if (ok) {
    // `next.edits` counts this call's own writing already: a command that writes files is not its own fix.
    const kept: CommandRecord = { ok: (seen?.ok ?? 0) + 1, failed: seen?.failed ?? 0, last: 'ok', editsAtLast: next.edits, refails: 0, error: seen?.error ?? '', seenAt: call.step }
    const resolves = record.raisedFor === name && !record.resolved
    return { record: { ...next, commands: withCommand(next.commands, name, kept), ...(resolves ? { resolved: true } : {}) }, event: resolves ? { kind: 'resolved', command: name } : null }
  }
  const key = errorKey(failedLine)
  const edited = seen !== undefined && next.edits > seen.editsAtLast
  const refail = seen?.last === 'failed' && edited
  const regression = seen?.last === 'ok' && edited
  const earlier = record.lastError
  const sameLine = key !== '' && !GENERIC.test(key) && earlier !== null && earlier.key === key && earlier.step < call.step
  const refails = refail ? (seen?.refails ?? 0) + 1 : (seen?.refails ?? 0)
  const kept: CommandRecord = { ok: seen?.ok ?? 0, failed: (seen?.failed ?? 0) + 1, last: 'failed', editsAtLast: next.edits, refails, error: failedLine, seenAt: call.step }
  next = { ...next, commands: withCommand(next.commands, name, kept), lastError: { line: failedLine, key, step: call.step }, ...(record.raisedFor === name ? { resolved: false } : {}) }
  if (!refail && !regression && !sameLine) return { record: next, event: null }
  const before = refail ? (seen?.error ?? '') : sameLine ? (earlier?.line ?? '') : ''
  return { record: next, event: { kind: 'failure', command: name, why: refail ? 'refail' : regression ? 'regression' : 'same-line', refails, latest: failedLine, earlier: before === '' ? null : before } }
}

/**
 * What the code counted, as sentences the state gives the decision model (`facts`): it does not count reliably and reads
 * times as text (TypeSafe's model jaggedness), so the counting is done here.
 */
export function factsOf(record: MidrunRecord, event: MidrunEvent | { kind: 'report' }): string[] {
  const facts: string[] = []
  if (event.kind === 'failure') {
    if (event.why === 'refail') facts.push(`The command \`${event.command}\` failed again after the assistant edited files since its last failure${event.refails > 1 ? `: ${event.refails} times in a row now` : ''}.`)
    if (event.why === 'regression') facts.push(`The command \`${event.command}\` passed earlier in this run and fails now, after the assistant edited files.`)
    if (event.why === 'same-line') facts.push('The latest failure has the same first error line as the failure before it.')
  }
  if (event.kind === 'skill') facts.push(`The assistant has just loaded the skill "${event.name}": its instructions are part of the work ahead.`)
  if (event.kind === 'handback') facts.push(`A dispatched agent's result has just come back to the assistant (the latest ${event.tool} call in \`recent_steps\`).`)
  if (event.kind === 'todo') facts.push(event.total > 0 ? `The assistant's task list has ${event.done} of ${event.total} items done; it has just moved on to \`next_item\`.` : `The assistant's task list has just moved on to ${event.item === '' ? 'its next item' : '`next_item`'}.`)
  if (event.kind === 'report') facts.push('A report was just delivered to the assistant while it works (`report`): a background task or a dispatched agent finished.')
  if (record.failed > 0) facts.push(`${record.failed} of the ${record.calls} tool calls of this run failed.`)
  const editedAt = [...record.recent].reverse().find((step) => step.tools.some((tool) => isEdit(tool.tool) && tool.outcome === 'ok'))?.step
  if (record.edits === 0) facts.push('The assistant has not edited any file in this run.')
  else if (editedAt === undefined && record.recent.length >= 5) facts.push(`No file was edited in the latest ${record.recent.length} steps.`)
  return facts
}
