// The zoomed re-check of two images (#59, ADR 0008), for every feature that compares a pair of images: visual_check against a reference
// or another screenshot, and the quality series (#61), which compares each two neighbours. Given the parts the checks name and the
// boxes the decision model located them in, it cuts the crops out of the two images, asks one Noul of each pair of crops, and reads
// the verdict of each check off the crops. Like image-files.ts it keeps no state and asks for nothing but closures (a module cannot
// pass `$` across an import): the files, and `ask`, which sends one request to the decision model that takes images.

import { type Asked, type Failure, failureText } from '../decision/backend.ts'
import { imageRef } from '../decision/images.ts'
import { mergeParts, type DecisionRequest } from '../decision/system-one.ts'
import type { Check, CheckResult } from '../decision/visual-check.ts'
import { batchPairs, type Boxed, type Elsewhere, fallBack, judgeZoom, type LocatePlan, locatePlan, readLocated, readZoom, withinFailed, zoomRequest, type ZoomPair } from '../decision/visual-check-zoom.ts'
import { type Box, cropRect, type Rect, sameView, scaleRect, unionBox } from '../decision/zoom.ts'
import { type Crop, cropImage } from './image-crops.ts'
import type { ImageFilesIo, LoadedImage } from './image-files.ts'

/** What the zoomed re-check needs of the world: files and programs, and the decision model that takes images. */
export type ZoomDeps = {
  files: ImageFilesIo
  /** One request to the decision model that takes images (Jev: the Box questions and the pinned model are its own). */
  ask: (request: DecisionRequest) => Promise<Asked>
  /** The name the decision model goes by in a reason. */
  backend: string
}

/** What is compared: the screenshot, and the images it is compared with. */
export type ZoomSubjects = {
  candidate: LoadedImage
  /** The images the screenshot is compared with, and the names they go by in the request (`reference`, `reference-1`, `other`). */
  others: readonly LoadedImage[]
  names: readonly string[]
  /** For each of `others`, whether it shows the same view as the screenshot. */
  sameViews: readonly boolean[]
}

/** A crop of a part that failed: the screenshot's and the other image's, to show the agent. */
export type FailedCrops = { index: number; candidate: Crop; other: Crop }

/** The place the whole screen asked about, if it is to be reported, with the crops of it (a crop that could not be made is null). */
export type Place = { place: Elsewhere; candidate: Crop | null; other: Crop | null }

/** What the zoomed re-check comes to. */
export type ZoomOutcome = {
  /** A result for each check, in order: from the crops, or, where that failed, from the whole images (only a fail), with the reason. */
  results: CheckResult[]
  /** The crops of the checks that failed on their crops, to attach. */
  failed: FailedCrops[]
  /** Another place that may differ; null when there is none to report. */
  elsewhere: Place | null
  /** The first request to the decision model that failed, if one did (the board keeps it as a note: #58); null when none did. */
  failure: Failure | null
}

/** A crop is not worth showing when it is nearly all of the image: the agent has that already. */
const WORTH_SHOWING = 0.9

/** The crops of one pair: the screenshot's and the other image's, and where each was cut. */
type PairCrops = { candidate: Crop; other: Crop }

/**
 * The rects to cut for a part: the same piece of both images by proportion, from the union of the two boxes, when they show the
 * same view; else each image around its own box.
 */
function rectsFor(subjects: ZoomSubjects, k: number, candidateBox: Box, otherBox: Box): { candidate: Rect; other: Rect } {
  const candidate = subjects.candidate
  const other = subjects.others[k] as LoadedImage
  if (subjects.sameViews[k]) {
    const rect = cropRect(unionBox(candidateBox, otherBox), candidate)
    return { candidate: rect, other: scaleRect(rect, candidate, other) }
  }
  return { candidate: cropRect(candidateBox, candidate), other: cropRect(otherBox, other) }
}

/**
 * The zoomed re-check. `whole`: the answers of the whole images for each check, which stand for a check whose re-check failed
 * (only a fail is taken from them). `plan` and `located` come from the request that asked the Box questions.
 */
