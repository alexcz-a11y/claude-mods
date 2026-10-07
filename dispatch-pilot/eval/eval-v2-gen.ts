// Writes the eval v2 dataset (#45): every item's whole conversation, assembled from the pool by lib/eval-v2.ts
// buildEvalV2 (datasets/eval-v2/FORMAT.md「生成」), as datasets/eval-v2.jsonl (tens of megabytes: not committed, see the
// .gitignore beside it) and its record datasets/eval-v2/generated.json (committed: the seed, the JSONL's sha256 and size,
// each item's depths and length). eval/validate.ts builds the JSONL again from the files and checks it against the record.
//
//   node dispatch-pilot/eval/eval-v2-gen.ts               writes both, with the seed generated.json names (else "eval-v2")
//   node dispatch-pilot/eval/eval-v2-gen.ts --seed s2     another seed (the record keeps it)
//   node dispatch-pilot/eval/eval-v2-gen.ts --check       writes nothing; exits 1 when generated.json (or eval-v2.jsonl, when
//                                                         there is one) is not what the files make
//
// Refuses (exit 1) when a file under eval-v2/ has errors or the pool cannot fill an item.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { BIN_NAMES, BINS, RELATIONS } from './lib/eval-v2.ts'
import { EVAL_V2_GENERATED, EVAL_V2_JSONL, evalV2Seed, generateEvalV2, readEvalV2, shown, shownV2 } from './node.ts'

const { values } = parseArgs({ options: { seed: { type: 'string' }, check: { type: 'boolean', default: false } } })
const read = readEvalV2()
const bad = read.reports.filter((report) => report.errors.length > 0)
if (bad.length > 0) {
  console.log(`${bad.length} files under eval-v2/ have errors; fix them first (node dispatch-pilot/eval/eval-v2-check.ts <file> says what):`)
  for (const report of bad) for (const error of report.errors) console.log(`  ${report.path}: ${error}`)
  process.exit(1)
}
const seed = values.seed ?? evalV2Seed()
const made = generateEvalV2(read.segments, read.items, seed)
for (const warning of made.built.warnings) console.log(`warning: ${warning}`)
if (made.built.errors.length > 0) {
  console.log(`the pool cannot fill ${made.built.errors.length} items; nothing written:`)
  for (const error of made.built.errors) console.log(`  ${error}`)
  process.exit(1)
}

if (values.check) {
  const record = existsSync(EVAL_V2_GENERATED) && readFileSync(EVAL_V2_GENERATED, 'utf8') === made.generated
  const local = !existsSync(EVAL_V2_JSONL) || readFileSync(EVAL_V2_JSONL, 'utf8') === made.jsonl
  console.log(`${shownV2(EVAL_V2_GENERATED)}: ${record ? 'is what the files make' : 'differs from what the files make (or is missing): run node dispatch-pilot/eval/eval-v2-gen.ts'}`)
  if (!local) console.log(`${shown(EVAL_V2_JSONL)}: differs from what the files make: run node dispatch-pilot/eval/eval-v2-gen.ts`)
  process.exit(record && local ? 0 : 1)
}

writeFileSync(EVAL_V2_JSONL, made.jsonl)
writeFileSync(EVAL_V2_GENERATED, made.generated)
const records = made.built.records
const range = (numbers: readonly number[]) => (numbers.length === 0 ? '-' : `${Math.min(...numbers)}–${Math.max(...numbers)}`)
const sorted = records.map((record) => record.tokens).sort((a, b) => a - b)
console.log(`${shown(EVAL_V2_JSONL)}: ${records.length} items, ${made.bytes} bytes, sha256 ${made.sha256.slice(0, 12)}… (seed ${JSON.stringify(seed)})`)
console.log(`  total tokens ${range(sorted)}, median ${sorted[Math.floor(sorted.length / 2)] ?? '-'}`)
for (const bin of BIN_NAMES) {
  const group = records.filter((record) => record.bin === bin)
  if (group.length === 0) continue
  const counts = RELATIONS.map((relation) => `${group.filter((record) => record.relation === relation).length} ${relation}`).join(', ')
  console.log(`  ${bin}: ${group.length} items (${counts}); depth ${range(group.map((record) => record.depth))}, newest decisive line ${range(group.map((record) => record.depth_end))} (the bin: ${BINS[bin].least}–${BINS[bin].most})`)
}
const uses = Object.values(made.built.uses)
console.log(`  pool: ${uses.filter((n) => n > 0).length} of ${uses.length} segments used, at most ${Math.max(0, ...uses)} times each`)
console.log(`${shownV2(EVAL_V2_GENERATED)}: written; commit it (eval-v2.jsonl stays out of git)`)
