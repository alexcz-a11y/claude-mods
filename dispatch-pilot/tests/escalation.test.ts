// Forced escalation (#7): seam 1 (engine events in; what reaches the engine,
// the decision backend and the status line out). A loop whose tool calls keep
// failing is asked about again, with the trouble and the question whether the
// failures were expected, and goes up a level (or to max) unless they were.

import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { briefOf, expectedFailurePart, stepsFromRows, type TranscriptRow } from '../hooks/decision/escalation.ts'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import { midturnEffortPart, midturnState, type MidturnInput } from '../hooks/decision/midturn.ts'
import { mergeParts } from '../hooks/decision/system-one.ts'
import { jev, world, type Reply, type Sent, type ToolRun } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }
/** No periodic mid-turn re-decisions (they have their own tests): the only requests are this feature's. */
const ONLY = { ...KEY, rejudgeEvery: 0 }

/** The ids of a request's questions, joined: `effort.level` for a message, `midturn.level,escalation.expected` for a stuck loop. */
function kind(request: Sent | undefined): string {
  return Object.keys(request?.body?.questions ?? {}).join(',')
}

const LOW = [0.9, 0.1, 0, 0, 0]
const MEDIUM = [0, 1, 0, 0, 0]
const HIGH = [0, 0, 1, 0, 0]
const XHIGH = [0, 0, 0.1, 0.8, 0.1]

type Stuck = {
  /** What the effort question of the stuck re-decision answers. */
  levels?: readonly number[]
  confidence?: number
  /** The probability that the failures were expected. */
  expected?: number
}

/** Jev answering the message's request with `start`, and a stuck re-decision with `stuck`. */
function answers(start: readonly number[], stuck: Stuck = {}) {
  const { levels = MEDIUM, confidence = 0.8, expected = 0.1 } = stuck
  return (request: Sent): Reply => {
    if (!('escalation.expected' in (request.body?.questions ?? {}))) return jev(start)(request)
    const reply = jev(levels, { confidence })(request) as { status: number; body: { answers: Record<string, unknown> } }
    reply.body.answers['escalation.expected'] = { type: 'noul', noul: expected }
    return reply
  }
}

const FAILS = { error: 'exit status 1' }
/** What Claude Code answers when the person refuses a call at the permission prompt. */
const REFUSED_AT_PROMPT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
/** A PreToolUse settings hook refusing the call. */
const BLOCKED = { blockedByHook: 'git push is blocked by policy' }

/** A step whose response makes these two calls, which end as `ends` says. */
const calls = (index: number, ends: NonNullable<ToolRun['ends']>) => ({
  index,
  tools: [
    { tool: 'Bash', input: { command: 'git push origin main', description: '推送到远端' }, ends },
    { tool: 'Bash', input: { command: 'git push origin dev', description: '推送 dev' }, ends },
  ],
})

/** A step whose response runs two commands that both fail. */
const failing = (index: number) => ({
  index,
  answer: `第 ${index} 步：跑测试。`,
  tools: [
    { tool: 'Bash', input: { command: 'pnpm test auth', description: '跑 auth 的测试' }, ends: FAILS },
    { tool: 'Bash', input: { command: 'pnpm test api', description: '跑 api 的测试' }, ends: FAILS },
  ],
})

test('two failed tool calls: the next step is asked about again, with the trouble and whether the failures were expected, and goes out one level higher', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM) })
  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step(failing(0))
  await w.step({ index: 1 })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level,escalation.expected'])
  expect(w.requests[1]?.body.state.trouble).toBe('2 tool calls have failed while working on this request')
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'high'])
})

test('a call the person refused is never a failure, however often they refuse', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM) })
  await w.submit('把 main 分支推上去')
  await w.step(calls(0, { error: REFUSED_AT_PROMPT }))
  await w.step(calls(1, { error: REFUSED_AT_PROMPT }))
  await w.step({ index: 2 })

  expect(w.requests.map(kind)).toEqual(['effort.level'])
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'medium'])
})

