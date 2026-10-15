// visual_check, a series of quality levels (#61): what each pair of neighbouring levels comes to, and from which level on the higher
// ones no longer look different. Seam 2: the pure functions the tool and the eval (#65) share. "No difference" is the weaker
// direction of the decision model's answers, so it takes every named part to pass (ADR 0008): one part that fails, or that nobody
// could tell, and the pair is not the same.

import { expect, test } from 'claude-code/testing'
import { pairConclusion, pairWaves, seriesVerdict } from '../hooks/decision/visual-check-sequence.ts'

const pass = { verdict: 'pass' } as const
const fail = { verdict: 'fail' } as const
const unsure = { verdict: 'unsure' } as const

test('a pair is the same only when every named part passed; one part that fails makes it differ, one nobody could tell leaves it unsure', () => {
  expect(pairConclusion([pass, pass, pass])).toBe('same')
  expect(pairConclusion([pass, fail, pass])).toBe('differs')
  expect(pairConclusion([pass, unsure])).toBe('unsure')
  // A fail outweighs a doubt: the pair is known to differ.
  expect(pairConclusion([unsure, fail])).toBe('differs')
  expect(pairConclusion([])).toBe('unsure')
})

test('the level from which the higher ones look alike is the first of the unbroken run of same pairs at the top', () => {
  // Levels 1 to 5: the pairs are 1-2, 2-3, 3-4, 4-5.
  expect(seriesVerdict(['differs', 'differs', 'same', 'same'])).toEqual({ kind: 'from', level: 3 })
  expect(seriesVerdict(['same', 'same', 'same', 'same'])).toEqual({ kind: 'from', level: 1 })
  expect(seriesVerdict(['differs', 'differs', 'differs', 'same'])).toEqual({ kind: 'from', level: 4 })
  // A pair that looked the same lower down does not count when a higher one differs again.
  expect(seriesVerdict(['same', 'differs', 'same', 'same'])).toEqual({ kind: 'from', level: 3 })
  // A pair nobody could tell breaks the run: the level above it is the first that is known.
  expect(seriesVerdict(['differs', 'unsure', 'same', 'same'])).toEqual({ kind: 'from', level: 3 })
})

test('when the top pair still differs there is no such level; when every pair differs, every level does', () => {
  expect(seriesVerdict(['differs', 'differs', 'differs'])).toEqual({ kind: 'differs', every: true })
  expect(seriesVerdict(['same', 'same', 'differs'])).toEqual({ kind: 'differs', every: false })
})

test('when the top pair could not be told the level is not known', () => {
  expect(seriesVerdict(['same', 'same', 'unsure'])).toEqual({ kind: 'unknown' })
  expect(seriesVerdict(['differs', 'unsure'])).toEqual({ kind: 'unknown' })
})

test('pairs go out in waves: as many as fit about three requests\' worth of images, and no more than six at once', () => {
  // A pair of 1-megapixel images costs Jev about 5,200 tokens: 13 would fit the token share, so six is the limit.
  expect(pairWaves(Array(8).fill(5200))).toEqual([[0, 1, 2, 3, 4, 5], [6, 7]])
  // A pair at the 24,000-token budget of a request: three of them are 72,000.
  expect(pairWaves(Array(7).fill(24_000))).toEqual([[0, 1, 2], [3, 4, 5], [6]])
  // One pair is never split, however much it costs.
  expect(pairWaves([100_000, 100_000])).toEqual([[0], [1]])
  expect(pairWaves([])).toEqual([])
})
