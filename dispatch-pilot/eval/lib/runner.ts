// Runs a suite: every item, in each language, under each variant, asked of
// one backend the way the mod asks it, and graded. One row per answer.
//
// The eval is a batch, not the mod's hot path: a busy backend, a dropped
// connection or a timeout is asked again after a pause (the backend's own
// Retry-After when it sent one, else 1 s, then 2 s, ...), and only the answered
// attempt's latency counts. Anything else (a refused
// key, a malformed request) is final: the row says why and counts as wrong.
//
// Pure: the network, the clock and the pauses are handed in.

import type { Backend, BackendIo, Failure } from '../../hooks/decision/backend.ts'
import type { State } from '../../hooks/decision/system-one.ts'
import { LANGUAGES, type Language } from './datasets.ts'
import type { AnyItem, Ask, Sent, Settings, Suite } from './suite.ts'

export type RunOptions = {
  backend: Backend
  /** The backend's host: the network and its timers. */
  io: BackendIo
  /** A clock in milliseconds, for latency. */
  now: () => number
  /** Waits before asking again. */
  pause: (ms: number) => Promise<void>
  /** The mod's settings (settingsFrom). */
  settings: Settings
  variants: readonly string[]
  /** Both by default. */
  languages?: readonly Language[]
  /** How long one attempt may take. */
  timeoutMs: number
  /** Further attempts after a busy, network or timeout failure. */
  retries: number
  /** Requests in flight at once. */
  concurrency: number
  /** Called as each row is done (progress). */
  onRow?: (row: Row<unknown>, done: number, total: number) => void
  /** How many times every item is asked under each variant and language: 1 by default (`--repeat`, to see whether an answer is stable). */
  repeats?: number
}

/** One answer: an item in one language under one variant. */
export type Row<P> = {
  id: string
  language: Language
  variant: string
  ok: boolean
  prediction: P | null
  /** The suite's text for the prediction (`show`). */
  shown: string | null
  correct: boolean
  exact: boolean
  /** Which way a wrong answer missed, in the suite's words. */
  miss: string | null
  /** Each part of the answer right or wrong, for a suite that grades parts (Grade.parts); null without an answer. */
  parts?: Readonly<Record<string, boolean>> | null
  /** Why there was no prediction. */
  failure: string | null
  /** The suite's reading of the answer (for effort: each level's probability and the confidence). */
  detail: Readonly<Record<string, unknown>> | null
  /** Latency of the answered attempts, summed over the item's requests; null when unanswered. */
  ms: number | null
  /** Requests sent for the item, each counted once however often it was tried (more than one where a suite asks again: the skill suite's second stage). */
  requests?: number
  attempts: number
  inputTokens: number | null
  /** The model that answered, as the response named it. */
  model: string | null
  /** The state of the item's first request (what the decision model read). */
  state: State | null
  /** Which time the item was asked (1-based), only in a run that asked more than once (`repeats`). */
  repeat?: number
}

/** The rows of each time the run asked, in order: a run that asked once (rows with no `repeat`) is one time. */
export function byRepeat<P>(rows: readonly Row<P>[]): Row<P>[][] {
  const times = new Map<number, Row<P>[]>()
  for (const row of rows) times.set(row.repeat ?? 1, [...(times.get(row.repeat ?? 1) ?? []), row])
  return [...times.entries()].sort(([a], [b]) => a - b).map(([, own]) => own)
}

/**
 * A state in a few lines, for a result file that need not keep what the decision model read word for word (a suite sets
 * `digestState`): the fields that are short stay as they are; the conversation becomes its size, its number of lines and
 * the start of its first and of its last, so that what a request held of it can still be told (a state of 100000 tokens
 * is hundreds of kilobytes a request).
 */
export function stateDigest(state: State | null): Record<string, unknown> | null {
  if (state === null) return null
  const { recent_context: conversation, ...rest } = state as Record<string, unknown>
  if (typeof conversation !== 'string') return { ...rest }
  const lines = conversation === '' ? [] : conversation.split('\n')
  return { ...rest, recent_context: { chars: conversation.length, lines: lines.length, first: (lines[0] ?? '').slice(0, 160), last: (lines.at(-1) ?? '').slice(0, 160) } }
}

/** The failures worth asking again: the backend was busy, the connection dropped, or the answer was slow. */
export const TRANSIENT: readonly Failure['kind'][] = ['busy', 'network', 'timeout']

/**
 * How long one attempt may take unless the person says: four times the mod's
 * timeoutMs, at least 10 s, so that a slow answer is still measured (and a
 * cold connection's first request does not fail outright); the summary counts
 * the answers that came later than the mod would have waited.
 */
export function attemptMs(modTimeoutMs: number): number {
  return Math.max(10_000, 4 * modTimeoutMs)
}

