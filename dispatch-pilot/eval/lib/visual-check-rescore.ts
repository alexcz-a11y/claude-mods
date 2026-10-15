// The visual-check results read again by other bars (ADR 0008, revised 2026-10-15): every check keeps the probability its verdict rests
// on (`p`) and what that probability may decide (`trust`), so the verdicts of a stored result can be worked out afresh for any bars
// without a request. The user's decision of that day: PASS from 0.9 to 0.8 for a screenshot, a crop and a recording; FAIL up to 0.4
// for a recording (a screenshot stays 0.2); a series keeps 0.9. This is what the old and the new bars say of the same answers.
//
// Pure: no Node API. The script eval/rescore-visual-check.ts reads the result files and writes the figures.

import { FAIL_AT, judge, PASS_AT, RECORDING_BARS, STILL_BARS, type Bars, type Verdict } from '../../hooks/decision/visual-check.ts'
import { isRecord } from './datasets.ts'

/** The bars before 2026-10-15 (ADR 0008 as the spec of #55 set them): PASS from 0.9, FAIL up to 0.2, for every kind. */
export const BARS_BEFORE: Bars = { passAt: 0.9, failAt: FAIL_AT }

/** The kinds of item with checks, and the bars the mod judges each by now: the frames of an animation are a recording's, the rest are stills. */
export const KINDS = ['ui', 'sea', 'anim'] as const
export type Kind = (typeof KINDS)[number]
export const barsNow = (kind: Kind): Bars => (kind === 'anim' ? RECORDING_BARS : STILL_BARS)

/** What the checks of a group came to. `unsure` counts the checks with no verdict to trust; the rates are over `checks`, `differ` or `same`. */
export type Tally = {
  checks: number
  /** Checks that do not hold (the part differs, the requirement is not met). */
  differ: number
  /** Checks that hold. */
  same: number
  /** A check that does not hold, judged PASS (it must be none). */
  falsePass: number
  /** A check that holds, judged FAIL. */
  falseFail: number
  /** A check that does not hold, judged FAIL. */
  caught: number
  /** A check that holds, judged PASS. */
  passed: number
  unsure: number
  unsureDiffer: number
  unsureSame: number
}

const emptyTally = (): Tally => ({ checks: 0, differ: 0, same: 0, falsePass: 0, falseFail: 0, caught: 0, passed: 0, unsure: 0, unsureDiffer: 0, unsureSame: 0 })

/** One more check in `into`. */
function add(into: Tally, holds: boolean, verdict: Verdict): void {
  into.checks++
  if (holds) into.same++
  else into.differ++
  if (verdict === 'unsure') {
    into.unsure++
    if (holds) into.unsureSame++
    else into.unsureDiffer++
  } else if (verdict === 'pass') {
    if (holds) into.passed++
    else into.falsePass++
  } else if (holds) into.falseFail++
  else into.caught++
}

/** What a stored result keeps of a check (CheckDetail in visual-check.ts) and of its item. */
export type StoredCheck = { holds: boolean; verdict: Verdict; p: number | null; trust: 'both' | 'fail' }
type StoredAnswer = { id: string; repeat?: number; language: string } & Record<string, unknown>

export type Rescored = {
  variant: string
  /** The verdicts as stored (the bars of the day of the run). */
  stored: Record<Kind | 'all', Tally>
  /** The same probabilities judged by the bars before 2026-10-15; they must reproduce `stored`. */
  before: Record<Kind | 'all', Tally>
  /** The same probabilities judged by the bars of now. */
  now: Record<Kind | 'all', Tally>
  /** How many checks the old bars gave a different verdict from the stored one (0: the probabilities reproduce the run). */
  notReproduced: number
}

const emptyGroups = (): Record<Kind | 'all', Tally> => ({ ui: emptyTally(), sea: emptyTally(), anim: emptyTally(), all: emptyTally() })

/** The checks stored in an answer's variant, with its kind; none for a complexity item or an answer that failed. */
function checksOf(answer: StoredAnswer, variant: string): { kind: Kind; checks: StoredCheck[] } | null {
  const own = answer[variant]
  if (!isRecord(own) || !(KINDS as readonly unknown[]).includes(own.kind) || !Array.isArray(own.checks)) return null
  return { kind: own.kind as Kind, checks: own.checks as StoredCheck[] }
}

/**
 * The checks of `variant` in a result's answers judged three ways: as stored, by the old bars, by the bars of now. Every answer
 * counts, a repeated item (`repeat`) once for each time it was asked.
 */
export function rescoreVariant(answers: readonly StoredAnswer[], variant: string): Rescored {
  const out: Rescored = { variant, stored: emptyGroups(), before: emptyGroups(), now: emptyGroups(), notReproduced: 0 }
  for (const answer of answers) {
    if (answer.language !== 'zh') continue
    const found = checksOf(answer, variant)
    if (found === null) continue
    for (const check of found.checks) {
      const before = judge(check.p, check.trust, BARS_BEFORE).verdict
      const now = judge(check.p, check.trust, barsNow(found.kind)).verdict
      if (before !== check.verdict) out.notReproduced++
      for (const group of [found.kind, 'all'] as const) {
        add(out.stored[group], check.holds, check.verdict)
        add(out.before[group], check.holds, before)
        add(out.now[group], check.holds, now)
      }
    }
  }
  return out
}

/** The variants a stored result's answers hold (`mod`, `whole`, ...), from its summary. */
export function variantsOf(result: unknown): string[] {
  if (!isRecord(result) || !isRecord(result.summary) || !Array.isArray(result.summary.variants)) return []
  return result.summary.variants.flatMap((variant) => (isRecord(variant) && typeof variant.variant === 'string' ? [variant.variant] : []))
}

/** The answers of a stored result. */
export const answersOf = (result: unknown): StoredAnswer[] => (isRecord(result) && Array.isArray(result.answers) ? (result.answers as StoredAnswer[]) : [])

/** One result file's figures. */
export type RescoredFile = { file: string; label: string; date: string; repeats: number; variants: Rescored[] }

/** What the file holds, rescored for every variant. */
export function rescoreResult(file: string, result: unknown): RescoredFile {
  const run = isRecord(result) && isRecord(result.run) ? result.run : {}
  return {
    file,
    label: isRecord(result) && typeof result.label === 'string' ? result.label : '',
    date: isRecord(result) && typeof result.date === 'string' ? result.date : '',
    repeats: typeof run.repeats === 'number' ? run.repeats : 1,
    variants: variantsOf(result).map((variant) => rescoreVariant(answersOf(result), variant)),
  }
}

/** The bars the figures are about, written out beside them. */
export const BARS_NOTE = {
  before: { passAt: BARS_BEFORE.passAt, failAt: BARS_BEFORE.failAt, for: 'every kind' },
  now: { screenshot: { passAt: PASS_AT, failAt: FAIL_AT }, recording: { passAt: RECORDING_BARS.passAt, failAt: RECORDING_BARS.failAt }, series: 'PASS from 0.9, FAIL up to 0.2 (unchanged; no series is in the evaluation set)' },
} as const
