// The visual-check suite when something goes wrong (#65, seam 2): the eval says why an item has no answer instead of counting it as one, and
// where the mod would go on (the zoomed re-check failing for a check) the suite goes on the same way and keeps the reason with the answer. And
// what a run plans to send, for `--estimate` and `--max-usd`: the requests of the whole flow, with their images, not only the first.

import { expect, test } from 'claude-code/testing'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import { settingsFrom } from '../eval/lib/suite.ts'
import { type VisualCheckItem, visualCheckSuite } from '../eval/lib/visual-check.ts'
import { askThrough, evalJev, imageHost } from './support/eval-images.ts'
import type { FakeFile } from './support/images.ts'
import { isZoomRequest, zoomBackend } from './support/zoom.ts'
import { jev } from './support/world.ts'

const settings = settingsFrom({ decisionModel: 'jev', typesafeApiKey: 'ts-test-key' })
const FILES = {
  '/set/ui/ref.png': { format: 'png', width: 702, height: 1519 },
  '/set/ui/c1.png': { format: 'png', width: 702, height: 1519 },
  '/set/effort/cube-0.png': { format: 'png', width: 640, height: 480 },
}
const base = { rationale: 'x', difficulty: 'hard' as const, tags: [] as string[] }
const UI: VisualCheckItem = {
  ...base,
  id: 'ui-c1',
  kind: 'ui',
  asked: { screenshot: 'ui/c1.png', reference: ['ui/ref.png'], same_view: null, checks: [{ part: 'the primary button', property: 'corner radius' }, { part: 'the tab bar', property: 'number of tabs' }] },
  gold: { holds: [false, true] },
}
const CUBE: VisualCheckItem = { ...base, id: 'cube', kind: 'complexity', asked: { references: ['effort/cube-0.png'] }, gold: { level: 0, accept: [0, 1], rank: 0 } }

const answering = zoomBackend({ whole: { 'check.0': 0.1, 'check.1': 0.95 }, zoom: 0.3 })

async function decide(item: VisualCheckItem, reply: Parameters<typeof askThrough>[1], options: { files?: Record<string, FakeFile>; variant?: string; language?: 'zh' | 'en'; host?: boolean } = {}) {
  const { host } = imageHost(options.files ?? FILES)
  const { ask, sent } = askThrough(evalJev('ts-test-key'), reply)
  const decided = await visualCheckSuite(options.host === false ? undefined : host).decide(item, options.language ?? 'zh', options.variant ?? 'mod', ask, settings)
  return { decided, sent }
}

test('a run with no host for pictures says so, for each item: nothing is asked', async () => {
  const { decided, sent } = await decide(UI, answering, { host: false })
  expect(decided).toMatchObject({ ok: false, failure: expect.stringContaining('config: this run has no host') })
  expect(sent).toHaveLength(0)
})

test("the questions are the mod's English ones whatever the language, so an item in another language is not asked, and a variant that is not one is refused", async () => {
  expect((await decide(UI, answering, { language: 'en' })).decided).toMatchObject({ ok: false, failure: expect.stringContaining('--languages zh') })
  await expect(decide(UI, answering, { variant: 'zh-score' })).rejects.toThrow(/no variant "zh-score" \(mod, whole\)/)
})

test('a picture that is not there is why an item has no answer, before anything is sent', async () => {
  const { decided, sent } = await decide(UI, answering, { files: { '/set/ui/ref.png': FILES['/set/ui/ref.png'] } })
  expect(decided).toMatchObject({ ok: false, failure: expect.stringMatching(/^images: .*c1\.png/) })
  expect(sent).toHaveLength(0)
})

test('a request the decision model refuses is the item\'s failure, in the words of the other suites: the kind and the detail', async () => {
  const refused = () => ({ status: 400, body: { error: { message: 'bad request', type: 'invalid_request_error' } } })
  expect((await decide(UI, refused)).decided).toMatchObject({ ok: false, failure: expect.stringMatching(/^http: HTTP 400/) })
  expect((await decide(CUBE, refused)).decided).toMatchObject({ ok: false, failure: expect.stringMatching(/^http: HTTP 400/) })
})

test("when the zoomed re-check fails the item still has its answer, as in the mod: the whole images' FAIL stands, the rest is UNSURE with the reason", async () => {
  const reply = zoomBackend({ whole: { 'check.0': 0.1, 'check.1': 0.95 }, zoomReply: { status: 500, body: 'down' } })
  const { decided, sent } = await decide(UI, reply)

  expect(sent.filter((request) => isZoomRequest(request))).toHaveLength(1)
  expect(decided.ok).toBe(true)
  if (!decided.ok) return
  expect(decided.prediction).toMatchObject({ kind: 'checks', outcomes: [{ verdict: 'fail', basis: 'whole' }, { verdict: 'unsure', basis: 'whole' }] })
  const checks = (decided.detail as { checks: { why?: string; whole: number | null; trust: string }[] }).checks
  expect(checks[1]?.why).toMatch(/zoomed re-check failed/)
  // What each answer rests on is kept: the whole images may only fail, whatever they said.
  expect(checks.map((one) => [one.whole, one.trust])).toEqual([[0.1, 'fail'], [0.95, 'fail']])
})

