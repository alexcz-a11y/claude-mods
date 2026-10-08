// The `unresolved` suite (seam 2): what it asks of the backend for an item and
// how it scores the answers: the final effort, and the three-way question the mod
// asks beside it (`effort.unresolved`: the same part, the same reading of its
// answer, mapped to the dataset's `triage` names). The suite's requests are
// the mod's: the parts, the state and its budget come from the same functions.

import { expect, test } from 'claude-code/testing'
import type { BackendIo } from '../hooks/decision/backend.ts'
import { estimateTokens } from '../hooks/decision/context.ts'
import { EFFORTS } from '../hooks/decision/effort.ts'
import { JEV_MODEL, jevBackend } from '../hooks/decision/jev.ts'
import { renderSummary, type Summary } from '../hooks/decision/summary.ts'
import type { UnresolvedItem } from '../eval/lib/datasets.ts'
import { summarize } from '../eval/lib/metrics.ts'
import { runSuite } from '../eval/lib/runner.ts'
import { settingsFrom } from '../eval/lib/suite.ts'
import { UNRESOLVED_VARIANTS, unresolved, unresolvedRequest } from '../eval/lib/unresolved.ts'
import { jev, world } from './support/world.ts'
/** The switch is off until the person turns it on (#48): these tests are about what the request is with it on. */
const UNRESOLVED_ON = { unresolved: true }

/** A log long enough to overrun a 6000-token budget but not 24000: pasted output, ASCII, about 4 characters a token. */
const LOG = Array.from({ length: 700 }, (_, i) => `2026-10-05T10:${String(i % 60).padStart(2, '0')}:11Z worker-3 handler.ts:${100 + (i % 40)} retry ${i} of order-${i * 7} failed: ETIMEDOUT`).join('\n')

/** One HTTP reply of the fake network: a status and a JSON body. */
type Reply = { status: number; body: unknown }

/** What the decision model leans to for the three-way question: the mod's own option names. */
const STILL = { still_unresolved: 0.7, resolved: 0.2, new_or_unrelated: 0.1 }
const SOLVED = { still_unresolved: 0.1, resolved: 0.8, new_or_unrelated: 0.1 }
const ELSEWHERE = { still_unresolved: 0.1, resolved: 0.1, new_or_unrelated: 0.8 }

/** A Jev answer to the effort question putting `p` on the levels (lowest first), and to the three-way question the probabilities `triage`. */
function answers(body: any, p: readonly number[], triage: Record<string, number> = STILL): Reply {
  const out: Record<string, unknown> = {}
  for (const [id, question] of Object.entries(body.questions as Record<string, { type: string }>)) {
    if (id === 'effort.level') {
      const probabilities = Object.fromEntries(EFFORTS.map((_, i) => [String(i), p[i] ?? 0]))
      out[id] = { type: 'score', probabilities, confidence: 0.5, score: 0 }
    } else out[id] = { type: question.type, probabilities: triage, confidence: 0.5, choice: '' }
  }
  return { status: 200, body: { model: 'jev-1.13.0', answers: out, usage: { input_tokens: 700 } } }
}

/** A fake network: `reply` answers each request. */
function network(reply: (body: any) => Reply) {
  const bodies: any[] = []
  let clock = 0
  const io: BackendIo = {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body))
      bodies.push(body)
      const { status, body: out } = reply(body)
      clock += 120
      return { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(out) }
    },
    sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))),
  }
  return { io, bodies, now: () => clock }
}

const HIGH = [0, 0.1, 0.6, 0.2, 0.1]
/** xhigh and max at 0.45 each: max at a thetaMax of 0.4, xhigh at 0.5. */
const NEAR_MAX = [0, 0, 0.1, 0.45, 0.45]
const MAX = [0, 0, 0.1, 0.2, 0.7]

/** An item from a thread that went round before: the first round is marked EARLY. */
function item(id: string, change: (item: UnresolvedItem) => void = () => {}): UnresolvedItem {
  const asked = (message: string): UnresolvedItem['zh'] => ({
    message,
    recent_context: [
      { role: 'user', text: 'EARLY first attempt: raise the timeout' },
      { role: 'assistant', text: 'Done.', tools: ['Edit'] },
      { role: 'user', text: 'still failing' },
      { role: 'assistant', text: 'Tried fake timers.', tools: ['Edit', 'Bash'] },
    ],
  })
  const result: UnresolvedItem = {
    id,
    zh: asked(`${id} 还是不行`),
    en: asked(`${id} still broken`),
    gold: 'max',
    accept: ['xhigh', 'max'],
    triage: 'unresolved',
    rationale: '理由',
    difficulty: 'hard',
    tags: [],
  }
  change(result)
  return result
}

