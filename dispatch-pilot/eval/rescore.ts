// Stored answers decided again under the rules of the AA routing (eval/lib/rescore.ts), the figures of the rule
// before it beside the rule now; nothing is asked of any decision model, nothing is written to a result file.
//
//   node dispatch-pilot/eval/rescore.ts                every eval/results/<suite>/*.json (not probes/)
//   node dispatch-pilot/eval/rescore.ts <file> ...     these files
//   node dispatch-pilot/eval/rescore.ts --markdown     the table as Markdown (for the docs)
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
import { rescoreAgents, rescoreMidturn, rescoreSubmit, type Compared, type StoredAnswers, type Tally } from './lib/rescore.ts'
import { DATASETS_DIR, RESULTS_DIR, readDataset, shown } from './node.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { markdown: { type: 'boolean', default: false } } })

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

const out: string[] = [row(['file', 'variant', 'what', 'n', 'accuracy', 'gold', 'too high', 'too low', 'effort part'])]
if (values.markdown) out.push('|---|---|---|---|---|---|---|---|---|')
for (const file of files) {
  const result = JSON.parse(readFileSync(file, 'utf8')) as StoredAnswers & { suite: string }
  const name = shown(file).replace(/^eval\/results\//, '').replace(/\.json$/, '')
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
