// visual_check (#59): against a reference or another screenshot the first request also locates things. Beside the Noul of each check
// it holds the Box questions: each named part in both images, and one for the whole screen, where the two differ. Seam 1, as
// visual-check.test.ts: the world's backend answers, and a test reads the request that went out.

import { expect, test } from 'claude-code/testing'
import { zoomBackend } from './support/zoom.ts'
import { pplx, world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }
const SHOT = '/shots/home.png'
const DESIGN = '/design/home.png'
const BEFORE = '/shots/before.png'
const FILES = {
  [SHOT]: { format: 'png', width: 1000, height: 1000 },
  [DESIGN]: { format: 'png', width: 1000, height: 1000 },
  [BEFORE]: { format: 'png', width: 1000, height: 1000 },
  '/photos/side.png': { format: 'png', width: 800, height: 600 },
  '/photos/front.png': { format: 'png', width: 800, height: 600 },
}
const BUTTON = { part: 'the primary button', property: 'corner radius' }
const TAB_BAR = { part: 'the tab bar', property: 'color' }

test('against a reference the first request holds, beside the Noul of each check, a Box for each named part in both images and one for where the images differ', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend() })
  await w.start()
  await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON, TAB_BAR] })

  const first = w.requests[0]?.body
  expect(first.model).toBe('jev-1.14.0')
  expect(first.questions).toEqual({
    'check.0': { type: 'noul', instructions: 'In `candidate`, is the corner radius of the primary button the same as in `reference`?' },
    'check.1': { type: 'noul', instructions: 'In `candidate`, is the color of the tab bar the same as in `reference`?' },
    'box.0.candidate': { type: 'box', instructions: 'The primary button in `candidate`.' },
    'box.0.reference': { type: 'box', instructions: 'The primary button in `reference`.' },
    'box.1.candidate': { type: 'box', instructions: 'The tab bar in `candidate`.' },
    'box.1.reference': { type: 'box', instructions: 'The tab bar in `reference`.' },
    'where.screen': { type: 'box', instructions: 'The region of `candidate` that differs from `reference`.' },
  })
  // The images are in it once, as before.
  expect(Object.keys(first.assets)).toHaveLength(2)
})

test('against another screenshot the boxes are about `other`', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend() })
  await w.start()
  await w.visualCheck({ images: [SHOT], compare_to: BEFORE, checks: [BUTTON] })

  const questions = w.requests[0]?.body.questions
  expect(questions['box.0.other']).toEqual({ type: 'box', instructions: 'The primary button in `other`.' })
  expect(questions['where.screen']).toEqual({ type: 'box', instructions: 'The region of `candidate` that differs from `other`.' })
})

test('against a spec, or against nothing, there is nothing to locate: no Box questions', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend() })
  await w.start()
  await w.visualCheck({ images: [SHOT], spec: 'The Home screen.', checks: [BUTTON] })
  await w.visualCheck({ images: [SHOT], checks: [BUTTON] })

  expect(w.requests).toHaveLength(2)
  for (const request of w.requests) expect(Object.values(request.body.questions).map((question: any) => question.type)).toEqual(['noul'])
})

test('with pplx, which has no Box question, the request is as it was and there is no second one', { options: { perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: pplx([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] })

  expect(w.requests).toHaveLength(1)
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['check.0'])
})

test('a check that names no part has no Box: there is nothing to cut out', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend() })
  await w.start()
  await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: ['everything is the same'] })

  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['check.0', 'where.screen'])
})

test('several references show the object from different sides, so the named part is boxed in each of them and there is no whole-screen "where"', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend() })
  await w.start()
  await w.visualCheck({ images: [SHOT], reference: ['/photos/side.png', '/photos/front.png'], checks: [{ part: 'the handle', property: 'shape' }] })

  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['check.0', 'box.0.candidate', 'box.0.reference-1', 'box.0.reference-2'])
})

test('when the images do not show the same view (said so, or by their shapes) there is no whole-screen "where": everything would differ', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend() })
  await w.start()
  await w.visualCheck({ images: [SHOT], reference: [DESIGN], same_view: false, checks: [BUTTON] })
  await w.visualCheck({ images: [SHOT], reference: ['/photos/side.png'], checks: [BUTTON] })

  const asked = w.requests.filter((request) => 'box.0.candidate' in request.body.questions)
  expect(asked).toHaveLength(2)
  for (const request of asked) expect(Object.keys(request.body.questions)).not.toContain('where.screen')
})
