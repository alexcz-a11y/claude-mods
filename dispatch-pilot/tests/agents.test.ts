import { expect, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { START } from '../hooks/decide.ts'
import type { Decision } from '../hooks/log.ts'
import type { AgentState } from '../hooks/state.ts'
import { scriptByPoll } from './support/rows.ts'
import { KEYS, appendAll, dp, drexOk, noul, score, spawn, start, step, turnStart, world } from './support/world.ts'

type World = ReturnType<typeof world>

// What the mod recorded and wrote, and what reached the engine.
const logged = (w: World): Decision[] => (w.storeWrites.filter((s) => s.key === 'log').at(-1)?.value ?? []) as Decision[]
const recent = (w: World): Decision[] => (w.stateWrites.filter((s) => s.key === 'recent' && s.isSet).at(-1)?.value ?? []) as Decision[]
/** The agents family's entry for one agent, as last written. */
const entry = (w: World, id: string): AgentState | undefined => w.stateWrites.filter((s) => s.key === 'agents' && s.id === id && s.isSet).at(-1)?.value as AgentState | undefined
const agentWrites = (w: World) => w.stateWrites.filter((s) => s.key === 'agents')
/** The requests about an agent (only they ask read_only). */
const asked = (w: World) => w.fetched.filter((f) => 'read_only' in f.body.questions)
/** The efforts of one loop's steps as they reached the engine; agentId undefined: the main loop's. */
const effortsOf = (w: World, agentId: string | undefined): unknown[] => w.stepsSent.filter((s) => s.agentId === agentId).map((s) => s.effort)

const OPUS = 'claude-opus-5-5'
const FABLE = 'claude-fable-5-2'

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

/** Runs n steps of an agent's loop, each at the engine's level. */
async function agentSteps($: Engine, agentId: string, n: number, effort: unknown = 'high') {
  for (let index = 0; index < n; index++) await step($, { turnId: `a-${agentId}`, index, effort, model: 'claude-haiku-5-5', agentId })
}

// The brief's ten.

test('派出时发一个请求，state.task 是任务原文；只读又机械的任务用 haiku，之后每步写定下的 effort', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP), agents: [info('agent-1')] })
  await mainAtHigh($)
  const task = 'List every file under src/ that imports the retry helper.'
  const r = await spawn($, { prompt: task, description: 'List retry users', subagentType: 'Explore' })
  await agentSteps($, 'agent-1', 3)

  expect(asked(w)).toHaveLength(1)
  expect(w.fetched).toHaveLength(1)
  expect(Object.keys(w.fetched[0]!.body.questions)).toEqual(['open', 'mechanical', 'unknown_cause', 'read_only'])
  expect(w.fetched[0]!.body.state).toMatchObject({ task, agent_type: 'Explore', description: 'List retry users' })
  // The model reached the engine as the alias; the engine's answer comes back as it is.
  expect(w.spawned.map((s) => s.model)).toEqual(['haiku'])
  expect(r).toEqual({ model: 'haiku', agentId: 'agent-1' })
  expect(effortsOf(w, 'agent-1')).toEqual(['medium', 'medium', 'medium'])
  // The main loop's own step is untouched.
  expect(effortsOf(w, undefined)).toEqual(['high'])

  const d = logged(w)
  expect(d).toHaveLength(1)
  expect(d[0]).toMatchObject({ kind: 'agent', from: 'opus · high', to: 'haiku · medium', reason: 'mechanical', detail: 'Explore', applied: true, turnId: 't1' })
  expect(entry(w, 'agent-1')).toEqual({ effort: 'medium', isEffortExplicit: false, decisionId: d[0]!.id, steps: 3 })
  // $.agent.list() is asked twice: at the agent's first step whether its effort is its own, and at its second for what
  // the first request carried (Task 11; this row has no lastRequest, so the check is unverified).
  expect(w.listed.calls).toBe(2)
  expect(d[0]!.sent).toBe('unverified')
})

