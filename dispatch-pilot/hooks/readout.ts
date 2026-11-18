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
import type { Decision } from './log.ts'
import type { TurnState } from './state.ts'

/** The main loop's step whose request is on its way; matched: one of its requests was read already. */
export type OpenStep = { turnId: string; index: number; model: string; matched: boolean }

export type Reading = { kind: 'main'; effort: Level | null } | { kind: 'unsure' } | { kind: 'ignore' }

const IGNORE: Reading = { kind: 'ignore' }
const UNSURE: Reading = { kind: 'unsure' }

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
 * What one request is. `agentStepsOpen`: the agent steps open now on the open main step's model, whose requests look
 * just like the main loop's. The cheap checks come first; a body (it can be hundreds of KB) is parsed once, here, and
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
  if (open === null || open.matched || body.model !== open.model || i.agentStepsOpen > 0) return UNSURE
  // The top level only: a message that carried a change has an output_config of its own (E6).
  const config = body.output_config
  return { kind: 'main', effort: isRecord(config) && isLevel(config.effort) ? config.effort : null }
}

/** The check a turn waits on: the Decision's id and the level it should bring. queued: its note waits for a row, so no request carries the level yet. */
export type Awaited = NonNullable<TurnState['unverified']>

/**
 * The turn waiting on a check of a Decision just recorded (a newer one takes the place of any before it, which stays as
 * it is). `queuedNote`: the note the shift queued, if it did; the check waits with it while it is still the turn's
 * pendingNote. Unchanged when the turn is no longer that turn or no longer at that level.
 */
export function awaitCheck(turn: TurnState, c: { turnId: string; id: string; level: Level; queuedNote: string | null }): TurnState
export function awaitCheck(turn: TurnState | null, c: { turnId: string; id: string; level: Level; queuedNote: string | null }): TurnState | null
export function awaitCheck(turn: TurnState | null, c: { turnId: string; id: string; level: Level; queuedNote: string | null }): TurnState | null {
  if (turn === null || turn.turnId !== c.turnId || (turn.wanted ?? turn.base) !== c.level) return turn
  const queued = c.queuedNote !== null && turn.pendingNote === c.queuedNote
  return { ...turn, unverified: { id: c.id, level: c.level, queued } }
}

/** The turn once its queued note is on a row: from the next request on, the level is sent and can be checked. */
export function notePlaced(turn: TurnState): TurnState {
  const w = turn.unverified
  return w !== null && w.queued ? { ...turn, unverified: { ...w, queued: false } } : turn
}

/** What a reading writes on the Decision it checks: the level when the request carried it, 'not-sent' when it carried another or none, 'unverified' when it could not be told for the main loop's. */
export function sentOf(r: Reading, level: Level): Decision['sent'] {
  if (r.kind !== 'main') return 'unverified'
  return r.effort === level ? level : 'not-sent'
}

/**
 * The check a reading settles, if any: the first reading (main or unsure) after the check was set settles it. A
 * request read before a queued note is on its row says nothing of that Decision, nor does a main-loop request of a
 * turn other than the one held. `open`: the main step open when the request was read.
 */
export function settleReading(turn: TurnState | null, r: Reading, open: OpenStep | null): { awaited: Awaited; sent: Decision['sent'] } | null {
  const awaited = turn?.unverified ?? null
  if (turn === null || awaited === null || awaited.queued || r.kind === 'ignore') return null
  if (r.kind === 'main' && open?.turnId !== turn.turnId) return null
  return { awaited, sent: sentOf(r, awaited.level) }
}

/** The turn with that check cleared; unchanged when it waits on another by now. */
export function clearCheck(turn: TurnState | null, awaited: Awaited): TurnState | null {
  const w = turn?.unverified ?? null
  return turn !== null && w !== null && w.id === awaited.id && w.queued === awaited.queued ? { ...turn, unverified: null } : turn
}

/**
 * An agent's check, from $.agent.list()'s documented reading (design 5.12): the level its last request carried against
 * the one decided at its spawn. No last request (the agent not listed, or none answered yet): unverified.
 */
export function agentSent(decided: Level, last: { effort?: unknown } | undefined): Level | 'not-sent' | 'unverified' {
  if (last === undefined) return 'unverified'
  return last.effort === decided ? decided : 'not-sent'
}
