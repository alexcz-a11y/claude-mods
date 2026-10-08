// Perplexity's decision model, pplx-decider-v1.1-27b, on the Decisions API:
// POST https://api.perplexity.ai/v1/decisions with a Bearer key. The request is
// Jev's (the same state and questions; the body holds `model`, `state` and
// `questions` and nothing else, since the API answers 400 to an unknown
// top-level field), and so is the answer: `{ model, answers, usage }`, an answer
// per question under its name. What differs from Jev is how failures look:
// most come as `{ error: { message, type, code } }`, a 404 or 405 has an empty
// body, a 504 may be an HTML page, and a 429 carries `Retry-After`.
//
// A choice in the mod's settings (`decisionModel: pplx`, #50; ADR 0006) and the eval's (`--backend pplx`).
//
// Pure (see system-one.ts).

import type { HttpResponse } from 'claude-code'
import { postJson, type Asked, type Backend, type Failure } from './backend.ts'
import { readResponse } from './system-one.ts'

export const PPLX_URL = 'https://api.perplexity.ai/v1/decisions'
/**
 * The decision model, by the name the docs give: the API takes this and
 * `pplx-decider-v1-27b` only, with no `-latest` alias (an unknown name is a 400).
 */
export const PPLX_MODEL = 'pplx-decider-v1.1-27b'

/**
 * The key is a string, or a function that gives it when asked: the mod's key may come from the environment, which is read
 * after the backend is built (core/setup.ts `Secrets`). `configured` follows it.
 */
export function pplxBackend(apiKey: string | (() => string), options: { url?: string; model?: string } = {}): Backend {
  const url = options.url ?? PPLX_URL
  const model = options.model ?? PPLX_MODEL
  const keyNow = typeof apiKey === 'function' ? apiKey : () => apiKey
  return {
    name: 'pplx',
    get configured() {
      return keyNow() !== ''
    },
    async ask(io, request, timeoutMs) {
      const apiKey = keyNow()
      if (!apiKey) return { ok: false, failure: { kind: 'config', detail: 'no Perplexity API key: set perplexityApiKey or PERPLEXITY_API_KEY' } }
      const posted = await postJson(io, url, { authorization: `Bearer ${apiKey}` }, { model, state: request.state, questions: request.questions }, timeoutMs, pplxFailure)
      const asked: Asked = posted.ok ? readAnswers(posted.response.text) : posted
      // A failure's detail goes to the debug log: what it echoes of the key stays out.
      return asked.ok ? asked : { ok: false, failure: { ...asked.failure, detail: asked.failure.detail.split(apiKey).join('[REDACTED]') } }
    },
  }
}

/**
 * A non-2xx response as a failure. 401 and 403 are the key; 429 and the
 * service's own 500, 502, 503 and 529 are worth asking again (`busy`), 429 with
 * the wait `Retry-After` asked for in the detail and as `retryAfterMs` (the
 * rate limiter, pplx-rate.ts, retries on it); 504 is the model not answering
 * in time (about a minute, in the docs' tests); the rest, 400 and 413 among them,
 * mean this mod sent a bad request. The detail is the API's own reason
 * (`error.type: error.message`), or what there is of the body.
 */
function pplxFailure(response: HttpResponse): Failure {
  const status = response.status
  const wait = retryAfter(response)
  const detail = `HTTP ${status}: ${bodyReason(response.text)}${wait === null || status !== 429 ? '' : ` (retry after ${wait} s)`}`
  if (status === 401 || status === 403) return { kind: 'config', status, detail }
  if (status === 429) return { kind: 'busy', status, detail, ...(wait === null ? {} : { retryAfterMs: Number(wait) * 1000 }) }
  if (status === 500 || status === 502 || status === 503 || status === 529) return { kind: 'busy', status, detail }
  if (status === 504 || status === 408) return { kind: 'timeout', status, detail }
  return { kind: 'http', status, detail }
}

/** Why a response failed, from its body: the JSON `error`, else what the body is (empty, an HTML page) or its start. */
function bodyReason(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return 'empty body'
  const error = parse(trimmed)?.error
  if (isRecord(error) && typeof error.message === 'string') return typeof error.type === 'string' ? `${error.type}: ${error.message}` : error.message
  if (/^<(!doctype|html)\b/i.test(trimmed)) return 'an HTML page, not JSON'
  return trimmed.replace(/\s+/g, ' ').slice(0, 200)
}

/** The seconds a 429's `Retry-After` header asks to wait, when it has one. */
function retryAfter(response: HttpResponse): string | null {
  const header = Object.entries(response.headers ?? {}).find(([name]) => name.toLowerCase() === 'retry-after')
  return header !== undefined && /^\d+$/.test(String(header[1]).trim()) ? String(header[1]).trim() : null
}

/** The answers out of a 2xx body; a failure when it is not JSON or holds none. */
function readAnswers(text: string): Asked {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, failure: { kind: 'parse', detail: `not JSON: ${text.slice(0, 200)}` } }
  }
  const response = readResponse(body)
  if (response === null) return { ok: false, failure: { kind: 'parse', detail: `no answers: ${text.slice(0, 200)}` } }
  return { ok: true, ...response }
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
