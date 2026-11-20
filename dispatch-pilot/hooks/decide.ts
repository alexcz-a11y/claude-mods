// Turns the decision model's answers into an effort level and a model tier. Pure functions:
// no $ calls, no engine events, so every branch is testable without a session.
import { LEVELS, TIERS } from './levels.ts'
import type { Level, Tier } from './levels.ts'
import { START } from './questions.ts'
import type { Thresholds } from './questions.ts'

// The tables live beside the questions (questions.ts); re-exported so their readers import them from here as before.
// The thresholds in use are the options' (Config.bars); every reading here takes them as an argument.
export { START }
export type { Thresholds }

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

/**
 * One thing the rules did, in the order they did it, for the board to say why a level came out (board/model.ts). The
 * rules below push these as they go when given a trace, so what the board says is the path the level took, not a
 * second reading of the rules. hop: the open question moved one level (the sum over the levels past `from` reached the
 * bar); stop: it went no further that way (sum below the bar); cap: the highest level this action reaches; flag: a
 * yes/no answer read as yes, and what it did; blocked: the open question said down but no answer allowed it.
 */
export type TraceStep =
  | { k: 'hop'; dir: 'up' | 'down'; from: Level; to: Level; sum: number; bar: number }
  | { k: 'stop'; dir: 'up' | 'down'; at: Level; sum: number; bar: number }
  | { k: 'cap'; at: Level }
  | { k: 'flag'; id: string; value: number; effect: 'up-one' | 'allow-down' | 'at-most-medium' | 'at-least-high' }
  | { k: 'blocked'; at: Level }

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

export function decide(current: Level, probs: readonly number[], t: Thresholds, cap: Level = 'max', trace?: TraceStep[]): Level {
  let i = rank(current)
  const top = rank(cap)
  let moved = false
  while (i < top && reaches(sum(probs, i + 1, LEVELS.length), upBar(i + 1, t))) {
    trace?.push({ k: 'hop', dir: 'up', from: LEVELS[i]!, to: LEVELS[i + 1]!, sum: sum(probs, i + 1, LEVELS.length), bar: upBar(i + 1, t) })
    i++
    moved = true
  }
  if (i < top) trace?.push({ k: 'stop', dir: 'up', at: LEVELS[i]!, sum: sum(probs, i + 1, LEVELS.length), bar: upBar(i + 1, t) })
  else if (moved) trace?.push({ k: 'cap', at: LEVELS[i]! })
  // Only look down when there was no way up.
  if (!moved) {
    while (i > 0 && reaches(sum(probs, 0, i), t.down)) {
      trace?.push({ k: 'hop', dir: 'down', from: LEVELS[i]!, to: LEVELS[i - 1]!, sum: sum(probs, 0, i), bar: t.down })
      i--
    }
    if (i > 0) trace?.push({ k: 'stop', dir: 'down', at: LEVELS[i]!, sum: sum(probs, 0, i), bar: t.down })
  }
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
  trace?: TraceStep[],
): Verdict {
  const decided = decide(base, a.open, t, 'max', trace)
  let i = rank(decided)
  let floored = false
  if (isYes(a.mechanical, t)) {
    trace?.push({ k: 'flag', id: 'mechanical', value: a.mechanical!, effect: 'at-most-medium' })
    i = Math.min(i, MEDIUM)
  }
  if (isYes(a.unknownCause, t)) trace?.push({ k: 'flag', id: 'unknown_cause', value: a.unknownCause!, effect: 'at-least-high' })
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
 * other message is submitLevel from the session's own level. base: the level it went from, the turn's start.
 */
export function messageLevel(
  own: Level,
  previous: Level | null,
  a: { open: readonly number[]; mechanical?: number; unknownCause?: number; continues?: number },
  t: Thresholds,
): Verdict & { base: Level } {
  if (previous !== null && isYes(a.continues, t)) return { level: previous, reason: 'continues', base: previous }
  return { ...submitLevel(own, a, t), base: own }
}

export function midrunLevel(
  current: Level,
  a: { open: readonly number[]; sameFailure?: number; causeFound?: number; onlyCarryingOut?: number; contradictsPlan?: number },
  t: Thresholds,
  trace?: TraceStep[],
): Verdict {
  // Mid-run reaches max as well (2026-11-20, ADR 0031); moving into xhigh or max takes the same upHigh bar.
  const cap = 'max'
  const decided = decide(current, a.open, t, cap, trace)
  const i = rank(current)
  if (isYes(a.sameFailure, t)) trace?.push({ k: 'flag', id: 'same_failure', value: a.sameFailure!, effect: 'up-one' })
  if (isYes(a.contradictsPlan, t)) trace?.push({ k: 'flag', id: 'contradicts_plan', value: a.contradictsPlan!, effect: 'up-one' })
  const flagUp = isYes(a.sameFailure, t) || isYes(a.contradictsPlan, t)
  if (rank(decided) > i || flagUp) {
    // A flag alone moves one step, never past the cap; the open question may move further.
    const step = i < rank(cap) ? i + 1 : i
    const level = LEVELS[Math.max(rank(decided), step)]!
    if (level === current) {
      trace?.push({ k: 'cap', at: current })
      return { level: current, reason: 'hold' }
    }
    const reason: Reason = isYes(a.sameFailure, t) ? 'same-failure' : isYes(a.contradictsPlan, t) ? 'contradicts-plan' : 'more-open'
    return { level, reason }
  }
  if (rank(decided) < i) {
    if (isYes(a.causeFound, t)) trace?.push({ k: 'flag', id: 'cause_found', value: a.causeFound!, effect: 'allow-down' })
    if (isYes(a.onlyCarryingOut, t)) trace?.push({ k: 'flag', id: 'only_carrying_out', value: a.onlyCarryingOut!, effect: 'allow-down' })
  }
  if (rank(decided) < i && (isYes(a.causeFound, t) || isYes(a.onlyCarryingOut, t))) {
    return { level: decided, reason: isYes(a.causeFound, t) ? 'cause-found' : 'carrying-out' }
  }
  if (rank(decided) < i) trace?.push({ k: 'blocked', at: current })
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
