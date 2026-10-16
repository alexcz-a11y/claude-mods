// Jev's pacing (decision/jev-rate.ts, 2026-10-15): an account may send so many requests and input tokens a second (the
// default plan's 80 and 100,000); the tokens come out of a bucket that holds BURST_SECONDS of the rate and fills at it. A
// 429 or 529 holds every request back as long as it says (at most MAX_HOLD_MS), and the refused one asks once more, in its
// old place in line, when its time allows. Seam 2: the pacing over a backend that records when each request reached it, on
// the mock clock.

import { expect, mock, test } from 'claude-code/testing'
import type { Asked, Backend, BackendIo } from '../hooks/decision/backend.ts'
import { BURST_SECONDS, JEV_DEFAULT_LIMITS, jevRateLimited, jevRequestTokens, MAX_HOLD_MS, type JevLimits } from '../hooks/decision/jev-rate.ts'
import type { DecisionRequest } from '../hooks/decision/system-one.ts'
import { JEV_MODEL } from '../hooks/decision/jev.ts'

type Clock = ReturnType<typeof mock.clock>

/** A request named `name` of about `chars` Chinese characters of state; the effort question of a message when `effort`. */
function request(name: string, chars: number, effort = false): DecisionRequest {
  const id = effort ? 'effort.level' : 'agent-0.model'
  return { state: { name, c: '会'.repeat(chars) }, questions: { [id]: { type: 'noul', instructions: 'Is it?' } } }
}

const answered = (inputTokens: number | null = null): Asked => ({ ok: true, answers: {}, model: JEV_MODEL, inputTokens })

/** A backend that records when each request reached it, and answers after `delayMs` as `answer` says. */
function recording(answer: (name: string, n: number) => Asked = () => answered(), delayMs = 0) {
  const calls: { name: string; at: number }[] = []
  const backend: Backend = {
    name: 'jev',
    configured: true,
    async ask(io, sent) {
      const name = String((sent.state as { name: string }).name)
      calls.push({ name, at: await (io.pace as NonNullable<BackendIo['pace']>).now() })
      if (delayMs > 0) await io.sleep(delayMs, new AbortController().signal)
      return answer(name, calls.length)
    },
  }
  return { backend, calls }
}

/** The host as a hook gives it, on the mock clock; the pplx cell is there but the Jev pacing does not use it. */
function hostOf(clock: Clock): BackendIo {
  return {
    fetch: async () => {
      throw new Error('no network in this test')
    },
    sleep: (ms, signal) =>
      new Promise<void>((done, fail) => {
        signal.addEventListener('abort', () => fail(new Error('aborted')))
        void clock.sleep(ms).then(done)
      }),
    pace: { now: async () => clock.now(), sentAt: { get: async () => ({ value: undefined, version: 0 }), set: async () => ({ isSet: true, version: 1 }) } },
  }
}

const paced = (backend: Backend, limits: JevLimits = JEV_DEFAULT_LIMITS) => jevRateLimited(backend, () => limits)

/** 1,000 tokens a second: the bucket holds 5,000 and fills one token a millisecond, so the waits below are whole numbers. */
const SLOW: JevLimits = { requestsPerSecond: 80, tokensPerSecond: 1000 }

test("the default plan's limits: 80 requests and 100,000 input tokens a second", () => {
  expect(JEV_DEFAULT_LIMITS).toEqual({ requestsPerSecond: 80, tokensPerSecond: 100_000 })
})

