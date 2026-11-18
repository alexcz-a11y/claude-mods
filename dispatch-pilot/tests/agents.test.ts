import { expect, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { AgentSpawnInput } from 'claude-code'

import { START } from '../hooks/decide.ts'
import type { Decision } from '../hooks/log.ts'
import { AGENT_TYPES_KEEP, knownType, learnType } from '../hooks/agents.ts'
import type { AgentState, SessionState } from '../hooks/state.ts'
import { scriptByPoll } from './support/rows.ts'
import { KEYS, NO_BACKEND, appendAll, dp, drexOk, noul, score, spawn, start, step, turnStart, world } from './support/world.ts'

type World = ReturnType<typeof world>

// What the mod recorded and wrote, and what reached the engine.
const logged = (w: World): Decision[] => (w.storeWrites.filter((s) => s.key === 'log').at(-1)?.value ?? []) as Decision[]
const recent = (w: World): Decision[] => (w.stateWrites.filter((s) => s.key === 'recent' && s.isSet).at(-1)?.value ?? []) as Decision[]
/** The agents family's entry for one agent, as last written. */
const entry = (w: World, id: string): AgentState | undefined => w.stateWrites.filter((s) => s.key === 'agents' && s.id === id && s.isSet).at(-1)?.value as AgentState | undefined
const agentWrites = (w: World) => w.stateWrites.filter((s) => s.key === 'agents')
/** What the session holds of the agent types, as last written. */
const types = (w: World) => (w.stateWrites.filter((s) => s.key === 'session' && s.isSet).at(-1)?.value as SessionState | undefined)?.agentTypes
/** The requests about an agent (only they ask read_only). */
const asked = (w: World) => w.fetched.filter((f) => 'read_only' in f.body.questions)
/** The efforts of one loop's steps as they reached the engine; agentId undefined: the main loop's. */
const effortsOf = (w: World, agentId: string | undefined): unknown[] => w.stepsSent.filter((s) => s.agentId === agentId).map((s) => s.effort)

const OPUS = 'claude-opus-5-5'
const FABLE = 'claude-fable-5-2'
const HAIKU = 'claude-haiku-5-5'
const SONNET = 'claude-sonnet-5-5'
/** The detail of a spawn whose model the mod left alone, not knowing yet whether its type follows the parent's model. */
const UNKNOWN = '模型没动：还不知道这个类型是否沿用主 agent 的模型'

// Answers about an agent's task, read from high (the main turn's level in every test).
// Holds at high; nothing reads yes; no tier down.
const HOLD = { open: score([0.05, 0.3, 0.3, 0.3, 0.05]), mechanical: noul(0.1), unknown_cause: noul(0.1), read_only: noul(0.1) }
// Read-only and mechanical: effort capped at medium, the lowest tier allowed.
const LOOKUP = { open: score([0.05, 0.3, 0.3, 0.3, 0.05]), mechanical: noul(0.9), unknown_cause: noul(0.1), read_only: noul(0.9) }
// Little is open (0.9 on the two lowest levels): medium, one tier down.
const EASY = { open: score([0.5, 0.4, 0.05, 0.05, 0]), mechanical: noul(0.1), unknown_cause: noul(0.1), read_only: noul(0.1) }
// Very open (0.85 above high, over the stricter bar 0.8): xhigh, the tier kept.
const HARD = { open: score([0, 0.05, 0.1, 0.8, 0.05]), mechanical: noul(0.1), unknown_cause: noul(0.1), read_only: noul(0.1) }

const agentAnswer = (a: Record<string, unknown>) => () => drexOk(a)

/** A row of $.agent.list() for one agent; effort only when given. */
function info(id: string, o: { effort?: string } = {}) {
  return {
    id,
    description: 'Find the retry',
    type: 'general-purpose',
    status: 'running',
    kind: 'local_agent',
    taskStatus: 'running',
    label: 'Find the retry',
    startTime: 0,
    cwd: '/work',
    model: 'claude-haiku-5-5',
    ...(o.effort === undefined ? {} : { effort: o.effort }),
  }
}

// The main loop at high: a turn no message decision set starts from its step 0's level (base).
async function mainAtHigh($: Engine) {
  await start($)
  await turnStart($, 't1', 'Fix the flaky retry in the uploader')
  await step($, { turnId: 't1', index: 0, effort: 'high' })
}

/**
 * The first spawn of a type under a parent: the mod gives it no model and learns what it ran on (design 5.5). Its own
 * request and Decision are those of any spawn; the tests that look at a later spawn count them in.
 */
function teach($: Engine, o: Partial<AgentSpawnInput> = {}) {
  return spawn($, { tool_use_id: 'toolu_teach', ...o })
}

/** Runs n steps of an agent's loop, each at the engine's level. */
async function agentSteps($: Engine, agentId: string, n: number, effort: unknown = 'high') {
  for (let index = 0; index < n; index++) await step($, { turnId: `a-${agentId}`, index, effort, model: 'claude-haiku-5-5', agentId })
}

// The brief's ten.

test('派出时发一个请求，state.task 是任务原文；只读又机械的任务用 haiku（这个类型第二次派出起），之后每步写定下的 effort', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP), agents: [info('agent-2')] })
  await mainAtHigh($)
  const task = 'List every file under src/ that imports the retry helper.'
  const first = await teach($, { prompt: task, description: 'List retry users', subagentType: 'Explore' })
  const r = await spawn($, { prompt: task, description: 'List retry users', subagentType: 'Explore' })
  await agentSteps($, 'agent-2', 3)

  expect(asked(w)).toHaveLength(2)
  expect(w.fetched).toHaveLength(2)
  expect(Object.keys(w.fetched[1]!.body.questions)).toEqual(['open', 'mechanical', 'unknown_cause', 'read_only'])
  expect(w.fetched[1]!.body.state).toMatchObject({ task, agent_type: 'Explore', description: 'List retry users' })
  // The first spawn of the type is left alone: it ran on the parent's model, so the type follows it. The second gets
  // the alias; the engine answers with the id it resolved.
  expect(w.spawned.map((s) => s.model)).toEqual([undefined, 'haiku'])
  expect(first).toEqual({ model: OPUS, agentId: 'agent-1' })
  expect(r).toEqual({ model: HAIKU, agentId: 'agent-2' })
  expect(effortsOf(w, 'agent-2')).toEqual(['medium', 'medium', 'medium'])
  // The main loop's own step is untouched.
  expect(effortsOf(w, undefined)).toEqual(['high'])

  const d = logged(w)
  expect(d).toHaveLength(2)
  expect(d[0]).toMatchObject({ kind: 'agent', from: '? · high', to: 'inherit · medium', detail: 'Explore · ' + UNKNOWN, applied: true })
  expect(d[1]).toMatchObject({ kind: 'agent', from: 'opus · high', to: 'haiku · medium', reason: 'mechanical', detail: 'Explore', applied: true, turnId: 't1' })
  expect(entry(w, 'agent-2')).toMatchObject({ effort: 'medium', isEffortExplicit: false, decisionId: d[1]!.id, steps: 3 })
  // $.agent.list() is asked twice: at the agent's first step whether its effort is its own, and at its second for what
  // the first request carried (Task 11; this row has no lastRequest, so the check is unverified).
  expect(w.listed.calls).toBe(2)
  expect(d[1]!.sent).toBe('unverified')
})

