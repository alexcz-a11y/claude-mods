// Images in a decision request (#56, ADR 0008): how a request refers to them, and what they cost. The request's state and
// questions name an image with `imageRef(name)`; each backend swaps that for its own reference and sends the image its own
// way (jev.ts, pplx.ts). Pure (see system-one.ts).

import type { DecisionRequest, Question, RequestImage, State } from './system-one.ts'

/** The most images pplx takes in one request (measured: the 9th is a 400 `At most 8 images are allowed per question`). */
export const PPLX_MAX_IMAGES = 8

/** Jev counts about this many input tokens for each megapixel of an image (measured 2026-10-15; the docs give no figure). */
export const JEV_TOKENS_PER_MEGAPIXEL = 2600
/** pplx counts about this many (the docs: "about 1,000 input tokens per megapixel"). */
export const PPLX_TOKENS_PER_MEGAPIXEL = 1000

/**
 * About how many input tokens `images` cost on a request of `questions` questions (ADR 0008). Jev counts an image once, however
 * many questions use it; pplx counts it again for every question, so a request with images keeps its questions few.
 */
export function imageTokens(backend: 'jev' | 'pplx', images: readonly Pick<RequestImage, 'width' | 'height'>[], questions: number): number {
  const megapixels = images.reduce((sum, image) => sum + image.width * image.height, 0) / 1_000_000
  return backend === 'jev' ? Math.round(megapixels * JEV_TOKENS_PER_MEGAPIXEL) : Math.round(megapixels * PPLX_TOKENS_PER_MEGAPIXEL) * questions
}

/** What the debug log says of a request's images: how many, their sizes and the estimated tokens; never the images. Null for a request without images. */
export function describeImages(backend: 'jev' | 'pplx', request: DecisionRequest): string | null {
  const images = request.images ?? []
  if (images.length === 0) return null
  const sizes = images.map((image) => `${image.width}x${image.height}`).join(', ')
  return `images: ${images.length} (${sizes}), about ${imageTokens(backend, images, Object.keys(request.questions).length)} tokens`
}

/** An image's name:what `imageRef` and the backends' references are made of. */
export const IMAGE_NAME = /^[A-Za-z0-9_-]{1,40}$/

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
