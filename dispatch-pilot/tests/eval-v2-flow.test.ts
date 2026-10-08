// The real flow over an eval v2 conversation (seam 2, #45): at each of the person's messages, in order, the request the
// mod sends (the effort question and the three-way question beside it, with the problem summary and the count it holds
// then), the count moved by the mod's two bars, and after each turn the summary continued by the cheap model with the
// mod's own prompt. Seam 1 checks that the mod living the same conversation sends the same requests and prompts.

import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { BackendIo } from '../hooks/decision/backend.ts'
import { EFFORTS } from '../hooks/decision/effort.ts'
import { JEV_MODEL, jevBackend } from '../hooks/decision/jev.ts'
import { renderSummary, SUMMARY_SYSTEM } from '../hooks/decision/summary.ts'
import type { V2Record, V2Turn } from '../eval/lib/eval-v2.ts'
import { flowItem, type FlowItem } from '../eval/lib/eval-v2-flow.ts'
import { askRetrying } from '../eval/lib/runner.ts'
import { settingsFrom } from '../eval/lib/suite.ts'
import { world, type Sent } from './support/world.ts'

type Reply = { status: number; body: unknown }

const STILL = { still_unresolved: 0.8, resolved: 0.05, new_or_unrelated: 0.15 }
const ELSEWHERE = { still_unresolved: 0.05, resolved: 0.1, new_or_unrelated: 0.85 }
const UNSURE = { still_unresolved: 0.3, resolved: 0.4, new_or_unrelated: 0.3 }
const HIGH = [0, 0.1, 0.8, 0.1, 0]

/** A Jev answer to the effort question (`p` on the levels) and to the three-way question (`triage`), for a request body. */
function answers(body: any, triage: Record<string, number>, p: readonly number[] = HIGH): Reply {
  const out: Record<string, unknown> = {}
  for (const [id, question] of Object.entries(body.questions as Record<string, { type: string }>)) {
    if (id === 'effort.level') out[id] = { type: 'score', probabilities: Object.fromEntries(EFFORTS.map((_, i) => [String(i), p[i] ?? 0])), confidence: 0.5, score: 0 }
    else out[id] = { type: question.type, probabilities: triage, confidence: 0.5, choice: '' }
  }
  return { status: 200, body: { model: 'jev-1.13.0', answers: out, usage: { input_tokens: 700 } } }
}

/** The conversation: a lead round, the decisive rounds (a problem raised, then said to be unresolved), a middle round, the message. */
const TURNS: V2Turn[] = [
  { role: 'user', msg: 'p1', part: 'lead', segment: 'frontend-unrelated-01', text: '给订单导出加一列备注' },
  { role: 'assistant', part: 'lead', segment: 'frontend-unrelated-01', text: '加好了，导出的 CSV 多了一列备注。', tools: ['Read', 'Edit'] },
  { role: 'user', msg: 'd1', part: 'decisive', text: '订单列表翻到第二页是空的，帮我查一下' },
  { role: 'assistant', part: 'decisive', text: 'offset 按页码直接乘了页大小，改成了 (page - 1) * size。', tools: ['Read', 'Edit'] },
  { role: 'user', msg: 'd2', part: 'decisive', text: '还是空的' },
  { role: 'assistant', part: 'decisive', text: '在请求里补上了 page。', tools: ['Edit', 'Bash', 'Bash'] },
  { role: 'user', msg: 'm1', part: 'middle', segment: 'frontend-same-problem-01', text: '先别改，把 useOrderPagination 的调用链理一遍' },
  { role: 'assistant', part: 'middle', segment: 'frontend-same-problem-01', text: '理了一遍：四条路径会走到这里。', tools: ['Grep', 'Read'] },
  { role: 'user', msg: 'f1', part: 'final', text: '回到分页那个问题，第二页还是空的' },
]

/** What the decision model reads each message as, by the message: the lead and the first decisive message start something new, the second is unresolved, the middle one says nothing either way, the last is unresolved again. */
const READS: Record<string, Record<string, number>> = { p1: ELSEWHERE, d1: ELSEWHERE, d2: STILL, m1: UNSURE, f1: STILL }

function record(turns: V2Turn[] = TURNS): V2Record {
  return {
    id: 'explicit-unresolved-01',
    category: 'explicit-unresolved',
    domain: 'frontend',
    bin: 'd1',
    relation: 'same-problem',
    middle_hint: '中间是同一个问题的继续排查。',
    turns,
    decisive: [
      { msg: 'd1', at: 2, depth: 300 },
      { msg: 'd2', at: 4, depth: 200 },
    ],
    depth: 300,
    depth_end: 150,
    tokens: 400,
    segments: { lead: ['frontend-unrelated-01'], middle: ['frontend-same-problem-01'] },
  }
}

