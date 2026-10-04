// Runs an eval suite against a real decision backend and saves the results.
//
//   node dispatch-pilot/eval/run.ts effort-submit --estimate            what a run would send and cost; nothing is sent
//   node dispatch-pilot/eval/run.ts effort-submit --label preliminary   every variant, both languages, against Jev
//
// Options: --backend jev|clef (jev), --model <id> (Jev's: jev-latest by default; Clef asks clef only),
// --variants en-score,zh-score (all), --languages zh,en (both), --ids a,b or
// --limit N (all items), --concurrency 1 (Jev answers one key's requests one
// after another: on 2026-10-04 the p50 was 271 ms at 1 in flight, 543 ms at
// 2 and 684-1134 ms at 4, so latency is only the mod's at 1; more is faster
// for accuracy alone), --timeout 10000 (ms per attempt),
// --retries 2, --option contextTokens=4000 (one of the mod's options, as
// /config sets it; the manifest's defaults otherwise), --max-usd 1 (refuse a
// run estimated to cost more), --label <word>, --no-save.
//
// Credentials: TYPESAFE_API_KEY for Jev; CLOUDFLARE_ACCOUNT_ID and
// CLOUDFLARE_AUTH_TOKEN for Clef: the environment first, then
// ~/.config/dispatch-pilot/eval.env. Never printed or saved.
//
// Saves eval/results/<suite>/<date>-<backend>[-<label>].json: the settings,
// the backend and the model that answered, hashes of the dataset and of the
// decision module, the questions each variant asked, the summary, and every
// answer (one line per item and language).

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { PluginOptions } from 'claude-code'
import type { Backend } from '../hooks/decision/backend.ts'
import { CLEF_MODEL, clefBackend } from '../hooks/decision/clef.ts'
import { estimateTokens } from '../hooks/decision/context.ts'
import { JEV_MODEL, jevBackend } from '../hooks/decision/jev.ts'
import type { DecisionRequest } from '../hooks/decision/system-one.ts'
import { LANGUAGES, validateDataset, type Language } from './lib/datasets.ts'
import { summarize, type Summary } from './lib/metrics.ts'
import { runSuite, type Row } from './lib/runner.ts'
import { settingsFrom } from './lib/suite.ts'
import { SUITES } from './lib/suites.ts'
import { CREDENTIALS_FILE, MOD_DIR, RESULTS_DIR, REVIEW_DIR, credential, datasetFile, nodeIo, readDataset, shown } from './node.ts'

/** Input price per million tokens; output is free on both (docs.typesafe.ai/models, the Clef model page; 2026-10-04). */
const PRICES: Readonly<Record<string, number>> = { jev: 0.042, clef: 0.24, 'clef-flash': 0.09 }

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    backend: { type: 'string', default: 'jev' },
    model: { type: 'string' },
    variants: { type: 'string' },
    languages: { type: 'string', default: LANGUAGES.join(',') },
    ids: { type: 'string' },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '1' },
    timeout: { type: 'string', default: '10000' },
    retries: { type: 'string', default: '2' },
    option: { type: 'string', multiple: true, default: [] },
    estimate: { type: 'boolean', default: false },
    'max-usd': { type: 'string', default: '1' },
    label: { type: 'string' },
    'no-save': { type: 'boolean', default: false },
  },
})

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

const name = positionals[0] ?? fail('usage: node dispatch-pilot/eval/run.ts <suite> [--estimate] [--backend jev|clef] [--label <word>] ...')
const suite = SUITES[name] ?? fail(`no suite for "${name}" yet (suites: ${Object.keys(SUITES).join(', ')})`)
const { kind, path } = datasetFile(name)
const dataset = readDataset(path)
const checked = validateDataset(kind, dataset.items)
if (dataset.errors.length + checked.errors.length > 0) fail(`${shown(path)} is not valid; run eval/validate.ts ${name}`)

