// Judging the effort again in the middle of a turn (design 5.4): when a result reaches the model, whether the work
// that remains still fits the level, and how a new level gets sent. Pure: no $ calls. The entry's session.append
// hook reads state, calls planRow, asks when the plan says so, settles the answer with settleCheckpoint, writes the
// turn with applyShift and passes the row on, with the note when there is one.
//
// How the engine sends a level changed mid-turn (design 3.2, E4 to E6 and E13, measured on 2.1.326/2.1.327): a
// rewritten effort on a step that follows only tool results is not sent, unless a text block was added to a tool
// result row before that request; from then on the new level is sent and holds for the rest of the turn. The note
// is that text block. Poll's result row and REPL's receipt row both carry it; a delivery row cannot, so a result
// that came by delivery queues its note for the next row that can. A step that follows new input needs none.
import { noulOf, scoreOf } from './backend.ts'
import type { AskResult } from './backend.ts'
import type { Config } from './config.ts'
import { REASON_EN, midrunLevel, thresholdsFor } from './decide.ts'
import type { Reason, Verdict } from './decide.ts'
import { applyRow } from './journal.ts'
import type { Row, RowKind } from './journal.ts'
import type { Level } from './levels.ts'
import { failureText } from './log.ts'
import type { Decision } from './log.ts'
import type { MidrunCounters, TurnJournal, TurnState } from './state.ts'
import { midrunState } from './statebuild.ts'
import type { StepRecord } from './statebuild.ts'

export { emptyCounters } from './state.ts'
export type { MidrunCounters } from './state.ts'

/** Two shifts in one turn are at least this many work steps apart. */
const SHIFT_GAP = 3

/** No shift yet this turn, or the last one SHIFT_GAP or more work steps back. */
export function gapOk(m: MidrunCounters, j: TurnJournal): boolean {
  return m.lastShiftAt === null || j.workSteps - m.lastShiftAt >= SHIFT_GAP
}

export function notesLeft(m: MidrunCounters, cfg: Config): number {
  return Math.max(0, cfg.midrunMaxNotes - m.notes)
}

/**
 * How a shift made on a row of this kind reaches the request; the one place this is decided (design 3.2).
 * - 'row': a note on this row. The results a request carries (E6): Poll's result, REPL's receipt, a tool result.
 * - 'queue': a note queued for the next 'row'. A delivery row cannot carry a shift (E13: a level changed after it
 *   arrives is not sent, and text added to it is neither kept nor sent), whether it brings a script's result or
 *   other input; it counts against the notes like any note.
 * - 'input': the person's prompt row. The step after it carries input and sends the new level with no note (the
 *   types' TurnStepInput.effort: a level on a step with input stays); nothing is counted. Whether input arriving any
 *   other way does the same is not measured (design 9), so only the prompt door is taken for it.
 * - null: no shift is made on this kind of row (it is never a checkpoint).
 */
export function carrierOf(kind: RowKind): 'row' | 'queue' | 'input' | null {
  switch (kind) {
    case 'receipt':
    case 'script-result-poll':
    case 'tool-result':
      return 'row'
    case 'script-result-delivery':
    case 'delivered-input':
      return 'queue'
    case 'new-input':
      return 'input'
    default:
      return null
  }
}

/** The rows a note can ride (carrierOf 'row'). Not a delivery row (E13), not a call inside a script (E7). */
export function carriesNote(kind: RowKind): boolean {
  return carrierOf(kind) === 'row'
}

/** One line of fact in English, with no command in it (design 5.4). */
export function noteText(to: Level, reason: Reason): string {
  return `[dispatch-pilot] effort is now ${to}: ${REASON_EN[reason]}.`
}

/** The row with one more text block at the end of its content. */
export function withNote<E extends { message: { content: readonly unknown[] } }>(e: E, text: string): E {
  return { ...e, message: { ...e.message, content: [...e.message.content, { type: 'text', text }] } }
}

