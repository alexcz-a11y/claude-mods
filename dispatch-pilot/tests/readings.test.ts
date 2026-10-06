// The readings (#27): what the board knows of every agent from the engine's own events. The core hands the module
// each step as it sends it (`turn.step`), the module's own hooks hear an agent spawned and a loop's turn end.
// Seam 1: engine events in, `w.board()` out. None of it routes anything: these tests run without a decision
// backend, so every step goes out as the engine made it and the board shows what that was.

import { expect, test } from 'claude-code/testing'
import { runWorld } from './support/workflow-run.ts'

/** A Workflow with one agent() call, as the main agent hands it to the tool. */
const SCRIPT = `export const meta = { name: 'audit', description: 'audit the api', phases: [] }
const a = await agent('Audit the auth module and list the risks.', { label: 'review-auth' })
return { a }
`

test('the main agent, a dispatched agent and Workflow agents each get a row: their model by family, their effort as it went out', async ($, on) => {
  const w = runWorld($, on, {})
  await w.submit('把这几个模块都审查一遍')
  await w.step({ index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })
  w.agents.push({ id: 'a1', description: '审查登录模块', type: 'Explore', status: 'running' })
  await w.spawn({ prompt: 'review login', description: '审查登录模块', subagentType: 'Explore' })
  await w.agentStep('a1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  await w.workflow({ script: SCRIPT })
  w.started('wf_test-1', 'wa1', 'review-auth')
  w.started('wf_test-1', 'wa2', 'review-billing')
  await w.agentStep('wa1', { index: 0, model: 'claude-haiku-4-5-20251001', effort: null })
  await w.agentStep('wa2', { index: 0, model: 'claude-opus-5-5', effort: 'high' })

  const board = await w.board()
  expect(board.main).toMatchObject({ id: 'main', kind: 'main', name: '主 agent', model: 'opus', effort: 'xhigh', state: 'running', routed: false })
  expect(board.agents.map((node) => node.id)).toEqual(['a1', 'wa1', 'wa2'])
  expect(board.agents[0]).toMatchObject({ kind: 'agent', name: '审查登录模块', type: 'Explore', model: 'sonnet', effort: 'medium', state: 'running' })
  expect(board.agents[1]).toMatchObject({ kind: 'wf', name: 'review-auth', type: 'workflow', model: 'haiku', state: 'running' })
  expect(board.agents[1]?.effort).toBeUndefined()
  expect(board.agents[2]).toMatchObject({ kind: 'wf', name: 'review-billing', model: 'opus', effort: 'high' })
})

test("a dispatched agent is named by its name, else by its description; a Workflow agent by its label", async ($, on) => {
  const w = runWorld($, on, {})
  await w.submit('开几个 agent')
  w.agents.push({ id: 'a1', name: 'login-reviewer', description: '审查登录模块', type: 'Explore', status: 'running' })
  w.agents.push({ id: 'a2', description: '写迁移脚本', type: 'general-purpose', status: 'running' })
  await w.agentStep('a1', { index: 0 })
  await w.agentStep('a2', { index: 0 })
  await w.workflow({ script: SCRIPT })
  w.started('wf_test-1', 'wa1', 'review-auth', 'phase one')
  await w.agentStep('wa1', { index: 0 })

  expect((await w.board()).agents.map((node) => [node.name, node.kind, node.type])).toEqual([
    ['login-reviewer', 'agent', 'Explore'],
    ['写迁移脚本', 'agent', 'general-purpose'],
    ['review-auth', 'wf', 'workflow'],
  ])
})

test("a loop nobody launched (an engine fork) is not an agent of the board; one the roster lists later is, from the step that finds it", async ($, on) => {
  const w = runWorld($, on, {})
  await w.submit('改个错别字')
  await w.step({ index: 0 })
  await w.agentStep('fork-1', { index: 0, model: 'claude-haiku-4-5-20251001', effort: null })
  expect((await w.board()).agents).toEqual([])

  w.agents.push({ id: 'fork-1', description: '总结上下文', type: 'general-purpose', status: 'running' })
  await w.agentStep('fork-1', { index: 1, model: 'claude-haiku-4-5-20251001', effort: null })
  expect((await w.board()).agents).toMatchObject([{ id: 'fork-1', name: '总结上下文', model: 'haiku' }])
})

test("a Workflow agent whose run is not yet recorded when it starts is found by a later step, and starts when it first stepped", async ($, on) => {
  const w = runWorld($, on, {})
  await w.submit('跑一个 workflow')
  await w.step({ index: 0 })
  await w.clock.advance(200)
  await w.agentStep('wa1', { index: 0 })
  expect((await w.board()).agents).toEqual([])
  await w.clock.advance(300)
  await w.workflow({ script: SCRIPT })
  w.started('wf_test-1', 'wa1', 'review-auth')
  await w.clock.advance(100)
  await w.agentStep('wa1', { index: 1 })

  const wa1 = (await w.board()).agents[0]
  expect(wa1).toMatchObject({ id: 'wa1', name: 'review-auth', state: 'running' })
  // Seen first 300 ms before the run was recorded, 200 ms into the turn.
  expect(wa1?.t0).toBe(0.2)
})

test('a fan-out of Workflow agents stepping at once each get their row: no reading is lost to the others writing the board', async ($, on) => {
  const w = runWorld($, on, {})
  await w.submit('跑一个大的 workflow')
  await w.workflow({ script: SCRIPT })
  const ids = Array.from({ length: 16 }, (_, i) => `wa${i + 1}`)
  for (const id of ids) w.started('wf_test-1', id, `review-${id}`)
  await Promise.all(ids.map((id) => w.agentStep(id, { index: 0, model: 'claude-sonnet-5-5', effort: 'low' })))

  expect((await w.board()).agents.map((node) => node.id).sort()).toEqual([...ids].sort())
  expect(w.logs.filter((line) => line.text.startsWith('reading not kept'))).toEqual([])
})

// ---- the changes ----------------------------------------------------------------

test('an effort change makes exactly one event; steps that read the same make none, and the first reading is no change', async ($, on) => {
  const w = runWorld($, on, {})
  await w.submit('重构登录模块')
  await w.step({ index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })
  await w.step({ index: 1, model: 'claude-opus-5-5', effort: 'xhigh' })
  expect((await w.board()).changes).toEqual([])
  await w.clock.advance(4000)
  await w.step({ index: 2, model: 'claude-opus-5-5', effort: 'high' })
  await w.step({ index: 3, model: 'claude-opus-5-5', effort: 'high' })

  expect((await w.board()).changes).toEqual([{ turn: 1, id: 'main', at: 4, after: 0, from: { model: 'opus', effort: 'xhigh' }, to: { model: 'opus', effort: 'high' } }])
})

test('each agent is compared with its own previous step: one agent changing does not make the other one change', async ($, on) => {
  const w = runWorld($, on, {})
  await w.submit('开两个 agent')
  w.agents.push({ id: 'a1', description: 'one', type: 'Explore', status: 'running' }, { id: 'a2', description: 'two', type: 'Explore', status: 'running' })
  await w.agentStep('a1', { index: 0, model: 'claude-sonnet-5-5', effort: 'low' })
  await w.agentStep('a2', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  await w.agentStep('a1', { index: 1, model: 'claude-sonnet-5-5', effort: 'low' })
  await w.agentStep('a2', { index: 1, model: 'claude-sonnet-5-5', effort: 'high' })
  await w.agentStep('a1', { index: 2, model: 'claude-sonnet-5-5', effort: 'low' })

  expect((await w.board()).changes.map((change) => [change.id, change.from.effort, change.to.effort])).toEqual([['a2', 'medium', 'high']])
})

test('models are compared by family: the id an engine retry reports for the same model is no change, another family is', async ($, on) => {
  const w = runWorld($, on, {})
  await w.submit('开一个 agent')
  w.agents.push({ id: 'a1', description: 'one', type: 'Explore', status: 'running' })
  await w.agentStep('a1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  await w.agentStep('a1', { index: 1, model: 'claude-sonnet-5', effort: 'medium' })
  expect((await w.board()).changes).toEqual([])
  expect((await w.board()).agents[0]).toMatchObject({ model: 'sonnet', effort: 'medium' })

  await w.agentStep('a1', { index: 2, model: 'claude-opus-5-5', effort: 'medium' })
  expect((await w.board()).changes).toMatchObject([{ id: 'a1', from: { model: 'sonnet', effort: 'medium' }, to: { model: 'opus', effort: 'medium' } }])
})

test('a haiku step has no effort and is read as it is: no effort on the node, and no change event for a step that reads the same', async ($, on) => {
  const w = runWorld($, on, {})
  await w.submit('开一个 agent')
  w.agents.push({ id: 'a1', description: 'one', type: 'Explore', status: 'running' })
  await w.agentStep('a1', { index: 0, model: 'claude-haiku-4-5-20251001', effort: null })
  await w.agentStep('a1', { index: 1, model: 'claude-haiku-4-5-20251001', effort: null })
  const haiku = (await w.board()).agents[0]
  expect(haiku).toMatchObject({ model: 'haiku', state: 'running' })
  expect(haiku?.effort).toBeUndefined()
  expect((await w.board()).changes).toEqual([])

  // Moved off haiku: the model and the effort it now takes are one change.
  await w.agentStep('a1', { index: 2, model: 'claude-sonnet-5-5', effort: 'medium' })
  expect((await w.board()).changes).toMatchObject([{ id: 'a1', from: { model: 'haiku' }, to: { model: 'sonnet', effort: 'medium' } }])
})

test("a change is placed after the decision made before it: the event carries the log's latest number", async ($, on) => {
  const w = runWorld($, on, { seed: { log: [{ n: 7, turn: 1, feature: 'midturn-effort', agent: 'main', tone: 'ok', outcome: 'effort high', subject: '', reason: 'x' }] } })
  await w.submit('重构登录模块')
  await w.step({ index: 0, effort: 'xhigh' })
  await w.step({ index: 1, effort: 'high' })

  expect((await w.board()).changes).toMatchObject([{ id: 'main', after: 7 }])
})

// ---- reading only ---------------------------------------------------------------

test('the readings change nothing a step goes out with: an agent nobody routed, or found by no one, is sent as the engine made it', async ($, on) => {
  const w = runWorld($, on, {})
  await w.submit('开几个 agent')
  w.agents.push({ id: 'a1', description: 'one', type: 'Explore', status: 'running' })
  await w.agentStep('a1', { index: 0, model: 'claude-sonnet-5', effort: 'medium' })
  await w.agentStep('a1', { index: 1, model: 'claude-haiku-4-5-20251001', effort: null })
  await w.agentStep('stranger', { index: 0, model: 'claude-opus-5-5', effort: 'max' })
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 8000 })

  expect(w.steps.map((step) => [step.agentId, step.model, step.effort])).toEqual([
    ['a1', 'claude-sonnet-5', 'medium'],
    ['a1', 'claude-haiku-4-5-20251001', undefined],
    ['stranger', 'claude-opus-5-5', 'max'],
    ['wa1', 'claude-sonnet-5-5', 8000],
  ])
})

test('a roster that cannot be read, and a board that cannot be written, stop no step', async ($, on) => {
  on('state.set', { plugin: 'dispatch-pilot', key: 'board' }, () => ({ deny: 'the state cannot be written' }))
  const w = runWorld($, on, { agents: { deny: 'no roster' } })
  await w.submit('开一个 agent')
  await w.agentStep('a1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  await w.complete({ agentId: 'a1' })

  expect(w.steps.map((step) => [step.agentId, step.effort])).toEqual([['a1', 'medium']])
})

// ---- states and time ------------------------------------------------------------

test("a dispatched agent is queued from its spawn to its first step, running until its loop ends, then done for as long as it ran", async ($, on) => {
  const w = runWorld($, on, {})
  await w.submit('开一个 agent')
  await w.step({ index: 0 })
  await w.clock.advance(2000)
  w.agents.push({ id: 'a1', description: '审查登录模块', type: 'Explore', status: 'running' })
  await w.spawn({ prompt: 'review login', description: '审查登录模块', subagentType: 'Explore' })
  expect((await w.board()).agents).toMatchObject([{ id: 'a1', name: '审查登录模块', type: 'Explore', state: 'queued', t0: 2 }])

  await w.clock.advance(1500)
  await w.agentStep('a1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  expect((await w.board()).agents[0]).toMatchObject({ state: 'running', t0: 3.5, model: 'sonnet' })

  await w.complete({ agentId: 'a1', durationMs: 4200 })
  const done = (await w.board()).agents[0]
  expect(done).toMatchObject({ state: 'done', t0: 3.5, dur: 4.2 })
  expect(done?.why).toBeUndefined()
})

test('a loop that ends in an error, a refusal or an interruption is failed, and says which; the main agent too', async ($, on) => {
  const w = runWorld($, on, {})
  await w.submit('开几个 agent')
  await w.step({ index: 0 })
  for (const id of ['a1', 'a2']) w.agents.push({ id, description: id, type: 'Explore', status: 'running' })
  await w.agentStep('a1', { index: 0 })
  await w.agentStep('a2', { index: 0 })
  await w.complete({ agentId: 'a1', reason: 'error' })
  await w.complete({ agentId: 'a2', reason: 'aborted' })
  await w.complete({ reason: 'error', durationMs: 9000 })

  const board = await w.board()
  expect(board.agents.map((node) => [node.id, node.state, node.why])).toEqual([
    ['a1', 'failed', 'error'],
    ['a2', 'failed', 'aborted'],
  ])
  // Its own reason for not being routed (no decision key here) stays the reason it shows.
  expect(board.main).toMatchObject({ state: 'failed', dur: 9, failure: { kind: 'config' } })
})

test("the main agent runs from the turn's start (t0 0) until its turn ends, then is done; a Workflow agent is done when its own loop ends", async ($, on) => {
  const w = runWorld($, on, {})
  await w.submit('跑一个 workflow')
  await w.step({ index: 0 })
  await w.workflow({ script: SCRIPT })
  w.started('wf_test-1', 'wa1', 'review-auth')
  await w.clock.advance(1000)
  await w.agentStep('wa1', { index: 0 })
  // The main turn ends while the Workflow's agent still runs.
  await w.complete({ durationMs: 1500 })
  expect((await w.board()).main).toMatchObject({ state: 'done', t0: 0, dur: 1.5 })
  expect((await w.board()).agents[0]).toMatchObject({ id: 'wa1', state: 'running', t0: 1 })

  await w.clock.advance(5000)
  await w.complete({ agentId: 'wa1', durationMs: 5200 })
  expect((await w.board()).agents[0]).toMatchObject({ state: 'done', dur: 5.2 })
})

test('an agent that steps again after its loop ended runs again in the same turn: one row, no duration', async ($, on) => {
  const w = runWorld($, on, {})
  await w.submit('开一个 agent')
  w.agents.push({ id: 'a1', description: 'one', type: 'Explore', status: 'running' })
  await w.agentStep('a1', { index: 0 })
  await w.complete({ agentId: 'a1', durationMs: 800 })
  await w.agentStep('a1', { index: 0 })

  const agents = (await w.board()).agents
  expect(agents).toHaveLength(1)
  expect(agents[0]).toMatchObject({ state: 'running' })
  expect(agents[0]?.dur).toBeUndefined()
})

// ---- turns ----------------------------------------------------------------------

test('each turn is stamped when it starts, and an agent counts its time from its own turn', async ($, on) => {
  const w = runWorld($, on, {})
  await w.submit('第一条')
  await w.clock.advance(10_000)
  await w.submit('第二条')
  await w.clock.advance(2000)
  w.agents.push({ id: 'a1', description: 'one', type: 'Explore', status: 'running' })
  await w.agentStep('a1', { index: 0 })

  const board = await w.board()
  expect(board.starts.map((start) => start.turn)).toEqual([1, 2])
  expect((board.starts[1]?.at ?? 0) - (board.starts[0]?.at ?? 0)).toBe(10_000)
  expect(board.agents[0]).toMatchObject({ turn: 2, t0: 2 })
})

test("an agent still running when the next turn starts goes on in the turn it began in; one that had ended starts a row in the new turn", async ($, on) => {
  const w = runWorld($, on, {})
  await w.submit('第一条')
  for (const id of ['a1', 'a2']) w.agents.push({ id, description: id, type: 'Explore', status: 'running' })
  await w.agentStep('a1', { index: 0, effort: 'low' })
  await w.agentStep('a2', { index: 0 })
  await w.complete({ agentId: 'a2' })
  await w.complete()
  await w.submit('第二条')
  await w.clock.advance(3000)
  await w.agentStep('a1', { index: 1, effort: 'high' })
  await w.agentStep('a2', { index: 0 })

  const board = await w.board()
  const rows = board.nodes.filter((node) => node.id !== 'main').sort((x, y) => x.turn - y.turn || x.id.localeCompare(y.id))
  expect(rows.map((node) => [node.turn, node.id, node.state])).toEqual([
    [1, 'a1', 'running'],
    [1, 'a2', 'done'],
    [2, 'a2', 'running'],
  ])
  // The change is the first turn's, counted from the first turn's start.
  expect(board.changes).toMatchObject([{ turn: 1, id: 'a1', from: { effort: 'low' }, to: { effort: 'high' } }])
  expect(board.changes[0]?.at).toBe(3)
})

test('a hot reload keeps what the readings wrote: the node goes on from its stored start and the stored events stay', async ($, on) => {
  const node = { turn: 1, id: 'a1', kind: 'agent' as const, name: 'one', type: 'Explore', model: 'sonnet' as const, effort: 'low' as const, state: 'running' as const, t0: 2.5, routed: false }
  const change = { turn: 1, id: 'a1', at: 3, after: 0, from: { model: 'sonnet' as const, effort: 'medium' as const }, to: { model: 'sonnet' as const, effort: 'low' as const } }
  const w = runWorld($, on, { seed: { board: { turn: 1, starts: [{ turn: 1, at: 1000 }], changes: [change], nodes: [node] } } })
  w.agents.push({ id: 'a1', description: 'one', type: 'Explore', status: 'running' })
  await w.agentStep('a1', { index: 4, model: 'claude-sonnet-5-5', effort: 'high' })

  const board = await w.board()
  expect(board.agents[0]).toMatchObject({ t0: 2.5, effort: 'high', state: 'running' })
  expect(board.changes).toHaveLength(2)
  expect(board.changes[0]).toEqual(change)
})
