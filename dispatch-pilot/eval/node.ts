// What the eval's Node scripts share: where things are, reading datasets,
// the credentials, and the host side of a decision backend (Node's fetch and
// timers in place of $.http.fetch and $.clock.sleep).
//
// Node only (fs, process): the tests never import this file; they import the
// pure modules under lib/. Node 22.18+ runs .ts as is.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Backend, BackendIo } from '../hooks/decision/backend.ts'
import { clefBackend } from '../hooks/decision/clef.ts'
import { jevBackend } from '../hooks/decision/jev.ts'
import { isKind, parseJsonl, type Kind } from './lib/datasets.ts'
import { optionsFor, settingsFrom, type OptionSpec, type SuiteHost } from './lib/suite.ts'

/** The mod's directory (dispatch-pilot/). */
export const MOD_DIR = resolve(import.meta.dirname, '..')
export const EVAL_DIR = join(MOD_DIR, 'eval')
export const DATASETS_DIR = join(EVAL_DIR, 'datasets')
export const REVIEW_DIR = join(EVAL_DIR, 'review')
export const RESULTS_DIR = join(EVAL_DIR, 'results')

/** The mod's manifest (.claude-plugin/plugin.json): its options as the engine reads them (`optionsFrom` takes them). */
export function readManifest(): { userConfig?: Record<string, OptionSpec> } {
  return JSON.parse(readFileSync(join(MOD_DIR, '.claude-plugin', 'plugin.json'), 'utf8'))
}

/**
 * A short hash of every file a run's requests and grades come from, by its
 * path under the mod: the mod's hooks (the features, the core and the
 * decision modules the suites import) and the eval's suites (eval/lib).
 * Two runs with the same hashes asked and graded the same way.
 */