test('a call one of your hooks blocked is not a failure unless the hook-block-failures switch is on (it is off by default)', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM), store: {}, session: true })
  await w.start()
  expect(await w.command('dp')).toContain('off  hook-block-failures')
  await w.submit('把 main 分支推上去')
  await w.step(calls(0, BLOCKED))
  await w.step(calls(1, BLOCKED))
  await w.step({ index: 2 })

  expect(w.requests.map(kind)).toEqual(['effort.level'])
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'medium'])
})

test("a call a plugin's own tool.call hook refused (as Dispatch Pilot hands a Workflow script back) is nobody's failure, whatever the switches say", { options: ONLY }, async ($, on) => {
  on('tool.call', { tool: /^Handback$/ }, () => ({ deny: 'Workflow sent back with a recommendation for each agent' }))
  const w = world($, on, { backend: answers(MEDIUM), store: {}, session: true })
  await w.start()
  await w.command('dp', 'hook-block-failures on')
  await w.submit('把登录模块重构成三层')
  await w.step({ index: 0, tools: [{ tool: 'Handback', input: {} }, { tool: 'Handback', input: {} }] })
  await w.step({ index: 1 })

  expect(w.requests.map(kind)).toEqual(['effort.level'])
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium'])
  expect(w.status()).toBe('dp effort medium')
})

test('with the hook-block-failures switch on, the same blocks count: the loop is asked about, and goes one level higher', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM), store: {}, session: true })
  await w.start()
  expect(await w.command('dp', 'hook-block-failures on')).toContain('hook-block-failures is on')
  await w.submit('把 main 分支推上去')
  await w.step(calls(0, BLOCKED))
  await w.step({ index: 1 })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level,escalation.expected'])
  expect(w.requests[1]?.body.state.trouble).toBe('2 tool calls have failed or been blocked by a hook while working on this request')
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'high'])
})

test('escalateMode "max" sends the loop straight to max, from wherever it was', { options: { ...ONLY, escalateMode: 'max' } }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM) })
  await w.submit('把登录模块重构成三层')
  await w.step(failing(0))
  await w.step({ index: 1 })

  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'max'])
})

test('a one-level raise stops at xhigh: a loop already there is not asked about and keeps its level, and its failures are written off', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: answers(XHIGH), store: {}, session: true })
  await w.start()
  await w.submit('把登录模块重构成三层')
  await w.step(failing(0))
  await w.step({ index: 1 })

  expect(w.requests.map(kind)).toEqual(['effort.level'])
  expect(w.steps.map((s) => s.effort)).toEqual(['xhigh', 'xhigh'])
  const log = (await w.command('dp', 'log')).split('\n').filter((line) => line.includes(' escalation: '))
  expect(log).toEqual(['#2 escalation: effort xhigh (kept) for step 1 (2 failed tool calls): a one-level raise stops at xhigh'])
})

test('the decision model can put the loop higher than one level when it is sure; never lower than one level', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM, { levels: XHIGH, confidence: 0.8 }) })
  await w.submit('把登录模块重构成三层')
  await w.step(failing(0))
  await w.step({ index: 1 })

  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'xhigh'])
})

test('an answer too unsure to raise (thetaUp) leaves the one level the failures force', { options: { ...ONLY, thetaUp: 0.9 } }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM, { levels: XHIGH, confidence: 0.8 }) })
  await w.submit('把登录模块重构成三层')
  await w.step(failing(0))
  await w.step({ index: 1 })

  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'high'])
})

/** A step whose response makes one command that fails. */
const failingOnce = (index: number) => ({ index, tools: [{ tool: 'Bash', input: { command: 'pnpm test auth', description: '跑 auth 的测试' }, ends: FAILS }] })

test('after a raise the failures start counting from zero again: one more is not enough, two are', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM) })
  await w.submit('把登录模块重构成三层')
  await w.step(failing(0)) // two failures: the next step goes up to high
  await w.step(failingOnce(1)) // one failure since
  await w.step({ index: 2 })
  await w.step(failingOnce(3)) // the second one
  await w.step({ index: 4 })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level,escalation.expected', 'midturn.level,escalation.expected'])
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'high', 'high', 'high', 'xhigh'])
})

