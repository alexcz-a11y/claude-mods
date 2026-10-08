// The `eval-v2` suite (seam 2, #45): what it asks of the backend for an item of eval-v2.jsonl and how it scores the answers
// against the final gold (eval-v2/gold/). Its requests are the mod's: the message is the conversation's last turn, the
// conversation before it is `recent_context`, and the parts, the state and its budget come from the mod's own functions;
// the flow variants carry the count and the summary the flow file (eval-v2-flow.ts) holds at the last message.

import { expect, test } from 'claude-code/testing'
import type { BackendIo } from '../hooks/decision/backend.ts'
import { EFFORTS } from '../hooks/decision/effort.ts'
import { JEV_MODEL, jevBackend } from '../hooks/decision/jev.ts'
import { renderSummary, type Summary } from '../hooks/decision/summary.ts'
import type { V2Record, V2Turn } from '../eval/lib/eval-v2.ts'
import { flowItem, type FlowFile, type FlowItem } from '../eval/lib/eval-v2-flow.ts'
import { evalV2Suite, v2Item, type FinalGold, type V2EvalItem } from '../eval/lib/eval-v2-suite.ts'
import { summarize } from '../eval/lib/metrics.ts'
import { askRetrying, runSuite } from '../eval/lib/runner.ts'
import { settingsFrom, withStateMessages, withStateTokens } from '../eval/lib/suite.ts'
import { jev, world } from './support/world.ts'
/** The switch is off until the person turns it on (#48): these tests are about what the request is with it on. */
const UNRESOLVED_ON = { unresolved: true }

type Reply = { status: number; body: unknown }

const STILL = { still_unresolved: 0.7, resolved: 0.2, new_or_unrelated: 0.1 }

