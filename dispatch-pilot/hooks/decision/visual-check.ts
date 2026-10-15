// Judging with images (#57, ADR 0008): the questions visual_check asks about a screenshot, and how the decision model's
// answers become a verdict for each check. The eval's visual-check suite (#65) asks and reads the very same way, so this is pure
// (see system-one.ts): no `$`, no files; the images arrive already read and sized (core/image-files.ts).

import { imageRef, type Picture } from './images.ts'
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

/** A pass, a fail, or no verdict to trust. */
export type Verdict = 'pass' | 'fail' | 'unsure'

/** The probability that a check holds from which it passes (ADR 0008: "一致" at or above 0.9). */
export const PASS_AT = 0.9
/** The probability that a check holds up to which it fails (at or below 0.2). */
export const FAIL_AT = 0.2

/** What a verdict rests on: the whole image, or the crop of the part (#59). */
export type Basis = 'whole' | 'zoom'

/** What came of one check. `why`: for an unsure verdict, the reason the answer gives. */
export type CheckResult = { check: Check; verdict: Verdict; probability: number | null; basis: Basis; why?: string }

/**
 * The verdict for a probability that a check holds. A probability between the two bars is unsure. `trust`: what the probability
 * may decide: `both` (a pass and a fail), or `fail` (only a fail: the whole image cannot confirm that a part matches a
 * reference, ADR 0008).
 */
export function judge(probability: number | null, trust: 'both' | 'fail'): { verdict: Verdict; why?: string } {
  if (probability === null) return { verdict: 'unsure', why: 'the decision model gave no answer to this check' }
  if (probability <= FAIL_AT) return { verdict: 'fail' }
  if (probability >= PASS_AT) return trust === 'both' ? { verdict: 'pass' } : { verdict: 'unsure', why: 'a match with a reference cannot be confirmed from the whole image' }
  return { verdict: 'unsure', why: 'the decision model is not sure either way' }
}

/** The part of a request that holds the checks' questions, named so that the question of a check is `check.<index>`. */
export const CHECK_PART = 'check'

/** The images a call checks: the screenshot, and what it is compared with. */
export type Subjects = { screenshot: Picture; references: readonly Picture[] }

const named = (name: string, picture: Picture): RequestImage => ({ name, format: picture.format, base64: picture.base64, width: picture.width, height: picture.height })

/**
 * The first request of a call (the whole images): one Noul for each check, all in the same request, the images in the state
 * once. Against a spec (or against nothing) the screenshot is `screenshot`; against a reference or another screenshot it is
 * `candidate` and the others `reference` (`reference-1`, `reference-2`, ... if there are several) or `other`.
 */
export function wholeImageRequest(comparison: Comparison, subjects: Subjects, checks: readonly Check[]): { request: DecisionRequest; part: Part } {
  const { screenshot, references } = subjects
  const compared = comparison.kind === 'reference' || comparison.kind === 'compare_to'
  const state: Record<string, unknown> = {}
  const images: RequestImage[] = []
  let ask: (check: Check) => string
  if (!compared) {
    images.push(named('screenshot', screenshot))
    state.screenshot = imageRef('screenshot')
    const spec = comparison.kind === 'spec' ? comparison.spec : null
    if (spec !== null) state.specification = spec
    ask = (check) => `In \`screenshot\`, does ${check.part} meet this requirement: ${check.property}?${spec === null ? '' : ' The specification it belongs to is in `specification`.'}`
  } else {
    images.push(named('candidate', screenshot))
    state.candidate = imageRef('candidate')
    const names = comparison.kind === 'reference' && references.length > 1 ? references.map((_, i) => `reference-${i + 1}`) : [comparison.kind === 'reference' ? 'reference' : 'other']
    references.forEach((picture, i) => {
      const name = names[i] as string
      images.push(named(name, picture))
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
function yesOf(answer: Answer | undefined): number | null {
  return answer !== undefined && answer.type === 'noul' ? answer.noul : null
}

/**
 * What the answers to the first request say of each check, by the whole image. Against a spec, or against nothing, a high
 * probability passes; against a reference or another screenshot only a low one counts (`judge`).
 */
export function readWholeImage(comparison: Comparison, part: Part, answers: Readonly<Record<string, unknown>>, checks: readonly Check[]): CheckResult[] {
  const own = answersFor(part, answers)
  const trust = comparison.kind === 'reference' || comparison.kind === 'compare_to' ? 'fail' : 'both'
  return checks.map((check, i) => {
    const probability = yesOf(own[String(i)])
    return { check, probability, basis: 'whole' as const, ...judge(probability, trust) }
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
  for (const oldest of [...streaks.keys()].slice(0, Math.max(0, streaks.size - MOST_AGENTS))) streaks.delete(oldest)
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
  for (const oldest of [...mine.keys()].slice(0, Math.max(0, mine.size - MOST_CHECKS))) mine.delete(oldest)
  return repeated
}
