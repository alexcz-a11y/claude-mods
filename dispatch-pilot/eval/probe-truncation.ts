// Does Clef read the whole of a long state? (#17: 验证 Clef 是否截断 state)
//
//   node dispatch-pilot/eval/probe-truncation.ts --estimate          what it would send and cost; nothing is sent
//   node dispatch-pilot/eval/probe-truncation.ts                     Clef, then Jev as the control
//   node dispatch-pilot/eval/probe-truncation.ts --backend clef      one backend only
//
// Third-party pages say Workers AI reads only about the first 2K tokens of a
// state; Cloudflare's schema says only that a long text state "is truncated
// to fit the model's token limit"; the open-source encoder
// (joint_schema_model.py on Hugging Face) keeps a state's head
// (`state_ids[:max_state_tokens]`, then what `max_length` leaves after the
// questions) and never cuts the questions. So each probe hides three facts in
// `recent_context`, at its start, its middle and its end, and asks about each
// with a Choice that offers "not stated": a fact that was cut off is answered
// "not stated", or guessed. The ladder grows the state (English to about 9.6k
// tokens, Chinese to 4.8k, counted as the mod estimates tokens). One more
// probe puts a long question (about 15k tokens of criteria) beside a short
// state: whether the questions eat the state's room, and, by asking about the
// last of its options, whether the questions themselves are cut. Every answer
// is kept with the input tokens the backend counted and how long it took.
//
// Credentials as eval/run.ts reads them (the environment, then
// ~/.config/dispatch-pilot/eval.env); never printed or saved. Saves
// eval/results/probes/<date>-truncation.json.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Asked, Backend, Failure } from '../hooks/decision/backend.ts'
import { CLEF_MODEL, clefBackend } from '../hooks/decision/clef.ts'
import { estimateTokens } from '../hooks/decision/context.ts'
import { JEV_MODEL, jevBackend } from '../hooks/decision/jev.ts'
import { answersFor, mergeParts, type ChoiceQuestion, type DecisionRequest, type Part } from '../hooks/decision/system-one.ts'
import { CREDENTIALS_FILE, RESULTS_DIR, credential, nodeIo, shown } from './node.ts'

type Language = 'en' | 'zh'
type Position = 'start' | 'middle' | 'end'
const POSITIONS: readonly Position[] = ['start', 'middle', 'end']

const { values } = parseArgs({
  options: {
    backend: { type: 'string', default: 'both' },
    estimate: { type: 'boolean', default: false },
    show: { type: 'string' },
    timeout: { type: 'string', default: '30000' },
    retries: { type: 'string', default: '2' },
    'no-save': { type: 'boolean', default: false },
  },
})

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

// ---- What the probes say -------------------------------------------------

/** The three facts, one at each place in `recent_context`. */
const FACTS: Record<Language, Record<Position, string>> = {
  en: {
    start: 'The badge colour for the visitor desk is vermilion.',
    middle: 'The fallback code word for the night shift is lantern.',
    end: 'The courier for the Friday shipment is named Okonkwo.',
  },
  zh: {
    start: '访客台的胸牌颜色是朱红色。',
    middle: '夜班的备用暗号是“灯笼”。',
    end: '周五那批货的快递员叫欧阳明。',
  },
}

