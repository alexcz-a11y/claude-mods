// Checks eval datasets against their format (lib/datasets.ts states it).
//
//   node dispatch-pilot/eval/validate.ts                      every eval/datasets/*.jsonl
//   node dispatch-pilot/eval/validate.ts effort-submit        eval/datasets/effort-submit.jsonl
//   node dispatch-pilot/eval/validate.ts path/to/skill.jsonl  a file elsewhere (skill-catalog.json beside it)
//
// Exits 1 when any item breaks a rule; warnings (dataset-wide quotas) do not fail.

import { readdirSync } from 'node:fs'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { validateDataset } from './lib/datasets.ts'
import { DATASETS_DIR, datasetFile, readCatalog, readDataset } from './node.ts'

const { positionals } = parseArgs({ allowPositionals: true, options: {} })
const names = positionals.length > 0 ? positionals : readdirSync(DATASETS_DIR).filter((file) => file.endsWith('.jsonl')).map((file) => basename(file, '.jsonl'))

let failed = false
for (const name of names) {
  const { kind, path } = datasetFile(name)
  const { items, errors: unreadable } = readDataset(path)
  const { errors, warnings } = validateDataset(kind, items, { catalog: kind === 'skill' ? readCatalog(path) : undefined })
  const all = [...unreadable, ...errors]
  const hard = items.filter((item) => item.difficulty === 'hard').length
  console.log(`${basename(path)}: ${items.length} items (${hard} hard): ${all.length === 0 ? 'ok' : `${all.length} errors`}`)
  for (const error of all) console.log(`  ${error}`)
  for (const warning of warnings) console.log(`  warning: ${warning}`)
  if (all.length > 0) failed = true
}
process.exit(failed ? 1 : 0)
