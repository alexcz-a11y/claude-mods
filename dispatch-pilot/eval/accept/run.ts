// Run with `node dispatch-pilot/eval/accept/run.ts --task <id> --arm on|off --mode code|ordinary [--model <model>]
// [--data <dir>] [--work <dir>] [--max-minutes <n>] [--dry-run]` (calibration plan, Task 15 Step 3). One acceptance run:
// the task's project/ copied to <work>/<task>-<arm>-<mode>-<timestamp>-<random>/project, an interactive session in tmux
// (server dpacc, session acc-<the same name>) that loads this mod with --plugin-dir, the task's prompt
// sent, the turn waited out (at most --max-minutes), then check.sh, the session record's usage and the levels its
// requests carried, and the mod's store's count of this session's mid-run decisions (best effort), appended as one line
// to <data>/accept.jsonl. The session, the settings file (the only place the Nace key is written) and the run's
// directory are removed at the end, on failure and on SIGINT, SIGTERM or SIGHUP too.
//
//   --model        default sonnet
//   --data         default ~/.config/dispatch-pilot/calibration
//   --work         default /private/tmp/dp-accept; never a path with the user's name in it (the mod sends the session's
//                  working directory to the decision model)
//   --max-minutes  default 15
//   --dry-run      everything but the session: the directory, the settings file with the key as "DRY-RUN", the tmux
//                  command printed, check.sh on the untouched project (it should fail), then the clean-up
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readLog } from '../../hooks/log.ts'
import { ownMidrun } from './lib/decisions.ts'
import { levelsOf, recordDir, turnEnded, turnSpan } from './lib/records.ts'
import { holdsUser, paneCommand, pasted, screenState, sessionEnv, settingsFor, trustSelected } from './lib/session.ts'
import type { Arm, Mode } from './lib/session.ts'
import { usageOf } from './lib/usage.ts'
import type { Usage } from './lib/usage.ts'

const USAGE = 'usage: node dispatch-pilot/eval/accept/run.ts --task <id> --arm on|off --mode code|ordinary [--model <model>] [--data <dir>] [--work <dir>] [--max-minutes <n>] [--dry-run]'
const MOD_DIR = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/+$/, '')
const TASKS = fileURLToPath(new URL('./tasks/', import.meta.url))
const SERVER = 'dpacc'
// The store file of the mod loaded with --plugin-dir: named after the first 12 hex of sha256("<name>@inline") (so are
// both dispatch-pilot store files on this machine, the inline one and the installed one's "dispatch-pilot@alex-mods").
const STORE = join(homedir(), '.claude', 'plugins', 'store', `dispatch-pilot_inline-${createHash('sha256').update('dispatch-pilot@inline').digest('hex').slice(0, 12)}.json`)
const TICK_MS = 1000
/** No "esc to interrupt" on screen this long, after the record shows the turn's end (the board and the status lines
 * change on their own, so the rest of the screen is not compared). */
const IDLE_MS = 5000
/** The input box on screen this long before the prompt is sent. */
const SETTLE_MS = 3000
/** No prompt in the record this long after sending: Enter once more (a long paste may wait for a second one). */
const RESEND_MS = 30_000
const CHECK_MS = 10 * 60_000
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

function fail(message: string, code = 1): never {
  console.error(message)
  process.exit(code)
}

type Args = { task: string; arm: Arm; mode: Mode; model: string; data: string; work: string; maxMinutes: number; dryRun: boolean }

function parseArgs(argv: readonly string[]): Args {
  const a: Partial<Args> & { model: string; data: string; work: string; maxMinutes: number; dryRun: boolean } = {
    model: 'sonnet',
    data: join(homedir(), '.config', 'dispatch-pilot', 'calibration'),
    work: '/private/tmp/dp-accept',
    maxMinutes: 15,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    const value = (): string => argv[++i] ?? fail(`${flag} needs a value\n${USAGE}`, 2)
    if (flag === '--task') a.task = value()
    else if (flag === '--arm') {
      const v = value()
      if (v !== 'on' && v !== 'off') fail(`--arm takes on or off\n${USAGE}`, 2)
      a.arm = v
    } else if (flag === '--mode') {
      const v = value()
      if (v !== 'code' && v !== 'ordinary') fail(`--mode takes code or ordinary\n${USAGE}`, 2)
      a.mode = v
    } else if (flag === '--model') a.model = value()
    else if (flag === '--data') a.data = value()
    else if (flag === '--work') a.work = value()
    else if (flag === '--max-minutes') {
      const n = Number(value())
      if (!Number.isFinite(n) || n <= 0) fail(`--max-minutes takes a positive number\n${USAGE}`, 2)
      a.maxMinutes = n
    } else if (flag === '--dry-run') a.dryRun = true
    else fail(`unknown argument: ${flag}\n${USAGE}`, 2)
  }
  if (a.task === undefined || a.arm === undefined || a.mode === undefined) fail(`--task, --arm and --mode are needed\n${USAGE}`, 2)
  if (!/^[A-Za-z0-9_-]+$/.test(a.task)) fail(`--task takes a task's folder name\n${USAGE}`, 2)
  return a as Args
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function stampOf(d: Date): string {
  return d.toISOString().replace(/\..*$/, '').replace(/[-:]/g, '').replace('T', '-')
}

function tmux(env: Record<string, string>, ...args: string[]): { status: number | null; out: string } {
  const r = spawnSync('tmux', ['-L', SERVER, ...args], { encoding: 'utf8', env })
  return { status: r.status, out: r.stdout ?? '' }
}

function readStoreLog(): unknown {
  try {
    const v = JSON.parse(readFileSync(STORE, 'utf8')) as Record<string, unknown>
    return v.log
  } catch {
    return []
  }
}

/** The newest record file of the session's folder, parsed; lines that are not JSON are skipped. */
function readRecords(dir: string): unknown[] {
  if (!existsSync(dir)) return []
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, at: statSync(join(dir, f)).mtimeMs }))
    .sort((x, y) => y.at - x.at)
  if (files.length === 0) return []
  return readFileSync(join(dir, files[0]!.f), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as unknown]
      } catch {
        return []
      }
    })
}

