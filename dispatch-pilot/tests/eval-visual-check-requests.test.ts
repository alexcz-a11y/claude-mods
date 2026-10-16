// The visual-check suite of the eval (#65, seam 2): what it sends for an item is what the mod sends when an agent calls visual_check
// on those pictures (or, for a group of references, when the person pastes them): the same requests, in the same order, checked against
// the mod itself through seam 1's world, as tests/eval-effort-submit.test.ts does for the effort question. The mod's tool runs in the world on a
// fake disk; the eval's suite runs on the same fake disk through its own host (tests/support/eval-images.ts) and its own backend,
// and what each put on the wire is compared. The UUID every request names its images by is new each time, so it is made alike;
// everything else, the bytes of the images included, is compared as it is.

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { frameTimes, WHOLE_RECORDING } from '../hooks/decision/visual-check-frames.ts'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import { settingsFrom } from '../eval/lib/suite.ts'
import { type VisualCheckItem, visualCheckSuite } from '../eval/lib/visual-check.ts'
import { askThrough, comparable, evalJev, evalPplx, imageHost } from './support/eval-images.ts'
import { ffmpeg, readFake } from './support/images.ts'
import { jev, KEY, pplx, world } from './support/world.ts'
import { box, zoomBackend } from './support/zoom.ts'

const PPLX = { decisionModel: 'pplx', perplexityApiKey: 'pplx-test-key' }

const frame = (n: number): string => `anim/spring-${String(n).padStart(2, '0')}.png`
const FILES = {
  '/set/ui/ref.png': { format: 'png', width: 702, height: 1519 },
  '/set/ui/c1.png': { format: 'png', width: 702, height: 1519 },
  '/set/sea/ref.png': { format: 'png', width: 640, height: 400 },
  '/set/sea/big.png': { format: 'png', width: 640, height: 400 },
  '/set/effort/cube-0.png': { format: 'png', width: 640, height: 480 },
  '/set/effort/cube-1.png': { format: 'png', width: 640, height: 480 },
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`/set/${frame(i)}`, { format: 'png', width: 400, height: 400 }])),
}

const BUTTON = { part: 'the primary button', property: 'corner radius' }
const TAB_BAR = { part: 'the tab bar', property: 'number of tabs' }
const base = { rationale: 'x', difficulty: 'hard' as const, tags: [] as string[] }

const UI: VisualCheckItem = { ...base, id: 'ui-c1-radius', kind: 'ui', asked: { screenshot: 'ui/c1.png', reference: ['ui/ref.png'], same_view: null, checks: [BUTTON, TAB_BAR] }, gold: { holds: [false, true] } }
const SEA: VisualCheckItem = {
  ...base,
  id: 'sea-big',
  kind: 'sea',
  asked: { screenshot: 'sea/big.png', reference: ['sea/ref.png'], same_view: null, checks: [{ part: 'the waves', property: 'height' }, { part: 'the white foam on the wave crests', property: 'amount' }, { part: 'the fog over the water', property: 'density' }] },
  gold: { holds: [false, false, true] },
}
const REFERENCES: VisualCheckItem = { ...base, id: 'complexity-cube', kind: 'complexity', asked: { references: ['effort/cube-0.png', 'effort/cube-1.png'] }, gold: { level: 0, accept: [0, 1], rank: 0 } }

/** The Jev the world answers with: the whole images 0.5 for the first check and 0.95 for the rest, boxes for each part, the crops 0.1 for the first pair and 0.95 for the others. */
const ZOOMING = zoomBackend({
  whole: { 'check.0': 0.5, 'check.1': 0.95, 'check.2': 0.95 },
  boxes: {
    'box.0.candidate': box(0.63, 0.69, 0.04, 0.96),
    'box.0.reference': box(0.63, 0.69, 0.04, 0.96),
    'box.1.candidate': box(0.9, 1, 0, 1),
    'box.1.reference': box(0.9, 1, 0, 1),
    'box.2.candidate': box(0, 0.4, 0, 1),
    'box.2.reference': box(0, 0.4, 0, 1),
    'where.screen': box(0.2, 0.3, 0.1, 0.5, 0.6),
  },
  zoom: { 'zoom.0.0': 0.1, 'zoom.1.0': 0.95, 'zoom.2.0': 0.95 },
})

/** The mod's requests, and the eval's, for one item. */
async function bothAsk($: Engine, on: On, item: VisualCheckItem, input: Record<string, unknown>, options: Record<string, unknown>, reply: Parameters<typeof askThrough>[1], variant = 'mod', backend = evalJev(String(options.typesafeApiKey))) {
  const w = world($, on, { session: true, files: FILES, process: true, backend: reply })
  await w.start()
  await w.visualCheck(input)
  const host = imageHost(FILES)
  const { ask, sent } = askThrough(backend, reply)
  const decided = await visualCheckSuite(host.host).decide(item, 'zh', variant, ask, settingsFrom(options as never))
  return { w, sent, decided, ran: host.ran }
}

