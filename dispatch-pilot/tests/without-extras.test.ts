// A session without dispatch-pilot-extras (ADR 0028): what a Code Mode session is, since Claude Code 2.1.325 does not
// start Code Mode beside a mod that hooks `tool.call`, `agent.spawn` or `classic.PreToolUse`. These tests take the kit's
// own `test`, which loads the mod alone (every other file takes support/test.ts's, which loads the other plugin's hooks
// beside it). Seam 1: engine events in; what reaches the engine, the decision backend and the board out.
//
// Without the other plugin no bridged hook runs (hooks/core/bridge.ts). The main agent's calls and an agent's are read
// from the conversation's rows (hooks/core/calls.ts), an agent is decided as its own turn starts
// (hooks/features/dispatched-agents.ts), and find_skill is a skill either way (tests/find-skill.test.ts).

import type { AgentInfo } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { blockedByHookText } from '../hooks/decision/escalation.ts'
import { newRecord, stepsDue, withResponse } from '../hooks/decision/midrun-track.ts'
import { agentJev } from './support/workflow.ts'
import { jev, KEY, kind, type Reply, type Sent, type StepOptions, type World, world } from './support/world.ts'

const MEDIUM = [0, 1, 0, 0, 0]
const FAILS = { error: 'Exit code 1\nTypeError: token is undefined' }
const BLOCKED = { blockedByHook: 'git push is blocked by policy' }

/** The decision model: `first` for a message, then `later` for each look in the middle of the turn. */
function backend(first: readonly number[], later: { levels: readonly number[]; nouls?: Record<string, number> }) {
  return (request: Sent): Reply => (kind(request) === 'midrun.level' ? jev(later.levels, { nouls: later.nouls ?? {}, confidence: 0.8 })(request) : jev(first)(request))
}

const run = (index: number, ends?: typeof FAILS): StepOptions => ({ index, answer: `第 ${index} 步`, tools: [{ tool: 'Bash', input: { command: 'pnpm test auth', description: '跑 auth 的测试' }, ...(ends === undefined ? {} : { ends }) }] })
const fix = (index: number): StepOptions => ({ index, answer: '改一下 token 的读取', tools: [{ tool: 'Edit', input: { file_path: '/repo/src/auth/login.ts', old_string: 'a', new_string: 'b' } }] })
const quiet = (index: number): StepOptions => ({ index, tools: [{ tool: 'Read', input: { file_path: `/repo/src/f${index}.ts` } }] })
const efforts = (w: World) => w.steps.map((s) => String(s.effort))

// ---- The main agent's effort in the middle of a turn ---------------------------------

test("the main agent's calls are read from the rows of the conversation: a failure that comes back after a fix asks about the run, a row is appended as its result is stored, and the steps after it go out at the new level", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MEDIUM, { levels: MEDIUM, nouls: { 'midrun.cause_unknown': 0.9 } }) })
  await w.submit('把登录的 token 读取修好，测试要过')
  await w.step(run(0, FAILS))
  await w.step(fix(1))
  await w.step(run(2, FAILS))
  await w.step(quiet(3))
  await w.step(quiet(4))

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midrun.level'])
  expect(w.appended).toHaveLength(1)
  expect(w.appended[0]).toMatchObject({ type: 'user', agentId: undefined, afterStep: 3 })
  expect(w.appended[0]?.text.includes('raised your reasoning effort from medium to high')).toBe(true)
  expect(efforts(w)).toEqual(['medium', 'medium', 'medium', 'high', 'high'])
  const entry = (await w.board()).log.find((one) => one.feature === 'midrun-effort')
  expect(entry?.subject).toBe('第 2 步（改过之后又失败：pnpm test auth）')
})

test('in a Code Mode session the calls are the ones a script makes: the script and the wait for its events are no calls, a failed call of a script is read with its error, and the level moves the same way', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MEDIUM, { levels: MEDIUM, nouls: { 'midrun.cause_unknown': 0.9 } }) })
  await w.submit('把登录的 token 读取修好，测试要过')
  await w.step({ ...run(0, FAILS), script: true })
  await w.step({ index: 1, poll: true })
  await w.step({ ...fix(2), script: true })
  await w.step({ index: 3, poll: true })
  await w.step({ ...run(4, FAILS), script: true })
  await w.step({ index: 5, poll: true })
  await w.step({ ...quiet(6), script: true })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midrun.level'])
  expect(w.appended).toHaveLength(1)
  expect(w.appended[0]?.text.includes('raised your reasoning effort from medium to high')).toBe(true)
  expect(efforts(w)).toEqual(['medium', 'medium', 'medium', 'medium', 'medium', 'high', 'high'])
  // What the decision model read of the run: the script's calls by their own tools, never `REPL` or `Poll`.
  const steps = (w.requests[1]?.body.state as { recent_steps?: { tools?: { tool: string; outcome: string }[] }[] }).recent_steps ?? []
  expect(steps.flatMap((step) => (step.tools ?? []).map((tool) => `${tool.tool} ${tool.outcome}`))).toEqual(['Bash failed', 'Edit ok', 'Bash failed'])
  // The turn's counts are the script's calls too.
  expect((await w.board()).main?.counts).toMatchObject({ failed: 2 })
})

