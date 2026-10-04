// The main agent's effort, re-decided while a turn runs (#5): seam 1 (engine
// events in; what reaches the engine, the decision backend and the status
// line out).

import { expect, test } from 'claude-code/testing'
import { estimateTokens } from '../hooks/decision/context.ts'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import { midturnEffortPart, midturnState, type MidturnInput } from '../hooks/decision/midturn.ts'
import { mergeParts } from '../hooks/decision/system-one.ts'
import { jev, world, type Sent } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }

/** The ids of a request's questions: `effort.level` when a message is sent, `midturn.level` mid-turn. */
function kind(request: Sent | undefined): string {
  return Object.keys(request?.body?.questions ?? {}).join(',')
}

/** Jev answering the message's request with `start` and each mid-turn request with the next of `midturn`. */
function answers(start: readonly number[], ...midturn: { levels: readonly number[]; confidence?: number | null }[]) {
  let asked = 0
  return (request: Sent) => {
    if (kind(request) !== 'midturn.level') return jev(start)(request)
    const next = midturn[Math.min(asked++, midturn.length - 1)] as { levels: readonly number[]; confidence?: number | null }
    return jev(next.levels, { confidence: next.confidence })(request)
  }
}

const MEDIUM = [0, 1, 0, 0, 0]
const XHIGH = [0, 0, 0.1, 0.8, 0.1]
const LOW = [0.9, 0.1, 0, 0, 0]

/** A step whose response calls one tool (the call a re-decision goes out with). */
const working = (index: number) => ({ index, answer: `第 ${index} 步`, tools: [{ tool: 'Read', input: { file_path: `/repo/src/f${index}.ts` } }] })

test('every N steps the effort is re-decided: asked while the tool of the step before runs, used from step N on', { options: { ...KEY, rejudgeEvery: 2 } }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM, { levels: XHIGH }) })
  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step({ index: 0, answer: '先看一下目录结构。', tools: [{ tool: 'Glob', input: { pattern: 'src/auth/**' } }] })
  await w.step({ index: 1, answer: '读一下入口文件。', tools: [{ tool: 'Read', input: { file_path: '/repo/src/auth/index.ts' } }] })
  await w.step({ index: 2 })
  await w.step({ index: 3 })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level'])
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'xhigh', 'xhigh'])
})

test("the re-decision reads the turn's message, the step it is for, the level and counts, and the latest steps with how each tool call ended (spec #67)", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: answers([0, 0, 1, 0, 0], { levels: XHIGH }) })
  await w.submit('修复登录接口偶发 502 的问题')
  await w.step({ index: 0, answer: '先看看日志。', tools: [{ tool: 'Bash', input: { command: 'tail -n 50 logs/app.log', description: '查看最近的日志' } }] })
  await w.step({ index: 1, answer: '读一下代理配置。', tools: [{ tool: 'Read', input: { file_path: '/repo/src/server/proxy.ts' }, ends: { error: 'File does not exist.' } }] })
  // The third step's call starts the re-decision for step 3 (every 3 steps by default): it is still running.
  await w.step({ index: 2, answer: '换个路径再读。', tools: [{ tool: 'Read', input: { file_path: '/repo/src/proxy.ts' } }] })

  const expected: MidturnInput = {
    message: '修复登录接口偶发 502 的问题',
    step: 3,
    current_effort: 'high',
    counts: { judgments: 1, changes: 0, failures: 1, hook_blocks: 0 },
    recent_steps: [
      { assistant_text: '先看看日志。', tools: [{ name: 'Bash', result: '成功：查看最近的日志' }] },
      { assistant_text: '读一下代理配置。', tools: [{ name: 'Read', result: '失败：server/proxy.ts' }] },
      { assistant_text: '换个路径再读。', tools: [{ name: 'Read', result: '进行中：src/proxy.ts' }] },
    ],
  }
  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level'])
  expect(w.requests[1]?.body).toEqual({ model: JEV_MODEL, ...mergeParts(midturnState(expected, { steps: 4, tokens: 2000 }), [midturnEffortPart()]) })
  // Neither the tools' output nor their other input goes.
  const sent = JSON.stringify(w.requests[1]?.body)
  expect(sent).not.toContain('tail -n 50')
  expect(sent).not.toContain('File does not exist')
})

test('rejudgeSteps sets how many of the latest steps the re-decision reads; contextTokens bounds the whole state', { options: { ...KEY, rejudgeSteps: 2, contextTokens: 300 } }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM, { levels: MEDIUM }) })
  await w.submit('把会话模块的过期逻辑彻底查清楚')
  await w.step(working(0))
  await w.step(working(1))
  await w.step(working(2)) // its call starts the re-decision for step 3

  const state = w.requests[1]?.body.state
  expect((state.recent_steps as { assistant_text: string }[]).map((s) => s.assistant_text)).toEqual(['第 1 步', '第 2 步'])
  expect(estimateTokens(JSON.stringify(state))).toBeLessThanOrEqual(300)
})

