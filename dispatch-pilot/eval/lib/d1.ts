// d1-ultra, Liquid AI's decision model (released 2026-10-15): the same System One request and answers as Jev's
// (`{model, state, questions}` in, `answers` with each level's probability and `usage.input_tokens` out), at Liquid's
// endpoint with a Liquid key. For the eval only (DEVELOPMENT.md 「d1-ultra 核验」): the mod has no such backend, and a run
// on it reads Jev's row of the defaults (its questions, thresholds and budgets), so the requests are the ones Jev is asked.
// No images (Liquid takes them in a top-level `images` array, not Jev's `assets`) and no long-context header (it has none).
//
// Pure: the network is handed in.

import { postJson, readPosted, withoutKey, type Backend } from '../../hooks/decision/backend.ts'

export const D1_URL = 'https://api.liquid.ai/decisions/v1/systemone'
export const D1_MODEL = 'd1-ultra'
/** Input price per million tokens; output is free (liquid.ai/pricing, 2026-10-15). */
export const D1_PRICE = 0.042

export function d1Backend(apiKey: string, options: { url?: string; model?: string } = {}): Backend {
  const url = options.url ?? D1_URL
  const model = options.model ?? D1_MODEL
  return {
    name: 'd1',
    configured: apiKey !== '',
    async ask(io, request, timeoutMs) {
      if (!apiKey) return { ok: false, failure: { kind: 'config', detail: 'no Liquid API key: set LIQUID_API_KEY' } }
      if ((request.images ?? []).length > 0) return { ok: false, failure: { kind: 'request', detail: 'the eval sends d1 no images' } }
      const posted = await postJson(io, url, { authorization: `Bearer ${apiKey}` }, { model, state: request.state, questions: request.questions }, timeoutMs)
      return withoutKey(readPosted(posted), apiKey)
    },
  }
}
