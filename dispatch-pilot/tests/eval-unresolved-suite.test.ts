// The `unresolved` suite (seam 2): what it asks of the backend for an item and
// how it scores the answers: the final effort always, the three-way question
// when the mod asks it (it does not yet: spec #36, ticket #37).

import { expect, test } from 'claude-code/testing'
import type { BackendIo } from '../hooks/decision/backend.ts'
import { estimateTokens } from '../hooks/decision/context.ts'
import { EFFORTS } from '../hooks/decision/effort.ts'
import { JEV_MODEL, jevBackend } from '../hooks/decision/jev.ts'
import type { Triage, UnresolvedItem } from '../eval/lib/datasets.ts'
import { summarize } from '../eval/lib/metrics.ts'
import { runSuite } from '../eval/lib/runner.ts'
import { settingsFrom } from '../eval/lib/suite.ts'
import { UNRESOLVED_VARIANTS, unresolved, unresolvedRequest, unresolvedSuite, type TriageAsk } from '../eval/lib/unresolved.ts'
import { jev, withoutUnresolved, world } from './support/world.ts'

/** A log long enough to overrun a 6000-token budget but not 24000: pasted output, ASCII, about 4 characters a token. */
const LOG = Array.from({ length: 700 }, (_, i) => `2026-10-05T10:${String(i % 60).padStart(2, '0')}:11Z worker-3 handler.ts:${100 + (i % 40)} retry ${i} of order-${i * 7} failed: ETIMEDOUT`).join('\n')

/** One HTTP reply of the fake network: a status and a JSON body. */
type Reply = { status: number; body: unknown }

/** A Jev answer to the effort question putting `p` on the levels (lowest first), and to any other question (a choice) the probabilities `triage`. */
function answers(body: any, p: readonly number[], triage?: Record<string, number>): Reply {
  const out: Record<string, unknown> = {}
  for (const [id, question] of Object.entries(body.questions as Record<string, { type: string }>)) {
    if (id === 'effort.level') {
      const probabilities = Object.fromEntries(EFFORTS.map((_, i) => [String(i), p[i] ?? 0]))
      out[id] = { type: 'score', probabilities, confidence: 0.5, score: 0 }
    } else out[id] = { type: question.type, probabilities: triage ?? {}, confidence: 0.5, choice: '' }
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

async function run(items: UnresolvedItem[], net: ReturnType<typeof network>, variants: string[], suite = unresolved) {
  return runSuite(suite, items, { backend: jevBackend('k'), io: net.io, now: net.now, pause: async () => {}, settings: settingsFrom({}), variants, timeoutMs: 10_000, retries: 0, concurrency: 1 })
}

test('the effort question is asked alone; its state has the 6000 tokens it had beside the skills question, and the wide variants the 24000 of its own request', async () => {
  // A backend that answers high without having seen the thread's first round, and max with it.
  const net = network((body) => answers(body, String(body.state.recent_context).includes('EARLY') ? MAX : HIGH))
  const rows = await run([overBudget('unresolved-001')], net, ['zh-score', 'zh-score-wide'])

  expect(rows.map((r) => `${r.variant} ${r.language}: ${r.shown}`)).toEqual(['zh-score zh: high', 'zh-score en: high', 'zh-score-wide zh: max', 'zh-score-wide en: max'])
  expect(net.bodies.every((body) => Object.keys(body.questions).join() === 'effort.level')).toBe(true)
  // Each request's state is the mod's own: the message, and the conversation within the budget.
  expect(Object.keys(net.bodies[0].state)).toEqual(['user_message', 'recent_context'])
  expect(estimateTokens(JSON.stringify(net.bodies[0].state))).toBeLessThanOrEqual(6000)
  expect(estimateTokens(JSON.stringify(net.bodies[2].state))).toBeGreaterThan(6000)
})

// The request of the wide variants is the mod's, the request the effort question has of its own since #38 (ADR 0005); the
// others are the state the effort question had when it shared its request with the skills (6000).
test("the eval's wide request for an item is the mod's request for that message after that conversation", { options: { typesafeApiKey: 'k' } }, async ($, on) => {
  const long = overBudget('unresolved-001')
  const messages = long.zh.recent_context.map((entry) => ({ role: entry.role, text: entry.text, toolUses: (entry.tools ?? []).map((tool, i) => ({ tool_use_id: `toolu_${i}`, tool, input: {}, text: '' })) }))
  const w = world($, on, { backend: jev([0, 0, 0.2, 0.7, 0.1]), messages })
  await w.submit(long.zh.message)

  const { request } = unresolvedRequest(long, 'zh', UNRESOLVED_VARIANTS['zh-score-wide'] as Parameters<typeof unresolvedRequest>[2], settingsFrom({ typesafeApiKey: 'k' }))
  expect(w.requests).toHaveLength(1)
  // The mod asks the unresolved question beside the effort question (`effort.unresolved`, same state); the suite asks it only given a `TriageAsk`.
  expect(withoutUnresolved(w.requests[0]?.body)).toEqual({ model: JEV_MODEL, state: request.state, questions: request.questions })
  // The state is what 24000 tokens hold, so the thread's first round is in it.
  expect(String(request.state.recent_context)).toContain('EARLY')
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
  const summary = summarize(unresolved, items, rows, { slowMs: 1500, settings: settingsFrom({}) })
  const breakdown = summary.variants[0]?.breakdown as any

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
  // The three-way question is not asked yet: nothing to report for it, and no row is graded on it.
  expect(breakdown.triage).toBeNull()
  expect(rows.every((r) => r.parts === null)).toBe(true)
  expect(summary.constants.map((c) => `${c.answer} ${c.accuracy}`)).toEqual(['low 0.3333', 'medium 0.3333', 'high 0', 'xhigh 0.6667', 'max 0.6667'])
})

/** The three-way question as a later ticket will write it: one choice, `which`, named for each answer. */
const TRIAGE_ASK: TriageAsk = {
  part: () => ({ part: 'unresolved', questions: { which: { type: 'choice', instructions: 'Is `user_message` about the same problem, still unresolved?', criteria: { unresolved: 'still', resolved: 'fixed', new: 'different' } } } }),
  read: (read) => {
    const answer = read.which
    if (answer?.type !== 'choice') return null
    const [best] = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])
    return best === undefined ? null : { triage: best[0] as Triage, probabilities: answer.probabilities }
  },
}

