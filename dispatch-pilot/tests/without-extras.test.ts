// A session without dispatch-pilot-extras (ADR 0028): what a Code Mode session is, since Claude Code 2.1.325 does not
// start Code Mode beside a mod that hooks `tool.call`, `agent.spawn` or `classic.PreToolUse`. These tests take the kit's
// own `test`, which loads the mod alone (every other file takes support/test.ts's, which loads the other plugin's hooks
// beside it). Seam 1: engine events in; what reaches the engine, the decision backend and the board out.
//
// Without the other plugin no bridged hook runs (hooks/core/bridge.ts). The main agent's calls and an agent's are read
// from the conversation's rows (hooks/core/calls.ts), an agent is decided as its own turn starts
// (hooks/features/dispatched-agents.ts), and find_skill is a skill either way (tests/find-skill.test.ts).

import { expect, test } from 'claude-code/testing'
import { blockedByHookText } from '../hooks/decision/escalation.ts'
import { scriptEnded } from '../hooks/core/calls.ts'
import { midrunState, type MidrunStep } from '../hooks/decision/midrun.ts'
import { newRecord, stepsDue, withResponse, withScript, workSince } from '../hooks/decision/midrun-track.ts'
import { agentJev } from './support/workflow.ts'
import { jev, KEY, kind, type ListedAgent, type Reply, type Sent, type StepOptions, type World, world } from './support/world.ts'

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
  // The failed call's row is one no request carries: the note goes on the next result of `Poll` (step 5), and the step after it takes the level.
  expect(efforts(w)).toEqual(['medium', 'medium', 'medium', 'medium', 'medium', 'medium', 'high'])
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

test('the gaps between two switches, between two questions and before a raise is taken back are counted in steps of work: a step that only waited is left out, and a session with none counts as before', () => {
  const waitedAt = (step: number, waited: number[]) => ({ ...newRecord('t1'), step, waited })
  expect(workSince({ ...newRecord('t1'), step: 9 }, 5)).toBe(4)
  // Script at 5, wait at 6, script at 7, wait at 8, script at 9: two steps of work since the one at 5.
  expect(workSince(waitedAt(9, [2, 4, 6, 8]), 5)).toBe(2)
  // The step the loop is at is a wait: the calls read in it belong to the script before.
  expect(workSince(waitedAt(8, [6, 8]), 5)).toBe(1)
  const twice = withResponse(withResponse({ ...newRecord('t1'), step: 3 }, 3, '', 1, true), 3, '', 1, true)
  expect(twice.waited).toEqual([3])
})

test('in a Code Mode session a question is not asked again until four steps of work after the last: the waits between the scripts do not bring it nearer', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MEDIUM, { levels: MEDIUM }) })
  await w.submit('把登录的 token 读取修好，测试要过')
  // A skill loaded at step 0 is asked about; one loaded at step 6 is three steps of work on (2, 4, 6), and is not; the one at step 8 is.
  const skill = (index: number): StepOptions => ({ index, script: true, tools: [{ tool: 'Skill', input: { skill: `s${index}` } }] })
  await w.step(skill(0))
  for (const index of [2, 4]) {
    await w.step({ index: index - 1, poll: true })
    await w.step({ ...quiet(index), script: true })
  }
  await w.step({ index: 5, poll: true })
  await w.step(skill(6))
  expect(w.requests.map(kind)).toEqual(['effort.level', 'midrun.level'])
  await w.step({ index: 7, poll: true })
  await w.step(skill(8))
  expect(w.requests.map(kind)).toEqual(['effort.level', 'midrun.level', 'midrun.level'])
})

// ---- What a script returned ---------------------------------------------------------------

type SentStep = { step: number; tools?: unknown[]; script_result?: string; script_error?: string }
const sentSteps = (request: Sent | undefined): SentStep[] => (request?.body.state as { recent_steps?: SentStep[] }).recent_steps ?? []
const RETURNED = "{ edited: 'src/auth/login.ts', tests: 'FAIL src/auth/login.test.ts > reads <token> & refreshes\n1 failed, 11 passed' }"