test('fork、续跑、workflow 的 agent：不发请求，模型不动', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP) })
  await mainAtHigh($)
  const fork = { subagentType: 'fork', fork: true, parentModel: FABLE }
  const resume = { resume: { agentId: 'agent-old' }, parentModel: FABLE }
  const workflow = { workflow: { runId: 'wf_1', agentIndex: 1 }, parentModel: FABLE }
  // Twice each: what the first ran on teaches the mod nothing about them either.
  const rs: Awaited<ReturnType<typeof spawn>>[] = []
  for (let i = 0; i < 2; i++) rs.push(await spawn($, fork), await spawn($, resume), await spawn($, workflow))
  for (let n = 1; n <= 6; n++) await agentSteps($, 'agent-' + n, 2)

  expect(w.fetched).toHaveLength(0)
  // Each reached the engine as it was given: no model, not even the fableAgents cap.
  expect(w.spawned).toHaveLength(6)
  expect(w.spawned.map((s) => s.model)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined])
  expect(w.spawned[0]).toMatchObject({ fork: true, subagentType: 'fork' })
  expect(w.spawned[1]!.resume).toEqual({ agentId: 'agent-old' })
  expect(w.spawned[2]!.workflow).toEqual({ runId: 'wf_1', agentIndex: 1 })
  expect(rs.map((r) => r.model)).toEqual([FABLE, FABLE, FABLE, FABLE, FABLE, FABLE])
  for (let n = 1; n <= 6; n++) expect(effortsOf(w, 'agent-' + n)).toEqual(['high', 'high'])
  expect(logged(w)).toHaveLength(0)
  expect(agentWrites(w)).toHaveLength(0)
  expect(types(w)).toEqual([])
  expect(w.listed.calls).toBe(0)
})

