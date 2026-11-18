// Run with `node dispatch-pilot/eval/validate.ts` (scripts/check.sh does).
// The mod registers none of these events in any file under hooks/ (checked against the source text, matcher or not):
// tool.call and its kin act on each tool call itself, inside a Code Mode script too, and the mod makes no decision
// request and no decision per such call; it only notes a call's tool and failure on its result row.
// The module scan takes a state atom only as a const of the file that reads or writes through it, so each file declares
// the atoms it uses: every declaration of one key must be the same line, or the copies could drift apart.
// The board-scenes probe (docs/research/board-scenes) shows the tests' scenes from its own copy of them: the copy must
// be the file itself, byte for byte.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hooksDir = fileURLToPath(new URL('../hooks/', import.meta.url))

const FORBIDDEN: { why: string; pattern: RegExp }[] = [
  {
    why: 'registers an event the mod keeps out of its hooks (no decision per tool call)',
    pattern: /\bon\(\s*(['"`])(tool\.call|tool\.check|tool\.run|tool\.judge|agent\.offer|session\.send)\1/,
  },
  { why: 'registers a classic.* event, which the mod keeps out of its hooks', pattern: /\bon\(\s*(['"`])classic\./ },
  { why: 'registers a tool with $.tool.register', pattern: /\$\.tool\.register\b/ },
]

const files = readdirSync(hooksDir, { recursive: true, encoding: 'utf8' })
  .filter((name) => /\.tsx?$/.test(name))
  .sort()

const ATOM_DECLARATION = /^\s*(?:export\s+)?const\s+\w+\s*=\s*atom\(/
const ATOM_KEY = /\bkey:\s*(['"`])([^'"`]+)\1/

const found: string[] = []
/** The first declaration of each atom key: where it is, and its line trimmed. */
const atoms = new Map<string, { at: string; text: string }>()
for (const name of files) {
  readFileSync(join(hooksDir, name), 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const at = `hooks/${name}:${i + 1}`
      for (const { why, pattern } of FORBIDDEN) {
        if (pattern.test(line)) found.push(`${at}: ${why}: ${line.trim()}`)
      }
      if (!ATOM_DECLARATION.test(line)) return
      const key = ATOM_KEY.exec(line)?.[2]
      if (key === undefined) {
        found.push(`${at}: an atom declaration whose key this check cannot read (keep it on one line): ${line.trim()}`)
        return
      }
      const first = atoms.get(key)
      if (first === undefined) atoms.set(key, { at, text: line.trim() })
      else if (first.text !== line.trim()) found.push(`${first.at} and ${at}: the atom of key '${key}' is declared differently:\n  ${first.text}\n  ${line.trim()}`)
    })
}

if (files.length === 0) found.push('no .ts file under hooks/: the check is looking in the wrong place')

const scenes = fileURLToPath(new URL('../tests/support/scenes.ts', import.meta.url))
const scenesCopy = fileURLToPath(new URL('../../docs/research/board-scenes/hooks/scenes-data.ts', import.meta.url))
if (!existsSync(scenesCopy) || readFileSync(scenesCopy, 'utf8') !== readFileSync(scenes, 'utf8')) {
  found.push('docs/research/board-scenes/hooks/scenes-data.ts is not a copy of dispatch-pilot/tests/support/scenes.ts; from the repository root run:\n  cp dispatch-pilot/tests/support/scenes.ts docs/research/board-scenes/hooks/scenes-data.ts')
}

if (found.length > 0) {
  console.error(found.join('\n'))
  process.exit(1)
}
console.log(`dispatch-pilot: ${files.length} hook files, none registers tool.call or its kin; ${atoms.size} atom keys, each declared alike; the probe's scenes are the tests' own`)
