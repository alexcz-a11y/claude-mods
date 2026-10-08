// The rate limit on pplx requests (#51, ADR 0006): a Tier 0 Perplexity account takes 1 request a second, and one message sends
// two or three (the effort question, the skills' two stages), so the mod queues them itself (`pplxQps`), effort first, and
// when a 429 comes anyway it asks once more if what time is left allows. Seam 1 (engine events in, what reaches the decision
// backend and when, and the board, out) on the mock clock; the 429 and its `Retry-After` as the API sends them are seam 2
// (pplx.test.ts). Every test here sets `decisionModel: pplx`, which is not the default until #52.

import { expect, test } from 'claude-code/testing'
import { readConfig } from '../hooks/core/setup.ts'
import { pplx, rates, world, type Reply, type Sent, type SkillsWorld } from './support/world.ts'

const PPLX = { decisionModel: 'pplx', perplexityApiKey: 'pplx-test-key' }

const SKILLS: SkillsWorld = {
  commands: [{ name: 'tdd', description: 'Test-driven development. Use when the user wants to build features or fix bugs test-first.', source: 'user' }],
  listed: [{ name: 'tdd', source: 'userSettings', tokens: 52 }],
}

const ids = (request: Sent): string[] => Object.keys(request.body?.questions ?? {})
/** What each request asked, in the order it was sent, with when (mock ms from the start of the test). */
const timeline = (w: { requests: Sent[] }, from = 0) => w.requests.map((request) => [ids(request)[0], request.at - from])

/** pplx answering a message with skills: medium effort, `tdd` suggested. */
const answering = () => rates({ tdd: 0.8, '(none)': 0.2 }, { tdd: 0.9 }, [0, 1, 0, 0, 0], pplx)

test('one message sends its effort request at once and its skills request a second later: pplxQps 1 lets one request out a second', { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: answering(), skills: SKILLS })
  const start = w.clock.now()
  const submitting = w.submit('先写一个失败的测试')
  await w.clock.settle()
  expect(timeline(w, start)).toEqual([['effort.level', 0]])

  await w.clock.advance(1000)
  expect(timeline(w, start)).toEqual([['effort.level', 0], ['skills.which', 1000]])
  // The skills' second stage is a request too: one more second.
  await w.clock.advance(1000)
  await submitting
  expect(timeline(w, start)).toEqual([['effort.level', 0], ['skills.which', 1000], ['skills.fits.0', 2000]])
})

test('pplxQps 2 lets two requests out in the same second: the effort and the skills request go together, the second stage follows a second later', { options: { ...PPLX, pplxQps: 2 } }, async ($, on) => {
  const w = world($, on, { backend: answering(), skills: SKILLS })
  const submitting = w.submit('先写一个失败的测试')
  await w.clock.settle()
  expect(timeline(w)).toEqual([['effort.level', 0], ['skills.which', 0]])

  await w.clock.advance(1000)
  await submitting
  expect(timeline(w)).toEqual([['effort.level', 0], ['skills.which', 0], ['skills.fits.0', 1000]])
})

test("the effort request of a message goes before a skills request that was queued earlier: two messages at once, one place a second", { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: answering(), skills: SKILLS })
  const first = w.submit('先写一个失败的测试')
  await w.clock.settle()
  // The first message's effort request is out; its skills request waits for the next second. Now a second message comes.
  const second = w.submit('再补一个集成测试')
  await w.clock.settle()
  expect(timeline(w)).toEqual([['effort.level', 0]])

  await w.clock.advance(1000)
  // The second message's effort request goes first, though the first message's skills request has been waiting longer.
  const messages = (request: Sent) => String(request.body.state.user_message)
  expect(w.requests.map((request) => [ids(request)[0], messages(request), request.at])).toEqual([
    ['effort.level', '先写一个失败的测试', 0],
    ['effort.level', '再补一个集成测试', 1000],
  ])
  await w.clock.advance(1000)
  expect(timeline(w).slice(2)).toEqual([['skills.which', 2000]])
  await w.clock.advance(10_000)
  await Promise.all([first, second])
  expect(w.requests.map((request) => [ids(request)[0], request.at])).toEqual([
    ['effort.level', 0],
    ['effort.level', 1000],
    ['skills.which', 2000],
    ['skills.which', 3000],
    ['skills.fits.0', 4000],
    ['skills.fits.0', 5000],
  ])
})