test('派出时明写了模型：模型不改，仍然定 effort；也不从它学这个类型', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP) })
  await mainAtHigh($)
  const r = await spawn($, { model: 'sonnet' })
  const again = await spawn($, { model: 'sonnet', tool_use_id: 'toolu_2' })
  await agentSteps($, 'agent-1', 2)

  expect(asked(w)).toHaveLength(2)
  // The answers would pick haiku; the call named sonnet, and sonnet is what reached the engine.
  expect(w.spawned.map((s) => s.model)).toEqual(['sonnet', 'sonnet'])
  expect([r, again]).toEqual([
    { model: SONNET, agentId: 'agent-1' },
    { model: SONNET, agentId: 'agent-2' },
  ])
  expect(effortsOf(w, 'agent-1')).toEqual(['medium', 'medium'])
  // The type's own model is not known (the call chose one): from says so, and the call's model is not taken for it.
  expect(logged(w)[0]).toMatchObject({ kind: 'agent', from: '? · high', to: 'sonnet · medium', reason: 'mechanical', detail: 'general-purpose', applied: true })
  expect(entry(w, 'agent-1')).toMatchObject({ effort: 'medium', steps: 2 })
  expect(types(w)).toEqual([])
})

test('主 agent 是 Fable、fableAgents 关着：沿用主 agent 模型的类型从第二次起是 opus，后端失败时也是', { options: KEYS }, async ($, on) => {
  const net = { down: false }
  const w = world(on, { answer: () => (net.down ? null : drexOk(HOLD)) })
  await mainAtHigh($)
  const first = await teach($, { parentModel: FABLE })
  const ok = await spawn($, { parentModel: FABLE })
  net.down = true
  const failed = await spawn($, { parentModel: FABLE, tool_use_id: 'toolu_2' })
  for (const id of ['agent-1', 'agent-2', 'agent-3']) await agentSteps($, id, 2)

  expect(asked(w)).toHaveLength(3)
  expect(w.spawned.map((s) => s.model)).toEqual([undefined, 'opus', 'opus'])
  expect([first.model, ok.model, failed.model]).toEqual([FABLE, OPUS, OPUS])
  // The answered ones get their effort; the failed one is not handled beyond the cap.
  expect(effortsOf(w, 'agent-2')).toEqual(['high', 'high'])
  expect(effortsOf(w, 'agent-3')).toEqual(['high', 'high'])
  expect(entry(w, 'agent-2')).toMatchObject({ effort: 'high' })
  expect(entry(w, 'agent-3')).toMatchObject({ effort: null })
  const d = logged(w)
  expect(d).toHaveLength(3)
  expect(d[0]).toMatchObject({ from: '? · high', to: 'inherit · high', detail: 'general-purpose · ' + UNKNOWN, applied: true })
  expect(d[1]).toMatchObject({ from: 'fable · high', to: 'opus · high', reason: 'hold', failure: null, detail: 'general-purpose', applied: true })
  expect(d[2]).toMatchObject({ from: 'fable · high', to: 'opus · —', reason: null, raw: null, bars: null, model: null, failure: 'network', backend: 'drex', applied: true })
})

test('fableAgents 开着：继承 fable 不改', { options: { ...KEYS, fableAgents: true } }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(HOLD) })
  await mainAtHigh($)
  await teach($, { parentModel: FABLE })
  const r = await spawn($, { parentModel: FABLE })
  await agentSteps($, 'agent-2', 1, 'medium')

  expect(asked(w)).toHaveLength(2)
  expect(w.spawned.map((s) => s.model)).toEqual([undefined, undefined])
  expect(r.model).toBe(FABLE)
  // The effort decided from the main turn's high is still written over the engine's medium.
  expect(effortsOf(w, 'agent-2')).toEqual(['high'])
  expect(logged(w)[1]).toMatchObject({ from: 'fable · high', to: 'inherit · high', reason: 'hold', applied: true })
})

