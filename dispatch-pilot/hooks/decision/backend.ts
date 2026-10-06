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
  /** Its name on the board and in the debug log. */
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
  const call = io.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(
    (response): Posted => (response.ok ? { ok: true, response } : { ok: false, failure: classify(response) }),
    (error: unknown): Posted => ({ ok: false, failure: { kind: 'network', detail: errorText(error) } }),
  )
  const late: Posted = { ok: false, failure: { kind: 'timeout', detail: `no answer in ${timeoutMs} ms` } }
  return within(io.sleep, call, timeoutMs, late)
}

/**
 * What `promise` comes to when it settles within `ms`, else `late`; the timer
 * is called off either way. A promise that loses keeps running (a caller may
 * still take its answer later). `sleep` is the host's, as BackendIo has it:
 * `(ms, signal) => $.clock.sleep(ms, { signal })` in a hook.
 */
export async function within<T, L>(sleep: BackendIo['sleep'], promise: Promise<T>, ms: number, late: L): Promise<T | L> {
  const stop = new AbortController()
  const timer = sleep(ms, stop.signal).then(
    () => late,
    () => late,
  )
  try {
    return await Promise.race([promise, timer])
  } finally {
    stop.abort()
  }
}

/** A request's outcome as every debug-log line about one writes it: `answered in 310 ms by jev-1.13.0 (626 input tokens)`, or the failure. */
export function describeAsked(asked: Asked, ms: number): string {
  if (!asked.ok) return `${asked.failure.kind}: ${asked.failure.detail} (${ms} ms)`
  const by = asked.model === null ? '' : ` by ${asked.model}`
  const tokens = asked.inputTokens === null ? '' : ` (${asked.inputTokens} input tokens)`
  return `answered in ${ms} ms${by}${tokens}`
}

/** What went wrong, in one line for the debug log. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A non-2xx response as a failure, with the start of its body for the log. */
export function httpFailure(response: HttpResponse): Failure {
  const status = response.status
  const detail = `HTTP ${status}: ${response.text.replace(/\s+/g, ' ').slice(0, 200)}`
  if (status === 401 || status === 403) return { kind: 'config', status, detail }
  if (status === 429 || status === 502 || status === 503 || status === 529) return { kind: 'busy', status, detail }
  return { kind: 'http', status, detail }
}

/**
 * A failed decision request in a few words: `jev: no answer in 1500 ms`,
 * `jev: key refused (HTTP 401)`. English: what the model is told when a request
 * fails (a Workflow note, a find_skill answer) and the debug log's words, which
 * stay as they are. What a person reads is `failureLine`.
 */
export function failureText(backend: string, failure: Failure): string {
  switch (failure.kind) {
    case 'config':
      return failure.status === undefined ? `${backend}: ${failure.detail}` : `${backend}: key refused (HTTP ${failure.status})`
    case 'timeout':
      return `${backend}: ${failure.detail}`
    case 'network':
      return `${backend}: unreachable`
    case 'busy':
      return `${backend}: busy (HTTP ${failure.status ?? '?'})`
    case 'quota':
      return `${backend}: daily quota used up`
    case 'http':
      return `${backend}: HTTP ${failure.status ?? '?'}`
    case 'parse':
      return `${backend}: unreadable answer`
    case 'request':
      return `${backend}: bad request (see debug log)`
  }
}

/**
 * The same, for the person: the board's reason an agent is not routed, the
 * toast, the card and the decision log's reasons. Chinese, `jev：1500 毫秒内没有回答`,
 * `jev：密钥被拒绝（状态码 401）`; the model never reads it.
 */
export function failureLine(backend: string, failure: Failure): string {
  switch (failure.kind) {
    case 'config': {
      if (failure.status !== undefined) return `${backend}：密钥被拒绝（状态码 ${failure.status}）`
      // Nothing was sent: what is not set up (the option names are the ones the person types).
      const missing = ['typesafeApiKey', 'cloudflareAccountId', 'cloudflareApiToken'].filter((option) => failure.detail.includes(option))
      return missing.length === 0 ? `${backend}：没有配好密钥或账号` : `${backend}：没有填 ${missing.join(' 和 ')}`
    }
    case 'timeout': {
      const ms = /\b(\d+) ms\b/.exec(failure.detail)?.[1]
      return ms === undefined ? `${backend}：没有及时回答` : `${backend}：${ms} 毫秒内没有回答`
    }
    case 'network':
      return `${backend}：连不上`
    case 'busy':
      return `${backend}：繁忙（状态码 ${failure.status ?? '?'}）`
    case 'quota':
      return `${backend}：今天的额度用完了`
    case 'http':
      return `${backend}：出错（状态码 ${failure.status ?? '?'}）`
    case 'parse':
      return `${backend}：回答读不懂`
    case 'request':
      return `${backend}：请求出错（详见 debug log）`
  }
}
