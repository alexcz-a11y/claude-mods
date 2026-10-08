// The `long-context` suite (seam 2): what it asks of the backend for an item in each version and with the summary and the
// count of a real flow, and how it scores the answers. Its requests are the mod's: the parts, the state and its budget
// come from the same functions, and the budget and the number of messages the state may hold are what the run sets (#44).

import { expect, test } from 'claude-code/testing'
import type { BackendIo } from '../hooks/decision/backend.ts'
import { estimateTokens } from '../hooks/decision/context.ts'
import { EFFORTS } from '../hooks/decision/effort.ts'
import { JEV_MODEL, jevBackend } from '../hooks/decision/jev.ts'
import { renderSummary, type Summary } from '../hooks/decision/summary.ts'
import { turnStartPart } from '../hooks/decision/turn-start.ts'
import type { LongContextItem } from '../eval/lib/datasets.ts'
import { conversationOf, fingerprint } from '../eval/lib/long-conversation.ts'
import { LONG_CONTEXT_VARIANTS, longContextSuite, type SummaryFile } from '../eval/lib/long-context.ts'
import { summarize } from '../eval/lib/metrics.ts'
import { runSuite, stateDigest } from '../eval/lib/runner.ts'
import { settingsFrom, withStateMessages, withStateTokens } from '../eval/lib/suite.ts'
import { jev, world } from './support/world.ts'
/** The switch is off until the person turns it on (#48): these tests are about what the request is with it on. */
const UNRESOLVED_ON = { unresolved: true }

type Reply = { status: number; body: unknown }

const STILL = { still_unresolved: 0.7, resolved: 0.2, new_or_unrelated: 0.1 }

/** A Jev answer to the effort question putting `p` on the levels (lowest first), and to the three-way question `STILL`. */
function answers(body: any, p: readonly number[]): Reply {
  const out: Record<string, unknown> = {}
  for (const [id, question] of Object.entries(body.questions as Record<string, { type: string }>)) {
    if (id === 'effort.level') out[id] = { type: 'score', probabilities: Object.fromEntries(EFFORTS.map((_, i) => [String(i), p[i] ?? 0])), confidence: 0.5, score: 0 }
    else out[id] = { type: question.type, probabilities: STILL, confidence: 0.5, choice: '' }
  }
  return { status: 200, body: { model: 'jev-1.13.0', answers: out, usage: { input_tokens: 700 } } }
}

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

/** The questions of the request the mod sends (the part's, under the part's name). */
function asked(input: { count?: number; maxAfter?: number }): Record<string, unknown> {
  const questions = turnStartPart({ ask: { language: 'zh', primitive: 'score' }, unresolved: true, ...input }).questions
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [`effort.${id}`, question]))
}

const HIGH = [0, 0.1, 0.6, 0.2, 0.1]
const MAX = [0, 0, 0.1, 0.2, 0.7]

/** A backend that gives high without having seen the decisive rounds, and max with them. */
function reader() {
  return network((body) => answers(body, String(body.state.recent_context).includes('DECISIVE-START') ? MAX : HIGH))
}

/** An item of the dataset: three decisive rounds (two of the person saying it did not work), a message, a depth. */
function item(id: string, change: (item: LongContextItem) => void = () => {}): LongContextItem {
  const result: LongContextItem = {
    id,
    zh: {
      message: `${id} 回到重连那个问题，我又试了一次`,
      decisive: [
        { role: 'user', text: `DECISIVE-START ${id} 重连在弱网下一直掉线，帮我修一下`, says: 'new' },
        { role: 'assistant', text: '把退避的上限调到 30 秒。', tools: ['Read', 'Edit'] },
        { role: 'user', text: '还是掉线', says: 'unresolved' },
        { role: 'assistant', text: '给心跳加了抖动。', tools: ['Edit'] },
        { role: 'user', text: '还是掉线', says: 'unresolved' },
        { role: 'assistant', text: '换了重连的库。', tools: ['Edit', 'Bash'] },
        { role: 'user', text: '先别改了，我想把周围的代码先看一遍' },
        { role: 'assistant', text: '好，我先不动代码。' },
      ],
      vocab: { area: 'WebSocket 重连', files: ['ws/reconnect.ts', 'ws/heartbeat.ts', 'ws/session.ts'], symbols: ['reconnect', 'scheduleRetry', 'Heartbeat', 'nextDelay'], terms: ['心跳', '会话', '退避'] },
    },
    depth: 30000,
    gold: 'max',
    accept: ['xhigh', 'max'],
    triage: 'unresolved',
    without: { gold: 'high', accept: ['high', 'xhigh'] },
    rationale: '理由',
    difficulty: 'hard',
    tags: ['repeated-failure'],
  }
  change(result)
  return result
}