/** The same thread with a last reply that overruns 6000 tokens but fits 24000: the first round falls outside the first budget only. */
function overBudget(id: string, change: (item: UnresolvedItem) => void = () => {}): UnresolvedItem {
  return item(id, (i) => {
    for (const language of ['zh', 'en'] as const) (i[language].recent_context[3] as { text: string }).text += `\n${LOG}`
    i.tags.push('over-budget')
    change(i)
  })
}

/** An item's conversation as the engine's transcript holds it (what `$.session.messages()` hands the mod). */
function transcript(entries: UnresolvedItem['zh']['recent_context']) {
  return entries.map((entry) => ({ role: entry.role, text: entry.text, toolUses: (entry.tools ?? []).map((tool, i) => ({ tool_use_id: `toolu_${i}`, tool, input: {}, text: '' })) }))
}

async function run(items: UnresolvedItem[], net: ReturnType<typeof network>, variants: string[], suite = unresolved) {
  return runSuite(suite, items, { backend: jevBackend('k'), io: net.io, now: net.now, pause: async () => {}, settings: settingsFrom({ decisionModel: 'jev' }), variants, timeoutMs: 10_000, retries: 0, concurrency: 1 })
}

test('the effort question is asked with the three-way question beside it; its state has the 6000 tokens it had beside the skills question, and the wide variants the 24000 of its own request', async () => {
  // A backend that answers high without having seen the thread's first round, and max with it.
  const net = network((body) => answers(body, String(body.state.recent_context).includes('EARLY') ? MAX : HIGH))
  const rows = await run([overBudget('unresolved-001')], net, ['zh-score', 'zh-score-wide'])

  expect(rows.map((r) => `${r.variant} ${r.language}: ${r.shown}`)).toEqual(['zh-score zh: high / unresolved', 'zh-score en: high / unresolved', 'zh-score-wide zh: max / unresolved', 'zh-score-wide en: max / unresolved'])
  expect(net.bodies.every((body) => Object.keys(body.questions).join() === 'effort.level,effort.unresolved')).toBe(true)
  // Each request's state is the mod's own: the message, and the conversation within the budget.
  expect(Object.keys(net.bodies[0].state)).toEqual(['user_message', 'recent_context'])
  expect(estimateTokens(JSON.stringify(net.bodies[0].state))).toBeLessThanOrEqual(6000)
  expect(estimateTokens(JSON.stringify(net.bodies[2].state))).toBeGreaterThan(6000)
})

// The request of the wide variants is the mod's, the request the effort question has of its own since #38 (ADR 0005); the
// others are the state the effort question had when it shared its request with the skills (6000).
test("the eval's wide request for an item is the mod's request for that message after that conversation: the same questions, the same state", { options: { decisionModel: 'jev', typesafeApiKey: 'k' } }, async ($, on) => {
  const long = overBudget('unresolved-001')
  const w = world($, on, { switches: UNRESOLVED_ON, backend: jev([0, 0, 0.2, 0.7, 0.1]), messages: transcript(long.zh.recent_context) })
  await w.submit(long.zh.message)

  const { request } = unresolvedRequest(long, 'zh', UNRESOLVED_VARIANTS['zh-score-wide'] as Parameters<typeof unresolvedRequest>[2], settingsFrom({ decisionModel: 'jev', typesafeApiKey: 'k' }))
  expect(w.requests).toHaveLength(1)
  expect(w.requests[0]?.body).toEqual({ model: JEV_MODEL, state: request.state, questions: request.questions })
  // The state is what 24000 tokens hold, so the thread's first round is in it.
  expect(String(request.state.recent_context)).toContain('EARLY')
})

const SUMMARY: Summary = { problem: '服务启动后立刻退出', tried: [{ text: '把超时调到 30 秒', unresolved: true }, { text: '换成 fake timers' }], status: '助手在等日志' }

test("given a summary the eval's request carries it as the mod's does, in the effort request's state beside the message and the conversation", { options: { decisionModel: 'jev', typesafeApiKey: 'k' } }, async ($, on) => {
  const long = overBudget('unresolved-001')
  const w = world($, on, { switches: UNRESOLVED_ON, backend: jev([0, 0, 0.2, 0.7, 0.1]), messages: transcript(long.zh.recent_context), seed: { unresolved: { count: 1, summary: { ...SUMMARY, turn: 't1' } } } })
  await w.submit(long.zh.message)

  const { request } = unresolvedRequest(long, 'zh', UNRESOLVED_VARIANTS['zh-score-wide'] as Parameters<typeof unresolvedRequest>[2], settingsFrom({ decisionModel: 'jev', typesafeApiKey: 'k' }), SUMMARY, { count: 1, maxAfter: 3 })
  expect(request.state.problem_summary).toBe(renderSummary(SUMMARY, 'zh'))
  expect(w.requests[0]?.body).toEqual({ model: JEV_MODEL, state: request.state, questions: request.questions })
  // None given (the dataset holds none): no field.
  expect('problem_summary' in unresolvedRequest(long, 'zh', UNRESOLVED_VARIANTS['zh-score-wide'] as Parameters<typeof unresolvedRequest>[2], settingsFrom({ decisionModel: 'jev', typesafeApiKey: 'k' })).request.state).toBe(false)
})