export function modCode(): Record<string, string> {
  const files = [join(MOD_DIR, 'hooks'), join(EVAL_DIR, 'lib')].flatMap((dir) =>
    (readdirSync(dir, { recursive: true }) as string[])
      .map((name) => join(dir, name))
      .filter((path) => statSync(path).isFile())
      .sort(),
  )
  return Object.fromEntries(files.map((path) => [relative(MOD_DIR, path), createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex').slice(0, 16)]))
}

/** A path as the scripts print it: relative to the mod when inside it. */
export function shown(path: string): string {
  const inside = relative(MOD_DIR, path)
  return inside.startsWith('..') ? path : inside
}

/** A dataset named by its kind (`effort-submit`) or by a path to its JSONL; the kind is the file's name. */
export function datasetFile(nameOrPath: string): { kind: Kind; path: string } {
  const path = nameOrPath.endsWith('.jsonl') ? resolve(nameOrPath) : join(DATASETS_DIR, `${nameOrPath}.jsonl`)
  const kind = basename(path, '.jsonl')
  if (!isKind(kind)) throw new Error(`${basename(path)}: a dataset file is named after its kind (effort-submit, effort-midturn, subagent, skill)`)
  return { kind, path }
}

/** A dataset's raw text, its items and the lines that did not parse. */
export function readDataset(path: string): { text: string; items: Record<string, unknown>[]; errors: string[] } {
  const text = readFileSync(path, 'utf8')
  return { text, ...parseJsonl(text) }
}

/** What checking a dataset of `kind` reads besides its items: the skill catalog beside a skill dataset; nothing for the others. */
export function catalogFor(kind: Kind, datasetPath: string): unknown {
  return kind === 'skill' ? nodeHost(datasetPath).beside('skill-catalog.json') : undefined
}

/**
 * What a suite may read besides the items of the dataset at `datasetPath`
 * (SuiteHost), over Node's file system; `onBeside` hears of each file it
 * reads beside the dataset, with its text (the results record its hash).
 */
export function nodeHost(datasetPath: string, onBeside?: (name: string, text: string) => void): SuiteHost {
  const dir = resolve(datasetPath, '..')
  return {
    beside: (name) => {
      const path = join(dir, name)
      if (!existsSync(path)) return undefined
      const text = readFileSync(path, 'utf8')
      onBeside?.(name, text)
      return JSON.parse(text)
    },
    read: async (path) => readFileSync(path.replace(/^~(?=\/|$)/, homedir()), 'utf8'),
  }
}

/** Where credentials are read when the environment does not have them. */
export const CREDENTIALS_FILE = join(homedir(), '.config', 'dispatch-pilot', 'eval.env')

/**
 * A credential: the process environment first, then CREDENTIALS_FILE
 * (`NAME=value` lines; `#` comments, `export ` and quotes allowed). Never
 * printed or written anywhere by the eval.
 */
export function credential(name: string): string | undefined {
  const fromEnv = process.env[name]
  if (fromEnv) return fromEnv
  if (!existsSync(CREDENTIALS_FILE)) return undefined
  for (const line of readFileSync(CREDENTIALS_FILE, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match === null || match[1] !== name) continue
    const value = (match[2] as string).replace(/^(["'])(.*)\1$/, '$2')
    return value || undefined
  }
  return undefined
}

/**
 * The decision backend under evaluation (`jev` or `clef`), with the
 * credentials it needs (`credential`); `secrets` are those values, to keep
 * them out of anything written. Throws, saying what is missing, when a
 * credential is not found or the backend is not known.
 */
export function backendFor(name: string, model?: string): { backend: Backend; secrets: string[] } {
  if (name === 'jev') {
    const key = credential('TYPESAFE_API_KEY')
    if (key === undefined) throw new Error(`no TYPESAFE_API_KEY in the environment or ${CREDENTIALS_FILE}`)
    return { backend: jevBackend(key, model === undefined ? {} : { model }), secrets: [key] }
  }
  if (name === 'clef') {
    const accountId = credential('CLOUDFLARE_ACCOUNT_ID')
    const apiToken = credential('CLOUDFLARE_AUTH_TOKEN')
    if (accountId === undefined || apiToken === undefined) throw new Error(`CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AUTH_TOKEN must both be in the environment or ${CREDENTIALS_FILE}`)
    return { backend: clefBackend({ accountId, apiToken }), secrets: [accountId, apiToken] }
  }
  throw new Error(`no backend "${name}" (jev, clef)`)
}

/** A result file's text: pretty JSON, each answer on a line of its own (eval/run.ts writes it, eval/resummarize.ts rewrites it). */
export function formatResult(result: Record<string, unknown> & { answers: readonly unknown[] }): string {
  const { answers, ...head } = result
  const top = JSON.stringify(head, null, 2)
  return `${top.slice(0, -2)},\n  "answers": [\n${answers.map((answer) => `    ${JSON.stringify(answer)}`).join(',\n')}\n  ]\n}\n`
}

/** Input price per million tokens, by backend; output is free on both (docs.typesafe.ai/models, the Clef model page; 2026-10-04). */
export const PRICES: Readonly<Record<'jev' | 'clef', number>> = { jev: 0.042, clef: 0.24 }

/**
 * What scripts/decide*.ts share, read with node:util parseArgs: `--clef`
 * (Jev otherwise), `--timeout <ms>`, and each script's own flags (`extra`).
 * Exits 2 with `usage` for a flag it does not know.
 */
export function scriptArgs(usage: string, extra: Record<string, { type: 'string' | 'boolean' }>): { values: Record<string, string | boolean | undefined>; positionals: string[] } {
  try {
    return parseArgs({ allowPositionals: true, options: { clef: { type: 'boolean' }, timeout: { type: 'string' }, ...extra } }) as { values: Record<string, string | boolean | undefined>; positionals: string[] }
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\nusage: ${usage}`)
    process.exit(2)
  }
}

/**
 * The decision model a script asks, with the mod's settings for it (the
 * manifest's defaults, its defaults where the manifest has none, then
 * `assignments` as --option gives them) and its backend (credentials as the
 * eval reads them, never printed). Exits 2 when a credential is missing.
 */
export function scriptDecision(clef: boolean, assignments: readonly string[] = []): { settings: ReturnType<typeof settingsFrom>; backend: Backend } {
  const chosen = clef ? 'clef' : 'jev'
  const settings = settingsFrom(optionsFor(chosen, readManifest().userConfig ?? {}, assignments))
  try {
    return { settings, backend: backendFor(chosen).backend }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}

/** Node's fetch and timers as a backend's host. */
export const nodeIo: BackendIo = {
  fetch: async (url, init) => {
    const response = await fetch(url, { method: init.method, headers: init.headers, body: init.body })
    return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers), text: await response.text() }
  },
  sleep: (ms, signal) =>
    new Promise((done, fail) => {
      if (signal.aborted) return fail(new Error('aborted'))
      const timer = setTimeout(done, ms)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        fail(new Error('aborted'))
      })
    }),
}
