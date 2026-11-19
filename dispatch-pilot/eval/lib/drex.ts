// One request to Drex for the calibration, through the mod's own ask() (it checks the answer's model and every
// question's type). Imports node: modules: neither the tests nor hooks/ import it. The key is read from NACE_API_KEY
// at the moment of the call and goes into no output, log line, error text or file.
import { ask } from '../../hooks/backend.ts'
import type { Io } from '../../hooks/backend.ts'
import { readConfig } from '../../hooks/config.ts'
import type { Question } from '../../hooks/questions.ts'
import type { Result } from './store.ts'

/** Each request's deadline: the client lower bound Nace's documentation asks for. */
export const TIMEOUT_MS = 60_000
// A fetch that ask() gave up on is cut off a little later, so it cannot keep the process alive.
const FETCH_LIMIT_MS = TIMEOUT_MS + 5_000

export const hasKey = (): boolean => (process.env.NACE_API_KEY ?? '').trim() !== ''

/** The raw reply, for the smoke checks: its status and its body parsed (undefined when not JSON). */
export type Reply = { status: number; body: unknown }

function nodeIo(onReply?: (r: Reply) => void): Io {
  return {
    async fetch(url, init) {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_LIMIT_MS) })
      const text = await res.text()
      if (onReply !== undefined) {
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          body = undefined
        }
        onReply({ status: res.status, body })
      }
      return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers.entries()), text }
    },
    sleep(ms, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new Error('aborted'))
        const timer = setTimeout(resolve, ms)
        signal.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('aborted'))), { once: true })
      })
    },
    now: async () => Date.now(),
  }
}

/** Asks Drex (drex-max-v1.1, no fallback: Jev is asked nothing) one request; every failure is a Result, never a throw. */
export async function askDrex(state: Record<string, unknown>, questions: Record<string, Question>, onReply?: (r: Reply) => void): Promise<{ result: Result; ms: number }> {
  const cfg = readConfig({ backend: 'drex', fallback: false, drexApiKey: process.env.NACE_API_KEY ?? '' })
  const r = await ask(nodeIo(onReply), cfg, { state, questions }, TIMEOUT_MS)
  if (r.ok) return { result: { ok: true, model: r.model, answers: r.answers }, ms: r.ms }
  const result: Result = { ok: false, reason: r.reason }
  if (r.status !== undefined) result.status = r.status
  if (r.requestId !== undefined) result.requestId = r.requestId
  return { result, ms: r.ms }
}
