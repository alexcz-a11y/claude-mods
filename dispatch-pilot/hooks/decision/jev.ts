// Jev, TypeSafe's System One model: POST /v1/systemone with a Bearer key.
//
// Pure (see system-one.ts).

import { errorText, postJson, readPosted, withNote, withoutKey, type Backend } from './backend.ts'
import { estimateTokens } from './context.ts'
import { describeImages, placeImages } from './images.ts'
import type { DecisionRequest } from './system-one.ts'

const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
/**
 * The Jev every decision without images is asked of: a version, not the `jev-latest` alias, so the thresholds stay those the
 * eval measured on it (docs.typesafe.ai/models: "If you have tuned confidence thresholds against one version, send that
 * version's ID instead of the alias"). 1.14 since 2026-10-15 (DEVELOPMENT.md 「Jev 1.14」): it ran the evals of 1.13 as well
 * as 1.13 did, and the agents' questions in Chinese better. Move it when the eval says so.
 */
export const JEV_MODEL = 'jev-1.14.0'
/**
 * The model a request with images is pinned to (#56, ADR 0008): the Box question is only in 1.14, and images are a
 * "Dreamer-ready" feature that may change from one version to the next, so it moves when the eval says so, not with `jev-latest`.
 */
const JEV_IMAGE_MODEL = 'jev-1.14.0'
/** Each request containing an image needs this header, else Jev answers 400. */
const JEV_IMAGES_HEADER = 'TypeSafe-Danger-Zone-Images'
/**
 * With this header a request may hold 262k tokens, for the request and for the state with any one question (64k and 32k
 * without), on Jev 1.14 and 1.13 alike (docs.typesafe.ai/models, Long context). Slower and less accurate, the docs say, so a
 * request carries it only when it is past the regular limits (`needsLongContext`); the eval's --long-context sends it on every one.
 */
export const JEV_LONG_CONTEXT_HEADER = 'TypeSafe-Danger-Zone-Long-Context'
/**
 * The most a request's state takes without the header, in the mod's estimated tokens: what Jev's 32k for the state and the
 * longest question leaves beside a question of at most 700 tokens, at 90% and with Jev counting about 1.2 of each estimated
 * token (Chinese conversations: 1.17-1.2; DEVELOPMENT.md, 「Jev 的上下文默认值怎么算」; the skills' 6000 stays far under it).
 */
export const JEV_REGULAR_STATE = 24000
/** The most a whole request (its state and every question) takes without the header, in estimated tokens: 90% of Jev's 64k at about 1.2 Jev tokens each. */
export const JEV_REGULAR_REQUEST = 48000

/**
 * Whether a request is past Jev's regular limits and goes with the long-context header: its state over JEV_REGULAR_STATE, or
 * the state and its questions together over JEV_REGULAR_REQUEST. A request with images never is (its features size it within the regular limits).
 */
export function needsLongContext(request: DecisionRequest): boolean {
  if ((request.images ?? []).length > 0) return false
  const state = estimateTokens(JSON.stringify(request.state))
  return state > JEV_REGULAR_STATE || state + estimateTokens(JSON.stringify(request.questions)) > JEV_REGULAR_REQUEST
}

/** A random version 4 UUID (a module's sandbox has no `crypto.randomUUID`). It only keeps references from meeting the text around them, so it needs no strength. */
function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16)
    return (c === 'x' ? r : (r & 3) | 8).toString(16)
  })
}

/**
 * The key is a string, or a function that gives it when asked: the mod's key may come from the environment, which is read
 * after the backend is built (core/setup.ts `Secrets`), as pplx's may. `configured` follows it.
 * `newId`: the id every reference of a request with images starts with, new for each request (a test gives a fixed one).
 * `longContext`: every request carries JEV_LONG_CONTEXT_HEADER (the eval's --long-context); without it, only a request
 * past the regular limits does (`needsLongContext`).
 */
export function jevBackend(apiKey: string | (() => string), options: { url?: string; model?: string; newId?: () => string; longContext?: boolean } = {}): Backend {
  const url = options.url ?? JEV_URL
  const model = options.model ?? JEV_MODEL
  const newId = options.newId ?? uuid
  const long = (request: DecisionRequest) => options.longContext === true || needsLongContext(request)
  const keyNow = typeof apiKey === 'function' ? apiKey : () => apiKey
  return {
    name: 'jev',
    get configured() {
      return keyNow() !== ''
    },
    longContext: long,
    async ask(io, request, timeoutMs) {
      const apiKey = keyNow()
      if (!apiKey) return { ok: false, failure: { kind: 'config', detail: 'no TypeSafe API key: set typesafeApiKey or TYPESAFE_API_KEY' } }
      let sent: { headers: Record<string, string>; body: unknown }
      try {
        sent = jevRequest(request, model, newId())
      } catch (error) {
        return { ok: false, failure: { kind: 'request', detail: errorText(error) } }
      }
      const longContext: Record<string, string> = long(request) ? { [JEV_LONG_CONTEXT_HEADER]: 'true' } : {}
      const posted = await postJson(io, url, { authorization: `Bearer ${apiKey}`, ...longContext, ...sent.headers }, sent.body, timeoutMs)
      return withNote(withoutKey(readPosted(posted), apiKey), describeImages('jev', request))
    },
  }
}

/**
 * The extra headers and the body a request goes out with. Without images: the body it always had. With images (their
 * references start with `id`): the images in the top-level `assets` (JSON with base64: a module's http body is a string, so no
 * multipart), the references where the state and the questions had `imageRef`s, the pinned model and the images header.
 * Throws a RangeError for a request Jev would answer 400 (see `placeImages`).
 */
function jevRequest(request: DecisionRequest, model: string, id: string): { headers: Record<string, string>; body: unknown } {
  const images = request.images ?? []
  if (images.length === 0) return { headers: {}, body: { model, state: request.state, questions: request.questions } }
  const { state, questions } = placeImages(request, (image) => `${id}-${image.name}`)
  const assets = Object.fromEntries(images.map((image) => [`${id}-${image.name}`, { type: 'image', format: image.format, data_base64: image.base64 }]))
  return { headers: { [JEV_IMAGES_HEADER]: 'true' }, body: { model: JEV_IMAGE_MODEL, state, assets, questions } }
}
