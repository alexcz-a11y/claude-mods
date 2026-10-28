// Images in a decision request (#56, ADR 0008): how a request refers to them, and what they cost. The request's state and
// questions name an image with `imageRef(name)`; each backend swaps that for its own reference and sends the image its own
// way (jev.ts, pplx.ts). Pure (see system-one.ts).

import type { ImageBackendName } from './backend.ts'
import type { DecisionRequest, Question, RequestImage, State } from './system-one.ts'

/** An image as a request sends it, less its name (the request gives it one). */
export type Picture = Omit<RequestImage, 'name'>

/** The most images pplx takes in one request (measured: the 9th is a 400 `At most 8 images are allowed per question`). */
export const PPLX_MAX_IMAGES = 8

/**
 * What an image costs each decision model: input tokens for each megapixel, and whether it counts again for every question.
 * Jev: about 2600 (measured 2026-10-15; the docs give no figure), once however many questions use it. pplx: about 1000 (the
 * docs: "about 1,000 input tokens per megapixel"), again for every question.
 */
const IMAGE_COST: Readonly<Record<ImageBackendName, { perMegapixel: number; perQuestion: boolean }>> = {
  jev: { perMegapixel: 2600, perQuestion: false },
  pplx: { perMegapixel: 1000, perQuestion: true },
}

/**
 * Items with the `costs` given, in order, split into groups (their indexes) whose costs add up to `maxCost` at the most and that
 * hold at most `maxItems`. An item is never split: one that costs more than `maxCost` is a group of its own.
 */
export function packByCost(costs: readonly number[], maxCost: number, maxItems: number): number[][] {
  const groups: number[][] = []
  let cost = 0
  costs.forEach((one, index) => {
    const last = groups.at(-1)
    if (last === undefined || cost + one > maxCost || last.length >= maxItems) {
      groups.push([index])
      cost = one
    } else {
      last.push(index)
      cost += one
    }
  })
  return groups
}

/**
 * About how many input tokens `images` cost on a request of `questions` questions (ADR 0008). Jev counts an image once, however
 * many questions use it; pplx counts it again for every question, so a request with images keeps its questions few.
 */
export function imageTokens(backend: ImageBackendName, images: readonly Pick<RequestImage, 'width' | 'height'>[], questions: number): number {
  const megapixels = images.reduce((sum, image) => sum + image.width * image.height, 0) / 1_000_000
  const { perMegapixel, perQuestion } = IMAGE_COST[backend]
  return Math.round(megapixels * perMegapixel) * (perQuestion ? questions : 1)
}

/**
 * About how many input tokens the images of one request may cost in all. Jev: its context holds 32k for a question and the state
 * (ADR 0008), so 24k leaves room for the rest. pplx: the share of its context an agent's request gets, where an image counts
 * again for every question.
 */
const IMAGE_TOKEN_BUDGET = { jev: 24_000, pplx: 32_000 } as const

/** How many megapixels the images of a request of `questions` questions may total to stay within `IMAGE_TOKEN_BUDGET`. */
export function imageMegapixelBudget(backend: ImageBackendName, questions: number): number {
  const { perMegapixel, perQuestion } = IMAGE_COST[backend]
  return IMAGE_TOKEN_BUDGET[backend] / (perMegapixel * (perQuestion ? Math.max(1, questions) : 1))
}

/** What the debug log says of a request's images: how many, their sizes and the estimated tokens; never the images. Null for a request without images. */
export function describeImages(backend: ImageBackendName, request: DecisionRequest): string | null {
  const images = request.images ?? []
  if (images.length === 0) return null
  const sizes = images.map((image) => `${image.width}x${image.height}`).join(', ')
  return `images: ${images.length} (${sizes}), about ${imageTokens(backend, images, Object.keys(request.questions).length)} tokens`
}

/** What an image's name may be: it is what `imageRef` and the backends' references are made of. */
const IMAGE_NAME = /^[A-Za-z0-9_-]{1,40}$/

/** Written in a string of the state or of a question, where the image belongs: "Is `candidate` ..." is `Is ${imageRef('candidate')} ...`. */
export function imageRef(name: string): string {
  return `⟦image:${name}⟧`
}

const REF = /⟦image:([A-Za-z0-9_-]+)⟧/g

/** The value with `replace(name)` put for each `imageRef` in its strings (a name `replace` gives null for stays as written); object keys are not touched. */
function swapRefs(value: unknown, replace: (name: string) => string | null): unknown {
  if (typeof value === 'string') return value.replace(REF, (whole, name: string) => replace(name) ?? whole)
  if (Array.isArray(value)) return value.map((item) => swapRefs(item, replace))
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, swapRefs(item, replace)]))
  return value
}

/**
 * The request's state and questions with each `imageRef` replaced by `reference(image, index)`, the form its backend
 * sends. Throws a RangeError for a request a backend would only get a 400 for: a name twice or malformed, or an image
 * that nothing refers to.
 */
export function placeImages(request: DecisionRequest, reference: (image: RequestImage, index: number) => string): { state: State; questions: Record<string, Question> } {
  const images = request.images ?? []
  const byName = new Map<string, number>()
  images.forEach((image, index) => {
    if (!IMAGE_NAME.test(image.name)) throw new RangeError(`image name "${image.name}" must match ${IMAGE_NAME}`)
    if (byName.has(image.name)) throw new RangeError(`image "${image.name}" appears twice in one request`)
    byName.set(image.name, index)
  })
  const used = new Set<string>()
  const swap = <T>(value: T): T =>
    swapRefs(value, (name) => {
      const index = byName.get(name)
      if (index === undefined) return null
      used.add(name)
      return reference(images[index] as RequestImage, index)
    }) as T
  const state = swap(request.state) as State
  const questions = swap(request.questions) as Record<string, Question>
  const unused = images.filter((image) => !used.has(image.name))
  if (unused.length > 0) throw new RangeError(`image ${unused.map((image) => `"${image.name}"`).join(', ')} is not referred to by the state or a question`)
  return { state, questions }
}