test('明写了 fable 的 agent 不受开关影响', { options: KEYS }, async ($, on) => {
  const net = { down: false }
  const w = world(on, { answer: () => (net.down ? null : drexOk(LOOKUP)) })
  await mainAtHigh($)
  const asOpus = await spawn($, { model: 'fable' })
  net.down = true
  const asFable = await spawn($, { model: 'fable', parentModel: FABLE })

  expect(asked(w)).toHaveLength(2)
  expect(w.spawned.map((s) => s.model)).toEqual(['fable', 'fable'])
  expect([asOpus.model, asFable.model]).toEqual([FABLE, FABLE])
  const d = logged(w)
  expect(d.map((x) => [x.from, x.to, x.failure])).toEqual([
    ['? · high', 'fable · medium', null],
    ['? · high', 'fable · —', 'network'],
  ])
})

test('同时派出两个 agent：各按各的回答定，互不串（Review Focus 5）', { options: KEYS }, async ($, on) => {
  const late: { clock: MockClock | null } = { clock: null }
  const LIST = 'List every caller of retry().'
  const DESIGN = 'Design a new backoff for the uploader that survives restarts.'
  const w = world(on, {
    answer: async ({ body }) => {
      // The lookup answers last, so the two requests are both out before either comes back.
      const lookup = body.state.task === LIST
      await late.clock!.sleep(lookup ? 500 : 100)
      return drexOk(lookup ? LOOKUP : HARD)
    },
  })
  late.clock = w.clock
  await mainAtHigh($)
  // Both types are seen once first, so the pair below may get a model.
  const taught = Promise.all([teach($, { prompt: LIST, subagentType: 'Explore' }), teach($, { prompt: DESIGN, subagentType: 'Plan' })])
  await w.clock.settle()
  await w.clock.advance(500)
  await taught
  const both = Promise.all([spawn($, { prompt: LIST, subagentType: 'Explore', tool_use_id: 'toolu_a' }), spawn($, { prompt: DESIGN, subagentType: 'Plan', tool_use_id: 'toolu_b' })])
  await w.clock.settle()
  expect(asked(w)).toHaveLength(4)
  expect(w.spawned).toHaveLength(2)
  await w.clock.advance(500)
  const [list, design] = await both

  // The design answered first and reached the engine first.
  expect(w.spawned.slice(2).map((s) => [s.tool_use_id, s.model])).toEqual([
    ['toolu_b', undefined],
    ['toolu_a', 'haiku'],
  ])
  expect(list).toEqual({ model: HAIKU, agentId: 'agent-4' })
  expect(design).toEqual({ model: OPUS, agentId: 'agent-3' })
  await agentSteps($, list.agentId!, 2)
  await agentSteps($, design.agentId!, 2)
  expect(effortsOf(w, list.agentId!)).toEqual(['medium', 'medium'])
  expect(effortsOf(w, design.agentId!)).toEqual(['xhigh', 'xhigh'])

  const d = logged(w).slice(2)
  expect(d).toHaveLength(2)
  const byType = Object.fromEntries(d.map((x) => [x.detail, x]))
  expect(byType.Plan).toMatchObject({ to: 'inherit · xhigh', reason: 'more-open' })
  expect(byType.Explore).toMatchObject({ to: 'haiku · medium', reason: 'mechanical' })
  expect(recent(w).map((x) => x.id).sort()).toEqual(logged(w).map((x) => x.id).sort())
  expect(entry(w, list.agentId!)).toMatchObject({ effort: 'medium', decisionId: byType.Explore!.id })
  expect(entry(w, design.agentId!)).toMatchObject({ effort: 'xhigh', decisionId: byType.Plan!.id })
})

test('时限到了：原样放行，这个 agent 之后每步的 effort 也不写', { options: KEYS }, async ($, on) => {
  const late: { clock: MockClock | null } = { clock: null }
  const w = world(on, {
    answer: async () => {
      await late.clock!.sleep(60_000)
      return drexOk(LOOKUP)
    },
  })
  late.clock = w.clock
  await mainAtHigh($)
  const pending = spawn($)
  await w.clock.settle()
  expect(w.spawned).toHaveLength(0)
  await w.clock.advance(3000)
  const r = await pending
  await agentSteps($, 'agent-1', 3)

  expect(asked(w)).toHaveLength(1)
  expect(w.spawned.map((s) => s.model)).toEqual([undefined])
  expect(r).toEqual({ model: OPUS, agentId: 'agent-1' })
  expect(effortsOf(w, 'agent-1')).toEqual(['high', 'high', 'high'])
  expect(logged(w)[0]).toMatchObject({ kind: 'agent', failure: 'timeout', ms: 3000, from: '? · high', to: 'inherit · —', reason: null, applied: false })
  expect(entry(w, 'agent-1')).toMatchObject({ effort: null, steps: 3 })
  expect(w.listed.calls).toBe(0)
})