test('a turn is raised at most escalateLimit times (2 by default), however many failures follow', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: answers(LOW) })
  await w.submit('把登录模块重构成三层')
  await w.step(failing(0))
  await w.step(failing(1))
  await w.step(failing(2))
  await w.step(failing(3))
  await w.step({ index: 4 })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level,escalation.expected', 'midturn.level,escalation.expected'])
  expect(w.steps.map((s) => s.effort)).toEqual(['low', 'medium', 'high', 'high', 'high'])
})

test('escalateLimit sets how many raises a turn gets; escalateAfter how many failures make one', { options: { ...ONLY, escalateLimit: 1, escalateAfter: 3 } }, async ($, on) => {
  const w = world($, on, { backend: answers(LOW) })
  await w.submit('把登录模块重构成三层')
  await w.step(failing(0)) // two failures: not yet
  await w.step(failing(1)) // four: the first raise
  await w.step(failing(2))
  await w.step(failing(3))
  await w.step({ index: 4 })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level,escalation.expected'])
  expect(w.steps.map((s) => s.effort)).toEqual(['low', 'low', 'medium', 'medium', 'medium'])
})

test('failures the decision model finds expected (a test written to fail first) force nothing: the effort stays, the count starts over, the decision is recorded', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM, { expected: 0.9 }), store: {}, session: true })
  await w.start()
  await w.submit('先写一个失败的测试，确认它红了再动手实现')
  await w.step(failing(0))
  await w.step(failingOnce(1)) // asked here: expected
  await w.step({ index: 2 }) // one failure since: not enough
  await w.step(failingOnce(3))
  await w.step({ index: 4 }) // two since: asked again

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level,escalation.expected', 'midturn.level,escalation.expected'])
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'medium', 'medium', 'medium'])
  const log = (await w.command('dp', 'log')).split('\n').filter((line) => line.includes(' escalation: '))
  expect(log[0]).toContain('#2 escalation: effort medium (kept) for step 1 (2 failed tool calls): the failures are expected (p 0.90, thetaExpected 0.25), so nothing is forced; ')
})

test('an expected verdict leaves an ordinary re-decision: the answer moves the level by the usual rules; the same answer to failures that are not expected raises it', { options: ONLY }, async ($, on) => {
  const calm = world($, on, { backend: answers(HIGH, { levels: LOW, confidence: 0.9, expected: 0.9 }) })
  await calm.submit('先写一个失败的测试，确认它红了再动手实现')
  await calm.step(failing(0))
  await calm.step({ index: 1 })

  expect(calm.steps.map((s) => s.effort)).toEqual(['high', 'medium'])
})

test('failures that are not expected raise the loop, whatever else the answer says about the effort', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: answers(HIGH, { levels: LOW, confidence: 0.9, expected: 0.1 }) })
  await w.submit('先写一个失败的测试，确认它红了再动手实现')
  await w.step(failing(0))
  await w.step({ index: 1 })

  expect(w.steps.map((s) => s.effort)).toEqual(['high', 'xhigh'])
})

test('by default an answer of 0.25 or more counts the failures as expected (the decision model rates real ones well below that), less does not', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => answers(MEDIUM, { expected: n === 2 ? 0.25 : 0.24 })(request) })
  await w.submit('把登录模块重构成三层')
  await w.step(failing(0))
  await w.step({ index: 1 }) // 0.25: expected
  await w.step(failing(2))
  await w.step({ index: 3 }) // 0.24: not

  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'medium', 'high'])
})

test('thetaExpected sets how sure the answer must be that the failures are expected', { options: { ...ONLY, thetaExpected: 0.8 } }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM, { expected: 0.7 }) })
  await w.submit('先写一个失败的测试，确认它红了再动手实现')
  await w.step(failing(0))
  await w.step({ index: 1 })

  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'high'])
})