/** What asking again needs: the backend and its host, how long an attempt may take, how often to retry, the clock and the pause. */
export type Retrying = { backend: Backend; io: BackendIo; timeoutMs: number; retries: number; now: () => number; pause: (ms: number) => Promise<void> }

/** The most a `Retry-After` is waited for: a backend that asks for an hour is not waited on, the request is asked again after this and fails if it is still refused. */
export const RETRY_AFTER_MAX_MS = 60_000

/**
 * One request, asked again after a busy, network or timeout failure up to
 * `retries` more times: the answered (or last) attempt's outcome, how long that
 * attempt took, and how many there were. The pause is what the backend asked for
 * when it said (a 429's `Retry-After`, `Failure.retryAfterMs`, at most
 * `RETRY_AFTER_MAX_MS`: asking again inside the window is refused again), else
 * 1 s, then 2 s, ...
 */
export async function askRetrying(request: Sent['request'], options: Retrying): Promise<Sent> {
  for (let attempt = 1; ; attempt++) {
    const started = options.now()
    const asked = await options.backend.ask(options.io, request, options.timeoutMs)
    const ms = options.now() - started
    if (asked.ok || attempt > options.retries || !TRANSIENT.includes(asked.failure.kind)) return { request, asked, ms, attempts: attempt }
    const asksFor = asked.failure.retryAfterMs
    await options.pause(asksFor === undefined ? 1000 * 2 ** (attempt - 1) : Math.min(asksFor, RETRY_AFTER_MAX_MS))
  }
}

export async function runSuite<I extends AnyItem, P>(suite: Suite<I, P>, items: readonly I[], options: RunOptions): Promise<Row<P>[]> {
  const languages = options.languages ?? LANGUAGES
  const repeats = options.repeats ?? 1
  if (!Number.isInteger(repeats) || repeats < 1) throw new RangeError(`repeats must be a whole number of 1 or more, not ${repeats}`)
  const tasks = items.flatMap((item) => options.variants.flatMap((variant) => languages.flatMap((language) => Array.from({ length: repeats }, (_, i) => ({ item, variant, language, repeat: repeats === 1 ? undefined : i + 1 })))))
  const rows: Row<P>[] = new Array(tasks.length)
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < tasks.length) {
      const at = next++
      const task = tasks[at] as (typeof tasks)[number]
      const row = await answer(suite, task.item, task.language, task.variant, options)
      rows[at] = task.repeat === undefined ? row : { ...row, repeat: task.repeat }
      options.onRow?.(rows[at] as Row<unknown>, ++done, tasks.length)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, tasks.length)) }, worker))
  return rows
}

/**
 * One item in one language under one variant, decided and graded. `send` asks one request: by default on its own, with retries;
 * the merged run (merge.ts) hands one that asks it together with the other requests of the same state.
 */
export async function answer<I extends AnyItem, P>(suite: Suite<I, P>, item: I, language: Language, variant: string, options: RunOptions, send: Ask = (request) => askRetrying(request, options)): Promise<Row<P>> {
  const sent: Sent[] = []
  const ask: Ask = async (request) => {
    const one = await send(request)
    sent.push(one)
    return one
  }
  const decided = await suite.decide(item, language, variant, ask, options.settings).catch((error: unknown): { ok: false; failure: string } => ({
    ok: false,
    failure: `request: ${error instanceof Error ? error.message : String(error)}`,
  }))
  const answered = sent.filter((one) => one.asked.ok)
  const base = {
    id: item.id,
    language,
    variant,
    requests: sent.length,
    attempts: sent.reduce((sum, one) => sum + one.attempts, 0),
    inputTokens: answered.some((one) => one.asked.ok && one.asked.inputTokens !== null)
      ? answered.reduce((sum, one) => sum + (one.asked.ok ? (one.asked.inputTokens ?? 0) : 0), 0)
      : null,
    model: answered.map((one) => (one.asked.ok ? one.asked.model : null)).find((model) => model !== null) ?? null,
    state: sent[0]?.request.state ?? null,
  }
  if (!decided.ok) {
    return { ...base, ok: false, prediction: null, shown: null, correct: false, exact: false, miss: null, parts: null, failure: decided.failure, detail: null, ms: null }
  }
  const grade = suite.grade(item, decided.prediction)
  return {
    ...base,
    ok: true,
    prediction: decided.prediction,
    shown: suite.show(decided.prediction),
    correct: grade.correct,
    exact: grade.exact,
    miss: grade.correct ? null : (grade.miss ?? null),
    parts: grade.parts ?? null,
    failure: null,
    detail: decided.detail ?? null,
    ms: answered.reduce((sum, one) => sum + one.ms, 0),
  }
}
