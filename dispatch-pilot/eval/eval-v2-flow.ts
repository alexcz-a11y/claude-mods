// Runs the real flow over eval v2 (#45; lib/eval-v2-flow.ts): for every item, each of the person's messages in order is
// asked of one backend at one state budget as the mod asks it (the effort question and the three-way question beside it,
// with the summary, the count and, from unresolvedMaxAfter on, the strong hint), the count moved by the mod's two bars,
// and after each turn the problem summary continued by the cheap model from the mod's own prompt, through
// `claude -p --model haiku` (`$.model.complete` exists only inside Claude Code; done as eval/long-context-summaries.ts does
// it). One file per backend and budget, which the eval-v2 suite's flow variants carry (`run.ts eval-v2 --flow <file>`)
// and eval/eval-v2-thresholds.ts scans:
//
//   node dispatch-pilot/eval/eval-v2-flow.ts --backend jev --estimate      how many requests and summary writes, the cost; nothing is asked
//   node dispatch-pilot/eval/eval-v2-flow.ts --backend jev                 -> eval/results/eval-v2-flow/jev-24000.json (the mod's budget)
//   node dispatch-pilot/eval/eval-v2-flow.ts --backend pplx --state-tokens 48000 --state-messages 2000 --timeout 240000 --max-usd 20
//   node dispatch-pilot/eval/eval-v2-flow.ts --backend pplx --state-tokens 135000 --state-messages 2000 --timeout 240000 --max-usd 40
//
// It goes on where an earlier run stopped: an item is saved after each of its messages (every few seconds), and a run
// takes the items not finished from the message they stopped at, with the count and summary they had (an item whose
// conversation changed starts over). A request that fails in a way the mod would also have met (an HTTP error, an answer
// it cannot read) is recorded as the mod would treat it: the count stays. One that may answer if asked again (busy,
// network, timeout, after --retries) stops that item, to be gone on with by the next run; a refused key or a spent quota
// stops the run.
//
// Options: --model (the backend's: jev-latest, pplx-decider-v1.1-27b), --state-tokens N and --state-messages N (as run.ts;
// the mod's 24000 and 32 otherwise), --language zh|en (the questions; the mod's turnStartLanguage, zh, otherwise),
// --thresholds add,reset (the bars; the mod's 0.5,0.7 otherwise), --option name=value (a mod option, as run.ts), --ids a,b,
// --limit N, --concurrency 4 (items at once; the messages of one item go one after another), --timeout <ms>, --retries 2,
// --summary-model haiku, --tries 3 (asks of a turn whose reply is no summary; the mod asks once, `claude -p` fails for
// reasons of its own), --out <file>, --label <word> (added to the file's name), --estimate, --max-usd 1, --no-cache.
//
// The cheap model's replies are kept by prompt in eval/results/eval-v2-flow/haiku-cache.jsonl (not committed): the same
// prompt, the same reply, so the two pplx budgets share the summaries while their counts agree, and a rerun costs nothing.
// Before the first write the run asks the cheap model once which model it is; the file records that answer and the models
// `claude -p` reports for every call (`summarizer.says`, `summarizer.answeredBy`).
//
// Credentials as run.ts: TYPESAFE_API_KEY, PERPLEXITY_API_KEY, from the environment or ~/.config/dispatch-pilot/eval.env.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import type { PluginOptions } from 'claude-code'
import { estimateTokens } from '../hooks/decision/context.ts'
import type { Language } from '../hooks/decision/effort.ts'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import { PPLX_MODEL } from '../hooks/decision/pplx.ts'
import { readSummary, SUMMARY_SYSTEM } from '../hooks/decision/summary.ts'
import { turnStartPart } from '../hooks/decision/turn-start.ts'
import { UNRESOLVED_THRESHOLDS, type UnresolvedThresholds } from '../hooks/decision/unresolved.ts'
import { lineTokens } from './lib/eval-v2.ts'
import { conversationPrint, flowItem, type FlowFile, type FlowItem } from './lib/eval-v2-flow.ts'
import type { V2EvalItem } from './lib/eval-v2-suite.ts'
import { attemptMs as defaultAttemptMs, askRetrying } from './lib/runner.ts'
import { optionsFor, settingsFrom, settingsModel, withStateMessages, withStateTokens, type EvalBackend } from './lib/suite.ts'
import { EVAL_V2_FLOW_DIR, PRICES, backendFor, nodeIo, readEvalV2Dataset, readManifest, shown } from './node.ts'