/** The question about each fact: its options (the right one first in this table) and "not stated". */
const ASKED: Record<Position, { right: string; instructions: Record<Language, string>; options: Record<Language, Record<string, string>> }> = {
  start: {
    right: 'vermilion',
    instructions: { en: 'What badge colour does `recent_context` give for the visitor desk?', zh: '`recent_context` 里说访客台的胸牌是什么颜色？' },
    options: {
      en: { vermilion: 'Vermilion', cerulean: 'Cerulean', ochre: 'Ochre', viridian: 'Viridian', mauve: 'Mauve', sienna: 'Sienna' },
      zh: { vermilion: '朱红色', cerulean: '天蓝色', ochre: '赭石色', viridian: '铬绿色', mauve: '淡紫色', sienna: '土黄色' },
    },
  },
  middle: {
    right: 'lantern',
    instructions: { en: 'What fallback code word does `recent_context` give for the night shift?', zh: '`recent_context` 里说夜班的备用暗号是什么？' },
    options: {
      en: { lantern: 'Lantern', harbour: 'Harbour', thicket: 'Thicket', pebble: 'Pebble', falcon: 'Falcon', meadow: 'Meadow' },
      zh: { lantern: '灯笼', harbour: '港湾', thicket: '灌木', pebble: '卵石', falcon: '猎鹰', meadow: '草地' },
    },
  },
  end: {
    right: 'okonkwo',
    instructions: { en: 'Who does `recent_context` name as the courier for the Friday shipment?', zh: '`recent_context` 里说周五那批货的快递员叫什么？' },
    options: {
      en: { okonkwo: 'Okonkwo', lindqvist: 'Lindqvist', tanaka: 'Tanaka', moreau: 'Moreau', castellano: 'Castellano', abernathy: 'Abernathy' },
      zh: { okonkwo: '欧阳明', lindqvist: '司马青', tanaka: '上官云', moreau: '慕容雪', castellano: '东方白', abernathy: '南宫月' },
    },
  },
}

const NOT_STATED: Record<Language, string> = { en: '`recent_context` does not say', zh: '`recent_context` 里没有说' }

/** Neutral notes between the facts: none of them names a colour, a code word, a courier or a weekday the questions ask about. */
const FILLER: Record<Language, readonly string[]> = {
  en: [
    'Item {n}: the team reviewed the archive migration schedule and moved the remaining checks to next week.',
    'Item {n}: a reviewer asked for clearer names in the billing report, and the author agreed to rename two columns.',
    'Item {n}: the nightly import finished without warnings and the row counts matched the previous run.',
    'Item {n}: someone noted that the staging database still uses the old timezone setting.',
    'Item {n}: the design notes for the export page were shared, with a request for comments by Thursday.',
    'Item {n}: two unstable tests in the payment module were marked for investigation.',
    'Item {n}: the meeting about the onboarding checklist was moved to the afternoon.',
    'Item {n}: a dependency update was postponed until the release branch is cut.',
  ],
  zh: [
    '第 {n} 条：团队回顾了归档迁移的排期，把剩下的检查挪到了下周。',
    '第 {n} 条：一位评审希望账单报表里的列名更清楚，作者同意改两列的名字。',
    '第 {n} 条：夜间导入顺利完成，没有警告，行数和上一次一致。',
    '第 {n} 条：有人提到预发环境的数据库还在用旧的时区设置。',
    '第 {n} 条：导出页面的设计说明已经发出，请大家周四之前给意见。',
    '第 {n} 条：支付模块里两个不稳定的测试被标记为待查。',
    '第 {n} 条：关于入职清单的会议改到了下午。',
    '第 {n} 条：一个依赖升级推迟到发布分支切出之后。',
  ],
}

const SUMMARIZE: Record<Language, string> = { en: 'Summarize the notes in recent_context.', zh: '总结一下 recent_context 里的记录。' }

/** `recent_context` of about `tokens` estimated tokens: the start fact, notes, the middle fact, notes, the end fact. */
function notes(language: Language, tokens: number): string {
  const lines: string[] = []
  let used = estimateTokens(Object.values(FACTS[language]).join(' '))
  for (let n = 1; used < tokens; n++) {
    const line = (FILLER[language][(n - 1) % FILLER[language].length] as string).replace('{n}', String(n))
    lines.push(line)
    used += estimateTokens(line) + 1
  }
  const half = Math.floor(lines.length / 2)
  const facts = FACTS[language]
  return [facts.start, ...lines.slice(0, half), facts.middle, ...lines.slice(half), facts.end].join(' ')
}