export async function zoomReview(deps: ZoomDeps, subjects: ZoomSubjects, checks: readonly Check[], whole: readonly CheckResult[], plan: LocatePlan, located: ReturnType<typeof readLocated>): Promise<ZoomOutcome> {
  const reasons = new Map<number, string>(plan.skipped)
  const pairs: ZoomPair[] = []
  const crops = new Map<ZoomPair, PairCrops>()
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof cropImage>>>>()
  /** A crop of `image` at `rect`, made once however many pairs use it. */
  const cut = (image: LoadedImage, rect: Rect) => {
    const key = `${image.file}|${rect.x},${rect.y},${rect.width},${rect.height}`
    let made = cache.get(key)
    if (made === undefined) {
      made = cropImage(deps.files, image, rect)
      cache.set(key, made)
    }
    return made
  }
  // The crops of every pair, made at once.
  await Promise.all(
    located.boxed.map(async (boxed) => {
      const { index, check } = boxed.located
      if (boxed.candidate === null) {
        reasons.set(index, 'the decision model did not locate the part in the screenshot')
        return
      }
      const candidateBox = boxed.candidate
      const names = new Map<string, string>()
      await Promise.all(
        boxed.references.map(async (otherBox, k) => {
          if (otherBox === null) {
            reasons.set(index, `the decision model did not locate the part in ${subjects.names[k]}`)
            return
          }
          const rects = rectsFor(subjects, k, candidateBox, otherBox)
          const [candidate, other] = await Promise.all([cut(subjects.candidate, rects.candidate), cut(subjects.others[k] as LoadedImage, rects.other)])
          if (!candidate.ok || !other.ok) {
            reasons.set(index, (!candidate.ok ? candidate : (other as { reason: string })).reason)
            return
          }
          // One name for each distinct crop of the screenshot (several images compared with can ask for the same piece of it).
          const key = `${candidate.crop.rect.x},${candidate.crop.rect.y},${candidate.crop.rect.width},${candidate.crop.rect.height}`
          if (!names.has(key)) names.set(key, names.size === 0 ? `zoom-${index}-candidate` : `zoom-${index}-candidate-${names.size + 1}`)
          const name = subjects.names[k] as string
          const pair: ZoomPair = {
            index,
            reference: k,
            check,
            candidate: { name: names.get(key) as string, picture: candidate.crop },
            other: { name: `zoom-${index}-${name}`, picture: other.crop },
            otherField: `${name}_crop`,
          }
          pairs.push(pair)
          crops.set(pair, { candidate: candidate.crop, other: other.crop })
        }),
      )
    }),
  )
  // The pairs in the order of the checks and the images, whatever order their crops were made in.
  pairs.sort((a, b) => a.index - b.index || a.reference - b.reference)
  // The second request(s): one Noul for each pair of crops, split where the crops would cost more than a request holds.
  const probabilities = new Map<ZoomPair, number | null>()
  let failure: Failure | null = null
  await Promise.all(
    batchPairs(pairs).map(async (batch) => {
      const { request, part } = zoomRequest(batch)
      const asked = await deps.ask(request)
      if (!asked.ok) {
        failure ??= asked.failure
        for (const pair of batch) {
          probabilities.set(pair, null)
          if (!reasons.has(pair.index)) reasons.set(pair.index, `the zoomed re-check failed (${failureText(deps.backend, asked.failure)})`)
        }
        return
      }
      for (const [pair, probability] of readZoom(part, asked.answers, batch)) {
        probabilities.set(pair, probability)
        if (probability === null && !reasons.has(pair.index)) reasons.set(pair.index, 'the decision model gave no answer to the zoomed re-check')
      }
    }),
  )
  // The verdicts: the crops decide; for a check they cannot be made for, the whole image gives only a fail.
  const failed: FailedCrops[] = []
  const failedBoxes: Box[] = []
  const results = checks.map((check, index): CheckResult => {
    const own = pairs.filter((pair) => pair.index === index)
    const judged = judgeZoom(check, own.map((pair) => probabilities.get(pair) ?? null))
    const wholeAnswer = whole[index] as CheckResult
    if (judged === null) return fallBack(wholeAnswer, reasons.get(index) ?? 'the zoomed re-check could not be made')
    if (judged.verdict === 'fail') {
      // The pair that differs most is the one to show.
      const worst = own.reduce((lowest, pair) => ((probabilities.get(pair) ?? 1) < (probabilities.get(lowest) ?? 1) ? pair : lowest), own[0] as ZoomPair)
      const pair = crops.get(worst) as PairCrops
      const share = (pair.candidate.rect.width * pair.candidate.rect.height) / (subjects.candidate.width * subjects.candidate.height)
      if (share <= WORTH_SHOWING) failed.push({ index, candidate: pair.candidate, other: pair.other })
      const boxed = located.boxed.find((one) => one.located.index === index)
      if (boxed?.candidate != null) failedBoxes.push(boxed.candidate)
    }
    return judged
  })
  return { results, failed, elsewhere: await placeOf(deps, subjects, located.elsewhere, failedBoxes), failure }
}

