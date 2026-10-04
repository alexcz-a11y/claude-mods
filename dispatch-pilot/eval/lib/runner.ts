// Runs a suite: every item, in each language, under each variant, asked of
// one backend the way the mod asks it, and graded. One row per answer.
//
// The eval is a batch, not the mod's hot path: a busy backend, a dropped
// connection or a timeout is asked again after a pause (1 s, then 2 s, ...),
// and only the answered attempt's latency counts. Anything else (a refused
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
}

const TRANSIENT: readonly Failure['kind'][] = ['busy', 'network', 'timeout']

export async function runSuite<I extends AnyItem, P>(suite: Suite<I, P>, items: readonly I[], options: RunOptions): Promise<Row<P>[]> {
  const languages = options.languages ?? LANGUAGES
  const tasks = items.flatMap((item) => options.variants.flatMap((variant) => languages.map((language) => ({ item, variant, language }))))
  const rows: Row<P>[] = new Array(tasks.length)
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < tasks.length) {
      const at = next++
      const task = tasks[at] as (typeof tasks)[number]
      rows[at] = await answer(suite, task.item, task.language, task.variant, options)
      options.onRow?.(rows[at] as Row<unknown>, ++done, tasks.length)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, tasks.length)) }, worker))
  return rows
}

async function answer<I extends AnyItem, P>(suite: Suite<I, P>, item: I, language: Language, variant: string, options: RunOptions): Promise<Row<P>> {
  const sent: Sent[] = []
  const ask: Ask = async (request) => {
    for (let attempt = 1; ; attempt++) {
      const started = options.now()
      const asked = await options.backend.ask(options.io, request, options.timeoutMs)
      const ms = options.now() - started
      if (asked.ok || attempt > options.retries || !TRANSIENT.includes(asked.failure.kind)) {
        const one: Sent = { request, asked, ms, attempts: attempt }
        sent.push(one)
        return one
      }
      await options.pause(1000 * 2 ** (attempt - 1))
    }
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