function factQuestion(position: Position, language: Language): ChoiceQuestion {
  const asked = ASKED[position]
  return { type: 'choice', instructions: asked.instructions[language], criteria: { ...asked.options[language], not_stated: NOT_STATED[language] } }
}

/**
 * The long question: catalog entries, each about one ticket reference; the
 * one the message names is the last. Sized like the skill request's first
 * stage with every profile (about 15k tokens as Clef counts them), the
 * largest question the mod sends.
 */
const WANTED = 'ZEPHYR-ORCHID'
const BULK_ENTRIES = 72
function bulkQuestion(): ChoiceQuestion {
  const first = ['ALPINE', 'BRAMBLE', 'CINDER', 'DELTA', 'EMBER', 'FJORD', 'GLACIER', 'HOLLOW', 'INDIGO', 'JASPER', 'KESTREL', 'LAGOON']
  const second = ['ASTER', 'BIRCH', 'CEDAR', 'DAHLIA', 'ELM', 'FERN', 'GORSE']
  const references = first.flatMap((a) => second.map((b) => `${a}-${b}`)).slice(0, BULK_ENTRIES - 1)
  references.push(WANTED)
  const entry = (i: number, reference: string) =>
    `Catalog entry ${i} covers ticket reference ${reference}. It records a routine maintenance request filed by the facilities group: ` +
    'the request lists the building wing, the floor, the kind of fixture involved and the preferred time window, and notes that the work needs no special access. ' +
    'The entry also keeps the history of status changes, the reviewers who signed off, the estimated hours, the materials ordered and the follow-up checks planned after completion. ' +
    `Its invoices, photos and correspondence are filed under the same reference, ${reference}, which no other entry uses. ` +
    'Requests of this kind are usually closed within two working days, and a closed request can be reopened by the facilities group within a month.'
  return {
    type: 'choice',
    instructions: 'Which catalog entry is for the ticket reference that `user_message` gives?',
    criteria: Object.fromEntries(references.map((reference, i) => [`entry_${String(i).padStart(2, '0')}`, entry(i, reference)])),
  }
}
const BULK_RIGHT = `entry_${String(BULK_ENTRIES - 1).padStart(2, '0')}`

// ---- The probes ------------------------------------------------------------

type Probe = { name: string; language: Language; stateTokens: number; bulk: boolean; part: Part; request: DecisionRequest }

function probe(language: Language, stateTokens: number, bulk = false): Probe {
  const questions: Record<string, ChoiceQuestion> = Object.fromEntries(POSITIONS.map((position) => [position, factQuestion(position, language)]))
  if (bulk) questions.bulk = bulkQuestion()
  const part: Part = { part: 'probe', questions }
  const message = bulk ? `Find the catalog entry for ticket reference ${WANTED}, then ${SUMMARIZE.en.charAt(0).toLowerCase()}${SUMMARIZE.en.slice(1)}` : SUMMARIZE[language]
  const state = { user_message: message, recent_context: notes(language, stateTokens) }
  return { name: `${language}-${stateTokens}${bulk ? '-bulk' : ''}`, language, stateTokens, bulk, part, request: mergeParts(state, [part]) }
}

const WARMUP: Probe = (() => {
  const part: Part = { part: 'probe', questions: { start: factQuestion('start', 'en') } }
  const state = { user_message: SUMMARIZE.en, recent_context: FACTS.en.start }
  return { name: 'warmup', language: 'en', stateTokens: 0, bulk: false, part, request: mergeParts(state, [part]) }
})()

const PROBES: Probe[] = [
  WARMUP,
  ...[1200, 2400, 4800, 9600].map((tokens) => probe('en', tokens)),
  ...[1200, 2400, 4800].map((tokens) => probe('zh', tokens)),
  probe('en', 1200, true),
]