test('without an answer (the request failed, or it left the question out) the failures are not known to be expected: the loop goes up', { options: ONLY }, async ($, on) => {
  const down = world($, on, { backend: (request, n) => (n === 1 ? jev(MEDIUM)(request) : { status: 503, body: 'overloaded' }), store: {}, session: true })
  await down.start()
  await down.submit('把登录模块重构成三层')
  await down.step(failing(0))
  await down.step({ index: 1 })

  expect(down.steps.map((s) => s.effort)).toEqual(['medium', 'high'])
  const log = (await down.command('dp', 'log')).split('\n').filter((line) => line.includes(' escalation: '))
  expect(log[0]).toContain('effort high (was medium) for step 1 (2 failed tool calls): forced one level up')
  expect(log[0]).toContain('no answer (jev: busy (HTTP 503))')
})

/** A tool call as the transcript holds it once it has failed. */
const failedCall = (id: string, command: string, description: string) => ({ tool_use_id: id, tool: 'Bash', input: { command, description }, text: 'FAIL src/auth.test.ts', isError: true as const })

test('the re-decision reads the turn the way a mid-turn one does: the message, the step, the level, the counts and the latest steps with how each call ended (spec #67)', { options: ONLY }, async ($, on) => {
  // The conversation so far, as `$.session.messages()` has it: an earlier turn, then this one's message and its first step.
  const messages: SessionMessage[] = [
    { role: 'user', text: '上一件事', toolUses: [] },
    { role: 'assistant', text: '上一件事做完了。', toolUses: [] },
    { role: 'user', text: '把登录模块重构成三层，并补上测试', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [] },
    { role: 'assistant', text: '第 0 步：跑测试。', toolUses: [failedCall('toolu_a', 'pnpm test auth', '跑 auth 的测试'), failedCall('toolu_b', 'pnpm test api', '跑 api 的测试')] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_a', text: 'FAIL', isError: true }, { tool_use_id: 'toolu_b', text: 'FAIL', isError: true }] },
  ]
  const w = world($, on, { backend: answers(MEDIUM), messages })
  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step(failing(0))
  await w.step({ index: 1 })

  const expected: MidturnInput = {
    message: '把登录模块重构成三层，并补上测试',
    step: 1,
    current_effort: 'medium',
    counts: { judgments: 1, changes: 0, failures: 2, hook_blocks: 0 },
    recent_steps: [{ assistant_text: '第 0 步：跑测试。', tools: [{ name: 'Bash', result: '失败：跑 auth 的测试' }, { name: 'Bash', result: '失败：跑 api 的测试' }] }],
    trouble: '2 tool calls have failed while working on this request',
  }
  expect(w.requests[1]?.body).toEqual({ model: JEV_MODEL, ...mergeParts(midturnState(expected, { steps: 4, tokens: 2000 }), [midturnEffortPart({}, { trouble: true }), expectedFailurePart()]) })
  // Neither the commands nor what they printed goes.
  const sent = JSON.stringify(w.requests[1]?.body)
  expect(sent).not.toContain('pnpm test')
  expect(sent).not.toContain('FAIL src')
})

test("the person's lock holds the effort whatever fails: nothing is asked, the lock is what goes out", { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM), store: {}, session: true })
  await w.start()
  await w.command('dp', 'lock low')
  await w.submit('把登录模块重构成三层')
  await w.step(failing(0))
  await w.step({ index: 1 })

  expect(w.requests.map(kind)).toEqual(['effort.level'])
  expect(w.steps.map((s) => s.effort)).toEqual(['low', 'low'])
})

test('/dp escalation off stops the counting and the raises; /dp off does too', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM), store: {}, session: true })
  await w.start()
  expect(await w.command('dp', 'escalation off')).toContain('escalation is off')
  await w.submit('把登录模块重构成三层')
  await w.step(failing(0))
  await w.step({ index: 1 })
  await w.command('dp', 'escalation on')
  await w.step(failing(2)) // counted from here on
  await w.step({ index: 3 })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level,escalation.expected'])
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'medium', 'high'])
})

test('without a decision model set up (no key) the mod does nothing, failures or not', async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM) })
  await w.submit('把登录模块重构成三层')
  await w.step({ ...failing(0), effort: 'medium' })
  await w.step({ index: 1, effort: 'medium' })

  expect(w.requests).toHaveLength(0)
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium'])
})

