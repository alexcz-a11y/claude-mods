// How a yes/no answer (a Noul) is read: the decision model's guide, not ours (decision/guides.ts; ADR 0014, ADR 0017).
// TypeSafe's for Jev and pplx (docs.typesafe.ai: "A good starting point is 0.7 for yes and 0.3 for no ... Values between 0.3
// and 0.7 can go to a person rather than either code path"), Liquid's for d1-ultra (yes above 0.8, no below 0.2). The band
// between has its own row in every rule that reads a Noul (decision/message-effort.ts, decision/unresolved.ts).
//
// Pure (see system-one.ts).

import { TYPESAFE_GUIDE, type NoulBars } from './guides.ts'
import type { Answer } from './system-one.ts'

/** TypeSafe's yes bar: at or above it a Noul reads as yes (Jev's and pplx's; d1-ultra's is its guide's, decision/guides.ts). */
export const NOUL_YES = TYPESAFE_GUIDE.noul.yes
/** TypeSafe's no bar: at or below it a Noul reads as no; between the two, the band. */
export const NOUL_NO = TYPESAFE_GUIDE.noul.no

/** What a Noul's probability reads as. */
export type Verdict = 'yes' | 'band' | 'no'

/** What `p` reads as against `bars` (TypeSafe's unless given). */
export function verdictOf(p: number, bars: NoulBars = TYPESAFE_GUIDE.noul): Verdict {
  if (bars.inclusive) return p >= bars.yes ? 'yes' : p <= bars.no ? 'no' : 'band'
  return p > bars.yes ? 'yes' : p < bars.no ? 'no' : 'band'
}

/** Whether `p` reaches the yes bar of `bars`. */
export function isYes(p: number, bars: NoulBars = TYPESAFE_GUIDE.noul): boolean {
  return verdictOf(p, bars) === 'yes'
}

/** A Noul answer's probability that the statement holds; null when the answer is missing or not a Noul. */
export function readNoul(answer: Answer | undefined): number | null {
  if (answer === undefined || answer.type !== 'noul' || !Number.isFinite(answer.noul)) return null
  return Math.min(1, Math.max(0, answer.noul))
}

/** The verdict of a probability that may be missing: a missing answer reads as no (nothing is lifted or moved by it). */
export function verdictOrNo(p: number | null, bars: NoulBars = TYPESAFE_GUIDE.noul): Verdict {
  return p === null ? 'no' : verdictOf(p, bars)
}
