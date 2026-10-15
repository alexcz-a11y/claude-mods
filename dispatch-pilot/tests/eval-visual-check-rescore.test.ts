// The visual-check results read again by the bars of 2026-10-15 (seam 2: the pure functions the script eval/rescore-visual-check.ts uses): the
// probabilities a result keeps give, for any bars, the verdicts they would have given, with no request. Worked by hand on a few checks.

import { expect, test } from 'claude-code/testing'
import { BARS_BEFORE, barsNow, rescoreResult, rescoreVariant } from '../eval/lib/visual-check-rescore.ts'

type Check = { holds: boolean; verdict: 'pass' | 'fail' | 'unsure'; p: number | null; trust: 'both' | 'fail' }
const answer = (id: string, kind: string, checks: Check[], extra: Record<string, unknown> = {}) => ({ id, language: 'zh', ...extra, mod: { kind, checks } })

// Stored by the bars of the day of the run (PASS from 0.9, FAIL up to 0.2).
const ANSWERS = [
  // A screenshot: 0.85 on a part that differs (no longer unsure: PASS, a false pass), 0.85 on a part that holds (PASS), 0.35 on one that differs (stays unsure).
  answer('ui-a', 'ui', [
    { holds: false, verdict: 'unsure', p: 0.85, trust: 'both' },
    { holds: true, verdict: 'unsure', p: 0.85, trust: 'both' },
    { holds: false, verdict: 'unsure', p: 0.35, trust: 'both' },
  ]),
  // A sea whole-image answer that can only fail: 0.95 stays unsure whatever the bar, 0.2 fails.
  answer('sea-a', 'sea', [
    { holds: true, verdict: 'unsure', p: 0.95, trust: 'fail' },
    { holds: false, verdict: 'fail', p: 0.2, trust: 'fail' },
  ]),
  // An animation, asked three times: 0.35 on a motion that is wrong is a catch by the bar of a recording (up to 0.4), 0.4 on one that holds is a false fail, a missing answer is unsure.
  ...[1, 2, 3].map((repeat) =>
    answer('anim-a', 'anim', [
      { holds: false, verdict: 'unsure', p: 0.35, trust: 'both' },
      { holds: true, verdict: 'unsure', p: 0.4, trust: 'both' },
      { holds: true, verdict: 'unsure', p: null, trust: 'both' },
    ], { repeat }),
  ),
  // No checks (a complexity item), another language and a variant that is not asked are left out.
  { id: 'cube', language: 'zh', mod: { kind: 'complexity', p: [1, 0, 0, 0, 0] } },
  answer('ui-en', 'ui', [{ holds: false, verdict: 'fail', p: 0.1, trust: 'both' }], { language: 'en' }),
]

test('the bars before are 0.9 and 0.2, the bars now a screenshot 0.8 and 0.2, a recording 0.8 and 0.4', () => {
  expect(BARS_BEFORE).toEqual({ passAt: 0.9, failAt: 0.2 })
  expect(barsNow('ui')).toEqual({ passAt: 0.8, failAt: 0.2 })
  expect(barsNow('sea')).toEqual({ passAt: 0.8, failAt: 0.2 })
  expect(barsNow('anim')).toEqual({ passAt: 0.8, failAt: 0.4 })
})

test('the old bars reproduce the stored verdicts, so the probabilities are the run\'s; the new bars judge the same probabilities again', () => {
  const r = rescoreVariant(ANSWERS as never, 'mod')
  expect(r.notReproduced).toBe(0)
  expect(r.before).toEqual(r.stored)

  // Stored: the checks of ui-a (3), sea-a (2) and anim-a (3 x 3) = 14, all unsure but the one fail.
  expect(r.stored.all).toMatchObject({ checks: 14, unsure: 13, caught: 1, falsePass: 0, falseFail: 0, passed: 0 })

  // Now, by kind.
  expect(r.now.ui).toMatchObject({ checks: 3, differ: 2, same: 1, falsePass: 1, passed: 1, unsure: 1, unsureDiffer: 1, caught: 0, falseFail: 0 })
  expect(r.now.sea).toMatchObject({ checks: 2, falsePass: 0, caught: 1, unsure: 1, unsureSame: 1 })
  // 0.35 is a catch, 0.4 a false fail (0.4 is in), a missing answer stays unsure; three times each.
  expect(r.now.anim).toMatchObject({ checks: 9, differ: 3, same: 6, caught: 3, falseFail: 3, unsure: 3, unsureSame: 3, falsePass: 0 })
  expect(r.now.all).toMatchObject({ checks: 14, falsePass: 1, falseFail: 3, caught: 4, passed: 1, unsure: 5 })
})

test('a result file is rescored for every variant its summary names, with how often it was run', () => {
  const file = rescoreResult('x.json', { label: 'anim', date: '2026-10-15', run: { repeats: 3 }, summary: { variants: [{ variant: 'mod' }, { variant: 'whole' }] }, answers: ANSWERS })
  expect(file).toMatchObject({ file: 'x.json', label: 'anim', repeats: 3 })
  expect(file.variants.map((v) => [v.variant, v.now.all.checks])).toEqual([['mod', 14], ['whole', 0]])
})