/** Whether a question is due on this row (design 5.4). `j`: the journal after the row; `m`: the counters before it. */
export function isCheckpoint(kind: RowKind, j: TurnJournal, m: MidrunCounters, cfg: Config, codeMode: boolean): boolean {
  // The person's input: its shift needs no note, so notes used up do not matter here.
  if (carrierOf(kind) === 'input') return true
  // Every other shift goes out only with a note: with none left, asking would hold the row for nothing.
  if (notesLeft(m, cfg) === 0) return false
  // Input that came by delivery, in either kind of session.
  if (kind === 'delivered-input') return true
  if (codeMode) {
    if (kind !== 'script-result-poll' && kind !== 'script-result-delivery') return false
    return cfg.midrunEveryScripts > 0 && m.scriptsSinceCheck + 1 >= cfg.midrunEveryScripts
  }
  if (kind !== 'tool-result') return false
  return j.sameErrorRepeated || j.consecutiveFailures >= 2 || (cfg.midrunEverySteps > 0 && m.stepsSinceCheck + 1 >= cfg.midrunEverySteps)
}

export type RowPlan = {
  /** The turn after the row: its journal and counters, and the queued note taken off when this row carries it. */
  turn: TurnState
  /** A note queued at an earlier checkpoint, to add to this row now. */
  note: string | null
  /** A checkpoint: the level being judged and the state to ask about. Null: nothing to ask on this row. */
  ask: { current: Level; state: Record<string, unknown> } | null
}

const NONCE_LINE = /^<system>authentic event nonces for this delivery:.*<\/system>$/

// What an input says, without a delivery's own wrapping: the <system-reminder> around it and the line about the
// delivery's event nonces.
function inputText(text: string): string {
  const inner = text.trim().replace(/^<system-reminder>\s*/, '').replace(/\s*<\/system-reminder>$/, '')
  return inner
    .split('\n')
    .filter((line) => !NONCE_LINE.test(line.trim()))
    .join('\n')
    .trim()
}

// What the question is about: the steps so far, oldest first, and the latest. On new input the latest is the
// input itself, the one thing that changed since the last result.
function evidenceOf(kind: RowKind, row: Row, j: TurnJournal): { recent: StepRecord[]; latest: StepRecord } | null {
  if (kind === 'new-input' || kind === 'delivered-input') {
    return { recent: j.steps, latest: { did: 'new input', tools: [], ok: true, result: inputText(row.text) } }
  }
  const latest = j.steps.at(-1)
  return latest === undefined ? null : { recent: j.steps.slice(0, -1), latest }
}

/**
 * What one main-loop row does to its turn. `judging`: mid-run questions may be asked at all (the mod enabled,
 * midrunShift on, no lock); `codeMode`: a receipt has been seen this session, this row included.
 */
export function planRow(turn: TurnState, row: Row, kind: RowKind, c: { cfg: Config; codeMode: boolean; judging: boolean }): RowPlan {
  const journal = applyRow(turn.journal, row, kind)
  const m = turn.midrun
  // A queued note goes on the first row that can carry it, while mid-run shifts are still made: a lock since then
  // sends its own level, which the note would misstate, so the note stays queued and goes on the first such row
  // after an unlock in the same turn. That row is not asked about: a shift on it would fall within the gap anyway.
  const note = c.judging && turn.pendingNote !== null && carriesNote(kind) ? turn.pendingNote : null
  // The level being judged; none on a model that takes no effort, and then nothing is asked.
  const current = turn.wanted ?? turn.base
  const due = note === null && c.judging && current !== null && isCheckpoint(kind, journal, m, c.cfg, c.codeMode)
  const evidence = due ? evidenceOf(kind, row, journal) : null
  const midrun: MidrunCounters =
    evidence !== null
      ? { ...m, stepsSinceCheck: 0, scriptsSinceCheck: 0 }
      : {
          ...m,
          stepsSinceCheck: m.stepsSinceCheck + journal.workSteps - turn.journal.workSteps,
          scriptsSinceCheck: m.scriptsSinceCheck + journal.scriptResults - turn.journal.scriptResults,
        }
  const next: TurnState = { ...turn, journal, midrun, pendingNote: note === null ? turn.pendingNote : null }
  if (evidence === null || current === null) return { turn: next, note, ask: null }
  const state = midrunState({
    request: turn.request,
    current,
    stepsSoFar: journal.workSteps,
    failedSteps: journal.failedSteps,
    ...evidence,
    statedNext: journal.statedNext,
    progress: turn.progress,
  })
  return { turn: next, note, ask: { current, state } }
}

