// Stored answers decided again under the rules of the AA routing (eval/lib/rescore.ts), the figures of the rule
// before it beside the rule now; nothing is asked of any decision model, nothing is written to a result file.
//
//   node dispatch-pilot/eval/rescore.ts                every eval/results/<suite>/*.json (not probes/)
//   node dispatch-pilot/eval/rescore.ts <file> ...     these files
//   node dispatch-pilot/eval/rescore.ts --markdown     the table as Markdown (for the docs)
//   node dispatch-pilot/eval/rescore.ts --theta-down 0.55,0.6,0.65 [<file> ...]
//                                                      a scan of the mid-turn lowering gate: the level sent at each
//                                                      thetaDown (the other rules as shipped), per variant and language
//                                                      (zh, en, both), effort-midturn results only
//
// Each row: the suite and file, the variant, what is decided (`picked` the level of the answer, `sent` the level the
// mod goes on at, `agent` a dispatched agent's model and effort, the model as stored), the answers decided (n), then
// accuracy, gold, too high and too low, before -> now, in percent. A dispatched agent's rows also have the effort
// part's accuracy. The model part of a subagent run is as it was stored: the model options were reworded, so the
// effect of the new wording needs the suite run again (eval/run.ts).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { AgentItem, EffortMidturnItem, EffortSubmitItem } from './lib/datasets.ts'
import { rescoreAgents, rescoreMidturn, rescoreSubmit, scanThetaDown, type Compared, type StoredAnswers, type Tally } from './lib/rescore.ts'
import { DATASETS_DIR, RESULTS_DIR, readDataset, shown } from './node.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { markdown: { type: 'boolean', default: false }, 'theta-down': { type: 'string' } } })

const files =
  positionals.length > 0
    ? positionals
    : readdirSync(RESULTS_DIR)
        .filter((suite) => suite !== 'probes' && statSync(join(RESULTS_DIR, suite)).isDirectory())
        .flatMap((suite) => readdirSync(join(RESULTS_DIR, suite)).filter((name) => name.endsWith('.json')).map((name) => join(RESULTS_DIR, suite, name)))
        .sort()

const items = (suite: string) => readDataset(join(DATASETS_DIR, `${suite}.jsonl`)).items

const pct = (value: number) => (value * 100).toFixed(1)
const pair = (before: number, now: number) => `${pct(before)} -> ${pct(now)}`
const row = (cells: readonly string[]) => (values.markdown ? `| ${cells.join(' | ')} |` : cells.join('  '))
const line = (name: string, compared: Compared) => {
  const { before, now }: { before: Tally; now: Tally } = compared
  const extra = before.effort === undefined || now.effort === undefined ? [] : [pair(before.effort, now.effort)]
  return row([name, compared.variant, compared.what, String(now.n), pair(before.accuracy, now.accuracy), pair(before.gold, now.gold), pair(before.over, now.over), pair(before.under, now.under), ...extra])
}

const thetas = values['theta-down']?.split(',').map(Number)
if (thetas?.some((theta) => !Number.isFinite(theta) || theta < 0 || theta > 1)) throw new Error(`--theta-down takes numbers from 0 to 1 separated by commas, not ${values['theta-down']}`)

const out: string[] =
  thetas === undefined
    ? [row(['file', 'variant', 'what', 'n', 'accuracy', 'gold', 'too high', 'too low', 'effort part'])]
    : [row(['file', 'variant', 'language', 'thetaDown', 'n', 'accuracy', 'gold', 'too high', 'too low'])]
if (values.markdown) out.push(`|${'---|'.repeat(9)}`)
for (const file of files) {
  const result = JSON.parse(readFileSync(file, 'utf8')) as StoredAnswers & { suite: string }
  const name = shown(file).replace(/^eval\/results\//, '').replace(/\.json$/, '')
  if (thetas !== undefined) {
    // The scan of the lowering gate: the level sent at each, effort-midturn results only.
    if (result.suite !== 'effort-midturn') continue
    for (const { variant, language, thetaDown, sent } of scanThetaDown(result, items('effort-midturn') as unknown as EffortMidturnItem[], thetas)) {
      out.push(row([name, variant, language, thetaDown.toFixed(2), String(sent.n), pct(sent.accuracy), pct(sent.gold), pct(sent.over), pct(sent.under)]))
    }
    continue
  }
  const compared =
    result.suite === 'effort-submit'
      ? rescoreSubmit(result, items('effort-submit') as unknown as EffortSubmitItem[])
      : result.suite === 'effort-midturn'
        ? rescoreMidturn(result, items('effort-midturn') as unknown as EffortMidturnItem[])
        : result.suite === 'subagent'
          ? rescoreAgents(result, items('subagent') as unknown as AgentItem[])
          : []
  for (const one of compared) out.push(line(name, one))
}
console.log(out.join('\n'))
