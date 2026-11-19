// Run with `node dispatch-pilot/eval/mine.ts --projects <dir>… --out <data dir>/mined.jsonl` (calibration plan, Task 3).
// Reads the session record files (<session id>.jsonl) directly in each projects directory and writes the material
// lib/transcript.ts mines from them, one JSON object a line, every text scrubbed; material still holding a key, a token
// or a user's path is dropped and counted. A session's folder (its subagents' records among others) is not read: a
// subagent's records are no main loop. Writes nothing but the --out file, which must be in an existing directory.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { mine, screen } from './lib/transcript.ts'
import type { Mined } from './lib/transcript.ts'

const USAGE = 'usage: node dispatch-pilot/eval/mine.ts --projects <dir>… --out <file>'

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

function parseArgs(argv: readonly string[]): { projects: string[]; out: string } {
  const projects: string[] = []
  let out: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--out') {
      out = argv[++i] ?? fail(USAGE)
    } else if (a === '--projects') {
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) projects.push(argv[++i]!)
    } else {
      fail(`unknown argument: ${a}\n${USAGE}`)
    }
  }
  if (projects.length === 0 || out === null) fail(USAGE)
  return { projects, out }
}

const { projects, out } = parseArgs(process.argv.slice(2))
if (!existsSync(dirname(out)) || !statSync(dirname(out)).isDirectory()) fail(`no such directory for --out: ${dirname(out)}`)

const mined: Mined[] = []
let files = 0
let unreadable = 0
for (const dir of projects) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`not a directory: ${dir}`)
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl') && statSync(join(dir, name)).isFile())
    .sort()
  for (const name of names) {
    files += 1
    const records: unknown[] = []
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        records.push(JSON.parse(line))
      } catch {
        unreadable += 1
      }
    }
    mined.push(...mine(basename(name, '.jsonl'), records))
  }
}

const { kept, dropped } = screen(mined, homedir(), userInfo().username)
// The material is private (global constraints): readable by its owner only.
writeFileSync(out, kept.map((m) => JSON.stringify(m)).join('\n') + (kept.length > 0 ? '\n' : ''), { mode: 0o600 })

const count = (kind: Mined['kind']): number => kept.filter((m) => m.kind === kind).length
const checkpoints = kept.filter((m) => m.kind === 'midrun' && m.isCheckpoint).length
console.log(
  `${files} session files (${unreadable} unreadable lines skipped): submit ${count('submit')}, midrun ${count('midrun')} (${checkpoints} checkpoints), agent ${count('agent')}; ` +
    `dropped ${dropped} holding a key, a token or a user's path; wrote ${out}`,
)
