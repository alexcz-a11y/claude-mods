// Run with `node dispatch-pilot/eval/notes.ts [--data <dir>] [--dry-run] [--only <case id>] [--force]` (calibration plan,
// Task 12 Step 1). Writes each mid-run case's input.notes = { before, after } back into the file the case came from:
// eval/cases/midrun.json (model-written) or <data>/cases/midrun.json (from real sessions; --data, default
// ~/.config/dispatch-pilot/calibration). "before" is built up over input.recent as the mod builds it (one call per
// step, each on the note before it), "after" on the latest step. A note is the mod's own prompt (progressPrompt) answered by
// `claude -p --model haiku --setting-sources project` and read with parseProgress; a reply it cannot read, a failed call or one over 120 s gives
// no note (the note before it stands). This is not the mod's own path ($.model.complete at low effort with a 200-token cap): the record says so.
//
//   --dry-run   how many notes would be written, and the first prompt; calls nothing, changes no file
//   --only <id> this case alone
//   --force     rewrite notes already there (without it a case that has notes is left alone)
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseProgress } from '../hooks/progress.ts'
import type { ProgressNote } from '../hooks/statebuild.ts'
import { pool } from './lib/budget.ts'
import { checkCase } from './lib/case.ts'
import type { MidrunCase } from './lib/case.ts'
import { callRecord, callsFor, firstPrompt, foldNotes, noteArgs, noteEnv, notesWanted, withNotes } from './lib/notes.ts'
import type { Notes } from './lib/notes.ts'

const USAGE = 'usage: node dispatch-pilot/eval/notes.ts [--data <dir>] [--dry-run] [--only <case id>] [--force]'
const REPO_FILE = fileURLToPath(new URL('./cases/midrun.json', import.meta.url))
// Each call runs in a fresh empty directory here, so its session record does not land among this project's; that record
// (cleaned real session text) is removed after the call, as the call's directory is.
const CALL_ROOT = '/private/tmp/dp-notes'
const CALL_MS = 120_000
const CONCURRENCY = 4

function fail(message: string, code = 1): never {
  console.error(message)
  process.exit(code)
}

type Args = { data: string; dryRun: boolean; only: string | null; force: boolean }

function parseArgs(argv: readonly string[]): Args {
  const a: Args = { data: join(homedir(), '.config', 'dispatch-pilot', 'calibration'), dryRun: false, only: null, force: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    const value = (): string => argv[++i] ?? fail(`${flag} needs a value\n${USAGE}`, 2)
    if (flag === '--data') a.data = value()
    else if (flag === '--only') a.only = value()
    else if (flag === '--dry-run') a.dryRun = true
    else if (flag === '--force') a.force = true
    else fail(`unknown argument: ${flag}\n${USAGE}`, 2)
  }
  return a
}

type Source = { path: string; cases: MidrunCase[] }

function readSource(path: string): Source {
  if (!existsSync(path)) return { path, cases: [] }
  let v: unknown
  try {
    v = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    fail(`${path}: not JSON`)
  }
  if (!Array.isArray(v)) fail(`${path}: not a JSON array of cases`)
  const problems = v.flatMap((c) => checkCase(c, []).map((p) => `${(c as { id?: string }).id ?? '?'} (${path}): ${p}`))
  if (problems.length > 0) fail(problems.join('\n'))
  const cases = v as MidrunCase[]
  const other = cases.find((c) => c.category !== 'midrun')
  if (other !== undefined) fail(`${path}: ${other.id} is not a midrun case`)
  return { path, cases }
}

// As the files are written elsewhere (one space of indent, a newline at the end); the data file stays 0600.
function writeSource(s: Source): void {
  writeFileSync(s.path, JSON.stringify(s.cases, null, 1) + '\n', { mode: 0o600 })
}

type Prompt = { system: string; prompt: string }
type Called = { note: ProgressNote | null; why: string }

// The calls in the air: their process groups and directories, so an interrupted run leaves none behind.
const live = new Map<number, string>()

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

// A call's directory and the session record Claude Code wrote for it under ~/.claude/projects/.
function removeCall(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
  const record = callRecord(homedir(), dir)
  if (record !== null) rmSync(record, { recursive: true, force: true })
}