/** A Jev answer to the effort question putting `p` on the levels (lowest first), and to the three-way question `triage`. */
function answers(body: any, p: readonly number[], triage: Record<string, number> = STILL): Reply {
  const out: Record<string, unknown> = {}
  for (const [id, question] of Object.entries(body.questions as Record<string, { type: string }>)) {
    if (id === 'effort.level') out[id] = { type: 'score', probabilities: Object.fromEntries(EFFORTS.map((_, i) => [String(i), p[i] ?? 0])), confidence: 0.5, score: 0 }
    else out[id] = { type: question.type, probabilities: triage, confidence: 0.5, choice: '' }
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

/** `n` tokens of Chinese prose (one a character). */
function prose(n: number): string {
  const sentence = '我把这一层的入参和返回值又对了一遍，顺手记下了调用方各自传的默认值。'
  return sentence.repeat(Math.ceil(n / sentence.length) + 1).slice(0, n)
}

/**
 * An assembled conversation as eval-v2.jsonl holds it: a lead segment, two decisive rounds (the first marked DECISIVE), a
 * middle of `middle` tokens, and the final message. Depths are not what the tests read, so they are left rough.
 */
function record(id: string, change: (record: V2Record) => void = () => {}, middle = 2000): V2Record {
  const turns: V2Turn[] = [
    { role: 'user', msg: 'p1', part: 'lead', segment: 'frontend-unrelated-01', text: '给订单导出加一列备注' },
    { role: 'assistant', part: 'lead', segment: 'frontend-unrelated-01', text: '加好了，导出的 CSV 多了一列备注。', tools: ['Read', 'Edit'] },
    { role: 'user', msg: 'd1', part: 'decisive', text: 'DECISIVE 订单列表翻到第二页是空的，帮我查一下' },
    { role: 'assistant', part: 'decisive', text: 'offset 按页码直接乘了页大小，改成了 (page - 1) * size。', tools: ['Read', 'Edit'] },
    { role: 'user', msg: 'd2', part: 'decisive', text: '还是空的' },
    { role: 'assistant', part: 'decisive', text: '在请求里补上了 page。', tools: ['Edit', 'Bash'] },
    { role: 'user', msg: 'm1', part: 'middle', segment: 'frontend-same-problem-01', text: '先别改，把调用链理一遍' },
    { role: 'assistant', part: 'middle', segment: 'frontend-same-problem-01', text: prose(middle), tools: ['Grep', 'Read'] },
    { role: 'user', msg: 'f1', part: 'final', text: `${id} 回到分页那个问题，第二页还是空的` },
  ]
  const result: V2Record = {
    id,
    category: 'explicit-unresolved',
    domain: 'frontend',
    bin: 'd1',
    relation: 'same-problem',
    middle_hint: '中间是同一个问题的继续排查。',
    turns,
    decisive: [
      { msg: 'd1', at: 2, depth: middle + 200 },
      { msg: 'd2', at: 4, depth: middle + 100 },
    ],
    depth: middle + 200,
    depth_end: middle + 60,
    tokens: middle + 260,
    segments: { lead: ['frontend-unrelated-01'], middle: ['frontend-same-problem-01'] },
  }
  change(result)
  return result
}

function gold(id: string, change: (gold: FinalGold) => void = () => {}): FinalGold {
  const result: FinalGold = {
    id,
    effort: 'max',
    accept: ['xhigh', 'max'],
    effort_without_decisive: 'high',
    triage_final: 'still_unresolved',
    triage_decisive: [
      { msg: 'd1', triage: 'new_or_unrelated' },
      { msg: 'd2', triage: 'still_unresolved' },
    ],
    rationale: '理由',
    source: 'agreed',
  }
  change(result)
  return result
}

const item = (id: string, change?: (record: V2Record) => void, middle?: number, goldChange?: (gold: FinalGold) => void): V2EvalItem => v2Item(record(id, change, middle), gold(id, goldChange))

/** An item's conversation before its message, as the engine's transcript holds it. */
function transcript(turns: readonly V2Turn[]) {
  return turns.map((turn) => ({ role: turn.role, text: turn.text, toolUses: (turn.tools ?? []).map((tool, i) => ({ tool_use_id: `toolu_${i}`, tool, input: {}, text: '' })) }))
}

async function run(items: V2EvalItem[], net: ReturnType<typeof network>, variants: string[], settings = settingsFrom({}), suite = evalV2Suite()) {
  return runSuite(suite, items, { backend: jevBackend('k'), io: net.io, now: net.now, pause: async () => {}, settings, variants, languages: ['zh'], timeoutMs: 10_000, retries: 0, concurrency: 1 })
}

const SOLVED = { still_unresolved: 0.1, resolved: 0.8, new_or_unrelated: 0.1 }
const ELSEWHERE = { still_unresolved: 0.1, resolved: 0.1, new_or_unrelated: 0.8 }
const MAX = [0, 0, 0.1, 0.2, 0.7]
const XHIGH = [0, 0, 0.1, 0.8, 0.1]
const HIGH = [0, 0.1, 0.8, 0.1, 0]
const MEDIUM = [0.1, 0.8, 0.1, 0, 0]

/** Four items over the bins and relations, each answered as its message says (the id is at the start of the last message). */
function fourItems() {
  const items = [
    // d1 same-problem, gold max: answered max, triage right.
    item('explicit-unresolved-01'),
    // d2 unrelated, gold low: answered xhigh (too high), triage answered unresolved though it is resolved.
    item('resolved-01', (r) => ((r.category = 'resolved'), (r.bin = 'd2'), (r.relation = 'unrelated')), 2000, (g) => ((g.effort = 'low'), (g.accept = ['low', 'medium']), (g.effort_without_decisive = 'low'), (g.triage_final = 'resolved'))),
    // d4 same-problem, gold max alone: answered high (too low: it reads as if the decisive rounds were not there), triage right.
    item('single-attempt-01', (r) => ((r.category = 'single-attempt'), (r.bin = 'd4')), 2000, (g) => ((g.accept = ['max']), (g.triage_final = 'new_or_unrelated'))),
    // d4 unrelated, gold medium: answered medium, triage right.
    item('new-topic-01', (r) => ((r.category = 'new-topic'), (r.bin = 'd4'), (r.relation = 'unrelated')), 2000, (g) => ((g.effort = 'medium'), (g.accept = ['medium']), (g.effort_without_decisive = 'medium'))),
  ]
  const net = network((body) => {
    const id = String(body.state.user_message).split(' ')[0]
    if (id === 'explicit-unresolved-01') return answers(body, MAX, STILL)
    if (id === 'resolved-01') return answers(body, XHIGH, STILL)
    if (id === 'single-attempt-01') return answers(body, HIGH, ELSEWHERE)
    return answers(body, MEDIUM, STILL)
  })
  return { items, net }
}

test('the answer is the effort, scored against the final gold: acceptable, exact, too high or too low; the three-way question is a part of its own, scored against triage_final', async () => {
  const { items, net } = fourItems()
  const rows = await run(items, net, ['zh-score'])
  expect(rows.map((r) => `${r.id}: ${r.shown}${r.correct ? ' right' : ` ${r.miss}`}${r.exact ? ' exact' : ''}, triage ${r.parts?.triage ? 'right' : 'wrong'}`)).toEqual([
    'explicit-unresolved-01: max / unresolved right exact, triage right',
    'resolved-01: xhigh / unresolved over, triage wrong',
    'single-attempt-01: high / new under, triage right',
    'new-topic-01: medium / unresolved right exact, triage right',
  ])
  // Each answer keeps the probabilities it was decided from, to decide again offline at other thresholds.
  expect(rows[0]?.detail).toMatchObject({ p: MAX, triageP: { unresolved: 0.7, resolved: 0.2, new: 0.1 }, triageChange: 'add' })
})

test('the figures of a variant: the recall of max, too high and too low, each split by bin, by relation and by both, and the three-way question', async () => {
  const { items, net } = fourItems()
  const suite = evalV2Suite()
  const settings = settingsFrom({})
  const rows = await run(items, net, ['zh-score'], settings, suite)
  const b = summarize(suite, items, rows, { slowMs: 1500, settings }).variants[0]?.breakdown as any

  // Two items need max (01, single-attempt-01): one got it. Neither of the two that do not accept max was given it.
  expect(b.top).toEqual({ items: 2, recall: 0.5, falseMax: 0 })
  expect(b.tooHigh).toBe(0.25)
  expect(b.tooLow).toBe(0.25)
  expect(b.byBin.d1).toEqual({ items: 1, accuracy: 1, exact: 1, tooHigh: 0, tooLow: 0, top: 1, topRecall: 1, triage: 1 })
  expect(b.byBin.d2).toEqual({ items: 1, accuracy: 0, exact: 0, tooHigh: 1, tooLow: 0, top: 0, topRecall: null, triage: 0 })
  expect(b.byBin.d3).toEqual({ items: 0, accuracy: null, exact: null, tooHigh: null, tooLow: null, top: 0, topRecall: null, triage: null })
  expect(b.byBin.d4).toEqual({ items: 2, accuracy: 0.5, exact: 0.5, tooHigh: 0, tooLow: 0.5, top: 1, topRecall: 0, triage: 1 })
  expect(b.byRelation['same-problem']).toMatchObject({ items: 2, accuracy: 0.5, topRecall: 0.5 })
  expect(b.byRelation.unrelated).toMatchObject({ items: 2, accuracy: 0.5, tooHigh: 0.5, triage: 0.5 })
  expect(b.byBinRelation['d4 same-problem']).toMatchObject({ items: 1, accuracy: 0, tooLow: 1 })
  expect(Object.keys(b.byBinRelation)).toHaveLength(8)
  expect(b.byCategory['resolved']).toMatchObject({ items: 1, accuracy: 0 })
  // Three of four right; resolved-01 was read as unresolved, which would have added one to the count.
  expect(b.triage.accuracy).toBe(0.75)
  expect(b.triage.confusion).toEqual({ unresolved: { unresolved: 2 }, resolved: { unresolved: 1 }, new: { new: 1 } })
  expect(b.triage.change).toEqual({ right: 0.75, falseAdd: 0.5, lostRecord: 0 })
  // Of the two items whose answer is another one without the decisive rounds, single-attempt-01 got exactly that one.
  expect(b.withoutDecisive).toEqual({ items: 2, share: 0.5 })
  // The decisive rounds are a few thousand tokens back here: every state held them.
  expect(b.seen).toEqual({ all: 1, any: 1 })
})

test('what other thresholds for max would have given, from the probabilities kept', async () => {
  const items = [item('explicit-unresolved-01'), item('explicit-unresolved-02'), item('resolved-01', () => {}, 2000, (g) => ((g.effort = 'high'), (g.accept = ['high', 'xhigh'])))]
  // xhigh and max at 0.45 each: max at a thetaMax of 0.4, xhigh at 0.5.
  const near = [0, 0, 0.1, 0.45, 0.45]
  const net = network((body) => answers(body, String(body.state.user_message).startsWith('explicit-unresolved-01') ? MAX : near))
  const suite = evalV2Suite()
  const settings = settingsFrom({})
  const rows = await run(items, net, ['zh-score'], settings, suite)
  const b = summarize(suite, items, rows, { slowMs: 1500, settings }).variants[0]?.breakdown as any
  const at = (theta: number) => b.thetaMax.find((row: any) => row.thetaMax === theta)
  expect(at(0.5)).toEqual({ thetaMax: 0.5, accuracy: 1, topRecall: 0.5, falseMax: 0 })
  expect(at(0.4)).toEqual({ thetaMax: 0.4, accuracy: 0.6667, topRecall: 1, falseMax: 1 })
})

test('a state that does not reach the decisive rounds says so: 24000 tokens do not hold rounds 30000 back, 48000 with the messages lifted do', async () => {
  const deep = item('explicit-unresolved-01', (r) => (r.bin = 'd2'), 30000)
  const reader = () => network((body) => answers(body, String(body.state.recent_context).includes('DECISIVE') ? MAX : HIGH))
  const near = await run([deep], reader(), ['zh-score'])
  expect(near[0]).toMatchObject({ shown: 'high / unresolved', correct: false })
  expect(near[0]?.detail).toMatchObject({ seen: false, seenAny: false })
  const wide = await run([deep], reader(), ['zh-score'], withStateMessages(withStateTokens(settingsFrom({}), 48000), 2000))
  expect(wide[0]?.detail).toMatchObject({ seen: true, seenAny: true })
  expect(wide[0]?.shown).toBe('max / unresolved')
})

/** A flow file (eval-v2-flow.ts) holding `items`, run with the mod's settings for Jev. */
function flowFile(items: Record<string, FlowItem>): FlowFile {
  return {
    suite: 'eval-v2-flow',
    about: 'test',
    backend: { name: 'jev', model: JEV_MODEL, answeredBy: ['jev-1.13.0'] },
    settings: { language: 'zh', stateTokens: 24000, stateMessages: 32, thresholds: { add: 0.5, reset: 0.7 }, maxAfter: 3 },
    summarizer: { model: 'haiku', says: null, answeredBy: [], how: 'test', asked: 0, failed: 0, cached: 0 },
    dataset: { sha256: 'test', items: Object.keys(items).length },
    items,
  }
}

/** The flow of an item, run over its conversation: the backend reads every message as unresolved, the cheap model writes the same record each turn. */
async function flowOf(one: V2EvalItem) {
  const net = network((body) => answers(body, HIGH, STILL))
  const ask = (request: Parameters<typeof askRetrying>[0]) => askRetrying(request, { backend: jevBackend('k'), io: net.io, timeoutMs: 10_000, retries: 0, now: net.now, pause: async () => {} })
  const record = JSON.stringify({ problem: '订单列表第二页是空的', tried: ['改了 offset', '补了 page'], status: '助手在理调用链' })
  const { item } = await flowItem(one, { ask, complete: async () => record, settings: settingsFrom({ typesafeApiKey: 'k' }), language: 'zh' })
  return { item, bodies: net.bodies }
}

test('a flow variant carries what the flow file says the last message\'s request carried: the count, the summary, and the strong hint once the count reached unresolvedMaxAfter; it is the flow\'s own request for that message', async () => {
  const one = item('explicit-unresolved-01')
  const flow = await flowOf(one)
  // Every message read as unresolved: p1, d1, d2, m1 make the count 4 by the last message, past the 3 the hint starts at.
  expect(flow.item.final).toMatchObject({ count: 4, hint: true })
  const net = network((body) => answers(body, MAX))
  const rows = await run([one], net, ['zh-flow', 'zh-score'], settingsFrom({ typesafeApiKey: 'k' }), evalV2Suite(flowFile({ [one.id]: flow.item })))
  const [withFlow, plain] = net.bodies
  expect(withFlow).toEqual(flow.bodies.at(-1))
  expect(withFlow.state.unresolved_count).toBe(4)
  expect(withFlow.state.problem_summary).toBe(renderSummary(flow.item.final?.summary as Summary, 'zh'))
  expect(Object.keys(withFlow.questions['effort.level'].instructions)).toContain('未解决')
  expect(Object.keys(plain.state)).toEqual(['user_message', 'recent_context'])
  expect(rows[0]?.detail).toMatchObject({ count: 4, hint: true })
  const suite = evalV2Suite(flowFile({ [one.id]: flow.item }))
  const figures = summarize(suite, [one], rows, { slowMs: 1500, settings: settingsFrom({}) }).variants.map((v) => (v.breakdown as any).carried)
  // The flow variant's requests: how many had a count, the hint, a summary; the plain variant carries none of it.
  expect(figures).toEqual([{ items: 1, counted: 1, hinted: 1, summarized: 1 }, null])
})

test('a flow variant with no flow file, without the item in it, with a flow of another conversation or one not finished is not asked: nothing is made up', async () => {
  const one = item('explicit-unresolved-01')
  const { item: done } = await flowOf(one)
  const net = network((body) => answers(body, MAX))
  const failures = async (suite: ReturnType<typeof evalV2Suite>) => (await run([one], net, ['zh-flow'], settingsFrom({}), suite)).map((row) => row.failure)
  expect(await failures(evalV2Suite())).toEqual([expect.stringMatching(/needs --flow/)])
  expect(await failures(evalV2Suite(flowFile({})))).toEqual([expect.stringMatching(/no flow for explicit-unresolved-01/)])
  expect(await failures(evalV2Suite(flowFile({ [one.id]: { ...done, conversation: 'ffffffffffffffff' } })))).toEqual([expect.stringMatching(/another conversation/)])
  const { final: _final, ...unfinished } = done
  expect(await failures(evalV2Suite(flowFile({ [one.id]: unfinished })))).toEqual([expect.stringMatching(/not finished/)])
  expect(net.bodies).toHaveLength(0)
})

test("a flow variant's request is the mod's request for the last message with that count and summary", { options: { typesafeApiKey: 'k' } }, async ($, on) => {
  const one = item('explicit-unresolved-01')
  const flow = await flowOf(one)
  const summary = flow.item.final?.summary as Summary
  const w = world($, on, { switches: UNRESOLVED_ON, backend: jev([0, 0, 0.2, 0.7, 0.1]), messages: transcript(one.turns.slice(0, -1)), seed: { unresolved: { count: 4, summary: { ...summary, turn: 't9' } } } })
  await w.submit(one.turns.at(-1)?.text ?? '')
  const net = network((body) => answers(body, MAX))
  await run([one], net, ['zh-flow'], settingsFrom({ typesafeApiKey: 'k' }), evalV2Suite(flowFile({ [one.id]: flow.item })))
  expect(w.requests[0]?.body).toEqual({ model: JEV_MODEL, state: net.bodies[0].state, questions: net.bodies[0].questions })
})

test("an item's request is the mod's request for its last message after the conversation before it: the same questions, the same state", { options: { typesafeApiKey: 'k' } }, async ($, on) => {
  const one = item('explicit-unresolved-01')
  const w = world($, on, { switches: UNRESOLVED_ON, backend: jev([0, 0, 0.2, 0.7, 0.1]), messages: transcript(one.turns.slice(0, -1)) })
  await w.submit(one.turns.at(-1)?.text ?? '')

  const net = network((body) => answers(body, [0, 0, 0.2, 0.7, 0.1]))
  await run([one], net, ['zh-score'], settingsFrom({ typesafeApiKey: 'k' }))
  expect(w.requests).toHaveLength(1)
  expect(w.requests[0]?.body).toEqual({ model: JEV_MODEL, state: net.bodies[0].state, questions: net.bodies[0].questions })
  expect(String(net.bodies[0].state.recent_context)).toContain('DECISIVE')
})
