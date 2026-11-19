// The judgement made when a person sends a message, settled at the turn's first step (design 5.3): the level the turn
// starts from, the level the mod wants, and the Decision that records both. Pure: no $ calls. The entry's turn.step
// hook reads the pending decision, calls settleSubmit and writes the turn.
import { noulOf, scoreOf } from './backend.ts'
import type { AskResult } from './backend.ts'
import type { Config } from './config.ts'
import { messageLevel } from './decide.ts'
import type { Thresholds } from './decide.ts'
import { isLevel } from './levels.ts'
import type { Level } from './levels.ts'
import { failureText } from './log.ts'
import type { Decision } from './log.ts'
import type { SessionState, TurnState } from './state.ts'

const NO_LEVEL = 'effort 缺省或是数字，没有改'

/**
 * What the mod writes on a main-loop step: a lock, else the level decided for the turn. Null when it writes nothing: the
 * mod off or only watching, or nothing decided (a failed evaluation, a turn no message decision set, submitShift off),
 * and the step then goes as it came.
 */
export function ownLevel(cfg: Config, session: SessionState, turn: TurnState | null): Level | null {
  if (!cfg.enabled || cfg.mode === 'shadow') return null
  return session.lock ?? turn?.wanted ?? null
}

/**
 * The level the main loop's steps go at, as the board shows it: what the mod writes (ownLevel), else the engine's own
 * level (the last step's, session.sessionLevel) for a turn that has one at all (base, set at step 0). Not turn.base
 * itself: in shadow a "go on" message's base is the last turn's level, which no step carries. Between turns only a lock
 * the mod writes. Null: a model that takes no effort, or between turns with no lock.
 */
export function stepLevel(cfg: Config, session: SessionState, turn: TurnState | null): Level | null {
  const own = ownLevel(cfg, session, turn)
  if (own !== null) return own
  return turn === null || turn.base === null ? null : (session.sessionLevel ?? turn.base)
}

export type Settled = { base: Level | null; wanted: Level | null; decision: Decision }

// What a message's answers make of its turn: the level it starts from, the level the mod wants, and
// the Decision that records both. Pure. `writes`: the mod would write a level (apply mode, no lock); `bars`: the
// submit thresholds in use (Config.bars.submit).
export function settleSubmit(
  r: AskResult,
  c: { effort: unknown; previousLevel: Level | null; writes: boolean; turnId: string; id: string; at: number; bars: Thresholds },
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
  const bars = c.bars
  const v = messageLevel(
    own,
    c.previousLevel,
    { open: scoreOf(r.answers.open), mechanical: noulOf(r.answers.mechanical), unknownCause: noulOf(r.answers.unknown_cause), continues: noulOf(r.answers.continues) },
    bars,
  )
  // A "go on" turn starts at the last turn's level (design 5.3); the shift is still measured from the engine's own
  // level, as for any other decided level, so a go-ahead that restores xhigh over a medium session reads as a rise.
  const decision: Decision = { ...common, model: r.model, raw: r.answers, from: own, to: v.level, reason: v.reason, detail: '', bars, failure: null, requestId: null, applied: c.writes }
  return { base: v.base, wanted: v.level, decision }
}
