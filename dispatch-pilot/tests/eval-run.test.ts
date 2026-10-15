// Running a suite (seam 2's runner): every item asked in both languages under
// each variant, through a backend the way the mod asks it, each answer
// graded against the item's accept set. The backend here is Jev's own client
// (jevBackend) over a fake network, so only the network is pretend.

import { expect, test } from 'claude-code/testing'
import type { BackendIo } from '../hooks/decision/backend.ts'
import { EFFORTS } from '../hooks/decision/effort.ts'
import { jevBackend } from '../hooks/decision/jev.ts'
import type { EffortSubmitItem } from '../eval/lib/datasets.ts'
import { effortSubmit } from '../eval/lib/effort-submit.ts'
import { readNumber } from '../eval/lib/numbers.ts'
import { askRetrying, attemptMs, byRepeat, RETRY_AFTER_MAX_MS, runSuite } from '../eval/lib/runner.ts'
import { optionsFor, optionsFrom, settingsFrom, withStateTokens } from '../eval/lib/suite.ts'
import { estimateTokens } from '../hooks/decision/context.ts'
import { pplxBackend } from '../hooks/decision/pplx.ts'
import type { DecisionRequest } from '../hooks/decision/system-one.ts'
import type { UnresolvedItem } from '../eval/lib/datasets.ts'
import { UNRESOLVED_VARIANTS, unresolvedRequest } from '../eval/lib/unresolved.ts'

function item(id: string, message: string, gold: EffortSubmitItem['gold'], accept: EffortSubmitItem['accept'], tags: string[] = []): EffortSubmitItem {
  return {
    id,
    zh: { message: `${message}（中文）`, recent_context: [] },
    en: { message: `${message} (English)`, recent_context: [] },
    gold,
    accept,
    rationale: '理由',
    difficulty: 'hard',
    tags,
  }
}

/** One HTTP reply of the fake network: a status and a JSON body. */
type Reply = { status: number; body: unknown }

/** A Jev answer putting `p` on the levels, lowest first, for whichever primitive the request asked with. */
function answer(body: any, p: readonly number[]): Reply {
  const [id, question] = Object.entries(body.questions as Record<string, { type: string }>)[0] as [string, { type: string }]
  const probabilities = Object.fromEntries(EFFORTS.map((level, i) => [question.type === 'score' ? String(i) : level, p[i] ?? 0]))
  return { status: 200, body: { model: 'jev-1.13.0', answers: { [id]: { type: question.type, probabilities, confidence: 0.5, score: 0, choice: '' } }, usage: { input_tokens: 700 } } }
}

/** A fake network: `reply` answers each request; every reply takes 120 ms of the fake clock; the runner's pauses are recorded. */
function network(reply: (body: any, n: number) => Reply) {
  let clock = 0
  const bodies: any[] = []
  const pauses: number[] = []
  const pause = async (ms: number) => {
    pauses.push(ms)
  }
  const io: BackendIo = {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body))
      bodies.push(body)
      const { status, body: out } = reply(body, bodies.length)
      clock += 120
      return { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(out) }
    },
    // The backend's own timeout timer: never fires here; it is aborted once the answer is in.
    sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))),
  }
  return { io, bodies, pauses, pause, now: () => clock }
}

const HIGH = [0, 0.1, 0.6, 0.2, 0.1]
const XHIGH = [0, 0, 0.3, 0.6, 0.1]
const MEDIUM = [0.1, 0.6, 0.2, 0.1, 0]
const LOW = [0.7, 0.2, 0.1, 0, 0]