/** How a new level is carried: by a note on this row, by one queued for the next row that can carry it, or by the input itself (both null). */
export type Shift = { to: Level; note: string | null; queued: string | null }

export type Judged = { decision: Decision; shift: Shift | null }

type CheckpointContext = { turn: TurnState; kind: RowKind; current: Level; cfg: Config; id: string; at: number }

// A new level is proposed only when it differs, the gap allows it, the mod applies what it decides, and the row
// has a way to carry it (carrierOf). applyShift checks it again when it is written.
function shiftFor(v: Verdict, c: CheckpointContext): Shift | null {
  const m = c.turn.midrun
  const carrier = carrierOf(c.kind)
  if (carrier === null || v.level === c.current || !gapOk(m, c.turn.journal) || c.cfg.mode !== 'apply') return null
  if (carrier === 'input') return { to: v.level, note: null, queued: null }
  if (notesLeft(m, c.cfg) === 0) return null
  const text = noteText(v.level, v.reason)
  return carrier === 'row' ? { to: v.level, note: text, queued: null } : { to: v.level, note: null, queued: text }
}

/**
 * The answer at a checkpoint: the Decision to record and the shift it calls for, if any. `turn` is planRow's turn
 * (after the row), `current` the level judged. The decision's `applied` says the shift was proposed; the caller
 * sets it to whether applyShift really made it.
 */
export function settleCheckpoint(r: AskResult, c: CheckpointContext): Judged {
  const common = { id: c.id, at: c.at, kind: 'midrun' as const, backend: r.backend, ms: r.ms, from: c.current, turnId: c.turn.turnId, step: c.turn.journal.workSteps, sent: null }
  if (!r.ok) {
    // A failed request changes nothing: the row goes on as it came.
    const decision: Decision = { ...common, model: null, raw: null, to: c.current, reason: null, detail: failureText(r), bars: null, failure: r.reason, requestId: r.requestId ?? null, applied: false }
    return { decision, shift: null }
  }
  const bars = thresholdsFor(r.backend, r.model, 'midrun')
  const a = r.answers
  const v = midrunLevel(
    c.current,
    { open: scoreOf(a.open), sameFailure: noulOf(a.same_failure), causeFound: noulOf(a.cause_found), onlyCarryingOut: noulOf(a.only_carrying_out), contradictsPlan: noulOf(a.contradicts_plan) },
    bars,
  )
  const shift = shiftFor(v, c)
  const decision: Decision = { ...common, model: r.model, raw: a, to: v.level, reason: v.reason, detail: '', bars, failure: null, requestId: null, applied: shift !== null }
  return { decision, shift }
}

/**
 * The turn with a shift made (the new level, the work step it was made at, one more note when it took one), or null
 * when the turn as it is at the write no longer allows it. The answer comes back up to midrunTimeoutMs after the plan,
 * and the result rows of one step may be appended side by side (the test kit runs two such appends concurrently;
 * the engine is not measured), so another row may have shifted meanwhile: the level must still be the one asked
 * about, the gap and the notes must still allow it, and no lock may have come.
 */
export function applyShift(turn: TurnState, s: Shift, c: { asked: Level; cfg: Config; locked: boolean }): TurnState | null {
  const noted = s.note !== null || s.queued !== null
  if (c.locked || (turn.wanted ?? turn.base) !== c.asked || !gapOk(turn.midrun, turn.journal)) return null
  if (noted && notesLeft(turn.midrun, c.cfg) === 0) return null
  return {
    ...turn,
    wanted: s.to,
    pendingNote: s.queued ?? turn.pendingNote,
    midrun: { ...turn.midrun, lastShiftAt: turn.journal.workSteps, notes: turn.midrun.notes + (noted ? 1 : 0) },
  }
}