test('agent 明写了 effort（agent.list 里有值）：不写 effort', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP), agents: [info('agent-2', { effort: 'low' })] })
  await mainAtHigh($)
  await teach($)
  await spawn($)
  await agentSteps($, 'agent-2', 3, 'low')

  expect(asked(w)).toHaveLength(2)
  // The model is still decided; the effort its definition set is left as it is.
  expect(w.spawned.map((s) => s.model)).toEqual([undefined, 'haiku'])
  expect(effortsOf(w, 'agent-2')).toEqual(['low', 'low', 'low'])
  // Once for the explicit effort, once for the readout at the second step (Task 11).
  expect(w.listed.calls).toBe(2)
  expect(entry(w, 'agent-2')).toMatchObject({ effort: 'medium', isEffortExplicit: true, decisionId: logged(w)[1]!.id, steps: 3 })
})

test('agent 的第一步比 agent.spawn 的结果先到：这一步原样放行，下一步起写定下的 effort', { options: KEYS }, async ($, on) => {
  const order: string[] = []
  const w = world(on, {
    answer: agentAnswer(LOOKUP),
    agents: [info('agent-2')],
    // The engine starts the agent inside agent.spawn's next(e): its first step runs before the answer is back.
    onSpawn: async (_e, agentId) => {
      if (agentId !== 'agent-2') return
      await step($, { turnId: 'a2', index: 0, effort: 'high', model: HAIKU, agentId })
      order.push('first step')
    },
  })
  await mainAtHigh($)
  await teach($)
  const r = await spawn($)
  order.push('spawn answered')
  await step($, { turnId: 'a2', index: 1, effort: 'high', model: HAIKU, agentId: 'agent-2' })
  await step($, { turnId: 'a2', index: 2, effort: 'high', model: HAIKU, agentId: 'agent-2' })

  expect(order).toEqual(['first step', 'spawn answered'])
  expect(r).toEqual({ model: HAIKU, agentId: 'agent-2' })
  expect(effortsOf(w, 'agent-2')).toEqual(['high', 'medium', 'medium'])
  // The early step wrote nothing; the entry counts the steps it saw.
  expect(entry(w, 'agent-2')).toMatchObject({ effort: 'medium', isEffortExplicit: false, decisionId: logged(w)[1]!.id, steps: 2 })
  // Once for the explicit effort at the first step the entry saw, once for the readout at the second (Task 11).
  expect(w.listed.calls).toBe(2)
})

// The model is changed only for a type known to follow the parent's model (final review C1, measured on 2.1.327: a
// call that names no model runs on the type's own definition's model when it has one).

test('定义里写了 haiku 的类型、主 agent 是 opus：第一次和之后都不给模型，不往上换', { options: KEYS }, async ($, on) => {
  // EASY reads one tier down from opus: sonnet, which is up from the type's own haiku.
  const w = world(on, { answer: agentAnswer(EASY), typeModels: { Explore: 'haiku' } })
  await mainAtHigh($)
  const rs: Awaited<ReturnType<typeof spawn>>[] = []
  for (const id of ['toolu_1', 'toolu_2', 'toolu_3']) rs.push(await spawn($, { subagentType: 'Explore', tool_use_id: id }))

  expect(asked(w)).toHaveLength(3)
  expect(w.spawned.map((s) => s.model)).toEqual([undefined, undefined, undefined])
  expect(rs.map((r) => r.model)).toEqual([HAIKU, HAIKU, HAIKU])
  // The effort is decided as before.
  const d = logged(w)
  expect(d.map((x) => [x.from, x.to, x.detail])).toEqual([
    ['? · high', 'inherit · medium', 'Explore · ' + UNKNOWN],
    ['haiku · high', 'inherit · medium', 'Explore'],
    ['haiku · high', 'inherit · medium', 'Explore'],
  ])
  expect(types(w)).toEqual([{ type: 'Explore', tier: 'haiku', parentTier: 'opus' }])
})