test('four long requests go out at once (the default plan: a burst of 500,000 tokens); a fifth waits until the bucket has filled what it lacks', async (_$, on) => {
  const clock = mock.clock(on)
  const { backend, calls } = recording()
  const jev = paced(backend)
  const long = (name: string) => request(name, 88_000)
  const size = jevRequestTokens(long('a'))
  // About 114,000 tokens each, as Jev would count the mod's 96000-token state: four fit the 500,000, five do not.
  const bucket = JEV_DEFAULT_LIMITS.tokensPerSecond * BURST_SECONDS
  expect(4 * size).toBeLessThanOrEqual(bucket)
  expect(5 * size).toBeGreaterThan(bucket)

  const io = hostOf(clock)
  const asking = ['a', 'b', 'c', 'd', 'e'].map((name) => jev.ask(io, long(name), 8000))
  await clock.settle()
  expect(calls.map((call) => [call.name, call.at])).toEqual([
    ['a', 0],
    ['b', 0],
    ['c', 0],
    ['d', 0],
  ])
  // What the fifth lacks, at 100 tokens a millisecond: about 720 ms.
  const lackMs = Math.ceil((5 * size - bucket) / 100)
  expect(lackMs).toBeLessThan(1000)
  await clock.advance(lackMs)
  expect(calls.at(-1)).toEqual({ name: 'e', at: lackMs })
  const answers = await Promise.all(asking)
  expect(answers.every((asked) => asked.ok)).toBe(true)
  // The one that waited says so in the debug log.
  expect(answers[4]?.notes).toEqual([`waited ${lackMs} ms for its place within the account's rate limit`])
})

test('a request is set right at what Jev says it cost: one that cost less gives the rest back, and who waits goes at once', async (_$, on) => {
  const clock = mock.clock(on)
  // Each answer says it cost 1,000 tokens, far under the planned 114,000.
  const { backend, calls } = recording(() => answered(1000), 300)
  const jev = paced(backend)
  const io = hostOf(clock)
  const asking = ['a', 'b', 'c', 'd', 'e'].map((name) => jev.ask(io, request(name, 88_000), 8000))
  await clock.settle()
  expect(calls.map((call) => call.name)).toEqual(['a', 'b', 'c', 'd'])
  // The four are answered at 300 ms and give back what they did not cost: the fifth goes then, not at about 720.
  await clock.advance(300)
  expect(calls.at(-1)).toEqual({ name: 'e', at: 300 })
  await clock.advance(300)
  await Promise.all(asking)
})

test('requests a second: with jevQps 2 the third request waits until a second has passed since the first', async (_$, on) => {
  const clock = mock.clock(on)
  const { backend, calls } = recording()
  const jev = paced(backend, { requestsPerSecond: 2, tokensPerSecond: 100_000 })
  const io = hostOf(clock)
  const asking = ['a', 'b', 'c'].map((name) => jev.ask(io, request(name, 10), 1500))
  await clock.settle()
  expect(calls.map((call) => [call.name, call.at])).toEqual([
    ['a', 0],
    ['b', 0],
  ])
  await clock.advance(1000)
  await Promise.all(asking)
  expect(calls.at(-1)).toEqual({ name: 'c', at: 1000 })
})

test("the effort question of a message goes first: an agent's request that was waiting for the bucket goes after it", async (_$, on) => {
  const clock = mock.clock(on)
  const { backend, calls } = recording()
  const jev = paced(backend, SLOW)
  const [firstOne, agentOne, effortOne] = [request('first', 2600), request('agent', 2600), request('effort', 2600, true)]
  const [first, agent, effort] = [firstOne, agentOne, effortOne].map(jevRequestTokens) as [number, number, number]
  // Any two fit the bucket of 5,000 only after a while.
  expect(first + Math.min(agent, effort)).toBeGreaterThan(5000)
  const io = hostOf(clock)
  const asking = [jev.ask(io, firstOne, 12_000)]
  await clock.settle()
  asking.push(jev.ask(io, agentOne, 12_000))
  await clock.advance(100)
  asking.push(jev.ask(io, effortOne, 12_000))
  await clock.settle()
  await clock.advance(10_000)
  await Promise.all(asking)
  // The effort question came later but goes first, once the bucket has filled what it lacked after the first request; the
  // agent's goes when the bucket has filled again.
  expect(calls.map((call) => [call.name, call.at])).toEqual([
    ['first', 0],
    ['effort', first + effort - 5000],
    ['agent', first + effort + agent - 5000],
  ])
})

