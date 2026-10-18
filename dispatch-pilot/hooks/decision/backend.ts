// The decision backend's interface: one implementation per decision model
// (Jev's in jev.ts, pplx's in pplx.ts), the same requests and answers.
//
// Pure (see system-one.ts): a backend reaches the network only through the
// `io` it is handed, which the mod builds from `$` in the hook that calls it
// (`$` itself may not cross an import) and a Node script builds from `fetch`.

import type { HttpInit, HttpResponse } from 'claude-code'
import { readResponse, type DecisionRequest } from './system-one.ts'

/** The decision models there are, by the name the person sets (`decisionModel`) and the code keys its tables by. */
export type BackendName = 'pplx' | 'jev'

/** What a backend needs from the host, as closures. */
export type BackendIo = {
  fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  /** Resolves after `ms`; rejects at once when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  /**
   * What the rate limits (pplx-rate.ts, jev-rate.ts) pace with: the clock, and for pplx a `$.state` cell for the times of
   * the latest sends (Jev's keeps its count in the backend object and does not read it). The hooks of the mod give it; the
   * eval, which paces its own requests, leaves it out, and a backend without a limit ignores it.
   */
  pace?: {
    now: () => Promise<number>
    /** The times (mock or real ms) of the latest sends, as `$.state` keeps them. */
    sentAt: StateCell<number[]>
  }
}

/** A `$.state` value reached through closures (the hook that owns `$` builds them); core/plans.ts `Cell` is this type. */
export type StateCell<T> = {
  get: () => Promise<{ value: T | undefined; version: number }>
  set: (value: T, options: { ifVersion: number }) => Promise<{ isSet: boolean; version: number }>
}

/** Why a request produced no answers; every kind is passed through (fail open). */
export type Failure = {
  /**
   * `config`: no key, or the key was refused (401/403). `timeout`: no answer
   * in time. `network`: the request never completed. `busy`: rate limited or
   * overloaded (429, 502, 503, 529), or held back by a rate limit's wait. `quota`: the account has no credits
   * left (402, from TypeSafe and Perplexity alike), so asking again is pointless until it is topped up. `http`: any other
   * non-2xx (400 and 422 mean this mod sent a bad request). `parse`: a 2xx that is not a System One answer. `request`:
   * the request could not be built (a part's bug).
   */
  kind: 'config' | 'timeout' | 'network' | 'busy' | 'quota' | 'http' | 'parse' | 'request'
  /** One line for the debug log. */
  detail: string
  /** The HTTP status, when there was one. */
  status?: number
  /** How long a 429 (or Jev's 529) asked to wait before asking again (its `Retry-After`, in ms); only one that gave a number has it. */
  retryAfterMs?: number
}

export type Asked = (
  | { ok: true; answers: Readonly<Record<string, unknown>>; model: string | null; inputTokens: number | null }
  | { ok: false; failure: Failure }
) & {
  /** What happened on the way that does not change the answer but belongs in the debug log (the rate limit could not be kept for this request). */
  notes?: readonly string[]
}

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
  /**
   * Whether `request` goes out past the model's regular limits (Jev's long-context header): it takes longer to answer, so
   * it, and the requests sent beside it, wait longer (core/setup.ts `waitFor`). Absent: no request does (pplx takes 262k
   * tokens in every request, and its wait is seconds already).
   */
  longContext?: (request: DecisionRequest) => boolean
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
  const late: Posted = { ok: false, failure: timedOut(timeoutMs) }
  return within(io.sleep, call, timeoutMs, late)
}

/** The failure of a request that was not answered in `timeoutMs`; `failureLine` reads the number back out of its detail. */
export function timedOut(timeoutMs: number): Failure {
  return { kind: 'timeout', detail: `no answer in ${timeoutMs} ms` }
}

