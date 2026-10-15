// Jev, TypeSafe's System One model: POST /v1/systemone with a Bearer key.
//
// Pure (see system-one.ts).

import { errorText, postJson, withNote, withoutBase64, type Asked, type Backend, type Posted } from './backend.ts'
import { describeImages, placeImages } from './images.ts'
import { readResponse, type DecisionRequest } from './system-one.ts'

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
/** The alias of the current Jev; pin a version id (`jev-1.13.0`) to keep calibrated thresholds stable. */
export const JEV_MODEL = 'jev-latest'
/**
 * The model a request with images is pinned to (#56, ADR 0008): the Box question is only in 1.14, and images are a
 * "Dreamer-ready" feature that may change from one version to the next, so it moves when the eval says so, not with `jev-latest`.
 */
export const JEV_IMAGE_MODEL = 'jev-1.14.0'
/** Each request containing an image needs this header, else Jev answers 400. */
export const JEV_IMAGES_HEADER = 'TypeSafe-Danger-Zone-Images'
/**
 * With this header a request may hold 262k tokens, for the request and for the state with any one question (64k and 32k
 * without), on Jev 1.14 and 1.13 alike (docs.typesafe.ai/models, Long context). Slower and less accurate, the docs say; only
 * the eval asks with it (eval/run.ts --long-context), to measure what a longer state gains.
 */
export const JEV_LONG_CONTEXT_HEADER = 'TypeSafe-Danger-Zone-Long-Context'

/** A random version 4 UUID (a module's sandbox has no `crypto.randomUUID`). It only keeps references from meeting the text around them, so it needs no strength. */
function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16)
    return (c === 'x' ? r : (r & 3) | 8).toString(16)
  })
}

/**
 * `newId`: the id every reference of a request with images starts with, new for each request (a test gives a fixed one).
 * `longContext`: every request carries JEV_LONG_CONTEXT_HEADER (the eval's --long-context; the mod never sets it).
 */
export function jevBackend(apiKey: string, options: { url?: string; model?: string; newId?: () => string; longContext?: boolean } = {}): Backend {
  const url = options.url ?? JEV_URL
  const model = options.model ?? JEV_MODEL
  const newId = options.newId ?? uuid
  const longContext: Record<string, string> = options.longContext === true ? { [JEV_LONG_CONTEXT_HEADER]: 'true' } : {}
  return {
    name: 'jev',
    configured: apiKey !== '',
    async ask(io, request, timeoutMs) {
      if (!apiKey) return { ok: false, failure: { kind: 'config', detail: 'no TypeSafe API key: set typesafeApiKey' } }
      let sent: { headers: Record<string, string>; body: unknown }
      try {
        sent = jevRequest(request, model, newId())
      } catch (error) {
        return { ok: false, failure: { kind: 'request', detail: errorText(error) } }
      }
      const posted = await postJson(io, url, { authorization: `Bearer ${apiKey}`, ...longContext, ...sent.headers }, sent.body, timeoutMs)
      const asked = readAsked(posted)
      // A failure's detail goes to the debug log: what it echoes of the key stays out.
      const kept: Asked = asked.ok ? asked : { ok: false, failure: { ...asked.failure, detail: asked.failure.detail.split(apiKey).join('[REDACTED]') } }
      return withNote(kept, describeImages('jev', request))
    },
  }
}

/** The answers out of a posted request, or why there are none. */
function readAsked(posted: Posted): Asked {
  if (!posted.ok) return posted
  let body: unknown
  try {
    body = JSON.parse(posted.response.text)
  } catch {
    return { ok: false, failure: { kind: 'parse', detail: `not JSON: ${withoutBase64(posted.response.text).slice(0, 200)}` } }
  }
  const response = readResponse(body)
  if (response === null) return { ok: false, failure: { kind: 'parse', detail: `no answers: ${withoutBase64(posted.response.text).slice(0, 200)}` } }
  return { ok: true, ...response }
}

/**
 * The extra headers and the body a request goes out with. Without images: the body it always had. With images (their
 * references start with `id`): the images in the top-level `assets` (JSON with base64: a module's http body is a string, so no
 * multipart), the references where the state and the questions had `imageRef`s, the pinned model and the images header.
 * Throws a RangeError for a request Jev would answer 400 (see `placeImages`).
 */
export function jevRequest(request: DecisionRequest, model: string, id: string): { headers: Record<string, string>; body: unknown } {
  const images = request.images ?? []
  if (images.length === 0) return { headers: {}, body: { model, state: request.state, questions: request.questions } }
  const { state, questions } = placeImages(request, (image) => `${id}-${image.name}`)
  const assets = Object.fromEntries(images.map((image) => [`${id}-${image.name}`, { type: 'image', format: image.format, data_base64: image.base64 }]))
  return { headers: { [JEV_IMAGES_HEADER]: 'true' }, body: { model: JEV_IMAGE_MODEL, state, assets, questions } }
}
