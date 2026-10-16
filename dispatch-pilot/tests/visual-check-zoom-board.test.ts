// visual_check (#59) on the board and in the decision log (#58): the log says, check by check and for the call, whether the verdict rests
// on the zoomed re-check; a request of the re-check that fails is a note on the board like the first one, never a toast. Seam 1:
// engine events in; the board data (`w.board()`) and the toasts out.

import { expect, test } from 'claude-code/testing'
import { zoomBackend } from './support/zoom.ts'
import { KEY, world } from './support/world.ts'

const OPTIONS = { ...KEY, rejudgeEvery: 0 }
const SHOT = '/shots/home.png'
const DESIGN = '/design/home.png'
const FILES = {
  [SHOT]: { format: 'png', width: 1000, height: 1000 },
  [DESIGN]: { format: 'png', width: 1000, height: 1000 },
}
const CHECKS = [
  { part: 'the primary button', property: 'corner radius' },
  { part: 'the title', property: 'font weight' },
]

test('the log says which checks rest on the zoomed re-check, and the call did a re-check if any did', { options: OPTIONS }, async ($, on) => {
  // The first check is judged on its crops; the second names no part, so only the whole images speak for it.
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ zoom: { 'zoom.0.0': 0.1 } }) })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [CHECKS[0] as (typeof CHECKS)[number], 'the layout is the same'] })

  const { log, main } = await w.board()
  const entry = log.find((one) => one.feature === 'visual-check')
  expect(entry?.visualCheck?.zoomed).toBe(true)
  expect(entry?.visualCheck?.checks.map((check) => [check.verdict, check.probability, check.zoomed])).toEqual([
    ['fail', 0.1, true],
    ['unsure', 0.5, false],
  ])
  expect(entry?.reason).toContain('the primary button · corner radius 不过 10%（放大复核）')
  expect(entry?.reason).toContain('做了放大复核')
  expect(main?.visualChecks).toEqual({ passed: 0, failed: 1, unsure: 1 })
})

test('a call whose re-check could not be made says so: no re-check was done', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ whole: { 'check.0': 0.97, 'check.1': 0.97 } , zoomReply: { status: 200, body: { answers: {} } } }) })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: CHECKS })

  const entry = (await w.board()).log.find((one) => one.feature === 'visual-check')
  expect(entry?.visualCheck?.zoomed).toBe(false)
  expect(entry?.reason).toContain('没有放大复核')
})

test('a request of the re-check that fails is a note on the board and a failed entry, never a toast', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ zoomReply: { status: 500, body: 'down' } }) })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: CHECKS })

  const { notes, main, log } = await w.board()
  expect(w.toasts).toEqual([])
  expect(notes.filter((note) => note.feature === 'visual-check')).toMatchObject([{ id: 'main', kind: 'failed' }])
  expect(log.find((entry) => entry.feature === 'visual-check')).toMatchObject({ tone: 'fail', outcome: '核对 2：0 过 · 0 不过 · 2 没把握' })
  expect(main?.visualChecks).toEqual({ passed: 0, failed: 0, unsure: 2 })
  expect(main?.failure).toBeUndefined()
})