test('when the three-way question is asked it is scored on its own: the final effort stays the answer, the triage a part of it, with a confusion table', async () => {
  const items = [item('unresolved-001'), item('unresolved-002', (i) => ((i.gold = 'low'), (i.accept = ['low', 'medium']), (i.triage = 'resolved'))), item('unresolved-003', (i) => (i.triage = 'new'))]
  const net = network((body) => {
    const message = String(body.state.user_message)
    // 001 is read as unresolved (right), 002 as unresolved too (wrong: it is resolved), 003 as new (right).
    const triage = message.startsWith('unresolved-003') ? { unresolved: 0.1, resolved: 0.1, new: 0.8 } : { unresolved: 0.7, resolved: 0.2, new: 0.1 }
    return answers(body, MAX, triage)
  })
  const suite = unresolvedSuite(TRIAGE_ASK)
  const rows = await run(items, net, ['zh-score'], suite)
  const summary = summarize(suite, items, rows, { slowMs: 1500, settings: settingsFrom({}) })

  expect(net.bodies.every((body) => Object.keys(body.questions).join() === 'effort.level,unresolved.which')).toBe(true)
  expect(rows.filter((r) => r.language === 'zh').map((r) => `${r.id}: ${r.shown}, effort ${r.parts?.effort ? 'right' : 'wrong'}, triage ${r.parts?.triage ? 'right' : 'wrong'}`)).toEqual([
    'unresolved-001: max / unresolved, effort right, triage right',
    'unresolved-002: max / unresolved, effort wrong, triage wrong',
    'unresolved-003: max / new, effort right, triage right',
  ])
  const variant = summary.variants[0]
  expect(variant?.zh.parts).toEqual({ effort: 0.6667, triage: 0.6667 })
  expect((variant?.breakdown as any).triage).toEqual({
    accuracy: { zh: 0.6667, en: 0.6667 },
    // by what the item is (rows), and what the model said (columns), in each language
    confusion: {
      zh: { unresolved: { unresolved: 1 }, resolved: { unresolved: 1 }, new: { new: 1 } },
      en: { unresolved: { unresolved: 1 }, resolved: { unresolved: 1 }, new: { new: 1 } },
    },
  })
})
