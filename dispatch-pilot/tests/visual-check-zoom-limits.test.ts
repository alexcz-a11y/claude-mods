// visual_check (#59): the zoomed re-check keeps to what a request holds. The first request has at most 64 questions, so the checks
// that do not fit are not located; the crops of the second cost Jev about 2,600 tokens a megapixel and a request holds 64k, so they
// are split over as many requests as that takes, sent at once. And comparePair, which the quality series (#61) calls for any two
// images, does the whole of it from the Box questions to the verdicts. Seam 1 for the tool, and the function itself for comparePair
// (it takes closures, as the eval's suite does).

import { expect, test } from 'claude-code/testing'
import { type ImageFilesIo, loadImage } from '../hooks/core/image-files.ts'
import { comparePair, type ZoomDeps } from '../hooks/core/zoom-review.ts'
import { JEV_IMAGE_LIMITS } from '../hooks/decision/image-fit.ts'
import type { Answer, DecisionRequest } from '../hooks/decision/system-one.ts'
import { BASE_DIRS, type FakeFile, fileBase64, sips } from './support/images.ts'
import { zoomBackend } from './support/zoom.ts'
import { world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }
const SHOT = '/shots/home.png'
const DESIGN = '/design/home.png'
const FILES = {
  [SHOT]: { format: 'png', width: 1000, height: 1000 },
  [DESIGN]: { format: 'png', width: 1000, height: 1000 },
}

const parts = (count: number) => Array.from({ length: count }, (_, i) => ({ part: `part ${i + 1}`, property: 'shape' }))

test('the crops of many checks are split over requests that each hold what Jev takes of images (about 48k tokens), sent at once', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ zoom: 0.95 }) })
  await w.start()
  // The default boxes cover the middle half of the image: crops of 650 x 650, enlarged to 1000 x 1000, 1 megapixel and 2,600 tokens each, 5,200 for a pair.
  const answer = (await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: parts(12) })).result as { text: string }[]

  expect(w.requests).toHaveLength(3)
  const zoom = w.requests.slice(1).map((request) => Object.keys(request.body.questions))
  expect(zoom.map((ids) => ids.length)).toEqual([9, 3])
  expect(zoom.flat()).toEqual(Array.from({ length: 12 }, (_, i) => `zoom.${i}.0`))
  for (const request of w.requests.slice(1)) expect(Object.keys(request.body.assets).length * 2600).toBeLessThanOrEqual(48_000)
  expect(answer[0]?.text).toContain('12 PASS')
})

test('a request holds 64 questions: the checks that do not fit with their Boxes are not located, and fall back on the whole images with the reason', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ zoom: 0.95, whole: Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`check.${i}`, 0.97])) }) })
  await w.start()
  const answer = (await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: parts(24) })).result as { text: string }[]

  // 24 Noul, one Box for the whole screen, and two Boxes each for the 19 checks that fit: 63.
  expect(Object.keys(w.requests[0]?.body.questions)).toHaveLength(63)
  const lines = (answer[0]?.text ?? '').split('\n')
  expect(lines[19]).toBe('19. PASS 0.95 (zoomed crop) part 19: shape')
  expect(lines[20]).toBe('20. UNSURE 0.97 (whole image) part 20: shape (there are too many checks to locate every part in one request; a match with a reference cannot be confirmed from the whole image)')
  expect(lines[24]).toContain('24. UNSURE 0.97 (whole image) part 24: shape (there are too many checks')
})

// ---- comparePair -------------------------------------------------------------------------------------------------------

/** The closures of a call, over a disk of the test's own (the test module has no `$.process` of its own: the programs are the world's, run on its files). */
function filesOf(disk: Map<string, FakeFile>): ImageFilesIo {
  let count = 0
  const dirs = new Set([...BASE_DIRS, '/tmp/pair'])
  return {
    run: async (argv) => sips(argv.slice(1), { files: disk, dirs }),
    readBytes: async (path) => fileBase64(disk.get(path) as FakeFile),
    newFile: async (extension) => `/tmp/pair/image-${++count}.${extension}`,
  }
}