test('a 429 holds every request back for its Retry-After, and the refused request asks once more when its time covers that and an answer', async (_$, on) => {
  const clock = mock.clock(on)
  const refused: Asked = { ok: false, failure: { kind: 'busy', status: 429, detail: 'HTTP 429: slow down', retryAfterMs: 2000 } }
  const { backend, calls } = recording((_name, n) => (n === 1 ? refused : answered()))
  const jev = paced(backend)
  const io = hostOf(clock)
  const first = jev.ask(io, request('first', 10), 8000)
  await clock.settle()
  // Another request after the 429: it waits until the account may ask again.
  const later = jev.ask(io, request('later', 10), 8000)
  await clock.settle()
  expect(calls.map((call) => [call.name, call.at])).toEqual([['first', 0]])
  await clock.advance(2000)
  const [again, other] = await Promise.all([first, later])
  // The refused one asks again first (it was in the queue before the other), the other right after it.
  expect(calls.map((call) => [call.name, call.at])).toEqual([
    ['first', 0],
    ['first', 2000],
    ['later', 2000],
  ])
  expect(again.ok && other.ok).toBe(true)
  expect(again.notes).toContain('HTTP 429, asked again after 2000 ms')
})

test('a 429 whose Retry-After the time left cannot cover fails as it is: busy, with no wait left in the failure the board keeps', async (_$, on) => {
  const clock = mock.clock(on)
  const refused: Asked = { ok: false, failure: { kind: 'busy', status: 429, detail: 'HTTP 429: slow down', retryAfterMs: 2000 } }
  const { backend, calls } = recording(() => refused)
  const jev = paced(backend)
  const asked = await jev.ask(hostOf(clock), request('alone', 10), 1500)
  expect(calls).toHaveLength(1)
  expect(asked).toEqual({ ok: false, failure: { kind: 'busy', status: 429, detail: 'HTTP 429: slow down' } })
})

test('a 429 without Retry-After holds the requests back a second, a 529 half a second; then the refused one asks again', async (_$, on) => {
  const clock = mock.clock(on)
  const over: Asked = { ok: false, failure: { kind: 'busy', status: 429, detail: 'HTTP 429: slow down' } }
  const overloaded: Asked = { ok: false, failure: { kind: 'busy', status: 529, detail: 'HTTP 529: overloaded' } }
  const { backend, calls } = recording((_name, n) => (n === 1 ? over : n === 3 ? overloaded : answered()))
  const jev = paced(backend)
  const io = hostOf(clock)
  const one = jev.ask(io, request('one', 10), 3000)
  await clock.settle()
  await clock.advance(1000)
  expect((await one).ok).toBe(true)
  const two = jev.ask(io, request('two', 10), 3000)
  await clock.settle()
  await clock.advance(500)
  expect((await two).ok).toBe(true)
  expect(calls.map((call) => [call.name, call.at])).toEqual([
    ['one', 0],
    ['one', 1000],
    ['two', 1000],
    ['two', 1500],
  ])
})

test('other failures are no reason to wait: a 503 is the answer at once, and the next request goes straight out', async (_$, on) => {
  const clock = mock.clock(on)
  const { backend, calls } = recording((_name, n) => (n === 1 ? { ok: false, failure: { kind: 'busy', status: 503, detail: 'HTTP 503' } } : answered()))
  const jev = paced(backend)
  const io = hostOf(clock)
  expect(await jev.ask(io, request('one', 10), 3000)).toEqual({ ok: false, failure: { kind: 'busy', status: 503, detail: 'HTTP 503' } })
  expect((await jev.ask(io, request('two', 10), 3000)).ok).toBe(true)
  expect(calls.map((call) => call.at)).toEqual([0, 0])
})

test('a request whose place cannot come within its own wait fails as a timeout, and is never sent', async (_$, on) => {
  const clock = mock.clock(on)
  const { backend, calls } = recording()
  const jev = paced(backend, SLOW)
  const io = hostOf(clock)
  // About 4,000 tokens each: the second lacks about 3,000, three seconds of filling.
  const first = jev.ask(io, request('first', 3070), 8000)
  await clock.settle()
  const late = jev.ask(io, request('late', 3070), 1500)
  await clock.settle()
  const asked = await late
  expect(asked).toEqual({ ok: false, failure: { kind: 'timeout', detail: 'no answer in 1500 ms' } })
  expect(calls.map((call) => call.name)).toEqual(['first'])
  await first
})

