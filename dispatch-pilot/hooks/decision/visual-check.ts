// Judging with images (#57, ADR 0008): the questions visual_check asks about a screenshot, and how the decision model's
// answers become a verdict for each check. The eval's visual-check suite (#65) asks and reads the very same way, so this is pure
// (see system-one.ts): no `$`, no files; the images arrive already read and sized (core/image-files.ts).

import { imageRef, type Picture } from './images.ts'
import { keepNewest } from './keep-newest.ts'
import { answersFor, mergeParts, type DecisionRequest, type Part, type Question, type RequestImage, type Answer } from './system-one.ts'

/** One thing to check: a part of the image, and one visible property of it (what to compare, or the requirement it must meet). */
export type Check = { part: string; property: string }

/** What the screenshot is checked against. */
export type Comparison =
  /** A written specification; with none (`spec: null`) each check is judged on its own wording. */
  | { kind: 'spec'; spec: string | null }
  /** One or more reference images (a design, photos of the real object), by path. */
  | { kind: 'reference'; paths: readonly string[] }
  /** Another screenshot, by path. */
  | { kind: 'compare_to'; path: string }
  /** The images are a series of one view at rising quality levels (#61). */
  | { kind: 'sequence' }

/** A share as a whole percent: `0.97` is `97%`. */
export const percent = (share: number): string => `${Math.round(share * 100)}%`

/** A pass, a fail, or no verdict to trust. */
export type Verdict = 'pass' | 'fail' | 'unsure'

// The bars (ADR 0008, revised 2026-10-15 by the user after two evaluations). A check passes at `passAt` or more and fails at `failAt`
// or less; both ends are in. Three sets, each with its own constants so that no number is written twice.

/** The probability that a check holds from which it passes (screenshot, crop, recording: 0.8; a series asks for more, SERIES_PASS_AT). */
export const PASS_AT = 0.8
/** The probability that a check holds up to which it fails on a screenshot (and on the whole images that stand in for a crop that failed). */
export const FAIL_AT = 0.2
/** The same for a recording: the frames of a motion give a lower score to a motion that is wrong, so the fail bar is higher (the evaluation of 2026-10-15). */
export const RECORDING_FAIL_AT = 0.4
/** The probability from which a pair of levels of a series counts as "no difference": the weak direction of the answers, so it stays at the old bar. */
export const SERIES_PASS_AT = 0.9

/** The two bars a probability is judged by. */
export type Bars = { readonly passAt: number; readonly failAt: number }
/** A screenshot, a crop of one, a pair of images. */
export const STILL_BARS: Bars = { passAt: PASS_AT, failAt: FAIL_AT }
/** A screen recording (read as its frames). */
export const RECORDING_BARS: Bars = { passAt: PASS_AT, failAt: RECORDING_FAIL_AT }
/** Each pair of neighbouring levels of a series. */
export const SERIES_BARS: Bars = { passAt: SERIES_PASS_AT, failAt: FAIL_AT }

/** What a verdict rests on: the whole image, or the crop of the part (#59). */
export type Basis = 'whole' | 'zoom'

/** What came of one check. `why`: for an unsure verdict, the reason the answer gives. */
export type CheckResult = { check: Check; verdict: Verdict; probability: number | null; basis: Basis; why?: string }

/**
 * The verdict for a probability that a check holds. A probability between the two bars is unsure. `trust`: what the probability
 * may decide: `both` (a pass and a fail), or `fail` (only a fail: the whole image cannot confirm that a part matches a
 * reference, ADR 0008). `bars`: a screenshot's unless said otherwise.
 */
export function judge(probability: number | null, trust: 'both' | 'fail', bars: Bars = STILL_BARS): { verdict: Verdict; why?: string } {
  if (probability === null) return { verdict: 'unsure', why: 'the decision model gave no answer to this check' }
  if (probability <= bars.failAt) return { verdict: 'fail' }
  if (probability >= bars.passAt) return trust === 'both' ? { verdict: 'pass' } : { verdict: 'unsure', why: 'a match with a reference cannot be confirmed from the whole image' }
  return { verdict: 'unsure', why: 'the decision model is not sure either way' }
}

/** All the checks end unsure, for a reason that touches them all. */
export function allUnsure(checks: readonly Check[], why: string): CheckResult[] {
  return checks.map((check) => ({ check, verdict: 'unsure' as const, probability: null, basis: 'whole' as const, why }))
}

/** The comparison kinds that are checked against an image, and so can be zoomed. */
export const isCompared = (comparison: Comparison): boolean => comparison.kind === 'reference' || comparison.kind === 'compare_to'

/** The part of a request that holds the checks' questions, named so that the question of a check is `check.<index>`. */
export const CHECK_PART = 'check'

/** The images a call checks: the screenshot, and what it is compared with. */
export type Subjects = { screenshot: Picture; references: readonly Picture[] }

