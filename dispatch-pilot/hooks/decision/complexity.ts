// The complexity reading (#63, ADR 0008): how complex it is to build what a group of reference images shows, as one Score question
// of five levels asked of Jev (or of pplx without a TypeSafe key), and what the answer is made into. The reading goes into the
// state of the effort request of a message with images (`reference_complexity`), and #64 puts the same field in the mid-turn
// re-decision, the dispatched agents' and the Workflow agents' requests. The eval's visual-check suite (#65) asks and reads the
// same way. The question is its own request, not a question beside the effort question: the questions of a request do not see
// each other's answers, and the effort question is not sensitive to images (ADR 0008).
//
// Pure (see system-one.ts): no `$`; the images arrive read and sized (core/image-files.ts).

import type { BackendName } from './backend.ts'
import { type ImageLimits, limitsFor } from './image-fit.ts'
import { imageRef, type Picture } from './images.ts'
import { answersFor, mergeParts, type Answer, type DecisionRequest, type Part, type RequestImage } from './system-one.ts'
import { requestImage } from './visual-check.ts'

/** A group is at most this many images; one that has more is read by its first ones. */
export const MAX_REFERENCE_IMAGES = 6

/** Each image is brought to at most this many pixels: a reading needs the picture's gist, and a group of six stays under 16k tokens on Jev. */
export const REFERENCE_MAX_PIXELS = 1_000_000

/** What the decision model takes of an image for a reading: its own limits, and about a megapixel at the most. */
export function complexityLimits(backend: BackendName): ImageLimits {
  return { ...limitsFor(backend), maxPixels: REFERENCE_MAX_PIXELS }
}

/**
 * The five levels, lowest first, as the decision model reads them. `en`: the question's description of the level; `summary`: the
 * level in the effort request's state. What a person reads on the card is another table (board/reference.ts).
 */
export const COMPLEXITY_LEVELS: readonly { name: string; en: string; summary: string }[] = [
  {
    name: 'trivial',
    en: 'A single plain shape or flat graphic with almost nothing to it and no fine detail, such as a plain cube, a solid-colour logo or one basic button.',
    summary: 'trivial: a single plain shape or flat graphic, no fine detail',
  },
  {
    name: 'simple',
    en: 'A few plain elements laid out simply, with little detail: a basic screen with a handful of standard controls, or an object made of a few primitive shapes.',
    summary: 'simple: a few plain elements laid out simply, little detail',
  },
  {
    name: 'moderate',
    en: 'A moderate number of distinct parts with some detail or styling: an ordinary app screen, a recognisable object of several components, or a small scene with a few materials.',
    summary: 'moderate: a moderate number of distinct parts with some detail or styling',
  },
  {
    name: 'complex',
    en: 'Many distinct parts with fine detail, layered materials, lighting or effects: a dense interface, a detailed model, or a scene with several kinds of surfaces.',
    summary: 'complex: many distinct parts with fine detail, layered materials, lighting or effects',
  },
  {
    name: 'very complex',
    en: 'A very large amount of intricate detail: a whole city or environment, an organic or highly detailed model with many parts, a scene with many interacting effects, or a screen of many interacting elements.',
    summary: 'very complex: a very large amount of intricate detail, many parts or interacting effects',
  },
]

/** The reading part's name and its one question's id: `complexity.level` in the request. */
export const COMPLEXITY_PART = 'complexity'
export const COMPLEXITY_LEVEL = 'level'

/** What the question points at in the request's state. */
const IMAGES_FIELD = 'reference_images'

/**
 * The request that reads a group of images (`pictures`, at most `MAX_REFERENCE_IMAGES`, already sized): one Score question, with
 * the images in the state under `reference_images`. Throws a RangeError for no image or for more than the most.
 */
export function complexityRequest(pictures: readonly Picture[]): { request: DecisionRequest; part: Part } {
  if (pictures.length === 0) throw new RangeError('a complexity reading needs at least one image')
  if (pictures.length > MAX_REFERENCE_IMAGES) throw new RangeError(`${pictures.length} images in one reading; at most ${MAX_REFERENCE_IMAGES}`)
  const images: RequestImage[] = pictures.map((picture, i) => requestImage(`reference-${i + 1}`, picture))
  const part: Part = {
    part: COMPLEXITY_PART,
    questions: {
      [COMPLEXITY_LEVEL]: {
        type: 'score',
        instructions: `The images in \`${IMAGES_FIELD}\` are references for something that is going to be built to match them (an interface, a 3D model, a scene, an animation). How complex is it to build it so that it matches them? Rate the work of reproducing what the images show, not how important or well known the subject is.`,
        criteria: COMPLEXITY_LEVELS.map((level) => level.en),
      },
    },
  }
  const state = { [IMAGES_FIELD]: images.map((image) => ({ image: imageRef(image.name) })) }
  return { request: { ...mergeParts(state, [part]), images }, part }
}

/** What a group of images reads as: the level, 0 (trivial) to 4 (very complex), and how many images it was read from. */
export type ReferenceReading = { level: number; images: number }

/**
 * The reading an answer gives: the expected level (the probabilities of the five levels weighed by their level, normalised)
 * rounded to a whole level. The expectation, not the most likely level: it moves smoothly from one picture to the next, and the
 * measured readings (a cube 0.14, a sea 1.77, a city 3.14) came out in order that way. Null when the answer is missing, is not
 * a Score or puts no probability on any level.
 */
export function readComplexity(part: Part, answers: Readonly<Record<string, unknown>>, images: number): ReferenceReading | null {
  const answer: Answer | undefined = answersFor(part, answers)[COMPLEXITY_LEVEL]
  if (answer === undefined || answer.type !== 'score') return null
  const raw = COMPLEXITY_LEVELS.map((_, i) => answer.probabilities[String(i)] ?? 0)
  const sum = raw.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return null
  const expected = raw.reduce((total, p, i) => total + (p / sum) * i, 0)
  return { level: Math.min(COMPLEXITY_LEVELS.length - 1, Math.max(0, Math.round(expected))), images }
}

/** The effort request's state field (and the mid-turn re-decision's, the dispatched agent's, ...) that carries a reading. */
export const REFERENCE_FIELD = 'reference_complexity'

/** What the decision model is told of a reading, in the field `REFERENCE_FIELD`. A hint for the question, never a level the answer is to take. */
export function referenceState(reading: ReferenceReading): Record<string, unknown> {
  const level = COMPLEXITY_LEVELS[reading.level]
  return { level: reading.level, scale: '0 (trivial) to 4 (very complex)', description: level?.summary ?? `level ${reading.level}`, images: reading.images }
}

/** The request state's field for a reading, or nothing when there is none (to spread into a state: `...referenceField(reading)`). */
export function referenceField(reading: ReferenceReading | null | undefined): Record<string, unknown> {
  return reading === undefined || reading === null ? {} : { [REFERENCE_FIELD]: referenceState(reading) }
}

/** Lowercase hexadecimal of bytes. */
const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

/**
 * What names a group of images: a hash of their content, the same whatever order they come in. The same pictures read once
 * (the reading is kept under this key); an image changed, added or left out is another group. 16 hexadecimal digits.
 */
export async function referenceKey(images: readonly { base64: string }[]): Promise<string> {
  const each = await Promise.all(images.map((image) => sha256(image.base64)))
  return (await sha256(each.sort().join('\n'))).slice(0, 16)
}
