// Which decision model decides (#52, ADR 0006): pplx by default; Jev when `decisionModel` is jev, and as the way back for a
// person with a TypeSafe key and no Perplexity key (a 0.3.1 configuration). Seam 1 (engine events in; the requests the
// decision backend gets, and the board and the decision log out).
//
// The Perplexity key may be in the environment, which the mod reads at the session start (asynchronously), after every
// feature has registered: the tests with an environment key below also show that what the features took from the options
// when they registered is read again once the decision model is settled.

import { expect, test } from 'claude-code/testing'
import { jev, pplx, world, type Reply, type Sent } from './support/world.ts'

const PPLX_URL = 'https://api.perplexity.ai/v1/decisions'
const JEV_URL = 'https://api.typesafe.ai/v1/systemone'

/** Whichever of the two decision models the request is for answers it with `levels`. */
const either = (levels: readonly number[], extra: { key?: string } = {}) => (request: Sent): Reply => (request.url === PPLX_URL ? pplx(levels, extra)(request) : jev(levels)(request))

/** The decision log's entries that say the decision model changed. */
const fellBack = async (w: ReturnType<typeof world>) => (await w.board()).log.filter((entry) => entry.feature === 'decision-model')

// ---- the choice ----------------------------------------------------------------------------------

test('nothing set but a Perplexity key: pplx decides, and nothing says it fell back', { options: { perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, backend: pplx([0, 0, 1, 0, 0]) })
  await w.start()
  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step({ index: 0, effort: 'low' })

  expect(w.requests.map((request) => request.url)).toEqual([PPLX_URL])
  expect(w.requests[0]?.headers.authorization).toBe('Bearer pplx-test-key')
  expect(w.requests[0]?.body.model).toBe('pplx-decider-v1.1-27b')
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  expect(await fellBack(w)).toEqual([])
})

test('only a TypeSafe key, as a 0.3.1 configuration has it: Jev decides, and the decision log says why', { options: { typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, backend: either([0, 0, 1, 0, 0]) })
  await w.start()
  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step({ index: 0, effort: 'low' })

  expect(w.requests.map((request) => request.url)).toEqual([JEV_URL])
  expect(w.requests[0]?.headers.authorization).toBe('Bearer ts-test-key')
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  const [entry, ...more] = await fellBack(w)
  expect(more).toEqual([])
  expect(entry).toMatchObject({ tone: 'info', outcome: expect.stringContaining('Jev'), reason: expect.stringContaining('perplexityApiKey') })
  expect(entry?.reason).toContain('PERPLEXITY_API_KEY')
  expect(entry).toMatchObject({ outcome: '改用 Jev', reason: '没有 pplx 的密钥（perplexityApiKey 或环境变量 PERPLEXITY_API_KEY），改用 Jev；补上密钥就用 pplx，decisionModel 设成 Jev 则不再提示' })
  // The key itself is written nowhere.
  expect(JSON.stringify({ logs: w.logs, board: await w.board() })).not.toContain('ts-test-key')
})

test('a hot reload starts the session again: the fallback is in the decision log once', { options: { typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, backend: either([0, 0, 1, 0, 0]) })
  await w.start()
  await w.start()
  expect(await fellBack(w)).toHaveLength(1)
})

test('Jev answers with its own defaults when it is the way back: 1500 ms, not pplx\'s 8000', { options: { typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, backend: (request) => ({ after: 60_000, reply: either([0, 0, 1, 0, 0])(request) }) })
  await w.start()
  const submitting = w.submit('看看这个报错是怎么回事')
  await w.clock.settle()
  await w.clock.advance(1500)
  await submitting
  await w.step({ index: 0, effort: 'xhigh' })
  expect((await w.board()).main).toMatchObject({ routed: false, failure: { backend: 'jev', kind: 'timeout', detail: 'no answer in 1500 ms' } })
})

test('no key of either kind: nothing is sent, and the board names the Perplexity key as the one missing', { options: {} }, async ($, on) => {
  const w = world($, on, { session: true, env: {}, backend: either([0, 0, 1, 0, 0]) })
  await w.submit('解释一下这个函数做了什么')
  await w.step({ index: 0, effort: 'medium' })

  expect(w.requests).toHaveLength(0)
  expect(w.steps.map((s) => s.effort)).toEqual(['medium'])
  expect((await w.board()).main).toMatchObject({
    routed: false,
    why: 'pplx：没有填 perplexityApiKey 或 PERPLEXITY_API_KEY',
    failure: { backend: 'pplx', kind: 'config' },
  })
  expect(await fellBack(w)).toEqual([])
})

test('decisionModel jev is Jev even when a Perplexity key is there too', { options: { decisionModel: 'jev', typesafeApiKey: 'ts-test-key', perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, env: { PERPLEXITY_API_KEY: 'env-key' }, backend: either([0, 0, 1, 0, 0]) })
  await w.submit('解释一下这个函数做了什么')
  expect(w.requests.map((request) => request.url)).toEqual([JEV_URL])
  expect(await fellBack(w)).toEqual([])
})

test('decisionModel jev with no TypeSafe key is not routed, whatever Perplexity key there is: it names the TypeSafe key', { options: { decisionModel: 'jev', perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, env: {}, backend: either([0, 0, 1, 0, 0]) })
  await w.submit('解释一下这个函数做了什么')
  await w.step({ index: 0, effort: 'medium' })
  expect(w.requests).toHaveLength(0)
  expect((await w.board()).main).toMatchObject({ routed: false, why: 'jev：没有填 typesafeApiKey', failure: { backend: 'jev', kind: 'config' } })
})