/** The names the images a screenshot is compared with go by in a request: `reference` (`reference-1`, `reference-2`, ... for several) or `other`. */
export function comparedNames(comparison: Comparison, count: number): string[] {
  return comparison.kind === 'reference' && count > 1 ? Array.from({ length: count }, (_, i) => `reference-${i + 1}`) : [comparison.kind === 'reference' ? 'reference' : 'other']
}

/** A picture as an image of a request, under `name`. */
export const requestImage = (name: string, picture: Picture): RequestImage => ({ name, format: picture.format, base64: picture.base64, width: picture.width, height: picture.height })

/**
 * The first request of a call (the whole images): one Noul for each check, all in the same request, the images in the state
 * once. Against a spec (or against nothing) the screenshot is `screenshot`; against a reference or another screenshot it is
 * `candidate` and the others `reference` (`reference-1`, `reference-2`, ... if there are several) or `other`.
 */
export function wholeImageRequest(comparison: Comparison, subjects: Subjects, checks: readonly Check[]): { request: DecisionRequest; part: Part } {
  const { screenshot, references } = subjects
  const compared = isCompared(comparison)
  const state: Record<string, unknown> = {}
  const images: RequestImage[] = []
  let ask: (check: Check) => string
  if (!compared) {
    images.push(requestImage('screenshot', screenshot))
    state.screenshot = imageRef('screenshot')
    const spec = comparison.kind === 'spec' ? comparison.spec : null
    if (spec !== null) state.specification = spec
    ask = (check) => `In \`screenshot\`, does ${check.part} meet this requirement: ${check.property}?${spec === null ? '' : ' The specification it belongs to is in `specification`.'}`
  } else {
    images.push(requestImage('candidate', screenshot))
    state.candidate = imageRef('candidate')
    const names = comparedNames(comparison, references.length)
    references.forEach((picture, i) => {
      const name = names[i] as string
      images.push(requestImage(name, picture))
      state[name] = imageRef(name)
    })
    const those = names.length === 1 ? `\`${names[0]}\`` : `the reference images (${names.map((name) => `\`${name}\``).join(', ')}), which show it from different sides`
    ask = (check) => `In \`candidate\`, is the ${check.property} of ${check.part} the same as in ${those}?`
  }
  const questions: Record<string, Question> = Object.fromEntries(checks.map((check, i) => [String(i), { type: 'noul' as const, instructions: ask(check) }]))
  const part: Part = { part: CHECK_PART, questions }
  return { request: { ...mergeParts(state, [part]), images }, part }
}

/** The probability of a Noul answer; null for one that is missing or is another kind of answer. */
export function yesOf(answer: Answer | undefined): number | null {
  return answer !== undefined && answer.type === 'noul' ? answer.noul : null
}

/**
 * What the answers to the first request say of each check, by the whole image. Against a spec, or against nothing, a high
 * probability passes; against a reference or another screenshot only a low one counts (`judge`). `bars`: a recording's frames are
 * judged by RECORDING_BARS, anything else by a screenshot's.
 */
export function readWholeImage(comparison: Comparison, part: Part, answers: Readonly<Record<string, unknown>>, checks: readonly Check[], bars: Bars = STILL_BARS): CheckResult[] {
  const own = answersFor(part, answers)
  const trust = isCompared(comparison) ? 'fail' : 'both'
  return checks.map((check, i) => {
    const probability = yesOf(own[String(i)])
    return { check, probability, basis: 'whole' as const, ...judge(probability, trust, bars) }
  })
}

// ---- The same check failing again ------------------------------------------------------------------------------------

/** For each agent ('main' or an agent's id), how many times in a row each check has failed in its loop. */
export type Streaks = Map<string, Map<string, number>>

/** Most agents and checks a record keeps (the oldest are dropped): it is only a reminder. */
const MOST_AGENTS = 64
const MOST_CHECKS = 200

/** A check by its words, spaced and cased alike: the part and the property. */
export function checkKey(check: Check): string {
  return `${check.part}\n${check.property}`.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** The loop of `agent` begins (a turn of the main agent, an agent's run): its count starts again. */
export function forgetLoop(streaks: Streaks, agent: string): void {
  streaks.delete(agent)
}

/**
 * Notes what a call found in the loop of `agent` and gives the checks, by their index, that have now failed twice or more in a
 * row there: a FAIL adds one to its check's count; a pass or an unsure verdict ends it.
 */
export function noteResults(streaks: Streaks, agent: string, results: readonly CheckResult[]): number[] {
  const mine = streaks.get(agent) ?? new Map<string, number>()
  streaks.delete(agent)
  streaks.set(agent, mine)
  keepNewest(streaks, MOST_AGENTS)
  const repeated: number[] = []
  results.forEach((result, i) => {
    const key = checkKey(result.check)
    if (result.verdict !== 'fail') {
      mine.delete(key)
      return
    }
    const count = (mine.get(key) ?? 0) + 1
    mine.set(key, count)
    if (count >= 2) repeated.push(i)
  })
  keepNewest(mine, MOST_CHECKS)
  return repeated
}
