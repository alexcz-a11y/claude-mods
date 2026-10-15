// What a run is estimated to send, for `eval/run.ts --estimate` and `--max-usd` (nothing is sent to find it out). The mod's token estimate
// of the text (decision/context.ts) times the factor a decision model's own count has been found to be of it, and, for a request with
// images, the tokens its pixels cost (decision/images.ts: Jev about 2,600 a megapixel, once; pplx about 1,000 for each question), which
// are not estimated from the length of the base64 the images travel as. Pure: no Node API.

import type { BackendName } from '../../hooks/decision/backend.ts'
import { estimateTokens } from '../../hooks/decision/context.ts'
import { imageTokens } from '../../hooks/decision/images.ts'
import type { DecisionRequest } from '../../hooks/decision/system-one.ts'

/** A request's estimated tokens: its text as the mod estimates it (the request as it goes out, with its model, less the images), and its pictures as the decision model counts them. */
export function estimateRequest(request: DecisionRequest, model: string, backend: BackendName): { text: number; images: number } {
  const { images = [], ...text } = request
  return { text: estimateTokens(JSON.stringify({ model, ...text })), images: imageTokens(backend, images, Object.keys(request.questions).length) }
}

/**
 * The input tokens and the price of `requests`: the text's estimate times `factor` (what the decision model counted over what the mod
 * estimates, run.ts), plus the pictures' tokens as they are, at `usdPerMillionTokens`.
 */
export function estimateRun(requests: readonly DecisionRequest[], options: { model: string; backend: BackendName; factor: number; usdPerMillionTokens: number }): { tokens: number; usd: number } {
  const each = requests.map((request) => estimateRequest(request, options.model, options.backend))
  const tokens = Math.round(options.factor * each.reduce((sum, one) => sum + one.text, 0) + each.reduce((sum, one) => sum + one.images, 0))
  return { tokens, usd: (tokens * options.usdPerMillionTokens) / 1e6 }
}
