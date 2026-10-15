// The fake decision backends of the world (tests/support/world.ts: `jev`, `pplx`) take images as the real APIs do (#56, seam 1),
// and a request with images that the backends build goes through them: Jev refuses images without its header and answers a Box
// question; pplx refuses the ninth image, and its image requests wait their turn at the rate limit like any other.
//
// A test module may not call `$.http.fetch` itself (the host lets a module call only what it lists), so the fakes, which are
// functions from a request to a reply, are used here the way the world uses them, behind an `io.fetch` of the test's own; the
// rate limit has its own clock below.

import { expect, test } from 'claude-code/testing'
import { setup } from '../hooks/core/setup.ts'
import type { Asked, BackendIo, StateCell } from '../hooks/decision/backend.ts'
import { imageRef } from '../hooks/decision/images.ts'
import type { DecisionRequest, RequestImage } from '../hooks/decision/system-one.ts'
import { jev, pplx, type Reply, type Sent } from './support/world.ts'

/** A `BackendIo` whose network is `fake` (a world backend), keeping what was sent and when. */
function fakeNetwork(fake: (sent: Sent) => Reply, clock: { now: () => number } = { now: () => 0 }) {
  const sent: Sent[] = []
  const send = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    const one: Sent = { url, method: init.method, headers: { ...(init.headers ?? {}) }, body: JSON.parse(String(init.body)), at: clock.now() }
    sent.push(one)
    const reply = fake(one)
    if (!('status' in reply)) throw new Error('this test replies at once')
    return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: reply.headers ?? {}, text: JSON.stringify(reply.body) }
  }
  const io: BackendIo = { fetch: send, sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))) }
  return { io, sent, send }
}

const shot = (name: string): RequestImage => ({ name, format: 'png', base64: 'iVBORw0KGgo=', width: 1200, height: 800 })

/** `count` screenshots in the state and one question on them; with `box`, a Box question about the first. */
function request(count: number, box = false): DecisionRequest {
  const names = Array.from({ length: count }, (_, i) => `shot-${i + 1}`)
  return {
    state: Object.fromEntries(names.map((name) => [name, imageRef(name)])),
    questions: {
      'check.same': { type: 'noul', instructions: 'Are the screenshots the same?' },
      ...(box ? { 'check.where': { type: 'box' as const, instructions: 'The region of `shot-1` that differs.' } } : {}),
    },
    images: names.map(shot),
  }
}

const ok = (asked: Asked) => {
  if (!asked.ok) throw new Error(`not answered: ${asked.failure.detail}`)
  return asked
}

const imagesOf = (options: Record<string, string | number>) => {
  const images = setup(options).images
  if (images === null) throw new Error('no image backend for these keys')
  return images
}

test('Jev through the world: images with their header are answered, a Noul by the value the test gives and a Box question with a box', async () => {
  const box = { top: 0.62, bottom: 0.69, left: 0.04, right: 0.96 }
  const net = fakeNetwork(jev([0, 1, 0, 0, 0], { nouls: { 'check.same': 0.93 }, boxes: { 'check.where': { box, confidence: 0.24 } } }))
  const asked = ok(await imagesOf({ typesafeApiKey: 'ts-test-key' }).backend.ask(net.io, request(2, true), 1500))

  expect(asked.answers['check.same']).toEqual({ type: 'noul', noul: 0.93 })
  expect(asked.answers['check.where']).toEqual({ type: 'box', box, confidence: 0.24 })
  expect(net.sent).toHaveLength(1)
})

test('a Box question gets a box of the middle of the image unless the test says where', async () => {
  const net = fakeNetwork(jev([0, 1, 0, 0, 0]))
  const asked = ok(await imagesOf({ typesafeApiKey: 'ts-test-key' }).backend.ask(net.io, request(1, true), 1500))
  expect(asked.answers['check.where']).toEqual({ type: 'box', box: { top: 0.25, bottom: 0.75, left: 0.25, right: 0.75 }, confidence: 0.5 })
})

