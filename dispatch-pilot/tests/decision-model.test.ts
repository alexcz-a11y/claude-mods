// Which decision model decides (ADR 0014, before it ADR 0006): Jev by default; pplx only when `decisionModel` names it.
// Nothing falls back on the keys: without the chosen model's key nothing is sent, the turn goes out at the engine's effort,
// and the board names the key that is missing. Seam 1 (engine events in; the requests the decision backend gets, and the
// board and the decision log out).
//
// A key may be in the environment, which the mod reads at the session start (asynchronously), after every feature has
// registered: the tests with an environment key below show the chosen model takes it.

import { expect, test } from 'claude-code/testing'
import { jev, pplx, world, type Reply, type Sent } from './support/world.ts'

const PPLX_URL = 'https://api.perplexity.ai/v1/decisions'
const JEV_URL = 'https://api.typesafe.ai/v1/systemone'

/** Whichever of the two decision models the request is for answers it with `levels`. */
const either = (levels: readonly number[], extra: { key?: string } = {}) => (request: Sent): Reply => (request.url === PPLX_URL ? pplx(levels, extra)(request) : jev(levels)(request))

/** The decision log's entries about the decision model (the one that says images go to pplx is image-backend.test.ts's). */
const aboutTheModel = async (w: ReturnType<typeof world>) => (await w.board()).log.filter((entry) => entry.feature === 'decision-model' && entry.fallbackFor !== 'images')

// ---- the choice ----------------------------------------------------------------------------------

test('nothing set but a TypeSafe key: Jev decides, and nothing is said about the choice', { options: { typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, backend: either([0, 0, 1, 0, 0]) })
  await w.start()
  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step({ index: 0, effort: 'low' })

  expect(w.requests.map((request) => request.url)).toEqual([JEV_URL])
  expect(w.requests[0]?.headers.authorization).toBe('Bearer ts-test-key')
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  expect(await aboutTheModel(w)).toEqual([])
  // The key itself is written nowhere.
  expect(JSON.stringify({ logs: w.logs, board: await w.board() })).not.toContain('ts-test-key')
})

test('nothing set but a Perplexity key: nothing falls back to pplx; nothing is sent, the turn keeps the engine effort, and the board names the TypeSafe key', { options: { perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, env: {}, backend: either([0, 0, 1, 0, 0]) })
  await w.start()
  // A hot reload starts the session again: still nothing about the choice.
  await w.start()
  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step({ index: 0, effort: 'low' })

  expect(w.requests).toHaveLength(0)
  expect(w.steps.map((s) => s.effort)).toEqual(['low'])
  expect((await w.board()).main).toMatchObject({ routed: false, why: 'jev：没有填 typesafeApiKey 或 TYPESAFE_API_KEY', failure: { backend: 'jev', kind: 'config' } })
  expect(await aboutTheModel(w)).toEqual([])
})

test('Jev answers within its own defaults: 1500 ms, not pplx\'s 8000', { options: { typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, backend: (request) => ({ after: 60_000, reply: either([0, 0, 1, 0, 0])(request) }) })
  await w.start()
  const submitting = w.submit('看看这个报错是怎么回事')
  await w.clock.settle()
  await w.clock.advance(1500)
  await submitting
  await w.step({ index: 0, effort: 'xhigh' })
  expect((await w.board()).main).toMatchObject({ routed: false, failure: { backend: 'jev', kind: 'timeout', detail: 'no answer in 1500 ms' } })
})

test('no key of either kind: nothing is sent, and the board names the TypeSafe key as the one missing', { options: {} }, async ($, on) => {
  const w = world($, on, { session: true, env: {}, backend: either([0, 0, 1, 0, 0]) })
  await w.submit('解释一下这个函数做了什么')
  await w.step({ index: 0, effort: 'medium' })

  expect(w.requests).toHaveLength(0)
  expect(w.steps.map((s) => s.effort)).toEqual(['medium'])
  expect((await w.board()).main).toMatchObject({
    routed: false,
    why: 'jev：没有填 typesafeApiKey 或 TYPESAFE_API_KEY',
    failure: { backend: 'jev', kind: 'config' },
  })
  expect(await aboutTheModel(w)).toEqual([])
})

test('decisionModel pplx with a Perplexity key: pplx decides, though a TypeSafe key is there too', { options: { decisionModel: 'pplx', typesafeApiKey: 'ts-test-key', perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, env: {}, backend: either([0, 0, 1, 0, 0]) })
  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step({ index: 0, effort: 'low' })

  expect(w.requests.map((request) => request.url)).toEqual([PPLX_URL])
  expect(w.requests[0]?.headers.authorization).toBe('Bearer pplx-test-key')
  expect(w.requests[0]?.body.model).toBe('pplx-decider-v1.1-27b')
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
})