test("a turn the decision model did not route at its start still goes up: the raise lifts the session's own effort", { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => (n === 1 ? { status: 503, body: 'overloaded' } : answers(MEDIUM)(request)) })
  await w.submit('把登录模块重构成三层')
  await w.step({ ...failing(0), effort: 'medium' })
  await w.step({ index: 1, effort: 'medium' })
  await w.step({ index: 2, effort: 'medium' })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level,escalation.expected'])
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'high', 'high'])
})

test('a model that takes no effort level has nothing to raise: nothing is asked', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM) })
  await w.submit('把登录模块重构成三层')
  await w.step({ ...failing(0), effort: null })
  await w.step({ index: 1, effort: null })

  expect(w.requests.map(kind)).toEqual(['effort.level'])
  expect(w.steps.map((s) => s.effort)).toEqual([undefined, undefined])
})

test("a mid-turn re-decision due at the same step cannot undercut the raise: the turn never goes below the level the failures forced", { options: { ...KEY, rejudgeEvery: 2 } }, async ($, on) => {
  // Every mid-turn answer says low; the stuck re-decision says medium and not expected.
  const w = world($, on, { backend: (request, n) => (n > 1 && kind(request) === 'midturn.level' ? jev(LOW, { confidence: 0.9 })(request) : answers(MEDIUM)(request)) })
  await w.submit('把登录模块重构成三层')
  await w.step({ index: 0, tools: [{ tool: 'Read', input: { file_path: '/repo/src/auth/index.ts' } }] })
  await w.step(failing(1)) // its first call starts the mid-turn re-decision for step 2
  await w.step({ index: 2 })
  await w.step({ index: 3, tools: [{ tool: 'Read', input: { file_path: '/repo/src/auth/login.ts' } }] }) // asks again, for step 4
  await w.step({ index: 4 })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level', 'midturn.level,escalation.expected', 'midturn.level'])
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'high', 'high', 'high'])
})

test("the status line shows the turn's failed calls, the calls a hook blocked (whether or not they count) and the raises, once there is something to show", { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM) })
  await w.submit('把登录模块重构成三层')
  await w.step({ index: 0 })
  expect(w.status()).toBe('dp effort medium')
  await w.step(failingOnce(1))
  expect(w.status()).toBe('dp effort medium | failed 1')
  await w.step(calls(2, BLOCKED))
  expect(w.status()).toBe('dp effort medium | failed 1, blocked 2')
  await w.step(failingOnce(3)) // the second counted failure: asked about at the next step
  await w.step({ index: 4 })
  expect(w.status()).toBe('dp effort high | failed 2, blocked 2, raised 1')

  await w.submit('再看看另一个模块')
  await w.step({ index: 0 })
  expect(w.status()).toBe('dp effort medium')
})

test("an agent's failed calls and raises show beside the agent's own segment", { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: withAgents({ model: { sonnet: 1 }, effort: MEDIUM }), messages: agentRows })
  const { agentId } = (await w.spawn({ prompt: agentRows[0]?.text ?? '', description: 'Fix auth tests' })) as { agentId: string }
  await w.step(agentStep(agentId, 0, { tools: agentFailing }))
  expect(w.status()).toBe('dp agent sonnet medium | agent failed 2')
  await w.step(agentStep(agentId, 1))
  expect(w.status()).toBe('dp agent sonnet medium | agent failed 2, raised 1')
})

test('a new turn starts the count and the limit afresh', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: answers(LOW) })
  await w.submit('把登录模块重构成三层')
  await w.step(failing(0))
  await w.step({ index: 1 }) // raised once (two failures)
  await w.step(failingOnce(2)) // one failure left over at the end of the turn

  await w.submit('再看看另一个模块')
  await w.step(failingOnce(0)) // one failure in the new turn
  await w.step({ index: 1 })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level,escalation.expected', 'effort.level'])
  expect(w.steps.map((s) => `${s.turnId}:${String(s.effort)}`)).toEqual(['t1:low', 't1:medium', 't1:medium', 't2:low', 't2:low'])
})

// Dispatched agents.

type Spawn = {
  /** The model question's probability for each option. */
  model: Record<string, number>
  /** The effort levels' probabilities, lowest first. */
  effort?: readonly number[]
}

