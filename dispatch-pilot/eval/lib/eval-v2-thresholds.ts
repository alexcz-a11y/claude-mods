// The scan of the three-way question's two bars (#45, for #42): which pair moves the unresolved count best, judged on
// the messages whose answer is known. A flow file (lib/eval-v2-flow.ts) keeps, for every message of the person, the
// probabilities the decision model gave the three options; the final gold (eval-v2/gold/) says what each decisive message
// (`triage_decisive`) and each last message (`triage_final`) said of the problem. A pair of bars judges each answer as
// the mod does (`judgeUnresolved`: one more at the add bar, a clear at the reset bar, else nothing).
//
// The rule (issue #45): of the pairs that clear the count at no more than 2% of the messages still unresolved (a clear
// loses the record of several tries; a count one too high is made up at the next message), the one that adds one for
// the most of them. Ties: fewer wrong adds, more right clears, fewer wrong moves in the middle rounds, then nearer the
// mod's present bars. Every pair keeps the mod's two rules for the bars: add + reset over 1 (one answer never meets
// both), and add under reset (adding takes less certainty than clearing).
//
// The middle rounds have no gold, so what is reported of them is the count moved where it should not be: cleared in a
// same-problem stretch (more work on the problem, no word on whether it is solved: the record lost), raised in an
// unrelated one (other work in the same repository).
//
// Offline, from the probabilities: a different pair would have moved the count differently, and later requests would
// have carried another count and hint; the scan reads each answer as it was given.
//
// Pure: no Node API.

import { judgeUnresolved, UNRESOLVED_THRESHOLDS, type UnresolvedOption, type UnresolvedThresholds } from '../../hooks/decision/unresolved.ts'
import type { FinalGold, Relation } from './eval-v2.ts'
import type { FlowFile } from './eval-v2-flow.ts'
import { rate } from './metrics.ts'

type Probs = Record<UnresolvedOption, number>

/** A message whose answer is known: its item, its id, the gold answer and the probabilities the decision model gave. */
export type TriagePoint = { id: string; msg: string; gold: UnresolvedOption; probs: Probs }
/** A message of a middle round: no gold, only the relation of the item's middle to its problem. */
export type MiddlePoint = { id: string; msg: string; relation: Relation; probs: Probs }

type Figure = number | null

const share = (count: number, of: number): Figure => (of === 0 ? null : rate(count, of))

/** What a pair of bars does: to the decisive messages, and in the middle rounds. */
export type BarFigures = UnresolvedThresholds & {
  /** Decisive messages still unresolved, and the others. */
  still: number
  others: number
  /** Of those still unresolved: the share that adds one, the share that clears the count. */
  addRecall: Figure
  falseReset: Figure
  /** Of the others (solved, or another problem): the share that adds one, the share that clears. */
  falseAdd: Figure
  resetRecall: Figure
  /** In the middle rounds, by relation: the shares that add, that clear, and that move the count where it should not be (`wrong`). */
  middle: Record<Relation, { items: number; add: Figure; reset: Figure; wrong: Figure }> & { items: number; wrong: Figure }
}

/** What the pair `bars` does to the decisive messages and to the middle rounds. */
export function barFigures(decisive: readonly TriagePoint[], middle: readonly MiddlePoint[], bars: UnresolvedThresholds): BarFigures {
  const change = (probs: Probs) => judgeUnresolved({ probabilities: probs, confidence: null }, bars).change
  const still = decisive.filter((point) => point.gold === 'still_unresolved')
  const others = decisive.filter((point) => point.gold !== 'still_unresolved')
  const count = (points: readonly { probs: Probs }[], moved: string) => points.filter((point) => change(point.probs) === moved).length
  const group = (relation: Relation) => {
    const points = middle.filter((point) => point.relation === relation)
    const wrong = count(points, relation === 'same-problem' ? 'reset' : 'add')
    return { items: points.length, add: share(count(points, 'add'), points.length), reset: share(count(points, 'reset'), points.length), wrong: share(wrong, points.length), wrongCount: wrong }
  }
  const same = group('same-problem')
  const other = group('unrelated')
  const strip = ({ wrongCount: _count, ...figures }: ReturnType<typeof group>) => figures
  return {
    add: bars.add,
    reset: bars.reset,
    still: still.length,
    others: others.length,
    addRecall: share(count(still, 'add'), still.length),
    falseReset: share(count(still, 'reset'), still.length),
    falseAdd: share(count(others, 'add'), others.length),
    resetRecall: share(count(others, 'reset'), others.length),
    middle: { 'same-problem': strip(same), unrelated: strip(other), items: middle.length, wrong: share(same.wrongCount + other.wrongCount, middle.length) },
  }
}

export type ScanOptions = {
  /** The most of the still-unresolved messages a pair may clear (issue #45: 2%). */
  maxFalseReset: number
  /** Optionally, the most of the other messages a pair may add one for (none by default: the issue's rule has no such limit). */
  maxFalseAdd?: number
  /** The grid's step (0.01). */
  step?: number
}

