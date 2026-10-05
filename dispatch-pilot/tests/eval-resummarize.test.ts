// A result file's summary brought up to the metrics of now from the answers
// it holds, without asking again (seam 2: eval/lib/resummarize.ts, which
// eval/resummarize.ts runs on the files). The expected numbers are worked out
// by hand below.

import { expect, test } from 'claude-code/testing'
import { resummarize } from '../eval/lib/resummarize.ts'

/** A language's summary as an older run wrote it: no late, retried or inTime. */
const older = (items: number, accuracy: number) => ({ items, answered: items, failed: 0, accuracy, exact: accuracy, misses: {} })

/** A stored result: the mod's wait, two variants' summaries, and the answers the file keeps (one line per item and language). */
function stored() {
  return {
    suite: 'effort-submit',
    settings: { timeoutMs: 1500 },
    summary: {
      items: 2,
      variants: [
        { variant: 'en-score', zh: older(2, 0.5), en: older(2, 0.54), gap: -0.04, pass: false, agreement: { items: 2, same: 2, rate: 1 } },
        { variant: 'zh-score', zh: older(2, 0.5), en: older(2, 0.5401), gap: -0.0401, pass: true },
      ],
      constants: [],
    },
    answers: [
      // a in Chinese: right in 300 ms, but only at the second attempt; b in Chinese: right, but in 1600 ms.
      { id: 'a', language: 'zh', state: {}, 'en-score': { answer: 'high', correct: true, ms: 300, attempts: 2 }, 'zh-score': { answer: 'high', correct: true, ms: 300, attempts: 1 } },
      { id: 'b', language: 'zh', state: {}, 'en-score': { answer: 'high', correct: true, ms: 1600, attempts: 1 }, 'zh-score': { answer: 'low', correct: false, ms: 200, attempts: 1 } },
      // a in English: right in time; b in English: no answer after three attempts (not counted as retried: no answer to count).
      { id: 'a', language: 'en', state: {}, 'en-score': { answer: 'high', correct: true, ms: 200, attempts: 1 }, 'zh-score': { answer: 'high', correct: true, ms: 200, attempts: 1 } },
      { id: 'b', language: 'en', state: {}, 'en-score': { correct: false, attempts: 3, failure: 'timeout: no answer in 10000 ms' }, 'zh-score': { answer: 'high', correct: true, ms: 250, attempts: 1 } },
    ],
  }
}

test("each language gets late, retried and inTime from the stored answers: a retried answer is no decision in time, however fast", () => {
  const [enScore] = resummarize(stored(), '2026-10-05').summary.variants
  expect(enScore?.zh).toEqual({ ...older(2, 0.5), late: 1, retried: 1, inTime: 0 })
  expect(enScore?.en).toEqual({ ...older(2, 0.54), late: 0, retried: 0, inTime: 0.5 })
})

test('each variant passes again by the bar of now: 4.0 points below passes, 4.01 does not', () => {
  const [enScore, zhScore] = resummarize(stored(), '2026-10-05').summary.variants
  expect([enScore?.gap, enScore?.pass]).toEqual([-0.04, true])
  expect([zhScore?.gap, zhScore?.pass]).toEqual([-0.0401, false])
})

test('the rest of the file stays as the run wrote it, and a note says what was brought up to date and when', () => {
  const before = stored()
  const after = resummarize(before, '2026-10-05')
  expect(after.answers).toEqual(before.answers)
  expect(after.summary.variants[0]?.agreement).toEqual({ items: 2, same: 2, rate: 1 })
  expect(after.resummarized).toMatchObject({ date: '2026-10-05', by: 'eval/resummarize.ts' })
  // The language summaries keep the order the metrics write them in.
  expect(Object.keys(after.summary.variants[0]?.zh ?? {})).toEqual(['items', 'answered', 'failed', 'accuracy', 'exact', 'misses', 'late', 'retried', 'inTime'])
})

test("an item that sent two requests (the skill suite's two stages, in stages_ms) is retried only past two attempts", () => {
  const result = stored()
  const first = result.answers[0] as Record<string, unknown>
  first['en-score'] = { answer: 'high', correct: true, ms: 300, attempts: 2, stages_ms: [200, 100] }
  expect(resummarize(result, '2026-10-05').summary.variants[0]?.zh.retried).toBe(0)
  first['en-score'] = { answer: 'high', correct: true, ms: 300, attempts: 3, stages_ms: [200, 100] }
  expect(resummarize(result, '2026-10-05').summary.variants[0]?.zh.retried).toBe(1)
})
