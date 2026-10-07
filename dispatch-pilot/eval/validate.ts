// Checks eval datasets against their format (lib/datasets.ts states it), the
// README's configuration table against plugin.json and the decision models'
// defaults, DEVELOPMENT.md's 「结构」 tree against the modules under hooks/, and
// that only the decision report writes the screens (lib/docs.ts): the checks of the docs a test file cannot make, for it cannot
// read the files.
//
//   node dispatch-pilot/eval/validate.ts                      every eval/datasets/*.jsonl, then the README's configuration table
//   node dispatch-pilot/eval/validate.ts effort-submit        eval/datasets/effort-submit.jsonl
//   node dispatch-pilot/eval/validate.ts path/to/skill.jsonl  a file elsewhere (skill-catalog.json beside it)
//   node dispatch-pilot/eval/validate.ts docs                 only the docs: the configuration table, the 「结构」 tree and the one-writer check
//
// Exits 1 when any item or row breaks a rule; warnings (dataset-wide quotas) do not fail.

import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { validateDataset } from './lib/datasets.ts'
import { checkConfigTable, checkOneWriter, checkStructureTree } from './lib/docs.ts'
import { longContextJsonl } from './long-context-items.ts'
import { DATASETS_DIR, MOD_DIR, catalogFor, datasetFile, readDataset, readManifest } from './node.ts'

const { positionals } = parseArgs({ allowPositionals: true, options: {} })
const everything = positionals.length === 0
const names = everything ? readdirSync(DATASETS_DIR).filter((file) => file.endsWith('.jsonl')).map((file) => basename(file, '.jsonl')) : positionals.filter((name) => name !== 'docs')

let failed = false
for (const name of names) {
  const { kind, path } = datasetFile(name)
  const { items, errors: unreadable } = readDataset(path)
  const { errors, warnings } = validateDataset(kind, items, { catalog: catalogFor(kind, path) })
  // The long-context file is written from the items module (its one source): a hand edit of the JSONL is an error.
  const drift = kind === 'long-context' && readFileSync(path, 'utf8') !== longContextJsonl() ? ['the file is not what eval/long-context-items.ts makes: edit the items there and run node dispatch-pilot/eval/long-context-gen.ts'] : []
  const all = [...unreadable, ...errors, ...drift]
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
  const hooks = join(MOD_DIR, 'hooks')
  const modules = readdirSync(hooks, { recursive: true, encoding: 'utf8' }).filter((path) => /\.tsx?$/.test(path)).map((path) => path.split('\\').join('/'))
  const drift = checkStructureTree(readFileSync(join(MOD_DIR, 'DEVELOPMENT.md'), 'utf8'), modules)
  console.log(`DEVELOPMENT.md structure tree: ${drift.length === 0 ? 'ok' : `${drift.length} problems`}`)
  for (const problem of drift) console.log(`  ${problem}`)
  if (drift.length > 0) failed = true
  const writers = checkOneWriter(Object.fromEntries(modules.map((path) => [path, readFileSync(join(hooks, path), 'utf8')])))
  console.log(`hooks/ one writer of the screens (ADR 0004): ${writers.length === 0 ? 'ok' : `${writers.length} problems`}`)
  for (const problem of writers) console.log(`  ${problem}`)
  if (writers.length > 0) failed = true
}
process.exit(failed ? 1 : 0)