export type Scan = {
  /** The mod's present bars. */
  current: BarFigures
  /** The pick, or null when no pair is within the limits. */
  best: BarFigures | null
  /** For each add bar on the grid (every 0.05), the lowest reset bar within the limits: the choices beside the pick. */
  frontier: BarFigures[]
  /** How many pairs were within the limits, of how many tried. */
  within: number
  tried: number
}

/**
 * The pairs of the grid, every `step` from `step` to 1 − `step`, under the mod's two rules for the bars
 * (decision/unresolved.ts `UnresolvedThresholds`): add + reset over 1, and adding takes less certainty than clearing.
 */
function grid(step: number): UnresolvedThresholds[] {
  const n = Math.round(1 / step)
  const values = Array.from({ length: n - 1 }, (_, i) => Math.round((i + 1) * step * 1e6) / 1e6)
  return values.flatMap((add) => values.filter((reset) => add + reset > 1 + 1e-9 && add < reset).map((reset) => ({ add, reset })))
}

/** Higher first for a figure that is better high (null as the worst). */
const desc = (a: Figure, b: Figure) => (b ?? -1) - (a ?? -1)
/** Lower first for a figure that is better low (null as the best: nothing to get wrong). */
const asc = (a: Figure, b: Figure) => (a ?? 0) - (b ?? 0)

/** Scans the grid of pairs and picks one by the rule above. */
export function scanBars(decisive: readonly TriagePoint[], middle: readonly MiddlePoint[], options: ScanOptions): Scan {
  const step = options.step ?? 0.01
  const tried = grid(step).map((bars) => barFigures(decisive, middle, bars))
  const fits = (figures: BarFigures) => (figures.falseReset ?? 0) <= options.maxFalseReset + 1e-9 && (options.maxFalseAdd === undefined || (figures.falseAdd ?? 0) <= options.maxFalseAdd + 1e-9)
  const within = tried.filter(fits)
  const near = (figures: BarFigures) => Math.abs(figures.add - UNRESOLVED_THRESHOLDS.add) + Math.abs(figures.reset - UNRESOLVED_THRESHOLDS.reset)
  const ranked = [...within].sort(
    (a, b) => desc(a.addRecall, b.addRecall) || asc(a.falseAdd, b.falseAdd) || desc(a.resetRecall, b.resetRecall) || asc(a.middle.wrong, b.middle.wrong) || near(a) - near(b) || a.add - b.add || a.reset - b.reset,
  )
  const shown = (add: number) => Math.abs(Math.round(add * 20) - add * 20) < 1e-6
  const frontier = [...new Set(within.map((figures) => figures.add))]
    .filter(shown)
    .sort((a, b) => a - b)
    .map((add) => within.filter((figures) => figures.add === add).reduce((low, figures) => (figures.reset < low.reset ? figures : low)))
  return { current: barFigures(decisive, middle, UNRESOLVED_THRESHOLDS), best: ranked[0] ?? null, frontier, within: within.length, tried: tried.length }
}

/** An item of the dataset as the scan reads it: its id, the relation of its middle, its final gold. */
export type ScanItem = { id: string; relation: Relation; gold: Pick<FinalGold, 'triage_final' | 'triage_decisive'> }

/**
 * The points of a flow file: each decisive message with its gold, each item's last message with `triage_final`, each
 * middle message with the relation of its item. A message with no answer (the request failed) is left out and counted;
 * an item with no finished flow is named.
 */
export function scanPoints(flow: Pick<FlowFile, 'items'>, items: readonly ScanItem[]): { decisive: TriagePoint[]; final: TriagePoint[]; middle: MiddlePoint[]; missing: { items: string[]; unanswered: number } } {
  const decisive: TriagePoint[] = []
  const final: TriagePoint[] = []
  const middle: MiddlePoint[] = []
  const missing = { items: [] as string[], unanswered: 0 }
  for (const item of items) {
    const kept = flow.items[item.id]
    if (kept?.final === undefined) {
      missing.items.push(item.id)
      continue
    }
    const golds = new Map(item.gold.triage_decisive.map((answer) => [answer.msg, answer.triage]))
    kept.messages.forEach((message, i) => {
      const last = i === kept.messages.length - 1
      const gold = last ? item.gold.triage_final : golds.get(message.msg)
      const isMiddle = message.part === 'middle'
      if (gold === undefined && !isMiddle) return
      if (message.triage === undefined) {
        missing.unanswered++
        return
      }
      if (isMiddle) middle.push({ id: item.id, msg: message.msg, relation: item.relation, probs: message.triage })
      else (last ? final : decisive).push({ id: item.id, msg: message.msg, gold: gold as UnresolvedOption, probs: message.triage })
    })
  }
  return { decisive, final, middle, missing }
}