/** The message a request is about, by its text. */
const msgOf = (text: unknown) => TURNS.find((turn) => turn.role === 'user' && turn.text === text)?.msg ?? '?'

/** A backend that reads each message as READS says (or as `reads` overrides), through Jev's own reading of the reply. */
function backend(reads: Record<string, Record<string, number> | Reply> = READS) {
  const bodies: any[] = []
  const io: BackendIo = {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body))
      bodies.push(body)
      const read = reads[msgOf(body.state.user_message)] ?? READS[msgOf(body.state.user_message)] ?? UNSURE
      const reply = 'status' in read ? (read as Reply) : answers(body, read as Record<string, number>)
      return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: {}, text: JSON.stringify(reply.body) }
    },
    sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))),
  }
  const ask = (request: Parameters<typeof askRetrying>[0]) => askRetrying(request, { backend: jevBackend('k'), io, timeoutMs: 10_000, retries: 0, now: () => 0, pause: async () => {} })
  return { ask, bodies }
}

/** The cheap model: the n-th summary it is asked for is `replies[n]` (a record), every prompt kept. */
function cheap(replies: readonly (string | null)[]) {
  const prompts: string[] = []
  const complete = async (prompt: string) => {
    prompts.push(prompt)
    return replies[prompts.length - 1] ?? null
  }
  return { complete, prompts }
}

const written = (problem: string, tried: string[], status: string) => JSON.stringify({ problem, tried, status })
const REPLIES = [
  written('订单导出加一列备注', ['导出加了备注列'], '助手加好了'),
  written('订单列表第二页是空的', ['offset 改成 (page - 1) * size'], '助手改了 offset'),
  written('订单列表第二页是空的', ['offset 改成 (page - 1) * size [unresolved]', '请求里补上 page'], '助手补了 page'),
  written('订单列表第二页是空的', ['offset 改成 (page - 1) * size [unresolved]', '请求里补上 page'], '助手在理调用链'),
]

test('every message of the person is asked in order, as the mod asks it, and the count moves by the mod\'s two bars; the last message carries the count and the summary the conversation left', async () => {
  const net = backend()
  const model = cheap(REPLIES)
  const { item, stopped } = await flowItem(record(), { ask: net.ask, complete: model.complete, settings: settingsFrom({}), language: 'zh' })

  expect(stopped).toBeNull()
  expect(net.bodies.map((body) => msgOf(body.state.user_message))).toEqual(['p1', 'd1', 'd2', 'm1', 'f1'])
  expect(net.bodies.every((body) => Object.keys(body.questions).join() === 'effort.level,effort.unresolved')).toBe(true)
  expect(item.messages.map((m) => `${m.msg} ${m.before}→${m.after} ${m.change}`)).toEqual(['p1 0→0 reset', 'd1 0→0 reset', 'd2 0→1 add', 'm1 1→1 keep', 'f1 1→2 add'])
  // The probabilities each answer gave, for scanning the bars offline.
  expect(item.messages[2]).toMatchObject({ msg: 'd2', at: 4, part: 'decisive', triage: STILL, p: HIGH })
  // The first request has no summary yet; each later one the summary written after the turn before it, and the count from the first "still unresolved" on.
  expect('problem_summary' in net.bodies[0].state).toBe(false)
  expect(net.bodies[1].state.problem_summary).toBe(renderSummary({ problem: '订单导出加一列备注', tried: [{ text: '导出加了备注列' }], status: '助手加好了' }, 'zh'))
  expect(net.bodies[3].state.unresolved_count).toBe(1)
  expect('unresolved_count' in net.bodies[2].state).toBe(false)
  // What the last message's request carried.
  const last = { problem: '订单列表第二页是空的', tried: [{ text: 'offset 改成 (page - 1) * size', unresolved: true as const }, { text: '请求里补上 page' }], status: '助手在理调用链' }
  expect(item.final).toEqual({ count: 1, summary: last, hint: false })
  expect(net.bodies[4].state.problem_summary).toBe(renderSummary(last, 'zh'))
})

test('the summary is continued after each turn but the last: a clear starts it over, a "still unresolved" marks its last try before the turn is written about', async () => {
  const net = backend()
  const model = cheap(REPLIES)
  await flowItem(record(), { ask: net.ask, complete: model.complete, settings: settingsFrom({}), language: 'zh' })

  expect(model.prompts).toHaveLength(4)
  // After the lead: none yet. After d1, which started another problem: none again (the clear took the record).
  expect(model.prompts[0]).toMatch(/none yet/i)
  expect(model.prompts[1]).toMatch(/none yet/i)
  expect(model.prompts[1]).toContain('订单列表翻到第二页是空的')
  expect(model.prompts[1]).toContain('改成了 (page - 1) * size')
  expect(model.prompts[1]).toContain('Read, Edit')
  // d2 said it is still unresolved: the try it is about is marked when the turn is written about.
  expect(model.prompts[2]).toContain('"tried":["offset 改成 (page - 1) * size [unresolved]"]')
  expect(model.prompts[2]).toContain('Edit, Bash x2')
  expect(model.prompts[3]).toContain('理了一遍')
})

