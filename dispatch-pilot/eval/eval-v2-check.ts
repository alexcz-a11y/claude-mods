// Checks eval v2 files the way their authors write them (datasets/eval-v2/FORMAT.md): a pool segment, an item or a gold
// file, by the folder it is in (pool/, items/, gold-author/, gold-labeler/; a file elsewhere by its fields). The rules are
// lib/eval-v2.ts's, the same eval/validate.ts applies to every file.
//
//   node dispatch-pilot/eval/eval-v2-check.ts dispatch-pilot/eval/datasets/eval-v2/pool/frontend-same-problem-01.json
//   node dispatch-pilot/eval/eval-v2-check.ts dispatch-pilot/eval/datasets/eval-v2/items/      every .json file in a folder
//   node dispatch-pilot/eval/eval-v2-check.ts dispatch-pilot/eval/datasets/eval-v2/            all four folders
//
// One line a file: `ok`, `warn` (it passes; read the notes) or `FAIL`, then what is wrong. Exits 1 when any file fails.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { V2_FOLDERS, checkV2File } from './node.ts'

const args = process.argv.slice(2)
if (args.length === 0 || args.includes('--help')) {
  console.error('usage: node dispatch-pilot/eval/eval-v2-check.ts <file or folder>...')
  process.exit(2)
}

/** The .json files of a folder; eval-v2/ itself stands for its four folders. */
function jsonIn(dir: string): string[] {
  const own = readdirSync(dir).filter((file) => file.endsWith('.json')).sort().map((file) => join(dir, file))
  const folders = V2_FOLDERS.map((folder) => join(dir, folder)).filter((path) => existsSync(path) && statSync(path).isDirectory())
  return folders.length > 0 ? folders.flatMap(jsonIn) : own
}

let checked = 0
let failed = 0
let warned = 0
for (const arg of args) {
  const path = resolve(arg)
  if (!existsSync(path)) {
    console.log(`FAIL  ${arg}: no such file or folder`)
    failed++
    continue
  }
  for (const file of statSync(path).isDirectory() ? jsonIn(path) : [path]) {
    const report = checkV2File(file)
    checked++
    const mark = report.errors.length > 0 ? 'FAIL' : report.warnings.length > 0 ? 'warn' : 'ok'
    if (mark === 'FAIL') failed++
    else if (mark === 'warn') warned++
    console.log(`${mark.padEnd(5)} ${report.path}${report.about === '' ? '' : `: ${report.about}`}`)
    for (const error of report.errors) console.log(`      - ${error}`)
    for (const warning of report.warnings) console.log(`      ~ ${warning}`)
  }
}
if (checked > 1) console.log(`${checked} files: ${checked - failed} pass (${warned} with notes), ${failed} fail`)
process.exit(failed > 0 ? 1 : 0)