test('Jev is not queued: the same message sends all its requests at once', { options: { typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.8, '(none)': 0.2 }, { tdd: 0.9 }, [0, 1, 0, 0, 0]), skills: SKILLS })
  await w.submit('先写一个失败的测试')
  expect(w.requests.map((request) => request.url)).toEqual(Array(3).fill('https://api.typesafe.ai/v1/systemone'))
  expect(w.requests.map((request) => request.at)).toEqual([0, 0, 0])
  expect(w.pplxRate()).toBeUndefined()
})

test('the send times are kept in $.state, so a hot reload goes on from them: a request that came a moment after the last one still waits out the second', { options: PPLX }, async ($, on) => {
  // An earlier load of the mod sent a request at 0 (the mock clock's start); the mod that loads now finds it in $.state.
  const w = world($, on, { backend: answering(), seed: { pplxRate: [0] } })
  const submitting = w.submit('先写一个失败的测试')
  await w.clock.settle()
  expect(w.requests).toHaveLength(0)

  await w.clock.advance(999)
  expect(w.requests).toHaveLength(0)
  await w.clock.advance(1)
  await submitting
  expect(timeline(w)).toEqual([['effort.level', 1000]])
  expect(w.pplxRate()).toEqual([1000])
})

test('a request that cannot be sent before its wait runs out is not held up for it: it fails at once, and the queue is part of the wait', { options: { ...PPLX, timeoutMs: 500 } }, async ($, on) => {
  const w = world($, on, { backend: answering(), skills: SKILLS })
  await w.submit('先写一个失败的测试')

  // The skills request would be sent at 1000, after the 500 ms it may take: it was never sent.
  expect(timeline(w)).toEqual([['effort.level', 0]])
  expect(w.logs.map((log) => log.text).filter((text) => text.includes('skills.which'))).toEqual([expect.stringContaining('to pplx: timeout: no answer in 500 ms')])
})

test('the time in the queue is taken from the request\'s own wait: a skills request sent at 1000 has what is left of 1500', { options: { ...PPLX, timeoutMs: 1500 } }, async ($, on) => {
  const w = world($, on, { backend: (request) => (ids(request).includes('skills.which') ? { after: 700, reply: answering()(request) } : answering()(request)), skills: SKILLS })
  const submitting = w.submit('先写一个失败的测试')
  await w.clock.settle()
  await w.clock.advance(1000)
  expect(timeline(w)).toEqual([['effort.level', 0], ['skills.which', 1000]])

  // 700 ms after the send is 1700, 200 past the wait of 1500 counted from the ask.
  await w.clock.advance(500)
  await submitting
  expect(w.logs.map((log) => log.text).filter((text) => text.includes('[skills.which]'))).toEqual([expect.stringContaining('to pplx: timeout: no answer in 1500 ms')])
})

test('a record that cannot be written lets the request out, and the debug log says the limit was not kept for it', { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: answering(), pplxRateContended: true })
  await w.submit('先写一个失败的测试')

  expect(timeline(w)).toEqual([['effort.level', 0]])
  expect(w.logs.map((log) => log.text).filter((text) => text.includes('[effort.level]'))).toEqual([expect.stringContaining('rate limit not kept (the record of sends could not be written after 8 tries)')])
})

// ---- a 429 ----------------------------------------------------------------------------------------

/** What the API sends when the account is over its limit, with the wait it asks for. */
const OVER = (retryAfter?: string): Reply => ({
  status: 429,
  headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  body: { error: { code: null, message: 'Request rate limit exceeded, please try again later.', param: null, type: 'too_many_requests' } },
})

/** The first request meets a 429, the rest are answered `levels`. */
const limitedOnce = (retryAfter: string | undefined, levels: readonly number[] = [0, 0, 1, 0, 0]) => (request: Sent, n: number): Reply => (n === 1 ? OVER(retryAfter) : pplx(levels)(request))

