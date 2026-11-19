// Calibration material from a session's own records (calibration plan, Task 3): the records of one session file, read
// the way the mod would have read that session, so a case built from them holds the request the mod would really have
// sent. Pure: mine.ts reads the files and imports this; the tests import it too, so no node: module here.
//
// A record file is JSON lines, not session.append events. eventOf maps a record to the event-like object rowOf and
// kindOf take, door by door (what each door is inferred from is said there); a turn is then replayed row by row with
// the mod's own planRow, default configuration, judging on. No answer is known, so every checkpoint is taken as a
// hold: no shift is applied, no note queued.
import { readConfig } from '../../hooks/config.ts'
import { kindOf, rowOf } from '../../hooks/journal.ts'
import type { RowKind } from '../../hooks/journal.ts'
import { isLevel } from '../../hooks/levels.ts'
import type { Level } from '../../hooks/levels.ts'
import { planRow } from '../../hooks/midrun.ts'
import { newTurn } from '../../hooks/state.ts'
import type { TurnState } from '../../hooks/state.ts'
import { clip } from '../../hooks/statebuild.ts'
import type { PreviousTurn, StepRecord } from '../../hooks/statebuild.ts'
import { secretsIn } from './case.ts'
import type { MidrunCase } from './case.ts'

export type Mined =
  | { kind: 'submit'; session: string; request: string; previous: PreviousTurn | null }
  /** ended: how the turn ended, one of PreviousTurn['ended']; after: the steps that ended after this row, up to the turn's end. */
  | { kind: 'midrun'; session: string; input: Omit<MidrunCase['input'], 'notes'>; isCheckpoint: boolean; after: StepRecord[]; ended: string }
  | { kind: 'agent'; session: string; task: string; agentType: string; description: string; parentModel: string }

type MidrunMined = Extract<Mined, { kind: 'midrun' }>
type Obj = Record<string, any>
type RowEvent = Parameters<typeof rowOf>[0]

const CFG = readConfig({})
/** The level a replayed turn is judged at when its records show none (the controller's ruling for Task 3). */
const DEFAULT_LEVEL: Level = 'medium'
/** As flows/submit.ts's LAST_REPLY_TOKENS (not importable here: that file imports the engine's runtime). */
const LAST_REPLY_TOKENS = 300
/** As flows/submit.ts's PERSON. A session record names the composer 'human'. */
const PERSON: readonly string[] = ['human', 'composer', 'sdk', 'bridge']
const RESULT_KINDS: readonly RowKind[] = ['tool-result', 'script-result-poll', 'script-result-delivery']
const MAX_RECENT = 5
// The text block the mod adds to a row (midrun.ts noteText) is not part of the row as the mod read it.
const NOTE_PREFIX = '[dispatch-pilot]'
const INTERRUPTED = /^\[Request interrupted/
// A slash command's expansion: what prompt.submit's text was for it cannot be told from the record.
const COMMAND = /^<command-/
const SYNTHETIC = '<synthetic>'

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function isStr(v: unknown): v is string {
  return typeof v === 'string'
}

// A subagent's record: in the main file it is a sidechain one; a subagent's own file (under the session's folder) is
// never read by mine.ts.
function isSubagent(r: Obj): boolean {
  return r.isSidechain === true || isStr(r.agentId)
}

// A message that starts a main-loop turn carries its position among the session's turns. A compaction summary carries
// one too but starts nothing.
function isTurnStart(r: Obj): boolean {
  return r.type === 'user' && isObj(r.turnPosition) && r.isCompactSummary !== true
}

function textOf(content: unknown): string {
  if (isStr(content)) return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => isObj(b) && b.type === 'text' && isStr(b.text))
    .map((b) => b.text as string)
    .join('\n')
}

// Whether the mod judges this message when it is sent (judgeMessage: a person's, by the prompt's origin). Older records
// carry no origin, only turnOrigin or promptSource.
function isPerson(r: Obj): boolean {
  const kind = isObj(r.origin) ? r.origin.kind : r.turnOrigin
  return (isStr(kind) && PERSON.includes(kind)) || r.promptSource === 'sdk'
}