test('a request with less than 200 ms left is never sent: nothing could answer it in that time', async (_$, on) => {
  const clock = mock.clock(on)
  const { backend, calls } = recording()
  const asked = await paced(backend).ask(hostOf(clock), request('late', 10), 150)
  expect(asked).toEqual({ ok: false, failure: { kind: 'timeout', detail: 'no answer in 150 ms' } })
  expect(calls).toEqual([])
})

/** A refusal of the account: a 429 (or 529) that asks to wait `retryAfterMs`, or says nothing of it. */
const refusal = (retryAfterMs?: number, status = 429): Asked => ({ ok: false, failure: { kind: 'busy', status, detail: `HTTP ${status}: slow down`, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } })

test('the second 429, the one the retry meets, holds every request back too', async (_$, on) => {
  const clock = mock.clock(on)
  const { backend, calls } = recording((_name, n) => (n === 1 ? refusal(1000) : n === 2 ? refusal(3000) : answered()))
  const jev = paced(backend)
  const io = hostOf(clock)
  const first = jev.ask(io, request('first', 10), 8000)
  await clock.settle()
  await clock.advance(1000)
  // The retry is the answer, and it is a 429 too, with no retry of its own.
  expect(await first).toEqual({
    ok: false,
    failure: { kind: 'busy', status: 429, detail: 'HTTP 429: slow down' },
    notes: ['HTTP 429, asked again after 1000 ms', "waited 1000 ms for its place within the account's rate limit"],
  })

  const later = jev.ask(io, request('later', 10), 8000)
  await clock.settle()
  expect(calls.map((call) => [call.name, call.at])).toEqual([
    ['first', 0],
    ['first', 1000],
  ])
  // The second 429 asked for 3 s from the moment it came: the next request goes then, not at once.
  await clock.advance(3000)
  expect((await later).ok).toBe(true)
  expect(calls.at(-1)).toEqual({ name: 'later', at: 4000 })
})

test('a Retry-After of an hour holds the requests back for MAX_HOLD_MS only: the refused one asks again then', async (_$, on) => {
  const clock = mock.clock(on)
  const { backend, calls } = recording((_name, n) => (n === 1 ? refusal(3_600_000) : answered()))
  const jev = paced(backend)
  const io = hostOf(clock)
  const first = jev.ask(io, request('first', 10), 8000)
  await clock.settle()
  const later = jev.ask(io, request('later', 10), 8000)
  await clock.settle()
  expect(calls.map((call) => call.name)).toEqual(['first'])
  await clock.advance(MAX_HOLD_MS)
  const [again, other] = await Promise.all([first, later])
  expect(calls.map((call) => [call.name, call.at])).toEqual([
    ['first', 0],
    ['first', MAX_HOLD_MS],
    ['later', MAX_HOLD_MS],
  ])
  expect(again.ok && other.ok).toBe(true)
  expect(again.notes).toContain(`HTTP 429, asked again after ${MAX_HOLD_MS} ms`)
})

test("a request that the hold of a 429 keeps from going within its wait fails as busy, not as a timeout, and is not sent", async (_$, on) => {
  const clock = mock.clock(on)
  const { backend, calls } = recording((_name, n) => (n === 1 ? refusal(4000) : answered()))
  const jev = paced(backend)
  const io = hostOf(clock)
  await jev.ask(io, request('first', 10), 1500)
  const held = await jev.ask(io, request('held', 10), 1500)
  // Told to wait 4 s, and asked to answer within 1.5: the account is busy, which is not the same as no answer.
  expect(held).toEqual({ ok: false, failure: { kind: 'busy', status: 429, detail: expect.stringContaining('not sent') } })
  expect(calls.map((call) => call.name)).toEqual(['first'])
  // The hold ends, and requests go again.
  await clock.advance(4000)
  expect((await jev.ask(io, request('after', 10), 1500)).ok).toBe(true)
})