test('a 429 with Retry-After, and time enough left: the request waits as asked, asks once more, and the second answer is the one used', { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: limitedOnce('1') })
  const submitting = w.submit('把这个死锁查清楚')
  await w.clock.settle()
  expect(timeline(w)).toEqual([['effort.level', 0]])

  await w.clock.advance(1000)
  await submitting
  await w.step({ index: 0, effort: 'low' })
  expect(timeline(w)).toEqual([['effort.level', 0], ['effort.level', 1000]])
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  expect((await w.board()).main).toMatchObject({ effort: 'high', routed: true })
})

test('the retry is made once: a second 429 is the answer, shown as rate limited', { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: () => OVER('1') })
  const submitting = w.submit('把这个死锁查清楚')
  await w.clock.settle()
  await w.clock.advance(1000)
  await submitting
  await w.step({ index: 0, effort: 'medium' })

  expect(w.requests).toHaveLength(2)
  expect((await w.board()).main).toMatchObject({ effort: 'medium', routed: false, why: 'pplx：被限速（状态码 429）', failure: { backend: 'pplx', kind: 'busy', status: 429 } })
})

test('a 429 when the time left is short of the wait plus an ordinary request (5 s): no retry, the message goes unrouted and the board says rate limited', { options: { ...PPLX, timeoutMs: 5999 } }, async ($, on) => {
  const w = world($, on, { backend: limitedOnce('1') })
  await w.submit('把这个死锁查清楚')
  await w.step({ index: 0, effort: 'medium' })

  expect(w.requests).toHaveLength(1)
  expect(w.requests[0]?.at).toBe(0)
  expect((await w.board()).main).toMatchObject({
    effort: 'medium',
    routed: false,
    why: 'pplx：被限速（状态码 429）',
    failure: { backend: 'pplx', kind: 'busy', status: 429, detail: expect.stringContaining('retry after 1 s') },
  })
})

test('the time left only has to cover the wait and 5 s: 1 s asked of 6000 ms is retried', { options: { ...PPLX, timeoutMs: 6000 } }, async ($, on) => {
  const w = world($, on, { backend: limitedOnce('1') })
  const submitting = w.submit('把这个死锁查清楚')
  await w.clock.settle()
  await w.clock.advance(1000)
  await submitting
  expect(w.requests).toHaveLength(2)
})

test('a long wait is not waited for: Retry-After of 30 s is no retry within 8 s', { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: limitedOnce('30') })
  await w.submit('把这个死锁查清楚')
  expect(w.requests).toHaveLength(1)
  expect((await w.board()).main).toMatchObject({ routed: false, failure: { kind: 'busy', status: 429 } })
})

test('a 429 that says nothing of when to come back is not retried either', { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: limitedOnce(undefined) })
  await w.submit('把这个死锁查清楚')
  expect(w.requests).toHaveLength(1)
  expect((await w.board()).main).toMatchObject({ routed: false, why: 'pplx：被限速（状态码 429）' })
})

test('other failures are not retried: a 503 is the answer at once', { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: () => ({ status: 503, headers: { 'retry-after': '1' }, body: { error: { message: 'unavailable', type: 'server_error' } } }) })
  await w.submit('把这个死锁查清楚')
  expect(w.requests).toHaveLength(1)
  expect((await w.board()).main).toMatchObject({ routed: false, failure: { kind: 'busy', status: 503 } })
})

test('the retry takes a place like any request, and keeps its priority: a 429 that asks for no wait is asked again the next second, before the skills request', { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => (n === 1 ? OVER('0') : answering()(request)), skills: SKILLS })
  const submitting = w.submit('先写一个失败的测试')
  await w.clock.settle()
  expect(timeline(w)).toEqual([['effort.level', 0]])
  await w.clock.advance(1000)
  expect(timeline(w)).toEqual([['effort.level', 0], ['effort.level', 1000]])
  await w.clock.advance(1000)
  expect(timeline(w).slice(2)).toEqual([['skills.which', 2000]])
  await w.clock.advance(5000)
  await submitting
})

test('pplxQps is read within 1 to 50: a larger or smaller number reads as the nearest, and a word as 1', () => {
  expect([0, 1, 7.4, 50, 999].map((pplxQps) => readConfig({ pplxQps }).pplxQps)).toEqual([1, 1, 7, 50, 50])
  expect(readConfig({}).pplxQps).toBe(1)
  expect(readConfig({ pplxQps: 'fast' }).pplxQps).toBe(1)
})