/** The record as the session.append event the engine appended for it, or null for a record the mod never reads mid-turn. */
function eventOf(r: Obj, toolOf: ReadonlyMap<string, string>): RowEvent | null {
  const m = r.message
  if (r.type === 'assistant' && isObj(m) && Array.isArray(m.content)) {
    // Door response: one record per block, as the engine appends one row per block. A call made inside a Code Mode
    // script is recorded with isVirtual (and a synthetic model); its row carries no role, so kindOf passes it over.
    const role = r.isVirtual === true ? {} : { role: 'assistant' }
    return { door: 'response', origin: { kind: 'model' }, message: { type: 'assistant', ...role, content: m.content } }
  }
  if (r.type === 'user' && isObj(m) && Array.isArray(m.content)) {
    // Door tool-result: a user record holding a tool_result, the tool named by its call's tool_use id. One with
    // isVirtual is a call inside a script, whose row has no role (E7: kindOf reads it as an inner call).
    const first = m.content.find((b: unknown) => isObj(b) && b.type === 'tool_result')
    // Any other user record (a person's text, a meta record, an interrupt marker) is no row the mod reads mid-turn:
    // input during a turn arrives as a queued_command attachment.
    if (first === undefined) return null
    const tool = toolOf.get(first.tool_use_id) ?? 'unknown'
    const content = m.content.filter((b: unknown) => !(isObj(b) && b.type === 'text' && isStr(b.text) && b.text.startsWith(NOTE_PREFIX)))
    const role = r.isVirtual === true ? {} : { role: 'user' }
    return { door: 'tool-result', origin: { kind: 'tool', tool }, message: { type: 'user', ...role, content } }
  }
  if (r.type === 'attachment' && isObj(r.attachment)) {
    const a = r.attachment
    const delivery = (text: string | null): RowEvent => ({
      door: 'delivery',
      origin: { kind: 'engine' },
      message: { type: 'attachment', role: 'user', content: text === null ? [] : [{ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }] },
    })
    // Door delivery, name poll_events: the events it delivered. Its envelopes are empty when the step called Poll and
    // the result came in Poll's own result (dispatch-pilot-real-rows.md: that delivery row has no blocks).
    if (a.type === 'poll_events') {
      const envelopes = Array.isArray(a.envelopes) ? a.envelopes.filter(isStr) : []
      return delivery(envelopes.length > 0 ? envelopes.join('\n') : null)
    }
    // Door delivery, name queued_command: input sent into the running turn (DEVELOPMENT.md, 引擎规则). Only that it is
    // input matters to what is mined here; the engine's own wording of the row is not in the record.
    if (a.type === 'queued_command' && isStr(a.prompt) && a.prompt.trim() !== '') return delivery(a.prompt)
  }
  return null
}

type Turn = { start: Obj; records: Obj[] }

// The level the turn's first step carried, as the session's records show it.
function recordedLevel(records: readonly Obj[]): Level | null {
  const first = records.find((r) => r.type === 'assistant' && r.isVirtual !== true)
  return first !== undefined && isLevel(first.effort) ? first.effort : null
}

// How the turn ended and its final visible text (turn.complete's answer: the last response's text blocks).
function endOf(records: readonly Obj[]): { ended: PreviousTurn['ended']; answer: string } {
  const interrupted = records.some((r) => r.type === 'user' && INTERRUPTED.test(textOf(r.message?.content).trim()))
  const responses = records.filter((r) => r.type === 'assistant' && r.isVirtual !== true && isObj(r.message))
  const last = responses.at(-1)
  const id = last?.message.id
  const answer = last === undefined ? '' : responses.filter((r) => (id === undefined ? r === last : r.message.id === id)).map((r) => textOf(r.message.content)).filter((t) => t !== '').join('\n')
  const ended = interrupted ? 'interrupted' : last?.isApiErrorMessage === true ? 'error' : 'answered'
  return { ended, answer }
}

// The steps of the whole turn: the journal keeps only its last few. A step that ended is appended (the old last moves
// one back); a result that joined its response's step replaces the last in place (journal.ts).
function trackSteps(all: StepRecord[], before: readonly StepRecord[], after: readonly StepRecord[]): void {
  const last = after.at(-1)
  if (last === undefined || last === before.at(-1)) return
  if (before.length === 0 || after.at(-2) === before.at(-1)) all.push(last)
  else all[all.length - 1] = last
}

type Session = { id: string; toolOf: ReadonlyMap<string, string>; codeMode: boolean; previous: PreviousTurn | null; parentModel: string }

function agentOf(s: Session, use: Obj): Mined | null {
  const input = isObj(use.input) ? use.input : {}
  // The engine resolves a call that names no type to general-purpose. The mod leaves a fork and a resumed run alone.
  const agentType = isStr(input.subagent_type) && input.subagent_type !== '' ? input.subagent_type : 'general-purpose'
  if (agentType === 'fork' || input.resume !== undefined || !isStr(input.prompt)) return null
  return { kind: 'agent', session: s.id, task: input.prompt, agentType, description: isStr(input.description) ? input.description : '', parentModel: s.parentModel }
}

