// What a run reports, from its graded answers (runner.ts), per variant:
//
// - accuracy in each language: acceptable answers over all items (an item
//   with no answer counts as wrong; how many failed is beside it), and how
//   often the answer was the gold one;
// - the gap, Chinese accuracy minus English, and whether it passes the bar
//   (Chinese at most 4 points below English, exactly 4 passing: MAX_GAP);
// - answers that came after the mod's wait (`slowMs`, its timeoutMs): how
//   many in each language, and the accuracy the mod would have had, those
//   counted as no decision (`inTime`);
// - agreement: of the items answered in both languages, how many got the
//   same answer in both;
// - latency over answered requests: p50 and p90 by nearest rank, the max,
//   and how many took longer than `slowMs` (the mod's timeout);
// - wrong answers by tag, most first.
//
// And, for the dataset, the score of always giving the same answer (a
// constant baseline: with acceptable sets two levels wide, a constant can do
// well), and of the suite's other baselines (an answer that depends on the
// item, such as keeping its current level).
//
// A suite that grades the parts of an answer (Grade.parts, such as a
// dispatched agent's model and effort) gets each part's accuracy beside the
// whole answer's: in each language, by tag (wrong answers) and for each
// constant answer.
//
// Pure. Rates are rounded to four places.

import type { Language } from './datasets.ts'
import type { Row } from './runner.ts'
import type { AnyItem, Settings, Suite } from './suite.ts'

/**
 * Chinese may be at most this far below English: exactly 4 points below
 * passes, 4.01 does not. The person's bar since 2026-10-05; the spec said 3
 * (中文准确率比英文低不超过 3 个百分点).
 */
export const MAX_GAP = 0.04

export type LanguageSummary = {
  items: number
  answered: number
  failed: number
  accuracy: number
  exact: number
  /** Wrong answers by the way they missed. */
  misses: Record<string, number>
  /** Each part's accuracy (a suite that grades parts): items whose answer got that part right, over all items. */
  parts?: Record<string, number>
  /** Answers that took longer than the mod waits (`slowMs`): the mod would have gone on without them. */
  late: number
  /** Accuracy as the mod would have had it: a late answer counts as no decision (wrong). */
  inTime: number
}

export type TagSummary = {
  tag: string
  items: number
  wrong: Record<Language, number>
  /** Wrong answers by part (a suite that grades parts); an unanswered item is wrong in every part. */
  parts?: Record<string, Record<Language, number>>
}

export type VariantSummary = {
  variant: string
  zh: LanguageSummary
  en: LanguageSummary
  gap: number
  pass: boolean
  agreement: { items: number; same: number; rate: number | null }
  latency: { answers: number; p50: number | null; p90: number | null; max: number | null; slow: number }
  tags: TagSummary[]
  /** The suite's own figures (Suite.breakdown), when it has them. */
  breakdown?: Readonly<Record<string, unknown>>
}

export type Summary = {
  items: number
  variants: VariantSummary[]
  constants: { answer: string; accuracy: number; exact: number; parts?: Record<string, number> }[]
}

/** `settings`: the run's (settingsFrom), which a suite's own figures may read (Suite.breakdown); without them there are none. */
export function summarize<I extends AnyItem, P>(suite: Suite<I, P>, items: readonly I[], rows: readonly Row<P>[], options: { slowMs: number; settings?: Settings }): Summary {
  const variants = [...new Set(rows.map((row) => row.variant))]
  const parts = partNames(rows.map((row) => row.parts))
  const { settings } = options
  // A baseline: the answer `answer` gives each item, scored on the whole dataset.
  const baseline = (label: string, answer: (item: I) => P) => {
    const grades = items.map((item) => suite.grade(item, answer(item)))
    const named = partNames(grades.map((grade) => grade.parts))
    return {
      answer: label,
      accuracy: rate(grades.filter((g) => g.correct).length, items.length),
      exact: rate(grades.filter((g) => g.exact).length, items.length),
      ...(named.length > 0 ? { parts: Object.fromEntries(named.map((name) => [name, rate(grades.filter((g) => g.parts?.[name] === true).length, items.length)])) } : {}),
    }
  }
  return {
    items: items.length,
    variants: variants.map((variant) => {
      const mine = rows.filter((row) => row.variant === variant)
      const summary = summarizeVariant(items, mine, variant, options.slowMs, parts)
      return suite.breakdown === undefined || settings === undefined ? summary : { ...summary, breakdown: suite.breakdown(items, mine, variant, settings) }
    }),
    constants: [
      ...suite.constants.map((answer) => baseline(suite.show(answer), () => answer)),
      ...Object.entries(suite.baselines ?? {}).map(([name, answer]) => baseline(name, answer)),
    ],
  }
}

