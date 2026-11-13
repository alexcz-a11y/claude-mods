// Drex Max v1.1, Nace's decision model, as the eval's `--backend drex` asks it (docs/research/drex-max-decision-model.md,
// 2026-11-12): the mod's backend (hooks/decision/drex.ts, the default since 0.13.0, ADR 0026) with images, which the mod
// leaves with Jev. A request without images is the mod's, word for word.
//
// What differs is the images (console.nace.ai/docs/drex/guides/drex-max): they go in a top-level `images` array, every
// question sees them all, and the text calls them "Image 1", "Image 2" by their place in it; at most 8 a request, about
// 3 MiB of inline bytes in all; no Box question (422), so no zoomed re-check. No header is needed.
//
// Pure: the network is handed in.

import { errorText, postJson, readPosted, withoutKey, type Backend } from '../../hooks/decision/backend.ts'
import { DREX_MODEL, DREX_URL } from '../../hooks/decision/drex.ts'
import { placeImages } from '../../hooks/decision/images.ts'
import type { DecisionRequest } from '../../hooks/decision/system-one.ts'

export { DREX_MODEL, DREX_URL }
/** Input price per million tokens; output is free (reference/pricing, 2026-11-12; Nace calls it a launch discount). */
export const DREX_PRICE = 0.03
/** The most images in one request ("at most 8 images allowed"). */
export const DREX_MAX_IMAGES = 8
/** About how many bytes of inline images a request holds: its body is 4 MiB at the most, base64 included. */
export const DREX_INLINE_BYTES = 3 * 1024 * 1024
/** How long a client should wait: Drex queues a request up to 55 s when it is busy (guides/errors-and-retries: "at least 60 seconds"). */
export const DREX_ATTEMPT_MS = 60_000

export function drexBackend(apiKey: string, options: { url?: string; model?: string } = {}): Backend {
  const url = options.url ?? DREX_URL
  const model = options.model ?? DREX_MODEL
  return {
    name: 'drex',
    configured: apiKey !== '',
    async ask(io, request, timeoutMs) {
      if (!apiKey) return { ok: false, failure: { kind: 'config', detail: 'no Nace API key: set NACE_API_KEY' } }
      let body: unknown
      try {
        body = drexRequest(request, model)
      } catch (error) {
        return { ok: false, failure: { kind: 'request', detail: errorText(error) } }
      }
      return withoutKey(readPosted(await postJson(io, url, { authorization: `Bearer ${apiKey}` }, body, timeoutMs)), apiKey)
    },
  }
}

/**
 * The body a request goes out with. With images: each `imageRef` of the state and the questions becomes "Image N", N the
 * image's place in `images`, which holds them as data URLs. Throws a RangeError for a request Drex would answer 422: a Box
 * question, more than DREX_MAX_IMAGES images, images past DREX_INLINE_BYTES (and what `placeImages` refuses).
 */
export function drexRequest(request: DecisionRequest, model: string = DREX_MODEL): unknown {
  if (Object.values(request.questions).some((question) => question.type === 'box')) throw new RangeError(`${model} has no Box question`)
  const images = request.images ?? []
  if (images.length === 0) return { model, state: request.state, questions: request.questions }
  if (images.length > DREX_MAX_IMAGES) throw new RangeError(`${images.length} images in one request; ${model} takes at most ${DREX_MAX_IMAGES}`)
  const bytes = images.reduce((sum, image) => sum + Math.floor((image.base64.length * 3) / 4), 0)
  if (bytes > DREX_INLINE_BYTES) throw new RangeError(`${bytes} bytes of images in one request; ${model} takes about ${DREX_INLINE_BYTES}`)
  const { state, questions } = placeImages(request, (_image, index) => `Image ${index + 1}`)
  return { model, state, questions, images: images.map((image) => `data:image/${image.format};base64,${image.base64}`) }
}