test('沿用主 agent 模型的类型：第一次不动，第二次起照回答往下换', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(EASY) })
  await mainAtHigh($)
  const rs: Awaited<ReturnType<typeof spawn>>[] = []
  for (const id of ['toolu_1', 'toolu_2', 'toolu_3']) rs.push(await spawn($, { tool_use_id: id }))

  expect(w.spawned.map((s) => s.model)).toEqual([undefined, 'sonnet', 'sonnet'])
  expect(rs.map((r) => r.model)).toEqual([OPUS, SONNET, SONNET])
  expect(logged(w).map((x) => [x.from, x.to])).toEqual([
    ['? · high', 'inherit · medium'],
    ['opus · high', 'sonnet · medium'],
    ['opus · high', 'sonnet · medium'],
  ])
  // What a spawn the mod gave a model to ran on teaches nothing: the type is still the parent's.
  expect(types(w)).toEqual([{ type: 'general-purpose', tier: 'opus', parentTier: 'opus' }])
})

test('主 agent 换了模型：重新学，换回来也重新学', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(EASY) })
  await mainAtHigh($)
  const parents = [OPUS, OPUS, FABLE, FABLE, OPUS, OPUS]
  for (const [i, parentModel] of parents.entries()) await spawn($, { parentModel, tool_use_id: 'toolu_' + i })

  // Under fable (capped at opus) one tier down is sonnet as well.
  expect(w.spawned.map((s) => s.model)).toEqual([undefined, 'sonnet', undefined, 'sonnet', undefined, 'sonnet'])
  expect(logged(w).map((x) => x.from)).toEqual(['? · high', 'opus · high', '? · high', 'fable · high', '? · high', 'opus · high'])
  expect(types(w)).toEqual([{ type: 'general-purpose', tier: 'opus', parentTier: 'opus' }])
})

test('fableAgents 的上限照同样的规则：只给沿用主 agent 模型的类型；定义里有自己模型的类型不动', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(HOLD), typeModels: { Explore: 'haiku' } })
  await mainAtHigh($)
  for (const [i, subagentType] of ['general-purpose', 'general-purpose', 'Explore', 'Explore'].entries()) await spawn($, { subagentType, parentModel: FABLE, tool_use_id: 'toolu_' + i })

  expect(w.spawned.map((s) => s.model)).toEqual([undefined, 'opus', undefined, undefined])
  expect(logged(w).map((x) => [x.from, x.to])).toEqual([
    ['? · high', 'inherit · high'],
    ['fable · high', 'opus · high'],
    ['? · high', 'inherit · high'],
    ['haiku · high', 'inherit · high'],
  ])
})

for (const [name, options] of NO_BACKEND) {
  test(name + '：上限也照同样的规则', { options }, async ($, on) => {
    const w = world(on, { answer: agentAnswer(HOLD), typeModels: { Explore: 'haiku' } })
    await mainAtHigh($)
    for (const [i, subagentType] of ['general-purpose', 'general-purpose', 'Explore', 'Explore'].entries()) await spawn($, { subagentType, parentModel: FABLE, tool_use_id: 'toolu_' + i })

    expect(w.fetched).toHaveLength(0)
    expect(w.spawned.map((s) => s.model)).toEqual([undefined, 'opus', undefined, undefined])
    expect(types(w)).toEqual([
      { type: 'general-purpose', tier: 'fable', parentTier: 'fable' },
      { type: 'Explore', tier: 'haiku', parentTier: 'fable' },
    ])
  })
}

test('记下的类型有上限：最近学的留下，最早的先走', () => {
  let held = learnType([], { type: 't0', tier: 'opus', parentTier: 'opus' })
  for (let i = 1; i < AGENT_TYPES_KEEP + 8; i++) held = learnType(held, { type: 't' + i, tier: 'opus', parentTier: 'opus' })
  expect(held).toHaveLength(AGENT_TYPES_KEEP)
  expect(held[0]!.type).toBe('t8')
  // Learned again: replaced in place of the old entry, last.
  const again = learnType(held, { type: 't8', tier: 'haiku', parentTier: 'opus' })
  expect([again.at(-1), again.length]).toEqual([{ type: 't8', tier: 'haiku', parentTier: 'opus' }, AGENT_TYPES_KEEP])
  expect(knownType(again, 't8', 'opus')).toEqual({ type: 't8', tier: 'haiku', parentTier: 'opus' })
  // Known only under the parent it was learned under.
  expect([knownType(again, 't8', 'fable'), knownType(again, 'nope', 'opus')]).toEqual([null, null])
})

// Beyond the brief.