test("a check's answer keeps the probability it rests on: the crops' once they decide, with the whole images' beside it", async () => {
  const { decided } = await decide(UI, zoomBackend({ whole: { 'check.0': 0.8, 'check.1': 0.95 }, zoom: { 'zoom.0.0': 0.12, 'zoom.1.0': 0.97 } }))
  expect(decided.ok).toBe(true)
  if (!decided.ok) return
  expect((decided.detail as { checks: unknown[] }).checks).toMatchObject([
    { holds: false, verdict: 'fail', p: 0.12, basis: 'zoom', trust: 'both', whole: 0.8 },
    { holds: true, verdict: 'pass', p: 0.97, basis: 'zoom', trust: 'both', whole: 0.95 },
  ])
  // And what each request cost: the first with its two pictures, the second with the four crops.
  expect((decided.detail as { requests: { questions: number; images: number }[] }).requests).toMatchObject([{ questions: 7, images: 2 }, { questions: 2, images: 4 }])
})

test('the estimate is the requests of the whole flow with their pictures: the first, and the zoomed re-check\'s crops as the middle of each image would give them', async () => {
  const { host } = imageHost(FILES)
  const planned = await visualCheckSuite(host).estimate?.(UI, 'zh', 'mod', settings)
  expect(planned).toHaveLength(2)
  expect(planned?.map((request) => request.images?.length)).toEqual([2, 4])
  expect(Object.keys(planned?.[0]?.questions ?? {})).toContain('where.screen')
  expect(Object.keys(planned?.[1]?.questions ?? {})).toEqual(['zoom.0.0', 'zoom.1.0'])
  // The `whole` variant sends the first request alone.
  expect((await visualCheckSuite(host).estimate?.(UI, 'zh', 'whole', settings))?.length).toBe(1)
  // A group of references is one request.
  expect((await visualCheckSuite(host).estimate?.(CUBE, 'zh', 'mod', settings))?.map((request) => Object.keys(request.questions))).toEqual([['complexity.level']])
})

test("an animation is read by the bars of a recording, as in the mod: PASS from 0.8, FAIL up to 0.4, and a screenshot's check keeps FAIL up to 0.2", async () => {
  const ANIM: VisualCheckItem = {
    ...base,
    id: 'anim-spring',
    kind: 'anim',
    asked: {
      frames: [{ file: 'anim/f-00.png', seconds: 0 }, { file: 'anim/f-01.png', seconds: 0.05 }],
      spec: 'A card slides in.',
      checks: ['a', 'b', 'c', 'd'].map((property) => ({ part: 'the card', property })),
    },
    gold: { holds: [true, true, false, false] },
  }
  const files = { ...FILES, '/set/anim/f-00.png': FILES['/set/ui/c1.png'], '/set/anim/f-01.png': FILES['/set/ui/c1.png'] }
  const { decided } = await decide(ANIM, jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.8, 'check.1': 0.79, 'check.2': 0.41, 'check.3': 0.4 } }), { files })
  expect(decided).toMatchObject({ ok: true, prediction: { kind: 'checks', outcomes: [{ verdict: 'pass' }, { verdict: 'unsure' }, { verdict: 'unsure' }, { verdict: 'fail' }] } })

  const still = await decide(UI, zoomBackend({ whole: { 'check.0': 0.4, 'check.1': 0.4 }, zoom: 0.4 }))
  expect(still.decided).toMatchObject({ ok: true, prediction: { kind: 'checks', outcomes: [{ verdict: 'unsure' }, { verdict: 'unsure' }] } })
})

test('the reading of a group whose answer has no level is no answer either, with the reason', async () => {
  const { decided } = await decide(CUBE, () => ({ status: 200, body: { model: JEV_MODEL, answers: {}, usage: { input_tokens: 10, output_tokens: 0 } } }))
  expect(decided).toMatchObject({ ok: false, failure: expect.stringContaining('no complexity level') })
})

test('a group reads as the level its answer leans to', async () => {
  const { decided } = await decide(CUBE, jev([0, 1, 0, 0, 0], { scores: { 'complexity.level': [0.05, 0.1, 0.1, 0.7, 0.05] } }))
  expect(decided).toMatchObject({ ok: true, prediction: { kind: 'level', level: 3 } })
})