/** Jev answering an agent's decision at spawn with `spawn`, a stuck re-decision with `stuck`, and anything else (a message) with `start`. */
function withAgents(spawn: Spawn, stuck: Stuck = {}, start: readonly number[] = MEDIUM) {
  const stuckAnswer = answers(start, stuck)
  return (request: Sent): Reply => {
    const questions = (request.body?.questions ?? {}) as Record<string, { type: string; criteria?: unknown }>
    if (!('agent.model' in questions)) return stuckAnswer(request)
    const out: Record<string, unknown> = {}
    for (const [id, question] of Object.entries(questions)) {
      if (question.type === 'choice') {
        const options = Object.keys((question.criteria ?? {}) as Record<string, unknown>)
        const probabilities = Object.fromEntries(options.map((option) => [option, spawn.model[option] ?? 0]))
        const choice = options.reduce((best, option) => ((probabilities[option] ?? 0) > (probabilities[best] ?? 0) ? option : best), options[0] ?? '')
        out[id] = { type: 'choice', choice, probabilities, confidence: 0.9 }
      } else if (question.type === 'score') {
        const levels = spawn.effort ?? MEDIUM
        out[id] = { type: 'score', score: 0, legend: {}, probabilities: Object.fromEntries(levels.map((p, i) => [String(i), p])), confidence: 0.7 }
      } else {
        out[id] = { type: 'noul', noul: 0 }
      }
    }
    return { status: 200, body: { model: 'jev-1.13.0', answers: out, usage: { input_tokens: 400, output_tokens: 0 } } }
  }
}

/** The transcript of an agent whose two calls failed: its task, one step, the two results. */
const agentRows: SessionMessage[] = [
  { role: 'user', text: 'Make the failing auth tests pass: run `pnpm test auth`, find what breaks and fix it.', toolUses: [] },
  { role: 'assistant', text: "I'll run the tests first.", toolUses: [failedCall('toolu_a', 'pnpm test auth', 'Run the auth tests'), failedCall('toolu_b', 'pnpm test auth --bail', 'Run the auth tests, bail out')] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_a', text: 'FAIL', isError: true }, { tool_use_id: 'toolu_b', text: 'FAIL', isError: true }] },
]

/** One step of a dispatched agent's loop (the engine's own effort on it: `effort`). */
const agentStep = (agentId: string, index: number, more: { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null; tools?: ToolRun[]; answer?: string } = {}) => ({
  index,
  turnId: 'sub-1',
  agentId,
  model: more.model ?? 'claude-sonnet-5-5',
  effort: more.effort === undefined ? 'high' : more.effort,
  ...(more.tools === undefined ? {} : { tools: more.tools }),
  ...(more.answer === undefined ? {} : { answer: more.answer }),
})

const agentFailing: ToolRun[] = [
  { tool: 'Bash', input: { command: 'pnpm test auth', description: 'Run the auth tests' }, ends: FAILS },
  { tool: 'Bash', input: { command: 'pnpm test auth --bail', description: 'Run the auth tests, bail out' }, ends: FAILS },
]

test("a dispatched agent whose tool calls keep failing goes up a level on every step that follows, asked about with its own task and steps", { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: withAgents({ model: { sonnet: 1 }, effort: MEDIUM }), messages: agentRows })
  const { agentId } = (await w.spawn({ prompt: agentRows[0]?.text ?? '', description: 'Fix auth tests' })) as { agentId: string }
  await w.step(agentStep(agentId, 0, { tools: agentFailing }))
  await w.step(agentStep(agentId, 1))
  await w.step(agentStep(agentId, 2))

  expect(w.steps.map((s) => String(s.effort))).toEqual(['medium', 'high', 'high'])
  const asked = w.requests.filter((r) => 'escalation.expected' in r.body.questions)
  expect(asked).toHaveLength(1)
  expect(asked[0]?.body.state.user_message).toBe(agentRows[0]?.text)
  expect(asked[0]?.body.state.recent_steps).toEqual([
    { assistant_text: "I'll run the tests first.", tools: [{ name: 'Bash', result: 'Failed: Run the auth tests' }, { name: 'Bash', result: 'Failed: Run the auth tests, bail out' }] },
  ])
})