/** The parts answers are graded on, in the order the suite names them; none for a suite that grades whole answers only. */
function partNames(parts: readonly (Readonly<Record<string, boolean>> | null | undefined)[]): string[] {
  const names: string[] = []
  for (const one of parts) for (const name of Object.keys(one ?? {})) if (!names.includes(name)) names.push(name)
  return names
}

function summarizeVariant(items: readonly AnyItem[], rows: readonly Row<unknown>[], variant: string, slowMs: number, parts: readonly string[]): VariantSummary {
  const of = (language: Language) => rows.filter((row) => row.language === language)
  const zh = languageSummary(items.length, of('zh'), parts, slowMs)
  const en = languageSummary(items.length, of('en'), parts, slowMs)
  const gap = round(zh.accuracy - en.accuracy)

  const byId = (language: Language) => new Map(of(language).map((row) => [row.id, row]))
  const [zhRows, enRows] = [byId('zh'), byId('en')]
  let both = 0
  let same = 0
  for (const item of items) {
    const [a, b] = [zhRows.get(item.id), enRows.get(item.id)]
    if (!a?.ok || !b?.ok) continue
    both++
    if (a.shown === b.shown) same++
  }

  const times = rows.flatMap((row) => (row.ms === null ? [] : [row.ms])).sort((a, b) => a - b)

  const tags = new Map<string, Omit<TagSummary, 'tag'>>()
  for (const item of items) {
    for (const tag of item.tags) {
      const entry = tags.get(tag) ?? { items: 0, wrong: { zh: 0, en: 0 }, ...(parts.length > 0 ? { parts: Object.fromEntries(parts.map((name) => [name, { zh: 0, en: 0 }])) } : {}) }
      entry.items++
      for (const language of ['zh', 'en'] as const) {
        const row = (language === 'zh' ? zhRows : enRows).get(item.id)
        if (row !== undefined && !row.correct) entry.wrong[language]++
        for (const name of parts) if (row !== undefined && row.parts?.[name] !== true) (entry.parts?.[name] as Record<Language, number>)[language]++
      }
      tags.set(tag, entry)
    }
  }

  return {
    variant,
    zh,
    en,
    gap,
    pass: passes(gap),
    agreement: { items: both, same, rate: both === 0 ? null : rate(same, both) },
    latency: { answers: times.length, p50: nearestRank(times, 0.5), p90: nearestRank(times, 0.9), max: times.at(-1) ?? null, slow: times.filter((ms) => ms > slowMs).length },
    tags: [...tags]
      .map(([tag, entry]) => ({ tag, ...entry }))
      .sort((a, b) => b.wrong.zh + b.wrong.en - (a.wrong.zh + a.wrong.en) || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)),
  }
}

function languageSummary(items: number, rows: readonly Row<unknown>[], parts: readonly string[], slowMs: number): LanguageSummary {
  const late = (row: Row<unknown>) => row.ms !== null && row.ms > slowMs
  const misses: Record<string, number> = {}
  for (const row of rows) if (row.miss !== null) misses[row.miss] = (misses[row.miss] ?? 0) + 1
  return {
    items,
    answered: rows.filter((row) => row.ok).length,
    failed: rows.filter((row) => !row.ok).length,
    accuracy: rate(rows.filter((row) => row.correct).length, items),
    exact: rate(rows.filter((row) => row.exact).length, items),
    misses,
    ...(parts.length > 0 ? { parts: Object.fromEntries(parts.map((name) => [name, rate(rows.filter((row) => row.parts?.[name] === true).length, items)])) } : {}),
    late: rows.filter(late).length,
    inTime: rate(rows.filter((row) => row.correct && !late(row)).length, items),
  }
}

/** Whether a gap (Chinese accuracy minus English, rounded to four places) is within the bar: at most MAX_GAP below. */
export function passes(gap: number): boolean {
  return round(gap) >= -MAX_GAP
}

/** The value at rank ceil(p·n) of the sorted values (nearest rank); null for none. */
export function nearestRank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number
}

/** count over of, rounded to four places; 0 when there is nothing to count over. */
export function rate(count: number, of: number): number {
  return of === 0 ? 0 : round(count / of)
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