function runCheck(checkSh: string, project: string, env: Record<string, string>): number | null {
  const r = spawnSync('bash', [checkSh, project], { encoding: 'utf8', env, timeout: CHECK_MS, stdio: ['ignore', 'pipe', 'pipe'] })
  return r.status
}

type Line = {
  task: string
  arm: Arm
  mode: Mode
  model: string
  pass: boolean
  reason?: string
  usage: Usage
  /** From the mod's store, best effort: null when the decisions cannot be told from another session's. */
  midrunDecisions: number | null
  /** From the session's own record: the levels its requests carried, consecutive repeats made one. */
  levelsSent: string[]
  shifts: number
  startedAt: string
  minutes: number
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2))
  const taskDir = join(TASKS, a.task)
  for (const part of ['prompt.txt', 'check.sh', 'project']) if (!existsSync(join(taskDir, part))) fail(`task ${a.task}: no ${part} in ${taskDir}`)
  const key = a.dryRun ? 'DRY-RUN' : (process.env.NACE_API_KEY ?? '')
  if (key.trim() === '') fail('NACE_API_KEY is not set')

  const started = new Date()
  const stamp = stampOf(started)
  // A short random part: two runs of the same task, arm and mode started in the same second do not meet.
  const name = `${a.task}-${a.arm}-${a.mode}-${stamp}-${randomBytes(2).toString('hex')}`
  // The path the engine sees (and the mod sends): relative paths resolved, symbolic links followed.
  const user = userInfo().username
  const home = realpathSync(homedir())
  const tooNear = `--work: ${a.work} holds the user's name; the mod would send it to the decision model`
  if (holdsUser(resolve(a.work), home, user)) fail(tooNear)
  mkdirSync(a.work, { recursive: true, mode: 0o700 })
  const work = realpathSync(a.work)
  if (holdsUser(work, home, user)) fail(tooNear)
  const runDir = join(work, name)
  const project = join(runDir, 'project')
  const settingsPath = join(runDir, 'settings.json')
  const session = `acc-${name}`
  const env = sessionEnv(process.env, a.mode)
  let live = false

  const cleanUp = (): void => {
    rmSync(settingsPath, { force: true })
    if (live && tmux(env, 'has-session', '-t', session).status === 0) tmux(env, 'kill-session', '-t', session)
    rmSync(runDir, { recursive: true, force: true })
  }
  const onSignal = (): void => {
    cleanUp()
    process.exit(130)
  }
  // A closed terminal (SIGHUP) too: the settings file holds the key.
  for (const s of SIGNALS) process.on(s, onSignal)

  try {
    mkdirSync(runDir, { recursive: true, mode: 0o700 })
    cpSync(join(taskDir, 'project'), project, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(MOD_DIR, '.claude-plugin', 'plugin.json'), 'utf8')) as { userConfig?: Record<string, unknown> }
    writeFileSync(settingsPath, JSON.stringify(settingsFor({ arm: a.arm, mode: a.mode, key, userConfig: manifest.userConfig ?? {} }), null, 2) + '\n', { mode: 0o600 })
    chmodSync(settingsPath, 0o600)
    const pane = paneCommand({ pluginDir: MOD_DIR, settings: settingsPath, model: a.model, mode: a.mode })
    const newSession = ['new-session', '-d', '-s', session, '-x', '220', '-y', '50', '-c', project, '/bin/sh', '-c', pane]
    const checkSh = join(taskDir, 'check.sh')

    if (a.dryRun) {
      console.log(`run directory: ${runDir}`)
      console.log(`settings file (mode ${(statSync(settingsPath).mode & 0o777).toString(8)}):\n${readFileSync(settingsPath, 'utf8')}`)
      console.log(`tmux command: tmux -L ${SERVER} ${newSession.map((s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)).join(' ')}`)
      console.log(`session record folder: ${recordDir(homedir(), project)}`)
      console.log(`store file: ${STORE}`)
      const code = runCheck(checkSh, project, env)
      console.log(`check.sh on the untouched project: exit ${code} (expected: not 0)`)
      return
    }

    const prompt = readFileSync(join(taskDir, 'prompt.txt'), 'utf8')
    const records = recordDir(homedir(), project)
    const seen = new Set(readLog(readStoreLog()).map((d) => d.id))
    const deadline = started.getTime() + a.maxMinutes * 60_000
    if (tmux(env, ...newSession).status !== 0) throw new Error('tmux could not start the session')
    live = true

    let reason: string | undefined
    let sentAt: number | null = null
    let resent = false
    let readySince: number | null = null
    let busyAt = 0
    let trustAt = 0
    for (;;) {
      await sleep(TICK_MS)
      const now = Date.now()
      if (now > deadline) {
        reason = 'timeout'
        break
      }
      if (tmux(env, 'has-session', '-t', session).status !== 0) {
        reason = 'exited'
        break
      }
      const text = tmux(env, 'capture-pane', '-p', '-t', session).out
      const state = screenState(text)
      if (state === 'permission') {
        reason = 'blocked'
        break
      }
      if (state === 'trust') {
        readySince = null
        // The run's own directory. The menu starts on "No, exit", which Enter alone would choose: move down to
        // "Yes, I trust this folder", and press Enter only once the marker is seen there.
        if (now - trustAt < 3000) continue
        trustAt = now
        tmux(env, 'send-keys', '-t', session, 'Down')
        await sleep(500)
        if (!trustSelected(tmux(env, 'capture-pane', '-p', '-t', session).out)) {
          reason = 'trust-dialog'
          break
        }
        tmux(env, 'send-keys', '-t', session, 'Enter')
        continue
      }
      if (sentAt === null) {
        readySince = state === 'ready' ? (readySince ?? now) : null
        if (readySince === null || now - readySince < SETTLE_MS) continue
        tmux(env, 'send-keys', '-t', session, '-l', pasted(prompt))
        await sleep(500)
        tmux(env, 'send-keys', '-t', session, 'Enter')
        sentAt = Date.now()
        busyAt = sentAt
        console.error(`${session}: prompt sent`)
        continue
      }
      if (state === 'busy') busyAt = now
      const recs = readRecords(records)
      if (!resent && turnSpan(recs) === null && now - sentAt >= RESEND_MS) {
        tmux(env, 'send-keys', '-t', session, 'Enter')
        resent = true
      }
      if (turnEnded(recs) && now - busyAt >= IDLE_MS) break
    }

    const killed = tmux(env, 'kill-session', '-t', session)
    if (tmux(env, 'has-session', '-t', session).status === 0) throw new Error(`the tmux session ${session} is still there after kill-session (exit ${killed.status})`)
    live = false
    // The settings file holds the key and the session that read it is gone: removed now, not after runCheck, whose
    // spawnSync keeps the signal handlers from running for up to CHECK_MS. cleanUp removes it on every earlier exit.
    rmSync(settingsPath, { force: true })

    const recs = readRecords(records)
    const span = turnSpan(recs) ?? { startedAt: sentAt ?? started.getTime(), endedAt: Date.now() }
    const own = ownMidrun(readStoreLog(), { seen, startedAt: span.startedAt, endedAt: span.endedAt })
    if (own.midrun === null) console.error(`${session}: another session's turn started with this one; the store's mid-run decisions are not counted`)
    const sent = levelsOf(recs)
    let pass = false
    if (reason === undefined) {
      const code = runCheck(checkSh, project, env)
      pass = code === 0
      if (code === null) reason = 'check-timeout'
    }
    const line: Line = {
      task: a.task,
      arm: a.arm,
      mode: a.mode,
      model: a.model,
      pass,
      ...(reason === undefined ? {} : { reason }),
      usage: usageOf(recs),
      midrunDecisions: own.midrun === null ? null : own.midrun.length,
      levelsSent: sent.levels,
      shifts: sent.shifts,
      startedAt: started.toISOString(),
      minutes: Math.round(((Date.now() - started.getTime()) / 60_000) * 100) / 100,
    }
    mkdirSync(a.data, { recursive: true, mode: 0o700 })
    appendFileSync(join(a.data, 'accept.jsonl'), JSON.stringify(line) + '\n', { mode: 0o600 })
    console.log(JSON.stringify(line))
  } finally {
    cleanUp()
    for (const s of SIGNALS) process.off(s, onSignal)
  }
}

await main()