test('fork、续跑、workflow 的 agent：不发请求，模型不动', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP) })
  await mainAtHigh($)
  const fork = { subagentType: 'fork', fork: true, parentModel: FABLE }
  const resume = { resume: { agentId: 'agent-old' }, parentModel: FABLE }
  const workflow = { workflow: { runId: 'wf_1', agentIndex: 1 }, parentModel: FABLE }
  const rs = [await spawn($, fork), await spawn($, resume), await spawn($, workflow)]
  for (const id of ['agent-1', 'agent-2', 'agent-3']) await agentSteps($, id, 2)

  expect(w.fetched).toHaveLength(0)
  // Each reached the engine as it was given: no model, not even the fableAgents cap.
  expect(w.spawned).toHaveLength(3)
  expect(w.spawned.map((s) => s.model)).toEqual([undefined, undefined, undefined])
  expect(w.spawned[0]).toMatchObject({ fork: true, subagentType: 'fork' })
  expect(w.spawned[1]!.resume).toEqual({ agentId: 'agent-old' })
  expect(w.spawned[2]!.workflow).toEqual({ runId: 'wf_1', agentIndex: 1 })
  expect(rs.map((r) => r.model)).toEqual([FABLE, FABLE, FABLE])
  for (const id of ['agent-1', 'agent-2', 'agent-3']) expect(effortsOf(w, id)).toEqual(['high', 'high'])
  expect(logged(w)).toHaveLength(0)
  expect(agentWrites(w)).toHaveLength(0)
  expect(w.listed.calls).toBe(0)
})

test('派出时明写了模型：模型不改，仍然定 effort', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP) })
  await mainAtHigh($)
  const r = await spawn($, { model: 'sonnet' })
  await agentSteps($, 'agent-1', 2)

  expect(asked(w)).toHaveLength(1)
  // The answers would pick haiku; the call named sonnet, and sonnet is what reached the engine.
  expect(w.spawned.map((s) => s.model)).toEqual(['sonnet'])
  expect(r).toEqual({ model: 'sonnet', agentId: 'agent-1' })
  expect(effortsOf(w, 'agent-1')).toEqual(['medium', 'medium'])
  expect(logged(w)[0]).toMatchObject({ kind: 'agent', from: 'opus · high', to: 'sonnet · medium', reason: 'mechanical', applied: true })
  expect(entry(w, 'agent-1')).toMatchObject({ effort: 'medium', steps: 2 })
})

test('主 agent 是 Fable、fableAgents 关着：没写模型的 agent 是 opus，后端失败时也是', { options: KEYS }, async ($, on) => {
  const net = { down: false }
  const w = world(on, { answer: () => (net.down ? null : drexOk(HOLD)) })
  await mainAtHigh($)
  const ok = await spawn($, { parentModel: FABLE })
  net.down = true
  const failed = await spawn($, { parentModel: FABLE, tool_use_id: 'toolu_2' })
  await agentSteps($, 'agent-1', 2)
  await agentSteps($, 'agent-2', 2)

  expect(asked(w)).toHaveLength(2)
  expect(w.spawned.map((s) => s.model)).toEqual(['opus', 'opus'])
  expect([ok.model, failed.model]).toEqual(['opus', 'opus'])
  // The answered one gets its effort; the failed one is not handled beyond the cap.
  expect(effortsOf(w, 'agent-1')).toEqual(['high', 'high'])
  expect(effortsOf(w, 'agent-2')).toEqual(['high', 'high'])
  expect(entry(w, 'agent-1')).toMatchObject({ effort: 'high' })
  expect(entry(w, 'agent-2')).toMatchObject({ effort: null })
  const d = logged(w)
  expect(d).toHaveLength(2)
  expect(d[0]).toMatchObject({ from: 'fable · high', to: 'opus · high', reason: 'hold', failure: null, applied: true })
  expect(d[1]).toMatchObject({ from: 'fable · high', to: 'opus · —', reason: null, raw: null, bars: null, model: null, failure: 'network', backend: 'drex', applied: true })
})

