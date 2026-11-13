// Drex Max v1.1, Nace's decision model, the default since 0.13.0 (ADR 0026): POST https://console.nace.ai/v1/systemone with a
// Bearer key. The request and the answers are TypeSafe's System One API, Jev's (`{ model, state, questions }` in,
// `{ model, answers, usage }` out), so it is posted and read as Jev's is (backend.ts `postJson`, `readPosted`), and it is
// asked Jev's questions and read at TypeSafe's bars (core/setup.ts DREX_DEFAULTS): those are what the eval of 2026-11-13 ran.
//
// What differs: one limit of 262,144 tokens for a whole request (the state once, every question), so there is no long-context
// header; no Box question (a 422); a Noul answer carries a `confidence` too (the likelier side's probability), which nothing
// here reads; a 429 is the account's rate limit (120 requests a minute and 8 at once on the free tier, 1200 and 16 once
// paid), read as busy with its `retry-after` like any other. No images here: they stay with Jev, whatever decides the rest
// (core/setup.ts `chooseImageBackend`). Drex Max reads images (a top-level `images` array, 8 a request), but without a Box
// question nothing locates a part for the zoomed re-check, and the way tried without one (the same enlarged bands of both
// images in one request, eval/lib/visual-check-criteria.ts) let two parts that differ pass where Jev let one (ADR 0026).
//
// What Nace keeps of a request's state is not in its Drex docs (2026-11-12; its data-retention page is about documents).
//
// Pure (see system-one.ts).

import { errorText, postJson, readPosted, withoutKey, type Backend } from './backend.ts'
import type { DecisionRequest } from './system-one.ts'

export const DREX_URL = 'https://console.nace.ai/v1/systemone'
/**
 * The model, pinned: `drex-max-v1.1`, not `drex-latest`, which names it today and moves (reference/models; Nace: "Pin a
 * model ... when you tune a threshold, because probabilities can shift between models").
 */
export const DREX_MODEL = 'drex-max-v1.1'

/** The key is a string, or a function that gives it when asked (the mod's may come from the environment: core/setup.ts `Secrets`). */
export function drexBackend(apiKey: string | (() => string), options: { url?: string; model?: string } = {}): Backend {
  const url = options.url ?? DREX_URL
  const model = options.model ?? DREX_MODEL
  const keyNow = typeof apiKey === 'function' ? apiKey : () => apiKey
  return {
    name: 'drex',
    get configured() {
      return keyNow() !== ''
    },
    async ask(io, request, timeoutMs) {
      const apiKey = keyNow()
      if (!apiKey) return { ok: false, failure: { kind: 'config', detail: 'no Nace API key: set naceApiKey or NACE_API_KEY' } }
      let body: unknown
      try {
        body = drexRequest(request, model)
      } catch (error) {
        return { ok: false, failure: { kind: 'request', detail: errorText(error) } }
      }
      const posted = await postJson(io, url, { authorization: `Bearer ${apiKey}` }, body, timeoutMs)
      return withoutKey(readPosted(posted), apiKey)
    },
  }
}

/** The body a request goes out with. Throws a RangeError for a request with images or a Box question: those are Jev's. */
function drexRequest(request: DecisionRequest, model: string): unknown {
  if ((request.images ?? []).length > 0) throw new RangeError(`${model} is asked no images here: they go to Jev`)
  if (Object.values(request.questions).some((question) => question.type === 'box')) throw new RangeError(`${model} has no Box question`)
  return { model, state: request.state, questions: request.questions }
}
