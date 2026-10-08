// What the eval's Node scripts share: where things are, reading datasets,
// the credentials, and the host side of a decision backend (Node's fetch and
// timers in place of $.http.fetch and $.clock.sleep).
//
// Node only (fs, process): the tests never import this file; they import the
// pure modules under lib/. Node 22.18+ runs .ts as is.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Backend, BackendIo } from '../hooks/decision/backend.ts'
import { jevBackend } from '../hooks/decision/jev.ts'
import { pplxBackend } from '../hooks/decision/pplx.ts'
import { isKind, parseJsonl, type Kind } from './lib/datasets.ts'
import { buildEvalV2, checkFinalGold, checkGold, checkItem, checkSegment, datasetWarnings, evalV2Jsonl, generatedFile, type Built, type FinalGold, type Segment, type V2Item, type V2Record } from './lib/eval-v2.ts'
import { v2Item, type V2EvalItem } from './lib/eval-v2-suite.ts'
import { optionsFor, settingsFrom, type EvalBackend, type OptionSpec, type SuiteHost } from './lib/suite.ts'

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
  if (!isKind(kind)) throw new Error(`${basename(path)}: a dataset file is named after its kind (effort-submit, effort-midturn, subagent, skill, unresolved, long-context)`)
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
 * The decision backend under evaluation (`jev` or `pplx`), with the
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
  if (name === 'pplx') {
    const key = credential('PERPLEXITY_API_KEY')
    if (key === undefined) throw new Error(`no PERPLEXITY_API_KEY in the environment or ${CREDENTIALS_FILE}`)
    return { backend: pplxBackend(key, model === undefined ? {} : { model }), secrets: [key] }
  }
  throw new Error(`no backend "${name}" (jev, pplx)`)
}

/** A result file's text: pretty JSON, each answer on a line of its own (eval/run.ts writes it, eval/resummarize.ts rewrites it). */
export function formatResult(result: Record<string, unknown> & { answers: readonly unknown[] }): string {
  const { answers, ...head } = result
  const top = JSON.stringify(head, null, 2)
  return `${top.slice(0, -2)},\n  "answers": [\n${answers.map((answer) => `    ${JSON.stringify(answer)}`).join(',\n')}\n  ]\n}\n`
}

/**
 * Input price per million tokens, by backend; output is free on all (docs.typesafe.ai/models, 2026-10-04; Perplexity: docs.perplexity.ai/docs/decisions/quickstart, Pricing, 2026-10-07).
 */
export const PRICES: Readonly<Record<EvalBackend, number>> = { jev: 0.042, pplx: 0.02 }

/**
 * What scripts/decide*.ts share, read with node:util parseArgs: `--timeout <ms>`
 * and each script's own flags (`extra`).
 * Exits 2 with `usage` for a flag it does not know.
 */