/** The answers out of a posted request, or why there are none (a 2xx body that is not JSON, or holds no answers). */
export function readPosted(posted: Posted): Asked {
  if (!posted.ok) return posted
  const text = posted.response.text
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, failure: { kind: 'parse', detail: `not JSON: ${withoutBase64(text).slice(0, 200)}` } }
  }
  const response = readResponse(body)
  if (response === null) return { ok: false, failure: { kind: 'parse', detail: `no answers: ${withoutBase64(text).slice(0, 200)}` } }
  return { ok: true, ...response }
}

/** `asked` with the key out of a failure's detail: a failure goes to the debug log, and what the API echoes of the key stays out. */
export function withoutKey(asked: Asked, apiKey: string): Asked {
  return asked.ok ? asked : { ok: false, failure: { ...asked.failure, detail: asked.failure.detail.split(apiKey).join('[REDACTED]') } }
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

/** `asked` with `note` among its notes (a request with images says what it carried); `asked` as it is for a null note. */
export function withNote(asked: Asked, note: string | null): Asked {
  return note === null ? asked : { ...asked, notes: [...(asked.notes ?? []), note] }
}

/** Text from a response or an error with its long base64 runs (an image the API echoed back) left out: no image content reaches a log. */
export function withoutBase64(text: string): string {
  return text.replace(/[A-Za-z0-9+/_-]{60,}={0,2}/g, '[base64 left out]')
}

/** A request's outcome as every debug-log line about one writes it: `answered in 310 ms by jev-1.14.0 (626 input tokens)`, or the failure. */
export function describeAsked(asked: Asked, ms: number): string {
  const notes = asked.notes === undefined || asked.notes.length === 0 ? '' : `; ${asked.notes.join('; ')}`
  if (!asked.ok) return `${asked.failure.kind}: ${asked.failure.detail} (${ms} ms)${notes}`
  const by = asked.model === null ? '' : ` by ${asked.model}`
  const tokens = asked.inputTokens === null ? '' : ` (${asked.inputTokens} input tokens)`
  return `answered in ${ms} ms${by}${tokens}${notes}`
}

/** What went wrong, in one line for the debug log. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A non-2xx response as a failure, with the start of its body for the log. A 402 is an account out of credits (TypeSafe and
 * Perplexity both answer so). A 429 or 529 that says how long to wait
 * (`Retry-After`, in seconds) carries it as `retryAfterMs`, for a rate limit to wait as told (jev-rate.ts).
 */
export function httpFailure(response: HttpResponse): Failure {
  const status = response.status
  const detail = `HTTP ${status}: ${withoutBase64(response.text).replace(/\s+/g, ' ').slice(0, 200)}`
  if (status === 401 || status === 403) return { kind: 'config', status, detail }
  if (status === 402) return { kind: 'quota', status, detail }
  const wait = status === 429 || status === 529 ? retryAfterSeconds(response) : null
  if (status === 429 || status === 502 || status === 503 || status === 529) return { kind: 'busy', status, detail, ...(wait === null ? {} : { retryAfterMs: Number(wait) * 1000 }) }
  return { kind: 'http', status, detail }
}

/** The seconds a response's `Retry-After` header asks to wait, when it gives a whole number of them (a date is not read). */
export function retryAfterSeconds(response: HttpResponse): string | null {
  const header = Object.entries(response.headers ?? {}).find(([name]) => name.toLowerCase() === 'retry-after')
  return header !== undefined && /^\d+$/.test(String(header[1]).trim()) ? String(header[1]).trim() : null
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
      return `${backend}: out of credits (HTTP ${failure.status ?? '?'})`
    case 'http':
      return `${backend}: HTTP ${failure.status ?? '?'}`
    case 'parse':
      return `${backend}: unreadable answer`
    case 'request':
      return `${backend}: bad request (see debug log)`
  }
}

/**
 * What a person reads of each kind of failed request, in one table (Chinese; the model's words are `failureText`):
 * `words`, a few of them (the band's not-routed cell, the toast's start); `means`, what the kind is (the card's
 * row beside the kind); `line`, the request's failure with its details (the board's `why`, the toast, the card, the
 * decision log's reasons): `jev：1500 毫秒内没有回答`, `jev：密钥被拒绝（状态码 401）`.
 */