/** Where each fact sits in the state, in estimated tokens from its start (the state as JSON, as it is sent). */
function factOffsets(p: Probe): Partial<Record<Position, number>> {
  const text = JSON.stringify(p.request.state)
  const out: Partial<Record<Position, number>> = {}
  for (const position of POSITIONS) {
    const at = text.indexOf(FACTS[p.language][position])
    if (at >= 0) out[position] = estimateTokens(text.slice(0, at))
  }
  return out
}

const sizes = PROBES.map((p) => ({ state: estimateTokens(JSON.stringify(p.request.state)), questions: estimateTokens(JSON.stringify(p.request.questions)) }))

// --show <probe>: the request it sends, as JSON; nothing is sent.
if (values.show !== undefined) {
  const p = PROBES.find((one) => one.name === values.show) ?? fail(`no probe "${values.show}" (${PROBES.map((one) => one.name).join(', ')})`)
  console.log(JSON.stringify(p.request, null, 2))
  console.log(`facts at (estimated tokens from the start of the state): ${JSON.stringify(factOffsets(p))}`)
  process.exit(0)
}

// ---- Estimate ----------------------------------------------------------------

const backends = values.backend === 'both' ? ['clef', 'jev'] : [values.backend]
for (const name of backends) if (name !== 'clef' && name !== 'jev') fail(`no backend "${name}" (clef, jev, both)`)
// As eval/run.ts: the mod's estimate times what Jev counted (1.6); Clef counts about 0.68 of what Jev does (#17's plan, 1.5).
const estimated = sizes.reduce((sum, s) => sum + s.state + s.questions, 0)
const PRICE: Record<string, { factor: number; usd: number }> = { jev: { factor: 1.6, usd: 0.042 }, clef: { factor: 1.6 * 0.68, usd: 0.24 } }
for (const [i, p] of PROBES.entries()) console.log(`${p.name.padEnd(14)} state ~${sizes[i]?.state} tokens, questions ~${sizes[i]?.questions}`)
for (const name of backends) {
  const price = PRICE[name] as { factor: number; usd: number }
  const tokens = Math.round(estimated * price.factor)
  console.log(`${name}: ${PROBES.length} requests, about ${tokens} input tokens, about $${((tokens * price.usd) / 1e6).toFixed(4)}${name === 'clef' ? `, about ${Math.round(tokens / 45)} neurons` : ''}`)
}
if (values.estimate) process.exit(0)

// ---- Send --------------------------------------------------------------------

const secrets: string[] = []
function makeBackend(name: string): Backend {
  if (name === 'jev') {
    const key = credential('TYPESAFE_API_KEY') ?? fail(`no TYPESAFE_API_KEY in the environment or ${CREDENTIALS_FILE}`)
    secrets.push(key)
    return jevBackend(key, { model: JEV_MODEL })
  }
  const accountId = credential('CLOUDFLARE_ACCOUNT_ID') ?? fail(`no CLOUDFLARE_ACCOUNT_ID in the environment or ${CREDENTIALS_FILE}`)
  const apiToken = credential('CLOUDFLARE_AUTH_TOKEN') ?? fail(`no CLOUDFLARE_AUTH_TOKEN in the environment or ${CREDENTIALS_FILE}`)
  secrets.push(accountId, apiToken)
  return clefBackend({ accountId, apiToken })
}

const TRANSIENT: readonly Failure['kind'][] = ['busy', 'network', 'timeout']
async function send(backend: Backend, request: DecisionRequest): Promise<{ asked: Asked; ms: number; attempts: number }> {
  for (let attempt = 1; ; attempt++) {
    const started = performance.now()
    const asked = await backend.ask(nodeIo, request, Number(values.timeout))
    const ms = Math.round(performance.now() - started)
    if (asked.ok || attempt > Number(values.retries) || !TRANSIENT.includes(asked.failure.kind)) return { asked, ms, attempts: attempt }
    await new Promise((done) => setTimeout(done, 1000 * 2 ** (attempt - 1)))
  }
}