test('a busy backend stops the item where it is, and a later run goes on from there with what the requests carried: the same flow as one run', async () => {
  const busy = { status: 529, body: { error: 'overloaded' } }
  const first = backend({ m1: busy })
  const saved: FlowItem[] = []
  const stoppedRun = await flowItem(record(), { ask: first.ask, complete: cheap(REPLIES).complete, settings: settingsFrom({}), language: 'zh', onMessage: (item) => void saved.push(JSON.parse(JSON.stringify(item))) })
  expect(stoppedRun.stopped).toMatch(/^m1: busy/)
  expect(stoppedRun.item.messages.map((m) => m.msg)).toEqual(['p1', 'd1', 'd2'])
  expect(stoppedRun.item.final).toBeUndefined()
  // Progress was heard of after each message done.
  expect(saved.map((item) => item.messages.length)).toEqual([1, 2, 3])

  const second = backend()
  const rest = cheap(REPLIES.slice(3))
  const resumed = await flowItem(record(), { ask: second.ask, complete: rest.complete, settings: settingsFrom({}), language: 'zh' }, stoppedRun.item)
  expect(second.bodies.map((body) => msgOf(body.state.user_message))).toEqual(['m1', 'f1'])
  const whole = await flowItem(record(), { ask: backend().ask, complete: cheap(REPLIES).complete, settings: settingsFrom({}), language: 'zh' })
  expect(resumed.item).toEqual(whole.item)
  // A flow of another conversation is not gone on with.
  await expect(flowItem(record(TURNS.map((turn) => ({ ...turn, text: `${turn.text}。` }))), { ask: second.ask, complete: rest.complete, settings: settingsFrom({}), language: 'zh' }, stoppedRun.item)).rejects.toThrow(/another conversation/)
})

test('a 402 (the account has no credits left) stops the item as a spent quota does, instead of recording an unanswered message, and a later run goes on from there', async () => {
  const spent = { status: 402, body: { error_type: 'billing_error', message: 'Your organization has no available TypeSafe API credits.' } }
  const first = backend({ m1: spent })
  const stoppedRun = await flowItem(record(), { ask: first.ask, complete: cheap(REPLIES).complete, settings: settingsFrom({}), language: 'zh' })
  expect(stoppedRun.stopped).toMatch(/^m1: quota: /)
  // The message that met the 402 is not in the file: no `failure` was recorded for it.
  expect(stoppedRun.item.messages.map((m) => m.msg)).toEqual(['p1', 'd1', 'd2'])
  expect(stoppedRun.item.messages.some((m) => m.failure !== undefined)).toBe(false)
  expect(stoppedRun.item.final).toBeUndefined()
  // The runner halts the whole run on this (its test is on "quota:" after the message name).
  expect(stoppedRun.stopped).toMatch(/^\S+: (config|quota):/)

  const second = backend()
  const resumed = await flowItem(record(), { ask: second.ask, complete: cheap(REPLIES.slice(3)).complete, settings: settingsFrom({}), language: 'zh' }, stoppedRun.item)
  expect(resumed.stopped).toBeNull()
  expect(second.bodies.map((body) => msgOf(body.state.user_message))).toEqual(['m1', 'f1'])
  const whole = await flowItem(record(), { ask: backend().ask, complete: cheap(REPLIES).complete, settings: settingsFrom({}), language: 'zh' })
  expect(resumed.item).toEqual(whole.item)
})

test('an answer the mod could not read leaves the count as it is, as the mod does, and says why; a turn whose summary never came keeps the one before it', async () => {
  const net = backend({ d2: { status: 400, body: { error: 'bad request' } } })
  const model = cheap([REPLIES[0] ?? '', REPLIES[1] ?? '', 'not a record', null, 'still not', REPLIES[3] ?? ''])
  const { item, stopped } = await flowItem(record(), { ask: net.ask, complete: model.complete, settings: settingsFrom({}), language: 'zh', tries: 3 })
  expect(stopped).toBeNull()
  expect(item.messages[2]).toMatchObject({ msg: 'd2', before: 0, after: 0, change: 'keep', write: 'failed' })
  expect(item.messages[2]?.failure).toMatch(/^http/)
  // The summary of d1's turn stayed: it is what m1's request read, not marked (nothing said it was unresolved).
  expect(net.bodies[3].state.problem_summary).toBe(renderSummary({ problem: '订单列表第二页是空的', tried: [{ text: 'offset 改成 (page - 1) * size' }], status: '助手改了 offset' }, 'zh'))
  expect(model.prompts).toHaveLength(6)
})

