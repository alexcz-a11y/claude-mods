// The visual-check suite's scoring and figures (#65, seam 2): how an item's verdicts are graded against what is true of it, and what a run
// reports: the false passes (there must be none), the controls judged FAIL, UNSURE, the tokens, the latency and the price of each image, and
// whether the groups of reference images read in the order of their complexity. Pure: rows in, figures out; no decision model asked.

import { expect, test } from 'claude-code/testing'
import { judge, type Verdict } from '../hooks/decision/visual-check.ts'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import { summarize } from '../eval/lib/metrics.ts'
import type { Row } from '../eval/lib/runner.ts'
import { settingsFrom } from '../eval/lib/suite.ts'
import { type CheckDetail, type CheckedDetail, type ReadingDetail, SWEPT, verdictAt, type VisualCheckItem, type VisualPrediction, visualCheckSuite, evenly, expectedLevel } from '../eval/lib/visual-check.ts'

const suite = visualCheckSuite(undefined)
const settings = settingsFrom({ decisionModel: 'jev', typesafeApiKey: 'k' })
const base = { rationale: 'x', difficulty: 'hard' as const }

const item = (id: string, holds: boolean[], tags: string[] = [], kind: 'ui' | 'sea' = 'ui'): VisualCheckItem => ({
  ...base,
  id,
  kind,
  tags,
  asked: { screenshot: `${kind}/${id}.png`, reference: [`${kind}/ref.png`], same_view: null, checks: holds.map((_, i) => ({ part: `part ${i}`, property: 'p' })) },
  gold: { holds },
})
const group = (id: string, rank: number, level: number): VisualCheckItem => ({ ...base, id, kind: 'complexity', tags: [], asked: { references: [`effort/${id}.png`] }, gold: { level, accept: [level], rank } })

/** The grade of an item for verdicts, one for each of its checks. */
const gradeOf = (it: VisualCheckItem, verdicts: Verdict[]) => suite.grade(it, { kind: 'checks', outcomes: verdicts.map((verdict) => ({ verdict, probability: null, basis: 'zoom' as const })) })

test('a check is right when a part that is the same passes and a part that differs fails; UNSURE is neither right nor wrong', () => {
  const two = item('a', [false, true])
  expect(gradeOf(two, ['fail', 'pass'])).toEqual({ correct: true, exact: true })
  // Not sure: nothing wrong was said, and not everything was right.
  expect(gradeOf(two, ['unsure', 'pass'])).toEqual({ correct: true, exact: false })
  expect(gradeOf(two, ['unsure', 'unsure'])).toEqual({ correct: true, exact: false })
})

test('the two ways to be wrong are named: a part that differs judged PASS (which must not happen), and a part that is the same judged FAIL', () => {
  const two = item('a', [false, true])
  expect(gradeOf(two, ['pass', 'pass'])).toEqual({ correct: false, exact: false, miss: 'false-pass' })
  expect(gradeOf(two, ['fail', 'fail'])).toEqual({ correct: false, exact: false, miss: 'false-fail' })
  // When both happen, the one that matters is the name.
  expect(gradeOf(two, ['pass', 'fail'])).toMatchObject({ correct: false, miss: 'false-pass' })
})

test('a group of reference images is right when its level is acceptable and exact when it is the gold level; a wrong one is too low or too high', () => {
  const ocean: VisualCheckItem = { ...base, id: 'ocean', kind: 'complexity', tags: [], asked: { references: ['effort/o.png'] }, gold: { level: 2, accept: [1, 2, 3], rank: 1 } }
  const level = (n: number) => suite.grade(ocean, { kind: 'level', level: n })
  expect(level(2)).toEqual({ correct: true, exact: true })
  expect(level(3)).toEqual({ correct: true, exact: false })
  expect(level(0)).toEqual({ correct: false, exact: false, miss: 'under' })
  expect(level(4)).toEqual({ correct: false, exact: false, miss: 'over' })
})

test('a tool that gave every check the same verdict is the baseline: always PASS is wrong on every part that differs, always UNSURE is never wrong and never exact', () => {
  const two = item('a', [false, true])
  expect(suite.grade(two, { kind: 'always', verdict: 'pass' })).toMatchObject({ correct: false, miss: 'false-pass' })
  expect(suite.grade(two, { kind: 'always', verdict: 'fail' })).toMatchObject({ correct: false, miss: 'false-fail' })
  expect(suite.grade(two, { kind: 'always', verdict: 'unsure' })).toEqual({ correct: true, exact: false })
  // A verdict is no level, and a level no verdict.
  expect(suite.grade(group('g', 0, 1), { kind: 'always', verdict: 'pass' })).toMatchObject({ correct: false })
  expect(suite.grade(two, { kind: 'level', level: 1 })).toMatchObject({ correct: false })
})

// ---- The figures -----------------------------------------------------------------------------------------------------------