test('fableAgents 开着：继承 fable 不改', { options: { ...KEYS, fableAgents: true } }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(HOLD) })
  await mainAtHigh($)
  const r = await spawn($, { parentModel: FABLE })
  await agentSteps($, 'agent-1', 1, 'medium')

  expect(asked(w)).toHaveLength(1)
  expect(w.spawned.map((s) => s.model)).toEqual([undefined])
  expect(r.model).toBe(FABLE)
  // The effort decided from the main turn's high is still written over the engine's medium.
  expect(effortsOf(w, 'agent-1')).toEqual(['high'])
  expect(logged(w)[0]).toMatchObject({ from: 'fable · high', to: 'inherit · high', reason: 'hold', applied: true })
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
  expect([asOpus.model, asFable.model]).toEqual(['fable', 'fable'])
  const d = logged(w)
  expect(d.map((x) => [x.from, x.to, x.failure])).toEqual([
    ['opus · high', 'fable · medium', null],
    ['fable · high', 'fable · —', 'network'],
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
  const both = Promise.all([spawn($, { prompt: LIST, subagentType: 'Explore', tool_use_id: 'toolu_a' }), spawn($, { prompt: DESIGN, subagentType: 'Plan', tool_use_id: 'toolu_b' })])
  await w.clock.settle()
  expect(asked(w)).toHaveLength(2)
  expect(w.spawned).toHaveLength(0)
  await w.clock.advance(500)
  const [list, design] = await both

  // The design answered first and reached the engine first.
  expect(w.spawned.map((s) => [s.tool_use_id, s.model])).toEqual([
    ['toolu_b', undefined],
    ['toolu_a', 'haiku'],
  ])
  expect(list).toEqual({ model: 'haiku', agentId: 'agent-2' })
  expect(design).toEqual({ model: OPUS, agentId: 'agent-1' })
  await agentSteps($, list.agentId!, 2)
  await agentSteps($, design.agentId!, 2)
  expect(effortsOf(w, list.agentId!)).toEqual(['medium', 'medium'])
  expect(effortsOf(w, design.agentId!)).toEqual(['xhigh', 'xhigh'])

  const d = logged(w)
  expect(d).toHaveLength(2)
  const byType = Object.fromEntries(d.map((x) => [x.detail, x]))
  expect(byType.Plan).toMatchObject({ to: 'inherit · xhigh', reason: 'more-open' })
  expect(byType.Explore).toMatchObject({ to: 'haiku · medium', reason: 'mechanical' })
  expect(recent(w).map((x) => x.id).sort()).toEqual(d.map((x) => x.id).sort())
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
  expect(logged(w)[0]).toMatchObject({ kind: 'agent', failure: 'timeout', ms: 3000, from: 'opus · high', to: 'inherit · —', reason: null, applied: false })
  expect(entry(w, 'agent-1')).toMatchObject({ effort: null, steps: 3 })
  expect(w.listed.calls).toBe(0)
})

test('agent 明写了 effort（agent.list 里有值）：不写 effort', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP), agents: [info('agent-1', { effort: 'low' })] })
  await mainAtHigh($)
  await spawn($)
  await agentSteps($, 'agent-1', 3, 'low')

  expect(asked(w)).toHaveLength(1)
  // The model is still decided; the effort its definition set is left as it is.
  expect(w.spawned.map((s) => s.model)).toEqual(['haiku'])
  expect(effortsOf(w, 'agent-1')).toEqual(['low', 'low', 'low'])
  // Once for the explicit effort, once for the readout at the second step (Task 11).
  expect(w.listed.calls).toBe(2)
  expect(entry(w, 'agent-1')).toEqual({ effort: 'medium', isEffortExplicit: true, decisionId: logged(w)[0]!.id, steps: 3 })
})

