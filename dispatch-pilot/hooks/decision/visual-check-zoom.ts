// The zoomed re-check of visual_check (#59, ADR 0008): the Box questions that locate each named part in both images, the Noul that
// asks of a pair of crops whether the property is the same, and how the answers become verdicts. Against a reference or another
// screenshot a part is cut out of both, enlarged, and judged on the crops, where the whole images cannot confirm a match. The eval's
// visual-check suite (#65) asks and reads the very same way, so this is pure (see system-one.ts): no `$`, no files.

import { type Box, boxArea, coverage, ELSEWHERE_MAX_AREA, ELSEWHERE_MIN_CONFIDENCE, normalizeBox } from './zoom.ts'
import { imageRef, imageTokens, type Picture } from './images.ts'
import { answersFor, mergeParts, type Answer, type DecisionRequest, type Part, type Question, type RequestImage, MAX_QUESTIONS } from './system-one.ts'
import { judge, type Check, type CheckResult } from './visual-check.ts'

// ---- Locating: the Box questions of the first request ----------------------------------------------------------------

/** The part of the first request that holds the Box questions of the named parts: the question of a part in an image is `box.<check>.<image's name>`. */
export const BOX_PART = 'box'
/** The part with the one Box question for the whole screen: `where.screen`. */
export const WHERE_PART = 'where'
const WHERE_ID = 'screen'

/** The first letter capital: a part is written as a noun phrase in the middle of a sentence ("the primary button"), a question starts with it. */
const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** A check with the ids of the Box questions that locate its part: in the candidate, and in each image it is compared with. */
export type Located = { index: number; check: Check; candidate: string; references: readonly string[] }

/** What the first request asks to locate, and why some checks are not located. */
export type LocatePlan = {
  /** The parts to add to the first request (none when nothing is to be located). */
  parts: readonly Part[]
  /** The checks whose part is located. */
  located: readonly Located[]
  /** The checks that are not located, by index, with the reason. */
  skipped: ReadonlyMap<number, string>
  /** The Box question for the whole screen is asked. */
  where: boolean
}

/**
 * The Box questions for `checks`: each part a check names, in the screenshot (`candidate`) and in each of the images it is
 * compared with (`names`), and, when there is one image to compare with and it shows the same view, one for where the two differ
 * (with several images, or another view, everything differs: there is nothing to find). `sameViews`: for each image of `names`,
 * whether it shows the same view as the screenshot. A request holds at most 64 questions: the checks that do not fit are not located.
 */
export function locatePlan(names: readonly string[], sameViews: readonly boolean[], checks: readonly Check[]): LocatePlan {
  const where = names.length === 1 && sameViews[0] === true
  let room = MAX_QUESTIONS - checks.length - (where ? 1 : 0)
  const located: Located[] = []
  const skipped = new Map<number, string>()
  const boxes: Record<string, Question> = {}
  checks.forEach((check, index) => {
    if (check.part === '') {
      skipped.set(index, 'the check names no part of the image, so there is nothing to cut out')
      return
    }
    const cost = 1 + names.length
    if (cost > room) {
      skipped.set(index, 'there are too many checks to locate every part in one request')
      return
    }
    room -= cost
    const ask = (image: string): string => `${sentence(check.part)} in \`${image}\`.`
    const candidate = `${index}.candidate`
    boxes[candidate] = { type: 'box', instructions: ask('candidate') }
    const references = names.map((name) => `${index}.${name}`)
    names.forEach((name, i) => {
      boxes[references[i] as string] = { type: 'box', instructions: ask(name) }
    })
    located.push({ index, check, candidate, references })
  })
  const parts: Part[] = []
  if (located.length > 0) parts.push({ part: BOX_PART, questions: boxes })
  if (where) parts.push({ part: WHERE_PART, questions: { [WHERE_ID]: { type: 'box', instructions: `The region of \`candidate\` that differs from \`${names[0]}\`.` } } })
  return { parts, located, skipped, where }
}

/** The first request with the Box questions of `plan` added (its images and everything else as it was). */
export function withBoxes(first: { request: DecisionRequest; part: Part }, plan: LocatePlan): DecisionRequest {
  if (plan.parts.length === 0) return first.request
  const merged = mergeParts(first.request.state, [first.part, ...plan.parts])
  return { ...merged, ...(first.request.images === undefined ? {} : { images: first.request.images }) }
}

/** A check with the boxes the model gave for its part: each null where the model gave none that is a box. */
export type Boxed = { located: Located; candidate: Box | null; references: readonly (Box | null)[] }

/** A place where the two images may differ: the box of "where do they differ", and how sure the model is of it. */
export type Elsewhere = { box: Box; confidence: number }

const boxOf = (answer: Answer | undefined): { box: Box | null; confidence: number | null } =>
  answer !== undefined && answer.type === 'box' ? { box: normalizeBox(answer.box), confidence: answer.confidence } : { box: null, confidence: null }

/**
 * What the first request's answers locate: the boxes of each located check, and the place that may differ. The place is
 * reported when the model's confidence in it is at least 0.2 and it covers no more than a quarter of the screen (ADR 0008): the
 * model always boxes something, even between two images that are the same. Confidence in the box of a named part says only how
 * well the model knows the part by name, so it is never read as a difference.
 */
