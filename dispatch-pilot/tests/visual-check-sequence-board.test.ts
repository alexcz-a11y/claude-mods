// visual_check with a series of quality levels (#61) on the board and in the decision log (#58): one entry for the call, with every
// check of every pair in it and which two levels the pair is, in the person's words; the count is of the checks made (a check on each
// pair); a request that fails is a note, never a toast. Seam 1: engine events in; the board data (`w.board()`) and the toasts out.

import { expect, test } from 'claude-code/testing'
import { level, levels, seriesBackend } from './support/series.ts'
import { world } from './support/world.ts'

const OPTIONS = { decisionModel: 'jev', typesafeApiKey: 'ts-test-key', rejudgeEvery: 0 }
const FOAM = { part: 'the waves near the horizon', property: 'foam density' }
const SUN = { part: 'the reflection of the sun', property: 'brightness' }

test('the log has one entry for the series: every check of every pair, with its two levels, and the count of them', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, files: levels(3), process: true, backend: seriesBackend({ zoom: { '1-2': { 'zoom.0.0': 0.1, 'zoom.1.0': 0.95 }, '2-3': 0.95 } }) })
  await w.start()
  await w.submit('把海面画质调到够用')
  await w.step({ index: 0 })
  await w.visualCheck({ images: [level(1), level(2), level(3)], sequence: true, checks: [FOAM, SUN] })

  const { log, main } = await w.board()
  const entries = log.filter((one) => one.feature === 'visual-check')
  expect(entries).toHaveLength(1)
  const entry = entries[0]
  expect(entry).toMatchObject({ subject: '/levels/1.png', outcome: '核对 4：3 过 · 1 不过 · 0 没把握', tone: 'warn' })
  expect(entry?.visualCheck?.against).toEqual({ kind: 'sequence', paths: ['/levels/1.png', '/levels/2.png', '/levels/3.png'] })
  expect(entry?.visualCheck?.checks.map((check) => [check.pair, check.part, check.verdict, check.probability, check.zoomed])).toEqual([
    [[1, 2], FOAM.part, 'fail', 0.1, true],
    [[1, 2], SUN.part, 'pass', 0.95, true],
    [[2, 3], FOAM.part, 'pass', 0.95, true],
    [[2, 3], SUN.part, 'pass', 0.95, true],
  ])
  expect(entry?.reason).toContain('档 1→2 · the waves near the horizon · foam density 不过 10%（放大复核）')
  expect(entry?.reason).toContain('档 2→3 · the reflection of the sun · brightness 过 95%（放大复核）')
  expect(entry?.reason).toContain('做了放大复核')
  expect(main?.visualChecks).toEqual({ passed: 3, failed: 1, unsure: 0 })
})

test('a request of a pair that fails is a note on the board and a failed entry, never a toast', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, files: levels(3), process: true, backend: seriesBackend({ zoom: { '1-2': 0.95 }, reply: { '2-3': { status: 500, body: 'down' } } }) })
  await w.start()
  await w.submit('把海面画质调到够用')
  await w.step({ index: 0 })
  await w.visualCheck({ images: [level(1), level(2), level(3)], sequence: true, checks: [FOAM] })

  const { notes, main, log } = await w.board()
  expect(w.toasts).toEqual([])
  expect(notes.filter((note) => note.feature === 'visual-check')).toMatchObject([{ id: 'main', kind: 'failed' }])
  expect(log.find((entry) => entry.feature === 'visual-check')).toMatchObject({ tone: 'fail', outcome: '核对 2：1 过 · 0 不过 · 1 没把握' })
  expect(main?.visualChecks).toEqual({ passed: 1, failed: 0, unsure: 1 })
})

test('a series that could not be read is a failed entry with the checks unsure, and a note', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, files: levels(2), process: true, backend: seriesBackend() })
  await w.start()
  await w.submit('把海面画质调到够用')
  await w.step({ index: 0 })
  await w.visualCheck({ images: [level(1), level(2), '/levels/missing.png'], sequence: true, checks: [FOAM] })

  const { notes, main, log } = await w.board()
  expect(w.toasts).toEqual([])
  expect(log.find((entry) => entry.feature === 'visual-check')).toMatchObject({ tone: 'fail', outcome: '核对 1：0 过 · 0 不过 · 1 没把握' })
  expect(notes.filter((note) => note.feature === 'visual-check')).toMatchObject([{ id: 'main', kind: 'skipped' }])
  expect(main?.visualChecks).toEqual({ passed: 0, failed: 0, unsure: 1 })
  // The checks belong to no pair: the log does not name two levels for them.
  expect(log.find((entry) => entry.feature === 'visual-check')?.visualCheck?.checks.map((check) => check.pair)).toEqual([undefined])
})
