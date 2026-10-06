// The decision-report module (「决定汇报」, core/report.ts, ADR 0004) at seam 1: engine events in, the board data
// in $.state out (`w.board()`), plus what `/dp log` and the debug log say of it.

import { expect, test } from 'claude-code/testing'
import { jev, world, type Reply } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }

test("a decided message is on the board: its decision in the log (the level decided as data, beside its words), linked from the main agent's node of the turn it starts", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0.05, 0.1, 0.7, 0.1, 0.05]) })
  await w.submit('把登录模块重构成三层，并补上测试')

  const board = await w.board()
  expect(board.turn).toBe(1)
  expect(board.log).toHaveLength(1)
  expect(board.log[0]).toMatchObject({
    n: 1,
    turn: 1,
    feature: 'main-effort',
    agent: 'main',
    tone: 'ok',
    effort: 'high',
    outcome: 'effort high',
    subject: '"把登录模块重构成三层，并补上测试"',
    reason: '概率 low 0.05, medium 0.10, high 0.70, xhigh 0.10, max 0.05；置信度 0.70',
    conf: 0.7,
  })
  // The decision model's levels, as it gave them (the reading normalizes them, so to two decimals).
  expect(Object.values(board.log[0]?.probs ?? {}).map((p) => Math.round(p * 100) / 100)).toEqual([0.05, 0.1, 0.7, 0.1, 0.05])
  expect(Object.keys(board.log[0]?.probs ?? {})).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  expect(board.main).toMatchObject({ turn: 1, id: 'main', kind: 'main', name: '主 agent', routed: true, decision: 1 })
})

test("the main agent's decision carries the rule trace that picked its level: max held back, the round-up blocked by it", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0.05, 0.1, 0.4, 0.45]) })
  await w.submit('把登录模块重构成三层，并补上测试')

  const entry = (await w.board()).log[0]
  expect(entry).toMatchObject({ outcome: 'effort xhigh' })
  expect(entry?.trace?.map((step) => [step.rule, step.applied, step.level])).toEqual([
    ['top', true, 'max'],
    ['max-gate', true, 'xhigh'],
    ['round-up', false, 'xhigh'],
  ])
  expect(entry?.trace?.[1]).toMatchObject({ thetaMax: 0.5 })
  expect(entry?.trace?.[2]).toMatchObject({ above: 'max', blockedByMax: true, threshold: 0.3 })
})

// ---- a decision that could not be made ----------------------------------------

const FAILED: { name: string; backend: () => Reply; why: string; failure: Record<string, unknown> }[] = [
  { name: 'no answer in time', backend: () => ({ after: 60_000, reply: { status: 200, body: {} } }), why: 'jev：800 毫秒内没有回答', failure: { backend: 'jev', kind: 'timeout', detail: 'no answer in 800 ms' } },
  { name: 'the key is refused', backend: () => ({ status: 401, body: { detail: 'Invalid API key' } }), why: 'jev：密钥被拒绝（状态码 401）', failure: { backend: 'jev', kind: 'config', status: 401 } },
  { name: 'the network is down', backend: () => ({ reject: 'getaddrinfo ENOTFOUND api.typesafe.ai' }), why: 'jev：连不上', failure: { backend: 'jev', kind: 'network' } },
  { name: 'an answer without the effort question', backend: () => ({ status: 200, body: { model: 'jev-1.13.0', answers: {} } }), why: 'jev：回答读不懂', failure: { backend: 'jev', kind: 'parse', detail: 'no effort answer' } },
]