test('agent 的第一步比 agent.spawn 的结果先到：这一步原样放行，下一步起写定下的 effort', { options: KEYS }, async ($, on) => {
  const order: string[] = []
  const w = world(on, {
    answer: agentAnswer(LOOKUP),
    agents: [info('agent-1')],
    // The engine starts the agent inside agent.spawn's next(e): its first step runs before the answer is back.
    onSpawn: async (_e, agentId) => {
      await step($, { turnId: 'a1', index: 0, effort: 'high', model: 'claude-haiku-5-5', agentId })
      order.push('first step')
    },
  })
  await mainAtHigh($)
  const r = await spawn($)
  order.push('spawn answered')
  await step($, { turnId: 'a1', index: 1, effort: 'high', model: 'claude-haiku-5-5', agentId: 'agent-1' })
  await step($, { turnId: 'a1', index: 2, effort: 'high', model: 'claude-haiku-5-5', agentId: 'agent-1' })

  expect(order).toEqual(['first step', 'spawn answered'])
  expect(r).toEqual({ model: 'haiku', agentId: 'agent-1' })
  expect(effortsOf(w, 'agent-1')).toEqual(['high', 'medium', 'medium'])
  // The early step wrote nothing; the entry counts the steps it saw.
  expect(entry(w, 'agent-1')).toEqual({ effort: 'medium', isEffortExplicit: false, decisionId: logged(w)[0]!.id, steps: 2 })
  // Once for the explicit effort at the first step the entry saw, once for the readout at the second (Task 11).
  expect(w.listed.calls).toBe(2)
})

// Beyond the brief.

test('派出成功时 Decision 的每个字段', { options: { ...KEYS, midrunShift: false } }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(EASY) })
  await mainAtHigh($)
  // One finished script in the main turn, so the Decision's step is the main turn's work steps.
  await appendAll($, scriptByPoll(1, 'Read the uploader', 'ok'))
  await spawn($, { subagentType: 'general-purpose' })

  const d = logged(w)
  expect(d).toHaveLength(1)
  const { id, at, ...rest } = d[0]!
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
  expect(w.spawned.map((s) => s.model)).toEqual(['sonnet'])
  expect(recent(w)).toEqual(d)
  expect(entry(w, 'agent-1')).toEqual({ effort: 'medium', isEffortExplicit: null, decisionId: id, steps: 0 })
})

test('shadow：照常判断并记下，模型和 effort 都不改（fableAgents 的上限也不执行）', { options: { ...KEYS, mode: 'shadow' } }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP), agents: [info('agent-1')] })
  await mainAtHigh($)
  const r = await spawn($, { parentModel: FABLE })
  await agentSteps($, 'agent-1', 2)

  expect(asked(w)).toHaveLength(1)
  expect(w.spawned.map((s) => s.model)).toEqual([undefined])
  expect(r.model).toBe(FABLE)
  expect(effortsOf(w, 'agent-1')).toEqual(['high', 'high'])
  // What it would have done is recorded, as not applied.
  expect(logged(w)[0]).toMatchObject({ from: 'fable · high', to: 'haiku · medium', reason: 'mechanical', applied: false })
  expect(entry(w, 'agent-1')).toMatchObject({ effort: null })
  expect(w.listed.calls).toBe(0)
})

test('agentShift 关着：不发请求，fableAgents 的上限照样执行；继承 opus 的 agent 不改', { options: { ...KEYS, agentShift: false } }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP) })
  await mainAtHigh($)
  const capped = await spawn($, { parentModel: FABLE })
  const kept = await spawn($)
  await agentSteps($, 'agent-1', 1)

  expect(w.fetched).toHaveLength(0)
  expect(w.spawned.map((s) => s.model)).toEqual(['opus', undefined])
  expect([capped.model, kept.model]).toEqual(['opus', OPUS])
  expect(effortsOf(w, 'agent-1')).toEqual(['high'])
  const d = logged(w)
  expect(d).toHaveLength(2)
  expect(d[0]).toMatchObject({ kind: 'agent', backend: null, model: null, raw: null, reason: null, failure: null, bars: null, ms: 0, from: 'fable · high', to: 'opus · —', applied: true })
  expect(d[1]).toMatchObject({ from: 'opus · high', to: 'inherit · —', applied: false })
  expect(entry(w, 'agent-1')).toMatchObject({ effort: null })
})

