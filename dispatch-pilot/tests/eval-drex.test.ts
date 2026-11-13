// Drex Max v1.1 as the eval asks it (`--backend drex`, eval/lib/drex.ts), and the visual-check suite's `criteria` variant
// (eval/lib/visual-check-criteria.ts): the body is Nace's (the images in a top-level array, "Image N" where the text speaks of
// them), and each check goes out with criteria for both sides, the mod's own wording beside it.

import { expect, test } from 'claude-code/testing'
import { imageRef } from '../hooks/decision/images.ts'
import type { DecisionRequest } from '../hooks/decision/system-one.ts'
import { DREX_MAX_IMAGES, DREX_MODEL, drexBackend, drexRequest } from '../eval/lib/drex.ts'
import { settingsFrom } from '../eval/lib/suite.ts'
import { type VisualCheckItem, visualCheckSuite } from '../eval/lib/visual-check.ts'
import { imageHost } from './support/eval-images.ts'

const settings = settingsFrom({ decisionModel: 'jev', typesafeApiKey: 'ts-test-key' })
const picture = { format: 'png' as const, base64: 'AAAA', width: 400, height: 400 }
const base = { rationale: 'x', difficulty: 'hard' as const, tags: [] as string[] }
const UI: VisualCheckItem = {
  ...base,
  id: 'ui-c1',
  kind: 'ui',
  asked: { screenshot: 'ui/c1.png', reference: ['ui/ref.png'], same_view: null, checks: [{ part: 'the primary button', property: 'corner radius' }] },
  gold: { holds: [false] },
}
const frames = Array.from({ length: 12 }, (_, i) => ({ file: `anim/spring-${String(i).padStart(2, '0')}.png`, seconds: i / 10 }))
const ANIM: VisualCheckItem = { ...base, id: 'anim-spring', kind: 'anim', asked: { frames, spec: 'the card springs', checks: [{ part: 'the card', property: 'overshoots and settles' }] }, gold: { holds: [true] } }
const FILES = Object.fromEntries(['ui/c1.png', 'ui/ref.png', ...frames.map((frame) => frame.file)].map((file) => [`/set/${file}`, { format: 'png' as const, width: 400, height: 400 }]))

test('a request without images goes out as Jev\'s does, under the pinned model', () => {
  const request: DecisionRequest = { state: { user_message: 'hi' }, questions: { 'effort.level': { type: 'noul', instructions: 'Is it hard?' } } }
  expect(drexRequest(request)).toEqual({ model: DREX_MODEL, state: request.state, questions: request.questions })
})

test('images go in a top-level array as data URLs, and the text calls each by its place in it', () => {
  const request: DecisionRequest = {
    state: { candidate: imageRef('candidate'), reference: imageRef('reference') },
    questions: { 'check.0': { type: 'noul', instructions: `Is the button in ${imageRef('candidate')} the same as in ${imageRef('reference')}?` } },
    images: [{ name: 'candidate', ...picture }, { name: 'reference', ...picture, format: 'jpeg' }],
  }
  expect(drexRequest(request)).toEqual({
    model: DREX_MODEL,
    state: { candidate: 'Image 1', reference: 'Image 2' },
    questions: { 'check.0': { type: 'noul', instructions: 'Is the button in Image 1 the same as in Image 2?' } },
    images: ['data:image/png;base64,AAAA', 'data:image/jpeg;base64,AAAA'],
  })
})

test('what Drex would answer 422 is refused before it is sent: a Box question, a ninth image', async () => {
  expect(() => drexRequest({ state: {}, questions: { 'box.0': { type: 'box', instructions: 'the button' } } })).toThrow(/no Box question/)
  const many = Array.from({ length: DREX_MAX_IMAGES + 1 }, (_, i) => ({ name: `frame-${i}`, ...picture }))
  expect(() => drexRequest({ state: { frames: many.map((image) => imageRef(image.name)) }, questions: { q: { type: 'noul', instructions: 'x' } }, images: many })).toThrow(/at most 8/)
  const asked = await drexBackend('nace_sk_test').ask({ fetch: async () => ({ status: 200, ok: true, headers: {}, text: '{}' }), sleep: async () => {} }, { state: {}, questions: { 'box.0': { type: 'box', instructions: 'x' } } }, 1000)
  expect(asked).toMatchObject({ ok: false, failure: { kind: 'request' } })
})

test('the criteria variant asks each check with both sides of the boundary and its images named, the mod\'s wording beside it, in one request', async () => {
  const { host } = imageHost(FILES)
  const planned = await visualCheckSuite(host).estimate?.(UI, 'zh', 'criteria', settings)
  expect(planned).toHaveLength(1)
  const body = drexRequest(planned?.[0] as DecisionRequest) as { state: unknown; questions: Record<string, { instructions: string; criteria?: { true: string; false: string } }>; images: string[] }
  expect(body.images).toHaveLength(2)
  expect(body.state).toEqual({ candidate: 'Image 1', reference: 'Image 2' })
  expect(Object.keys(body.questions)).toEqual(['check.0', 'plain.0'])
  expect(body.questions['check.0']?.instructions).toBe('Is the corner radius of the primary button in Image 1 the same as in Image 2?')
  expect(body.questions['check.0']?.criteria?.true).toMatch(/looks the same/)
  expect(body.questions['check.0']?.criteria?.false).toMatch(/visibly different/)
  expect(body.questions['plain.0']).toEqual({ type: 'noul', instructions: 'In `candidate`, is the corner radius of the primary button the same as in `reference`?' })
})

test('a motion is 8 of its frames in the criteria variant, the first and the last among them', async () => {
  const { host } = imageHost(FILES)
  const planned = await visualCheckSuite(host).estimate?.(ANIM, 'zh', 'criteria', settings)
  const body = drexRequest(planned?.[0] as DecisionRequest) as { state: { frames: { seconds: number; frame: string }[] }; questions: Record<string, { instructions: string; criteria?: unknown }>; images: string[] }
  expect(body.images).toHaveLength(8)
  expect(body.state.frames.map((frame) => frame.frame)).toEqual(['Image 1', 'Image 2', 'Image 3', 'Image 4', 'Image 5', 'Image 6', 'Image 7', 'Image 8'])
  expect([body.state.frames[0]?.seconds, body.state.frames[7]?.seconds]).toEqual([0, 1.1])
  expect(body.questions['check.0']?.instructions).toMatch(/^`frames` are 8 frames/)
  expect(body.questions['check.0']?.criteria).toBeDefined()
  // The mod's own way still sends Jev its twelve.
  expect((await visualCheckSuite(host).estimate?.(ANIM, 'zh', 'whole', settings))?.[0]?.images).toHaveLength(12)
})