test('each item is asked in both languages under each variant, as the mod asks it, and graded against its accept set', async () => {
  const items = [item('a', '把登录拆成三层', 'high', ['high', 'xhigh']), item('b', '改个错别字', 'low', ['low'])]
  const net = network((body) => {
    const message = String(body.state.user_message)
    if (message.startsWith('把登录')) return answer(body, message.endsWith('（中文）') ? XHIGH : HIGH)
    return answer(body, message.endsWith('（中文）') ? MEDIUM : LOW)
  })

  const rows = await runSuite(effortSubmit, items, {
    backend: jevBackend('k'),
    io: net.io,
    now: net.now,
    pause: net.pause,
    settings: settingsFrom({ decisionModel: 'jev' }),
    variants: ['en-score', 'zh-choice'],
    timeoutMs: 10_000,
    retries: 2,
    concurrency: 3,
  })

  expect(rows.map((r) => `${r.id} ${r.variant} ${r.language}: ${r.shown} ${r.correct ? 'right' : `wrong (${r.miss})`}${r.exact ? ', gold' : ''}`)).toEqual([
    'a en-score zh: xhigh right',
    'a en-score en: high right, gold',
    'a zh-choice zh: xhigh right',
    'a zh-choice en: high right, gold',
    'b en-score zh: medium wrong (over)',
    'b en-score en: low right, gold',
    'b zh-choice zh: medium wrong (over)',
    'b zh-choice en: low right, gold',
  ])
  // What each answer records: the reading (for calibrating thresholds later), who answered, at what cost.
  expect(rows[0]).toMatchObject({ ok: true, attempts: 1, inputTokens: 700, model: 'jev-1.13.0', failure: null })
  expect(rows[0]?.detail).toEqual({ p: [0, 0, 0.3, 0.6, 0.1], confidence: 0.5 })
  expect(rows[0]?.state).toEqual({ user_message: '把登录拆成三层（中文）', recent_context: '' })
  // The variant decides how the question is written; the person's words go as they are.
  const asked = net.bodies.filter((b) => b.state.user_message === '把登录拆成三层 (English)')
  expect(asked.map((b) => b.questions['effort.level'].type).sort()).toEqual(['choice', 'score'])
  const choice = asked.find((b) => b.questions['effort.level'].type === 'choice')
  expect(JSON.stringify(choice.questions)).toContain('逐步推理')
  expect(Object.keys(choice.questions['effort.level'].criteria)).toEqual([...EFFORTS])
})

test('a busy backend is asked again after a pause; a refused key is not; an unanswered item counts as wrong and says why', async () => {
  const items = [item('a', '把登录拆成三层', 'high', ['high', 'xhigh']), item('b', '改个错别字', 'low', ['low'])]
  const net = network((body, n) => {
    if (String(body.state.user_message).startsWith('改个')) return { status: 401, body: { detail: 'bad key' } }
    return n === 1 ? { status: 529, body: { detail: 'overloaded' } } : answer(body, HIGH)
  })

  const rows = await runSuite(effortSubmit, items, {
    backend: jevBackend('k'),
    io: net.io,
    now: net.now,
    pause: net.pause,
    settings: settingsFrom({ decisionModel: 'jev' }),
    variants: ['en-score'],
    languages: ['zh'],
    timeoutMs: 10_000,
    retries: 2,
    concurrency: 1,
  })

  // Only the answered attempt's time is its latency (each reply takes 120 ms here).
  expect(rows[0]).toMatchObject({ id: 'a', ok: true, shown: 'high', correct: true, attempts: 2, ms: 120 })
  expect(rows[1]).toMatchObject({ id: 'b', ok: false, shown: null, correct: false, exact: false, attempts: 1, ms: null })
  expect(rows[1]?.failure).toMatch(/^config: HTTP 401/)
  // One pause of a second before the second attempt.
  expect(net.pauses).toEqual([1000])
})