test('comparePair locates the parts in a pair of images, cuts the crops and judges each part on them, for any pair', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: { '/levels/low.png': { format: 'png', width: 1200, height: 800 }, '/levels/high.png': { format: 'png', width: 1200, height: 800 } }, process: true })
  await w.start()
  const files = filesOf(w.files)
  const [low, high] = await Promise.all(['/levels/low.png', '/levels/high.png'].map((path) => loadImage(files, path, JEV_IMAGE_LIMITS)))
  if (!low?.ok || !high?.ok) throw new Error(`the images did not load: ${JSON.stringify([low, high])}`)

  const asked: DecisionRequest[] = []
  const answers = (request: DecisionRequest): Record<string, Answer> =>
    Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [
        id,
        question.type === 'box'
          ? ({ type: 'box', box: id === 'where.screen' ? { top: 0.1, bottom: 0.3, left: 0.1, right: 0.4 } : { top: 0.5, bottom: 0.7, left: 0.5, right: 0.7 }, confidence: id === 'where.screen' ? 0.3 : 0.9 } as Answer)
          : ({ type: 'noul', noul: id === 'zoom.0.0' ? 0.97 : 0.1 } as Answer),
      ]),
    )
  const deps: ZoomDeps = {
    files,
    backend: 'jev',
    ask: async (request) => {
      asked.push(request)
      return { ok: true, answers: answers(request), model: 'jev-1.14.0', inputTokens: 100 }
    },
  }
  const outcome = await comparePair(deps, { candidate: high.image, other: low.image, sameView: null }, [
    { part: 'the waves near the horizon', property: 'foam density' },
    { part: 'the reflection of the sun', property: 'brightness' },
    { part: '', property: 'the overall mood' },
  ])

  // One request for the Boxes (both images in it, a Box for each part in each, one for where they differ), then one for the crops.
  expect(asked.map((request) => Object.keys(request.questions))).toEqual([
    ['box.0.candidate', 'box.0.other', 'box.1.candidate', 'box.1.other', 'where.screen'],
    ['zoom.0.0', 'zoom.1.0'],
  ])
  expect(outcome.results.map((result) => [result.verdict, result.probability, result.basis])).toEqual([
    ['pass', 0.97, 'zoom'],
    ['fail', 0.1, 'zoom'],
    ['unsure', null, 'whole'],
  ])
  expect(outcome.results[2]?.why).toBe('the check names no part of the image, so there is nothing to cut out; the whole images were not compared')
  // The part that differs brings its crops; so does the other place, 0.3 sure and a sixth of the screen.
  expect(outcome.failed.map((one) => one.index)).toEqual([1])
  expect(outcome.elsewhere?.place.confidence).toBe(0.3)
  expect(outcome.elsewhere?.candidate?.file).toMatch(/^\/tmp\/pair\/image-\d+\.png$/)
})

test('comparePair never throws: where the Boxes cannot be asked for, every check is unsure with the reason', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: { '/levels/low.png': { format: 'png', width: 1200, height: 800 }, '/levels/high.png': { format: 'png', width: 1200, height: 800 } }, process: true })
  await w.start()
  const files = filesOf(w.files)
  const [low, high] = await Promise.all(['/levels/low.png', '/levels/high.png'].map((path) => loadImage(files, path, JEV_IMAGE_LIMITS)))
  if (!low?.ok || !high?.ok) throw new Error(`the images did not load: ${JSON.stringify([low, high])}`)

  const deps: ZoomDeps = { files, backend: 'jev', ask: async () => ({ ok: false, failure: { kind: 'timeout', detail: 'no answer in 8000 ms' } }) }
  const outcome = await comparePair(deps, { candidate: high.image, other: low.image, sameView: true }, [{ part: 'the sea', property: 'foam' }])

  expect(outcome.results).toEqual([{ check: { part: 'the sea', property: 'foam' }, verdict: 'unsure', probability: null, basis: 'whole', why: 'the parts could not be located (jev: no answer in 8000 ms)' }])
})