const check = (holds: boolean, verdict: Verdict, p: number | null, extra: Partial<CheckDetail> = {}): CheckDetail => ({ part: 'the part', property: 'p', holds, verdict, p, basis: 'zoom', trust: 'both', whole: null, ...extra })
const checked = (kind: 'ui' | 'sea', images: number, checks: CheckDetail[], extra: Partial<CheckedDetail> = {}): CheckedDetail => ({ kind, images, checks, elsewhere: null, requests: [{ questions: 2, images, ms: 300, tokens: 1000 }], ...extra })

function row(id: string, prediction: VisualPrediction, detail: CheckedDetail | ReadingDetail, extra: Partial<Row<VisualPrediction>> = {}): Row<VisualPrediction> {
  return { id, language: 'zh', variant: 'mod', ok: true, prediction, shown: null, correct: true, exact: true, miss: null, failure: null, detail: detail as unknown as Record<string, unknown>, ms: 400, attempts: 1, inputTokens: 2000, model: JEV_MODEL, state: null, requests: 2, ...extra }
}
const verdicts = (c: readonly CheckDetail[]): VisualPrediction => ({ kind: 'checks', outcomes: c.map((one) => ({ verdict: one.verdict, probability: one.p, basis: one.basis })) })

const ITEMS = [item('ui-good', [false, true]), item('ui-bad', [false, true]), item('ui-same', [true, true], ['control']), item('sea-twin', [true], ['control'], 'sea'), group('cube', 0, 0), group('ocean', 1, 2), group('city', 2, 3)]
const GOOD = [check(false, 'fail', 0.1), check(true, 'pass', 0.95)]
const BAD = [check(false, 'pass', 0.93), check(true, 'fail', 0.15)]
const SAME = [check(true, 'fail', 0.05), check(true, 'pass', 0.97)]
const TWIN = [check(true, 'unsure', 0.5)]
const reading = (p: number[], images = 2): ReadingDetail => ({ kind: 'complexity', images, p, expected: expectedLevel(p), requests: [{ questions: 1, images, ms: 900, tokens: 3000 }] })
const ROWS = [
  row('ui-good', verdicts(GOOD), checked('ui', 2, GOOD)),
  row('ui-bad', verdicts(BAD), checked('ui', 2, BAD)),
  row('ui-same', verdicts(SAME), checked('ui', 2, SAME, { elsewhere: { confidence: 0.4, area: 0.1 } })),
  row('sea-twin', verdicts(TWIN), checked('sea', 2, TWIN), { ms: 200, inputTokens: 1000 }),
  row('cube', { kind: 'level', level: 0 }, reading([0.87, 0.11, 0.02, 0, 0], 2), { ms: 600, inputTokens: 2100 }),
  row('ocean', { kind: 'level', level: 2 }, reading([0.13, 0.12, 0.63, 0.08, 0.04], 3), { ms: 900, inputTokens: 2600 }),
  row('city', { kind: 'level', level: 3 }, reading([0, 0.01, 0.14, 0.55, 0.3], 4), { ms: 1500, inputTokens: 3800 }),
]
const figures = () => suite.breakdown?.(ITEMS, ROWS, 'mod', settings, { usdPerMillionTokens: 0.042 }) as Record<string, any>

test('the false passes are counted, with the items that have them: a part that differs and was judged PASS', () => {
  expect(figures().falsePass).toEqual({ count: 1, of: 2, items: ['ui-bad'] })
})

test('the controls judged FAIL are counted: the items in which nothing differs, whatever the other items did', () => {
  const f = figures()
  expect(f.controlFails).toEqual({ count: 1, of: 3, items: ['ui-same'] })
  // A part that is the same judged FAIL, in a control or in an item that differs elsewhere (ui-bad's second check).
  expect(f.falseFail).toEqual({ count: 2, of: 5 })
})

test('the share of UNSURE is read over all the checks, over those that differ and over those that are the same', () => {
  expect(figures().unsure).toMatchObject({ count: 1, of: 7, onDiffering: 0, onSame: 0.2 })
  // The differences caught: FAIL on a part that differs.
  expect(figures().caught).toEqual({ count: 1, of: 2, rate: 0.5 })
})

test('each image costs its tokens, its latency and its price: over all, and by kind of item', () => {
  const { cost } = figures()
  // Four items with checks of 2 images each, three groups of 2, 3 and 4 images: 17 images in all, 2000 + 2000 + 2000 + 1000 + 2100 + 2600 + 3800 tokens.
  expect(cost.all).toMatchObject({ items: 7, images: 17, tokens: 15500, usd: 0.000651 })
  expect(cost.all.perImage).toEqual({ tokens: 912, ms: 259, usd: 0.000038 })
  expect(cost.byKind.complexity).toMatchObject({ items: 3, images: 9, tokens: 8500 })
  expect(cost.byKind.ui.perImage.tokens).toBe(1000)
  expect(cost.requests).toBe(7)
})

test('without a price there are no dollars, and the rest is as it was', () => {
  const f = suite.breakdown?.(ITEMS, ROWS, 'mod', settings) as Record<string, any>
  expect(f.cost.all.usd).toBeNull()
  expect(f.cost.all.perImage.usd).toBeNull()
  expect(f.cost.all.perImage.tokens).toBe(912)
})