test('--repeat asks every item again as many times as told, each time a row of its own that says which time it was; without it the rows carry no repeat', async () => {
  const items = [item('a', '把登录拆成三层', 'high', ['high', 'xhigh'])]
  // The backend answers differently each time it is asked, so that the rows can be told apart.
  const net = network((body, n) => answer(body, n === 2 ? XHIGH : HIGH))
  const options = { backend: jevBackend('k'), io: net.io, now: net.now, pause: net.pause, settings: settingsFrom({ decisionModel: 'jev' }), variants: ['en-score'], languages: ['zh'] as const, timeoutMs: 10_000, retries: 0, concurrency: 1 }

  const once = await runSuite(effortSubmit, items, options)
  expect(once.length).toBe(1)
  expect('repeat' in (once[0] as object)).toBe(false)

  // The second request the backend sees (the first of the repeats) is the one answered XHIGH.
  const rows = await runSuite(effortSubmit, items, { ...options, repeats: 3 })
  expect(rows.map((r) => `${r.id} #${r.repeat}: ${r.shown}`)).toEqual(['a #1: xhigh', 'a #2: high', 'a #3: high'])
  expect(net.bodies.length).toBe(4)

  // The rows of one time, for a summary of its own: the rows without a repeat are one time.
  expect(byRepeat(rows).map((group) => group.map((r) => r.repeat))).toEqual([[1], [2], [3]])
  expect(byRepeat(once).length).toBe(1)
  expect(byRepeat([]).length).toBe(0)
})

test('a repeat count that is not a whole number of 1 or more is refused before anything is asked', async () => {
  const net = network((body) => answer(body, HIGH))
  const options = { backend: jevBackend('k'), io: net.io, now: net.now, pause: net.pause, settings: settingsFrom({ decisionModel: 'jev' }), variants: ['en-score'], timeoutMs: 10_000, retries: 0, concurrency: 1 }
  for (const repeats of [0, -1, 1.5, Number.NaN]) {
    await expect(runSuite(effortSubmit, [item('a', 'x', 'low', ['low'])], { ...options, repeats })).rejects.toThrow(/repeats/)
  }
  expect(net.bodies.length).toBe(0)
})

// The options a run asks with: what the engine hands the mod (the manifest's
// defaults), then each `--option name=value`, read by the type the manifest
// gives the option.
const USER_CONFIG = {
  contextTokens: { type: 'number', default: 2000 },
  agentFable: { type: 'boolean', default: false },
  workflowMode: { type: 'string', default: 'rewrite' },
  skillsNeverSuggested: { type: 'string', multiple: true, default: [] },
}

test('a run reads each --option by the type the manifest gives it: a number, true or false, or the text; the rest keep their defaults', () => {
  const options = optionsFrom(USER_CONFIG, ['agentFable=true', 'contextTokens=4000', 'skillsNeverSuggested=tdd,pdf'])
  expect(options).toEqual({ contextTokens: 4000, agentFable: true, workflowMode: 'rewrite', skillsNeverSuggested: 'tdd,pdf' })
  // Read as the mod reads them: fable offered, the two skills never suggested.
  const settings = settingsFrom(options)
  expect(settings.agents.models).toContain('fable')
  expect(settings.skills.neverSuggested).toEqual(['tdd', 'pdf'])
  expect(optionsFrom(USER_CONFIG, ['agentFable=false']).agentFable).toBe(false)
})

test('an --option the manifest does not have, or a value its type cannot take, is refused with the reason', () => {
  expect(() => optionsFrom(USER_CONFIG, ['contextToken=4000'])).toThrow('no option "contextToken" in the manifest')
  expect(() => optionsFrom(USER_CONFIG, ['agentFable=yes'])).toThrow('agentFable takes true or false, not "yes"')
  expect(() => optionsFrom(USER_CONFIG, ['contextTokens=lots'])).toThrow('contextTokens takes a number, not "lots"')
  expect(() => optionsFrom(USER_CONFIG, ['contextTokens'])).toThrow('--option takes name=value, not contextTokens')
})

