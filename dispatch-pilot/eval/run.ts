// Runs an eval suite against a real decision backend and saves the results.
//
//   node dispatch-pilot/eval/run.ts effort-submit --estimate            what a run would send and cost; nothing is sent
//   node dispatch-pilot/eval/run.ts effort-submit --label preliminary   every variant, both languages, against Jev
//
// Options: --backend jev|clef|pplx (jev), --model <id> (Jev's: jev-latest by default; Clef asks clef only;
// Perplexity's: pplx-decider-v1.1-27b by default, or pplx-decider-v1-27b; a run on it reads the mod's settings as
// Jev's, so the requests, the state budgets and the timeout are the same as Jev's),
// --variants en-score,zh-score (all), --languages zh,en (both), --ids a,b or
// --limit N (all items), --concurrency 1 (Jev answers one key's requests one
// after another: on 2026-10-04 the p50 was 271 ms at 1 in flight, 543 ms at
// 2 and 684-1134 ms at 4, so latency is only the mod's at 1; more is faster
// for accuracy alone), --timeout <ms> (per attempt: by default four times the
// mod's timeoutMs for the backend, at least 10000, so a slow answer is still
// measured; the summary counts the answers later than the mod would wait),
// --retries 2, --option contextTokens=4000 (one of the mod's options, as
// /config sets it, read by the type the manifest gives it: a number, true or
// false, or text; the manifest's defaults otherwise, and for the options whose
// default depends on the decision model, the backend's: core/setup.ts
// BACKEND_DEFAULTS), --max-usd 1 (refuse a run estimated to cost more),
// --label <word>, --no-save, --state-tokens N (the state's budget for every kind of request, past what --option
// contextTokens can reach, which only lowers it), --state-messages N (how many recent messages the state may hold:
// the mod's contextMessages is at most 32, so a large --state-tokens alone is still cut to the newest 32 messages).
//
// eval-v2 (#45): the dataset is eval-v2.jsonl (built first when it is not there, and checked against
// eval-v2/generated.json), each item scored against eval-v2/gold/; the conversations are Chinese only, so the run asks
// --languages zh unless told otherwise; the variants are zh-score, en-score (the question's language) and zh-flow,
// en-flow, which carry the count and the summary the flow file given with --flow <file> holds at the last message
// (eval/eval-v2-flow.ts writes one per backend and budget):
//
//   node dispatch-pilot/eval/run.ts eval-v2 --backend pplx --state-tokens 135000 --state-messages 2000 --timeout 240000 --variants zh-score,en-score --label A
//   node dispatch-pilot/eval/run.ts eval-v2 --backend jev --variants zh-flow,en-flow --flow dispatch-pilot/eval/results/eval-v2-flow/jev-24000.json --label J
//
// Credentials: TYPESAFE_API_KEY for Jev; CLOUDFLARE_ACCOUNT_ID and
// CLOUDFLARE_AUTH_TOKEN for Clef; PERPLEXITY_API_KEY for Perplexity: the environment first, then
// ~/.config/dispatch-pilot/eval.env. Never printed or saved.
//
// Saves eval/results/<suite>/<date>-<backend>[-<label>].json: the settings,
// the backend and the model that answered, hashes of the dataset and of the
// code the requests and grades come from (the mod's hooks, the eval's
// suites), the questions each variant asked, the summary, and every answer
// (one line per item and language).

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { PluginOptions } from 'claude-code'
import type { Backend } from '../hooks/decision/backend.ts'
import { CLEF_MODEL } from '../hooks/decision/clef.ts'
import { estimateTokens } from '../hooks/decision/context.ts'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import { PPLX_MODEL } from '../hooks/decision/pplx.ts'
import type { DecisionRequest } from '../hooks/decision/system-one.ts'
import { LANGUAGES, validateDataset, type Language } from './lib/datasets.ts'
import type { FlowFile } from './lib/eval-v2-flow.ts'
import { summarize, type Summary } from './lib/metrics.ts'
import { attemptMs as defaultAttemptMs, runSuite, stateDigest, type Row } from './lib/runner.ts'
import { optionsFor, settingsFrom, settingsModel, withStateMessages, withStateTokens, type EvalBackend } from './lib/suite.ts'
import { READS_FLOW, SUITES } from './lib/suites.ts'
import { EVAL_V2_JSONL, PRICES, RESULTS_DIR, REVIEW_DIR, backendFor, catalogFor, datasetFile, formatResult, modCode, nodeHost, nodeIo, readDataset, readEvalV2Dataset, readManifest, shown } from './node.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    backend: { type: 'string', default: 'jev' },
    model: { type: 'string' },
    variants: { type: 'string' },
    languages: { type: 'string' },
    flow: { type: 'string' },
    ids: { type: 'string' },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '1' },
    timeout: { type: 'string' },
    retries: { type: 'string', default: '2' },
    option: { type: 'string', multiple: true, default: [] },
    estimate: { type: 'boolean', default: false },
    'max-usd': { type: 'string', default: '1' },
    'state-tokens': { type: 'string' },
    'state-messages': { type: 'string' },
    label: { type: 'string' },
    'no-save': { type: 'boolean', default: false },
  },
})

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