test("with Jev, an item compared with a reference is asked as the mod asks a call: the checks and the Box questions in the first request, one Noul for each pair of crops in the second", { options: KEY }, async ($, on) => {
  const { w, sent, decided } = await bothAsk($, on, UI, { images: ['/set/ui/c1.png'], reference: ['/set/ui/ref.png'], checks: [BUTTON, TAB_BAR] }, KEY, ZOOMING)

  expect(decided.ok).toBe(true)
  // Two requests each, and each pair is the same on the wire: the URL, the headers (the key and the images header), the body (the pinned model, the state, the assets, the questions).
  expect(w.requests).toHaveLength(2)
  expect(sent.map((request) => comparable(request))).toEqual(w.requests.map((request) => comparable(request)))
  // What they hold, so that the equality is not of two empty things.
  const [first, second] = sent
  expect(first?.body.model).toBe(JEV_MODEL)
  expect(first?.headers['TypeSafe-Danger-Zone-Images']).toBe('true')
  expect(Object.keys(first?.body.assets)).toHaveLength(2)
  expect(Object.keys(first?.body.questions)).toEqual(['check.0', 'check.1', 'box.0.candidate', 'box.0.reference', 'box.1.candidate', 'box.1.reference', 'where.screen'])
  expect(Object.keys(second?.body.questions)).toEqual(['zoom.0.0', 'zoom.1.0'])
  // The crops are cut by the same sips arguments: each says what it was cut from, which piece, and that it was enlarged (the equality above holds their bytes to the mod's).
  const crops = Object.values(second?.body.assets as Record<string, { data_base64: string }>).map((asset) => readFake(asset.data_base64)?.label)
  expect(crops).toHaveLength(4)
  for (const label of crops) expect(label).toMatch(/^\/set\/ui\/(c1|ref)\.png > crop \d+x\d+\+\d+\+\d+ > fit /)
})

test('the same for a render of the sea against its reference, three checks, three pairs of crops', { options: KEY }, async ($, on) => {
  const sea = [{ part: 'the waves', property: 'height' }, { part: 'the white foam on the wave crests', property: 'amount' }, { part: 'the fog over the water', property: 'density' }]
  const { w, sent, decided } = await bothAsk($, on, SEA, { images: ['/set/sea/big.png'], reference: ['/set/sea/ref.png'], checks: sea }, KEY, ZOOMING)

  expect(decided.ok).toBe(true)
  expect(sent.map((request) => comparable(request))).toEqual(w.requests.map((request) => comparable(request)))
  expect(Object.keys(sent[1]?.body.questions)).toEqual(['zoom.0.0', 'zoom.1.0', 'zoom.2.0'])
})

test("the `whole` variant is the mod's first request without the Box questions, and no second", { options: KEY }, async ($, on) => {
  const { w, sent, decided } = await bothAsk($, on, UI, { images: ['/set/ui/c1.png'], reference: ['/set/ui/ref.png'], checks: [BUTTON, TAB_BAR] }, KEY, ZOOMING, 'whole')

  expect(decided.ok).toBe(true)
  expect(sent).toHaveLength(1)
  const modFirst = comparable(w.requests[0] as never) as { body: { questions: Record<string, unknown> } }
  const wholeFirst = comparable(sent[0] as never) as { body: { questions: Record<string, unknown> } }
  expect(Object.keys(wholeFirst.body.questions)).toEqual(['check.0', 'check.1'])
  // Everything else is the mod's request: the state, the images, the questions the two share.
  expect({ ...wholeFirst, body: { ...wholeFirst.body, questions: undefined } }).toEqual({ ...modFirst, body: { ...modFirst.body, questions: undefined } })
  expect(wholeFirst.body.questions).toEqual({ 'check.0': modFirst.body.questions['check.0'], 'check.1': modFirst.body.questions['check.1'] })
})

test('with pplx, which has no Box question, an item is one request: the mod\'s, the state an array of the text and the images', { options: PPLX }, async ($, on) => {
  const reply = pplx([0, 1, 0, 0, 0], { key: 'pplx-test-key', nouls: { 'check.0': 0.5, 'check.1': 0.95 } })
  const { w, sent, decided } = await bothAsk($, on, UI, { images: ['/set/ui/c1.png'], reference: ['/set/ui/ref.png'], checks: [BUTTON, TAB_BAR] }, PPLX, reply, 'mod', evalPplx('pplx-test-key'))

  expect(decided.ok).toBe(true)
  expect(w.requests).toHaveLength(1)
  expect(sent.map((request) => comparable(request))).toEqual(w.requests.map((request) => comparable(request)))
  expect(Array.isArray(sent[0]?.body.state)).toBe(true)
  expect(Object.keys(sent[0]?.body.questions)).toEqual(['check.0', 'check.1'])
})

// ---- A motion --------------------------------------------------------------------------------------------------------------

const SPEC = 'A card (150 px wide) slides in from the left over 550 ms inside a 400 px wide frame.'
const CARD = [{ part: 'the card', property: 'it never moves past its final resting position' }, { part: 'the card in the last frame', property: 'its right edge is at x=350' }]
/** The frames the mod cuts from a 0.55 second recording: the dataset's twelve are given the same seconds, so that the state of the request says the same. */
const TIMES = frameTimes(0.55, WHOLE_RECORDING, 12)
const ANIM = (): VisualCheckItem => {
  if (!TIMES.ok) throw new Error('no times')
  return { ...base, id: 'anim-spring', kind: 'anim', asked: { frames: TIMES.times.map((seconds, i) => ({ file: frame(i), seconds })), spec: SPEC, checks: CARD }, gold: { holds: [false, true] } }
}

