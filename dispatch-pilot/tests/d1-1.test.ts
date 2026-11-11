// d1.1, Liquid's newest decision model (ADR 0021): `decisionModel: d1.1` picks it. The backend and the guide are d1-ultra's
// (tests/d1-ultra.test.ts: the same API, answers read at Liquid's bars, agents routed by their tier), the model pinned to
// `d1.1`, and its own row of the defaults (core/setup.ts BACKEND_DEFAULTS: d1-ultra's budgets, the waits measured on
// 2026-11-10). The images still go to Jev; without a Liquid key nothing is sent. Pure modules first, then seam 1.

import { expect, test } from 'claude-code/testing'
import { BACKEND_DEFAULTS, readConfig, setup } from '../hooks/core/setup.ts'
import { failureLine } from '../hooks/decision/backend.ts'
import { D1_1_MODEL, LIQUID_URL, liquidBackend } from '../hooks/decision/liquid.ts'
import { jev, type Reply, type Sent, world } from './support/world.ts'

test("decisionModel d1.1: Liquid's guide and d1-ultra's budgets, its own waits; the images go to Jev with a TypeSafe key, never to Liquid", () => {
  const ctx = setup({ decisionModel: 'd1.1', liquidApiKey: 'liquid_k', typesafeApiKey: 'ts-k' })
  expect(ctx.config).toMatchObject({ backend: 'd1.1', guide: { name: 'liquid' }, longWaitMs: null })
  expect(ctx.backend.name).toBe('d1.1')
  expect(ctx.images?.name).toBe('jev')
  expect(setup({ decisionModel: 'd1.1', liquidApiKey: 'liquid_k' }).images).toBeNull()
  const own = readConfig({ decisionModel: 'd1.1' })
  const ultra = readConfig({ decisionModel: 'd1-ultra' })
  expect(BACKEND_DEFAULTS['d1.1'].guide).toBe(BACKEND_DEFAULTS['d1-ultra'].guide)
  // d1-ultra's budgets, though d1.1 reads 65,536 tokens a question: a state of 48000 took 4.6 s (DEVELOPMENT.md 「d1.1 的预算」).
  expect([own.context, own.contextByKind]).toEqual([ultra.context, ultra.contextByKind])
  expect(own.contextByKind).toEqual({ messagePlain: 24000, agent: 24000, workflow: 24000 })
  // A message waits 3500 ms, find_skill as long, the skills' second stage 1000 at least; an agent 7000 (its request and one ahead).
  expect([own.timeoutMs, own.skills.findWaitMs, own.skills.secondStageMs, own.agents.lanes, own.agents.waitMs]).toEqual([3500, 3500, 1000, 4, 7000])
  // The key is not enumerable: a config written out carries none.
  expect(JSON.stringify(readConfig({ decisionModel: 'd1.1', liquidApiKey: 'liquid_secret' }))).not.toContain('liquid_secret')
})

const io = (reply: () => { status: number; text: string; headers?: Record<string, string> }) => {
  const sent: { url: string; headers: Record<string, string>; body: string }[] = []
  return {
    sent,
    io: {
      fetch: async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
        sent.push({ url, headers: init.headers ?? {}, body: init.body ?? '' })
        const answer = reply()
        return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, headers: answer.headers ?? {}, text: answer.text }
      },
      sleep: () => new Promise<void>(() => {}),
    },
  }
}

