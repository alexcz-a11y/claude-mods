// Scans the three-way question's two bars over flow files (#45 for #42; lib/eval-v2-thresholds.ts): the decisive messages
// with a gold answer (eval-v2/gold/ `triage_decisive`) and the probabilities each flow file kept for them; of the pairs
// that clear the count at no more than --max-false-reset of the messages still unresolved, the one that adds one for the
// most; and what each pair does to the count in the middle rounds (cleared in a same-problem stretch, raised in an
// unrelated one). Nothing is asked of any model.
//
//   node dispatch-pilot/eval/eval-v2-thresholds.ts dispatch-pilot/eval/results/eval-v2-flow/jev-24000.json
//   node dispatch-pilot/eval/eval-v2-thresholds.ts dispatch-pilot/eval/results/eval-v2-flow/pplx-48000.json dispatch-pilot/eval/results/eval-v2-flow/pplx-135000.json
//
// Several files: each on its own, then all their messages together (one backend's set over its budgets).
// Options: --max-false-reset 0.02 (issue #45), --max-false-add <share> (none by default: the issue's rule has no such
// limit, and without one the pick can be a low add bar that adds one for almost every message: read the frontier and the
// middle rounds beside it), --step 0.01, --out <file> (the scans as JSON, e.g. under eval/results/eval-v2/).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { parseArgs } from 'node:util'
import type { Relation } from './lib/eval-v2.ts'
import type { FlowFile } from './lib/eval-v2-flow.ts'
import { barFigures, scanBars, scanPoints, type BarFigures, type MiddlePoint, type Scan, type ScanItem, type TriagePoint } from './lib/eval-v2-thresholds.ts'
import { EVAL_V2_GENERATED, readFinalGold, shown } from './node.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'max-false-reset': { type: 'string', default: '0.02' }, 'max-false-add': { type: 'string' }, step: { type: 'string', default: '0.01' }, out: { type: 'string' } },
})
if (positionals.length === 0) {
  console.error('usage: node dispatch-pilot/eval/eval-v2-thresholds.ts <flow file> [<flow file> ...] [--max-false-reset 0.02] [--max-false-add <share>] [--step 0.01] [--out <file>]')
  process.exit(2)
}
const options = { maxFalseReset: Number(values['max-false-reset']), ...(values['max-false-add'] === undefined ? {} : { maxFalseAdd: Number(values['max-false-add']) }), step: Number(values.step) }

// The items: their relation from generated.json, their final gold.
const generated = JSON.parse(readFileSync(EVAL_V2_GENERATED, 'utf8')) as { items: { id: string; relation: Relation }[] }
const items: ScanItem[] = generated.items.map((item) => {
  const { gold, errors } = readFinalGold(item.id, null)
  if (gold === null) {
    console.error(errors.join('\n'))
    process.exit(2)
  }
  return { id: item.id, relation: item.relation, gold }
})

const pct = (figure: number | null) => (figure === null ? '    -' : `${(figure * 100).toFixed(1).padStart(5)}%`)
const row = (label: string, f: BarFigures) =>
  `  ${label.padEnd(9)} add ${f.add.toFixed(2)} reset ${f.reset.toFixed(2)} | add recall ${pct(f.addRecall)}  false reset ${pct(f.falseReset)} | false add ${pct(f.falseAdd)}  reset recall ${pct(f.resetRecall)} | middle: same-problem cleared ${pct(f.middle['same-problem'].reset)} (added ${pct(f.middle['same-problem'].add)}), unrelated added ${pct(f.middle.unrelated.add)}, wrong ${pct(f.middle.wrong)}`

