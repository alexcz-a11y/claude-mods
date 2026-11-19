// Turns the decision model's answers into an effort level and a model tier. Pure functions:
// no $ calls, no engine events, so every branch is testable without a session.
import { LEVELS, TIERS } from './levels.ts'
import type { Level, Tier } from './levels.ts'

export type Thresholds = { up: number; upHigh: number; down: number; yes: number; no: number; modelDown: number }

export const START: Thresholds = { up: 0.7, upHigh: 0.8, down: 0.7, yes: 0.7, no: 0.3, modelDown: 0.8 }

// One table per backend, model version and action once calibration has run; until then all return START.
export function thresholdsFor(backend: 'drex' | 'jev', model: string, action: 'submit' | 'midrun' | 'agent'): Thresholds {
  void backend
  void model
  void action
  return START
}

export type Reason =
  | 'more-open'
  | 'less-open'
  | 'mechanical'
  | 'unknown-cause'
  | 'same-failure'
  | 'contradicts-plan'
  | 'cause-found'
  | 'carrying-out'
  | 'continues'
  | 'hold'

export const REASON_EN: Record<Reason, string> = {
  'more-open': 'the remaining problem is more open than assumed',
  'less-open': 'the problem is less open than the current level assumes',
  mechanical: 'the work repeats an approach that is already known',
  'unknown-cause': 'a cause has to be found first',
  'same-failure': 'the same failure came back after a fix',
  'contradicts-plan': 'a result contradicts the plan',
  'cause-found': 'the cause is found and what remains is routine',
  'carrying-out': 'what remains is carrying out decided steps',
  continues: "the message only says to go on, so the level is the previous turn's",
  hold: 'no change',
}

export type Verdict = { level: Level; reason: Reason }

// Sums of probabilities are compared with a tolerance so that 0.3 + 0.4 still reaches 0.7.
const EPS = 1e-9
// Moving up into xhigh or max needs the stricter bar.
const HIGH_FROM = LEVELS.indexOf('xhigh')
const MEDIUM = LEVELS.indexOf('medium')
const HIGH = LEVELS.indexOf('high')

const rank = (l: Level): number => LEVELS.indexOf(l)
const reaches = (sum: number, bar: number): boolean => sum >= bar - EPS

// Sum of the probabilities of levels from `from` (inclusive) to `to` (exclusive); a missing or bad entry counts as 0.
function sum(probs: readonly number[], from: number, to: number): number {
  let s = 0
  for (let i = from; i < to; i++) {
    const p = probs[i]
    if (typeof p === 'number' && Number.isFinite(p)) s += p
  }
  return s
}

const upBar = (target: number, t: Thresholds): number => (target >= HIGH_FROM ? t.upHigh : t.up)

export function decide(current: Level, probs: readonly number[], t: Thresholds, cap: Level = 'max'): Level {
  let i = rank(current)
  const top = rank(cap)
  let moved = false
  while (i < top && reaches(sum(probs, i + 1, LEVELS.length), upBar(i + 1, t))) {
    i++
    moved = true
  }
  // Only look down when there was no way up.
  if (!moved) while (i > 0 && reaches(sum(probs, 0, i), t.down)) i--
  return LEVELS[i]!
}

export function readNoul(p: number | undefined, t: Thresholds): 'yes' | 'no' | 'unsure' {
  if (typeof p !== 'number' || !Number.isFinite(p)) return 'unsure'
  if (reaches(p, t.yes)) return 'yes'
  if (p <= t.no + EPS) return 'no'
  return 'unsure'
}

const isYes = (p: number | undefined, t: Thresholds): boolean => readNoul(p, t) === 'yes'

export function margins(
  current: Level,
  probs: readonly number[],
  t: Thresholds,
  cap: Level = 'max',
): { up: { sum: number; bar: number } | null; down: { sum: number; bar: number } | null } {
  const i = rank(current)
  return {
    up: i < rank(cap) ? { sum: sum(probs, i + 1, LEVELS.length), bar: upBar(i + 1, t) } : null,
    down: i > 0 ? { sum: sum(probs, 0, i), bar: t.down } : null,
  }
}