const { values } = parseArgs({
  options: {
    backend: { type: 'string', default: 'jev' },
    model: { type: 'string' },
    'state-tokens': { type: 'string' },
    'state-messages': { type: 'string' },
    language: { type: 'string' },
    thresholds: { type: 'string' },
    option: { type: 'string', multiple: true, default: [] },
    ids: { type: 'string' },
    limit: { type: 'string' },
    concurrency: { type: 'string', default: '4' },
    timeout: { type: 'string' },
    retries: { type: 'string', default: '2' },
    'summary-model': { type: 'string', default: 'haiku' },
    tries: { type: 'string', default: '3' },
    out: { type: 'string' },
    label: { type: 'string' },
    estimate: { type: 'boolean', default: false },
    'max-usd': { type: 'string', default: '1' },
    'no-cache': { type: 'boolean', default: false },
  },
})

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

// ---- the mod's settings for the backend, as run.ts reads them ----
const backendName = values.backend as EvalBackend
if (backendName !== 'jev' && backendName !== 'pplx') fail(`no backend "${backendName}" (jev, pplx)`)
const manifest = readManifest()
let options: PluginOptions
try {
  options = optionsFor(settingsModel(backendName), manifest.userConfig ?? {}, values.option)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
const stateTokens = values['state-tokens'] === undefined ? null : Number(values['state-tokens'])
if (stateTokens !== null && !(Number.isInteger(stateTokens) && stateTokens >= 100)) fail('--state-tokens takes a whole number of at least 100')
const stateMessages = values['state-messages'] === undefined ? null : Number(values['state-messages'])
if (stateMessages !== null && !(Number.isInteger(stateMessages) && stateMessages >= 1)) fail('--state-messages takes a whole number of at least 1')
const widened = stateTokens === null ? settingsFrom(options) : withStateTokens(settingsFrom(options), stateTokens)
const settings = stateMessages === null ? widened : withStateMessages(widened, stateMessages)
const budget = settings.contextByKind.messagePlain
const language = (values.language ?? settings.turnStartLanguage) as Language
if (language !== 'zh' && language !== 'en') fail(`--language takes zh or en, not ${language}`)
const thresholds: UnresolvedThresholds = values.thresholds === undefined ? UNRESOLVED_THRESHOLDS : (() => {
  const [add, reset] = values.thresholds.split(',').map(Number)
  if (add === undefined || reset === undefined || !(add > 0 && add < 1 && reset > 0 && reset < 1)) fail(`--thresholds takes add,reset, two numbers between 0 and 1, not ${values.thresholds}`)
  if (add + reset <= 1) console.log(`warning: add + reset is ${add + reset}: the mod keeps it over 1, so that one answer never meets both bars`)
  return { add, reset }
})()
const model = values.model ?? (backendName === 'pplx' ? PPLX_MODEL : JEV_MODEL)
const attemptMs = values.timeout === undefined ? defaultAttemptMs(settings.timeoutMs) : Number(values.timeout)
const summaryModel = values['summary-model']
const tries = Number(values.tries)

// ---- the dataset and the file ----
const read = readEvalV2Dataset()
for (const note of read.notes) console.log(note)
if (read.errors.length > 0) fail(`eval-v2 cannot be run:\n  ${read.errors.slice(0, 20).join('\n  ')}`)
let items: V2EvalItem[] = read.items
if (values.ids !== undefined) {
  const ids = values.ids.split(',')
  const unknown = ids.filter((id) => !items.some((item) => item.id === id))
  if (unknown.length > 0) fail(`no item ${unknown.join(', ')} in eval-v2`)
  items = items.filter((item) => ids.includes(item.id))
}
if (values.limit !== undefined) items = items.slice(0, Number(values.limit))

const label = values.label === undefined ? '' : `-${values.label.replace(/[^A-Za-z0-9-]+/g, '-')}`
const out = values.out ?? join(EVAL_V2_FLOW_DIR, `${backendName}-${budget}${language === 'zh' ? '' : `-${language}`}${label}.json`)
const ran: FlowFile['settings'] = { language, stateTokens: budget, stateMessages: settings.context.messages, thresholds, maxAfter: settings.unresolved.maxAfter }
const how = `claude -p --model ${summaryModel} --safe-mode --setting-sources project --tools "" --system-prompt-file <SUMMARY_SYSTEM> --output-format json --no-session-persistence --settings '{"alwaysThinkingEnabled":false}' --strict-mcp-config, MAX_THINKING_TOKENS=0, summaryPrompt on stdin, in an empty directory; up to ${tries} asks of a turn whose reply is no summary`
const file: FlowFile = existsSync(out)
  ? (JSON.parse(readFileSync(out, 'utf8')) as FlowFile)
  : {
      suite: 'eval-v2-flow',
      about:
        "The real flow over eval v2 (eval/eval-v2-flow.ts, lib/eval-v2-flow.ts): at each of the person's messages the mod's request (effort and three-way question, the summary and the count it held, the strong hint from unresolvedMaxAfter on), the count moved by the bars, the summary continued after each turn by the cheap model from the mod's prompt. Per item: each message's probabilities and count before and after; `final` is what the last message's request carried.",
      backend: { name: backendName, model, answeredBy: [] },
      settings: ran,
      summarizer: { model: summaryModel, says: null, answeredBy: [], how, asked: 0, failed: 0, cached: 0 },
      dataset: { sha256: read.sha256, items: read.items.length },
      items: {},
      runs: [],
    }
if (file.suite !== 'eval-v2-flow') fail(`${shown(out)} is not a flow file`)
if (file.backend.name !== backendName || file.backend.model !== model || JSON.stringify(file.settings) !== JSON.stringify(ran) || file.summarizer.model !== summaryModel) {
  fail(`${shown(out)} was written with other settings (${file.backend.name} ${file.backend.model}, ${JSON.stringify(file.settings)}, ${file.summarizer.model}): give another --out or --label`)
}
if (file.dataset.sha256 !== read.sha256) {
  console.log(`warning: ${shown(out)} was written over another eval-v2.jsonl: the items whose conversation changed start over`)
  file.dataset = { sha256: read.sha256, items: read.items.length }
}

/** The items to run, each from where it stopped (nothing when its conversation changed). */
const due = items.flatMap((item) => {
  const kept = file.items[item.id]
  const current = kept !== undefined && kept.conversation === conversationPrint(item)
  if (current && kept.final !== undefined) return []
  return [{ item, from: current ? kept : undefined }]
})

// ---- the estimate: requests at the state each would hold (the budget at most), the questions, the summary writes ----
const people = (item: V2EvalItem) => item.turns.flatMap((turn, at) => (turn.role === 'user' ? [at] : []))
const questions = estimateTokens(JSON.stringify({ model, questions: turnStartPart({ ask: { language, primitive: 'score' }, unresolved: true, count: 3, maxAfter: 3 }).questions }))
let requests = 0
let tokens = 0
let writes = 0
for (const { item, from } of due) {
  const ats = people(item).slice(from?.messages.length ?? 0)
  const before = item.turns.map(lineTokens)
  const prefix = (at: number) => before.slice(0, at).reduce((sum, n) => sum + n, 0) + estimateTokens(item.turns[at]?.text ?? '')
  for (const at of ats) tokens += Math.min(budget, prefix(at) + 600) + questions
  requests += ats.length
  writes += Math.max(0, ats.length - 1)
}
// The factors of run.ts: what each backend counted against the mod's estimate.
const factor = backendName === 'pplx' ? 3 : 1.6
const usd = (factor * tokens * PRICES[backendName]) / 1e6
console.log(`eval-v2 flow, ${backendName} (${model}), state ${budget} tokens / ${settings.context.messages} messages, questions in ${language}, bars ${thresholds.add}/${thresholds.reset}: ${items.length - due.length} of ${items.length} items done, ${due.length} to run: ${requests} requests, about ${Math.round(factor * tokens)} input tokens, about $${usd.toFixed(2)}; up to ${writes} summary writes with claude -p --model ${summaryModel}; -> ${shown(out)}`)
if (values.estimate || due.length === 0) process.exit(0)
if (usd > Number(values['max-usd'])) fail(`the estimate is over --max-usd ${values['max-usd']}: nothing sent`)

let chosen: ReturnType<typeof backendFor>
try {
  chosen = backendFor(backendName, model)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
const { backend, secrets } = chosen

// ---- the cheap model, through claude -p ----
const dir = mkdtempSync(join(tmpdir(), 'dp-flow-'))
const systemFile = join(dir, 'system.txt')
writeFileSync(systemFile, SUMMARY_SYSTEM)
const probeFile = join(dir, 'probe.txt')
writeFileSync(probeFile, 'Answer in one line.')
const SETTINGS = JSON.stringify({ alwaysThinkingEnabled: false })
const answeredBy = new Set(file.summarizer.answeredBy)

/** One `claude -p` call: the reply's text and the models it reports, or null (an error, a minute without an answer). */
function claude(prompt: string, system: string): Promise<{ text: string; models: string[] } | null> {
  return new Promise((done) => {
    const args = ['-p', '--model', summaryModel, '--safe-mode', '--setting-sources', 'project', '--tools', '', '--system-prompt-file', system, '--output-format', 'json', '--no-session-persistence', '--settings', SETTINGS, '--strict-mcp-config']
    const child = spawn('claude', args, { cwd: dir, env: { ...process.env, MAX_THINKING_TOKENS: '0' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => child.kill(), 60_000)
    child.stdout.on('data', (chunk) => (output += chunk))
    child.on('error', () => done(null))
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const result = JSON.parse(output) as { result?: string; is_error?: boolean; modelUsage?: Record<string, unknown> }
        if (result.is_error || typeof result.result !== 'string') return done(null)
        done({ text: result.result, models: Object.keys(result.modelUsage ?? {}) })
      } catch {
        done(null)
      }
    })
    child.stdin.end(prompt)
  })
}

const cacheFile = join(EVAL_V2_FLOW_DIR, 'haiku-cache.jsonl')
const cache = new Map<string, string>()
if (!values['no-cache'] && existsSync(cacheFile)) {
  for (const line of readFileSync(cacheFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const { key, reply } = JSON.parse(line) as { key: string; reply: string }
      cache.set(key, reply)
    } catch {
      // a line cut short by an interrupted run: skipped
    }
  }
}
const keyOf = (prompt: string) => createHash('sha256').update(JSON.stringify([summaryModel, SUMMARY_SYSTEM, prompt])).digest('hex')

/** The cheap model's reply to a summary prompt: from the cache when it holds one, else asked (and kept when it is a summary). */
async function complete(prompt: string): Promise<string | null> {
  const key = keyOf(prompt)
  const kept = values['no-cache'] ? undefined : cache.get(key)
  if (kept !== undefined) {
    file.summarizer.cached++
    return kept
  }
  file.summarizer.asked++
  const reply = await claude(prompt, systemFile)
  if (reply === null || readSummary(reply.text) === null) {
    file.summarizer.failed++
    return reply?.text ?? null
  }
  for (const name of reply.models) answeredBy.add(name)
  if (!values['no-cache']) {
    cache.set(key, reply.text)
    mkdirSync(EVAL_V2_FLOW_DIR, { recursive: true })
    appendFileSync(cacheFile, `${JSON.stringify({ key, reply: reply.text })}\n`)
  }
  return reply.text
}

// Which model is it: asked once, and recorded beside the models claude -p reports.
const probe = await claude('Which Claude model are you? Reply with your exact model ID only.', probeFile)
if (probe === null) fail(`claude -p --model ${summaryModel} gave no answer: is claude logged in?`)
file.summarizer.says = probe.text.trim()
for (const name of probe.models) answeredBy.add(name)
console.log(`summaries by ${summaryModel}: it says it is ${JSON.stringify(file.summarizer.says)}; claude -p reports ${probe.models.join(', ') || 'no model'}`)

// ---- saving: after each item, and every ten seconds while items run ----
const backendModels = new Set(file.backend.answeredBy)
let lastSave = 0
function save(): void {
  file.backend.answeredBy = [...backendModels].sort()
  file.summarizer.answeredBy = [...answeredBy].sort()
  const { items: kept, ...head } = file
  const ordered = Object.entries(kept).sort(([a], [b]) => (a < b ? -1 : 1))
  const top = JSON.stringify(head, null, 2)
  const text = `${top.slice(0, -2)},\n  "items": {${ordered.length === 0 ? '' : `\n${ordered.map(([id, item]) => `    ${JSON.stringify(id)}: ${JSON.stringify(item)}`).join(',\n')}\n  `}}\n}\n`
  if (secrets.some((secret) => secret !== '' && text.includes(secret))) fail('the flow file would hold a credential: not saved')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, text)
  lastSave = Date.now()
}
const saveSoon = () => {
  if (Date.now() - lastSave > 10_000) save()
}
process.on('SIGINT', () => {
  save()
  rmSync(dir, { recursive: true, force: true })
  console.log(`interrupted: saved ${shown(out)}; run the same command to go on`)
  process.exit(130)
})