test('the hold is in place before the tokens a refused request gives back wake the one waiting for them: it does not go in between', async (_$, on) => {
  const clock = mock.clock(on)
  // The first request is refused after 100 ms with a wait of 2 s; the second lacks tokens for as long as the first has them.
  const { backend, calls } = recording((name, n) => (name === 'first' && n === 1 ? refusal(2000) : answered()), 100)
  const jev = paced(backend, SLOW)
  const io = hostOf(clock)
  const [firstOne, secondOne] = [request('first', 2300), request('second', 2300)]
  const [first, second] = [firstOne, secondOne].map(jevRequestTokens) as [number, number]
  // Two do not fit the bucket of 5,000 at once.
  expect(first + second).toBeGreaterThan(5000)
  const asking = [jev.ask(io, firstOne, 8000)]
  await clock.settle()
  asking.push(jev.ask(io, secondOne, 8000))
  await clock.settle()
  expect(calls.map((call) => call.name)).toEqual(['first'])
  // The refusal at 100 ms gives the first one's tokens back: the second could go then, but the account said to wait until 2100.
  await clock.advance(100)
  await clock.settle()
  expect(calls.map((call) => call.name)).toEqual(['first'])
  await clock.advance(10_000)
  await Promise.all(asking)
  // The first asks again at 2100 (its old place), the second when the bucket has filled what the first took out again.
  const lackMs = Math.ceil(first + second - 5000)
  expect(calls.map((call) => [call.name, call.at])).toEqual([
    ['first', 0],
    ['first', 2100],
    ['second', 2100 + lackMs],
  ])
})

test('a request that asks again keeps its old place in line: one that came while it was out does not go first', async (_$, on) => {
  const clock = mock.clock(on)
  // One request a second. The first is refused (asked to wait no longer) after 100 ms; the second came at 10 ms and waits for the second.
  const { backend, calls } = recording((name, n) => (name === 'first' && n === 1 ? refusal(0) : answered()), 100)
  const jev = paced(backend, { requestsPerSecond: 1, tokensPerSecond: 100_000 })
  const io = hostOf(clock)
  const asking = [jev.ask(io, request('first', 10), 5000)]
  await clock.settle()
  await clock.advance(10)
  asking.push(jev.ask(io, request('second', 10), 5000))
  await clock.settle()
  await clock.advance(5000)
  await Promise.all(asking)
  // The retry of the first is the first in line again, though the second asked after it first went out.
  expect(calls.map((call) => [call.name, call.at])).toEqual([
    ['first', 0],
    ['first', 1000],
    ['second', 2000],
  ])
})

test('a clock that fails does not leave the request at the head of the queue: the next request still goes', async (_$, on) => {
  const clock = mock.clock(on)
  const { backend, calls } = recording()
  const jev = paced(backend)
  const io = hostOf(clock)
  let reads = 0
  const flaky: BackendIo = {
    ...io,
    pace: {
      ...(io.pace as NonNullable<BackendIo['pace']>),
      // The first read is the deadline's, the second the request's wait for its place.
      now: async () => {
        if (++reads === 2) throw new Error('clock failed')
        return clock.now()
      },
    },
  }
  await expect(jev.ask(flaky, request('broken', 10), 3000)).rejects.toThrow('clock failed')
  expect((await jev.ask(io, request('next', 10), 3000)).ok).toBe(true)
  expect(calls.map((call) => call.name)).toEqual(['next'])
})

test('a request without the hook clock (the eval, which paces itself) goes straight through', async () => {
  const sent: string[] = []
  const backend: Backend = {
    name: 'jev',
    configured: true,
    async ask(_io, asked) {
      sent.push(String((asked.state as { name: string }).name))
      return answered()
    },
  }
  const jev = paced(backend, { requestsPerSecond: 1, tokensPerSecond: 1000 })
  const io: BackendIo = { fetch: async () => ({ status: 200, ok: true, headers: {}, text: '' }), sleep: async () => {} }
  await Promise.all(['a', 'b', 'c'].map((name) => jev.ask(io, request(name, 60_000), 1500)))
  expect(sent).toEqual(['a', 'b', 'c'])
})