async function run(items: LongContextItem[], net: ReturnType<typeof network>, variants: string[], settings = settingsFrom({ decisionModel: 'jev' }), suite = longContextSuite(undefined)) {
  return runSuite(suite, items, { backend: jevBackend('k'), io: net.io, now: net.now, pause: async () => {}, settings, variants, languages: ['zh'], timeoutMs: 10_000, retries: 0, concurrency: 1 })
}

const shownBy = (rows: Awaited<ReturnType<typeof run>>) => rows.map((r) => `${r.variant}: ${r.shown}${r.correct ? ' (right)' : ''}`)

test('the three versions of a question: the deep one is read only as far back as the state goes, the near one at any budget, the none one never, and each is scored against its own answer', async () => {
  const net = reader()
  const settings = withStateMessages(withStateTokens(settingsFrom({ decisionModel: 'jev' }), 24000), 1000)
  const rows = await run([item('long-001')], net, ['zh-score-deep', 'zh-score-near', 'zh-score-none'], settings)
  // 24000 tokens do not reach 30000 back; the near version has the rounds at the end; with them deleted high is what is right.
  expect(shownBy(rows)).toEqual(['zh-score-deep: high / unresolved', 'zh-score-near: max / unresolved (right)', 'zh-score-none: high / unresolved (right)'])
  expect(rows.map((r) => r.detail?.seen)).toEqual([false, true, null])
  expect(net.bodies.every((body) => Object.keys(body.questions).join() === 'effort.level,effort.unresolved')).toBe(true)
})

test('a larger budget reaches the deep rounds, and the mod\'s 32 messages are another limit the run says it lifts', async () => {
  const mod = settingsFrom({ decisionModel: 'jev' })
  const wide = withStateTokens(mod, 48000)
  const rows = await run([item('long-001')], reader(), ['zh-score-deep'], wide)
  expect(shownBy(rows)).toEqual(['zh-score-deep: high / unresolved']) // 48000 tokens, but the state keeps 32 messages
  expect(rows[0]?.detail?.seen).toBe(false)

  const lifted = await run([item('long-001')], reader(), ['zh-score-deep'], withStateMessages(wide, 1000))
  expect(shownBy(lifted)).toEqual(['zh-score-deep: max / unresolved (right)'])
  expect(lifted[0]?.detail?.seen).toBe(true)
  expect(Number(lifted[0]?.detail?.stateTokens)).toBeLessThanOrEqual(48000)
  expect(Number(lifted[0]?.detail?.stateTokens)).toBeGreaterThan(30000)
})

test('the plain variants carry no summary and no count; the flow variants carry what the mod keeps after the conversation: the summary, the count, and the strong hint from the count the person set', async () => {
  const base = item('long-001')
  const summary: Summary = { problem: '重连在弱网下一直掉线', tried: [{ text: '把退避的上限调到 30 秒', unresolved: true }, { text: '给心跳加了抖动', unresolved: true }, { text: '换了重连的库' }], status: '助手在读周围的代码' }
  const file: SummaryFile = { items: { 'long-001': { conversation: fingerprint(conversationOf(base, 'deep')), count: 2, summary } } }
  const net = reader()
  await run([base], net, ['zh-score-deep', 'zh-flow'], withStateMessages(settingsFrom({ decisionModel: 'jev' }), 1000), longContextSuite(file))

  const [plain, flow] = net.bodies
  expect(Object.keys(plain.state)).toEqual(['user_message', 'recent_context'])
  // The count is the decisive rounds' own (two of the person's messages said it was unresolved): the flow's state has it, and the summary.
  expect(flow.state.problem_summary).toBe(renderSummary(summary, 'zh'))
  expect(flow.state.unresolved_count).toBe(2)
  // Two is under the three the mod gives the strong hint from: the questions are the plain ones.
  expect(flow.questions).toEqual(asked({ count: 2, maxAfter: 3 }))
  expect(flow.questions).toEqual(plain.questions)
  // A budget that counts the summary's tokens: the state is within it as sent.
  expect(estimateTokens(JSON.stringify(flow.state))).toBeLessThanOrEqual(24000)
})

