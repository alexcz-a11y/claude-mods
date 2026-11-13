// Drex Max v1.1, the default decision model (ADR 0026): what the mod sends Nace and how it reads what comes back. The request
// and the answers are Jev's (System One); only where it goes, the key and the pinned model differ, and it is sent no images.

import { expect, test } from 'claude-code/testing'
import { BACKEND_DEFAULTS, DEFAULT_BACKEND, naceKey, readConfig, setup } from '../hooks/core/setup.ts'
import { failureLine, type BackendIo } from '../hooks/decision/backend.ts'
import { DREX_MODEL, DREX_URL, drexBackend } from '../hooks/decision/drex.ts'
import { TYPESAFE_GUIDE } from '../hooks/decision/guides.ts'
import { imageRef } from '../hooks/decision/images.ts'
import type { DecisionRequest } from '../hooks/decision/system-one.ts'

const REQUEST: DecisionRequest = { state: { user_message: 'rename the helper' }, questions: { 'effort.level': { type: 'noul', instructions: 'Is it hard?' } } }

type HttpInit = Parameters<BackendIo['fetch']>[1]

/** A network that answers every request with `status` and `body`, keeping what it was sent. */
function network(status: number, body: unknown, headers: Record<string, string> = {}): { io: BackendIo; sent: { url: string; init: HttpInit }[] } {
  const sent: { url: string; init: HttpInit }[] = []
  return {
    sent,
    io: {
      fetch: async (url, init) => {
        sent.push({ url, init })
        return { status, ok: status >= 200 && status < 300, headers, text: typeof body === 'string' ? body : JSON.stringify(body) }
      },
      sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))),
    },
  }
}

test("a request goes to Nace as Jev's goes to TypeSafe: the same body under the pinned model, the key as a Bearer token, no other header", async () => {
  // What Drex answered a three-question request on 2026-11-13: a Noul carries a confidence, and the top level a time and a request id.
  const { io, sent } = network(200, { model: 'drex-max-v1.1', answers: { 'effort.level': { type: 'noul', noul: 0.9937, confidence: 0.9937 } }, usage: { input_tokens: 178, output_tokens: 343 }, evaluation_time_ms: 188.9, request_id: 'req_x' })
  const asked = await drexBackend('nace_sk_test').ask(io, REQUEST, 1000)
  expect(asked).toEqual({ ok: true, model: 'drex-max-v1.1', answers: { 'effort.level': { type: 'noul', noul: 0.9937, confidence: 0.9937 } }, inputTokens: 178 })
  expect(sent).toHaveLength(1)
  expect(sent[0]?.url).toBe(DREX_URL)
  expect(sent[0]?.init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer nace_sk_test' })
  expect(JSON.parse(String(sent[0]?.init.body))).toEqual({ model: DREX_MODEL, state: REQUEST.state, questions: REQUEST.questions })
})

test('without a key nothing is sent, and the board names the option and the variable to fill', async () => {
  const { io, sent } = network(200, {})
  const backend = drexBackend(() => '')
  expect(backend.configured).toBe(false)
  const asked = await backend.ask(io, REQUEST, 1000)
  expect(sent).toHaveLength(0)
  expect(asked).toMatchObject({ ok: false, failure: { kind: 'config' } })
  if (!asked.ok) expect(failureLine('drex', asked.failure)).toBe('drex：没有填 naceApiKey 或 NACE_API_KEY')
})

test('images and Box questions are not sent to it: they are Jev\'s', async () => {
  const { io, sent } = network(200, {})
  const withImage: DecisionRequest = { state: { screenshot: imageRef('screenshot') }, questions: REQUEST.questions, images: [{ name: 'screenshot', format: 'png', base64: 'AAAA', width: 400, height: 400 }] }
  expect(await drexBackend('k').ask(io, withImage, 1000)).toMatchObject({ ok: false, failure: { kind: 'request', detail: expect.stringContaining('they go to Jev') } })
  expect(await drexBackend('k').ask(io, { state: {}, questions: { where: { type: 'box', instructions: 'the button' } } }, 1000)).toMatchObject({ ok: false, failure: { kind: 'request', detail: expect.stringContaining('no Box question') } })
  expect(sent).toHaveLength(0)
})

test("Nace's errors read as every model's do: a refused key, credits used up, its rate limit said as one, and the key never in the detail", async () => {
  const refused = await drexBackend('nace_sk_secret').ask(network(401, { error: { type: 'authentication_error', message: 'Invalid API key nace_sk_secret' }, request_id: 'req_x' }).io, REQUEST, 1000)
  expect(refused).toMatchObject({ ok: false, failure: { kind: 'config', status: 401 } })
  if (!refused.ok) expect(refused.failure.detail).not.toContain('nace_sk_secret')
  expect(await drexBackend('k').ask(network(402, { error: { type: 'insufficient_credit', message: 'no funds' } }).io, REQUEST, 1000)).toMatchObject({ ok: false, failure: { kind: 'quota', status: 402 } })
  const limited = await drexBackend('k').ask(network(429, { error: { type: 'rate_limit_error', message: 'Too many concurrent requests for this account.' } }, { 'retry-after': '2' }).io, REQUEST, 1000)
  expect(limited).toMatchObject({ ok: false, failure: { kind: 'busy', status: 429 } })
  if (!limited.ok) expect(failureLine('drex', limited.failure)).toBe('drex：被限速（状态码 429）')
  expect(await drexBackend('k').ask(network(529, { error: { type: 'overloaded', message: 'busy' } }).io, REQUEST, 1000)).toMatchObject({ ok: false, failure: { kind: 'busy', status: 529 } })
})

test("it is the default, asked and read as Jev is (the eval's request), with a longer wait; its key comes from the options first, then the environment", () => {
  expect(DEFAULT_BACKEND).toBe('drex')
  const ctx = setup({})
  expect([ctx.backend.name, ctx.backend.configured, ctx.config.backend]).toEqual(['drex', false, 'drex'])
  ctx.secrets.naceEnvKey = 'env-key'
  expect(ctx.backend.configured).toBe(true)
  expect(naceKey(readConfig({ naceApiKey: ' opt-key ' }), ctx.secrets)).toBe('opt-key')
  // The key is no part of a config written out.
  expect(JSON.stringify(readConfig({ naceApiKey: 'opt-key' }))).not.toContain('opt-key')
  const { drex, jev } = BACKEND_DEFAULTS
  expect(drex.guide).toBe(TYPESAFE_GUIDE)
  expect([drex.ask, drex.contextByKind, drex.contextTokens, drex.contextTokensMax, drex.agentLanes]).toEqual([jev.ask, jev.contextByKind, jev.contextTokens, jev.contextTokensMax, jev.agentLanes])
  expect([ctx.config.timeoutMs, ctx.config.longWaitMs, ctx.config.skills.secondStageMs, ctx.config.agents.waitMs]).toEqual([2500, null, 1000, 5000])
})
