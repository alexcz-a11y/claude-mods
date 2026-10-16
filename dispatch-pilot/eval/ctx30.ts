// The ctx30 experiment (lib/ctx30.ts): thirty questions about one long conversation in one request, asked of Jev 1.14
// with the regular context (the newest 24000 estimated tokens, the most Jev takes without the header) and with the long-context
// header (the whole conversation).
//
//   node dispatch-pilot/eval/ctx30.ts           check: sizes, where each question's decisive turns are, what each request holds
//   node dispatch-pilot/eval/ctx30.ts --run     ask both requests once and write results/ctx30/<date>-jev114.json
//   node dispatch-pilot/eval/ctx30.ts --run --backend d1 --tokens 28000
//                                               one request, the newest 28000 estimated tokens, asked of d1-ultra (or jev: past
//                                               24000 it carries Jev's long-context header, as the mod sends it), written to
//                                               results/ctx30/<date>-<backend>-<tokens>.json; the questions whose decisive turns
//                                               that state holds are listed (DEVELOPMENT.md 「d1-ultra 核验」)
//
// Exits 1 when the check finds a fault: a decisive turn the regular request can see, a question with no decisive turn
// (a trap aside), a mark naming no question, text the mod's masking would change.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { estimateTokens } from '../hooks/decision/context.ts'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import { D1_MODEL } from './lib/d1.ts'
import { DATASETS_DIR, RESULTS_DIR, backendFor, nodeIo } from './node.ts'
import { REGULAR_TOKENS, conversationLines, ctx30Request, depths, maskedMessages, mcnemar, parseConversation, probeQuestion, readRun, type Probe, type Read } from './lib/ctx30.ts'

const DIR = join(DATASETS_DIR, 'ctx30')
const { values } = parseArgs({ options: { run: { type: 'boolean', default: false }, backend: { type: 'string', default: 'jev' }, tokens: { type: 'string' } } })
const run = values.run === true
const backendName = values.backend as string
if (backendName !== 'jev' && backendName !== 'd1') throw new Error(`--backend takes jev or d1, not ${backendName}`)
const budgetTokens = values.tokens === undefined ? null : Number(values.tokens)
if (budgetTokens !== null && !(Number.isInteger(budgetTokens) && budgetTokens >= 1000)) throw new Error(`--tokens takes a whole number of 1000 or more, not ${values.tokens}`)
if (backendName === 'd1' && budgetTokens === null) throw new Error('d1 reads at most 32768 tokens a question: give it --tokens (28000)')

const folder = join(DIR, 'conversation')
const files = readdirSync(folder).filter((file) => file.endsWith('.txt')).sort().map((name) => ({ name, text: readFileSync(join(folder, name), 'utf8') }))
const { messages, errors } = parseConversation(files)
const probes = JSON.parse(readFileSync(join(DIR, 'questions.json'), 'utf8')) as Probe[]
const lines = conversationLines(messages)
if (lines.length !== messages.length) errors.push(`${messages.length} messages became ${lines.length} lines`)
const depth = depths(lines)
const total = depth[0] ?? 0

const regular = ctx30Request(lines, probes, REGULAR_TOKENS)
const long = ctx30Request(lines, probes, null)
const seen = lines.length - regular.kept
const covered = regular.kept === 0 ? 0 : (depth[seen] ?? 0)

for (const at of maskedMessages(messages)) errors.push(`${at}: the mod's masking would change this message`)
const ids = new Set(probes.map((probe) => probe.id))
for (const message of messages) for (const mark of message.marks) if (!ids.has(mark)) errors.push(`${message.at}: mark ${mark} names no question`)

const k = (n: number) => `${(n / 1000).toFixed(1)}k`
console.log(`conversation: ${files.length} files, ${messages.length} messages, ${k(total)} estimated tokens`)
console.log(`regular request: the newest ${regular.kept} messages, ${k(covered)} from the end (state budget ${REGULAR_TOKENS})`)
const questionTokens = probes.map((probe) => estimateTokens(JSON.stringify(probeQuestion(probe))))
const stateOf = (request: typeof regular.request) => estimateTokens(JSON.stringify(request.state))
const sum = questionTokens.reduce((a, b) => a + b, 0)
const largest = Math.max(...questionTokens)
console.log(`questions: ${probes.length}, ${k(sum)} in all, the largest ${largest} (Jev counts about 1.2 times: request ${k((stateOf(regular.request) + sum) * 1.2)} of 64k and ${k((stateOf(regular.request) + largest) * 1.2)} a question of 32k regular; ${k((stateOf(long.request) + sum) * 1.2)} of 262k long)`)
console.log('')

