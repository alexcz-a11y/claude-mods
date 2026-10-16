// visual_check (#58 with #60): a recording is reported like a screenshot. Its checks are counted on the caller's row, its call is one
// decision in the log with the recording's path as the subject, and a failure (no ffmpeg, a failed request) is a note on the board
// and never a toast. Seam 1: the engine's tool call in; the board data, the toasts and the debug log out.

import { expect, test } from 'claude-code/testing'
import { ffmpeg, type FakeVideo } from './support/images.ts'
import { jev, KEY, world } from './support/world.ts'

const OPTIONS = { ...KEY, rejudgeEvery: 0 }
const REC = '/rec/transition.mov'
const VIDEOS: Record<string, FakeVideo> = { [REC]: { seconds: 3.5, width: 390, height: 844 } }
const CHECKS = [
  { part: 'the card', property: 'settles in its place without bouncing back' },
  { part: 'the card', property: 'stops at the middle of the screen' },
]
const SPEC = 'A card slides up from the bottom and stops at the middle of the screen.'

test('a recording\'s checks are counted on the caller\'s row and logged as one decision, with the recording as its subject', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, process: { programs: { ffmpeg: ffmpeg(VIDEOS) } }, backend: jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.95, 'check.1': 0.05 } }) })
  await w.start()
  await w.submit('做一个卡片上滑的转场')
  await w.step({ index: 0 })
  await w.visualCheck({ images: [REC], spec: SPEC, checks: CHECKS })

  const { main, log } = await w.board()
  expect(main?.visualChecks).toEqual({ passed: 1, failed: 1, unsure: 0 })
  const entries = log.filter((entry) => entry.feature === 'visual-check')
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({ agent: 'main', tone: 'warn', subject: REC, outcome: '核对 2：1 过 · 1 不过 · 0 没把握' })
  expect(entries[0]?.visualCheck).toMatchObject({ image: REC, against: { kind: 'spec', paths: [] }, backend: 'jev', zoomed: false })
  expect(JSON.stringify(await w.board())).not.toContain('data_base64')
  expect(w.toasts).toEqual([])
})

test('a recording that cannot be read (no ffmpeg) is counted as unsure and is a note on the board, without a toast', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, process: true, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.submit('做一个卡片上滑的转场')
  await w.step({ index: 0 })
  const before = w.requests.length
  await w.visualCheck({ images: [REC], spec: SPEC, checks: CHECKS })

  const { notes, main } = await w.board()
  expect(w.requests).toHaveLength(before)
  expect(w.toasts).toEqual([])
  expect(main?.visualChecks).toEqual({ passed: 0, failed: 0, unsure: 2 })
  expect(notes.filter((note) => note.feature === 'visual-check')).toMatchObject([{ id: 'main', kind: 'skipped', why: 'error' }])
})

test('a failed request for the frames of a recording is a note on the board, without a toast, and the checks are unsure', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, process: { programs: { ffmpeg: ffmpeg(VIDEOS) } }, backend: (request) => (request.body?.questions?.['check.0'] === undefined ? jev([0, 1, 0, 0, 0])(request) : { status: 500, body: 'down' }) })
  await w.start()
  await w.submit('做一个卡片上滑的转场')
  await w.step({ index: 0 })
  await w.visualCheck({ images: [REC], spec: SPEC, checks: CHECKS })

  const { notes, main, log } = await w.board()
  expect(w.toasts).toEqual([])
  expect(notes.filter((note) => note.feature === 'visual-check')).toMatchObject([{ id: 'main', kind: 'failed' }])
  expect(main?.visualChecks).toEqual({ passed: 0, failed: 0, unsure: 2 })
  expect(log.find((entry) => entry.feature === 'visual-check')).toMatchObject({ tone: 'fail', subject: REC })
})