test("given a count the eval's request carries it and the hint as the mod's does (the same function, so the same request): the hint from the setting's count on", { options: { decisionModel: 'jev', typesafeApiKey: 'k' } }, async ($, on) => {
  const long = overBudget('unresolved-001')
  const unsure = { still_unresolved: 0.3, resolved: 0.4, new_or_unrelated: 0.3 }
  const w = world($, on, { switches: UNRESOLVED_ON, backend: (request) => jev([0, 0, 0.2, 0.7, 0.1], { shares: { 'effort.unresolved': unsure } })(request), messages: transcript(long.zh.recent_context), seed: { unresolved: { count: 3, summary: { ...SUMMARY, turn: 't1' } } } })
  await w.submit(long.zh.message)

  const variant = UNRESOLVED_VARIANTS['zh-score-wide'] as Parameters<typeof unresolvedRequest>[2]
  const settings = settingsFrom({ decisionModel: 'jev', typesafeApiKey: 'k' })
  const { request } = unresolvedRequest(long, 'zh', variant, settings, SUMMARY, { count: 3, maxAfter: 3 })
  expect(request.state.unresolved_count).toBe(3)
  expect(w.requests[0]?.body).toEqual({ model: JEV_MODEL, state: request.state, questions: request.questions })
  // Below the setting the count goes and the hint does not.
  const below = unresolvedRequest(long, 'zh', variant, settings, SUMMARY, { count: 2, maxAfter: 3 }).request
  expect(below.state.unresolved_count).toBe(2)
  expect(JSON.stringify(below.questions)).not.toContain('unresolved_count')
  expect(JSON.stringify(request.questions)).toContain('unresolved_count')
})

test("a command turn is asked as the mod asks it: the command as typed, and what it is for in the state's command field", async () => {
  const net = network((body) => answers(body, HIGH))
  const turn = item('unresolved-001', (i) => {
    i.zh = { ...i.zh, message: '/debug 订单超时', command: { name: 'debug', description: '系统地排查一个故障' } }
    i.en = { ...i.en, message: '/debug order timeout', command: { name: 'debug', description: 'Investigate a fault systematically' } }
  })
  await run([turn], net, ['en-score'])

  expect(net.bodies.map((body) => body.state.user_message)).toEqual(['/debug 订单超时', '/debug order timeout'])
  expect(net.bodies.map((body) => body.state.command)).toEqual([
    { name: 'debug', description: '系统地排查一个故障' },
    { name: 'debug', description: 'Investigate a fault systematically' },
  ])
})

test('the summary reports the recall of the top level, answers too high and too low, how long conversations do beside short ones, and what each thetaMax would have given', async () => {
  const items = [
    overBudget('unresolved-001'), // long: the answer does not see the first round, and is close to max
    item('unresolved-002'), // short: max
    item('unresolved-003', (i) => ((i.gold = 'low'), (i.accept = ['low', 'medium']), (i.triage = 'resolved'))), // answered xhigh: too high
  ]
  const net = network((body) => {
    const message = String(body.state.user_message)
    return answers(body, message.startsWith('unresolved-001') ? NEAR_MAX : message.startsWith('unresolved-002') ? MAX : [0, 0, 0.2, 0.7, 0.1])
  })
  const rows = await run(items, net, ['zh-score'])
  const summary = summarize(unresolved, items, rows, { slowMs: 1500, settings: settingsFrom({ decisionModel: 'jev' }) })
  const breakdown = summary.variants[0]?.breakdown as any

  // The effort is the answer: two of the three are right, whatever the three-way question made of them.
  expect(summary.variants[0]?.zh.accuracy).toBe(0.6667)
  // 001 is answered xhigh at the mod's thetaMax (0.5): right, but not the top level.
  expect(breakdown.top).toEqual({ items: 2, recall: { zh: 0.5, en: 0.5 } })
  expect(breakdown.tooHigh).toEqual({ zh: 0.3333, en: 0.3333 })
  expect(breakdown.tooLow).toEqual({ zh: 0, en: 0 })
  expect(breakdown.byLength).toEqual({
    'over-budget': { items: 1, accuracy: { zh: 1, en: 1 }, topRecall: { zh: 0, en: 0 } },
    fits: { items: 2, accuracy: { zh: 0.5, en: 0.5 }, topRecall: { zh: 1, en: 1 } },
  })
  const swept = (theta: number) => breakdown.thetaMax.find((row: any) => row.thetaMax === theta)
  expect(swept(0.5)).toEqual({ thetaMax: 0.5, topRecall: { zh: 0.5, en: 0.5 }, topWrong: { zh: 0, en: 0 } })
  expect(swept(0.4)).toEqual({ thetaMax: 0.4, topRecall: { zh: 1, en: 1 }, topWrong: { zh: 0, en: 0 } })
  expect(summary.constants.map((c) => `${c.answer} ${c.accuracy}`)).toEqual(['low 0.3333', 'medium 0.3333', 'high 0', 'xhigh 0.6667', 'max 0.6667'])
})