export function scriptArgs(usage: string, extra: Record<string, { type: 'string' | 'boolean' }>): { values: Record<string, string | boolean | undefined>; positionals: string[] } {
  try {
    return parseArgs({ allowPositionals: true, options: { timeout: { type: 'string' }, ...extra } }) as { values: Record<string, string | boolean | undefined>; positionals: string[] }
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
export function scriptDecision(assignments: readonly string[] = []): { settings: ReturnType<typeof settingsFrom>; backend: Backend } {
  const chosen = 'jev'
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

// ---- eval v2 (#45): the files under datasets/eval-v2/ and the dataset made from them ----

/** The folder the eval v2 authors write in (FORMAT.md), and what the generator writes: the dataset (not committed) and its record (committed). */
export const EVAL_V2_DIR = join(DATASETS_DIR, 'eval-v2')
export const EVAL_V2_JSONL = join(DATASETS_DIR, 'eval-v2.jsonl')
export const EVAL_V2_GENERATED = join(EVAL_V2_DIR, 'generated.json')
/** The seed when generated.json does not name one. */
export const EVAL_V2_SEED = 'eval-v2'
/** The final gold the eval scores against (FORMAT.md): one file an item, the agreed answers or the person's ruling. */
export const EVAL_V2_GOLD = join(EVAL_V2_DIR, 'gold')
/** Where eval/eval-v2-flow.ts writes its flow files, one per backend and state budget. */
export const EVAL_V2_FLOW_DIR = join(RESULTS_DIR, 'eval-v2-flow')

/** The four folders of eval v2 and what each holds. */
export const V2_FOLDERS = ['pool', 'items', 'gold-author', 'gold-labeler'] as const
export type V2Folder = (typeof V2_FOLDERS)[number]

/** One eval v2 file, checked: where it is (shown relative to eval-v2/), what kind, its errors and warnings, and a line about it. */
export type V2Report = { path: string; folder: V2Folder; errors: string[]; warnings: string[]; about: string }

/** A JSON file's value, or why it is not JSON (with the position Node gives). */
function readJson(path: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** A path as eval v2's scripts print it: relative to eval-v2/ when inside it, else as `shown` prints it. */
export function shownV2(path: string): string {
  const inside = relative(EVAL_V2_DIR, path)
  return inside.startsWith('..') ? shown(path) : inside
}

/** Which folder a file is in by its parent's name, or by its fields when it is elsewhere; null when neither tells. */
export function v2FolderOf(path: string, value: unknown): V2Folder | null {
  const parent = basename(resolve(path, '..'))
  if ((V2_FOLDERS as readonly string[]).includes(parent)) return parent as V2Folder
  if (typeof value !== 'object' || value === null) return null
  if ('relation' in value && 'assistant' in value) return 'pool'
  if ('category' in value && 'decisive' in value) return 'items'
  if ('triage_final' in value) return 'gold-author'
  return null
}

/**
 * Checks one eval v2 file as its folder says (a gold file against the item of the same id in the items folder beside its
 * own, when there is one). The values of the files that pass come back with the report.
 */
export function checkV2File(path: string): V2Report & { segment?: Segment; item?: V2Item } {
  const name = basename(path, '.json')
  const read = readJson(path)
  const folder = v2FolderOf(path, read.value) ?? 'pool'
  const shownPath = shownV2(path)
  if (read.error !== undefined) return { path: shownPath, folder, errors: [`not JSON: ${read.error}`], warnings: [], about: '' }
  if (folder === 'pool') {
    const checked = checkSegment(read.value, name)
    const segment = read.value as Segment
    // A size means the segment's user and assistant.text are strings.
    const placeholders = checked.tokens === null ? '' : [...new Set(`${segment.user} ${segment.assistant.text}`.match(/\{\{[A-Z][A-Z0-9_]*\}\}/g) ?? [])].join(' ')
    const about = checked.tokens === null ? '' : `${segment.relation}, ${checked.tokens} tokens${placeholders === '' ? '' : ` (sample values in ${placeholders})`}`
    return { path: shownPath, folder, errors: checked.errors, warnings: checked.warnings, about, ...(checked.errors.length === 0 ? { segment } : {}) }
  }
  if (folder === 'items') {
    const checked = checkItem(read.value, name)
    const item = read.value as V2Item
    const ids = checked.sizes === null ? '' : item.decisive.flatMap((entry) => (entry.msg === undefined ? [] : [entry.msg])).join(' ')
    const about = checked.sizes === null ? '' : `${item.bin} ${item.relation}; opening ${checked.sizes.opening}, decisive ${checked.sizes.decisive} (${ids}), final ${checked.sizes.final} tokens`
    return { path: shownPath, folder, errors: checked.errors, warnings: checked.warnings, about, ...(checked.errors.length === 0 ? { item } : {}) }
  }
  const itemPath = join(resolve(path, '..', '..'), 'items', `${name}.json`)
  const itemRead = existsSync(itemPath) ? readJson(itemPath) : {}
  const item = itemRead.value !== undefined && checkItem(itemRead.value, name).errors.length === 0 ? (itemRead.value as V2Item) : null
  const checked = checkGold(read.value, name, item)
  const gold = read.value as { effort?: string; accept?: string[]; effort_without_decisive?: string; triage_final?: string }
  const about = checked.errors.length > 0 ? '' : `effort ${gold.effort} [${gold.accept?.join(', ')}], without the decisive rounds ${gold.effort_without_decisive}; final ${gold.triage_final}`
  if (existsSync(itemPath) && item === null) checked.warnings.push(`items/${name}.json has errors: its decisive messages are not checked`)
  return { path: shownPath, folder, errors: checked.errors, warnings: checked.warnings.filter((w) => !(existsSync(itemPath) && w.startsWith('no items/'))), about }
}

/** Every eval v2 file, checked, with the segments and items that pass and the ids of the gold files on each side. */
export function readEvalV2(dir = EVAL_V2_DIR): { reports: V2Report[]; segments: Segment[]; items: V2Item[]; authorGold: string[]; labelerGold: string[]; strays: string[] } {
  const reports: V2Report[] = []
  const segments: Segment[] = []
  const items: V2Item[] = []
  const gold: Record<'gold-author' | 'gold-labeler', string[]> = { 'gold-author': [], 'gold-labeler': [] }
  const strays: string[] = []
  for (const folder of V2_FOLDERS) {
    const path = join(dir, folder)
    if (!existsSync(path)) continue
    for (const file of readdirSync(path).sort()) {
      if (!file.endsWith('.json')) {
        if (!file.startsWith('.')) strays.push(`${folder}/${file}`)
        continue
      }
      const report = checkV2File(join(path, file))
      reports.push({ path: report.path, folder: report.folder, errors: report.errors, warnings: report.warnings, about: report.about })
      if (report.segment !== undefined) segments.push(report.segment)
      if (report.item !== undefined) items.push(report.item)
      if ((folder === 'gold-author' || folder === 'gold-labeler') && report.errors.length === 0) gold[folder].push(basename(file, '.json'))
    }
  }
  return { reports, segments, items, authorGold: gold['gold-author'], labelerGold: gold['gold-labeler'], strays }
}

/** The seed generated.json names, or the default when there is no record yet. */
export function evalV2Seed(): string {
  if (!existsSync(EVAL_V2_GENERATED)) return EVAL_V2_SEED
  const seed = (readJson(EVAL_V2_GENERATED).value as { seed?: unknown } | undefined)?.seed
  return typeof seed === 'string' && seed !== '' ? seed : EVAL_V2_SEED
}

/** The dataset the pool and the items make with `seed`: the build, the JSONL's text, its sha256 and size, and generated.json's text. */
export function generateEvalV2(segments: readonly Segment[], items: readonly V2Item[], seed: string): { built: Built; jsonl: string; sha256: string; bytes: number; generated: string } {
  const built = buildEvalV2({ segments, items, seed })
  const jsonl = evalV2Jsonl(built.records)
  const sha256 = createHash('sha256').update(jsonl).digest('hex')
  const bytes = Buffer.byteLength(jsonl, 'utf8')
  return { built, jsonl, sha256, bytes, generated: generatedFile({ seed, records: built.records, uses: built.uses, sha256, bytes }) }
}

/**
 * eval/validate.ts's check of eval v2: every file's errors (failures) and warnings, the plan's shares (warnings), and the
 * dataset. With generated.json committed, the dataset is built again with its seed and must be what it records (and the
 * local eval-v2.jsonl, when there is one, what the build makes); without it, a pool that cannot yet fill the items is a warning.
 */
export function validateEvalV2(): { lines: string[]; failed: boolean } {
  const read = readEvalV2()
  const lines: string[] = []
  let failed = false
  const bad = read.reports.filter((report) => report.errors.length > 0)
  lines.push(`eval-v2: ${read.segments.length} segments, ${read.items.length} items, gold ${read.authorGold.length} author / ${read.labelerGold.length} labeler: ${bad.length === 0 ? 'ok' : `${bad.length} files with errors`}`)
  for (const report of bad) for (const error of report.errors) lines.push(`  ${report.path}: ${error}`)
  for (const report of read.reports) for (const warning of report.warnings) lines.push(`  warning: ${report.path}: ${warning}`)
  for (const stray of read.strays) lines.push(`  warning: ${stray} is not a .json file: ignored`)
  if (bad.length > 0) failed = true
  if (read.reports.length === 0) lines.push('  warning: nothing written yet under eval-v2/ (pool/, items/, gold-author/, gold-labeler/): see eval-v2/FORMAT.md')
  else for (const warning of datasetWarnings(read)) lines.push(`  warning: ${warning}`)

  const recorded = existsSync(EVAL_V2_GENERATED)
  if (!recorded) {
    if (read.items.length > 0) {
      const made = generateEvalV2(read.segments, read.items, EVAL_V2_SEED)
      for (const error of made.built.errors) lines.push(`  warning: not buildable yet: ${error}`)
    }
    lines.push(`${shown(EVAL_V2_JSONL)}: not generated yet (node dispatch-pilot/eval/eval-v2-gen.ts writes it and eval-v2/generated.json)`)
    return { lines, failed }
  }
  if (bad.length > 0) {
    lines.push(`${shown(EVAL_V2_JSONL)}: not rebuilt: files under eval-v2/ have errors`)
    return { lines, failed: true }
  }
  const seed = evalV2Seed()
  const made = generateEvalV2(read.segments, read.items, seed)
  const problems = [...made.built.errors]
  if (made.built.errors.length === 0 && readFileSync(EVAL_V2_GENERATED, 'utf8') !== made.generated) problems.push(`${shownV2(EVAL_V2_GENERATED)} is not what pool/ and items/ make now: run node dispatch-pilot/eval/eval-v2-gen.ts and commit it`)
  if (problems.length === 0 && existsSync(EVAL_V2_JSONL) && readFileSync(EVAL_V2_JSONL, 'utf8') !== made.jsonl) problems.push(`${shown(EVAL_V2_JSONL)} (local, not committed) is not what generated.json records: run node dispatch-pilot/eval/eval-v2-gen.ts`)
  lines.push(`${shown(EVAL_V2_JSONL)}: rebuilt with seed ${JSON.stringify(seed)}, ${made.built.records.length} items, sha256 ${made.sha256.slice(0, 12)}…: ${problems.length === 0 ? 'matches generated.json' : `${problems.length} problems`}`)
  for (const problem of problems) lines.push(`  ${problem}`)
  // The final gold the eval scores against: every file well formed, its decisive answers those of its item.
  const present = read.items.filter((item) => existsSync(join(EVAL_V2_GOLD, `${item.id}.json`)))
  const missing = read.items.filter((item) => !present.includes(item)).map((item) => item.id)
  const goldErrors = present.flatMap((item) => readFinalGold(item.id, item.decisive.flatMap((entry) => (entry.msg === undefined ? [] : [entry.msg]))).errors)
  lines.push(`eval-v2/gold: ${present.length} of ${read.items.length} items have a final gold: ${goldErrors.length === 0 ? 'ok' : `${goldErrors.length} errors`}`)
  for (const error of goldErrors) lines.push(`  ${error}`)
  if (missing.length > 0) lines.push(`  warning: no final gold yet for ${missing.join(', ')}`)
  return { lines, failed: failed || problems.length > 0 || goldErrors.length > 0 }
}

/** An item's final gold file (`gold/<id>.json`), checked against the decisive messages `asked` (FORMAT.md 「金标」). */
export function readFinalGold(id: string, asked: readonly string[] | null): { gold: FinalGold | null; errors: string[]; text: string } {
  const path = join(EVAL_V2_GOLD, `${id}.json`)
  if (!existsSync(path)) return { gold: null, errors: [`gold/${id}.json: missing`], text: '' }
  const text = readFileSync(path, 'utf8')
  const read = readJson(path)
  if (read.error !== undefined) return { gold: null, errors: [`gold/${id}.json: not JSON: ${read.error}`], text }
  const checked = checkFinalGold(read.value, id, asked)
  return { gold: checked.errors.length === 0 ? (read.value as FinalGold) : null, errors: checked.errors.map((error) => `gold/${id}.json: ${error}`), text }
}

/**
 * The eval-v2 dataset a run asks: eval-v2.jsonl, each record with its final gold. The JSONL must be what generated.json
 * records (its sha256); when there is none it is built now from pool/ and items/ with generated.json's seed and written
 * (what eval-v2-gen.ts does), so a run never asks a dataset other than the committed one. `notes` say what was done.
 */
export function readEvalV2Dataset(): { text: string; sha256: string; items: V2EvalItem[]; errors: string[]; notes: string[]; gold: { files: number; sha256: string } } {
  const none = { text: '', sha256: '', items: [], notes: [], gold: { files: 0, sha256: '' } }
  if (!existsSync(EVAL_V2_GENERATED)) return { ...none, errors: [`no ${shownV2(EVAL_V2_GENERATED)}: the dataset is not generated yet`] }
  const recorded = (readJson(EVAL_V2_GENERATED).value as { jsonl?: { sha256?: string } } | undefined)?.jsonl?.sha256
  const notes: string[] = []
  let text: string
  if (existsSync(EVAL_V2_JSONL)) text = readFileSync(EVAL_V2_JSONL, 'utf8')
  else {
    const read = readEvalV2()
    const bad = read.reports.filter((report) => report.errors.length > 0)
    if (bad.length > 0) return { ...none, errors: bad.flatMap((report) => report.errors.map((error) => `${report.path}: ${error}`)) }
    const made = generateEvalV2(read.segments, read.items, evalV2Seed())
    if (made.built.errors.length > 0) return { ...none, errors: made.built.errors }
    if (made.sha256 !== recorded) return { ...none, errors: [`pool/ and items/ do not make what ${shownV2(EVAL_V2_GENERATED)} records: run node dispatch-pilot/eval/eval-v2-gen.ts and commit it`] }
    writeFileSync(EVAL_V2_JSONL, made.jsonl)
    notes.push(`${shown(EVAL_V2_JSONL)} was not there: built it from pool/ and items/ (seed ${JSON.stringify(evalV2Seed())}), as eval-v2-gen.ts does`)
    text = made.jsonl
  }
  const sha256 = createHash('sha256').update(text).digest('hex')
  if (sha256 !== recorded) return { ...none, errors: [`${shown(EVAL_V2_JSONL)} is not what ${shownV2(EVAL_V2_GENERATED)} records: run node dispatch-pilot/eval/eval-v2-gen.ts`] }
  const { items: records, errors } = parseJsonl(text)
  const golds = (records as unknown as V2Record[]).map((record) => ({ record, ...readFinalGold(record.id, record.decisive.map((entry) => entry.msg)) }))
  errors.push(...golds.flatMap((gold) => gold.errors))
  const items = golds.flatMap(({ record, gold }) => (gold === null ? [] : [v2Item(record, gold)]))
  const goldSha = createHash('sha256').update(golds.map((gold) => gold.text).join('\n')).digest('hex')
  return { text, sha256, items, errors, notes, gold: { files: golds.filter((gold) => gold.gold !== null).length, sha256: goldSha } }
}