test('decisionModel clef, left over from 0.3.x, reads as unset: pplx with a Perplexity key', { options: { decisionModel: 'clef', typesafeApiKey: 'ts-test-key', perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, env: {}, backend: either([0, 0, 1, 0, 0]) })
  await w.submit('解释一下这个函数做了什么')
  expect(w.requests.map((request) => request.url)).toEqual([PPLX_URL])
})

test('a misspelt decisionModel reads as unset too: only a TypeSafe key, so Jev', { options: { decisionModel: 'pplx-typo', typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, env: {}, backend: either([0, 0, 1, 0, 0]) })
  await w.submit('解释一下这个函数做了什么')
  expect(w.requests.map((request) => request.url)).toEqual([JEV_URL])
  expect(await fellBack(w)).toHaveLength(1)
})

test('decisionModel pplx without a Perplexity key falls back to Jev as well', { options: { decisionModel: 'pplx', typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, env: {}, backend: either([0, 0, 1, 0, 0]) })
  await w.submit('解释一下这个函数做了什么')
  expect(w.requests.map((request) => request.url)).toEqual([JEV_URL])
})

// ---- the key in the environment, read after the features registered --------------------------------

test('a TypeSafe key in the options and a Perplexity key only in the environment: pplx decides, with no fallback to record', { options: { typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, { env: { PERPLEXITY_API_KEY: 'env-key' }, backend: either([0, 0, 1, 0, 0], { key: 'env-key' }) })
  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step({ index: 0, effort: 'low' })

  expect(w.requests.map((request) => request.url)).toEqual([PPLX_URL])
  expect(w.requests[0]?.headers.authorization).toBe('Bearer env-key')
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  expect(await fellBack(w)).toEqual([])
})

// `pplxQps: 50` below: this test is about the settings, not the 1 QPS of a Tier 0 account (pplx-rate.test.ts).
test('with the key from the environment the features run on pplx\'s settings, not on what they took before it was read: a step waits 6000 ms for a re-decision', { options: { typesafeApiKey: 'ts-test-key', rejudgeEvery: 2, pplxQps: 50 } }, async ($, on) => {
  const working = (index: number) => ({ index, answer: `step ${index}`, tools: [{ tool: 'Read', input: { file_path: `/repo/src/f${index}.ts` } }] })
  const w = world($, on, {
    env: { PERPLEXITY_API_KEY: 'env-key' },
    backend: (request) => {
      const midturn = Object.keys(request.body.questions).includes('midturn.level')
      const reply = either(midturn ? [0, 0, 0.1, 0.8, 0.1] : [0, 1, 0, 0, 0])(request)
      return midturn ? { after: 5000, reply } : reply
    },
  })
  await w.submit('把这个死锁查清楚')
  await w.step(working(0))
  await w.step(working(1))

  // Jev's 300 ms would have gone on at medium; pplx's 6000 ms waits for the 5 s answer.
  const waiting = w.step(working(2))
  await w.clock.settle()
  await w.clock.advance(5000)
  await waiting
  expect(w.requests.every((request) => request.url === PPLX_URL)).toBe(true)
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'xhigh'])
})

test("with the key from the environment a dispatched agent's max needs pplx's 0.47, not Jev's 0.5", { options: { typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, {
    env: { PERPLEXITY_API_KEY: 'env-key' },
    backend: (request) => {
      const reply = pplx([0, 0, 0.2, 0.32, 0.48])(request)
      if (!('body' in reply) || typeof reply.body !== 'object' || reply.body === null) return reply
      // The model question is a choice: opus.
      const answers = (reply.body as { answers: Record<string, { type: string; choice?: string; probabilities?: Record<string, number> }> }).answers
      const asked = request.body.questions as Record<string, { type: string; criteria?: Record<string, unknown> }>
      for (const [id, question] of Object.entries(asked)) {
        if (question.type !== 'choice') continue
        const options = Object.keys(question.criteria ?? {})
        answers[id] = { type: 'choice', choice: 'opus', probabilities: Object.fromEntries(options.map((option) => [option, option === 'opus' ? 1 : 0])) }
      }
      return reply
    },
  })
  const started = await w.spawn({ prompt: 'Find the cause of the deadlock in the scheduler and fix it.', description: 'Fix the deadlock' })
  await w.step({ index: 0, turnId: 'sub-1', agentId: started.agentId, model: 'claude-opus-5-5', effort: 'medium' })
  expect(w.steps.map((s) => s.effort)).toEqual(['max'])
})

test('pplx chosen by the key from the environment is still paced at pplxQps (1 a second by default); Jev, the way back, is not', { options: { typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, { env: { PERPLEXITY_API_KEY: 'env-key' }, backend: either([0, 1, 0, 0, 0]) })
  await w.submit('先看看这个函数')
  const second = w.submit('再看看另一个函数')
  await w.clock.settle()
  expect(w.requests).toHaveLength(1)
  await w.clock.advance(1000)
  await second
  expect(w.requests.map((request) => request.url)).toEqual([PPLX_URL, PPLX_URL])
})

test('Jev as the way back is not paced: two messages at once send two requests at once', { options: { typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, { env: {}, backend: either([0, 1, 0, 0, 0]) })
  await Promise.all([w.submit('先看看这个函数'), w.submit('再看看另一个函数')])
  expect(w.requests.map((request) => request.url)).toEqual([JEV_URL, JEV_URL])
})
