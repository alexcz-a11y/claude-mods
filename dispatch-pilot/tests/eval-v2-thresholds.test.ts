// The scan of the three-way question's two bars over a flow (seam 2, #45 for #42): the decisive messages that have a gold
// answer (gold/<id>.json `triage_decisive`) and the probabilities the flow file kept for them; the pair of bars that adds
// one for the most messages still unresolved while clearing at most 2% of them, and what each pair does to the count in
// the middle rounds, whose messages have no gold.

import { expect, test } from 'claude-code/testing'
import type { UnresolvedOption } from '../hooks/decision/unresolved.ts'
import type { FinalGold } from '../eval/lib/eval-v2.ts'
import type { FlowFile, FlowItem, FlowMessage } from '../eval/lib/eval-v2-flow.ts'
import { barFigures, scanBars, scanPoints, type MiddlePoint, type TriagePoint } from '../eval/lib/eval-v2-thresholds.ts'

const p = (still: number, resolved: number, other: number) => ({ still_unresolved: still, resolved, new_or_unrelated: other })

/** Decisive messages with their gold, and what the decision model gave each. */
const DECISIVE: TriagePoint[] = [
  { id: 'a', msg: 'd1', gold: 'still_unresolved', probs: p(0.9, 0.05, 0.05) },
  { id: 'a', msg: 'd2', gold: 'still_unresolved', probs: p(0.6, 0.1, 0.3) },
  { id: 'b', msg: 'd1', gold: 'still_unresolved', probs: p(0.45, 0.05, 0.5) },
  { id: 'b', msg: 'd2', gold: 'still_unresolved', probs: p(0.2, 0.05, 0.75) },
  { id: 'c', msg: 'd1', gold: 'new_or_unrelated', probs: p(0.1, 0.1, 0.8) },
  { id: 'c', msg: 'd2', gold: 'resolved', probs: p(0.1, 0.85, 0.05) },
  { id: 'd', msg: 'd1', gold: 'new_or_unrelated', probs: p(0.35, 0.05, 0.6) },
]

const MIDDLE: MiddlePoint[] = [
  { id: 'a', msg: 'm1', relation: 'same-problem', probs: p(0.3, 0.1, 0.6) },
  { id: 'a', msg: 'm2', relation: 'same-problem', probs: p(0.6, 0.2, 0.2) },
  { id: 'b', msg: 'm1', relation: 'unrelated', probs: p(0.1, 0.1, 0.8) },
  { id: 'b', msg: 'm2', relation: 'unrelated', probs: p(0.55, 0.05, 0.4) },
]

test("at the mod's bars: how many still-unresolved messages add one, how many of them clear the count, how many others add or clear; and in the middle rounds, the count cleared in a same-problem stretch or raised in an unrelated one", () => {
  const at = barFigures(DECISIVE, MIDDLE, { add: 0.5, reset: 0.7 })
  expect(at).toMatchObject({ add: 0.5, reset: 0.7, still: 4, others: 3, addRecall: 0.5, falseReset: 0.25, falseAdd: 0, resetRecall: 0.6667 })
  expect(at.middle).toEqual({ 'same-problem': { items: 2, add: 0.5, reset: 0, wrong: 0 }, unrelated: { items: 2, add: 0.5, reset: 0.5, wrong: 0.5 }, items: 4, wrong: 0.25 })
})

test('the scan takes the pair that adds one for the most still-unresolved messages among those that clear at most 2% of them (fewer wrong adds, more right clears, then nearer the mod\'s first), keeping the mod\'s rules for the bars', () => {
  const scan = scanBars(DECISIVE, MIDDLE, { maxFalseReset: 0.02 })
  expect(scan.current).toMatchObject({ add: 0.5, reset: 0.7 })
  // b's d2 clears at 0.7 unless add takes it first (0.2) or reset goes past 0.75; the lowest add takes every one.
  expect(scan.best).toMatchObject({ add: 0.2, reset: 0.81, addRecall: 1, falseReset: 0, falseAdd: 0.3333, resetRecall: 0.3333 })
  // With wrong adds held to none too, a higher add bar and a reset bar past 0.75.
  expect(scanBars(DECISIVE, MIDDLE, { maxFalseReset: 0.02, maxFalseAdd: 0 }).best).toMatchObject({ add: 0.45, reset: 0.76, addRecall: 0.75, falseReset: 0, falseAdd: 0, resetRecall: 0.6667 })
  // For each add bar, the lowest reset bar within the limit: the choices beside the pick.
  const row = scan.frontier.find((figures) => figures.add === 0.4)
  expect(row).toMatchObject({ add: 0.4, reset: 0.76, addRecall: 0.75, falseReset: 0, falseAdd: 0 })
  // Both of the mod's rules for the bars hold on every pair: add + reset over 1, and adding takes less certainty than clearing.
  expect(scan.frontier.length).toBeGreaterThan(5)
  expect(scan.frontier.every((figures) => figures.add + figures.reset > 1 && figures.add < figures.reset)).toBe(true)
  // Nothing within the limit: no pick.
  expect(scanBars([{ id: 'x', msg: 'd1', gold: 'still_unresolved', probs: p(0.01, 0, 0.99) }], [], { maxFalseReset: 0.02 }).best).toBeNull()
})

/** A message of a flow as eval-v2-flow.ts records it. */
const message = (msg: string, part: FlowMessage['part'], triage: Record<UnresolvedOption, number> | undefined): FlowMessage => ({ msg, at: 0, part, before: 0, change: 'keep', after: 0, ...(triage === undefined ? {} : { triage }) })

test('the points of a flow file: the decisive messages with their gold, the last message with triage_final, the middle messages by the relation of the item; a message without an answer is left out', () => {
  const item: FlowItem = {
    conversation: 'x',
    messages: [message('p1', 'lead', p(0.1, 0.1, 0.8)), message('d1', 'decisive', p(0.1, 0.1, 0.8)), message('d2', 'decisive', undefined), message('m1', 'middle', p(0.6, 0.1, 0.3)), message('f1', 'final', p(0.7, 0.1, 0.2))],
    carry: { count: 1, summary: null },
    final: { count: 1, summary: null, hint: false },
  }
  const flow = { items: { 'explicit-unresolved-01': item } } as unknown as FlowFile
  const gold = { triage_final: 'still_unresolved', triage_decisive: [{ msg: 'd1', triage: 'new_or_unrelated' }, { msg: 'd2', triage: 'still_unresolved' }] } as unknown as FinalGold
  const points = scanPoints(flow, [{ id: 'explicit-unresolved-01', relation: 'same-problem', gold }])
  expect(points.decisive).toEqual([{ id: 'explicit-unresolved-01', msg: 'd1', gold: 'new_or_unrelated', probs: p(0.1, 0.1, 0.8) }])
  expect(points.final).toEqual([{ id: 'explicit-unresolved-01', msg: 'f1', gold: 'still_unresolved', probs: p(0.7, 0.1, 0.2) }])
  expect(points.middle).toEqual([{ id: 'explicit-unresolved-01', msg: 'm1', relation: 'same-problem', probs: p(0.6, 0.1, 0.3) }])
  expect(points.missing).toEqual({ items: [], unanswered: 1 })
  // An item with no flow, or a flow not finished, is said to be missing.
  expect(scanPoints({ items: {} } as unknown as FlowFile, [{ id: 'resolved-01', relation: 'unrelated', gold }]).missing).toEqual({ items: ['resolved-01'], unanswered: 0 })
})
