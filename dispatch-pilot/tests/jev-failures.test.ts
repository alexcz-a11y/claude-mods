// What Jev's failed requests come to (decision/backend.ts `httpFailure`, `readPosted`, `withoutKey`): the kind of each status,
// the `Retry-After` a 429 or a 529 carries (jev-rate.ts waits for it), and the key kept out of the detail. Seam 2: the
// backend's `ask` over a fake network.

import { expect, test } from 'claude-code/testing'
import type { BackendIo } from '../hooks/decision/backend.ts'
import { JEV_MODEL, jevBackend } from '../hooks/decision/jev.ts'
import type { DecisionRequest } from '../hooks/decision/system-one.ts'

const KEY = 'ts-test-key-1234567890'

const REQUEST: DecisionRequest = { state: { c: 'x' }, questions: { done: { type: 'noul', instructions: 'Is it done?' } } }

/** A network that answers every request with `status`, `text` and `headers`. */
function replying(status: number, text: string, headers: Record<string, string> = {}): BackendIo {
  return {
    fetch: async () => ({ ok: status >= 200 && status < 300, status, headers, text }),
    sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))),
  }
}

const failureOf = async (io: BackendIo) => {
  const asked = await jevBackend(KEY).ask(io, REQUEST, 1500)
  if (asked.ok) throw new Error('answered')
  return asked.failure
}

test('an account out of credits (402, as TypeSafe answers it) is a quota failure, not an error of the mod', async () => {
  const failure = await failureOf(replying(402, JSON.stringify({ error_type: 'billing_error', message: 'Your organization has no available TypeSafe API credits.' })))
  expect(failure).toMatchObject({ kind: 'quota', status: 402, detail: expect.stringContaining('no available TypeSafe API credits') })
})

test('a 429 and a 529 carry the Retry-After they were given, in ms; any other busy status does not', async () => {
  expect(await failureOf(replying(429, 'slow down', { 'retry-after': '2' }))).toMatchObject({ kind: 'busy', status: 429, retryAfterMs: 2000 })
  expect(await failureOf(replying(529, 'overloaded', { 'Retry-After': '1' }))).toMatchObject({ kind: 'busy', status: 529, retryAfterMs: 1000 })
  expect((await failureOf(replying(429, 'slow down'))).retryAfterMs).toBeUndefined()
  const unavailable = await failureOf(replying(503, 'unavailable', { 'retry-after': '2' }))
  expect(unavailable).toMatchObject({ kind: 'busy', status: 503 })
  expect(unavailable.retryAfterMs).toBeUndefined()
})

test('a refused key (401) is a config failure, and the key is not in its detail where the API echoes it', async () => {
  const failure = await failureOf(replying(401, `bad key ${KEY}`))
  expect(failure).toMatchObject({ kind: 'config', status: 401 })
  expect(failure.detail).not.toContain(KEY)
  expect(failure.detail).toContain('[REDACTED]')
})

test('a 2xx that is not JSON, or holds no answers, is a parse failure with the start of the body', async () => {
  expect(await failureOf(replying(200, '<html>welcome</html>'))).toEqual({ kind: 'parse', detail: 'not JSON: <html>welcome</html>' })
  expect(await failureOf(replying(200, JSON.stringify({ model: JEV_MODEL })))).toMatchObject({ kind: 'parse', detail: expect.stringMatching(/^no answers: /) })
})
