// Two runs compared item by item (lib/paired.ts), or the effort rules' thresholds scanned over stored answers; nothing is
// asked of any decision model.
//
//   node dispatch-pilot/eval/paired.ts <A> <B>               each variant both runs have: right in A, right in B, only A,
//                                                             only B, the exact McNemar p
//   node dispatch-pilot/eval/paired.ts <A>:zh-score <B>:zh-score@0.45,0.2 --language zh
//   node dispatch-pilot/eval/paired.ts --scan <A>:zh-score <B>:en-score ...
//                                                             thetaMax x roundUp: the mean accuracy over the runs given, best first
//
// A run is a result file of eval/run.ts, or of eval/ctx30.ts (its variants are the requests it sent: regular, long, or
// the state budget's). `:variant` picks one; `@thetaMax,roundUp` grades its stored answers again under those rules
// (lib/rescore.ts `regrade`: effort-submit and subagent), else they are graded as they were stored.
// --language zh|en: only that language's answers.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { paired, scanRules, type Outcomes, type Rules } from './lib/paired.ts'
import { regrade, type StoredAnswers } from './lib/rescore.ts'
import { DATASETS_DIR, readDataset, shown } from './node.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { scan: { type: 'boolean', default: false }, language: { type: 'string' } } })
const language = values.language
if (language !== undefined && language !== 'zh' && language !== 'en') throw new Error(`--language takes zh or en, not ${language}`)

type Spec = { path: string; variant: string | null; rules: Rules | null }
function spec(text: string): Spec {
  const [head, rules] = text.split('@') as [string, string | undefined]
  const at = head.lastIndexOf(':')
  const path = at > 0 && head.endsWith('.json') === false ? head.slice(0, at) : head
  const variant = path === head ? null : head.slice(at + 1)
  if (rules === undefined) return { path, variant, rules: null }
  const [thetaMax, roundUp] = rules.split(',').map(Number)
  if (!Number.isFinite(thetaMax) || !Number.isFinite(roundUp)) throw new Error(`@ takes thetaMax,roundUp, not ${rules}`)
  return { path, variant, rules: { thetaMax: thetaMax as number, roundUp: roundUp as number } }
}

type Result = StoredAnswers & { suite?: string; experiment?: string; runs?: Record<string, unknown> }
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Result
const itemsOf = (suite: string) => readDataset(join(DATASETS_DIR, `${suite}.jsonl`)).items as { id: string }[]

/** The variants a run has. */
function variantsOf(result: Result): string[] {
  return result.experiment === 'ctx30' ? Object.keys(result.runs ?? {}) : result.summary.variants.map((v) => v.variant)
}

/** One variant's grade of each item (and language), as stored or under `rules`. */
function outcomes(result: Result, variant: string, rules: Rules | null): Outcomes {
  const out = new Map<string, boolean>()
  if (result.experiment === 'ctx30') {
    for (const row of result.answers) {
      const read = row[variant] as { answer?: string } | null | undefined
      out.set(String(row.id), read?.answer === row.gold)
    }
    return out
  }
  const lines = result.answers.filter((line) => (line.repeat ?? 1) === 1 && (language === undefined || line.language === language))
  for (const line of lines) {
    const own = line[variant] as { correct?: boolean } | undefined
    if (own !== undefined) out.set(`${line.id} ${line.language}`, own.correct === true)
  }
  if (rules === null) return out
  const suite = result.suite ?? ''
  for (const key of out.keys()) out.set(key, false)
  for (const one of regrade(suite, result, itemsOf(suite), rules)) {
    const key = `${one.id} ${one.language}`
    if (one.variant === variant && out.has(key)) out.set(key, one.correct)
  }
  return out
}

const pct = (n: number, of: number) => (of === 0 ? '-' : `${((100 * n) / of).toFixed(1)}%`)

if (values.scan) {
  const runs = positionals.map(spec).map((one) => {
    if (one.variant === null) throw new Error(`--scan takes each run with its variant: ${one.path}:<variant>`)
    return { ...one, result: read(one.path) }
  })
  // A run of 0.9.0 or later records no thresholds (it decided by the base rule): the scan starts from 0.8.x's.
  const settings = runs[0]?.result.settings
  const first = { thetaMax: settings?.thetaMax ?? 0.5, roundUp: settings?.roundUp ?? 0.3 }
  const accuracy = (rules: Rules) => runs.reduce((sum, run) => {
    const own = outcomes(run.result, run.variant as string, rules)
    return sum + [...own.values()].filter(Boolean).length / Math.max(1, own.size)
  }, 0) / runs.length
  const scanned = scanRules(accuracy, first)
  const asRun = accuracy(first)
  console.log(`runs: ${runs.map((run) => `${shown(run.path)}:${run.variant}`).join(', ')}${language === undefined ? '' : ` (${language})`}`)
  console.log(`as run (thetaMax ${first.thetaMax}, roundUp ${first.roundUp}): mean ${(asRun * 100).toFixed(1)}%`)
  for (const { rules, accuracy: mean } of scanned.slice(0, 10)) {
    const each = runs.map((run) => {
      const own = outcomes(run.result, run.variant as string, rules)
      return pct([...own.values()].filter(Boolean).length, own.size)
    })
    console.log(`thetaMax ${rules.thetaMax.toFixed(2)} roundUp ${rules.roundUp.toFixed(2)}: mean ${(mean * 100).toFixed(1)}% (${each.join(', ')})`)
  }
} else {
  const [a, b] = positionals.map(spec)
  if (a === undefined || b === undefined || positionals.length !== 2) throw new Error('usage: node dispatch-pilot/eval/paired.ts <A>[:variant][@thetaMax,roundUp] <B>[...] [--language zh|en] | --scan <run>:<variant> ...')
  const ra = read(a.path)
  const rb = read(b.path)
  const pairs = a.variant !== null || b.variant !== null
    ? [[a.variant ?? b.variant, b.variant ?? a.variant] as [string, string]]
    : variantsOf(ra).filter((variant) => variantsOf(rb).includes(variant)).map((variant) => [variant, variant] as [string, string])
  if (pairs.length === 0) throw new Error('the two runs have no variant in common: name them (<file>:<variant>)')
  const rulesText = (rules: Rules | null) => (rules === null ? '' : `@${rules.thetaMax},${rules.roundUp}`)
  console.log(`A ${shown(a.path)}${rulesText(a.rules)}\nB ${shown(b.path)}${rulesText(b.rules)}${language === undefined ? '' : `\nlanguage ${language}`}`)
  for (const [va, vb] of pairs) {
    const r = paired(outcomes(ra, va, a.rules), outcomes(rb, vb, b.rules))
    console.log(`${va === vb ? va : `${va} / ${vb}`}: n ${r.n}, A ${r.rightA} (${pct(r.rightA, r.n)}), B ${r.rightB} (${pct(r.rightB, r.n)}), only A ${r.onlyA}, only B ${r.onlyB}, exact McNemar p=${r.p.toFixed(4)}`)
  }
}