function report(name: string, points: { decisive: TriagePoint[]; final: TriagePoint[]; middle: MiddlePoint[] }, missing: { items: string[]; unanswered: number }, scan: Scan): void {
  const still = points.decisive.filter((point) => point.gold === 'still_unresolved').length
  console.log(`${name}: ${points.decisive.length} decisive messages with gold (${still} still unresolved, ${points.decisive.length - still} others), ${points.middle.length} middle messages (${points.middle.filter((point) => point.relation === 'same-problem').length} same-problem, ${points.middle.filter((point) => point.relation === 'unrelated').length} unrelated), ${points.final.length} last messages`)
  if (missing.items.length > 0) console.log(`  missing: no finished flow for ${missing.items.length} items (${missing.items.slice(0, 10).join(', ')}${missing.items.length > 10 ? ', …' : ''})`)
  if (missing.unanswered > 0) console.log(`  ${missing.unanswered} messages with gold or in the middle had no answer (the request failed): left out`)
  console.log(row('now', scan.current))
  console.log(scan.best === null ? `  no pair clears at most ${pct(options.maxFalseReset)} of the still-unresolved messages${options.maxFalseAdd === undefined ? '' : ` with false adds at most ${pct(options.maxFalseAdd)}`} (${scan.tried} tried)` : row('pick', scan.best))
  console.log(`  ${scan.within} of ${scan.tried} pairs (add + reset > 1 and add < reset, step ${options.step}) within the limits; for each add bar, the lowest reset bar within them:`)
  for (const figures of scan.frontier) console.log(row('', figures))
  const last = (bars: BarFigures) => barFigures(points.final, [], bars)
  console.log(`  last messages (triage_final), as a check: now add recall ${pct(last(scan.current).addRecall)}, false reset ${pct(last(scan.current).falseReset)}, false add ${pct(last(scan.current).falseAdd)}${scan.best === null ? '' : `; pick add recall ${pct(last(scan.best).addRecall)}, false reset ${pct(last(scan.best).falseReset)}, false add ${pct(last(scan.best).falseAdd)}`}`)
}

const scans: Record<string, unknown> = {}
const pooled = { decisive: [] as TriagePoint[], final: [] as TriagePoint[], middle: [] as MiddlePoint[], missing: { items: [] as string[], unanswered: 0 } }
const files: { file: string; backend: FlowFile['backend']; settings: FlowFile['settings'] }[] = []
for (const path of positionals) {
  if (!existsSync(path)) {
    console.error(`no flow file ${path}`)
    process.exit(2)
  }
  const flow = JSON.parse(readFileSync(path, 'utf8')) as FlowFile
  if (flow.suite !== 'eval-v2-flow') {
    console.error(`${path} is not a flow file (eval/eval-v2-flow.ts writes them)`)
    process.exit(2)
  }
  files.push({ file: shown(path), backend: flow.backend, settings: flow.settings })
  // Each message is tagged with its file, so that pooled points of two budgets stay apart by id.
  const points = scanPoints(flow, items)
  const tag = basename(path, '.json')
  const scan = scanBars(points.decisive, points.middle, options)
  report(`${shown(path)} (${flow.backend.name}, state ${flow.settings.stateTokens}, bars at the run ${flow.settings.thresholds.add}/${flow.settings.thresholds.reset})`, points, points.missing, scan)
  scans[tag] = { points: { decisive: points.decisive.length, middle: points.middle.length, final: points.final.length }, missing: points.missing, ...scan }
  pooled.decisive.push(...points.decisive.map((point) => ({ ...point, id: `${tag}:${point.id}` })))
  pooled.final.push(...points.final.map((point) => ({ ...point, id: `${tag}:${point.id}` })))
  pooled.middle.push(...points.middle.map((point) => ({ ...point, id: `${tag}:${point.id}` })))
  pooled.missing.items.push(...points.missing.items.map((id) => `${tag}:${id}`))
  pooled.missing.unanswered += points.missing.unanswered
}
if (positionals.length > 1) {
  const scan = scanBars(pooled.decisive, pooled.middle, options)
  report(`all ${positionals.length} files together`, pooled, pooled.missing, scan)
  scans.pooled = { points: { decisive: pooled.decisive.length, middle: pooled.middle.length, final: pooled.final.length }, missing: pooled.missing, ...scan }
}
if (values.out !== undefined) {
  mkdirSync(dirname(values.out), { recursive: true })
  writeFileSync(values.out, `${JSON.stringify({ date: new Date().toISOString(), files, options, rule: 'of the pairs whose false reset (still-unresolved messages that clear the count) is within maxFalseReset (and false add within maxFalseAdd, when set), the highest add recall; ties: lower false add, higher reset recall, fewer wrong moves in the middle rounds, nearer the mod\'s 0.5/0.7', scans }, null, 2)}\n`)
  console.log(`saved ${shown(values.out)}`)
}