/** One note: claude -p in a fresh directory, without the telemetry variables or the key; killed (its whole group) after CALL_MS. */
function call(p: Prompt): Promise<Called> {
  mkdirSync(CALL_ROOT, { recursive: true, mode: 0o700 })
  const dir = mkdtempSync(join(CALL_ROOT, 'call-'))
  return new Promise<Called>((resolve) => {
    let out = ''
    let settled = false
    const done = (c: Called): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child.pid !== undefined) live.delete(child.pid)
      removeCall(dir)
      resolve(c)
    }
    // detached: its own process group, so a kill takes the hooks and tools it started too.
    const child = spawn('claude', noteArgs(p.system), { cwd: dir, env: noteEnv(process.env), stdio: ['pipe', 'pipe', 'ignore'], detached: true })
    if (child.pid !== undefined) live.set(child.pid, dir)
    const timer = setTimeout(() => {
      if (child.pid !== undefined) killGroup(child.pid)
      done({ note: null, why: 'timeout' })
    }, CALL_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (out += chunk))
    child.on('error', (err) => done({ note: null, why: `not started: ${err.message}` }))
    child.on('close', (code) => {
      if (code !== 0) return done({ note: null, why: `exit ${code}` })
      const note = parseProgress(out)
      done({ note, why: note === null ? 'unreadable' : 'ok' })
    })
    child.stdin.on('error', () => {
      // a child that died before reading: its close says why
    })
    child.stdin.end(p.prompt)
  })
}

async function notesFor(c: MidrunCase): Promise<{ notes: Notes; whys: string[] }> {
  const whys: string[] = []
  const notes = await foldNotes(c.input, async (p) => {
    const r = await call(p)
    whys.push(r.why)
    return r.note
  })
  return { notes, whys }
}

function cleanRoot(): void {
  try {
    if (existsSync(CALL_ROOT) && readdirSync(CALL_ROOT).length === 0) rmdirSync(CALL_ROOT)
  } catch {
    // another run's calls are still there
  }
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2))
  const sources = [readSource(REPO_FILE), readSource(join(a.data, 'cases', 'midrun.json'))]
  const all = sources.flatMap((s) => s.cases.map((c) => ({ c, s })))
  if (a.only !== null && !all.some((x) => x.c.id === a.only)) fail(`no midrun case ${a.only}`)
  const todo = all.filter((x) => (a.only === null || x.c.id === a.only) && notesWanted(x.c, a.force))
  const calls = todo.reduce((n, x) => n + callsFor(x.c.input), 0)
  const noBefore = todo.filter((x) => x.c.input.recent.length === 0).map((x) => x.c.id)
  console.log(`${todo.length * 2} notes for ${todo.length} cases (of ${all.length}): ${calls} calls (one per recent step and one for "after")${noBefore.length > 0 ? `; "before" is null for ${noBefore.join(', ')} (no recent step)` : ''}`)
  if (a.dryRun) {
    const first = todo[0]
    if (first !== undefined) {
      const p = firstPrompt(first.c.input)
      console.log(`first prompt (${first.c.id}):\n--- system\n${p.system}\n--- prompt\n${p.prompt}`)
    }
    return
  }
  // Interrupted (a terminal's Ctrl-C, a caller's timeout, a closed terminal): the calls are in their own process groups,
  // so they would run on without their time limit; kill them and remove their directories before exiting.
  const onSignal = (): void => {
    for (const [pid, dir] of live) {
      killGroup(pid)
      removeCall(dir)
    }
    cleanRoot()
    process.exit(130)
  }
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(s, onSignal)
  try {
    await pool(todo, {
      concurrency: CONCURRENCY,
      reserve: () => true,
      run: async (x) => {
        const r = await notesFor(x.c)
        // Written as each case finishes, into its own file, so an interrupted run keeps what it had.
        x.s.cases = withNotes(x.s.cases, x.c.id, r.notes)
        writeSource(x.s)
        console.log(`${x.c.id}: ${r.whys.join(', ')} (the last is "after")`)
        return r
      },
    })
  } finally {
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(s, onSignal)
    cleanRoot()
  }
}

await main()
