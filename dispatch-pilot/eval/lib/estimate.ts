// What a run is estimated to send, for `eval/run.ts --estimate` and `--max-usd` (nothing is sent to find it out). The mod's token estimate
// of the text (decision/context.ts) times the factor a decision model's own count has been found to be of it, and, for a request with
// images, the tokens its pixels cost (decision/images.ts: Jev about 2,600 a megapixel, once; pplx about 1,000 for each question), which
// are not estimated from the length of the base64 the images travel as. Pure: no Node API.

import type { BackendName } from '../../hooks/decision/backend.ts'
import { estimateTokens } from '../../hooks/decision/context.ts'
import { imageTokens } from '../../hooks/decision/images.ts'
import type { DecisionRequest } from '../../hooks/decision/system-one.ts'

/**
 * What each decision model counted over the mod's estimate of the same text. Jev: 6468 tokens for 8 effort-submit requests
 * estimated at 4127 (2026-10-04), so 1.6. Perplexity counts differently, by the kind of text: against the estimate (without the
 * factor) its input tokens were 0.7 times for the skill suite, 0.9 for effort-submit, 1.0 for effort-midturn, 1.7 for subagent and
 * 2.9 for unresolved (2026-10-07: the long logs of its conversations tokenize four times as densely as the estimate's four
 * characters a token), so its factor is 3, so as never to estimate less than a run costs.
 */
export const ESTIMATE_FACTOR: Readonly<Record<BackendName, number>> = { jev: 1.6, pplx: 3 }

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