const name = positionals[0] ?? fail('usage: node dispatch-pilot/eval/run.ts <suite> [--estimate] [--backend jev|clef|pplx] [--label <word>] ...')
const entry = SUITES[name] ?? fail(`no suite for "${name}" yet (suites: ${Object.keys(SUITES).join(', ')})`)
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
/** The dataset: a kind's JSONL, checked against its format; or eval-v2.jsonl, checked against generated.json, with its final gold. */
const { kind, path, dataset, gold } = ((): { kind: string; path: string; dataset: { text: string; items: Record<string, unknown>[] }; gold: { files: number; sha256: string } | null } => {
  if (name === 'eval-v2') {
    const read = readEvalV2Dataset()
    for (const note of read.notes) console.log(note)
    if (read.errors.length > 0) fail(`eval-v2 cannot be run:\n  ${read.errors.slice(0, 20).join('\n  ')}`)
    return { kind: name, path: EVAL_V2_JSONL, dataset: { text: read.text, items: read.items as unknown as Record<string, unknown>[] }, gold: read.gold }
  }
  const { kind, path } = datasetFile(name)
  const read = readDataset(path)
  const checked = validateDataset(kind, read.items, { catalog: catalogFor(kind, path) })
  if (read.errors.length + checked.errors.length > 0) fail(`${shown(path)} is not valid; run eval/validate.ts ${name}`)
  return { kind, path, dataset: read, gold: null }
})()
// --flow <file>: what eval/eval-v2-flow.ts wrote for one backend and budget, which the flow variants carry.
let flow: { path: string; sha256: string; file: FlowFile } | null = null
if (values.flow !== undefined) {
  if (!READS_FLOW.includes(name)) fail(`--flow is for the suites that read a flow file (${READS_FLOW.join(', ')}), not ${name}`)
  const text = existsSync(values.flow) ? readFileSync(values.flow, 'utf8') : fail(`no flow file ${values.flow}`)
  const file = JSON.parse(text) as FlowFile
  if (file.suite !== 'eval-v2-flow') fail(`${values.flow} is not a flow file (eval/eval-v2-flow.ts writes them)`)
  flow = { path: values.flow, sha256: sha(text), file }
}
// A suite built when the run starts gets what lies beside its dataset (the skill suite; the results hash those files
// too) and every item of the dataset (the `subagent` suite asks about a Workflow's agents together).
const beside: Record<string, string> = {}
const suite = typeof entry === 'function' ? await entry(nodeHost(path, (file, text) => (beside[file] = sha(text))), dataset.items, { ...(flow === null ? {} : { flow: flow.file }) }) : entry
for (const warning of suite.about?.warnings ?? []) console.log(`warning: ${warning}`)

