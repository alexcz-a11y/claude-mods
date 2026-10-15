// visual_check (#57): the screenshot checked against a reference image, several of them, or another screenshot. Seam 1, as
// visual-check.test.ts. Until the zoomed re-check (#59) only a FAIL is taken from the whole images; a match is unsure.

import { expect, test } from 'claude-code/testing'
import { readFake } from './support/images.ts'
import { jev, world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }

const SHOT = '/shots/home.png'
const DESIGN = '/design/home.png'
const BEFORE = '/shots/before.png'
const FILES = {
  [SHOT]: { format: 'png', width: 1200, height: 800 },
  [DESIGN]: { format: 'png', width: 1000, height: 700 },
  [BEFORE]: { format: 'png', width: 1200, height: 800 },
  '/photos/side.png': { format: 'png', width: 900, height: 600 },
  '/photos/front.png': { format: 'png', width: 900, height: 600 },
}
const CORNERS = { part: 'the primary button', property: 'corner radius' }

test('against a reference the screenshot is the candidate, the design the reference, and each check asks whether the property is the same in both', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.5 } }) })
  await w.start()
  await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [CORNERS] })

  expect(w.requests).toHaveLength(1)
  const body = w.requests[0]?.body
  const references = Object.keys(body.assets)
  expect(references.map((key) => key.slice(37))).toEqual(['candidate', 'reference'])
  expect(body.state).toEqual({ candidate: references[0], reference: references[1] })
  expect(readFake(body.assets[references[0] as string].data_base64)).toMatchObject({ width: 1200, height: 800 })
  expect(readFake(body.assets[references[1] as string].data_base64)).toMatchObject({ width: 1000, height: 700 })
  expect(body.questions).toEqual({
    'check.0': { type: 'noul', instructions: 'In `candidate`, is the corner radius of the primary button the same as in `reference`?' },
  })
})

test('with a reference only a FAIL is taken from the whole images: a high probability of a match is UNSURE, and says why', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.97, 'check.1': 0.1 } }) })
  await w.start()
  const answer = await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [CORNERS, { part: 'the tab bar', property: 'color' }] })

  const blocks = answer.result as { type: string; text?: string }[]
  expect(blocks.map((block) => block.type)).toEqual(['text', 'image'])
  expect(blocks[0]?.text?.split('\n').slice(0, 3)).toEqual([
    'Visual check of /shots/home.png against the reference: 1 FAIL, 1 UNSURE.',
    '1. UNSURE 0.97 (whole image) the primary button: corner radius (a match with a reference cannot be confirmed from the whole image)',
    '2. FAIL 0.10 (whole image) the tab bar: color',
  ])
})

test('against another screenshot the other is named `other`, and the same rules hold', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.05 } }) })
  await w.start()
  const answer = await w.visualCheck({ images: [SHOT], compare_to: BEFORE, checks: [CORNERS] })

  const body = w.requests[0]?.body
  expect(Object.keys(body.assets).map((key) => key.slice(37))).toEqual(['candidate', 'other'])
  expect(body.questions['check.0'].instructions).toBe('In `candidate`, is the corner radius of the primary button the same as in `other`?')
  expect((answer.result as { text?: string }[])[0]?.text).toContain('against the other screenshot: 1 FAIL.')
})

test('several reference images (photos of the object from different sides) are all in the request, and the question names them all', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: [SHOT], reference: ['/photos/side.png', '/photos/front.png'], checks: [{ part: 'the handle', property: 'shape' }] })

  const body = w.requests[0]?.body
  expect(Object.keys(body.assets).map((key) => key.slice(37))).toEqual(['candidate', 'reference-1', 'reference-2'])
  expect(body.questions['check.0'].instructions).toBe(
    'In `candidate`, is the shape of the handle the same as in the reference images (`reference-1`, `reference-2`), which show it from different sides?',
  )
})