for (const failed of FAILED) {
  test(`${failed.name}: the main agent's node says it is not routed and why; nothing is logged as a decision`, { options: { ...KEY, timeoutMs: 800 } }, async ($, on) => {
    const w = world($, on, { backend: failed.backend })
    const submitting = w.submit('看看这个报错是怎么回事')
    await w.clock.settle()
    await w.clock.advance(800)
    await submitting
    await w.step({ index: 0, effort: 'medium' })

    const board = await w.board()
    expect(board.main).toMatchObject({ turn: 1, id: 'main', routed: false, why: failed.why, failure: failed.failure })
    expect(board.main?.decision).toBeUndefined()
    // A failed request is no decision: not in the log, not in the debug log (the core logs the request itself).
    expect(board.log).toEqual([])
    expect(w.logs.some((l) => l.text.startsWith('effort '))).toBe(false)
  })
}

test('a decision that comes back after a failure leaves the next turn routed, with nothing to explain', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => (n === 1 ? { status: 503, body: 'overloaded' } : jev([0, 1, 0, 0, 0])(request)) })
  await w.submit('第一条')
  await w.step({ index: 0, effort: 'xhigh' })
  expect((await w.board()).main).toMatchObject({ turn: 1, routed: false, why: 'jev：繁忙（状态码 503）' })

  await w.submit('第二条')
  await w.step({ index: 0, effort: 'xhigh' })
  const board = await w.board()
  expect(board.main).toMatchObject({ turn: 2, routed: true, effort: 'medium', decision: 1 })
  expect(board.main?.why).toBeUndefined()
  expect(board.main?.failure).toBeUndefined()
})

// ---- the reading ---------------------------------------------------------------

test("a step is read onto the main agent's node: the model by family, the effort it went out with, and whether it was routed", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0.05, 0.1, 0.7, 0.1, 0.05]) })
  await w.submit('把登录模块重构成三层')
  await w.step({ index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })

  expect((await w.board()).main).toMatchObject({ model: 'opus', effort: 'high', routed: true, state: 'running' })
  // The engine moves the turn to another model midway (an overload fallback): the latest step is the reading.
  await w.step({ index: 1, model: 'claude-sonnet-5-5', effort: 'max' })
  expect((await w.board()).main).toMatchObject({ model: 'sonnet', effort: 'high' })
})

test("a turn nobody decided is read as not routed, at the engine's effort", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  // A plugin's own message is nobody's decision.
  await w.submit('dashboard refreshed', { origin: { kind: 'plugin', name: 'other-mod' } })
  await w.step({ index: 0, effort: 'medium' })

  expect((await w.board()).main).toMatchObject({ turn: 1, effort: 'medium', routed: false })
  expect((await w.board()).log).toEqual([])
})

test("the person's lock is read as locked: the effort that went out, set by them", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]), session: true })
  await w.start()
  await w.command('dp', 'lock max')
  await w.submit('把登录模块重构成三层')
  await w.step({ index: 0, effort: 'xhigh' })
  expect((await w.board()).main).toMatchObject({ effort: 'max', locked: true, routed: true })

  await w.command('dp', 'unlock')
  await w.step({ index: 1, effort: 'xhigh' })
  const main = (await w.board()).main
  expect(main).toMatchObject({ effort: 'medium', routed: true })
  expect(main?.locked).toBeUndefined()
})

test('a model without effort is read without one: the node keeps the model, and no effort', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  await w.submit('解释一下这个函数')
  await w.step({ index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })
  expect((await w.board()).main?.effort).toBe('high')
  await w.step({ index: 1, model: 'claude-haiku-4-5-20251001', effort: null })

  const main = (await w.board()).main
  expect(main?.model).toBe('haiku')
  expect(main?.effort).toBeUndefined()
})

test('an integer effort budget is read as the engine sent it', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: () => ({ status: 500, body: 'down' }) })
  await w.submit('解释一下这个函数')
  await w.step({ index: 0, effort: 8000 })

  expect((await w.board()).main).toMatchObject({ effort: 8000, routed: false })
})

// ---- the turns -----------------------------------------------------------------