test('the groups of reference images are in order when their levels do not fall as their rank rises, strictly when each is above the one before; the unrounded expectation tells two groups of one level apart', () => {
  const { complexity } = figures()
  expect(complexity.groups.map((g: { id: string; level: number }) => [g.id, g.level])).toEqual([['cube', 0], ['ocean', 2], ['city', 3]])
  expect(complexity).toMatchObject({ inOrder: true, strictlyInOrder: true, expectedStrictlyInOrder: true })
  expect(complexity.groups.map((g: { expected: number }) => g.expected)).toEqual([0.15, 1.78, 3.14])

  // The mod's own rounded reading puts the city with the sea; the expectation still tells them apart, and an order broken is found.
  const same = ROWS.map((r) => (r.id === 'city' ? { ...r, prediction: { kind: 'level' as const, level: 2 } } : r))
  expect((suite.breakdown?.(ITEMS, same, 'mod', settings) as Record<string, any>).complexity).toMatchObject({ inOrder: true, strictlyInOrder: false, expectedStrictlyInOrder: true })
  const broken = ROWS.map((r) => (r.id === 'cube' ? { ...r, prediction: { kind: 'level' as const, level: 3 } } : r))
  expect((suite.breakdown?.(ITEMS, broken, 'mod', settings) as Record<string, any>).complexity).toMatchObject({ inOrder: false })
})

test('a part named elsewhere on a control is a false alarm, and counted', () => {
  expect(figures().elsewhere).toEqual({ reported: 1, onControls: ['ui-same'] })
})

test('an item with no answer is left out of the figures, not counted as a check', () => {
  const rows = ROWS.map((r) => (r.id === 'ui-bad' ? { ...r, ok: false, prediction: null, detail: null, failure: 'http: HTTP 400' } : r))
  const f = suite.breakdown?.(ITEMS, rows, 'mod', settings) as Record<string, any>
  expect(f.falsePass.count).toBe(0)
  expect(f.checks).toMatchObject({ total: 5, answeredItems: 3 })
})

// ---- The bars --------------------------------------------------------------------------------------------------------------

test("at the mod's bars for a screenshot (PASS from 0.8, FAIL up to 0.2) a probability gives the mod's own verdict; against a reference a whole image can only fail", () => {
  for (const trust of ['both', 'fail'] as const) {
    for (const p of [null, 0, 0.1, 0.2, 0.21, 0.5, 0.79, 0.8, 0.89, 0.9, 0.95, 1]) expect(verdictAt(p, trust, 0.8, 0.2)).toBe(judge(p, trust).verdict)
  }
})

test('the bars swept include the mod\'s three sets: a screenshot (0.8, 0.2), a recording (0.8, 0.4) and a series (0.9, 0.2)', () => {
  expect(SWEPT.passAt).toEqual(expect.arrayContaining([0.8, 0.9]))
  expect(SWEPT.failAt).toEqual(expect.arrayContaining([0.2, 0.4]))
})

test('sweeping the bars says what other bars would have decided, from the probabilities each answer kept', () => {
  const { thresholds } = figures()
  expect(thresholds).toHaveLength(SWEPT.passAt.length * SWEPT.failAt.length)
  const at = (passAt: number, failAt: number) => thresholds.find((t: { passAt: number; failAt: number }) => t.passAt === passAt && t.failAt === failAt)
  // The mod's bars: one false pass (0.93), as counted above.
  expect(at(0.9, 0.2)).toMatchObject({ falsePass: 1, caught: 1, differ: 2 })
  // A bar of 0.95 leaves the 0.93 UNSURE: no false pass; a bar of 0.1 for FAIL leaves 0.15 and 0.5 where they were and the same part judged 0.05 FAIL.
  expect(at(0.95, 0.2)).toMatchObject({ falsePass: 0 })
  expect(at(0.9, 0.1)).toMatchObject({ caught: 1 })
  expect(at(0.9, 0.3)).toMatchObject({ falseFail: 2 })
})

test('frames are spread evenly, the first and the last among them', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => i)
  expect(evenly(twelve, 8)).toEqual([0, 2, 3, 5, 6, 8, 9, 11])
  expect(evenly(twelve, 12)).toEqual(twelve)
  expect(evenly([1, 2, 3], 8)).toEqual([1, 2, 3])
})

test("the run's figures pass the price of a token through to the suite: a summary has the cost of each image in dollars", () => {
  const summary = summarize(suite, ITEMS, ROWS, { slowMs: 1500, settings, prices: { usdPerMillionTokens: 0.042 } })
  expect((summary.variants[0]?.breakdown as Record<string, any>).cost.all.perImage.usd).toBe(0.000038)
  expect((summarize(suite, ITEMS, ROWS, { slowMs: 1500, settings }).variants[0]?.breakdown as Record<string, any>).cost.all.usd).toBeNull()
})