test('with the count at the one the person set, the flow carries the strong hint', async () => {
  const base = item('long-001', (i) => i.zh.decisive.splice(4, 0, { role: 'user', text: '又掉线了', says: 'unresolved' }, { role: 'assistant', text: '重新写了重连。', tools: ['Edit'] }))
  const summary: Summary = { problem: '重连一直掉线', tried: [{ text: '调退避', unresolved: true }], status: '在等日志' }
  const file: SummaryFile = { items: { 'long-001': { conversation: fingerprint(conversationOf(base, 'deep')), count: 3, summary } } }
  const net = reader()
  await run([base], net, ['zh-flow'], settingsFrom({ decisionModel: 'jev' }), longContextSuite(file))
  expect(net.bodies[0].state.unresolved_count).toBe(3)
  expect(net.bodies[0].questions).toEqual(asked({ count: 3, maxAfter: 3 }))
  expect(net.bodies[0].questions).not.toEqual(asked({}))
})

test('the flow has two halves asked on their own, to tell what each does: the summary alone carries no count and no hint, the count alone carries the count and the hint and no summary (so it needs no summary file)', async () => {
  const base = item('long-001', (i) => i.zh.decisive.splice(4, 0, { role: 'user', text: '又掉线了', says: 'unresolved' }, { role: 'assistant', text: '重新写了重连。', tools: ['Edit'] }))
  const summary: Summary = { problem: '重连一直掉线', tried: [{ text: '调退避', unresolved: true }], status: '在等日志' }
  const file: SummaryFile = { items: { 'long-001': { conversation: fingerprint(conversationOf(base, 'deep')), count: 3, summary } } }
  const net = reader()
  await run([base], net, ['zh-summary', 'zh-count'], settingsFrom({ decisionModel: 'jev' }), longContextSuite(file))
  const [onlySummary, onlyCount] = net.bodies
  expect(Object.keys(onlySummary.state).sort()).toEqual(['problem_summary', 'recent_context', 'user_message'])
  expect(onlySummary.questions).toEqual(asked({}))
  expect(Object.keys(onlyCount.state).sort()).toEqual(['recent_context', 'unresolved_count', 'user_message'])
  expect(onlyCount.state.unresolved_count).toBe(3)
  expect(onlyCount.questions).toEqual(asked({ count: 3, maxAfter: 3 }))

  const withoutFile = await run([base], reader(), ['zh-count'])
  expect(withoutFile[0]?.ok).toBe(true)
})

test('a flow without its summary, or with one written for another conversation, is not asked: nothing is made up', async () => {
  const base = item('long-001')
  const net = reader()
  const none = await run([base], net, ['zh-flow'])
  expect(none[0]?.failure).toMatch(/no summary.*long-context-summaries\.json/)
  const stale = await run([base], net, ['zh-flow'], settingsFrom({ decisionModel: 'jev' }), longContextSuite({ items: { 'long-001': { conversation: 'ffffffffffffffff', count: 2, summary: { problem: 'p', tried: [], status: 's' } } } }))
  expect(stale[0]?.failure).toMatch(/written for another conversation/)
  expect(net.bodies).toHaveLength(0)
})

test('the count the file holds must be the one the decisive rounds make, so a summary written for other rounds is refused', async () => {
  const base = item('long-001')
  const net = reader()
  const rows = await run([base], net, ['zh-flow'], settingsFrom({ decisionModel: 'jev' }), longContextSuite({ items: { 'long-001': { conversation: fingerprint(conversationOf(base, 'deep')), count: 1, summary: { problem: 'p', tried: [], status: 's' } } } }))
  expect(rows[0]?.failure).toMatch(/count 1.*rounds make 2/)
})

test('English is only the language of the questions: the conversation is Chinese, so an English row is no answer', async () => {
  const net = reader()
  const rows = await runSuite(longContextSuite(undefined), [item('long-001')], { backend: jevBackend('k'), io: net.io, now: net.now, pause: async () => {}, settings: settingsFrom({ decisionModel: 'jev' }), variants: ['en-score-deep'], languages: ['en'], timeoutMs: 10_000, retries: 0, concurrency: 1 })
  expect(rows[0]?.failure).toMatch(/Chinese only/)
  const zh = await run([item('long-001')], reader(), ['en-score-deep'])
  expect(zh[0]?.ok).toBe(true)
  expect(zh[0]?.language).toBe('zh')
})