test('going down needs a surer answer (thetaDown) than going up, and goes one level at a time', { options: { ...KEY, rejudgeEvery: 2 } }, async ($, on) => {
  const w = world($, on, {
    backend: answers([0, 0, 0, 1, 0], { levels: LOW, confidence: 0.5 }, { levels: LOW, confidence: 0.8 }, { levels: LOW, confidence: 0.8 }),
  })
  await w.submit('把会话模块的过期逻辑彻底查清楚')
  for (const index of [0, 1, 2, 3, 4, 5]) await w.step({ ...working(index), effort: 'medium' })
  await w.step({ index: 6, effort: 'medium' })

  // Asked for steps 2, 4 and 6: at 0.5 the answer is not sure enough to lower xhigh; at 0.8 it lowers one level each time.
  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level', 'midturn.level', 'midturn.level'])
  expect(w.steps.map((s) => s.effort)).toEqual(['xhigh', 'xhigh', 'xhigh', 'xhigh', 'high', 'high', 'medium'])
})

test('going up needs thetaUp, and max needs its own probability to reach thetaMax', { options: { ...KEY, rejudgeEvery: 2, thetaUp: 0.5, thetaMax: 0.6 } }, async ($, on) => {
  const w = world($, on, {
    backend: answers(
      MEDIUM,
      { levels: XHIGH, confidence: 0.45 }, // xhigh, but not sure enough
      { levels: [0, 0, 0.1, 0.35, 0.55], confidence: 0.7 }, // most likely max, below thetaMax: the best of the rest
      { levels: [0, 0, 0, 0.3, 0.7], confidence: 0.7 }, // max, past thetaMax
    ),
  })
  await w.submit('设计一个跨区域的数据迁移方案，保证零停机')
  for (const index of [0, 1, 2, 3, 4, 5]) await w.step(working(index))
  await w.step({ index: 6 })

  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'medium', 'medium', 'xhigh', 'xhigh', 'max'])
})

test('after a raise the effort holds for holdSteps steps before it may go down again', { options: { ...KEY, rejudgeEvery: 2, holdSteps: 3 } }, async ($, on) => {
  const w = world($, on, {
    backend: answers(MEDIUM, { levels: XHIGH, confidence: 0.8 }, { levels: LOW, confidence: 0.9 }, { levels: LOW, confidence: 0.9 }),
  })
  await w.submit('把这个死锁查清楚')
  for (const index of [0, 1, 2, 3, 4, 5]) await w.step(working(index))
  await w.step({ index: 6 })

  // Raised at step 2; a sure "low" at step 4 is two steps later and holds; at step 6, four steps later, it lowers one level.
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'xhigh', 'xhigh', 'xhigh', 'xhigh', 'high'])
})

test('dispatching an agent, loading a skill or starting a Workflow re-decides the effort for the next step, every N or not', { options: { ...KEY, rejudgeEvery: 0 } }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM, { levels: XHIGH, confidence: 0.8 }) })
  await w.submit('登录接口偶发 502，帮我查一下原因并修掉')
  await w.step({ index: 0, answer: '先读一下代理配置。', tools: [{ tool: 'Read', input: { file_path: '/repo/src/server/proxy.ts' } }] })
  await w.step({ index: 1, answer: '派一个 agent 去查。', tools: [{ tool: 'Agent', input: { description: '查登录 502 的根因', prompt: 'Investigate the intermittent 502 on POST /login.', subagent_type: 'general-purpose' } }] })
  await w.step({ index: 2, tools: [{ tool: 'Skill', input: { skill: 'tdd' } }] })
  await w.step({ index: 3, tools: [{ tool: 'Workflow', input: { name: 'fix-flaky-tests' } }] })
  await w.step({ index: 4 })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level', 'midturn.level', 'midturn.level'])
  const starting = w.requests.slice(1).map((r) => (r.body.state.recent_steps as { tools: { name: string; result: string }[] }[]).at(-1)?.tools.at(-1))
  expect(starting).toEqual([
    { name: 'Agent', result: '进行中：查登录 502 的根因' },
    { name: 'Skill', result: '进行中：tdd' },
    { name: 'Workflow', result: '进行中：fix-flaky-tests' },
  ])
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'xhigh', 'xhigh', 'xhigh'])
})

