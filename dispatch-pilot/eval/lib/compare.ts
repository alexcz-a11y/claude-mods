// Two saved runs of a suite side by side (eval/compare.ts): per variant both
// ran, how many answers came out the same (an item in one language answered
// by both), and each headline number of one run beside the other's. Two runs
// of the same prompt show the noise a change has to clear (on 2026-10-04, 4%
// of Jev's answers differed between two identical runs); a run before and
// after a prompt change shows what the change did.
//
// Pure.

/** As much of a saved run (eval/run.ts) as a comparison reads. */
export type SavedRun = {
  summary: {
    variants: readonly {
      variant: string
      zh: { accuracy: number }
      en: { accuracy: number }
      gap: number
      agreement: { rate: number | null }
      latency: { p50: number | null }
    }[]
  }
  answers: readonly Record<string, unknown>[]
}

export type Paired<T> = { a: T; b: T }

export type VariantComparison = {
  variant: string
  /** Answers that are the same in both runs, of `compared` (items answered in both, per language). */
  same: number
  compared: number
  zh: Paired<number>
  en: Paired<number>
  gap: Paired<number>
  agreement: Paired<number | null>
  p50: Paired<number | null>
}

export function compareRuns(a: SavedRun, b: SavedRun): VariantComparison[] {
  const key = (row: Record<string, unknown>) => `${String(row.id)} ${String(row.language)}`
  const others = new Map(b.answers.map((row) => [key(row), row]))
  return a.summary.variants.flatMap((mine) => {
    const theirs = b.summary.variants.find((v) => v.variant === mine.variant)
    if (theirs === undefined) return []
    let same = 0
    let compared = 0
    for (const row of a.answers) {
      const [x, y] = [answerOf(row, mine.variant), answerOf(others.get(key(row)), mine.variant)]
      if (x === null || y === null) continue
      compared++
      if (x === y) same++
    }
    return [
      {
        variant: mine.variant,
        same,
        compared,
        zh: { a: mine.zh.accuracy, b: theirs.zh.accuracy },
        en: { a: mine.en.accuracy, b: theirs.en.accuracy },
        gap: { a: mine.gap, b: theirs.gap },
        agreement: { a: mine.agreement.rate, b: theirs.agreement.rate },
        p50: { a: mine.latency.p50, b: theirs.latency.p50 },
      },
    ]
  })
}

/** A row's answer under a variant, null when that run has none for it. */
function answerOf(row: Record<string, unknown> | undefined, variant: string): string | null {
  const entry = row?.[variant]
  if (typeof entry !== 'object' || entry === null) return null
  const answer = (entry as Record<string, unknown>).answer
  return typeof answer === 'string' ? answer : null
}