test("the backend posts TypeSafe's request to Liquid, pinned to d1.1 and named so; no key sends nothing; a 429 is Liquid's rate limit", async () => {
  const request = { state: { user_message: 'hi' }, questions: { q: { type: 'noul' as const, instructions: 'Is it a greeting?' } } }
  const ok = io(() => ({ status: 200, text: JSON.stringify({ model: 'd1.1', answers: { q: { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 40, output_tokens: 0, cost: 0.0000008 } }) }))
  const backend = liquidBackend('liquid_k', { model: D1_1_MODEL })
  expect(backend.name).toBe('d1.1')
  expect(await backend.ask(ok.io as never, request, 1000)).toMatchObject({ ok: true, model: 'd1.1', inputTokens: 40 })
  expect(ok.sent[0]?.url).toBe(LIQUID_URL)
  expect(JSON.parse(ok.sent[0]?.body ?? '{}')).toEqual({ model: 'd1.1', state: request.state, questions: request.questions })

  const none = await liquidBackend('', { model: D1_1_MODEL }).ask(ok.io as never, request, 1000)
  expect(failureLine('d1.1', (none as unknown as { failure: never }).failure)).toBe('d1.1：没有填 liquidApiKey 或 LIQUID_API_KEY')
  expect(ok.sent).toHaveLength(1)

  const limited = await backend.ask(io(() => ({ status: 429, text: '{"error":{"type":"rate_limit_error"}}', headers: { 'retry-after': '1' } })).io as never, request, 1000)
  expect(limited).toMatchObject({ ok: false, failure: { kind: 'busy', status: 429, retryAfterMs: 1000 } })
  expect(failureLine('d1.1', (limited as unknown as { failure: never }).failure)).toBe('d1.1：被限速（状态码 429）')

  // Images are Jev's: a request with one is not sent, and says which model it was not sent to.
  const pictured = await backend.ask(ok.io as never, { ...request, images: [{ name: 'a', format: 'png', base64: 'AA==', width: 1, height: 1 }] }, 1000)
  expect(pictured).toMatchObject({ ok: false, failure: { kind: 'request', detail: 'd1.1 is asked no images here: they go to Jev' } })
})

// ---- seam 1 ----------------------------------------------------------------------------------------

const D1_1 = { decisionModel: 'd1.1', liquidApiKey: 'liquid_test' }

/** Liquid answering as the fake Jev does, its `model` d1.1's. */
const liquid = (levels: number[], nouls: Record<string, number> = {}) => (request: Sent): Reply => {
  const base = jev(levels, { nouls, confidence: 0.9 })(request) as { status: number; body: { model: string } }
  base.body.model = 'd1.1'
  return base
}

test("with d1.1 a message goes to Liquid as d1.1, its answers read at Liquid's bars: a stake at 0.75 is the band and lifts nothing", { options: D1_1 }, async ($, on) => {
  const w = world($, on, { backend: liquid([0, 1, 0, 0, 0], { 'effort.stakes.undo': 0.75 }) })
  await w.submit('把这张表的数据迁过去')
  await w.step({ index: 0 })
  expect(w.requests[0]?.url).toBe(LIQUID_URL)
  expect(w.requests[0]?.body.model).toBe('d1.1')
  expect(w.steps.map((s) => s.effort)).toEqual(['medium'])
  const entry = (await w.board()).log.find((one) => one.feature === 'main-effort')
  expect(entry?.trace?.find((step) => step.rule === 'stakes')).toMatchObject({ applied: false, floor: null, undoVerdict: 'band', yes: 0.8, no: 0.2, inclusive: false })
  expect(w.logs.map((log) => log.text)).toContainEqual(expect.stringMatching(/^request \[effort\.level, .*\] to d1\.1: answered in \d+ ms by d1\.1 /))
})

test('d1.1 without a Liquid key in the options or the environment: nothing is sent, and the board names both places', { options: { decisionModel: 'd1.1' } }, async ($, on) => {
  const w = world($, on, { session: true, env: {}, backend: liquid([0, 0, 1, 0, 0]) })
  await w.start()
  await w.submit('解释一下这个函数做了什么')
  await w.step({ index: 0, effort: 'medium' })
  expect(w.requests).toHaveLength(0)
  expect((await w.board()).main).toMatchObject({ routed: false, why: 'd1.1：没有填 liquidApiKey 或 LIQUID_API_KEY', failure: { backend: 'd1.1', kind: 'config' } })
  expect(w.logs.filter((log) => log.text.startsWith('d1.1 key:')).map((log) => log.text)).toEqual(['d1.1 key: not set'])
})

test('d1.1 takes its key from LIQUID_API_KEY when the option is empty', { options: { decisionModel: 'd1.1' } }, async ($, on) => {
  const w = world($, on, { session: true, env: { LIQUID_API_KEY: 'liquid_env' }, backend: liquid([0, 0, 1, 0, 0]) })
  await w.start()
  await w.submit('解释一下这个函数做了什么')
  expect(w.requests.map((request) => request.headers.authorization)).toEqual(['Bearer liquid_env'])
  expect(w.logs.map((log) => log.text)).toContain('d1.1 key: from LIQUID_API_KEY')
})
