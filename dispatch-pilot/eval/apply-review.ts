// Applies the user's review decisions to a dataset in the repo, then checks
// it again (lib/review.ts says how decisions apply).
//
//   node dispatch-pilot/eval/apply-review.ts effort-submit --from <wizard's effort-submit.review.jsonl>
//   node dispatch-pilot/eval/apply-review.ts effort-submit            (eval/review/effort-submit.review.jsonl)
//   ... --dry-run                                                     (show what would change; write nothing)
//
// --from copies the wizard's file to eval/review/<set>.review.jsonl first:
// the decisions are committed beside the data they changed. Commit both.
// Lists what changed (those items' rationales argued for the old answers:
// rewrite them) and the notes to follow up. Exits 1, writing nothing, when
// the review cannot apply in full.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { validateDataset } from './lib/datasets.ts'
import { applyReview } from './lib/review.ts'
import { REVIEW_DIR, datasetFile, readCatalog, readDataset, shown } from './node.ts'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { from: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } })
const name = positionals[0]
if (name === undefined || positionals.length > 1) {
  console.error('usage: node dispatch-pilot/eval/apply-review.ts <set> [--from <review.jsonl>] [--dry-run]')
  process.exit(2)
}
const { kind, path } = datasetFile(name)
const reviewPath = join(REVIEW_DIR, `${kind}.review.jsonl`)
const source = values.from === undefined ? reviewPath : resolve(values.from)
if (!existsSync(source)) {
  console.error(`no review decisions at ${source}`)
  process.exit(2)
}

const catalog = kind === 'skill' ? readCatalog(path) : undefined
const datasetText = readFileSync(path, 'utf8')
const reviewed = applyReview(kind, datasetText, readFileSync(source, 'utf8'), { catalog })
const { agree, edit, note } = reviewed.verdicts
console.log(`${kind}: ${agree} agree, ${edit} edit, ${note} note; ${reviewed.unreviewed.length} items not reviewed yet`)

if (reviewed.errors.length > 0) {
  console.log('the review cannot apply; nothing was written:')
  for (const error of reviewed.errors) console.log(`  ${error}`)
  process.exit(1)
}
if (reviewed.edited.length > 0) {
  console.log('changed (rewrite their rationale: it argued for the old answers):')
  for (const { id, changes } of reviewed.edited) {
    console.log(`  ${id}: ${Object.entries(changes).map(([field, { from, to }]) => `${field} ${JSON.stringify(from)} -> ${JSON.stringify(to)}`).join('; ')}`)
  }
}
if (reviewed.notes.length > 0) {
  console.log('notes to follow up:')
  for (const { id, verdict, note: text } of reviewed.notes) console.log(`  ${id} (${verdict}): ${text}`)
}

if (values['dry-run']) {
  console.log('dry run: nothing written')
  process.exit(0)
}
if (source !== reviewPath) {
  mkdirSync(REVIEW_DIR, { recursive: true })
  copyFileSync(source, reviewPath)
  console.log(`decisions kept at ${shown(reviewPath)}`)
}
if (reviewed.text !== datasetText) writeFileSync(path, reviewed.text)

// Checked again as written.
const written = readDataset(path)
const { errors } = validateDataset(kind, written.items, { catalog })
const problems = [...written.errors, ...errors]
console.log(`${shown(path)}: ${problems.length === 0 ? 'valid' : `${problems.length} errors`}`)
for (const problem of problems) console.log(`  ${problem}`)
process.exit(problems.length === 0 ? 0 : 1)
