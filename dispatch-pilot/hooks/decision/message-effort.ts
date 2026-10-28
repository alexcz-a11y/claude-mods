// The main agent's effort for a message, from the answers of its effort part (ADR 0014): the decision model judges, the code
// decides (TypeSafe's guide: "Judgments from Jev, decisions in code"; every combination of answers has its row).
//
//   base   the effort question's position, rounded; one level up when the answer is unsure, as the decision model's guide
//          says (decision/guides.ts: two-peaked for Jev and pplx, confidence below 0.5 for d1-ultra; decision/effort.ts `traceEffort`)
//   R1     `ultrathink` in the person's message                                   → at least xhigh
//   ask    escalate yes: the person asks for more thought or a stronger model     → at least xhigh (ADR 0016)
//          confirm yes: the person only goes on with what was offered             → at least the previous turn's effort
//   R2     stakes.undo yes, and stakes.live or stakes.access yes                   → max
//          any stake yes                                                           → at least xhigh
//          any stake in the band                                                   → at least high
//   R3     cause_unknown yes → at least xhigh; in the band → at least high
//   R4     still_failing yes, and the person's previous turn stuck (its failures reached escalateAfter)
//                                                                                  → at least that turn's effort, one up
//   R5     still_failing yes, and the unresolved count with this message ≥ unresolvedMaxAfter (0: never) → max
//   result the highest of the base and every floor; a lock wins over all of it (the core's `planStep`, and the last step here)
//
// A floor only lifts, never lowers. A missing answer lifts nothing; a Noul in the band lifts only where a row says so. A Noul is
// read at the guide's bars (Jev and pplx: yes from 0.7, no up to 0.3; d1-ultra: yes above 0.8, no below 0.2), and the bars go
// into each step. Each row is a step of the trace the card words (ADR 0004).
//
// Pure (see system-one.ts): the mod and the eval decide alike.

import { CONFIRM, ESCALATE } from './asks.ts'
import { CAUSE_UNKNOWN, EFFORTS, higherEffort, STAKES_ACCESS, STAKES_LIVE, STAKES_UNDO, traceEffort, type Effort, type EffortReading, type EffortStep } from './effort.ts'
import { TYPESAFE_GUIDE, type Guide } from './guides.ts'
import { readNoul, verdictOrNo, type Verdict } from './nouls.ts'
import type { Answer } from './system-one.ts'
import { STILL_FAILING } from './unresolved.ts'

/** What the floors read, beside the effort answer. Probabilities are null where an answer is missing (or not asked). */
export type MessageSignals = {
  /** The person's message names `ultrathink` (`namesUltrathink`); false for a report's turn. */
  ultrathink: boolean
  stakes: { undo: number | null; live: number | null; access: number | null }
  causeUnknown: number | null
  stillFailing: number | null
  /** The person only goes on with what was offered (decision/asks.ts); null for a report's turn or a missing answer. */
  confirm: number | null
  /** The person asks for more thought or a stronger model; null for a report's turn or a missing answer. */
  escalate: number | null
  /** The turn the person's previous message started: the effort its steps went out at and whether it was stuck; null when there is none. */
  lastTurn: { effort: Effort | null; stuck: boolean } | null
  /** The unresolved count with this message's own change in it. */
  count: number
  /** `unresolvedMaxAfter`: the count from which a message still failing goes to max; 0 never. */
  maxAfter: number
  /** The person's lock, which wins over every rule; null when unlocked. */
  lock: Effort | null
}

type Fields = Record<string, string | number | boolean | null>

/** One floor's step: the rule, whether it lifted the level, the floor it gave (null: none), the level after it, and its own fields. */
export type FloorStep = { rule: 'ultrathink' | 'escalate' | 'confirm' | 'stakes' | 'cause-unknown' | 'stuck-again' | 'unresolved-count' | 'lock'; applied: boolean; level: Effort; floor: Effort | null } & Fields

/** Every step of a message's decision: the base's, then the floors', then the lock's. */
export type MessageStep = EffortStep | FloorStep

export type MessageDecision = {
  /** What the turn goes out at when no lock holds (the plan's effort). */
  effort: Effort
  /** What goes out with the lock as it stood when decided: the lock's level, else `effort`. */
  sent: Effort
  steps: MessageStep[]
  /** Which floor lifted the level last (null: the base stood), for the board's one-line reason. */
  lifted: FloorStep['rule'] | null
}

/**
 * The signals of a message out of its effort part's answers (by the part's own ids) and what the session kept: the mod and the
 * eval read them alike. `own`: the person's own words (a report's turn has no ultrathink and no "still failing" of theirs).
 */
export function messageSignals(answers: Readonly<Record<string, Answer>>, input: { own: boolean; text: string; lastTurn: MessageSignals['lastTurn']; count: number; maxAfter: number; lock: Effort | null }): MessageSignals {
  return {
    ultrathink: input.own && namesUltrathink(input.text),
    stakes: { undo: readNoul(answers[STAKES_UNDO]), live: readNoul(answers[STAKES_LIVE]), access: readNoul(answers[STAKES_ACCESS]) },
    causeUnknown: readNoul(answers[CAUSE_UNKNOWN]),
    stillFailing: input.own ? readNoul(answers[STILL_FAILING]) : null,
    confirm: input.own ? readNoul(answers[CONFIRM]) : null,
    escalate: input.own ? readNoul(answers[ESCALATE]) : null,
    lastTurn: input.lastTurn,
    count: input.count,
    maxAfter: input.maxAfter,
    lock: input.lock,
  }
}

/** One level above `level`, at most max; null stays null. */
function oneUp(level: Effort | null): Effort | null {
  if (level === null) return null
  return EFFORTS[Math.min(EFFORTS.indexOf(level) + 1, EFFORTS.length - 1)] as Effort
}

