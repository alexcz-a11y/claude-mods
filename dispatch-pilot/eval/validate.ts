// Run with `node dispatch-pilot/eval/validate.ts` (scripts/check.sh does).
// Code Mode does not run with a mod whose hooks module registers any of these events (checked against the
// module's source text, matcher or not), so keep them out of every file under hooks/.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hooksDir = fileURLToPath(new URL('../hooks/', import.meta.url))

const FORBIDDEN: { why: string; pattern: RegExp }[] = [
  {
    why: 'registers an event that blocks Code Mode',
    pattern: /\bon\(\s*(['"`])(tool\.call|tool\.check|tool\.run|tool\.judge|agent\.offer|session\.send)\1/,
  },
  { why: 'registers a classic.* event, which blocks Code Mode', pattern: /\bon\(\s*(['"`])classic\./ },
  { why: 'registers a tool with $.tool.register', pattern: /\$\.tool\.register\b/ },
]

const files = readdirSync(hooksDir, { recursive: true, encoding: 'utf8' })
  .filter((name) => /\.tsx?$/.test(name))
  .sort()

const found: string[] = []
for (const name of files) {
  readFileSync(join(hooksDir, name), 'utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const { why, pattern } of FORBIDDEN) {
        if (pattern.test(line)) found.push(`hooks/${name}:${i + 1}: ${why}: ${line.trim()}`)
      }
    })
}

if (files.length === 0) found.push('no .ts file under hooks/: the check is looking in the wrong place')

if (found.length > 0) {
  console.error(found.join('\n'))
  process.exit(1)
}
console.log(`dispatch-pilot: ${files.length} hook files, none registers an event that blocks Code Mode`)