test('Jev through the world answers 400 as the real API does: images without the header, a Box question without it, an image nothing refers to', async () => {
  const net = fakeNetwork(jev([0, 1, 0, 0, 0]))
  const post = async (body: unknown, headers: Record<string, string> = {}) =>
    (await net.send('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { authorization: 'Bearer ts-test-key', ...headers }, body: JSON.stringify(body) })).status
  const asset = { type: 'image', format: 'png', data_base64: 'iVBORw0KGgo=' }
  const questions = { a: { type: 'noul', instructions: 'Is there a person in `door`?' } }
  const withImage = { model: 'jev-1.14.0', state: { door: 'u-door' }, assets: { 'u-door': asset }, questions }
  const header = { 'TypeSafe-Danger-Zone-Images': 'true' }

  expect(await post(withImage)).toBe(400)
  expect(await post(withImage, header)).toBe(200)
  // The header's name is not case sensitive.
  expect(await post(withImage, { 'typesafe-danger-zone-images': 'true' })).toBe(200)
  expect(await post({ model: 'jev-1.14.0', state: {}, questions: { b: { type: 'box', instructions: 'x' } } })).toBe(400)
  expect(await post({ ...withImage, state: { door: 'something else' } }, header)).toBe(400)
  // Text only needs no header.
  expect(await post({ model: 'jev-latest', state: {}, questions })).toBe(200)
})

test('pplx through the world: a state that is an array of parts is answered, and the ninth image is a 400 that says so', async () => {
  const net = fakeNetwork(pplx([0, 1, 0, 0, 0], { nouls: { 'check.same': 0.8 } }))
  const eight = ok(await imagesOf({ perplexityApiKey: 'pplx-test-key' }).backend.ask(net.io, request(8), 1500))
  expect(eight.answers['check.same']).toEqual({ type: 'noul', noul: 0.8 })
  expect(Array.isArray(net.sent[0]?.body.state)).toBe(true)

  // The backend never sends a ninth (it fails when it builds the request); the world answers what the API would to one that was sent.
  const parts = (count: number) => Array.from({ length: count }, () => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }))
  const send = (count: number) =>
    net.send('https://api.perplexity.ai/v1/decisions', {
      method: 'POST',
      headers: { authorization: 'Bearer pplx-test-key' },
      body: JSON.stringify({ model: 'pplx-decider-v1.1-27b', state: parts(count), questions: { q: { type: 'noul', instructions: 'x' } } }),
    })
  const nine = await send(9)
  expect(nine.status).toBe(400)
  expect(JSON.parse(nine.text).error.message).toBe('At most 8 images are allowed per question')
  expect((await send(8)).status).toBe(200)
  // Box questions are Jev's alone.
  const box = await net.send('https://api.perplexity.ai/v1/decisions', {
    method: 'POST',
    headers: { authorization: 'Bearer pplx-test-key' },
    body: JSON.stringify({ model: 'pplx-decider-v1.1-27b', state: [], questions: { q: { type: 'box', instructions: 'x' } } }),
  })
  expect(box.status).toBe(400)
})

// ---- the rate limit -------------------------------------------------------------------------------------

/** A clock of the test's own: `sleep` waits for `advance`, which fires the timers in their order. */
function clock() {
  let at = 0
  const timers: { due: number; fire: () => void }[] = []
  const settle = async () => {
    for (let i = 0; i < 200; i++) await Promise.resolve()
  }
  return {
    now: () => at,
    sleep: (ms: number, signal: AbortSignal) =>
      new Promise<void>((done, fail) => {
        const timer = { due: at + ms, fire: () => done() }
        timers.push(timer)
        signal.addEventListener('abort', () => {
          timers.splice(timers.indexOf(timer), 1)
          fail(new Error('aborted'))
        })
      }),
    settle,
    advance: async (ms: number) => {
      const target = at + ms
      await settle()
      for (;;) {
        const next = timers.filter((timer) => timer.due <= target).sort((a, b) => a.due - b.due)[0]
        if (next === undefined) break
        at = next.due
        timers.splice(timers.indexOf(next), 1)
        next.fire()
        await settle()
      }
      at = target
      await settle()
    },
  }
}

test('a pplx request with images waits its turn at the rate limit: with one a second, the second goes out a second after the first, and the record of sends is kept', async () => {
  const time = clock()
  const net = fakeNetwork(pplx([0, 1, 0, 0, 0]), time)
  let sentAt: { value: number[] | undefined; version: number } = { value: undefined, version: 0 }
  const cell: StateCell<number[]> = {
    get: async () => sentAt,
    set: async (value, { ifVersion }) => {
      if (ifVersion !== sentAt.version) return { isSet: false, version: sentAt.version }
      sentAt = { value, version: sentAt.version + 1 }
      return { isSet: true, version: sentAt.version }
    },
  }
  const io: BackendIo = { ...net.io, sleep: time.sleep, pace: { now: async () => time.now(), sentAt: cell } }
  const { backend } = imagesOf({ perplexityApiKey: 'pplx-test-key', pplxQps: 1 })

  const first = backend.ask(io, request(2), 5000)
  const second = backend.ask(io, request(3), 5000)
  await time.settle()
  expect(net.sent.map((one) => one.at)).toEqual([0])

  await time.advance(1000)
  ok(await first)
  ok(await second)
  expect(net.sent.map((one) => one.at)).toEqual([0, 1000])
  expect(sentAt.value).toEqual([1000])
})