/** A Code Mode turn whose test fails, is fixed and fails again; each script returns `returned(index)` (undefined: nothing told). */
async function scriptedTurn(w: World, more: (index: number) => Partial<StepOptions>) {
  await w.submit('把登录的 token 读取修好，测试要过')
  await w.step({ ...run(0, FAILS), script: true, ...more(0) })
  await w.step({ ...fix(1), script: true, ...more(1) })
  await w.step({ ...run(2, FAILS), script: true, ...more(2) })
}

test("in a Code Mode session what each script returned to the main agent goes to the decision model on the step its calls are read into, not masked; the note on how to read the state says so", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MEDIUM, { levels: MEDIUM, nouls: { 'midrun.cause_unknown': 0.9 } }) })
  await scriptedTurn(w, (index) => (index === 1 ? { returns: 'undefined' } : { returns: index === 0 ? `${RETURNED} sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789` : RETURNED, twice: index === 2 }))

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midrun.level'])
  const steps = sentSteps(w.requests[1])
  // The event is the third script's failed call: its result came before that call's row, and is there; sent once though its row came twice.
  expect(steps.map((step) => step.script_result)).toEqual([`${RETURNED.replace('\n', ' ')} sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789`, 'undefined', RETURNED.replace('\n', ' ')])
  expect(String((w.requests[1]?.body.state as { progress_note: string }).progress_note).includes('`script_result` is what the step\'s script returned')).toBe(true)
  // The note waits for a result a request carries: the wait for the script's events is the next one.
  expect(w.appended).toEqual([])
  await w.step({ index: 3, poll: true })
  expect(w.appended).toHaveLength(1)
})

test('a script that stopped with an error is told as `script_error`; with `script-results` off, and in a turn whose scripts told nothing, the state is as it was', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MEDIUM, { levels: MEDIUM, nouls: { 'midrun.cause_unknown': 0.9 } }) })
  await scriptedTurn(w, (index) => (index === 2 ? { throws: 'Error: tests failed\nThrown at: throw new Error("tests failed");' } : {}))
  const steps = sentSteps(w.requests[1])
  expect(steps.map((step) => step.script_error)).toEqual([undefined, undefined, 'Error: tests failed Thrown at: throw new Error("tests failed");'])
  expect(steps.every((step) => step.script_result === undefined)).toBe(true)
})

test('`script-results` off: nothing a script returned is sent', { options: { ...KEY, scriptResults: false } }, async ($, on) => {
  const w = world($, on, { backend: backend(MEDIUM, { levels: MEDIUM, nouls: { 'midrun.cause_unknown': 0.9 } }) })
  await scriptedTurn(w, () => ({ returns: RETURNED }))
  expect(sentSteps(w.requests[1]).every((step) => step.script_result === undefined)).toBe(true)
  expect(String((w.requests[1]?.body.state as { progress_note: string }).progress_note).includes('script_result')).toBe(false)
})

