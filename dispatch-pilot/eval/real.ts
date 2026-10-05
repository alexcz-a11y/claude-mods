// What the saved answers of an effort suite say as they were given (no rule applied again): accuracy, gold,
// too high and too low per variant, to put two real runs side by side (for a run before a rule change and one
// after, `rescore.ts` is the offline counterpart). Reads result files, asks nothing.
//
//   node dispatch-pilot/eval/real.ts <results file> [<results file> ...]

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isEffort } from '../hooks/decision/effort.ts'
import type { EffortMidturnItem, EffortSubmitItem } from './lib/datasets.ts'
import { gradeEffort } from './lib/effort-submit.ts'
import { rate } from './lib/metrics.ts'
import { DATASETS_DIR, MOD_DIR, readDataset, shown } from './node.ts'

const pct = (value: number) => (value * 100).toFixed(1)
console.log(['file', 'variant', 'n', 'accuracy', 'gold', 'too high', 'too low'].join('  '))
for (const path of process.argv.slice(2)) {
  const file = [resolve(path), resolve(MOD_DIR, path)].find((candidate) => {
    try {
      readFileSync(candidate)
      return true
    } catch {
      return false
    }
  })
  if (file === undefined) throw new Error(`no results file ${path}`)
  const result = JSON.parse(readFileSync(file, 'utf8')) as { suite: string; summary: { variants: { variant: string }[] }; answers: Record<string, unknown>[] }
  const items = readDataset(join(DATASETS_DIR, `${result.suite}.jsonl`)).items as unknown as (EffortSubmitItem | EffortMidturnItem)[]
  const byId = new Map(items.map((item) => [item.id, item]))
  for (const { variant } of result.summary.variants) {
    // `answer` is the level the answer picked; a mid-turn answer also keeps `sent`, the level the mod went on at.
    for (const field of result.suite === 'effort-midturn' ? (['answer', 'sent'] as const) : (['answer'] as const)) {
      const grades = result.answers.flatMap((line) => {
        const answer = line[variant] as Record<string, unknown> | undefined
        const item = byId.get(String(line.id))
        const level = answer?.[field]
        return item !== undefined && answer !== undefined && answer.failure === undefined && isEffort(level) ? [gradeEffort(item, level)] : []
      })
      const share = (count: number) => pct(rate(count, grades.length))
      console.log(
        [shown(file).replace(/^eval\/results\//, ''), `${variant}${field === 'sent' ? ' (sent)' : ''}`, String(grades.length), share(grades.filter((g) => g.correct).length), share(grades.filter((g) => g.exact).length), share(grades.filter((g) => g.miss === 'over').length), share(grades.filter((g) => g.miss === 'under').length)].join('  '),
      )
    }
  }
}