test('one re-decision per step, however many of its calls are reasons; each request is written to the debug log', { options: { ...KEY, rejudgeEvery: 0 } }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM, { levels: XHIGH, confidence: 0.8 }) })
  await w.submit('派两个 agent 分头查前端和后端')
  await w.step({ index: 0, tools: [{ tool: 'Agent', input: { description: '查前端' } }, { tool: 'Agent', input: { description: '查后端' } }] })
  await w.step({ index: 1 })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level'])
  expect(w.logs.filter((l) => l.text.startsWith('request [midturn.level]')).map((l) => `${String(l.to)}: ${l.text}`)).toEqual([
    'debug: request [midturn.level] for step 1 (Agent) to jev: answered in 0 ms by jev-1.13.0 (300 input tokens)',
  ])
})

test('an answer not back by its step: the step waits rejudgeWaitMs, keeps the effort it had and says so; the answer is used once it comes', { options: { ...KEY, rejudgeEvery: 2, rejudgeWaitMs: 300 } }, async ($, on) => {
  const quick = answers(MEDIUM, { levels: XHIGH, confidence: 0.8 })
  // The mid-turn answer takes a second of (mock) time, within the request's own timeout (timeoutMs, 1500).
  const w = world($, on, { backend: (request) => (kind(request) === 'midturn.level' ? { after: 1000, reply: quick(request) } : quick(request)) })
  await w.submit('把这个死锁查清楚')
  await w.step(working(0))
  await w.step(working(1))

  const late = w.step(working(2))
  await w.clock.settle() // step 2 is now waiting for the answer
  await w.clock.advance(300)
  await late
  expect(w.status()).toBe('dp effort medium | step 3, judged 1, changed 0 (late)')

  await w.clock.advance(700) // the answer comes
  await w.step({ index: 3 })
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'medium', 'xhigh'])
  expect(w.status()).toBe('dp effort xhigh | step 4, judged 2, changed 1')
})

const REFUSED_AT_PROMPT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

test("a call a PreToolUse hook blocks, or the person refuses, reads as such and is not counted as a failure; an MCP tool's error is a failure whatever it says", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM, { levels: MEDIUM }) })
  await w.submit('把 main 分支推上去，然后清理一下构建目录')
  await w.step({ index: 0, answer: '推送一下。', tools: [{ tool: 'Bash', input: { command: 'git push origin main', description: '推送到远端' }, ends: { blockedByHook: 'git push is blocked by policy' } }] })
  await w.step({
    index: 1,
    answer: '改成删除构建目录。',
    tools: [
      { tool: 'Bash', input: { command: 'rm -rf build', description: '删除构建目录' }, ends: { error: REFUSED_AT_PROMPT } },
      { tool: 'mcp__github__create_pr', input: { title: 'cleanup', description: '建 PR' }, ends: { error: REFUSED_AT_PROMPT } },
    ],
  })
  await w.step({ index: 2, tools: [{ tool: 'Bash', input: { command: 'npm test', description: '跑测试' }, ends: { error: 'FAIL src/a.test.ts' } }] })

  const state = w.requests[1]?.body.state
  expect(state.recent_steps).toEqual([
    { assistant_text: '推送一下。', tools: [{ name: 'Bash', result: '被 hook 拦截：推送到远端' }] },
    {
      assistant_text: '改成删除构建目录。',
      tools: [
        { name: 'Bash', result: '用户拒绝：删除构建目录' },
        { name: 'mcp__github__create_pr', result: '失败：建 PR' },
      ],
    },
    { assistant_text: '', tools: [{ name: 'Bash', result: '进行中：跑测试' }] },
  ])
  expect(state.counts).toEqual({ judgments: 1, changes: 0, failures: 1, hook_blocks: 1 })
})

test('a re-decision that fails leaves the effort as it was, and the status line says why', { options: { ...KEY, rejudgeEvery: 2 } }, async ($, on) => {
  const w = world($, on, { backend: (request) => (kind(request) === 'midturn.level' ? { status: 503, body: 'overloaded' } : jev(MEDIUM)(request)) })
  await w.submit('把这个死锁查清楚')
  await w.step(working(0))
  await w.step(working(1))
  await w.step({ index: 2 })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level'])
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'medium'])
  expect(w.status()).toBe('dp effort medium | step 3, judged 1, changed 0 (jev: busy (HTTP 503))')
})