const HAIKU = { model: 'claude-haiku-4-5-20251001', effort: null }

test('a haiku agent has no effort to raise: it goes on as sonnet, named by its full id (the engine takes no alias for a step), and the decision is recorded', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: withAgents({ model: { haiku: 1 } }), messages: agentRows, store: {}, session: true })
  await w.start()
  const { agentId } = (await w.spawn({ prompt: agentRows[0]?.text ?? '', description: 'Find the auth failures', subagentType: 'Explore' })) as { agentId: string }
  await w.step(agentStep(agentId, 0, { ...HAIKU, tools: agentFailing }))
  await w.step(agentStep(agentId, 1, HAIKU))
  await w.step(agentStep(agentId, 2, HAIKU))

  expect(w.steps.map((s) => s.model)).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-5-5', 'claude-sonnet-5-5'])
  const asked = w.requests.filter((r) => 'escalation.expected' in r.body.questions)
  expect(asked).toHaveLength(1)
  // A haiku agent's effort is not asked about: only whether the failures were expected.
  expect(Object.keys(asked[0]?.body.questions)).toEqual(['escalation.expected'])
  expect(asked[0]?.body.state.current_effort).toBeUndefined()
  const log = (await w.command('dp', 'log')).split('\n').filter((line) => line.includes(' escalation: '))
  expect(log).toHaveLength(1)
  expect(log[0]).toContain('model claude-sonnet-5-5 (was claude-haiku-4-5-20251001) for agent "Make the failing auth tests pass: run `p...", step 1 (2 failed tool calls)')
  expect(log[0]).toContain('a haiku agent has no effort to raise, so it is switched to claude-sonnet-5-5; not expected (p 0.10, thetaExpected 0.25)')
})

test('escalateHaikuTo names the model a failing haiku agent is switched to', { options: { ...ONLY, escalateHaikuTo: 'claude-sonnet-9-9' } }, async ($, on) => {
  const w = world($, on, { backend: withAgents({ model: { haiku: 1 } }), messages: agentRows })
  const { agentId } = (await w.spawn({ prompt: agentRows[0]?.text ?? '', description: 'Find the auth failures' })) as { agentId: string }
  await w.step(agentStep(agentId, 0, { ...HAIKU, tools: agentFailing }))
  await w.step(agentStep(agentId, 1, HAIKU))

  expect(w.steps.map((s) => s.model)).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-9-9'])
})

test('failures the decision model finds expected change nothing about an agent, haiku or not', { options: ONLY }, async ($, on) => {
  const sonnet = world($, on, { backend: withAgents({ model: { sonnet: 1 }, effort: MEDIUM }, { expected: 0.9 }), messages: agentRows })
  const { agentId } = (await sonnet.spawn({ prompt: agentRows[0]?.text ?? '', description: 'Fix auth tests' })) as { agentId: string }
  await sonnet.step(agentStep(agentId, 0, { tools: agentFailing }))
  await sonnet.step(agentStep(agentId, 1))

  expect(sonnet.steps.map((s) => String(s.effort))).toEqual(['medium', 'medium'])
  expect(sonnet.requests.filter((r) => 'escalation.expected' in r.body.questions)).toHaveLength(1)
})

test("an agent whose transcript cannot be read (a workflow's) is raised without being asked whether its failures were expected", { options: ONLY }, async ($, on) => {
  on('session.messages', { agentId: /(?:)/ }, () => ({ value: { deny: "wf1 is not one of this session's agents" } }))
  const w = world($, on, { backend: withAgents({ model: { sonnet: 1 } }), store: {}, session: true })
  await w.start()
  await w.step(agentStep('wf1', 0, { effort: 'medium', tools: agentFailing }))
  await w.step(agentStep('wf1', 1, { effort: 'medium' }))
  await w.step(agentStep('wf1', 2, { effort: 'medium' }))

  expect(w.requests).toHaveLength(0)
  expect(w.steps.map((s) => String(s.effort))).toEqual(['medium', 'high', 'high'])
  const log = (await w.command('dp', 'log')).split('\n').filter((line) => line.includes(' escalation: '))
  expect(log[0]).toContain('effort high (was medium) for agent wf1, step 1 (2 failed tool calls): forced one level up; no transcript of this agent to read, so not asked whether the failures were expected')
})