// Perplexity's decision model is one of the mod's choices (`decisionModel: pplx`, #50), so a run on it reads the mod's own
// settings for it, pplx's row of the table, not Jev's: the eval and the mod ask the same.
test("a run on Perplexity asks with pplx's own settings: the budgets, the timeout, the thresholds and the question language", () => {
  const userConfig = {}
  const pplx = settingsFrom(optionsFor('pplx', userConfig))
  const jevSettings = settingsFrom(optionsFor('jev', userConfig))
  expect([pplx.backend, pplx.timeoutMs, pplx.context, pplx.contextByKind, pplx.ask]).toEqual([
    'pplx',
    8000,
    { messages: 2000, tokens: 6000 },
    { messagePlain: 48000, rejudge: 48000, agent: 32000, workflow: 48000 },
    { turnStart: { language: 'en', primitive: 'score' }, other: { language: 'en', primitive: 'score' } },
  ])
  expect([pplx.thetaMax, pplx.roundUp, pplx.midturn.rules.thetaUp, pplx.midturn.waitMs, pplx.skills.findWaitMs]).toEqual([0.47, 0.45, 0, 6000, 6000])
  expect([jevSettings.backend, jevSettings.timeoutMs, jevSettings.thetaMax, jevSettings.roundUp, jevSettings.ask.turnStart.language]).toEqual(['jev', 1500, 0.5, 0.3, 'zh'])
})

// A run can widen the state's budget past what any decision model of the mod has (`--state-tokens`), to see whether a
// model with a bigger window gains from a longer conversation (#43: Perplexity's takes 262144 tokens a request).
test('--state-tokens sets the budget of every kind of request, so a long conversation is cut at the run\'s budget and not at the mod\'s', () => {
  const long = (words: number) => Array.from({ length: words }, (_, i) => `w${i}`).join(' ')
  const recent = Array.from({ length: 24 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `${i}: ${long(2500)}` }))
  const item = { id: 'x', en: { message: 'still broken', recent_context: recent }, zh: { message: '还是不行', recent_context: recent } } as unknown as UnresolvedItem
  const variant = UNRESOLVED_VARIANTS['en-score-wide'] as (typeof UNRESOLVED_VARIANTS)[string]
  const settings = settingsFrom(optionsFor('jev', {}))
  const tokensOf = (s: typeof settings) => estimateTokens(JSON.stringify(unresolvedRequest(item, 'en', variant, s).request.state))

  expect(tokensOf(settings)).toBeLessThanOrEqual(24_000)
  const wider = withStateTokens(settings, 48_000)
  expect(tokensOf(wider)).toBeGreaterThan(30_000)
  expect(tokensOf(wider)).toBeLessThanOrEqual(48_000)
  // Every kind of request, not only a message's: the mid-turn re-decision, the dispatched agent, the Workflow's agents.
  expect([wider.context.tokens, wider.contextByKind, wider.midturn.limits.tokens]).toEqual([48_000, { messagePlain: 48_000, rejudge: 48_000, agent: 48_000, workflow: 48_000 }, 48_000])
  // The rest of the settings stay as they were.
  expect({ ...wider, context: settings.context, contextByKind: settings.contextByKind, midturn: settings.midturn }).toEqual(settings)
})

// How long the eval (and scripts/decide*.ts) gives one attempt unless told: four times the mod's timeoutMs, at least
// 10 s, so a slow answer is still measured and a cold connection's first request does not fail outright.
test("an attempt may take four times the mod's timeoutMs, at least 10 s: Jev's 1500 ms gives 10 s, 3000 ms 12 s", () => {
  expect([attemptMs(settingsFrom({ decisionModel: 'jev' }).timeoutMs), attemptMs(3000), attemptMs(5000)]).toEqual([10_000, 12_000, 20_000])
})

