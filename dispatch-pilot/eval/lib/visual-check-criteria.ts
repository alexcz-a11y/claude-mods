// The visual-check suite's `criteria` variant: each check asked as Nace's guide writes a yes/no question about images
// (docs/research/drex-max-decision-model.md, 2026-11-12), with the mod's own wording beside it in the same request.
//
// What the guide says, and what this does with it:
//   - "Refer to them as "Image 1", "Image 2" and so on in the state or the instructions": the question names its images where it
//     speaks of them (an `imageRef`, which Drex's backend writes as "Image N" and Jev's as its asset reference), and the state
//     still says which image is which.
//   - "Use criteria when your team's definition of yes differs from the everyday meaning of the question"; a sentence in
//     `instructions` "moves the answer less than criteria do, because criteria state both sides of the boundary": each check has
//     `criteria.true` and `criteria.false`. "The same" here means the same to the eye, not the same pixels.
//   - "One request accepts up to 512 questions about the same `state`": the mod's wording is asked beside it (`plain.<i>`), on the
//     same images, so one run says what the wording changes. Each question is read on its own, so neither moves the other.
//   - At most 8 images a request: a motion is 8 of its frames, as pplx gets it.
//
// Pure (see system-one.ts).

import { imageRef } from '../../hooks/decision/images.ts'
import type { DecisionRequest, NoulQuestion, Question, RequestImage } from '../../hooks/decision/system-one.ts'
import { CHECK_PART, type Check } from '../../hooks/decision/visual-check.ts'

/** The part the mod's own wording of each check goes under in a `criteria` request: `plain.<index>`. */
export const PLAIN_PART = 'plain'
/** How many frames of a motion the variant sends: the most images Drex Max takes in one request. */
export const CRITERIA_FRAMES = 8

/** A check as the variant asks it. */
export type Wording = (check: Check) => NoulQuestion

/** Against reference images, named `names` in the request (visual-check.ts `comparedNames`); the screenshot is `candidate`. */
export function comparedWording(names: readonly string[]): Wording {
  const those = names.length === 1 ? imageRef(names[0] as string) : `the reference images (${names.map(imageRef).join(', ')}), which show it from different sides`
  return (check) => ({
    type: 'noul',
    instructions: `Is the ${check.property} of ${check.part} in ${imageRef('candidate')} the same as in ${those}?`,
    criteria: {
      true: `The ${check.property} of ${check.part} looks the same: a person comparing the images side by side would see no difference in it.`,
      false: `The ${check.property} of ${check.part} is visibly different between the images, or ${check.part} is missing from one of them.`,
    },
  })
}

/** On the frames of a motion (visual-check-frames.ts `framesRequest`: the state's `frames` gives each frame's image and time). */
export function framesWording(count: number, spec: string | null): Wording {
  return (check) => {
    const part = check.part === '' ? 'the screen' : check.part
    return {
      type: 'noul',
      instructions: `\`frames\` are ${count} frames of a screen recording, in order of time (\`seconds\` is the time of each). Looking at how the picture changes from one frame to the next, does ${part} meet this requirement: ${check.property}?${spec === null ? '' : ' The specification it belongs to is in `specification`.'}`,
      criteria: {
        true: `From frame to frame, ${part} does what the requirement says.`,
        false: `From frame to frame, ${part} does something other than what the requirement says, or the frames do not show it.`,
      },
    }
  }
}

/**
 * `request` (the mod's first request of a call: one `check.<i>` for each check) with each check asked by `wording` under its
 * own id, and the mod's wording kept under `plain.<i>`. The answers are read as the mod reads them: `check.<i>` decides.
 */
export function withCriteria(request: DecisionRequest, checks: readonly Check[], wording: Wording): DecisionRequest {
  const questions: Record<string, Question> = {}
  checks.forEach((check, i) => {
    const plain = request.questions[`${CHECK_PART}.${i}`]
    if (plain === undefined) throw new RangeError(`the request has no question ${CHECK_PART}.${i}`)
    questions[`${CHECK_PART}.${i}`] = wording(check)
    questions[`${PLAIN_PART}.${i}`] = plain
  })
  return { ...request, questions }
}

/** The probability the mod's wording of check `index` got in a `criteria` request's answers; null when there is none. */
export function plainOf(answers: Readonly<Record<string, unknown>>, index: number): number | null {
  const answer = answers[`${PLAIN_PART}.${index}`] as { type?: unknown; noul?: unknown } | undefined
  return answer?.type === 'noul' && typeof answer.noul === 'number' ? answer.noul : null
}

// ---- The `tiles` variant: enlarged pieces without a Box question ------------------------------------------------------------
//
// Drex Max has no Box question, so nothing says where a part is; it does take 8 images a request, and keeps at most 1,638,400
// pixels of each (guides/drex-max). When the two images show the same view, the same three overlapping bands are cut out of
// both and enlarged, and go in the same request after the whole images: 2 + 6 = 8 images, one request, no second round. The
// answer then rests on enlarged pieces, so it may pass as well as fail, as the mod's zoomed re-check may.

/** The most pixels Drex Max keeps of an image; a band is enlarged up to it. */
export const DREX_KEPT_PIXELS = 1_638_400
/** A band is enlarged at most this many times: past it sips only blurs. */
const MOST_ENLARGED = 3
/** The share of the long side one band covers; three of them overlap by a quarter of a band. */
const BAND = 0.4

export type Band = { label: string; rect: { x: number; y: number; width: number; height: number }; longSide: number }

/** Three bands across the longer side of an image, first to last, each with the long side it is enlarged to. */
export function bandsOf(size: { width: number; height: number }): Band[] {
  const tall = size.height >= size.width
  const labels = tall ? ['top', 'middle', 'bottom'] : ['left', 'middle', 'right']
  const long = tall ? size.height : size.width
  const length = Math.round(long * BAND)
  return labels.map((label, i) => {
    const start = Math.round(((long - length) * i) / 2)
    const rect = tall ? { x: 0, y: start, width: size.width, height: length } : { x: start, y: 0, width: length, height: size.height }
    const scale = Math.min(MOST_ENLARGED, Math.sqrt(DREX_KEPT_PIXELS / (rect.width * rect.height)))
    return { label, rect, longSide: Math.floor(Math.max(rect.width, rect.height) * scale) }
  })
}

/** A band's two pieces as images of a request. */
export type BandPair = { label: string; candidate: RequestImage; reference: RequestImage }

/**
 * `request` (a `criteria` request about `candidate` and `reference`) with the bands' pieces after the whole images, the state
 * saying which piece is which, and each check told to look at the piece that shows its part.
 */
export function withBands(request: DecisionRequest, pairs: readonly BandPair[]): DecisionRequest {
  const state = { ...request.state, enlarged_pieces: pairs.map((pair) => ({ piece: pair.label, of_candidate: imageRef(pair.candidate.name), of_reference: imageRef(pair.reference.name) })) }
  const note = ' `enlarged_pieces` are the same pieces of both images, enlarged: compare the part in the piece that shows it.'
  const questions = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => [id, id.startsWith(`${CHECK_PART}.`) && typeof question.instructions === 'string' ? { ...question, instructions: question.instructions + note } : question]),
  ) as Record<string, Question>
  return { state, questions, images: [...(request.images ?? []), ...pairs.flatMap((pair) => [pair.candidate, pair.reference])] }
}