/** How far a question's nearest decisive message is from the end: near under 36k, mid under 48k, far beyond. */
const bandOf = (tokens: number): 'near' | 'mid' | 'far' => (tokens >= 48000 ? 'far' : tokens >= 36000 ? 'mid' : 'near')
const bands = { near: 0, mid: 0, far: 0 }
for (const probe of probes) {
  const at = messages.flatMap((message, i) => (message.marks.includes(probe.id) ? [i] : []))
  const trap = probe.kind === 'agent' && probe.trap === true
  if (at.length === 0) {
    if (!trap) errors.push(`${probe.id}: no decisive message is marked`)
    console.log(`${probe.id} ${probe.kind.padEnd(6)} gold ${probe.gold.padEnd(6)} ${trap ? 'trap: answered from the brief alone' : 'NOT MARKED'}`)
    continue
  }
  const nearest = Math.min(...at.map((i) => depth[i] ?? 0))
  const farthest = Math.max(...at.map((i) => depth[i] ?? 0))
  if (at.some((i) => i >= seen)) errors.push(`${probe.id}: a decisive message is within the regular request (${messages[at.find((i) => i >= seen) as number]?.at})`)
  const band = bandOf(nearest)
  bands[band]++
  console.log(`${probe.id} ${probe.kind.padEnd(6)} gold ${probe.gold.padEnd(6)} decisive ${k(nearest)}${farthest > nearest ? `–${k(farthest)}` : ''} from the end (band ${band}), ${at.length} message${at.length > 1 ? 's' : ''}`)
}
console.log(`\nbands (nearest decisive message): near (under 36k) ${bands.near}, mid (36k–48k) ${bands.mid}, far (48k and over) ${bands.far}`)

if (errors.length > 0) {
  console.log(`\n${errors.length} fault${errors.length > 1 ? 's' : ''}:`)
  for (const error of errors) console.log(`  - ${error}`)
  process.exit(1)
}
if (!run) process.exit(0)

// ---- --tokens: one request with that state budget, of --backend ----
if (budgetTokens !== null) {
  const budget = ctx30Request(lines, probes, budgetTokens)
  const holds = lines.length - budget.kept
  const visible = probes.filter((probe) => messages.some((message, i) => i >= holds && message.marks.includes(probe.id))).map((probe) => probe.id)
  const model = backendName === 'd1' ? D1_MODEL : JEV_MODEL
  const { backend, secrets } = backendFor(backendName, model)
  const started = Date.now()
  const asked = await backend.ask(nodeIo, budget.request, 120000)
  const ms = Date.now() - started
  if (!asked.ok) {
    let failure = `${asked.failure.kind}: ${asked.failure.status ?? ''} ${asked.failure.detail}`
    for (const secret of secrets) failure = failure.split(secret).join('[REDACTED]')
    console.error(`refused: ${failure}`)
    process.exit(1)
  }
  const key = `s${budgetTokens}`
  const reads = readRun(probes, asked.answers)
  const right = (kind?: Probe['kind']) => probes.filter((probe) => (kind === undefined || probe.kind === kind) && reads.get(probe.id)?.answer === probe.gold).length
  const summary = { right: right(), effort: right('effort'), agent: right('agent') }
  const answers = probes.map((probe) => ({ id: probe.id, kind: probe.kind, gold: probe.gold, ...(probe.kind === 'agent' && probe.trap ? { trap: true } : {}), [key]: reads.get(probe.id) ?? null }))
  const date = new Date().toISOString().slice(0, 10)
  const out = join(RESULTS_DIR, 'ctx30')
  mkdirSync(out, { recursive: true })
  const path = join(out, `${date}-${backendName}-${budgetTokens}.json`)
  writeFileSync(path, `${JSON.stringify({ experiment: 'ctx30', date, backend: backendName, model, tokens: budgetTokens, kept: budget.kept, conversationTokens: total, visible, runs: { [key]: { ok: true, model: asked.model, inputTokens: asked.inputTokens, ms } }, summary: { [key]: summary }, answers }, null, 2)}\n`)
  console.log(`${backendName} at ${budgetTokens}: the newest ${budget.kept} messages; decisive turns within it: ${visible.join(', ') || 'none'}`)
  console.log(`${summary.right}/30 (effort ${summary.effort}/15, agent ${summary.agent}/15), ${asked.inputTokens} input tokens, ${ms} ms by ${asked.model}`)
  console.log(`written: ${path}`)
  process.exit(0)
}

