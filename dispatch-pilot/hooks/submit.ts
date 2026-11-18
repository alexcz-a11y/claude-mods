// The judgement made when a person sends a message, settled at the turn's first step (design 5.3): the level the turn
// starts from, the level the mod wants, and the Decision that records both. Pure: no $ calls. The entry's turn.step
// hook reads the pending decision, calls settleSubmit and writes the turn.
import { noulOf, scoreOf } from './backend.ts'
import type { AskResult } from './backend.ts'
import type { Config } from './config.ts'
import { readNoul, submitLevel, thresholdsFor } from './decide.ts'
import { isLevel } from './levels.ts'
import type { Level } from './levels.ts'
import { failureText } from './log.ts'
import type { Decision } from './log.ts'
import type { SessionState, TurnState } from './state.ts'

const NO_LEVEL = 'effort 缺省或是数字，没有改'

/**
 * The level the main loop's steps go at: the one choice the step's rewrite and the board both read, so they cannot
 * disagree. While the mod writes (enabled, apply): a lock, else the level decided, else the one the turn started from.
 * Off or shadow, nothing is written: the engine's own level (the last step's, session.sessionLevel), for a turn that has
 * one at all (base, set at step 0). Not turn.base itself: in shadow a "go on" message's base is the last turn's level,
 * which no step carries. Null: nothing to write, or a model that takes no effort.
 */
export function writtenLevel(cfg: Config, session: SessionState, turn: TurnState | null): Level | null {
  if (!cfg.enabled || cfg.mode === 'shadow') return turn === null || turn.base === null ? null : (session.sessionLevel ?? turn.base)
  return session.lock ?? turn?.wanted ?? turn?.base ?? null
}

export type Settled = { base: Level | null; wanted: Level | null; decision: Decision }

// What a message's answers make of its turn: the level it starts from, the level the mod wants, and
// the Decision that records both. Pure. `writes`: the mod would write a level (apply mode, no lock).
export function settleSubmit(
  r: AskResult,
  c: { effort: unknown; previousLevel: Level | null; writes: boolean; turnId: string; id: string; at: number },
): Settled {
  const own = isLevel(c.effort) ? c.effort : null
  const common = { id: c.id, at: c.at, kind: 'submit' as const, backend: r.backend, ms: r.ms, turnId: c.turnId, step: 0, sent: null }
  if (!r.ok) {
    // A failed request changes nothing: the turn runs at the session's own level.
    const decision: Decision = { ...common, model: null, raw: null, from: own, to: own, reason: null, detail: failureText(r), bars: null, failure: r.reason, requestId: r.requestId ?? null, applied: false }
    return { base: own, wanted: null, decision }
  }
  if (own === null) {
    // Answers came, but the step has no level to start from or to replace.
    const decision: Decision = { ...common, model: r.model, raw: r.answers, from: null, to: null, reason: null, detail: NO_LEVEL, bars: null, failure: null, requestId: null, applied: false }
    return { base: null, wanted: null, decision }
  }
  const bars = thresholdsFor(r.backend, r.model, 'submit')
  // "Go on" carries the last turn's level; anything else starts from the session's.
  const continues = readNoul(noulOf(r.answers.continues), bars) === 'yes'
  const base = continues && c.previousLevel !== null ? c.previousLevel : own
  const v = submitLevel(base, { open: scoreOf(r.answers.open), mechanical: noulOf(r.answers.mechanical), unknownCause: noulOf(r.answers.unknown_cause) }, bars)
  const decision: Decision = { ...common, model: r.model, raw: r.answers, from: base, to: v.level, reason: v.reason, detail: '', bars, failure: null, requestId: null, applied: c.writes }
  return { base, wanted: v.level, decision }
}