test('派出成功时 Decision 的每个字段', { options: { ...KEYS, midrunShift: false } }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(EASY) })
  await mainAtHigh($)
  await teach($)
  // One finished script in the main turn, so the Decision's step is the main turn's work steps.
  await appendAll($, scriptByPoll(1, 'Read the uploader', 'ok'))
  await spawn($, { subagentType: 'general-purpose' })

  const d = logged(w)
  expect(d).toHaveLength(2)
  const { id, at, ...rest } = d[1]!
  expect(typeof id).toBe('string')
  expect(typeof at).toBe('number')
  expect(rest).toEqual({
    kind: 'agent',
    backend: 'drex',
    model: 'drex-max-v1.1',
    ms: 0,
    raw: {
      open: { type: 'score', score: EASY.open.score, probabilities: [0.5, 0.4, 0.05, 0.05, 0] },
      mechanical: { type: 'noul', noul: 0.1 },
      unknown_cause: { type: 'noul', noul: 0.1 },
      read_only: { type: 'noul', noul: 0.1 },
    },
    from: 'opus · high',
    to: 'sonnet · medium',
    reason: 'less-open',
    detail: 'general-purpose',
    turnId: 't1',
    step: 1,
    bars: START,
    failure: null,
    requestId: null,
    applied: true,
    sent: null,
  })
  expect(w.spawned.map((s) => s.model)).toEqual([undefined, 'sonnet'])
  expect(recent(w)).toEqual(d)
  expect(entry(w, 'agent-2')).toMatchObject({ effort: 'medium', isEffortExplicit: null, decisionId: id, steps: 0 })
})

test('shadow：照常判断并记下，模型和 effort 都不改（fableAgents 的上限也不执行）', { options: { ...KEYS, mode: 'shadow' } }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP), agents: [info('agent-2')] })
  await mainAtHigh($)
  await teach($, { parentModel: FABLE })
  const r = await spawn($, { parentModel: FABLE })
  await agentSteps($, 'agent-2', 2)

  expect(asked(w)).toHaveLength(2)
  expect(w.spawned.map((s) => s.model)).toEqual([undefined, undefined])
  expect(r.model).toBe(FABLE)
  expect(effortsOf(w, 'agent-2')).toEqual(['high', 'high'])
  // What it would have done is recorded, as not applied: the type follows the parent, so it would have had haiku.
  expect(logged(w)[1]).toMatchObject({ from: 'fable · high', to: 'haiku · medium', reason: 'mechanical', applied: false })
  expect(entry(w, 'agent-2')).toMatchObject({ effort: null })
  expect(w.listed.calls).toBe(0)
})

// No backend can be asked: the spawn takes the same path as with agentShift off, and comes out the same (ruling R37).
const NOT_ASKED = [['agentShift 关着', { ...KEYS, agentShift: false }], ...NO_BACKEND] as const
for (const [name, options] of NOT_ASKED) {
  test(name + '：不发请求，fableAgents 的上限照样执行；继承 opus 的 agent 不改', { options }, async ($, on) => {
    const w = world(on, { answer: agentAnswer(LOOKUP) })
    await mainAtHigh($)
    await teach($, { parentModel: FABLE })
    const capped = await spawn($, { parentModel: FABLE })
    await teach($, { tool_use_id: 'toolu_teach_opus' })
    const kept = await spawn($)
    await agentSteps($, 'agent-2', 1)

    expect(w.fetched).toHaveLength(0)
    expect(w.spawned.map((s) => s.model)).toEqual([undefined, 'opus', undefined, undefined])
    expect([capped.model, kept.model]).toEqual([OPUS, OPUS])
    expect(effortsOf(w, 'agent-2')).toEqual(['high'])
    // Only the cap changed anything: the spawns nothing was asked of and nothing changed record nothing, keep nothing.
    const d = logged(w)
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ kind: 'agent', backend: null, model: null, raw: null, reason: null, failure: null, bars: null, ms: 0, from: 'fable · high', to: 'opus · —', applied: true })
    expect(entry(w, 'agent-2')).toMatchObject({ effort: null })
    expect([...new Set(agentWrites(w).map((s) => s.id))]).toEqual(['agent-2'])
  })
}