type Read = { choice: string; right: boolean; p_right: number; p_not_stated: number }
function readProbe(p: Probe, asked: Asked): Record<string, Read> | null {
  if (!asked.ok) return null
  const answers = answersFor(p.part, asked.answers)
  const out: Record<string, Read> = {}
  for (const id of Object.keys(p.part.questions)) {
    const answer = answers[id]
    if (answer?.type !== 'choice') continue
    const right = id === 'bulk' ? BULK_RIGHT : ASKED[id as Position].right
    const round = (x: number | undefined) => Math.round((x ?? 0) * 1000) / 1000
    out[id] = { choice: answer.choice, right: answer.choice === right, p_right: round(answer.probabilities[right]), p_not_stated: round(answer.probabilities.not_stated) }
  }
  return out
}

const started = new Date()
const results: Record<string, unknown>[] = PROBES.map((p, i) => ({ name: p.name, language: p.language, bulk: p.bulk, estimated: sizes[i], facts_at: factOffsets(p) }))
const models: Record<string, string[]> = {}
for (const name of backends) {
  const backend = makeBackend(name)
  const answeredBy: string[] = (models[name] = [])
  console.log(`\n${name}:`)
  console.log(`${'probe'.padEnd(14)} ${'input tok'.padStart(9)} ${'ms'.padStart(6)}  start / middle / end / bulk (right: p of the right option; otherwise p of not stated)`)
  for (const [i, p] of PROBES.entries()) {
    const { asked, ms, attempts } = await send(backend, p.request)
    const read = readProbe(p, asked)
    if (asked.ok && asked.model !== null && !answeredBy.includes(asked.model)) answeredBy.push(asked.model)
    const row = results[i] as Record<string, unknown>
    row[name] = asked.ok ? { input_tokens: asked.inputTokens, ms, attempts, answers: read } : { failure: `${asked.failure.kind}: ${asked.failure.detail}`, ms, attempts }
    const cell = (id: string) => {
      const r = read?.[id]
      if (r === undefined) return '-'
      if (r.right) return `right ${r.p_right}`
      return `${r.choice === 'not_stated' ? 'not stated' : `wrong (${r.choice})`} ${r.p_not_stated}`
    }
    const line = asked.ok ? [...POSITIONS, 'bulk'].filter((id) => id in p.part.questions).map(cell).join(' / ') : `failed: ${asked.failure.kind}`
    console.log(`${p.name.padEnd(14)} ${String(asked.ok ? (asked.inputTokens ?? '-') : '-').padStart(9)} ${String(ms).padStart(6)}  ${line}`)
  }
}

if (!values['no-save']) {
  const result = {
    probe: 'state truncation (#17)',
    date: started.toISOString(),
    backends: Object.fromEntries(backends.map((name) => [name, { asked: name === 'clef' ? CLEF_MODEL : JEV_MODEL, answeredBy: models[name] ?? [] }])),
    design:
      'Three facts in recent_context (start, middle, end), each asked as a Choice with not_stated among the options; a ladder of state sizes (estimated tokens, as the mod counts them); ' +
      `one probe with a question of about 15k tokens as Clef counts them (${BULK_ENTRIES} catalog entries) beside a 1.2k state, whose right answer is its last option. ` +
      'facts_at: where each fact begins, in estimated tokens from the start of the state as sent.',
    probes: results,
  }
  const text = `${JSON.stringify(result, null, 2)}\n`
  if (secrets.some((secret) => secret !== '' && text.includes(secret))) fail('the results would hold a credential: not saved')
  const dir = join(RESULTS_DIR, 'probes')
  mkdirSync(dir, { recursive: true })
  const stem = `${started.toISOString().slice(0, 10)}-truncation`
  let file = join(dir, `${stem}.json`)
  for (let n = 2; existsSync(file); n++) file = join(dir, `${stem}-${n}.json`)
  writeFileSync(file, text)
  console.log(`\nsaved ${shown(file)}`)
}
