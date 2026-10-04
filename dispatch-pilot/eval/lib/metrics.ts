// What a run reports, from its graded answers (runner.ts), per variant:
//
// - accuracy in each language: acceptable answers over all items (an item
//   with no answer counts as wrong; how many failed is beside it), and how
//   often the answer was the gold one;
// - the gap, Chinese accuracy minus English, and whether it passes the
//   spec's bar (Chinese at most 3 points below English);
// - agreement: of the items answered in both languages, how many got the
//   same answer in both;
// - latency over answered requests: p50 and p90 by nearest rank, the max,
//   and how many took longer than `slowMs` (the mod's timeout);
// - wrong answers by tag, most first;
// - for a suite that groups its items, the accuracy of each group in each
//   language.
//
// And, for the dataset, the score of always giving the same answer (a
// constant baseline: with acceptable sets two levels wide, a constant can do
// well), and of the suite's other baselines (an answer that depends on the
// item, such as keeping its current level).
//
// Pure. Rates are rounded to four places.

import type { Language } from './datasets.ts'
import type { Row } from './runner.ts'
import type { AnyItem, Suite } from './suite.ts'

/** Chinese may be this far below English (spec: 中文准确率比英文低不超过 3 个百分点). */
export const MAX_GAP = 0.03

export type LanguageSummary = {
  items: number
  answered: number
  failed: number
  accuracy: number
  exact: number
  /** Wrong answers by the way they missed. */
  misses: Record<string, number>
}

export type VariantSummary = {
  variant: string
  zh: LanguageSummary
  en: LanguageSummary
  gap: number
  pass: boolean
  agreement: { items: number; same: number; rate: number | null }
  latency: { answers: number; p50: number | null; p90: number | null; max: number | null; slow: number }
  tags: { tag: string; items: number; wrong: Record<Language, number> }[]
  /** Accuracy per group, by group name; only for a suite that groups its items. */
  groups?: { group: string; items: number; accuracy: Record<Language, number> }[]
}

export type Summary = {
  items: number
  variants: VariantSummary[]
  constants: { answer: string; accuracy: number; exact: number }[]
}

export function summarize<I extends AnyItem, P>(suite: Suite<I, P>, items: readonly I[], rows: readonly Row<P>[], options: { slowMs: number }): Summary {
  const variants = [...new Set(rows.map((row) => row.variant))]
  const baseline = (name: string, answer: (item: I) => P) => {
    const grades = items.map((item) => suite.grade(item, answer(item)))
    return { answer: name, accuracy: rate(grades.filter((g) => g.correct).length, items.length), exact: rate(grades.filter((g) => g.exact).length, items.length) }
  }
  return {
    items: items.length,
    variants: variants.map((variant) => summarizeVariant(items, rows.filter((row) => row.variant === variant), variant, options.slowMs, suite.group)),
    constants: [
      ...suite.constants.map((answer) => baseline(suite.show(answer), () => answer)),
      ...Object.entries(suite.baselines ?? {}).map(([name, answer]) => baseline(name, answer)),
    ],
  }
}

function summarizeVariant<I extends AnyItem>(items: readonly I[], rows: readonly Row<unknown>[], variant: string, slowMs: number, group?: (item: I) => string): VariantSummary {
  const of = (language: Language) => rows.filter((row) => row.language === language)
  const zh = languageSummary(items.length, of('zh'))
  const en = languageSummary(items.length, of('en'))
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

  const tags = new Map<string, { items: number; wrong: Record<Language, number> }>()
  for (const item of items) {
    for (const tag of item.tags) {
      const entry = tags.get(tag) ?? { items: 0, wrong: { zh: 0, en: 0 } }
      entry.items++
      for (const language of ['zh', 'en'] as const) {
        const row = (language === 'zh' ? zhRows : enRows).get(item.id)
        if (row !== undefined && !row.correct) entry.wrong[language]++
      }
      tags.set(tag, entry)
    }
  }

  return {
    variant,
    zh,
    en,
    gap,
    pass: gap >= -MAX_GAP,
    agreement: { items: both, same, rate: both === 0 ? null : rate(same, both) },
    latency: { answers: times.length, p50: nearestRank(times, 0.5), p90: nearestRank(times, 0.9), max: times.at(-1) ?? null, slow: times.filter((ms) => ms > slowMs).length },
    tags: [...tags]
      .map(([tag, entry]) => ({ tag, ...entry }))
      .sort((a, b) => b.wrong.zh + b.wrong.en - (a.wrong.zh + a.wrong.en) || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)),
    ...(group === undefined ? {} : { groups: groupAccuracy(items, group, zhRows, enRows) }),
  }
}

/** Each group's accuracy in each language (an unanswered item counts as wrong), groups by name. */
function groupAccuracy<I extends AnyItem>(items: readonly I[], group: (item: I) => string, zh: ReadonlyMap<string, Row<unknown>>, en: ReadonlyMap<string, Row<unknown>>) {
  const names = [...new Set(items.map(group))].sort()
  return names.map((name) => {
    const members = items.filter((item) => group(item) === name)
    const right = (rows: ReadonlyMap<string, Row<unknown>>) => members.filter((item) => rows.get(item.id)?.correct === true).length
    return { group: name, items: members.length, accuracy: { zh: rate(right(zh), members.length), en: rate(right(en), members.length) } }
  })
}

function languageSummary(items: number, rows: readonly Row<unknown>[]): LanguageSummary {
  const misses: Record<string, number> = {}
  for (const row of rows) if (row.miss !== null) misses[row.miss] = (misses[row.miss] ?? 0) + 1
  return {
    items,
    answered: rows.filter((row) => row.ok).length,
    failed: rows.filter((row) => !row.ok).length,
    accuracy: rate(rows.filter((row) => row.correct).length, items),
    exact: rate(rows.filter((row) => row.exact).length, items),
    misses,
  }
}

/** The value at rank ceil(p·n) of the sorted values (nearest rank); null for none. */
function nearestRank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number
}

function rate(count: number, of: number): number {
  return of === 0 ? 0 : round(count / of)
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