// run.ts reads its numbers with `readNumber`: a typo must stop the run before anything is sent, not turn into NaN (a spend
// cap that `estimatedUsd > NaN` never reaches, retries that `attempt > NaN` never ends, a timeout that fires at once).
test('a number flag takes a finite number within its bound; anything else is refused with the flag and what was written', () => {
  expect(readNumber('--max-usd', '1', { min: 0 })).toBe(1)
  expect(readNumber('--max-usd', '0.25', { min: 0 })).toBe(0.25)
  expect(readNumber('--retries', '0', { min: 0, integer: true })).toBe(0)
  expect(readNumber('--timeout', '240000', { min: 1, integer: true })).toBe(240_000)
  expect(() => readNumber('--max-usd', '1o', { min: 0 })).toThrow('--max-usd takes a number of at least 0, not "1o"')
  expect(() => readNumber('--max-usd', '', { min: 0 })).toThrow('--max-usd takes a number of at least 0, not ""')
  expect(() => readNumber('--max-usd', 'Infinity', { min: 0 })).toThrow('--max-usd takes a number')
  expect(() => readNumber('--max-usd', '-1', { min: 0 })).toThrow('--max-usd takes a number of at least 0, not "-1"')
  expect(() => readNumber('--retries', 'two', { min: 0, integer: true })).toThrow('--retries takes a whole number of at least 0, not "two"')
  expect(() => readNumber('--retries', '1.5', { min: 0, integer: true })).toThrow('--retries takes a whole number of at least 0, not "1.5"')
  expect(() => readNumber('--concurrency', '0', { min: 1, integer: true })).toThrow('--concurrency takes a whole number of at least 1, not "0"')
  expect(() => readNumber('--state-tokens', '99', { min: 100, integer: true })).toThrow('--state-tokens takes a whole number of at least 100, not "99"')
})

// Perplexity's quickstart: "A request over a limit returns 429 with a Retry-After header in seconds. Wait that long, then retry."
// pplx.ts reads the header into `Failure.retryAfterMs`; the eval's backoff of 1 s and 2 s would ask again inside the window.
const DECISION: DecisionRequest = { state: { user_message: 'x' }, questions: { 'review.defect': { type: 'noul', instructions: 'Does the review report a defect?' } } }

/** A fake Perplexity network: the replies in turn, the last one repeated; the runner's pauses are recorded. */
function pplxNetwork(replies: readonly { status: number; headers?: Record<string, string>; body?: unknown }[]) {
  let n = 0
  const pauses: number[] = []
  const io: BackendIo = {
    fetch: async () => {
      const reply = replies[Math.min(n++, replies.length - 1)] as (typeof replies)[number]
      return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: reply.headers ?? {}, text: JSON.stringify(reply.body ?? {}) }
    },
    sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))),
  }
  const retrying = { backend: pplxBackend('k'), io, timeoutMs: 10_000, retries: 3, now: () => 0, pause: async (ms: number) => void pauses.push(ms) }
  return { retrying, pauses }
}
const ANSWERED = { status: 200, body: { model: 'pplx-decider-v1.1-27b', answers: { 'review.defect': { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 5, output_tokens: 1 } } }

test('a 429 with Retry-After is waited out as long as the header says before the request is asked again, not the 1 s, 2 s of the backoff', async () => {
  const net = pplxNetwork([{ status: 429, headers: { 'Retry-After': '5' } }, { status: 429, headers: { 'retry-after': '7' } }, ANSWERED])
  const sent = await askRetrying(DECISION, net.retrying)
  expect(sent.asked.ok).toBe(true)
  expect(sent.attempts).toBe(3)
  expect(net.pauses).toEqual([5000, 7000])
})

test('a Retry-After longer than the eval will wait is cut to the most; a 429 without one, or a busy 5xx, keeps the backoff of 1 s, then 2 s', async () => {
  const long = pplxNetwork([{ status: 429, headers: { 'retry-after': '3600' } }, ANSWERED])
  await askRetrying(DECISION, long.retrying)
  expect(long.pauses).toEqual([RETRY_AFTER_MAX_MS])

  const none = pplxNetwork([{ status: 429 }, { status: 503 }, ANSWERED])
  const sent = await askRetrying(DECISION, none.retrying)
  expect(sent.attempts).toBe(3)
  expect(none.pauses).toEqual([1000, 2000])
})