test('each re-decision is recorded with why it went where it did (debug log and /dp log)', { options: { ...KEY, rejudgeEvery: 2 } }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM, { levels: XHIGH, confidence: 0.8 }, { levels: LOW, confidence: 0.9 }), store: {}, session: true })
  await w.start()
  await w.submit('把登录模块重构成三层')
  for (const index of [0, 1, 2, 3]) await w.step(working(index))
  await w.step({ index: 4 })

  const mine = (await w.command('dp', 'log')).split('\n').filter((line) => line.includes(' midturn-effort: '))
  expect(mine).toEqual([
    '#2 midturn-effort: effort xhigh (was medium) for step 2 (every 2 steps): p low 0.00, medium 0.00, high 0.10, xhigh 0.80, max 0.10; confidence 0.80; up',
    '#3 midturn-effort: effort xhigh (kept) for step 4 (every 2 steps): p low 0.90, medium 0.10, high 0.00, xhigh 0.00, max 0.00; confidence 0.90; held: raised 2 steps ago (holdSteps 3)',
  ])
  expect(w.logs.filter((l) => l.text.startsWith('effort xhigh (was medium) for step 2')).map((l) => l.to)).toEqual(['debug'])
})

test('/dp midturn-effort off stops the re-decisions; switched on again they resume', { options: { ...KEY, rejudgeEvery: 2 } }, async ($, on) => {
  const w = world($, on, { backend: answers(MEDIUM, { levels: XHIGH, confidence: 0.8 }), store: {}, session: true })
  await w.start()
  expect(await w.command('dp', 'midturn-effort off')).toContain('midturn-effort is off')
  await w.submit('把登录模块重构成三层')
  await w.step(working(0))
  await w.step(working(1))
  await w.step(working(2))
  expect(w.requests.map(kind)).toEqual(['effort.level'])

  await w.command('dp', 'midturn-effort on')
  await w.step(working(3)) // its call starts the re-decision for step 4
  await w.step({ index: 4 })
  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level'])
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'medium', 'medium', 'xhigh'])
})

/** Another feature's demand for a re-decision of turn t1 (what #7 writes when the turn is stuck), once `when()` holds. */
function demand(on: Parameters<typeof world>[1], when: () => boolean = () => true) {
  const asked = { trouble: '2 tool calls in a row have failed while working on this request', atLeast: 'high', at: 1 }
  on('state.get', async (_$, e, next) => (e.key === 'demand' && e.id === 'main:t1' && when() ? { value: { value: asked, version: 1 } } : next(e)))
  return asked
}

test('a re-decision another feature asks for (#7, the turn is stuck) goes out with its trouble, once, and the turn goes at least to the level it asks', { options: { ...KEY, rejudgeEvery: 0 } }, async ($, on) => {
  const asked = demand(on)
  const w = world($, on, { backend: answers(MEDIUM, { levels: MEDIUM, confidence: 0.9 }) })
  await w.submit('把登录模块重构成三层')
  await w.step(working(0)) // its call takes the demand
  await w.step(working(1)) // the same demand is not asked again
  await w.step({ index: 2 })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level'])
  expect(w.requests[1]?.body.state.trouble).toBe(asked.trouble)
  expect(JSON.stringify(w.requests[1]?.body.questions)).toContain('`trouble`')
  // The answer says medium; the demand asks for at least high.
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'high', 'high'])
})

test('a demand that comes after the call ended is asked at the next step; if that answer fails, the turn still goes to the level asked', { options: { ...KEY, rejudgeEvery: 0 } }, async ($, on) => {
  let ended = false
  demand(on, () => ended)
  const w = world($, on, { backend: (request) => (kind(request) === 'midturn.level' ? { status: 500, body: 'down' } : jev(MEDIUM)(request)) })
  await w.submit('把登录模块重构成三层')
  await w.step(working(0))
  ended = true // written after the call ended (by a hook outside this one)
  await w.step({ index: 1 })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level'])
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'high'])
})

test('no re-decision while the person has locked the effort, nor in a turn that was not routed when it started', { options: { ...KEY, rejudgeEvery: 1 } }, async ($, on) => {
  let locked: string | null = 'high'
  on('state.get', async (_$, e, next) => (e.key === 'lock' ? { value: { value: locked, version: 1 } } : next(e)))
  const w = world($, on, { backend: (request, n) => (n === 1 ? jev(MEDIUM)(request) : { status: 500, body: 'down' }) })
  // Locked: the turn goes at the lock, and nothing is asked mid-turn.
  await w.submit('把这个死锁查清楚')
  await w.step(working(0))
  await w.step(working(1))
  // Unlocked, but this turn's decision failed (HTTP 500): it keeps the session's effort to the end.
  locked = null
  await w.submit('再看看别的')
  await w.step({ ...working(0), effort: 'xhigh' })
  await w.step({ ...working(1), effort: 'xhigh' })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'effort.level'])
  expect(w.steps.map((s) => `${s.turnId}:${String(s.effort)}`)).toEqual(['t1:high', 't1:high', 't2:xhigh', 't2:xhigh'])
})
