// The eval's metrics (seam 2): from the graded answers to what a run
// reports. The expected numbers are worked out by hand below.

import { expect, test } from 'claude-code/testing'
import type { Effort } from '../hooks/decision/effort.ts'
import type { EffortSubmitItem } from '../eval/lib/datasets.ts'
import { effortSubmit } from '../eval/lib/effort-submit.ts'
import { summarize } from '../eval/lib/metrics.ts'
import type { Row } from '../eval/lib/runner.ts'

function item(id: string, gold: Effort, accept: Effort[], tags: string[]): EffortSubmitItem {
  const asked = { message: id, recent_context: [] }
  return { id, zh: asked, en: asked, gold, accept, rationale: '理由', difficulty: 'hard', tags }
}

const ITEMS = [
  item('a', 'high', ['high', 'xhigh'], ['debug']),
  item('b', 'low', ['low'], ['trivial']),
  item('c', 'medium', ['medium', 'high'], ['debug', 'follow-up']),
  item('d', 'max', ['max'], ['security']),
]

/** An answer as the runner records it, graded by the suite. */
function row(id: string, language: 'zh' | 'en', effort: Effort | null, ms: number | null): Row<Effort> {
  const it = ITEMS.find((i) => i.id === id) as EffortSubmitItem
  const grade = effort === null ? { correct: false, exact: false } : effortSubmit.grade(it, effort)
  return {
    id,
    language,
    variant: 'en-score',
    ok: effort !== null,
    prediction: effort,
    shown: effort,
    correct: grade.correct,
    exact: grade.exact,
    miss: grade.correct ? null : (grade.miss ?? null),
    failure: effort === null ? 'timeout: no answer in 10000 ms' : null,
    detail: null,
    ms,
    attempts: 1,
    inputTokens: 700,
    model: 'jev-1.13.0',
    state: null,
  }
}

const ROWS = [
  row('a', 'zh', 'xhigh', 300), // right
  row('a', 'en', 'high', 200), // right, gold
  row('b', 'zh', 'medium', 500), // wrong: over
  row('b', 'en', 'low', 100), // right, gold
  row('c', 'zh', 'medium', 400), // right, gold
  row('c', 'en', 'medium', 600), // right, gold
  row('d', 'zh', null, null), // no answer: wrong
  row('d', 'en', 'xhigh', 700), // wrong: under
]

test('accuracy counts an unanswered item as wrong; gold hits, misses, the zh-en gap and agreement come beside it', () => {
  const [summary] = summarize(effortSubmit, ITEMS, ROWS, { slowMs: 500 }).variants
  expect(summary?.variant).toBe('en-score')
  // zh: a and c acceptable of 4; c is gold; d failed; b went over. Every answer came within 500 ms.
  expect(summary?.zh).toEqual({ items: 4, answered: 3, failed: 1, accuracy: 0.5, exact: 0.25, misses: { over: 1 }, late: 0, inTime: 0.5 })
  // en: a, b, c acceptable and gold; d went under. c (600 ms) and d (700 ms) came after 500 ms.
  expect(summary?.en).toEqual({ items: 4, answered: 4, failed: 0, accuracy: 0.75, exact: 0.75, misses: { under: 1 }, late: 2, inTime: 0.5 })
  // Chinese is 25 points below English: past the 4-point bar.
  expect(summary?.gap).toBe(-0.25)
  expect(summary?.pass).toBe(false)
  // Answered in both languages: a, b, c; the same level only for c.
  expect(summary?.agreement).toEqual({ items: 3, same: 1, rate: 0.3333 })
})

// The mod waits timeoutMs and then goes on without an answer; the eval waits longer and asks again, so an
// answer it got late is one the mod would not have had.
test("answers that came after the mod's wait are counted apart: accuracy in time counts them as no decision", () => {
  const [summary] = summarize(effortSubmit, ITEMS, ROWS, { slowMs: 500 }).variants
  // en: a (200 ms) and b (100 ms) are right in time; c is right but late, d late and wrong.
  expect([summary?.en.accuracy, summary?.en.inTime, summary?.en.late]).toEqual([0.75, 0.5, 2])
})

/** `n` items each answered right in English, and right in Chinese for the first `zh`. */
function rated(zh: number, n = 100) {
  const items = Array.from({ length: n }, (_, i) => item(`i${i}`, 'high', ['high'], []))
  const rows = items.flatMap((it, i) => (['zh', 'en'] as const).map((language) => ({ ...row('a', language, language === 'en' || i < zh ? 'high' : 'low', 100), id: it.id })))
  const graded = rows.map((r) => ({ ...r, correct: r.prediction === 'high', exact: r.prediction === 'high', miss: r.prediction === 'high' ? null : 'under' }))
  return summarize(effortSubmit, items, graded, { slowMs: 500 }).variants[0]
}

// The bar is the person's (2026-10-05): Chinese at most 4 points below English, exactly 4.0 passing. The spec said 3.
test('Chinese passes when it is at most 4 points below English: 3 and 4.0 points below pass, 4.01 and 5 do not', () => {
  expect([rated(97)?.gap, rated(97)?.pass]).toEqual([-0.03, true])
  expect([rated(96)?.gap, rated(96)?.pass]).toEqual([-0.04, true])
  const past = rated(9599, 10_000)
  expect([past?.gap, past?.pass]).toEqual([-0.0401, false])
  expect([rated(95)?.gap, rated(95)?.pass]).toEqual([-0.05, false])
})

test('latency is over answered requests, nearest rank; slow counts those over the given limit', () => {
  const [summary] = summarize(effortSubmit, ITEMS, ROWS, { slowMs: 500 }).variants
  // 100 200 300 400 500 600 700: p50 is the 4th of 7, p90 the 7th.
  expect(summary?.latency).toEqual({ answers: 7, p50: 400, p90: 700, max: 700, slow: 2 })
})

test('errors by tag, most first, in each language', () => {
  const [summary] = summarize(effortSubmit, ITEMS, ROWS, { slowMs: 500 }).variants
  expect(summary?.tags).toEqual([
    { tag: 'security', items: 1, wrong: { zh: 1, en: 1 } },
    { tag: 'trivial', items: 1, wrong: { zh: 1, en: 0 } },
    { tag: 'debug', items: 2, wrong: { zh: 0, en: 0 } },
    { tag: 'follow-up', items: 1, wrong: { zh: 0, en: 0 } },
  ])
})

test('a constant answer is scored on the dataset as a baseline: always high is right on a and c', () => {
  expect(summarize(effortSubmit, ITEMS, ROWS, { slowMs: 500 }).constants).toEqual([
    { answer: 'low', accuracy: 0.25, exact: 0.25 },
    { answer: 'medium', accuracy: 0.25, exact: 0.25 },
    { answer: 'high', accuracy: 0.5, exact: 0.25 },
    { answer: 'xhigh', accuracy: 0.25, exact: 0 },
    { answer: 'max', accuracy: 0.25, exact: 0.25 },
  ])
})