test('an agent is raised at most escalateLimit times, and a one-level raise stops at xhigh', { options: ONLY }, async ($, on) => {
  const w = world($, on, { backend: withAgents({ model: { sonnet: 1 }, effort: LOW }), messages: agentRows })
  const { agentId } = (await w.spawn({ prompt: agentRows[0]?.text ?? '', description: 'Fix auth tests' })) as { agentId: string }
  await w.step(agentStep(agentId, 0, { tools: agentFailing }))
  await w.step(agentStep(agentId, 1, { tools: agentFailing }))
  await w.step(agentStep(agentId, 2, { tools: agentFailing }))
  await w.step(agentStep(agentId, 3))

  expect(w.steps.map((s) => String(s.effort))).toEqual(['low', 'medium', 'high', 'high'])
  expect(w.requests.filter((r) => 'escalation.expected' in r.body.questions)).toHaveLength(2)
})

// The decision module (a public interface for the eval): reading a loop's steps from its transcript.

const call = (id: string, description: string, isError?: true) => ({ tool_use_id: id, tool: 'Bash', input: { description }, text: isError ? 'FAIL' : 'ok', ...(isError ? { isError } : {}) })
const REMINDER = '<system-reminder>The task tools have not been used recently.</system-reminder>'

test('a user row that only holds a system reminder is not something the person said: the steps before it stay, and the task is what was said', () => {
  const rows: TranscriptRow[] = [
    { role: 'user', text: REMINDER, toolUses: [] },
    { role: 'user', text: '修一下登录', toolUses: [] },
    { role: 'assistant', text: '先跑测试。', toolUses: [call('a', '跑测试', true)] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'FAIL', isError: true }] },
    { role: 'user', text: REMINDER, toolUses: [] },
    { role: 'assistant', text: '再跑一次。', toolUses: [call('b', '再跑测试')] },
  ]

  expect(briefOf(rows)).toBe('修一下登录')
  expect(stepsFromRows(rows, { language: 'zh' })).toEqual([
    { assistant_text: '先跑测试。', tools: [{ name: 'Bash', result: '失败：跑测试' }] },
    { assistant_text: '再跑一次。', tools: [{ name: 'Bash', result: '成功：再跑测试' }] },
  ])
})

test('what a person said last starts the window: the steps of the turn before are not the loop\'s', () => {
  const rows: TranscriptRow[] = [
    { role: 'user', text: '上一件事', toolUses: [] },
    { role: 'assistant', text: '做完了。', toolUses: [call('a', '跑测试')] },
    { role: 'user', text: '这一件事', toolUses: [] },
    { role: 'assistant', text: '开始。', toolUses: [call('b', 'Look around')] },
  ]

  expect(stepsFromRows(rows, { language: 'en' })).toEqual([{ assistant_text: '开始。', tools: [{ name: 'Bash', result: 'Success: Look around' }] }])
})

test('a call a hook refused reads as blocked in the steps, a call the person refused as refused, any other error as failed', () => {
  const rows: TranscriptRow[] = [
    { role: 'user', text: 'push it', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 'h', tool: 'Bash', input: { description: 'Push main' }, text: 'blocked by policy', isError: true },
        { tool_use_id: 'p', tool: 'Bash', input: { description: 'Delete build' }, text: REFUSED_AT_PROMPT, isError: true },
        { tool_use_id: 'f', tool: 'Bash', input: { description: 'Run tests' }, text: 'FAIL', isError: true },
      ],
    },
  ]

  expect(stepsFromRows(rows, { language: 'en', blocked: (id) => id === 'h' })).toEqual([
    {
      assistant_text: '',
      tools: [
        { name: 'Bash', result: 'Blocked by hook: Push main' },
        { name: 'Bash', result: 'Denied by user: Delete build' },
        { name: 'Bash', result: 'Failed: Run tests' },
      ],
    },
  ])
})