export function submitLevel(
  base: Level,
  a: { open: readonly number[]; mechanical?: number; unknownCause?: number },
  t: Thresholds,
): Verdict {
  const decided = decide(base, a.open, t)
  let i = rank(decided)
  let floored = false
  if (isYes(a.mechanical, t)) i = Math.min(i, MEDIUM)
  if (isYes(a.unknownCause, t) && i < HIGH) {
    i = HIGH
    floored = true
  }
  const level = LEVELS[i]!
  if (level !== decided) return { level, reason: floored ? 'unknown-cause' : 'mechanical' }
  if (rank(decided) > rank(base)) return { level, reason: 'more-open' }
  if (rank(decided) < rank(base)) return { level, reason: 'less-open' }
  return { level, reason: 'hold' }
}

/**
 * The level of the turn a person's message starts (Ruling C38). A message that only says to go on (continues read as
 * yes) keeps the previous turn's level when one is known: the message says nothing about the work, and the decision
 * model reads a bare go-ahead as the lowest level of open, so open, mechanical and unknown_cause do not move it. Any
 * other message is submitLevel from the session's own level.
 */
export function messageLevel(
  own: Level,
  previous: Level | null,
  a: { open: readonly number[]; mechanical?: number; unknownCause?: number; continues?: number },
  t: Thresholds,
): Verdict {
  if (previous !== null && isYes(a.continues, t)) return { level: previous, reason: 'continues' }
  return submitLevel(own, a, t)
}

export function midrunLevel(
  current: Level,
  a: { open: readonly number[]; sameFailure?: number; causeFound?: number; onlyCarryingOut?: number; contradictsPlan?: number },
  t: Thresholds,
): Verdict {
  const cap = 'xhigh'
  const decided = decide(current, a.open, t, cap)
  const i = rank(current)
  const flagUp = isYes(a.sameFailure, t) || isYes(a.contradictsPlan, t)
  if (rank(decided) > i || flagUp) {
    // A flag alone moves one step, never past the cap; the open question may move further.
    const step = i < rank(cap) ? i + 1 : i
    const level = LEVELS[Math.max(rank(decided), step)]!
    if (level === current) return { level: current, reason: 'hold' }
    const reason: Reason = isYes(a.sameFailure, t) ? 'same-failure' : isYes(a.contradictsPlan, t) ? 'contradicts-plan' : 'more-open'
    return { level, reason }
  }
  if (rank(decided) < i && (isYes(a.causeFound, t) || isYes(a.onlyCarryingOut, t))) {
    return { level: decided, reason: isYes(a.causeFound, t) ? 'cause-found' : 'carrying-out' }
  }
  return { level: current, reason: 'hold' }
}

const tierRank = (x: Tier): number => TIERS.indexOf(x)
const atLeast = (p: number | undefined, bar: number): boolean => typeof p === 'number' && reaches(p, bar)

export function agentPlan(
  inherit: { level: Level | null; tier: Tier | null },
  a: { open: readonly number[]; mechanical?: number; unknownCause?: number; readOnly?: number },
  opts: { agentModels: readonly Tier[]; fableAgents: boolean },
  t: Thresholds,
): { effort: Level | null; model: Tier | null; reason: Reason; modelReason: 'inherit' | 'capped' | 'lowest' | 'one-down' } {
  const verdict = inherit.level === null ? null : submitLevel(inherit.level, a, t)
  const effort = verdict ? verdict.level : null
  const reason: Reason = verdict ? verdict.reason : 'hold'
  if (inherit.tier === null) return { effort, model: null, reason, modelReason: 'inherit' }

  // With fableAgents off no agent runs on fable, whatever the answers say.
  const capped = inherit.tier === 'fable' && !opts.fableAgents
  const top: Tier = capped ? 'opus' : inherit.tier
  const candidates = opts.agentModels
    .filter((m) => tierRank(m) <= tierRank(top) && (m !== 'fable' || opts.fableAgents))
    .sort((x, y) => tierRank(x) - tierRank(y))

  const lowest = candidates[0]
  if (lowest && tierRank(lowest) < tierRank(top) && atLeast(a.readOnly, t.modelDown) && atLeast(a.mechanical, t.modelDown)) {
    return { effort, model: lowest, reason, modelReason: 'lowest' }
  }
  if (reaches(sum(a.open, 0, 2), t.modelDown)) {
    // One tier down, but never below sonnet and only to a tier the user allowed.
    const below = TIERS[tierRank(top) - 1]
    if (below && tierRank(below) >= tierRank('sonnet') && candidates.includes(below)) {
      return { effort, model: below, reason, modelReason: 'one-down' }
    }
  }
  return { effort, model: top, reason, modelReason: capped ? 'capped' : 'inherit' }
}