// ---- the run ----
const started = new Date()
const run = { date: started.toISOString(), items: 0, requests: 0, inputTokens: 0 }
file.runs = [...(file.runs ?? []), run]
const ask = async (request: Parameters<typeof askRetrying>[0]) => {
  const sent = await askRetrying(request, { backend, io: nodeIo, timeoutMs: attemptMs, retries: Number(values.retries), now: () => performance.now(), pause: (ms) => new Promise((done) => setTimeout(done, ms)) })
  run.requests++
  if (sent.asked.ok) {
    run.inputTokens += sent.asked.inputTokens ?? 0
    if (sent.asked.model !== null) backendModels.add(sent.asked.model)
  }
  return sent
}
let next = 0
let finished = 0
let halted: string | null = null
const stopped: string[] = []
const worker = async () => {
  while (next < due.length && halted === null) {
    const { item, from } = due[next++] as (typeof due)[number]
    const result = await flowItem(item, { ask, complete, settings, language, thresholds, tries, onMessage: (now: FlowItem) => {
      file.items[item.id] = now
      saveSoon()
    } }, from)
    file.items[item.id] = result.item
    if (result.stopped !== null) {
      stopped.push(`${item.id} at ${result.stopped}`)
      console.log(`  ${item.id}: stopped at ${result.stopped}`)
      if (/^\S+: (config|quota):/.test(result.stopped)) halted = result.stopped
    } else {
      run.items++
      const last = result.item.final
      const failures = result.item.messages.filter((message) => message.failure !== undefined).length
      const unwritten = result.item.messages.filter((message) => message.write === 'failed').length
      console.log(`  ${item.id}: ${result.item.messages.length} messages, count ${last?.count ?? 0} at the last${last?.hint ? ' (hint)' : ''}${failures > 0 ? `, ${failures} unanswered` : ''}${unwritten > 0 ? `, ${unwritten} summaries not written` : ''} (${++finished}/${due.length})`)
    }
    save()
  }
}
await Promise.all(Array.from({ length: Math.max(1, Math.min(Number(values.concurrency), due.length)) }, worker))
save()
rmSync(dir, { recursive: true, force: true })
const left = items.filter((item) => file.items[item.id]?.final === undefined)
console.log(`${shown(out)}: ${items.length - left.length} of ${items.length} items finished; ${run.requests} requests, ${run.inputTokens} input tokens (about $${((run.inputTokens * PRICES[backendName]) / 1e6).toFixed(2)}); summaries asked ${file.summarizer.asked}, from the cache ${file.summarizer.cached}, without a summary ${file.summarizer.failed} (all runs)`)
if (halted !== null) console.log(`halted: ${halted}`)
if (left.length > 0) console.log(`not finished: ${left.map((item) => item.id).join(', ')}; run the same command to go on`)
process.exit(left.length > 0 ? 1 : 0)