const FAILURE_WORDS: { readonly [K in Failure['kind']]: { words: (failure: NamedFailure) => string; means: (failure: NamedFailure) => string; line: (backend: string, failure: Failure) => string } } = {
  config: {
    words: (failure) => (failure.status === undefined ? '决策模型没配好' : '决策模型拒绝了密钥'),
    means: () => '没有配好决策模型的密钥或账号，或者密钥被拒绝',
    line: (backend, failure) => {
      if (failure.status !== undefined) return `${backend}：密钥被拒绝（状态码 ${failure.status}）`
      // Nothing was sent: what is not set up (the option and the variable names are the ones the person types; any one of them does).
      const missing = ['typesafeApiKey', 'TYPESAFE_API_KEY', 'perplexityApiKey', 'PERPLEXITY_API_KEY'].filter((name) => failure.detail.includes(name))
      return missing.length === 0 ? `${backend}：没有配好密钥或账号` : `${backend}：没有填 ${missing.join(' 或 ')}`
    },
  },
  timeout: {
    words: () => '决策模型超时',
    means: () => '没有在等待时间内回答',
    line: (backend, failure) => {
      // The board keeps a failure's detail and not its fields, so the wait is read back out of what `timedOut` wrote.
      const ms = /\b(\d+) ms\b/.exec(failure.detail)?.[1]
      return ms === undefined ? `${backend}：没有及时回答` : `${backend}：${ms} 毫秒内没有回答`
    },
  },
  network: { words: () => '连不上决策模型', means: () => '网络不通，请求没有发出去', line: (backend) => `${backend}：连不上` },
  // A 429 from pplx is the rate limit the mod itself keeps to (pplxQps, pplx-rate.ts): 「被限速」. Jev's is 「繁忙」, as in 0.3.1.
  busy: {
    words: (failure) => (rateLimited(failure.backend, failure) ? '决策模型被限速' : '决策模型繁忙'),
    means: (failure) => (rateLimited(failure.backend, failure) ? '请求太密，被决策模型限速了（状态码 429）' : '决策模型一时繁忙（状态码 429 之类）'),
    line: (backend, failure) => (rateLimited(backend, failure) ? `${backend}：被限速（状态码 429）` : `${backend}：繁忙（状态码 ${failure.status ?? '?'}）`),
  },
  quota: { words: () => '决策模型额度用完', means: () => '决策模型账号的额度用完了（状态码 402）', line: (backend, failure) => `${backend}：额度用完了（状态码 ${failure.status ?? '?'}）` },
  http: { words: () => '决策模型出错', means: () => '决策模型回了一个出错的状态码', line: (backend, failure) => `${backend}：出错（状态码 ${failure.status ?? '?'}）` },
  parse: { words: () => '读不懂决策模型的回答', means: () => '回答里没有能用的判断', line: (backend) => `${backend}：回答读不懂` },
  request: { words: () => '决策请求出错', means: () => '请求本身出了错', line: (backend) => `${backend}：请求出错（详见 debug log）` },
}

/**
 * The failure for the person, with its details: the board's reason an agent is not routed, the toast, the card and
 * the decision log's reasons (`FAILURE_WORDS`'s `line`); the model never reads it.
 */
export function failureLine(backend: string, failure: Failure): string {
  return FAILURE_WORDS[failure.kind].line(backend, failure)
}

/** The failure in a few words, as the band says why an agent is not routed (the toast and the card add the details). */
export function failureWords(failure: NamedFailure): string {
  return FAILURE_WORDS[failure.kind].words(failure)
}

/** What a kind of failure is, as the card says it beside the kind. */
export function failureMeaning(failure: NamedFailure): string {
  return FAILURE_WORDS[failure.kind].means(failure)
}

/** A failure with the decision model it came from, as the board keeps it. */
export type NamedFailure = Failure & { backend: string }

/** Whether a 429 is the limit the mod keeps pplx to (Jev's 429 is its own busy). */
function rateLimited(backend: string, failure: Failure): boolean {
  return backend === 'pplx' && failure.status === 429
}
