// Checks eval datasets against their format (lib/datasets.ts states it), and
// the README's configuration table against plugin.json and the decision
// models' defaults (lib/docs.ts): the one check of the docs a test file
// cannot make, for it cannot read the files.
//
//   node dispatch-pilot/eval/validate.ts                      every eval/datasets/*.jsonl, then the README's configuration table
//   node dispatch-pilot/eval/validate.ts effort-submit        eval/datasets/effort-submit.jsonl
//   node dispatch-pilot/eval/validate.ts path/to/skill.jsonl  a file elsewhere (skill-catalog.json beside it)
//   node dispatch-pilot/eval/validate.ts docs                 only the README's configuration table
//
// Exits 1 when any item or row breaks a rule; warnings (dataset-wide quotas) do not fail.

import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { validateDataset } from './lib/datasets.ts'
import { checkConfigTable } from './lib/docs.ts'
import { DATASETS_DIR, MOD_DIR, catalogFor, datasetFile, readDataset, readManifest } from './node.ts'

const { positionals } = parseArgs({ allowPositionals: true, options: {} })
const everything = positionals.length === 0
const names = everything ? readdirSync(DATASETS_DIR).filter((file) => file.endsWith('.jsonl')).map((file) => basename(file, '.jsonl')) : positionals.filter((name) => name !== 'docs')

let failed = false
for (const name of names) {
  const { kind, path } = datasetFile(name)
  const { items, errors: unreadable } = readDataset(path)
  const { errors, warnings } = validateDataset(kind, items, { catalog: catalogFor(kind, path) })
  const all = [...unreadable, ...errors]
  const hard = items.filter((item) => item.difficulty === 'hard').length
  console.log(`${basename(path)}: ${items.length} items (${hard} hard): ${all.length === 0 ? 'ok' : `${all.length} errors`}`)
  for (const error of all) console.log(`  ${error}`)
  for (const warning of warnings) console.log(`  warning: ${warning}`)
  if (all.length > 0) failed = true
}
if (everything || positionals.includes('docs')) {
  const problems = checkConfigTable(readFileSync(join(MOD_DIR, 'README.md'), 'utf8'), readManifest().userConfig ?? {})
  console.log(`README.md configuration table: ${problems.length === 0 ? 'ok' : `${problems.length} problems`}`)
  for (const problem of problems) console.log(`  ${problem}`)
  if (problems.length > 0) failed = true
}
process.exit(failed ? 1 : 0)
