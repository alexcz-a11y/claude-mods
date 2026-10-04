// Forced escalation (#7): seam 1 (engine events in; what reaches the engine,
// the decision backend and the status line out). A loop whose tool calls keep
// failing is asked about again, with the trouble and the question whether the
// failures were expected, and goes up a level (or to max) unless they were.

import { expect, test } from 'claude-code/testing'
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
  expect(log[0]).toContain('#2 escalation: effort medium (kept) for step 1 (2 failed tool calls): the failures are expected (p 0.90, thetaExpected 0.60), so nothing is forced; ')
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