test('the bars can be set: at an add bar of 0.25 an unsure answer adds one', async () => {
  const { item } = await flowItem(record(), { ask: backend().ask, complete: cheap(REPLIES).complete, settings: settingsFrom({}), language: 'zh', thresholds: { add: 0.25, reset: 0.8 } })
  expect(item.messages.map((m) => m.change)).toEqual(['reset', 'reset', 'add', 'add', 'add'])
})

/** A conversation's turns as the engine's transcript holds them. */
function transcript(turns: readonly V2Turn[]): SessionMessage[] {
  return turns.map((turn) => ({ role: turn.role, text: turn.text, toolUses: (turn.tools ?? []).map((tool, i) => ({ tool_use_id: `toolu_${i}`, tool, input: {} })) }))
}

test('the mod living the same conversation sends the same request at every message, asks the cheap model the same prompts, and holds the same count and summary at the last message', { options: { typesafeApiKey: 'k' } }, async ($, on) => {
  let shown: SessionMessage[] = []
  const w = world($, on, {
    backend: (request: Sent) => answers(request.body, READS[msgOf(request.body.state.user_message)] ?? UNSURE),
    model: (_request, n) => ({ text: REPLIES[n - 1] ?? '' }),
    messages: () => shown,
  })
  let before: { count: number; summary: unknown } | undefined
  for (const [at, turn] of TURNS.entries()) {
    if (turn.role !== 'user') continue
    const last = at === TURNS.length - 1
    if (last) {
      const { turn: _turn, ...summary } = w.summary() ?? { turn: '' }
      before = { count: w.unresolved(), summary: w.summary() === undefined ? null : summary }
    }
    shown = transcript(TURNS.slice(0, at))
    await w.submit(turn.text)
    if (last) break
    shown = transcript(TURNS.slice(0, at + 2))
    await w.complete({ answer: TURNS[at + 1]?.text ?? '' })
    await w.clock.settle()
  }

  const net = backend()
  const model = cheap(REPLIES)
  const { item } = await flowItem(record(), { ask: net.ask, complete: model.complete, settings: settingsFrom({ typesafeApiKey: 'k' }), language: 'zh' })
  expect(w.requests.map((request) => request.body)).toEqual(net.bodies.map((body) => ({ model: JEV_MODEL, state: body.state, questions: body.questions })))
  expect(w.completions.map((request) => request.prompt)).toEqual(model.prompts)
  expect(w.completions.every((request) => request.system === SUMMARY_SYSTEM && request.model === 'haiku')).toBe(true)
  expect(before).toEqual({ count: item.final?.count, summary: item.final?.summary })
  expect(w.unresolved()).toBe(item.messages.at(-1)?.after)
})

test('from the count unresolvedMaxAfter sets on, the request carries the strong hint, as the mod\'s does', async () => {
  const turns: V2Turn[] = [
    { role: 'user', msg: 'd1', part: 'decisive', text: '订单列表翻到第二页是空的，帮我查一下' },
    { role: 'assistant', part: 'decisive', text: '改了 offset。' },
    ...[2, 3, 4].flatMap((n): V2Turn[] => [
      { role: 'user', msg: `d${n}`, part: 'decisive', text: `还是空的（第 ${n} 次）` },
      { role: 'assistant', part: 'decisive', text: `第 ${n} 次改动。` },
    ]),
    { role: 'user', msg: 'f1', part: 'final', text: '第二页还是空的' },
  ]
  const reads = (body: any) => (String(body.state.user_message).startsWith('订单') ? ELSEWHERE : STILL)
  const bodies: any[] = []
  const io: BackendIo = {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body))
      bodies.push(body)
      return { status: 200, ok: true, headers: {}, text: JSON.stringify(answers(body, reads(body)).body) }
    },
    sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))),
  }
  const ask = (request: Parameters<typeof askRetrying>[0]) => askRetrying(request, { backend: jevBackend('k'), io, timeoutMs: 10_000, retries: 0, now: () => 0, pause: async () => {} })
  const { item } = await flowItem(record(turns), { ask, complete: async () => written('第二页是空的', ['改 offset'], '在改'), settings: settingsFrom({}), language: 'zh' })

  expect(item.messages.map((m) => `${m.msg} ${m.before}${m.hint ? ' hint' : ''}`)).toEqual(['d1 0', 'd2 0', 'd3 1', 'd4 2', 'f1 3 hint'])
  expect(Object.keys(bodies[4].questions['effort.level'].instructions)).toContain('未解决')
  expect(Object.keys(bodies[3].questions['effort.level'].instructions)).not.toContain('未解决')
  expect(item.final).toMatchObject({ count: 3, hint: true })
})