test('锁定时：不发请求，fableAgents 的上限照样执行', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP) })
  await mainAtHigh($)
  await dp($, 'lock low')
  await teach($, { parentModel: FABLE })
  const r = await spawn($, { parentModel: FABLE })
  await agentSteps($, 'agent-2', 1)

  expect(w.fetched).toHaveLength(0)
  expect(w.spawned.map((s) => s.model)).toEqual([undefined, 'opus'])
  expect(r.model).toBe(OPUS)
  // The lock is the main loop's: the agent's step keeps its own level.
  expect(effortsOf(w, 'agent-2')).toEqual(['high'])
  expect(logged(w).at(-1)).toMatchObject({ from: 'fable · high', to: 'opus · —', reason: null, applied: true })
})

test('enabled 关着：什么都不做，也不执行 fableAgents 的上限', { options: { ...KEYS, enabled: false } }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP) })
  await mainAtHigh($)
  const r = await spawn($, { parentModel: FABLE })
  await spawn($, { parentModel: FABLE, tool_use_id: 'toolu_2' })
  await agentSteps($, 'agent-1', 1)

  expect(w.spawned).toHaveLength(2)
  expect(w.spawned.map((s) => s.model)).toEqual([undefined, undefined])
  expect(r).toEqual({ model: FABLE, agentId: 'agent-1' })
  expect(effortsOf(w, 'agent-1')).toEqual(['high'])
  expect(w.fetched).toHaveLength(0)
  expect(logged(w)).toHaveLength(0)
  expect(agentWrites(w)).toHaveLength(0)
  expect(types(w)).toEqual([])
})

test('主 agent 的模型认不出层级（opusplan）：模型不改，只定 effort', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP) })
  await mainAtHigh($)
  await spawn($, { parentModel: 'opusplan' })
  const r = await spawn($, { parentModel: 'opusplan', tool_use_id: 'toolu_2' })
  await agentSteps($, 'agent-2', 2)

  expect(asked(w)).toHaveLength(2)
  expect(w.spawned.map((s) => s.model)).toEqual([undefined, undefined])
  expect(r.model).toBe('opusplan')
  expect(effortsOf(w, 'agent-2')).toEqual(['medium', 'medium'])
  expect(logged(w).map((d) => [d.from, d.to, d.reason, d.detail, d.applied])).toEqual([
    ['? · high', 'inherit · medium', 'mechanical', 'general-purpose', true],
    ['? · high', 'inherit · medium', 'mechanical', 'general-purpose', true],
  ])
})

test('next() 回答 deny 或没有 agentId：什么都不记，原样交回引擎的回答', { options: KEYS }, async ($, on) => {
  const answers: unknown[] = [{ deny: 'no agents here' }, { model: 'claude-haiku-5-5' }]
  const w = world(on, { answer: agentAnswer(LOOKUP), onSpawn: (e) => (e.tool_use_id === 'toolu_teach' ? undefined : answers.shift()) })
  await mainAtHigh($)
  await teach($)
  const denied = await spawn($)
  const unnamed = await spawn($, { tool_use_id: 'toolu_2' })

  // Both were judged and reached the engine with the model the answers picked.
  expect(asked(w)).toHaveLength(3)
  expect(w.spawned.map((s) => s.model)).toEqual([undefined, 'haiku', 'haiku'])
  expect(denied).toEqual({ deny: 'no agents here' })
  expect(unnamed).toEqual({ model: 'claude-haiku-5-5' })
  // Only the first spawn, which started agent-1, is kept.
  expect(logged(w)).toHaveLength(1)
  expect(agentWrites(w).map((s) => s.id)).toEqual(['agent-1'])
})

test('agent 的模型不收 effort（e.effort 缺省）或是数字：原样放行，不为明写的 effort 查 agent.list', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP), agents: [info('agent-2')] })
  await mainAtHigh($)
  await teach($)
  await spawn($)
  await step($, { turnId: 'a2', index: 0, model: HAIKU, agentId: 'agent-2' })
  await step($, { turnId: 'a2', index: 1, effort: 31999, model: HAIKU, agentId: 'agent-2' })

  expect(w.spawned.map((s) => s.model)).toEqual([undefined, 'haiku'])
  expect(effortsOf(w, 'agent-2')).toEqual([undefined, 31999])
  // The one call is the readout at the second step (Task 11); this row has no lastRequest, so the check is unverified.
  expect(w.listed.calls).toBe(1)
  expect(logged(w)[1]!.sent).toBe('unverified')
  expect(entry(w, 'agent-2')).toMatchObject({ effort: 'medium', isEffortExplicit: null, decisionId: logged(w)[1]!.id, steps: 2 })
})
