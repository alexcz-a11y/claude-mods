// A result file's summary brought up to the metrics of now from the answers
// it holds, without asking again (seam 2: eval/lib/resummarize.ts, which
// eval/resummarize.ts runs on the files). The expected numbers are worked out
// by hand below.

import { expect, test } from 'claude-code/testing'
import { resummarize, resummarizeAll } from '../eval/lib/resummarize.ts'

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

// eval/resummarize.ts with no arguments reads every JSON under results/<suite>/, and not all of them are runs: the flow
// files of eval-v2-flow/ and the scans of eval-v2/ (compare.json, thresholds-*.json) hold no summary of variants.
test('files that are no result (a flow file, a scan, text that is not JSON, a summary without the mod\'s timeout) are skipped with the reason, nothing throws, and the results among them are brought up to date', () => {
  const { settings: _settings, ...noSettings } = stored()
  const files = [
    { file: 'run.json', text: JSON.stringify(stored()) },
    { file: 'flow.json', text: JSON.stringify({ suite: 'eval-v2-flow', about: 'flow', items: {} }) },
    { file: 'thresholds.json', text: JSON.stringify({ suite: 'eval-v2-thresholds', rows: [] }) },
    { file: 'list.json', text: '[]' },
    { file: 'broken.json', text: '{"suite": ' },
    { file: 'no-settings.json', text: JSON.stringify(noSettings) },
  ]
  const { done, skipped } = resummarizeAll(files, '2026-10-14')
  expect(done.map((one) => one.file)).toEqual(['run.json'])
  expect(done[0]?.after.resummarized.date).toBe('2026-10-14')
  expect(done[0]?.after.summary.variants[0]?.zh).toMatchObject({ late: 1, retried: 1, inTime: 0 })
  expect(skipped.map((one) => one.file)).toEqual(['flow.json', 'thresholds.json', 'list.json', 'broken.json', 'no-settings.json'])
  expect(skipped.every((one) => one.why !== '')).toBe(true)
})

test("an item that sent two requests (the skill suite's two stages, in stages_ms) is retried only past two attempts", () => {
  const result = stored()
  const first = result.answers[0] as Record<string, unknown>
  first['en-score'] = { answer: 'high', correct: true, ms: 300, attempts: 2, stages_ms: [200, 100] }
  expect(resummarize(result, '2026-10-05').summary.variants[0]?.zh.retried).toBe(0)
  first['en-score'] = { answer: 'high', correct: true, ms: 300, attempts: 3, stages_ms: [200, 100] }
  expect(resummarize(result, '2026-10-05').summary.variants[0]?.zh.retried).toBe(1)
})

// A visual-check result is shaped differently from the others: one language, the number of requests an answer took is the
// length of its `requests` (the zoomed re-check is a second one), and a run with --repeat has a line for each time of the
// run. Reading it as the others used to count the second request as a retry and every time as the first.
const checks = (ms: number, attempts: number, requests: number) => ({ answer: 'PASS', correct: true, ms, attempts, requests: Array.from({ length: requests }, () => ({ questions: 3 })) })
function visualCheck() {
  const language = (inTime: number, late: number) => ({ items: 2, answered: 2, failed: 0, accuracy: 1, exact: 0.5, misses: {}, late, retried: 0, inTime })
  const empty = { items: 2, answered: 0, failed: 0, accuracy: 0, exact: 0, misses: {}, late: 0, retried: 0, inTime: 0 }
  return {
    suite: 'visual-check',
    settings: { timeoutMs: 1500 },
    // The first time: one answer in 900 ms, one past the mod's wait; the second time: both in time.
    summary: { items: 2, variants: [{ variant: 'mod', zh: language(0.5, 1), en: empty, gap: 1, pass: true }], constants: [] },
    repeatSummaries: [{ items: 2, variants: [{ variant: 'mod', zh: language(1, 0), en: empty, gap: 1, pass: true }], constants: [] }],
    answers: [
      { id: 'a', language: 'zh', repeat: 1, state: {}, mod: checks(900, 1, 1) },
      { id: 'b', language: 'zh', repeat: 1, state: {}, mod: checks(1800, 2, 2) },
      { id: 'a', language: 'zh', repeat: 2, state: {}, mod: checks(800, 1, 1) },
      { id: 'b', language: 'zh', repeat: 2, state: {}, mod: checks(1400, 2, 2) },
    ],
  }
}

test('a visual-check result is already up to date: two requests are not a retry, and each time of a --repeat run is summarized from its own lines', () => {
  const before = visualCheck()
  const after = resummarize(before, '2026-10-15')
  expect(after.summary).toEqual(before.summary)
  expect(after.repeatSummaries).toEqual(before.repeatSummaries)
  const { done } = resummarizeAll([{ file: 'visual-check.json', text: JSON.stringify(before) }], '2026-10-15')
  expect(done.map((one) => one.changed)).toEqual([false])
})

test('a summary that is out of date is changed, and the repeat summaries with it: the lines of the first time do not count in the second', () => {
  const before = visualCheck()
  const first = before.summary.variants[0] as { zh: { late: number; inTime: number } }
  first.zh.late = 0
  first.zh.inTime = 1
  const { done } = resummarizeAll([{ file: 'visual-check.json', text: JSON.stringify(before) }], '2026-10-15')
  expect(done.map((one) => one.changed)).toEqual([true])
  expect(done[0]?.after.summary.variants[0]?.zh).toMatchObject({ late: 1, retried: 0, inTime: 0.5 })
  expect(done[0]?.after.repeatSummaries?.[0]?.variants[0]?.zh).toMatchObject({ late: 0, retried: 0, inTime: 1 })
})

test('a run of one language has no gap and no pass (null): they stay null, and the file still counts as a result', () => {
  const before = visualCheck()
  const variant = before.summary.variants[0] as { gap: number | null; pass: boolean | null }
  variant.gap = null
  variant.pass = null
  const { done, skipped } = resummarizeAll([{ file: 'one-language.json', text: JSON.stringify(before) }], '2026-10-15')
  expect(skipped).toEqual([])
  expect([done[0]?.after.summary.variants[0]?.gap, done[0]?.after.summary.variants[0]?.pass]).toEqual([null, null])
})