test('a motion is its 12 frames in one request against its spec, as the mod asks a recording; only the pictures differ (the mod cuts JPEGs with ffmpeg, the dataset has PNG files)', { options: KEY }, async ($, on) => {
  const reply = jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.1, 'check.1': 0.95 } })
  const w = world($, on, { session: true, files: FILES, process: { programs: { ffmpeg: ffmpeg({ '/rec/card.mov': { seconds: 0.55, width: 400, height: 400 } }) } }, backend: reply })
  await w.start()
  await w.visualCheck({ images: ['/rec/card.mov'], spec: SPEC, checks: CARD })
  const { ask, sent } = askThrough(evalJev('ts-test-key'), reply)
  const decided = await visualCheckSuite(imageHost(FILES).host).decide(ANIM(), 'zh', 'mod', ask, settingsFrom(KEY as never))

  expect(decided.ok).toBe(true)
  expect(w.requests).toHaveLength(1)
  expect(sent.map((request) => comparable(request, { bytes: false }))).toEqual(w.requests.map((request) => comparable(request, { bytes: false })))
  expect(sent[0]?.body.state.frames).toHaveLength(12)
  expect(Object.keys(sent[0]?.body.assets)).toHaveLength(12)
  expect(String(sent[0]?.body.state.specification)).toBe(SPEC)
})

test("with pplx a motion is 8 of its frames, spread evenly through the 12, the first and the last among them, as the mod cuts a recording for pplx", { options: PPLX }, async ($, on) => {
  const reply = pplx([0, 1, 0, 0, 0], { key: 'pplx-test-key' })
  const w = world($, on, { session: true, files: FILES, process: { programs: { ffmpeg: ffmpeg({ '/rec/card.mov': { seconds: 0.55, width: 400, height: 400 } }) } }, backend: reply })
  await w.start()
  await w.visualCheck({ images: ['/rec/card.mov'], spec: SPEC, checks: CARD })
  const { ask, sent } = askThrough(evalPplx('pplx-test-key'), reply)
  const decided = await visualCheckSuite(imageHost(FILES).host).decide(ANIM(), 'zh', 'mod', ask, settingsFrom(PPLX as never))

  expect(decided.ok).toBe(true)
  // The same questions, and eight pictures in each. (The frames are other moments: the mod cuts eight of the recording, the suite takes eight of the twelve.)
  expect(sent[0]?.body.questions).toEqual(w.requests[0]?.body.questions)
  const pictures = (request: { body: { state: unknown[] } } | undefined) => (request?.body.state ?? []).filter((part) => typeof part === 'object' && part !== null)
  expect(pictures(sent[0] as never)).toHaveLength(8)
  expect(pictures(w.requests[0] as never)).toHaveLength(8)
  const listed = JSON.parse(String((sent[0]?.body.state as unknown[])[0])).frames as { seconds: number }[]
  expect(listed.map((one) => one.seconds)).toEqual([0, 2, 3, 5, 6, 8, 9, 11].map((i) => (TIMES.ok ? TIMES.times[i] : -1)))
})

// ---- A group of reference images --------------------------------------------------------------------------------------------

test('a group of reference images is read as the mod reads the images a person pastes: one Score question of five levels, the images in the state', { options: KEY, }, async ($, on) => {
  const reply = jev([0, 1, 0, 0, 0], { scores: { 'complexity.level': [0.87, 0.11, 0.02, 0, 0] } })
  const w = world($, on, { switches: { 'image-routing': true }, files: FILES, process: true, backend: reply })
  await w.submit('Build this cube', { images: ['/set/effort/cube-0.png', '/set/effort/cube-1.png'].map((path) => ({ path, shown: { format: 'png' as const, width: 640, height: 480, label: 'pasted' } })) })
  const { ask, sent } = askThrough(evalJev('ts-test-key'), reply)
  const decided = await visualCheckSuite(imageHost(FILES).host).decide(REFERENCES, 'zh', 'mod', ask, settingsFrom(KEY as never))

  // The mod's first request is the reading, the second its effort question; the suite asks only the reading.
  expect(decided).toMatchObject({ ok: true, prediction: { kind: 'level', level: 0 } })
  expect(sent).toHaveLength(1)
  expect(comparable(sent[0] as never)).toEqual(comparable(w.requests[0] as never))
  expect(Object.keys(sent[0]?.body.questions)).toEqual(['complexity.level'])
  expect(Object.keys(sent[0]?.body.assets)).toHaveLength(2)
  // The probabilities the answer gave are kept, and the expectation they come to.
  expect(decided.ok && decided.detail).toMatchObject({ kind: 'complexity', images: 2, p: [0.87, 0.11, 0.02, 0, 0], expected: 0.15 })
})
