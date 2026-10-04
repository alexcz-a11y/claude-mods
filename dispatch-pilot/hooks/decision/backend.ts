// The decision backend's interface: one implementation per decision model
// (Jev here; Clef joins in its own file), the same requests and answers.
//
// Pure (see system-one.ts): a backend reaches the network only through the
// `io` it is handed, which the mod builds from `$` in the hook that calls it
// (`$` itself may not cross an import) and a Node script builds from `fetch`.

import type { HttpInit, HttpResponse } from 'claude-code'
import type { DecisionRequest } from './system-one.ts'

/** What a backend needs from the host, as closures. */
export type BackendIo = {
  fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  /** Resolves after `ms`; rejects at once when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Why a request produced no answers; every kind is passed through (fail open). */
export type Failure = {
  /**
   * `config`: no key, or the key was refused (401/403). `timeout`: no answer
   * in time. `network`: the request never completed. `busy`: rate limited or
   * overloaded (429, 502, 503, 529). `quota`: the account's allowance for the
   * day is spent, so asking again today is pointless (Cloudflare's 3036, also
   * an HTTP 429). `http`: any other non-2xx (400 and 422 mean this mod sent a
   * bad request). `parse`: a 2xx that is not a System One answer. `request`:
   * the request could not be built (a part's bug).
   */
  kind: 'config' | 'timeout' | 'network' | 'busy' | 'quota' | 'http' | 'parse' | 'request'
  /** One line for the debug log. */
  detail: string
  /** The HTTP status, when there was one. */
  status?: number
}

export type Asked =
  | { ok: true; answers: Readonly<Record<string, unknown>>; model: string | null; inputTokens: number | null }
  | { ok: false; failure: Failure }

export type Backend = {
  /** Its name in the status line and the debug log. */
  name: string
  /**
   * False when the person has not set it up (no key): every `ask` fails at
   * once with a `config` failure. A feature that takes something away in
   * exchange for the decisions (the skills feature hides the listing) holds
   * back then. Absent reads as set up.
   */
  configured?: boolean
  /** One decision request, answered within `timeoutMs` or failed; never throws. */
  ask: (io: BackendIo, request: DecisionRequest, timeoutMs: number) => Promise<Asked>
}

export type Posted = { ok: true; response: HttpResponse } | { ok: false; failure: Failure }

/**
 * POSTs `body` as JSON, giving up after `timeoutMs` ($.http.fetch has no
 * timeout of its own). A request that loses the race keeps running; its
 * answer is dropped. A non-2xx response becomes a failure through `classify`
 * (by its HTTP status, unless the backend reads more of its body).
 */
export async function postJson(
  io: BackendIo,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  classify: (response: HttpResponse) => Failure = httpFailure,
): Promise<Posted> {
  const stop = new AbortController()
  const timer = io.sleep(timeoutMs, stop.signal).then(
    (): Posted => ({ ok: false, failure: { kind: 'timeout', detail: `no answer in ${timeoutMs} ms` } }),
    (): Posted => ({ ok: false, failure: { kind: 'timeout', detail: `no answer in ${timeoutMs} ms` } }),
  )
  const call = io.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(
    (response): Posted => (response.ok ? { ok: true, response } : { ok: false, failure: classify(response) }),
    (error: unknown): Posted => ({ ok: false, failure: { kind: 'network', detail: String(error instanceof Error ? error.message : error) } }),
  )
  try {
    return await Promise.race([call, timer])
  } finally {
    stop.abort()
  }
}

/** A non-2xx response as a failure, with the start of its body for the log. */
export function httpFailure(response: HttpResponse): Failure {
  const status = response.status
  const detail = `HTTP ${status}: ${response.text.replace(/\s+/g, ' ').slice(0, 200)}`
  if (status === 401 || status === 403) return { kind: 'config', status, detail }
  if (status === 429 || status === 502 || status === 503 || status === 529) return { kind: 'busy', status, detail }
  return { kind: 'http', status, detail }
}
