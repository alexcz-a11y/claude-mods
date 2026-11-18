// What the engine actually sent (design 5.12): the level each main-loop request carried, read at http.fetch, and what a
// reading does to the Decision it checks. Pure: no $ calls. The entry's turn.step hook keeps the steps that are open,
// its http.fetch hook calls classify and passes the request on untouched, and writes what comes of the reading.
//
// Telling the main loop's request from the others is not documented (design 9). Measured on 2.1.327 (E15 and the
// probe's wire log): the engine raises http.fetch once per send, next.origin.plugin "engine"; the main loop's request
// goes out a few to twenty ms after its turn.step starts and carries a `thread` field, which side requests (a title,
// a suggestion, $.model.fork) do not; an agent's request carries one too. What cannot be told apart is 'unsure', and
// is recorded as unverified, never as a level that may be someone else's.
import { isLevel } from './levels.ts'
import type { Level } from './levels.ts'
import { amendLog } from './log.ts'
import type { Decision } from './log.ts'
import type { TurnState } from './state.ts'

/** The main loop's step whose request is on its way; matched: one of its requests was read already. */
export type OpenStep = { turnId: string; index: number; model: string; matched: boolean }

/** unsure: stepOpen tells a request read while a main-loop step was open from one read between steps. */
export type Reading = { kind: 'main'; effort: Level | null } | { kind: 'unsure'; stepOpen: boolean } | { kind: 'ignore' }

const IGNORE: Reading = { kind: 'ignore' }

const SUFFIX = /\[[^\]]*\]$/

/** A model id without one trailing bracket suffix ("[1m]"): the form a step's model and a request's are compared in. */
export function modelBase(id: string): string {
  return id.replace(SUFFIX, '')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// The Messages endpoint itself (count_tokens and batches lie under it), with or without a query (?beta=true), on
// whatever host the engine is pointed at.
function isMessages(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/v1/messages')
  } catch {
    return false
  }
}

/**
 * What one request is. `agentStepsOpen`: the agent steps open now on the open main step's model (modelBase), whose
 * requests look just like the main loop's. The cheap checks come first; a body (it can be hundreds of KB) is parsed once, here, and
 * nothing of it leaves but the level.
 */
export function classify(i: { originPlugin: string | undefined; url: string; body: unknown; open: OpenStep | null; agentStepsOpen: number }): Reading {
  if (i.originPlugin !== 'engine' || !isMessages(i.url) || typeof i.body !== 'string') return IGNORE
  let body: unknown
  try {
    body = JSON.parse(i.body)
  } catch {
    return IGNORE
  }
  if (!isRecord(body) || !('thread' in body)) return IGNORE
  const open = i.open
  if (open === null) return { kind: 'unsure', stepOpen: false }
  if (open.matched || typeof body.model !== 'string' || modelBase(body.model) !== modelBase(open.model) || i.agentStepsOpen > 0) return { kind: 'unsure', stepOpen: true }
  // The top level only: a message that carried a change has an output_config of its own (E6).
  const config = body.output_config
  return { kind: 'main', effort: isRecord(config) && isLevel(config.effort) ? config.effort : null }
}

/** The check a turn waits on: the Decision's id and the level the next main-loop request should carry. */
export type Awaited = NonNullable<TurnState['unverified']>

type CheckOf = { turnId: string; id: string; level: Level; queuedNote: string | null }

/**
 * The turn once a shift's Decision is recorded (controller ruling). A shift whose note is queued keeps its check beside
 * that note (queuedCheck) and leaves the turn's check alone: until the note is on a row the requests carry the old
 * level, and they still check the Decision before it. Any other shift's check takes the turn's (an older one stays as
 * it is). Unchanged when the turn is no longer that turn or no longer at that level.
 */