test('a look by step count leaves out the steps in which the model only waited for a script', () => {
  const at = (step: number, idle?: number) => ({ ...newRecord('t1'), step, ...(idle === undefined ? {} : { idle }) })
  expect(stepsDue(at(6), 6, 2)).toEqual({ kind: 'steps', since: 6 })
  expect(stepsDue(at(6, 3), 6, 2)).toBeNull()
  expect(stepsDue(at(9, 3), 6, 2)).toEqual({ kind: 'steps', since: 6 })
  // A step whose response only waits is counted as it ends; any other step is not.
  expect(withResponse(at(2), 2, '', 1, true).idle).toBe(1)
  expect(withResponse(at(2, 1), 2, '', 1, true).idle).toBe(2)
  expect(withResponse(at(2), 2, '', 1).idle).toBeUndefined()
})

// ---- Failures counted ------------------------------------------------------------------

test("the main agent's failures and a hook's blocks are counted from the rows: a block is told by Claude Code's words for it", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev(MEDIUM) })
  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step(run(0, FAILS))
  await w.step({ index: 1, tools: [{ tool: 'Bash', input: { command: 'git push origin main', description: '推送' }, ends: BLOCKED }] })
  await w.step(run(2, FAILS))
  await w.step({ index: 3 })

  expect((await w.board()).main?.counts).toEqual({ failed: 2, blocked: 1, raised: 0 })
  expect(blockedByHookText('PreToolUse:Bash hook error: [python3 guard.py]: grep through Bash is blocked')).toBe(true)
  expect(blockedByHookText('Exit code 1\nPreToolUse is mentioned further down')).toBe(false)
})

// ---- Dispatched agents -----------------------------------------------------------------

const TASK = 'Rename getUser to fetchUser across src/api and run `pnpm test api`.'
const roster = (...agents: Partial<AgentInfo>[]): AgentInfo[] => agents.map((agent, i) => ({ id: `a${i + 1}`, description: 'Rename getUser', type: 'general-purpose', status: 'running', ...agent }) as AgentInfo)

test('an agent is decided as its own turn starts: its task is the turn\'s text, its description and type the roster\'s; the model goes into its plan with the effort, and every step names both', { options: KEY }, async ($, on) => {
  const w = world($, on, { agents: roster({}), backend: agentJev({ model: { haiku: 0.05, sonnet: 0.85, opus: 0.1 }, effort: [0, 0.1, 0.8, 0.1, 0] }) })
  await w.step({ index: 0, turnId: 'sub-1', agentId: 'a1', model: 'claude-haiku-5-5', effort: 'medium', task: TASK })
  await w.step({ index: 1, turnId: 'sub-1', agentId: 'a1', model: 'claude-haiku-5-5', effort: 'medium' })

  expect(w.spawned).toEqual([])
  expect(w.requests).toHaveLength(1)
  expect(w.requests[0]?.body.state).toMatchObject({ brief: { prompt: TASK, description: 'Rename getUser', agent_type: 'general-purpose' } })
  expect(w.steps.map((s) => `${s.model} ${String(s.effort)}`)).toEqual(['claude-sonnet-5-5 high', 'claude-sonnet-5-5 high'])
  const node = (await w.board()).nodes.find((one) => one.id === 'a1')
  expect(node).toMatchObject({ routed: true, model: 'sonnet', effort: 'high' })
})

test('an agent woken again goes on as it was decided, and one the roster does not list (a Workflow\'s) is not asked about', { options: KEY }, async ($, on) => {
  const w = world($, on, { agents: roster({}), backend: agentJev({ model: { sonnet: 1 }, effort: [0, 0, 1, 0, 0] }) })
  await w.step({ index: 0, turnId: 'sub-1', agentId: 'a1', model: 'claude-haiku-5-5', effort: 'medium', task: TASK })
  await w.step({ index: 0, turnId: 'sub-1b', agentId: 'a1', model: 'claude-haiku-5-5', effort: 'medium', task: 'The coordinator sent a message while you were working: also update the docs.' })
  await w.step({ index: 0, turnId: 'wf-1', agentId: 'wf-agent-7', model: 'claude-haiku-5-5', effort: 'medium', task: 'Audit src/auth.' })

  expect(w.requests).toHaveLength(1)
  expect(w.steps.map((s) => `${s.agentId} ${s.model} ${String(s.effort)}`)).toEqual(['a1 claude-sonnet-5-5 high', 'a1 claude-sonnet-5-5 high', 'wf-agent-7 claude-haiku-5-5 medium'])
})

test('a fork and a teammate are left as they are, and the board says why', { options: KEY }, async ($, on) => {
  const w = world($, on, { agents: roster({ type: 'fork' }, { teammateId: 'reviewer@team' }), backend: agentJev({ model: { opus: 1 }, effort: [0, 0, 0, 1, 0] }) })
  await w.step({ index: 0, turnId: 'sub-1', agentId: 'a1', model: 'claude-opus-5-5', effort: 'high', task: TASK })
  await w.step({ index: 0, turnId: 'sub-2', agentId: 'a2', model: 'claude-opus-5-5', effort: 'high', task: TASK })

  expect(w.requests).toHaveLength(0)
  expect(w.steps.map((s) => `${s.model} ${String(s.effort)}`)).toEqual(['claude-opus-5-5 high', 'claude-opus-5-5 high'])
  const whys = (await w.board()).nodes.map((one) => one.why)
  expect(whys).toEqual(['fork 沿用主 agent 的模型和 effort', 'teammate 跨多个任务，派出时不判断'])
})

// ---- What is not there -----------------------------------------------------------------

test('visual_check is not offered: its calls are answered in a hook only the other plugin runs', { options: KEY }, async ($, on) => {
  const w = world($, on, { session: true })
  await w.start()
  expect(w.tools).toEqual([])
})