export function readLocated(plan: LocatePlan, answers: Readonly<Record<string, unknown>>): { boxed: Boxed[]; elsewhere: Elsewhere | null } {
  const own = plan.parts.find((part) => part.part === BOX_PART)
  const boxes = own === undefined ? {} : answersFor(own, answers)
  const boxed = plan.located.map((located) => ({ located, candidate: boxOf(boxes[located.candidate]).box, references: located.references.map((id) => boxOf(boxes[id]).box) }))
  const wherePart = plan.parts.find((part) => part.part === WHERE_PART)
  const where = wherePart === undefined ? undefined : boxOf(answersFor(wherePart, answers)[WHERE_ID])
  const elsewhere = where?.box != null && where.confidence !== null && where.confidence >= ELSEWHERE_MIN_CONFIDENCE && boxArea(where.box) <= ELSEWHERE_MAX_AREA ? { box: where.box, confidence: where.confidence } : null
  return { boxed, elsewhere }
}

/** Whether a place is within a part that has already failed: it is then reported by that check (with its crop), not again as another place. */
export function withinFailed(elsewhere: Elsewhere, failed: readonly Box[]): boolean {
  return failed.some((box) => coverage(elsewhere.box, box) >= 0.5)
}

// ---- Asking: the second request, a pair of crops in each question ----------------------------------------------------

/** The part of the second request: the question of a pair is `zoom.<check>.<image>` (the image's place among those compared with). */
export const ZOOM_PART = 'zoom'

/** A crop with the name it goes by in the request. */
export type NamedPicture = { name: string; picture: Picture }

/** The two crops of one check's part: from the screenshot, and from the image `reference` (its place among those compared with) is compared with. */
export type ZoomPair = { index: number; reference: number; check: Check; candidate: NamedPicture; other: NamedPicture; otherField: string }

/** The probability of a Noul answer; null for one that is missing or is another kind of answer. */
const yesOf = (answer: Answer | undefined): number | null => (answer !== undefined && answer.type === 'noul' ? answer.noul : null)

const questionId = (pair: Pick<ZoomPair, 'index' | 'reference'>): string => `${pair.index}.${pair.reference}`

/** What a pair's question says: the crops are in its instructions, so that each costs only that question. */
function pairQuestion(pair: ZoomPair): Question {
  const { check, otherField } = pair
  return {
    type: 'noul',
    instructions: {
      question: `Both images are enlarged crops that show ${check.part}, cut out of two images. Is the ${check.property} of ${check.part} the same in \`candidate_crop\` as in \`${otherField}\`?`,
      candidate_crop: imageRef(pair.candidate.name),
      [otherField]: imageRef(pair.other.name),
    },
  }
}

/** About how many input tokens the crops of a request may cost in all: a Jev request holds 64k, and a pair's questions are read one by one. */
export const ZOOM_REQUEST_TOKENS = 48_000

/** The pairs split into requests whose crops cost about `ZOOM_REQUEST_TOKENS` each at the most (a pair is never split). */
export function batchPairs(pairs: readonly ZoomPair[]): ZoomPair[][] {
  const batches: ZoomPair[][] = []
  let tokens = 0
  for (const pair of pairs) {
    const cost = imageTokens('jev', [pair.candidate.picture, pair.other.picture], 1)
    const last = batches.at(-1)
    if (last === undefined || tokens + cost > ZOOM_REQUEST_TOKENS || last.length >= MAX_QUESTIONS - 1) {
      batches.push([pair])
      tokens = cost
    } else {
      last.push(pair)
      tokens += cost
    }
  }
  return batches
}

const requestImage = (crop: NamedPicture): RequestImage => ({ name: crop.name, format: crop.picture.format, base64: crop.picture.base64, width: crop.picture.width, height: crop.picture.height })

/** One request for these pairs: a Noul for each, its two crops in the instructions. */
export function zoomRequest(pairs: readonly ZoomPair[]): { request: DecisionRequest; part: Part } {
  const questions = Object.fromEntries(pairs.map((pair) => [questionId(pair), pairQuestion(pair)]))
  const part: Part = { part: ZOOM_PART, questions }
  const images = new Map<string, RequestImage>()
  for (const pair of pairs) for (const crop of [pair.candidate, pair.other]) if (!images.has(crop.name)) images.set(crop.name, requestImage(crop))
  // Nothing in the state is for the questions to read: the crops are in the instructions.
  return { request: { ...mergeParts({ task: 'Each question compares one part of two images, as shown in two enlarged crops.' }, [part]), images: [...images.values()] }, part }
}

/** For each pair of the request, the probability of "the same" the model gave; null for one it left out. */
export function readZoom(part: Part, answers: Readonly<Record<string, unknown>>, pairs: readonly ZoomPair[]): Map<ZoomPair, number | null> {
  const own = answersFor(part, answers)
  return new Map(pairs.map((pair): [ZoomPair, number | null] => [pair, yesOf(own[questionId(pair)])]))
}

/** The most failed checks whose crops go along with the answer (each is two images): the agent looks at them, in its context. */
export const MAX_CROPPED_CHECKS = 3

// ---- Judging ----------------------------------------------------------------------------------------------------------

/**
 * The verdict of a check from the probabilities of "the same" on its crops (one for each image it is compared with). A part seen
 * from several sides matches if any one side matches, so the highest counts. Null when no crop was judged: the zoomed re-check
 * failed for this check.
 */
export function judgeZoom(check: Check, probabilities: readonly (number | null)[]): CheckResult | null {
  const given = probabilities.filter((p): p is number => p !== null)
  if (given.length === 0) return null
  const probability = Math.max(...given)
  return { check, probability, basis: 'zoom', ...judge(probability, 'both') }
}

/**
 * What a check comes to when its zoomed re-check failed (`reason`): the answer of the whole images, of which only a fail is taken
 * (ADR 0008); anything else is unsure, with the reason.
 */
export function fallBack(whole: CheckResult, reason: string): CheckResult {
  if (whole.verdict === 'fail') return whole
  return { ...whole, verdict: 'unsure', why: whole.why === undefined ? reason : `${reason}; ${whole.why}` }
}