// ---- the run: each request once, regular first ----

type Ran = { ok: true; reads: Map<string, Read>; inputTokens: number | null; ms: number; model: string | null } | { ok: false; failure: string; ms: number }

async function ask(longContext: boolean, request: typeof regular.request): Promise<Ran> {
  const { backend, secrets } = backendFor('jev', JEV_MODEL, longContext ? { longContext: true } : {})
  const started = Date.now()
  const asked = await backend.ask(nodeIo, request, 60000)
  const ms = Date.now() - started
  if (!asked.ok) {
    let failure = `${asked.failure.kind}: ${asked.failure.status ?? ''} ${asked.failure.detail}`
    for (const secret of secrets) failure = failure.split(secret).join('[REDACTED]')
    return { ok: false, failure, ms }
  }
  return { ok: true, reads: readRun(probes, asked.answers), inputTokens: asked.inputTokens, ms, model: asked.model }
}

// The regular request is a 24000-token state (REGULAR_TOKENS); Jev counts a little more than the mod estimates, so should Jev
// answer that it is over its 32k a question, it is sent again with a smaller state (and the result says so).
let regularTokens = REGULAR_TOKENS
let regularRun = await ask(false, regular.request)
for (const smaller of [22000, 20000]) {
  if (regularRun.ok || !/^http: .*\b(400|413)\b/.test(regularRun.failure)) break
  console.log(`regular request refused (${regularRun.failure.slice(0, 160)}); again with a ${smaller}-token state`)
  regularTokens = smaller
  regularRun = await ask(false, ctx30Request(lines, probes, smaller).request)
}
const runs = { regular: regularRun, long: await ask(true, long.request) }
const right = (ran: Ran, probe: Probe) => ran.ok && ran.reads.get(probe.id)?.answer === probe.gold
const rows = probes.map((probe) => ({
  id: probe.id,
  kind: probe.kind,
  gold: probe.gold,
  ...(probe.kind === 'agent' && probe.trap ? { trap: true } : {}),
  regular: runs.regular.ok ? runs.regular.reads.get(probe.id) : null,
  long: runs.long.ok ? runs.long.reads.get(probe.id) : null,
}))
const count = (ran: Ran, kind?: Probe['kind']) => probes.filter((probe) => (kind === undefined || probe.kind === kind) && right(ran, probe)).length
const onlyLong = probes.filter((probe) => right(runs.long, probe) && !right(runs.regular, probe)).length
const onlyRegular = probes.filter((probe) => right(runs.regular, probe) && !right(runs.long, probe)).length
const summary = {
  regular: { right: count(runs.regular), effort: count(runs.regular, 'effort'), agent: count(runs.regular, 'agent') },
  long: { right: count(runs.long), effort: count(runs.long, 'effort'), agent: count(runs.long, 'agent') },
  onlyLong,
  onlyRegular,
  p: mcnemar(onlyLong, onlyRegular),
}
const about = (ran: Ran) => (ran.ok ? { ok: true, model: ran.model, inputTokens: ran.inputTokens, ms: ran.ms } : { ok: false, failure: ran.failure, ms: ran.ms })
const date = new Date().toISOString().slice(0, 10)
const out = join(RESULTS_DIR, 'ctx30')
mkdirSync(out, { recursive: true })
const path = join(out, `${date}-jev114.json`)
const kept = ctx30Request(lines, probes, regularTokens).kept
writeFileSync(path, `${JSON.stringify({ experiment: 'ctx30', date, model: JEV_MODEL, regularTokens, kept, conversationTokens: total, runs: { regular: about(runs.regular), long: about(runs.long) }, summary, answers: rows }, null, 2)}\n`)
console.log(`\nregular ${summary.regular.right}/30 (effort ${summary.regular.effort}/15, agent ${summary.regular.agent}/15); long ${summary.long.right}/30 (effort ${summary.long.effort}/15, agent ${summary.long.agent}/15)`)
console.log(`only long right ${onlyLong}, only regular right ${onlyRegular}, exact McNemar p=${summary.p.toFixed(4)}`)
console.log(`written: ${path}`)