/** R2's floor from the three stakes' verdicts. */
export function stakesFloor(undo: Verdict, live: Verdict, access: Verdict): Effort | null {
  if (undo === 'yes' && (live === 'yes' || access === 'yes')) return 'max'
  if (undo === 'yes' || live === 'yes' || access === 'yes') return 'xhigh'
  if (undo === 'band' || live === 'band' || access === 'band') return 'high'
  return null
}

/** R3's floor from the unknown cause's verdict. */
export function causeFloor(cause: Verdict): Effort | null {
  return cause === 'yes' ? 'xhigh' : cause === 'band' ? 'high' : null
}

/** The decision for a message: the base, then every floor in order, then the lock; read as `guide` says (TypeSafe's unless given). */
export function decideMessage(reading: EffortReading, signals: MessageSignals, guide: Guide = TYPESAFE_GUIDE): MessageDecision {
  const bars = guide.noul
  const held = { yes: bars.yes, no: bars.no, inclusive: bars.inclusive }
  const base = traceEffort(reading, {}, guide.scoreUnsure)
  const steps: MessageStep[] = [...base.steps]
  let level: Effort = base.effort
  let lifted: FloorStep['rule'] | null = null
  const floorStep = (rule: Exclude<FloorStep['rule'], 'lock'>, floor: Effort | null, fields: Fields) => {
    const after = higherEffort(level, floor) as Effort
    const applied = after !== level
    if (applied) lifted = rule
    level = after
    steps.push({ rule, applied, level, floor, ...fields })
  }
  const pct = (p: number | null) => (p === null ? null : Math.round(p * 1000) / 1000)

  floorStep('ultrathink', signals.ultrathink ? 'xhigh' : null, { named: signals.ultrathink })

  const escalate = verdictOrNo(signals.escalate, bars)
  floorStep('escalate', escalate === 'yes' ? 'xhigh' : null, { p: pct(signals.escalate), verdict: escalate, ...held })

  const lastEffort = signals.lastTurn?.effort ?? null
  const confirm = verdictOrNo(signals.confirm, bars)
  floorStep('confirm', confirm === 'yes' ? lastEffort : null, { p: pct(signals.confirm), verdict: confirm, lastEffort, ...held })

  const undo = verdictOrNo(signals.stakes.undo, bars)
  const live = verdictOrNo(signals.stakes.live, bars)
  const access = verdictOrNo(signals.stakes.access, bars)
  floorStep('stakes', stakesFloor(undo, live, access), { undo: pct(signals.stakes.undo), undoVerdict: undo, live: pct(signals.stakes.live), liveVerdict: live, access: pct(signals.stakes.access), accessVerdict: access, ...held })

  const cause = verdictOrNo(signals.causeUnknown, bars)
  floorStep('cause-unknown', causeFloor(cause), { p: pct(signals.causeUnknown), verdict: cause, ...held })

  const failing = verdictOrNo(signals.stillFailing, bars)
  const stuck = signals.lastTurn?.stuck === true
  floorStep('stuck-again', failing === 'yes' && stuck ? oneUp(lastEffort) : null, { p: pct(signals.stillFailing), verdict: failing, stuck, lastEffort, ...held })

  const reached = signals.maxAfter > 0 && signals.count >= signals.maxAfter
  floorStep('unresolved-count', failing === 'yes' && reached ? 'max' : null, { p: pct(signals.stillFailing), verdict: failing, count: signals.count, maxAfter: signals.maxAfter })

  const decided = level
  if (signals.lock !== null) steps.push({ rule: 'lock', applied: true, level: signals.lock, floor: null, decided })
  return { effort: decided, sent: signals.lock ?? decided, steps, lifted }
}

/**
 * Characters that make `ultrathink` part of a path, a name or a longer word when they touch it. Not CJK: `请ultrathink一下`
 * asks for it, as a word boundary reads it. A `.` or `:` only joins when a character of this kind follows it (`ultrathink.md`),
 * not at the end of a sentence.
 */
const ATTACHED = /[A-Za-z0-9_\-./\\~:@]/
const JOINS_ONLY_BEFORE = /[.:]/
/** Quote marks: a word between a pair of them on its line is quoted, not asked for. */
const QUOTES: readonly [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
]

/** Whether the word at [start, end) of `line` sits between a pair of one of the quote marks. */
function quoted(line: string, start: number, end: number): boolean {
  return QUOTES.some(([open, close]) => {
    const before = line.slice(0, start)
    const after = line.slice(end)
    if (open === close) {
      const count = before.split(open).length - 1
      return count % 2 === 1 && after.includes(close)
    }
    return before.lastIndexOf(open) > before.lastIndexOf(close) && after.includes(close)
  })
}

/**
 * Whether the person's message asks for `ultrathink` as Claude Code reads it (2.1.311: it raises the turn to xhigh, and the
 * keyword is not taken when it is quoted or part of a file path): the word on its own, any case, not touched by a path's or a
 * name's characters, not between quote marks or in a code block.
 */
export function namesUltrathink(text: string): boolean {
  let fenced = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const found = /ultrathink/gi
    for (let match = found.exec(line); match !== null; match = found.exec(line)) {
      const start = match.index
      const end = start + match[0].length
      const left = line[start - 1] ?? ''
      const right = line[end] ?? ''
      const leftJoins = left !== '' && ATTACHED.test(left)
      const rightJoins = right !== '' && ATTACHED.test(right) && (!JOINS_ONLY_BEFORE.test(right) || ATTACHED.test(line[end + 1] ?? ''))
      if (leftJoins || rightJoins || quoted(line, start, end)) continue
      return true
    }
  }
  return false
}