export function awaitCheck(turn: TurnState, c: CheckOf): TurnState
export function awaitCheck(turn: TurnState | null, c: CheckOf): TurnState | null
export function awaitCheck(turn: TurnState | null, c: CheckOf): TurnState | null {
  if (turn === null || turn.turnId !== c.turnId || (turn.wanted ?? turn.base) !== c.level) return turn
  const check = { id: c.id, level: c.level }
  if (c.queuedNote !== null && turn.pendingNote === c.queuedNote) return { ...turn, queuedCheck: { ...check, note: c.queuedNote } }
  // A queued check whose note is gone (placed, or dropped by this shift) waits on nothing any more.
  const queuedCheck = turn.queuedCheck !== null && turn.queuedCheck.note === turn.pendingNote ? turn.queuedCheck : null
  return { ...turn, unverified: check, queuedCheck }
}

/** The turn once a queued note is on a row: its shift's check becomes the turn's, due from the next request on. */
export function notePlaced(turn: TurnState, note: string): TurnState {
  const q = turn.queuedCheck
  if (q === null) return turn
  return q.note === note ? { ...turn, unverified: { id: q.id, level: q.level }, queuedCheck: null } : { ...turn, queuedCheck: null }
}

/** What a reading writes on the Decision it checks: the level when the request carried it, 'not-sent' when it carried another or none, 'unverified' when it could not be told for the main loop's. */
export function sentOf(r: Reading, level: Level): Decision['sent'] {
  if (r.kind !== 'main') return 'unverified'
  return r.effort === level ? level : 'not-sent'
}

/**
 * What a reading does to the check it meets, if anything (controller ruling):
 * - the main loop's request writes the level it carried (or not-sent) and clears the check (`clears`);
 * - an unsure one read while the turn's main step is open writes unverified and keeps the check, so a later main
 *   reading replaces it: unverified stays only when no clean main reading came;
 * - an unsure one read between steps (an agent's, a side request) does nothing.
 * A request read in a step of a turn other than the one held does nothing either. `open`: the main step open when the
 * request was read.
 */
export function settleReading(turn: TurnState | null, r: Reading, open: OpenStep | null): { awaited: Awaited; sent: Decision['sent']; clears: boolean } | null {
  const awaited = turn?.unverified ?? null
  if (turn === null || awaited === null || r.kind === 'ignore') return null
  if (r.kind === 'unsure' && !r.stepOpen) return null
  if (open?.turnId !== turn.turnId) return null
  return { awaited, sent: sentOf(r, awaited.level), clears: r.kind === 'main' }
}

/**
 * The log with one Decision's sent replaced, or null when nothing changes. Unverified never replaces a level or
 * not-sent: a main reading may land before an unsure one read beside it.
 */
export function withSent(log: readonly Decision[], id: string, sent: Decision['sent']): Decision[] | null {
  const d = log.find((x) => x.id === id)
  if (d === undefined || d.sent === sent || (sent === 'unverified' && d.sent !== null)) return null
  return amendLog(log, id, { sent })
}

/** The turn with one Decision's sent replaced in the copies it keeps (lastJudged, shifts), or null when nothing changes. */
export function judgedWithSent(turn: TurnState, id: string, sent: Decision['sent']): TurnState | null {
  const last = turn.lastJudged === null ? null : withSent([turn.lastJudged], id, sent)
  const shifts = withSent(turn.shifts, id, sent)
  if (last === null && shifts === null) return null
  return { ...turn, lastJudged: last?.[0] ?? turn.lastJudged, shifts: shifts ?? turn.shifts }
}

/** The turn with that check cleared; unchanged when it waits on another by now. */
export function clearCheck(turn: TurnState | null, awaited: Awaited): TurnState | null {
  const w = turn?.unverified ?? null
  return turn !== null && w !== null && w.id === awaited.id ? { ...turn, unverified: null } : turn
}

/**
 * An agent's check, from $.agent.list()'s documented reading (design 5.12): the level its last request carried against
 * the one decided at its spawn. No last request (the agent not listed, or none answered yet): unverified.
 */
export function agentSent(decided: Level, last: { effort?: unknown } | undefined): Level | 'not-sent' | 'unverified' {
  if (last === undefined) return 'unverified'
  return last.effort === decided ? decided : 'not-sent'
}