test('each message that starts a turn is the next turn: its decision is filed under it, the board counts them', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  expect((await w.board()).turn).toBe(0)
  await w.submit('第一条')
  await w.step({ index: 0 })
  await w.submit('第二条')
  await w.step({ index: 0 })

  const board = await w.board()
  expect(board.turn).toBe(2)
  expect(board.log.map((entry) => [entry.n, entry.turn, entry.subject])).toEqual([
    [1, 1, '"第一条"'],
    [2, 2, '"第二条"'],
  ])
  expect(board.main).toMatchObject({ turn: 2, decision: 2 })
})

test('a message typed while a turn runs is decided for that turn, not the next one', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  await w.submit('先看看目录结构')
  await w.step({ index: 0 })
  await w.submit('等等，顺便把那个并发问题查清楚', { turnId: 't1' })

  const board = await w.board()
  expect(board.turn).toBe(1)
  expect(board.log.map((entry) => entry.turn)).toEqual([1, 1])
})

test('the board holds the agents of the turn that runs and the one before it, no older', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  for (const text of ['一', '二', '三']) {
    await w.submit(text)
    await w.step({ index: 0 })
  }

  const board = await w.board()
  expect(board.nodes.map((node) => [node.turn, node.id])).toEqual([
    [2, 'main'],
    [3, 'main'],
  ])
})

// ---- what survives, and what must not stop anything ------------------------------

test('the board lives in $.state, so a hot reload of the mod keeps it: the count goes on from it, and what it holds is still there', { options: KEY }, async ($, on) => {
  // As an earlier load of the mod left it, three turns in.
  const node = { turn: 3, id: 'main', kind: 'main' as const, name: '主 agent', type: 'main', model: 'opus' as const, effort: 'high' as const, state: 'running' as const, t0: 0, routed: true, decision: 9 }
  const w = world($, on, { backend: jev([1, 0, 0, 0, 0]), seed: { board: { turn: 3, nodes: [{ ...node, turn: 2, decision: 8 }, node] } } })

  expect((await w.board()).main).toMatchObject({ turn: 3, effort: 'high', decision: 9 })
  await w.submit('改个错别字')
  await w.step({ index: 0 })

  const board = await w.board()
  expect(board.turn).toBe(4)
  // The turn before the new one stays, the one before that goes.
  expect(board.nodes.map((n) => n.turn)).toEqual([3, 4])
  expect(board.main).toMatchObject({ turn: 4, effort: 'low', decision: 1 })
})

test('a board that cannot be read stops nothing either: the decision is still logged and applied', { options: KEY }, async ($, on) => {
  on('state.get', { plugin: 'dispatch-pilot', key: 'board' }, () => ({ deny: 'the state cannot be read' }))
  const w = world($, on, { backend: jev([0.05, 0.1, 0.7, 0.1, 0.05]) })
  await w.submit('把登录模块重构成三层')
  await w.step({ index: 0, effort: 'xhigh' })

  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  expect((await w.board()).log.map((entry) => entry.outcome)).toEqual(['effort high'])
  expect(w.logs.map((l) => l.text)).toContainEqual(expect.stringMatching(/^board not read: /))
})

test('a board that cannot be written stops nothing: the decision is applied and logged, the debug log says what was lost', { options: KEY }, async ($, on) => {
  on('state.set', { plugin: 'dispatch-pilot', key: 'board' }, () => ({ deny: 'the state cannot be written' }))
  const w = world($, on, { backend: jev([0.05, 0.1, 0.7, 0.1, 0.05]) })
  await w.submit('把登录模块重构成三层')
  await w.step({ index: 0, effort: 'xhigh' })

  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  expect(w.prompts).toHaveLength(1)
  expect((await w.board()).log.map((entry) => entry.outcome)).toEqual(['effort high'])
  expect(w.logs.map((l) => l.text)).toContainEqual(expect.stringMatching(/^decision not kept on the board: /))
  expect(w.logs.map((l) => l.text)).toContainEqual(expect.stringMatching(/^reading not kept on the board: /))
})