const variants = values.variants?.split(',') ?? suite.variants.filter((variant) => flow !== null || !READS_FLOW.includes(name) || !variant.endsWith('-flow'))
for (const variant of variants) if (!suite.variants.includes(variant)) fail(`no variant "${variant}" (${suite.variants.join(', ')})`)
// A flow variant carries a flow file's count and summary: without one it would ask nothing.
const flowless = READS_FLOW.includes(name) && flow === null ? variants.filter((variant) => variant.endsWith('-flow')) : []
if (flowless.length > 0) fail(`${flowless.join(', ')} carry a flow file's count and summary: give one with --flow <file> (eval/eval-v2-flow.ts writes them)`)
const languages = (values.languages?.split(',') ?? suite.languages ?? LANGUAGES) as Language[]
for (const language of languages) if (!LANGUAGES.includes(language)) fail(`no language "${language}" (zh, en)`)
let items = dataset.items as { id: string; tags: string[] }[]
if (values.ids !== undefined) {
  const ids = values.ids.split(',')
  items = items.filter((item) => ids.includes(item.id))
}
if (values.limit !== undefined) items = items.slice(0, Number(values.limit))

// The mod's settings as the engine hands them over: the manifest's defaults, then --option; what the manifest leaves
// unset, the backend's defaults (readConfig).
const manifest = readManifest()
const backendName = values.backend as EvalBackend
if (backendName !== 'jev' && backendName !== 'clef' && backendName !== 'pplx') fail(`no backend "${backendName}" (jev, clef, pplx)`)
let options: Record<string, unknown>
try {
  // The decision model is the backend under evaluation (--backend), whatever the manifest's default says; Perplexity's
  // settings are Jev's (settingsModel), so the two are asked the same requests.
  options = optionsFor(settingsModel(backendName), manifest.userConfig ?? {}, values.option)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
// --state-tokens N widens (or narrows) the state's budget for every kind of request to N: past what the mod's own options
// can reach (they only lower it), to see what a model with a bigger window gains (#43). The result records it.
const stateTokens = values['state-tokens'] === undefined ? null : Number(values['state-tokens'])
if (stateTokens !== null && !(Number.isInteger(stateTokens) && stateTokens >= 100)) fail('--state-tokens takes a whole number of at least 100')
// --state-messages N lifts the number of recent messages the state may hold (the mod's is at most 32, whatever the token budget),
// so that a long conversation can fill a large --state-tokens (#44). The result records it.
const stateMessages = values['state-messages'] === undefined ? null : Number(values['state-messages'])
if (stateMessages !== null && !(Number.isInteger(stateMessages) && stateMessages >= 1)) fail('--state-messages takes a whole number of at least 1')
const widened = stateTokens === null ? settingsFrom(options as PluginOptions) : withStateTokens(settingsFrom(options as PluginOptions), stateTokens)
const settings = stateMessages === null ? widened : withStateMessages(widened, stateMessages)
/** How long one attempt may take: --timeout, else four times the mod's timeoutMs for this backend, at least 10 s (lib/runner.ts). */
const attemptMs = values.timeout === undefined ? defaultAttemptMs(settings.timeoutMs) : Number(values.timeout)
if (backendName === 'clef' && values.model !== undefined && values.model !== CLEF_MODEL) fail(`the Clef backend asks ${CLEF_MODEL} only`)
const model = backendName === 'clef' ? CLEF_MODEL : (values.model ?? (backendName === 'pplx' ? PPLX_MODEL : JEV_MODEL))
const price = PRICES[backendName]
// A flow file run with another backend or state than this run's is allowed (say, the 48000 flow under a 135000 state), and said.
if (flow !== null) {
  const ran = flow.file.settings
  const differs = [
    flow.file.backend.name !== backendName ? `backend ${flow.file.backend.name} (this run: ${backendName})` : '',
    ran.stateTokens !== settings.contextByKind.messagePlain ? `state budget ${ran.stateTokens} (this run: ${settings.contextByKind.messagePlain})` : '',
    ran.stateMessages !== settings.context.messages ? `message limit ${ran.stateMessages} (this run: ${settings.context.messages})` : '',
    ran.maxAfter !== settings.unresolved.maxAfter ? `unresolvedMaxAfter ${ran.maxAfter} (this run: ${settings.unresolved.maxAfter})` : '',
  ].filter((text) => text !== '')
  console.log(`flow: ${shown(flow.path)}, questions in ${ran.language}, bars ${ran.thresholds.add}/${ran.thresholds.reset}${differs.length === 0 ? '' : `; warning: it was run with ${differs.join(', ')}`}`)
}

// The estimate: the requests a run sends (a suite that asks again after
// reading an answer says what it may send at most: Suite.estimate; another
// counts what it sends first), at the mod's token estimate times what Jev
// actually counted: 6468 tokens for 8 effort-submit requests estimated at
// 4127 (2026-10-04), so 1.6.
// Perplexity counts differently, by the kind of text: against the mod's estimate (without the factor) its input tokens
// were 0.7 times for the skill suite, 0.9 for effort-submit, 1.0 for effort-midturn, 1.7 for subagent and 2.9 for
// unresolved (2026-10-07: the long logs of its conversations tokenize four times as densely as the estimate's four
// characters a token), so its factor is 3, so as never to estimate less than a run costs.
const ESTIMATE_FACTOR = backendName === 'pplx' ? 3 : 1.6
const planned: DecisionRequest[] = []
for (const item of items) {
  for (const variant of variants) {
    for (const language of languages) {
      if (suite.estimate !== undefined) {
        planned.push(...(await suite.estimate(item, language, variant, settings)))
        continue
      }
      await suite.decide(item, language, variant, async (request) => {
        planned.push(request)
        return { request, asked: { ok: false, failure: { kind: 'config', detail: 'estimate only' } }, ms: 0, attempts: 0 }
      }, settings)
    }
  }
}
const estimatedTokens = Math.round(ESTIMATE_FACTOR * planned.reduce((sum, request) => sum + estimateTokens(JSON.stringify({ model, ...request })), 0))
const estimatedUsd = (estimatedTokens * price) / 1e6
console.log(`${name}: ${items.length} items x ${variants.length} variants x ${languages.length} languages = ${planned.length} requests${suite.estimate === undefined ? '' : ' at most'}, about ${estimatedTokens} input tokens, about $${estimatedUsd.toFixed(4)} on ${backendName} (${model})`)
if (values.estimate) process.exit(0)
const maxUsd = Number(values['max-usd'])
if (estimatedUsd > maxUsd) fail(`the estimate is over --max-usd ${maxUsd}: nothing sent`)

let chosen: { backend: Backend; secrets: string[] }
try {
  chosen = backendFor(backendName, backendName === 'clef' ? undefined : model)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
const { backend, secrets } = chosen

const started = new Date()
const rows: Row<unknown>[] = await runSuite(suite, items, {
  backend,
  io: nodeIo,
  now: () => performance.now(),
  pause: (ms) => new Promise((done) => setTimeout(done, ms)),
  settings,
  variants,
  languages,
  timeoutMs: attemptMs,
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
// Requests sent: one per answer, more where a suite asks again (the skill suite's second stage).
const requests = rows.reduce((sum, row) => sum + (row.requests ?? 1), 0)
console.log(`answers ${rows.length}, requests ${requests} (attempts ${rows.reduce((sum, row) => sum + row.attempts, 0)}), input tokens ${inputTokens}, about $${usd.toFixed(4)}; answered by ${answeredBy.join(', ') || 'none'}`)

if (!values['no-save']) {
  const reviewPath = join(REVIEW_DIR, `${kind}.review.jsonl`)
  const decided = existsSync(reviewPath) ? new Set(readFileSync(reviewPath, 'utf8').split('\n').flatMap((line) => (line.trim() ? [JSON.parse(line).id] : []))).size : 0
  const result = {
    suite: suite.name,
    label: values.label ?? null,
    date: started.toISOString(),
    backend: { name: backend.name, model, answeredBy },
    dataset: {
      path: shown(path),
      items: dataset.items.length,
      sha256: sha(dataset.text),
      ...(Object.keys(beside).length === 0 ? {} : { beside }),
      // eval-v2: the final gold the answers were scored against (how many files, one hash of them all).
      ...(gold === null ? {} : { gold: { dir: 'eval/datasets/eval-v2/gold', ...gold } }),
      review: { file: existsSync(reviewPath) ? shown(reviewPath) : null, decided },
    },
    // The flow file the flow variants carried (--flow): where, its hash, and how it was run.
    ...(flow === null ? {} : { flow: { file: shown(flow.path), sha256: flow.sha256, backend: flow.file.backend, settings: flow.file.settings, summarizer: { model: flow.file.summarizer.model, says: flow.file.summarizer.says, answeredBy: flow.file.summarizer.answeredBy } } }),
    // Every file of the mod and of the eval's suites a request or a grade may come from.
    code: modCode(),
    settings: {
      context: settings.context,
      // The budget of a message's state as the run asked it (contextByKind.messagePlain: 24000 for Jev; the effort question's
      // request of its own, ADR 0005), and --state-tokens when the run set one for every kind of request.
      messageStateTokens: settings.contextByKind.messagePlain,
      ...(stateTokens === null ? {} : { stateTokens }),
      // The most recent messages the state may hold (the mod's: 32), and --state-messages when the run lifted it.
      stateMessagesLimit: settings.context.messages,
      ...(stateMessages === null ? {} : { stateMessages }),
      thetaMax: settings.thetaMax,
      timeoutMs: settings.timeoutMs,
      // Every option as the run read it (a feature's own, such as agentOverride), less the sensitive ones.
      options: Object.fromEntries(Object.entries(options).filter(([key]) => manifest.userConfig?.[key]?.sensitive !== true)),
      // The options the run left unset, with the value the backend's defaults gave each (core/setup.ts BACKEND_DEFAULTS).
      backendDefaults: Object.fromEntries(settings.defaults.used),
    },
    run: { items: items.length, variants, languages, timeoutMs: attemptMs, retries: Number(values.retries), concurrency: Number(values.concurrency), requests, attempts: rows.reduce((sum, row) => sum + row.attempts, 0), inputTokens, usd: Number(usd.toFixed(4)) },
    questions: Object.fromEntries(variants.map((variant) => [variant, suite.questions(variant)])),
    ...(suite.scoring === undefined ? {} : { scoring: suite.scoring }),
    ...(suite.about === undefined ? {} : { about: suite.about }),
    summary,
    answers: answersByItem(rows, suite.digestState === true),
  }
  const text = formatResult(result)
  if (secrets.some((secret) => secret !== '' && text.includes(secret))) fail('the results would hold a credential: not saved')
  const dir = join(RESULTS_DIR, suite.name)
  mkdirSync(dir, { recursive: true })
  const stem = `${started.toISOString().slice(0, 10)}-${backend.name}${values.label ? `-${values.label.replace(/[^A-Za-z0-9-]+/g, '-')}` : ''}`
  let file = join(dir, `${stem}.json`)
  for (let n = 2; existsSync(file); n++) file = join(dir, `${stem}-${n}.json`)
  writeFileSync(file, text)
  console.log(`saved ${shown(file)}`)
}

/**
 * One line per item and language: the state the model read once, then each variant's answer. A suite that digests its states
 * (`digestState`: its variants read different states, each tens of thousands of tokens) has a digest of each variant's state beside its answer.
 */
function answersByItem(rows: readonly Row<unknown>[], digest: boolean): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const key = `${row.id} ${row.language}`
    const group = groups.get(key) ?? { id: row.id, language: row.language, ...(digest ? {} : { state: row.state }) }
    group[row.variant] = Object.fromEntries(
      Object.entries({ answer: row.shown, correct: row.correct, gold: row.exact, miss: row.miss, parts: row.parts ?? null, ...row.detail, ms: row.ms, attempts: row.attempts, tokens: row.inputTokens, model: row.model, failure: row.failure, ...(digest ? { state: stateDigest(row.state) } : {}) }).filter(
        ([, value]) => value !== null,
      ),
    )
    groups.set(key, group)
  }
  return [...groups.values()]
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
    console.log(
      `${v.variant}: as the mod would have had it (within ${settings.timeoutMs} ms, at the first attempt; a later or retried answer counted as none) right zh/en: ${pct(v.zh.inTime)}/${pct(v.en.inTime)}; late answers zh/en: ${v.zh.late}/${v.en.late}; retried zh/en: ${v.zh.retried}/${v.en.retried}`,
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