test('锁定时：不发请求，fableAgents 的上限照样执行', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP) })
  await mainAtHigh($)
  await dp($, 'lock low')
  const r = await spawn($, { parentModel: FABLE })
  await agentSteps($, 'agent-1', 1)

  expect(w.fetched).toHaveLength(0)
  expect(w.spawned.map((s) => s.model)).toEqual(['opus'])
  expect(r.model).toBe('opus')
  // The lock is the main loop's: the agent's step keeps its own level.
  expect(effortsOf(w, 'agent-1')).toEqual(['high'])
  expect(logged(w)[0]).toMatchObject({ from: 'fable · high', to: 'opus · —', reason: null, applied: true })
})

test('enabled 关着：什么都不做，也不执行 fableAgents 的上限', { options: { ...KEYS, enabled: false } }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP) })
  await mainAtHigh($)
  const r = await spawn($, { parentModel: FABLE })
  await agentSteps($, 'agent-1', 1)

  expect(w.spawned).toHaveLength(1)
  expect(w.spawned[0]!.model).toBeUndefined()
  expect(r).toEqual({ model: FABLE, agentId: 'agent-1' })
  expect(effortsOf(w, 'agent-1')).toEqual(['high'])
  expect(w.fetched).toHaveLength(0)
  expect(logged(w)).toHaveLength(0)
  expect(agentWrites(w)).toHaveLength(0)
})

test('主 agent 的模型认不出层级（opusplan）：模型不改，只定 effort', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP) })
  await mainAtHigh($)
  const r = await spawn($, { parentModel: 'opusplan' })
  await agentSteps($, 'agent-1', 2)

  expect(asked(w)).toHaveLength(1)
  expect(w.spawned.map((s) => s.model)).toEqual([undefined])
  expect(r.model).toBe('opusplan')
  expect(effortsOf(w, 'agent-1')).toEqual(['medium', 'medium'])
  expect(logged(w)[0]).toMatchObject({ from: 'inherit · high', to: 'inherit · medium', reason: 'mechanical', applied: true })
})

test('next() 回答 deny 或没有 agentId：什么都不记，原样交回引擎的回答', { options: KEYS }, async ($, on) => {
  const answers: unknown[] = [{ deny: 'no agents here' }, { model: 'claude-haiku-5-5' }]
  const w = world(on, { answer: agentAnswer(LOOKUP), onSpawn: () => answers.shift() })
  await mainAtHigh($)
  const denied = await spawn($)
  const unnamed = await spawn($, { tool_use_id: 'toolu_2' })

  // Both were judged and reached the engine with the model the answers picked.
  expect(asked(w)).toHaveLength(2)
  expect(w.spawned.map((s) => s.model)).toEqual(['haiku', 'haiku'])
  expect(denied).toEqual({ deny: 'no agents here' })
  expect(unnamed).toEqual({ model: 'claude-haiku-5-5' })
  expect(logged(w)).toHaveLength(0)
  expect(agentWrites(w)).toHaveLength(0)
})

test('agent 的模型不收 effort（e.effort 缺省）或是数字：原样放行，不为明写的 effort 查 agent.list', { options: KEYS }, async ($, on) => {
  const w = world(on, { answer: agentAnswer(LOOKUP), agents: [info('agent-1')] })
  await mainAtHigh($)
  await spawn($)
  await step($, { turnId: 'a1', index: 0, model: 'claude-haiku-5-5', agentId: 'agent-1' })
  await step($, { turnId: 'a1', index: 1, effort: 31999, model: 'claude-haiku-5-5', agentId: 'agent-1' })

  expect(w.spawned.map((s) => s.model)).toEqual(['haiku'])
  expect(effortsOf(w, 'agent-1')).toEqual([undefined, 31999])
  // The one call is the readout at the second step (Task 11); this row has no lastRequest, so the check is unverified.
  expect(w.listed.calls).toBe(1)
  expect(logged(w)[0]!.sent).toBe('unverified')
  expect(entry(w, 'agent-1')).toEqual({ effort: 'medium', isEffortExplicit: null, decisionId: logged(w)[0]!.id, steps: 2 })
})
