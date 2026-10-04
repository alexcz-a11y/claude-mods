// Comparing two saved eval runs (seam 2's results): how many answers came
// out the same, and how each variant's numbers moved. What tells a prompt
// change from run-to-run noise.

import { expect, test } from 'claude-code/testing'
import { compareRuns } from '../eval/lib/compare.ts'

/** A saved run, as much of it as a comparison reads. */
function run(answers: Record<string, string>, numbers: { zh: number; en: number; agree: number; p50: number }) {
  const rows = Object.entries(answers).map(([key, answer]) => {
    const [id, language] = key.split(' ')
    return { id, language, 'en-score': { answer } }
  })
  const variant = {
    variant: 'en-score',
    zh: { accuracy: numbers.zh },
    en: { accuracy: numbers.en },
    gap: Math.round((numbers.zh - numbers.en) * 10_000) / 10_000,
    agreement: { rate: numbers.agree },
    latency: { p50: numbers.p50 },
  }
  return { summary: { variants: [variant] }, answers: rows }
}

test('the same answer for the same item and language counts as same; each number is paired with its change', () => {
  const a = run({ 'q1 zh': 'high', 'q1 en': 'high', 'q2 zh': 'low', 'q2 en': 'medium' }, { zh: 0.5, en: 1, agree: 0.5, p50: 290 })
  const b = run({ 'q1 zh': 'high', 'q1 en': 'xhigh', 'q2 zh': 'low', 'q2 en': 'medium' }, { zh: 0.5, en: 0.5, agree: 0, p50: 700 })
  expect(compareRuns(a, b)).toEqual([
    {
      variant: 'en-score',
      same: 3,
      compared: 4,
      zh: { a: 0.5, b: 0.5 },
      en: { a: 1, b: 0.5 },
      gap: { a: -0.5, b: 0 },
      agreement: { a: 0.5, b: 0 },
      p50: { a: 290, b: 700 },
    },
  ])
})

test('only variants both runs asked are compared, and only answers both runs have', () => {
  const a = run({ 'q1 zh': 'high', 'q2 zh': 'low' }, { zh: 1, en: 1, agree: 1, p50: 300 })
  const b = { summary: { variants: [] }, answers: [{ id: 'q1', language: 'zh', 'zh-choice': { answer: 'high' } }] }
  expect(compareRuns(a, b)).toEqual([])
})