test('the row of a script\'s end is read by its event; a result is kept on the step the loop is at, a long one cut from the middle, and the state cuts it to its share and the newest step\'s to what is left', () => {
  const row = (text: string) => ({ message: { content: [{ type: 'text', text }] } })
  expect(scriptEnded(row('<event nonce="a" kind="repl-eval" at="t" eval="7" ms="20" status="settled">\n<result>{ a: 1 &lt; 2 &amp;&amp; true }</result>\n</event>'))).toEqual({ eval: 7, text: '{ a: 1 < 2 && true }', failed: false })
  expect(scriptEnded(row('<event nonce="a" kind="repl-eval" at="t" eval="8" ms="20" status="settled">\n<error>Error: boom</error>\n</event>'))).toEqual({ eval: 8, text: 'Error: boom', failed: true })
  // What the script logged (and the harness's own notices) comes before what it returned, in the same event: the model reads both.
  expect(scriptEnded(row('<event nonce="a" kind="repl-eval" at="t" eval="9" ms="20" status="settled">\n<log>3 of 12 failed</log>\n<log>[stderr] 1 tool call still running at script end</log>\n<result>undefined</result>\n</event>'))).toEqual({ eval: 9, text: '3 of 12 failed\n[stderr] 1 tool call still running at script end\nundefined', failed: false })
  expect(scriptEnded(row('<event nonce="a" kind="repl-eval" at="t" eval="10" ms="20" status="settled">\n<log>step 1 ok</log>\n<error>Error: boom</error>\n</event>'))).toEqual({ eval: 10, text: 'step 1 ok\nError: boom', failed: true })
  expect(scriptEnded(row('<event nonce="a" kind="task-notification" at="t">\n<result>done</result>\n</event>'))).toBeUndefined()
  expect(scriptEnded(row('the person typed <result>x</result>'))).toBeUndefined()

  const at = { ...newRecord('t1'), step: 3 }
  const once = withScript(at, { eval: 1, text: 'first', failed: false })
  expect(once.recent).toEqual([{ step: 3, assistant_text: '', tools: [], script_result: 'first' }])
  expect(withScript(once, { eval: 1, text: 'first', failed: false })).toBe(once)
  expect(withScript(once, { eval: 2, text: 'second', failed: false }).recent[0]?.script_result).toBe('first\nsecond')
  const long = withScript(at, { eval: 3, text: `HEAD${'x'.repeat(9000)}TAIL`, failed: false }).recent[0]?.script_result ?? ''
  expect(long.length < 4100 && long.startsWith('HEAD') && long.endsWith('TAIL')).toBe(true)

  const words = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ')
  const step = (index: number): MidrunStep => ({ step: index, assistant_text: '', tools: [{ tool: 'Bash', target: 'pnpm test', outcome: 'ok' }], script_result: `START ${words(2000, 'out')} END` })
  const roomy = midrunState({ task: '修好登录', recent_steps: [step(0), step(1)], facts: [] }).recent_steps as MidrunStep[]
  expect(roomy).toHaveLength(2)
  expect(roomy.every((one) => (one.script_result ?? '').startsWith('START') && (one.script_result ?? '').endsWith('END') && (one.script_result ?? '').length < 2400)).toBe(true)
  const tight = midrunState({ task: '修好登录', recent_steps: [step(0), step(1)], facts: [] }, { steps: 8, tokens: 420 }).recent_steps as MidrunStep[]
  expect(tight.map((one) => one.step)).toEqual([1])
  expect((tight[0]?.script_result ?? '').length > 0 && (tight[0]?.script_result ?? '').length < 1200).toBe(true)
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
const roster = (...agents: Partial<ListedAgent>[]): ListedAgent[] => agents.map((agent, i) => ({ id: `a${i + 1}`, description: 'Rename getUser', type: 'general-purpose', status: 'running', ...agent }))

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

test("an agent the roster says is on the model decided for it already is not held to it: its plan names the effort alone, so the engine's own fallback still stands (Claude Code 2.1.326 on)", { options: KEY }, async ($, on) => {
  const w = world($, on, { agents: roster({ model: 'claude-sonnet-5-5' }), backend: agentJev({ model: { haiku: 0.05, sonnet: 0.85, opus: 0.1 }, effort: [0, 0.1, 0.8, 0.1, 0] }) })
  // The engine names another model on a later step (its fallback under load): the mod writes the effort and leaves the model.
  await w.step({ index: 0, turnId: 'sub-1', agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'medium', task: TASK })
  expect((await w.board()).nodes.find((one) => one.id === 'a1')).toMatchObject({ routed: true, model: 'sonnet', effort: 'high' })
  await w.step({ index: 1, turnId: 'sub-1', agentId: 'a1', model: 'claude-haiku-5-5', effort: 'medium' })

  expect(w.steps.map((s) => `${s.model} ${String(s.effort)}`)).toEqual(['claude-sonnet-5-5 high', 'claude-haiku-5-5 high'])
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
