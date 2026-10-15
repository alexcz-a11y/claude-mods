// visual_check (#55, ADR 0007): a `$.clock.sleep` counts toward the hook's 10 seconds, and every request waits on one, so the requests of
// one call share the time: each waits at most 8 seconds, and no longer than what is left of 9 (a second stays for the rest of the
// hook). When too little is left the request is not sent, and the checks it was for end unsure, with the reason. Seam 1, as
// visual-check.test.ts: the world's decision model answers after the time a test gives it, and a test moves the mock clock.

import { expect, test } from 'claude-code/testing'
import { zoomBackend } from './support/zoom.ts'
import { world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }
const SHOT = '/shots/home.png'
const DESIGN = '/design/home.png'
const FILES = {
  [SHOT]: { format: 'png', width: 1000, height: 1000 },
  [DESIGN]: { format: 'png', width: 1000, height: 1000 },
}
const BUTTON = { part: 'the primary button', property: 'corner radius' }

/** Whether a request is the first of a zoomed re-check (the whole images and the Box questions), not the one on the crops. */
const isFirst = (request: { body: any }): boolean => Object.keys(request.body.questions).some((id) => id.startsWith('check.'))

/** The text of the answer to a visual_check call. */
const textOf = (answer: { result?: unknown }): string => (answer.result as { type: string; text?: string }[]).filter((block) => block.type === 'text').map((block) => block.text).join('\n')

test('the second request of a call waits only for what is left of the hook\'s time: after a first one that took 5 seconds, 4', { options: JEV }, async ($, on) => {
  const answers = zoomBackend({ whole: { 'check.0': 0.5 }, zoom: 0.95 })
  const w = world($, on, { session: true, files: FILES, process: true, backend: (request) => ({ after: isFirst(request) ? 5000 : 20_000, reply: answers(request) }) })
  await w.start()
  const call = w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] })
  await w.clock.settle()
  await w.clock.advance(5000)
  await w.clock.settle()
  await w.clock.advance(4000)
  const text = textOf(await call)

  expect(text).toContain('no answer in 4000 ms')
  expect(w.clock.now()).toBe(9000)
})

test('a request with too little time left is not sent: the checks it was for are unsure, and the reason says so', { options: JEV }, async ($, on) => {
  const answers = zoomBackend({ whole: { 'check.0': 0.5 }, zoom: 0.95 })
  const w = world($, on, { session: true, files: FILES, process: true, backend: (request) => ({ after: 7900, reply: answers(request) }) })
  await w.start()
  const call = w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] })
  await w.clock.settle()
  await w.clock.advance(7900)
  const text = textOf(await call)

  // Only the first request went out; the zoomed re-check had 1.1 seconds.
  expect(w.requests).toHaveLength(1)
  expect(text).toContain('1. UNSURE')
  expect(text).toContain('no time left')
})

test('a call whose requests fit in the time is not held back: the zoomed re-check goes out when the first one is answered', { options: JEV }, async ($, on) => {
  const answers = zoomBackend({ whole: { 'check.0': 0.5 }, zoom: 0.95 })
  const w = world($, on, { session: true, files: FILES, process: true, backend: (request) => ({ after: 3000, reply: answers(request) }) })
  await w.start()
  const call = w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] })
  await w.clock.settle()
  await w.clock.advance(3000)
  await w.clock.settle()
  await w.clock.advance(3000)
  const text = textOf(await call)

  expect(w.requests).toHaveLength(2)
  expect(text).toContain('1. PASS 0.95 (zoomed crop)')
})