function replay(s: Session, turn: Turn, index: number, out: Mined[]): void {
  const request = textOf(turn.start.message?.content)
  if (isPerson(turn.start) && !COMMAND.test(request.trim())) out.push({ kind: 'submit', session: s.id, request, previous: s.previous })
  const level = recordedLevel(turn.records)
  const current = level ?? DEFAULT_LEVEL
  let state: TurnState = { ...newTurn(`turn-${index}`, request), base: current }
  const all: StepRecord[] = []
  const open: { item: MidrunMined; at: number }[] = []
  for (const r of turn.records) {
    if (r.type === 'assistant' && isObj(r.message)) {
      if (r.isVirtual !== true && isStr(r.message.model) && r.message.model !== SYNTHETIC) s.parentModel = r.message.model
      // An Agent call spawns whether the main loop or a script made it.
      for (const b of Array.isArray(r.message.content) ? r.message.content : []) {
        if (!isObj(b) || b.type !== 'tool_use' || b.name !== 'Agent') continue
        const agent = agentOf(s, b)
        if (agent !== null) out.push(agent)
      }
    }
    const e = eventOf(r, s.toolOf)
    if (e === null) continue
    const row = rowOf(e)
    const kind = kindOf(row)
    if (kind === 'other') continue
    // As onRow: a receipt makes this a Code Mode session from this row on.
    if (kind === 'receipt') s.codeMode = true
    const before = state.journal.steps
    const plan = planRow(state, row, kind, { cfg: CFG, codeMode: s.codeMode, judging: true })
    state = plan.turn
    trackSteps(all, before, state.journal.steps)
    if (!RESULT_KINDS.includes(kind)) continue
    const j = state.journal
    const latest = j.steps.at(-1)
    if (latest === undefined) continue
    const item: MidrunMined = {
      kind: 'midrun',
      session: s.id,
      input: { request, current, stepsSoFar: j.workSteps, failedSteps: j.failedSteps, recent: j.steps.slice(0, -1).slice(-MAX_RECENT), latest, statedNext: j.statedNext, codeMode: s.codeMode },
      isCheckpoint: plan.ask !== null,
      after: [],
      ended: 'answered',
    }
    out.push(item)
    open.push({ item, at: all.length })
  }
  const { ended, answer } = endOf(turn.records)
  for (const { item, at } of open) {
    item.after = all.slice(at)
    item.ended = ended
  }
  // As endTurn: the turn the next message's judgement sees.
  s.previous = { request, lastReply: clip(answer, LAST_REPLY_TOKENS), ended, level }
}

/** 一个会话的记录（JSONL 逐行解析后的对象）里能当素材的地方；不认识的记录跳过。 */
export function mine(session: string, records: readonly unknown[]): Mined[] {
  const main = records.filter(isObj).filter((r) => !isSubagent(r))
  const toolOf = new Map<string, string>()
  for (const r of main) {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue
    for (const b of r.message.content) if (isObj(b) && b.type === 'tool_use' && isStr(b.id) && isStr(b.name)) toolOf.set(b.id, b.name)
  }
  // Amendments A2, A13: a case keys its set on the first 8 characters of the session id.
  const s: Session = { id: session.slice(0, 8), toolOf, codeMode: false, previous: null, parentModel: '' }
  // Records before the first message belong to no turn: the mod reads rows only while a turn is held.
  const turns: Turn[] = []
  for (const r of main) {
    if (isTurnStart(r)) turns.push({ start: r, records: [] })
    else turns.at(-1)?.records.push(r)
  }
  const out: Mined[] = []
  turns.forEach((turn, i) => replay(s, turn, i, out))
  return out
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把本机主目录换成 /Users/user，把用户名换成 user。 */
export function scrub(text: string, home: string, user: string): string {
  let out = text
  const root = home.replace(/\/+$/, '')
  // Only the whole directory name: /Users/someone must not turn /Users/someoneelse into /Users/userelse.
  if (root !== '') out = out.replace(new RegExp(`${escapeRegExp(root)}(?![\\w.-])`, 'g'), '/Users/user')
  if (user !== '') out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(user)}(?![A-Za-z0-9_])`, 'g'), 'user')
  return out
}

function mapStrings<T>(v: T, f: (s: string) => string): T {
  if (isStr(v)) return f(v) as T
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f)) as T
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)])) as T
  return v
}

function stringsOf(v: unknown, out: string[] = []): string[] {
  if (isStr(v)) out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => stringsOf(x, out))
  else if (isObj(v)) Object.values(v).forEach((x) => stringsOf(x, out))
  return out
}

/** What mine.ts writes: every text scrubbed, and the items still holding a key, a token or a user's path dropped and counted. */
export function screen(items: readonly Mined[], home: string, user: string): { kept: Mined[]; dropped: number } {
  const kept: Mined[] = []
  let dropped = 0
  for (const item of items) {
    const clean = mapStrings(item, (t) => scrub(t, home, user))
    if (stringsOf(clean).some((t) => secretsIn(t).length > 0)) dropped += 1
    else kept.push(clean)
  }
  return { kept, dropped }
}