/** Another place that may differ, with its crops, unless a check that failed has reported it already. */
async function placeOf(deps: ZoomDeps, subjects: ZoomSubjects, elsewhere: Elsewhere | null, failedBoxes: readonly Box[]): Promise<Place | null> {
  if (elsewhere === null || withinFailed(elsewhere, failedBoxes)) return null
  // The question is asked only of one other image that shows the same view: the same piece of both is cut.
  const other = subjects.others[0]
  if (other === undefined) return { place: elsewhere, candidate: null, other: null }
  const rect = cropRect(elsewhere.box, subjects.candidate)
  const [candidate, theOther] = await Promise.all([cropImage(deps.files, subjects.candidate, rect), cropImage(deps.files, other, scaleRect(rect, subjects.candidate, other))])
  return { place: elsewhere, candidate: candidate.ok ? candidate.crop : null, other: theOther.ok ? theOther.crop : null }
}

// ---- A pair of images, on their own ----------------------------------------------------------------------------------

/** What `comparePair` compares: two images, and whether they show the same view (`null`: by the shapes of the images). */
export type ImagePair = { candidate: LoadedImage; other: LoadedImage; sameView: boolean | null }

/**
 * A pair of images and the parts to compare in them, from the Box questions to the verdicts: asks the decision model where each
 * part is in both images (and where the images differ), cuts the crops, and judges each part on them. For any pair of images, with
 * no first request of the whole images before it (the quality series, #61, compares each two neighbours so). A check whose re-check
 * cannot be made ends unsure with the reason; nothing throws.
 */
export async function comparePair(deps: ZoomDeps, pair: ImagePair, checks: readonly Check[]): Promise<ZoomOutcome> {
  const subjects: ZoomSubjects = { candidate: pair.candidate, others: [pair.other], names: ['other'], sameViews: [sameView(pair.sameView, pair.candidate, pair.other)] }
  const unasked = (reason: string, failure: Failure | null = null): ZoomOutcome => ({ results: checks.map((check) => ({ check, verdict: 'unsure', probability: null, basis: 'whole', why: reason })), failed: [], elsewhere: null, failure })
  const plan = locatePlan(subjects.names, subjects.sameViews, checks)
  if (plan.parts.length === 0) return unasked('no part of the image is named, so there is nothing to cut out')
  const state = { candidate: imageRef('candidate'), other: imageRef('other') }
  const asked = await deps.ask({
    ...mergeParts(state, plan.parts),
    images: [pair.candidate, pair.other].map((image, i) => ({ name: i === 0 ? 'candidate' : 'other', format: image.format, base64: image.base64, width: image.width, height: image.height })),
  })
  if (!asked.ok) return unasked(`the parts could not be located (${failureText(deps.backend, asked.failure)})`, asked.failure)
  const whole = checks.map((check): CheckResult => ({ check, verdict: 'unsure', probability: null, basis: 'whole', why: 'the whole images were not compared' }))
  return zoomReview(deps, subjects, checks, whole, plan, readLocated(plan, asked.answers))
}
