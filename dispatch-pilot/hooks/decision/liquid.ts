// d1-ultra and d1.1, Liquid AI's decision models: POST https://api.liquid.ai/decisions/v1/systemone with a Bearer key (ADR
// 0017, ADR 0021). The request and the answers are TypeSafe's System One API, Jev's (`{ model, state, questions }` in,
// `{ model, answers, usage }` out: a Choice's `choice`, `probabilities` and `confidence`, a Score's `score`, `legend`,
// `probabilities` and `confidence`, a Noul's `noul`), so it is posted and read as Jev's is (backend.ts `postJson`,
// `readPosted`). What differs: no long-context header (a question reads at most 32,768 tokens of state and question on
// d1-ultra, `LIQUID_QUESTION_TOKENS`, and 65,536 on d1.1, `D1_1_QUESTION_TOKENS`), no Box and no images here (they stay with
// Jev, whatever decides the rest: core/setup.ts `chooseImageBackend`), and a 429 is Liquid's rate limit (20 requests a second
// a model, shared by all of an account's keys), read as busy with its `Retry-After` like any other. A request is billed its
// state once and each question's own tokens (the API reference; measured on both models, DEVELOPMENT.md 「d1.1 的预算」).
//
// The console says "Zero data retention on every model": Liquid does not store, log or train on what is sent.
//
// Pure (see system-one.ts).

import { errorText, postJson, readPosted, withoutKey, type Backend } from './backend.ts'
import type { DecisionRequest } from './system-one.ts'

export const LIQUID_URL = 'https://api.liquid.ai/decisions/v1/systemone'
/**
 * The model, pinned: `d1-ultra`, not `d1-ultra:latest`, which "always point[s] to the newest model of [its] family" (the
 * console's API reference: "pin an exact id such as `d1-ultra` to keep the same model").
 */
export const LIQUID_MODEL = 'd1-ultra'
/**
 * Liquid's newest decision model (2026-10-19, "Default hosted decision model"), pinned as d1-ultra is: `d1.1`, not
 * `d1:latest`, which answered as `d1.1` on 2026-11-10 and moves with the family (ADR 0021).
 */
export const D1_1_MODEL = 'd1.1'
/** The most a question reads, its state with it, in Liquid's tokens (the API reference: "`d1-ultra` 32,768"; past it, 422). */
export const LIQUID_QUESTION_TOKENS = 32_768
/** The same on d1.1 (the API reference: "`d1` and `d1.1` allow 65,536 tokens"); the mod's budgets stay d1-ultra's (core/setup.ts). */
export const D1_1_QUESTION_TOKENS = 65_536
/**
 * Liquid's tokens for each the mod estimates (context.ts `estimateTokens`), measured on a state of 23,346 estimated tokens,
 * a conversation half Chinese and half English with code: 25,484 (1.092; 2026-10-28, DEVELOPMENT.md 「d1-ultra 的预算」).
 * A mostly Chinese one counted fewer, 21,911 for 23,625 (0.93), on d1.1 and d1-ultra alike (2026-11-10): one tokenizer.
 */
export const LIQUID_PER_ESTIMATED_TOKEN = 1.092

/**
 * The key is a string, or a function that gives it when asked: the mod's may come from the environment, which is read after
 * the backend is built (core/setup.ts `Secrets`). `configured` follows it. `model`: d1-ultra unless given (`D1_1_MODEL`).
 * `name`: what the board and the log call it, the model unless given (the mod's `decisionModel` value, `d1-ultra` or `d1.1`;
 * the eval's older runs call d1-ultra `d1`).
 */
export function liquidBackend(apiKey: string | (() => string), options: { url?: string; model?: string; name?: string } = {}): Backend {
  const url = options.url ?? LIQUID_URL
  const model = options.model ?? LIQUID_MODEL
  const keyNow = typeof apiKey === 'function' ? apiKey : () => apiKey
  return {
    name: options.name ?? model,
    get configured() {
      return keyNow() !== ''
    },
    async ask(io, request, timeoutMs) {
      const apiKey = keyNow()
      if (!apiKey) return { ok: false, failure: { kind: 'config', detail: 'no Liquid API key: set liquidApiKey or LIQUID_API_KEY' } }
      let body: unknown
      try {
        body = liquidRequest(request, model)
      } catch (error) {
        return { ok: false, failure: { kind: 'request', detail: errorText(error) } }
      }
      const posted = await postJson(io, url, { authorization: `Bearer ${apiKey}` }, body, timeoutMs)
      return withoutKey(readPosted(posted), apiKey)
    },
  }
}

/**
 * The body a request goes out with. Throws a RangeError for a request with images or a Box question: those are Jev's. Liquid's
 * models take images now (GET /decisions/v1/models lists `image` for each, 2026-11-10), but the zoomed re-check asks Jev's
 * Box question, which Liquid's API does not have (core/setup.ts `chooseImageBackend`).
 */
function liquidRequest(request: DecisionRequest, model: string): unknown {
  if ((request.images ?? []).length > 0) throw new RangeError(`${model} is asked no images here: they go to Jev`)
  if (Object.values(request.questions).some((question) => question.type === 'box')) throw new RangeError(`${model} has no Box question`)
  return { model, state: request.state, questions: request.questions }
}