test("the flow's request is the mod's request for that message after that conversation with that count and summary: the same questions, the same state", { options: { decisionModel: 'jev', typesafeApiKey: 'k' } }, async ($, on) => {
  const base = item('long-001')
  const summary: Summary = { problem: '重连在弱网下一直掉线', tried: [{ text: '把退避的上限调到 30 秒', unresolved: true }, { text: '给心跳加了抖动', unresolved: true }], status: '助手在读周围的代码' }
  const entries = conversationOf(base, 'deep')
  const transcript = entries.map((entry) => ({ role: entry.role, text: entry.text, toolUses: (entry.tools ?? []).map((tool, i) => ({ tool_use_id: `toolu_${i}`, tool, input: {}, text: '' })) }))
  const w = world($, on, { switches: UNRESOLVED_ON, backend: jev([0, 0, 0.2, 0.7, 0.1]), messages: transcript, seed: { unresolved: { count: 2, summary: { ...summary, turn: 't1' } } } })
  await w.submit(base.zh.message)

  const net = reader()
  await run([base], net, ['zh-flow'], settingsFrom({ decisionModel: 'jev', typesafeApiKey: 'k' }), longContextSuite({ items: { 'long-001': { conversation: fingerprint(entries), count: 2, summary } } }))
  expect(w.requests).toHaveLength(1)
  expect(w.requests[0]?.body).toEqual({ model: JEV_MODEL, state: net.bodies[0].state, questions: net.bodies[0].questions })
})

test('a result file keeps a digest of a state of tens of thousands of tokens: the short fields as they are, the conversation as its size and its two ends', () => {
  const digest = stateDigest({ user_message: '还是不行', problem_summary: '问题：重连', recent_context: ['user: 第一条', 'assistant: 第二条', 'user: 最后一条'].join('\n') })
  expect(digest).toEqual({ user_message: '还是不行', problem_summary: '问题：重连', recent_context: { chars: 35, lines: 3, first: 'user: 第一条', last: 'user: 最后一条' } })
  expect(stateDigest({ user_message: 'x', recent_context: '' })).toEqual({ user_message: 'x', recent_context: { chars: 0, lines: 0, first: '', last: '' } })
  expect(stateDigest(null)).toBeNull()
  expect(longContextSuite(undefined).digestState).toBe(true)
})

test('the figures of a variant: how often the state held the decisive rounds, the answers by depth, by category and by whether they were held', async () => {
  const items = [item('long-001'), item('long-002', (i) => (i.depth = 60000)), item('long-003', (i) => ((i.tags = ['looks-complex']), (i.gold = 'medium'), (i.accept = ['low', 'medium']), (i.without = { gold: 'high', accept: ['high', 'xhigh'] })))]
  const net = reader()
  const settings = withStateMessages(withStateTokens(settingsFrom({ decisionModel: 'jev' }), 48000), 1000)
  const suite = longContextSuite(undefined)
  const rows = await run(items, net, ['zh-score-deep'], settings, suite)
  const summary = summarize(suite, items, rows, { slowMs: 1500, settings }).variants[0]
  const b = summary?.breakdown as any
  // 48000 tokens reach the 30000-deep rounds (two items) and not the 60000-deep ones.
  expect(b.seen).toEqual({ items: 3, share: 0.6667 })
  expect(b.byDepth['30000']).toMatchObject({ items: 2, seen: 1, accuracy: 0.5 })
  expect(b.byDepth['60000']).toMatchObject({ items: 1, seen: 0, accuracy: 0 })
  expect(b.byCategory['repeated-failure']).toMatchObject({ items: 2, accuracy: 0.5 })
  expect(b.byCategory['looks-complex']).toMatchObject({ items: 1, accuracy: 0 }) // read the rounds and gave max, but medium was right
  expect(b.accuracyBySeen).toEqual({ seen: 0.5, notSeen: 0 })
  // The two items whose gold is max: one read them, so one recall; and the one that was too high.
  expect(b.top).toEqual({ items: 2, recall: 0.5 })
  expect(b.tooHigh).toBe(0.3333)
  expect(b.tooLow).toBe(0.3333)
  expect(b.stateTokens.max).toBeLessThanOrEqual(48000)
  expect(LONG_CONTEXT_VARIANTS['zh-score-deep']).toBeDefined()
})