const variants = values.variants?.split(',') ?? suite.variants
for (const variant of variants) if (!suite.variants.includes(variant)) fail(`no variant "${variant}" (${suite.variants.join(', ')})`)
const languages = values.languages.split(',') as Language[]
for (const language of languages) if (!LANGUAGES.includes(language)) fail(`no language "${language}" (zh, en)`)
let items = dataset.items as { id: string; tags: string[] }[]
if (values.ids !== undefined) {
  const ids = values.ids.split(',')
  items = items.filter((item) => ids.includes(item.id))
}
if (values.limit !== undefined) items = items.slice(0, Number(values.limit))

// The mod's settings as the engine hands them over: the manifest's defaults, then --option.
const manifest = JSON.parse(readFileSync(join(MOD_DIR, '.claude-plugin', 'plugin.json'), 'utf8')) as { userConfig?: Record<string, { default?: unknown; sensitive?: boolean }> }
const options: Record<string, unknown> = Object.fromEntries(Object.entries(manifest.userConfig ?? {}).map(([key, spec]) => [key, spec.default]))
for (const assignment of values.option) {
  const [key, value] = assignment.split(/=(.*)/s, 2)
  if (!key || value === undefined) fail(`--option takes name=value, not ${assignment}`)
  options[key] = value !== '' && Number.isFinite(Number(value)) ? Number(value) : value
}
// The decision model is the backend under evaluation (--backend), whatever the manifest's default says.
options.decisionModel = values.backend
const settings = settingsFrom(options as PluginOptions)

const backendName = values.backend
if (backendName === 'clef' && values.model !== undefined && values.model !== CLEF_MODEL) fail(`the Clef backend asks ${CLEF_MODEL} only`)
const model = backendName === 'clef' ? CLEF_MODEL : (values.model ?? JEV_MODEL)
const price = PRICES[backendName === 'jev' ? 'jev' : model] ?? fail(`no price known for ${backendName} ${model}`)

// The estimate: the requests a run sends first (a suite that asks a second
// time, after reading the first answer, sends more), at the mod's token
// estimate times what Jev actually counted: 6468 tokens for 8 effort-submit
// requests estimated at 4127 (2026-10-04), so 1.6.
const ESTIMATE_FACTOR = 1.6
const planned: DecisionRequest[] = []
for (const item of items) {
  for (const variant of variants) {
    for (const language of languages) {
      await suite.decide(item, language, variant, async (request) => {
        planned.push(request)
        return { request, asked: { ok: false, failure: { kind: 'config', detail: 'estimate only' } }, ms: 0, attempts: 0 }
      }, settings)
    }
  }
}
const estimatedTokens = Math.round(ESTIMATE_FACTOR * planned.reduce((sum, request) => sum + estimateTokens(JSON.stringify({ model, ...request })), 0))
const estimatedUsd = (estimatedTokens * price) / 1e6
console.log(`${name}: ${items.length} items x ${variants.length} variants x ${languages.length} languages = ${planned.length} requests, about ${estimatedTokens} input tokens, about $${estimatedUsd.toFixed(4)} on ${backendName} (${model})`)
if (values.estimate) process.exit(0)
const maxUsd = Number(values['max-usd'])
if (estimatedUsd > maxUsd) fail(`the estimate is over --max-usd ${maxUsd}: nothing sent`)

const secrets: string[] = []
async function makeBackend(): Promise<Backend> {
  if (backendName === 'jev') {
    const key = credential('TYPESAFE_API_KEY') ?? fail(`no TYPESAFE_API_KEY in the environment or ${CREDENTIALS_FILE}`)
    secrets.push(key)
    return jevBackend(key, { model })
  }
  if (backendName === 'clef') {
    const accountId = credential('CLOUDFLARE_ACCOUNT_ID') ?? fail(`no CLOUDFLARE_ACCOUNT_ID in the environment or ${CREDENTIALS_FILE}`)
    const apiToken = credential('CLOUDFLARE_AUTH_TOKEN') ?? fail(`no CLOUDFLARE_AUTH_TOKEN in the environment or ${CREDENTIALS_FILE}`)
    secrets.push(accountId, apiToken)
    return clefBackend({ accountId, apiToken })
  }
  return fail(`no backend "${backendName}" (jev, clef)`)
}
const backend = await makeBackend()