test('the three-way question is scored on its own, the final effort stays the answer and the triage a part of it: accuracy, a confusion table, and what the two bars would have done to the count', async () => {
  const items = [item('unresolved-001'), item('unresolved-002', (i) => ((i.gold = 'low'), (i.accept = ['low', 'medium']), (i.triage = 'resolved'))), item('unresolved-003', (i) => (i.triage = 'new'))]
  const net = network((body) => {
    const message = String(body.state.user_message)
    // 001 is read as unresolved (right), 002 as unresolved too (wrong: it is resolved), 003 as another problem (right).
    return answers(body, MAX, message.startsWith('unresolved-003') ? ELSEWHERE : STILL)
  })
  const rows = await run(items, net, ['zh-score'])
  const summary = summarize(unresolved, items, rows, { slowMs: 1500, settings: settingsFrom({ decisionModel: 'jev' }) })

  expect(rows.filter((r) => r.language === 'zh').map((r) => `${r.id}: ${r.shown}, effort ${r.parts?.effort ? 'right' : 'wrong'}, triage ${r.parts?.triage ? 'right' : 'wrong'}`)).toEqual([
    'unresolved-001: max / unresolved, effort right, triage right',
    'unresolved-002: max / unresolved, effort wrong, triage wrong',
    'unresolved-003: max / new, effort right, triage right',
  ])
  const variant = summary.variants[0]
  expect(variant?.zh.parts).toEqual({ effort: 0.6667, triage: 0.6667 })
  const triage = (variant?.breakdown as any).triage
  expect(triage.accuracy).toEqual({ zh: 0.6667, en: 0.6667 })
  // by what the item is (rows), and what the model said (columns), in each language
  expect(triage.confusion).toEqual({
    zh: { unresolved: { unresolved: 1 }, resolved: { unresolved: 1 }, new: { new: 1 } },
    en: { unresolved: { unresolved: 1 }, resolved: { unresolved: 1 }, new: { new: 1 } },
  })
  // At the mod's bars: 001 and 002 are added to the count (002 wrongly: a count too high), 003 clears it; no record of an unresolved problem is lost.
  expect(triage.change).toEqual({ right: { zh: 0.6667, en: 0.6667 }, falseAdd: { zh: 0.5, en: 0.5 }, lostRecord: { zh: 0, en: 0 } })
  expect(rows.find((r) => r.id === 'unresolved-002' && r.language === 'zh')?.detail?.triageChange).toBe('add')
})

test('an answer that is no reading of the three-way question is a failed item, not a guess: the item says so', async () => {
  const net = network((body) => answers(body, MAX, {}))
  const rows = await run([item('unresolved-001')], net, ['zh-score'])
  expect(rows.map((r) => r.failure)).toEqual(['parse: no triage answer', 'parse: no triage answer'])
})

test('when the person says it is still unresolved at 0.62, the mod adds one and the eval reads the same answer as unresolved; the mod\'s option names are the dataset\'s triage names', async () => {
  const cases = [
    [{ still_unresolved: 0.62, resolved: 0.08, new_or_unrelated: 0.3 }, 'unresolved', 'add'],
    [SOLVED, 'resolved', 'reset'],
    [ELSEWHERE, 'new', 'reset'],
    [{ still_unresolved: 0.3, resolved: 0.4, new_or_unrelated: 0.3 }, 'resolved', 'keep'],
  ] as const
  const items = cases.map(([, triage], i) => item(`unresolved-00${i + 1}`, (one) => (one.triage = triage)))
  const net = network((body) => {
    const index = Number(String(body.state.user_message).match(/unresolved-00(\d)/)?.[1]) - 1
    return answers(body, MAX, cases[index]?.[0])
  })
  const rows = await run(items, net, ['zh-score'])
  expect(rows.filter((r) => r.language === 'zh').map((r) => [r.shown, r.detail?.triageChange])).toEqual(cases.map(([, triage, change]) => [`max / ${triage}`, change]))
})
