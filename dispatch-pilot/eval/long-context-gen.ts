// Writes eval/datasets/long-context.jsonl from the items in long-context-items.ts (the dataset's one source: edit the items there,
// never the JSONL; the long stretch of ordinary work in each conversation is made when the conversation is built, from the
// item's vocabulary and id: lib/long-conversation.ts).
//
//   node dispatch-pilot/eval/long-context-gen.ts            writes the file
//   node dispatch-pilot/eval/long-context-gen.ts --check    exits 1 when the file is not what the items make (eval/validate.ts does the same)

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { longContextJsonl } from './long-context-items.ts'
import { DATASETS_DIR, shown } from './node.ts'

const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } })
const path = join(DATASETS_DIR, 'long-context.jsonl')
const text = longContextJsonl()
if (values.check) {
  const same = existsSync(path) && readFileSync(path, 'utf8') === text
  console.log(`${shown(path)}: ${same ? 'is what long-context-items.ts makes' : 'differs from what long-context-items.ts makes: run node dispatch-pilot/eval/long-context-gen.ts'}`)
  process.exit(same ? 0 : 1)
}
writeFileSync(path, text)
console.log(`${shown(path)}: ${text.split('\n').length - 1} items, ${text.length} bytes`)
