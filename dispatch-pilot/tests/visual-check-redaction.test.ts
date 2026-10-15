// visual_check (#55 spec: "the text part is redacted as before"): the words the agent writes in a call (the specification, the part
// and the property of each check) go to the decision model like any text of the mod's, with the common secret formats masked. Every
// kind of call has words in its requests: a spec, a reference or another screenshot (the Box and the crop questions), a recording's
// frames, a series of quality levels. Seam 1, as visual-check.test.ts: a test reads every request that went out.

import { expect, test } from 'claude-code/testing'
import { ffmpeg, type FakeVideo } from './support/images.ts'
import { level, levels, seriesBackend } from './support/series.ts'
import { zoomBackend } from './support/zoom.ts'
import { jev, world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }

/** A key the redaction knows by its prefix. */
const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwx'
const SPEC = `The sign-in screen. It was made with ANTHROPIC_API_KEY = ${KEY} in the environment.`
const CHECK = { part: `the field that shows ${KEY}`, property: `masks ${KEY} as dots` }

const SHOT = '/shots/home.png'
const DESIGN = '/design/home.png'
const REC = '/rec/transition.mov'
const FILES = {
  [SHOT]: { format: 'png', width: 1000, height: 1000 },
  [DESIGN]: { format: 'png', width: 1000, height: 1000 },
}
const VIDEOS: Record<string, FakeVideo> = { [REC]: { seconds: 3.5, width: 390, height: 844 } }

/** Everything the decision model was told in words, in all the requests of the world (the images are not words). */
const wordsSent = (requests: readonly { body: any }[]): string => JSON.stringify(requests.map((request) => ({ state: request.body.state, questions: request.body.questions })))

test('against a spec the specification and the words of each check are sent with secrets masked', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.95 } }) })
  await w.start()
  await w.visualCheck({ images: [SHOT], spec: SPEC, checks: [CHECK] })

  expect(w.requests).toHaveLength(1)
  expect(wordsSent(w.requests)).not.toContain(KEY)
  expect(wordsSent(w.requests)).toContain('[REDACTED]')
})

test('against a reference the questions that locate a part and the ones on its crops are sent with secrets masked too', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ whole: { 'check.0': 0.5 } }) })
  await w.start()
  await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [CHECK] })

  // The first request (whole images and Box questions) and the second (the crops).
  expect(w.requests.length).toBeGreaterThanOrEqual(2)
  expect(wordsSent(w.requests)).not.toContain(KEY)
})

test('the frames of a recording are sent with the spec and the words of the checks masked', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: { programs: { ffmpeg: ffmpeg(VIDEOS) } }, backend: jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.95 } }) })
  await w.start()
  await w.visualCheck({ images: [REC], spec: SPEC, checks: [CHECK] })

  expect(w.requests).toHaveLength(1)
  expect(wordsSent(w.requests)).not.toContain(KEY)
})

test('a series of quality levels is sent with the words of the checks masked', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: levels(2), process: true, backend: seriesBackend() })
  await w.start()
  await w.visualCheck({ images: [level(1), level(2)], sequence: true, checks: [CHECK] })

  expect(w.requests.length).toBeGreaterThanOrEqual(2)
  expect(wordsSent(w.requests)).not.toContain(KEY)
})

test('what the agent wrote is still what the answer to it says: only the request is masked', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.95 } }) })
  await w.start()
  const answer = await w.visualCheck({ images: [SHOT], spec: SPEC, checks: [CHECK] })

  expect(JSON.stringify(answer.result)).toContain(`masks ${KEY} as dots`)
})
