// One question round to a decision model: Drex by default, Jev as the other backend, and on a
// failure (when fallback is on and both keys are set) the other one, once. I/O comes in as `io`,
// so this file never touches $. Every failure is a value, never a throw: the caller fails open.
import type { Config } from './config.ts'
import type { Question } from './questions.ts'
import { fitState } from './statebuild.ts'

export const DREX_URL = 'https://console.nace.ai/v1/systemone'
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'

export type Io = {
  fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ status: number; ok: boolean; headers: Record<string, string>; text: string }>
  /** Resolves after ms; rejects once signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
  now(): Promise<number>
}

export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; probabilities: number[] }
  | { type: 'choice'; choice: string; probabilities: Record<string, number> }

export type Failure = 'no-key' | 'timeout' | 'http' | 'network' | 'bad-answer' | 'model-mismatch'
export type Backend = 'drex' | 'jev'
/** One failed attempt. requestId is the service's; the error body is never kept (it may echo the state). */
export type Miss = { reason: Failure; backend: Backend; status?: number; requestId?: string }

/** firstFailure: set when the other backend was asked, saying why the first did not answer. */
export type AskResult =
  | { ok: true; answers: Record<string, Answer>; model: string; backend: Backend; ms: number; firstFailure?: Miss }
  | ({ ok: false; ms: number; firstFailure?: Miss } & Miss)

type Got = { answers: Record<string, Answer>; model: string }

const keyOf = (cfg: Config, b: Backend): string => (b === 'drex' ? cfg.drexApiKey : cfg.jevApiKey)

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isProbability(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
}

// Probabilities keyed by exactly the given keys, each a number in 0..1; null otherwise.
function probabilities(v: unknown, keys: string[]): Record<string, number> | null {
  if (!isRecord(v) || Object.keys(v).length !== keys.length) return null
  const out: Record<string, number> = {}
  for (const k of keys) {
    const p = v[k]
    if (!isProbability(p)) return null
    out[k] = p
  }
  return out
}

function readAnswer(a: unknown, q: Question): Answer | null {
  if (!isRecord(a) || a.type !== q.type) return null
  if (q.type === 'noul') return isProbability(a.noul) ? { type: 'noul', noul: a.noul } : null
  if (q.type === 'score') {
    // Keyed by level number as a string ("0", "1", ...); one entry per level the question has.
    const levels = q.criteria.map((_, i) => String(i))
    const p = probabilities(a.probabilities, levels)
    if (!p || typeof a.score !== 'number' || !Number.isFinite(a.score)) return null
    return { type: 'score', score: a.score, probabilities: levels.map((k) => p[k]!) }
  }
  const options = Object.keys(q.criteria)
  const p = probabilities(a.probabilities, options)
  if (!p || typeof a.choice !== 'string' || !options.includes(a.choice)) return null
  return { type: 'choice', choice: a.choice, probabilities: p }
}

// Every question asked must come back with its type; answers to questions not asked are dropped.
function readAnswers(v: unknown, questions: Record<string, Question>): Record<string, Answer> | null {
  if (!isRecord(v)) return null
  const out: Record<string, Answer> = {}
  for (const [id, q] of Object.entries(questions)) {
    const a = readAnswer(v[id], q)
    if (!a) return null
    out[id] = a
  }
  return out
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// Drex puts request_id in the body; Jev sends it as a header.
function requestIdOf(body: unknown, headers: Record<string, string>): string | undefined {
  if (isRecord(body) && typeof body.request_id === 'string') return body.request_id
  const h = headers['x-typesafe-request-id']
  return typeof h === 'string' && h !== '' ? h : undefined
}

function miss(reason: Failure, backend: Backend, status?: number, requestId?: string): Miss {
  const m: Miss = { reason, backend }
  if (status !== undefined) m.status = status
  if (requestId !== undefined) m.requestId = requestId
  return m
}

type Raced = { kind: 'reply'; reply: Awaited<ReturnType<Io['fetch']>> } | { kind: 'network' } | { kind: 'timeout' }

async function attempt(io: Io, cfg: Config, backend: Backend, req: { state: unknown; questions: Record<string, Question> }, endAt: number): Promise<Got | Miss> {
  const left = endAt - (await io.now())
  if (left <= 0) return miss('timeout', backend)
  const model = backend === 'drex' ? cfg.drexModel : cfg.jevModel
  const init = {
    method: 'POST',
    headers: { authorization: 'Bearer ' + keyOf(cfg, backend), 'content-type': 'application/json' },
    body: JSON.stringify({ model, state: req.state, questions: req.questions }),
  }
  const stop = new AbortController()
  let sent: Promise<Raced>
  let timer: Promise<Raced>
  try {
    sent = io.fetch(backend === 'drex' ? DREX_URL : JEV_URL, init).then((reply): Raced => ({ kind: 'reply', reply }), (): Raced => ({ kind: 'network' }))
  } catch {
    sent = Promise.resolve({ kind: 'network' })
  }
  try {
    // A sleep that rejects on its own (not by our abort) also ends the wait: no time is left to rely on.
    timer = io.sleep(left, stop.signal).then((): Raced => ({ kind: 'timeout' }), (): Raced => ({ kind: 'timeout' }))
  } catch {
    timer = Promise.resolve({ kind: 'timeout' })
  }
  const raced = await Promise.race([sent, timer])
  // The losing sleep must not linger; a losing fetch cannot be cancelled (io.fetch takes no signal).
  stop.abort()
  if (raced.kind !== 'reply') return miss(raced.kind, backend)
  const { reply } = raced
  const body = parse(reply.text)
  const requestId = requestIdOf(body, reply.headers)
  if (!reply.ok) return miss('http', backend, reply.status, requestId)
  if (!isRecord(body) || typeof body.model !== 'string') return miss('bad-answer', backend, undefined, requestId)
  // Drex is pinned to a fixed version; Jev is asked by alias and answers with the version it resolved to.
  if (backend === 'drex' && body.model !== cfg.drexModel) return miss('model-mismatch', backend, undefined, requestId)
  const answers = readAnswers(body.answers, req.questions)
  if (!answers) return miss('bad-answer', backend, undefined, requestId)
  return { answers, model: body.model }
}

export async function ask(io: Io, cfg: Config, req: { state: unknown; questions: Record<string, Question> }, deadlineMs: number): Promise<AskResult> {
  const first = cfg.backend
  try {
    const start = await io.now()
    const endAt = start + deadlineMs
    const since = async (): Promise<number> => (await io.now()) - start
    if (!keyOf(cfg, first)) return { ok: false, ...miss('no-key', first), ms: await since() }
    const sendable = { state: fitState(req.state), questions: req.questions }
    const a = await attempt(io, cfg, first, sendable, endAt)
    if ('answers' in a) return { ok: true, ...a, backend: first, ms: await since() }
    const other: Backend = first === 'drex' ? 'jev' : 'drex'
    // The other backend is asked once, only when both keys are set (design 5.7) and time is left.
    if (!cfg.fallback || !keyOf(cfg, other) || (await io.now()) >= endAt) return { ok: false, ...a, ms: await since() }
    const b = await attempt(io, cfg, other, sendable, endAt)
    const ms = await since()
    return 'answers' in b ? { ok: true, ...b, backend: other, ms, firstFailure: a } : { ok: false, ...b, ms, firstFailure: a }
  } catch {
    // Only io itself can throw here (the clock); fail open all the same.
    return { ok: false, ...miss('network', first), ms: 0 }
  }
}
