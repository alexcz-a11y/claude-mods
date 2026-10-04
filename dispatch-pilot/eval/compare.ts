// Two saved runs side by side (lib/compare.ts): per variant, how many
// answers are the same and how each headline number moved. Nothing is sent.
//
//   node dispatch-pilot/eval/compare.ts eval/results/effort-submit/<a>.json eval/results/effort-submit/<b>.json

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { compareRuns, type Paired, type SavedRun } from './lib/compare.ts'
import { MOD_DIR } from './node.ts'

const { positionals } = parseArgs({ allowPositionals: true, options: {} })
if (positionals.length !== 2) {
  console.error('usage: node dispatch-pilot/eval/compare.ts <results a.json> <results b.json>')
  process.exit(2)
}
const runs = positionals.map((path) => {
  const full = [resolve(path), resolve(MOD_DIR, path)].find((candidate) => {
    try {
      readFileSync(candidate)
      return true
    } catch {
      return false
    }
  })
  if (full === undefined) {
    console.error(`no results file ${path}`)
    process.exit(2)
  }
  return JSON.parse(readFileSync(full, 'utf8')) as SavedRun & { suite: string; label: string | null; date: string; backend: { answeredBy: string[] }; run: { concurrency: number } }
})
const [a, b] = runs as [(typeof runs)[number], (typeof runs)[number]]
for (const [name, r] of [['a', a], ['b', b]] as const) {
  console.log(`${name}: ${r.suite} ${r.label ?? ''} ${r.date} by ${r.backend.answeredBy.join(', ')}, ${r.run.concurrency} in flight`)
}

const pct = (rate: number | null) => (rate === null ? '-' : (rate * 100).toFixed(1))
const pair = (p: Paired<number | null>, show: (n: number | null) => string) => `${show(p.a)} -> ${show(p.b)}`
const pad = (cells: readonly string[]) => cells.map((cell, i) => (i === 0 ? cell.padEnd(10) : cell.padStart(i === 1 ? 9 : 15))).join(' ')
console.log(pad(['variant', 'same', 'zh acc %', 'en acc %', 'gap pts', 'agree %', 'p50 ms']))
for (const c of compareRuns(a, b)) {
  console.log(
    pad([
      c.variant,
      `${c.same}/${c.compared}`,
      pair(c.zh, pct),
      pair(c.en, pct),
      pair(c.gap, pct),
      pair(c.agreement, pct),
      pair(c.p50, (n) => String(n ?? '-')),
    ]),
  )
}