test('decisionModel pplx without a Perplexity key is not routed, whatever TypeSafe key there is: it names the Perplexity key', { options: { decisionModel: 'pplx', typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, env: {}, backend: either([0, 0, 1, 0, 0]) })
  await w.submit('解释一下这个函数做了什么')
  await w.step({ index: 0, effort: 'medium' })
  expect(w.requests).toHaveLength(0)
  expect((await w.board()).main).toMatchObject({ routed: false, why: 'pplx：没有填 perplexityApiKey 或 PERPLEXITY_API_KEY', failure: { backend: 'pplx', kind: 'config' } })
})

test('decisionModel jev is Jev even when a Perplexity key is there too', { options: { decisionModel: 'jev', typesafeApiKey: 'ts-test-key', perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, env: { PERPLEXITY_API_KEY: 'env-key' }, backend: either([0, 0, 1, 0, 0]) })
  await w.submit('解释一下这个函数做了什么')
  expect(w.requests.map((request) => request.url)).toEqual([JEV_URL])
})

test('decisionModel clef, left over from 0.3.x, reads as unset: Jev', { options: { decisionModel: 'clef', typesafeApiKey: 'ts-test-key', perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, env: {}, backend: either([0, 0, 1, 0, 0]) })
  await w.submit('解释一下这个函数做了什么')
  expect(w.requests.map((request) => request.url)).toEqual([JEV_URL])
})

test('a misspelt decisionModel reads as unset too: Jev, and nothing is said about it in the decision log', { options: { decisionModel: 'pplx-typo', typesafeApiKey: 'ts-test-key', perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, env: {}, backend: either([0, 0, 1, 0, 0]) })
  await w.submit('解释一下这个函数做了什么')
  expect(w.requests.map((request) => request.url)).toEqual([JEV_URL])
  expect(await aboutTheModel(w)).toEqual([])
})

// ---- the key in the environment, read after the features registered --------------------------------

test('decisionModel pplx with the Perplexity key only in the environment: pplx decides with it', { options: { decisionModel: 'pplx', typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, { env: { PERPLEXITY_API_KEY: 'env-key' }, backend: either([0, 0, 1, 0, 0], { key: 'env-key' }) })
  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step({ index: 0, effort: 'low' })

  expect(w.requests.map((request) => request.url)).toEqual([PPLX_URL])
  expect(w.requests[0]?.headers.authorization).toBe('Bearer env-key')
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
})

// `pplxQps: 50` below: this test is about the settings, not the 1 QPS of a Tier 0 account (pplx-rate.test.ts).
test("pplx with its key from the environment runs on pplx's settings: a message waits 8000 ms for its decision", { options: { decisionModel: 'pplx', pplxQps: 50 } }, async ($, on) => {
  const w = world($, on, { env: { PERPLEXITY_API_KEY: 'env-key' }, backend: (request) => ({ after: 5000, reply: either([0, 0, 0.1, 0.8, 0.1])(request) }) })
  // Jev's 1500 ms would have let the message in unrouted; pplx's 8000 ms waits for the 5 s answer.
  const submitting = w.submit('把这个死锁查清楚')
  await w.clock.settle()
  await w.clock.advance(5000)
  await submitting
  await w.step({ index: 0, effort: 'medium' })
  expect(w.requests.every((request) => request.url === PPLX_URL)).toBe(true)
  expect(w.steps.map((s) => s.effort)).toEqual(['xhigh'])
})

test('pplx with its key from the environment is paced at pplxQps (here 1 a second)', { options: { decisionModel: 'pplx', pplxQps: 1 } }, async ($, on) => {
  const w = world($, on, { env: { PERPLEXITY_API_KEY: 'env-key' }, backend: either([0, 1, 0, 0, 0]) })
  await w.submit('先看看这个函数')
  const second = w.submit('再看看另一个函数')
  await w.clock.settle()
  expect(w.requests).toHaveLength(1)
  await w.clock.advance(1000)
  await second
  expect(w.requests.map((request) => request.url)).toEqual([PPLX_URL, PPLX_URL])
})

test('Jev is not paced by pplxQps: two messages at once send two requests at once', { options: { typesafeApiKey: 'ts-test-key', pplxQps: 1 } }, async ($, on) => {
  const w = world($, on, { env: {}, backend: either([0, 1, 0, 0, 0]) })
  await Promise.all([w.submit('先看看这个函数'), w.submit('再看看另一个函数')])
  expect(w.requests.map((request) => request.url)).toEqual([JEV_URL, JEV_URL])
})