const started = new Date()
const rows: Row<unknown>[] = await runSuite(suite, items, {
  backend,
  io: nodeIo,
  now: () => performance.now(),
  pause: (ms) => new Promise((done) => setTimeout(done, ms)),
  settings,
  variants,
  languages,
  timeoutMs: Number(values.timeout),
  retries: Number(values.retries),
  concurrency: Number(values.concurrency),
  onRow: (_row, done, total) => {
    if (done % 50 === 0 || done === total) process.stderr.write(`  ${done}/${total}\n`)
  },
})
for (const row of rows) row.ms = row.ms === null ? null : Math.round(row.ms)

const summary = summarize(suite, items, rows, { slowMs: settings.timeoutMs, settings })
const answeredBy = [...new Set(rows.flatMap((row) => (row.model === null ? [] : [row.model])))]
const inputTokens = rows.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0)
const usd = (inputTokens * price) / 1e6
report(summary)
console.log(`requests ${rows.length} (attempts ${rows.reduce((sum, row) => sum + row.attempts, 0)}), input tokens ${inputTokens}, about $${usd.toFixed(4)}; answered by ${answeredBy.join(', ') || 'none'}`)

if (!values['no-save']) {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  const decisionDir = join(MOD_DIR, 'hooks', 'decision')
  const reviewPath = join(REVIEW_DIR, `${kind}.review.jsonl`)
  const decided = existsSync(reviewPath) ? new Set(readFileSync(reviewPath, 'utf8').split('\n').flatMap((line) => (line.trim() ? [JSON.parse(line).id] : []))).size : 0
  const result = {
    suite: suite.name,
    label: values.label ?? null,
    date: started.toISOString(),
    backend: { name: backend.name, model, answeredBy },
    dataset: { path: shown(path), items: dataset.items.length, sha256: sha(dataset.text), review: { file: existsSync(reviewPath) ? shown(reviewPath) : null, decided } },
    code: Object.fromEntries(readdirSync(decisionDir).sort().map((file) => [`hooks/decision/${file}`, sha(readFileSync(join(decisionDir, file), 'utf8')).slice(0, 16)])),
    settings: {
      context: settings.context,
      thetaMax: settings.thetaMax,
      timeoutMs: settings.timeoutMs,
      // Every option as the run read it (a feature's own, such as agentOverride), less the sensitive ones.
      options: Object.fromEntries(Object.entries(options).filter(([key]) => manifest.userConfig?.[key]?.sensitive !== true)),
    },
    run: { items: items.length, variants, languages, timeoutMs: Number(values.timeout), retries: Number(values.retries), concurrency: Number(values.concurrency), requests: rows.length, attempts: rows.reduce((sum, row) => sum + row.attempts, 0), inputTokens, usd: Number(usd.toFixed(4)) },
    questions: Object.fromEntries(variants.map((variant) => [variant, suite.questions(variant)])),
    ...(suite.scoring === undefined ? {} : { scoring: suite.scoring }),
    summary,
    answers: answersByItem(rows),
  }
  const text = format(result)
  if (secrets.some((secret) => secret !== '' && text.includes(secret))) fail('the results would hold a credential: not saved')
  const dir = join(RESULTS_DIR, suite.name)
  mkdirSync(dir, { recursive: true })
  const stem = `${started.toISOString().slice(0, 10)}-${backend.name}${values.label ? `-${values.label.replace(/[^A-Za-z0-9-]+/g, '-')}` : ''}`
  let file = join(dir, `${stem}.json`)
  for (let n = 2; existsSync(file); n++) file = join(dir, `${stem}-${n}.json`)
  writeFileSync(file, text)
  console.log(`saved ${shown(file)}`)
}

/** One line per item and language: the state the model read once, then each variant's answer. */
function answersByItem(rows: readonly Row<unknown>[]): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const key = `${row.id} ${row.language}`
    const group = groups.get(key) ?? { id: row.id, language: row.language, state: row.state }
    group[row.variant] = Object.fromEntries(
      Object.entries({ answer: row.shown, correct: row.correct, gold: row.exact, miss: row.miss, parts: row.parts ?? null, ...row.detail, ms: row.ms, attempts: row.attempts, tokens: row.inputTokens, model: row.model, failure: row.failure }).filter(
        ([, value]) => value !== null,
      ),
    )
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** Pretty JSON, with each answer line on one line. */
function format(result: Record<string, unknown> & { answers: readonly unknown[] }): string {
  const { answers, ...head } = result
  const top = JSON.stringify(head, null, 2)
  return `${top.slice(0, -2)},\n  "answers": [\n${answers.map((answer) => `    ${JSON.stringify(answer)}`).join(',\n')}\n  ]\n}\n`
}

function report(summary: Summary): void {
  const pct = (rate: number | null) => (rate === null ? '-' : `${(rate * 100).toFixed(1)}%`)
  const pad = (cells: readonly string[]) => cells.map((cell, i) => (i === 0 ? cell.padEnd(10) : cell.padStart(8))).join(' ')
  console.log(pad(['variant', 'zh acc', 'en acc', 'gap', 'pass', 'agree', 'zh gold', 'en gold', 'p50 ms', 'p90 ms', `>${settings.timeoutMs}ms`, 'failed']))
  for (const v of summary.variants) {
    console.log(
      pad([
        v.variant,
        pct(v.zh.accuracy),
        pct(v.en.accuracy),
        `${(v.gap * 100).toFixed(1)}`,
        v.pass ? 'yes' : 'no',
        pct(v.agreement.rate),
        pct(v.zh.exact),
        pct(v.en.exact),
        String(v.latency.p50 ?? '-'),
        String(v.latency.p90 ?? '-'),
        String(v.latency.slow),
        String(v.zh.failed + v.en.failed),
      ]),
    )
  }
  for (const v of summary.variants) {
    const parts = Object.keys(v.zh.parts ?? {})
    if (parts.length > 0) console.log(`${v.variant}: right by part (zh/en): ${parts.map((part) => `${part} ${pct(v.zh.parts?.[part] ?? 0)}/${pct(v.en.parts?.[part] ?? 0)}`).join(', ')}; whole answer ${pct(v.zh.accuracy)}/${pct(v.en.accuracy)}`)
  }
  for (const v of summary.variants) {
    const misses = (language: 'zh' | 'en') => Object.entries(v[language].misses).map(([way, n]) => `${way} ${n}`).join(', ') || 'none'
    const missed = v.tags.filter((t) => t.wrong.zh + t.wrong.en > 0).slice(0, 6)
    const tags = missed.map((t) => `${t.tag} ${t.wrong.zh}/${t.wrong.en} of ${t.items}`).join(', ') || 'none'
    console.log(`${v.variant}: misses zh ${misses('zh')}; en ${misses('en')}. most missed tags (zh/en wrong of n): ${tags}`)
    for (const line of suite.report?.(v) ?? []) console.log(line)
  }
  const best = Math.max(...summary.constants.map((c) => c.accuracy))
  console.log(`constant answers: ${summary.constants.map((c) => `${c.answer} ${pct(c.accuracy)}${c.accuracy === best ? ' (best)' : ''} (gold ${pct(c.exact)})`).join(', ')}`)
  // For a suite that grades parts: the best constant for each part alone.
  for (const part of Object.keys(summary.constants[0]?.parts ?? {})) {
    const top = summary.constants.reduce((a, b) => ((b.parts?.[part] ?? 0) > (a.parts?.[part] ?? 0) ? b : a))
    console.log(`best constant for the ${part} alone: ${top.answer} ${pct(top.parts?.[part] ?? 0)}`)
  }
}
