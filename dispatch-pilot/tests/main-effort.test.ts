// The main agent's effort, decided when the person sends a message: seam 1
// (engine events in, what reaches the engine and the decision backend out).

import { expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import { estimateTokens, turnStartState } from '../hooks/decision/context.ts'
import { turnStartEffortPart } from '../hooks/decision/effort.ts'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import { mergeParts } from '../hooks/decision/system-one.ts'
import { jev, world, type Reply } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }

test('a message gets one Jev decision, and its turn goes out at the decided effort', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0.05, 0.1, 0.7, 0.1, 0.05]) })

  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step({ index: 0 })

  expect(w.requests).toHaveLength(1)
  const [request] = w.requests
  expect(request?.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(request?.method).toBe('POST')
  expect(request?.headers.authorization).toBe('Bearer ts-test-key')
  expect(request?.body.model).toBe('jev-latest')
  expect(request?.body.state.user_message).toBe('把登录模块重构成三层，并补上测试')
  // One Score question with five levels, lowest first (low .. max)
  expect(Object.keys(request?.body.questions)).toEqual(['effort.level'])
  expect(request?.body.questions['effort.level'].type).toBe('score')
  expect(request?.body.questions['effort.level'].criteria).toHaveLength(5)
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
})

test('every main step of the turn is re-set to the decision; the model goes out as the engine resolved it', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0.05, 0.1, 0.7, 0.1, 0.05]) })
  await w.submit('修复登录接口偶发 502 的问题')

  // The engine asks each request with its own effort again, and moves the
  // turn to another model midway (an overload fallback).
  await w.step({ index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })
  await w.step({ index: 1, model: 'claude-opus-5-5', effort: 'medium' })
  await w.step({ index: 2, model: 'claude-sonnet-5-5', effort: 'max' })

  expect(w.steps.map((s) => s.effort)).toEqual(['high', 'high', 'high'])
  expect(w.steps.map((s) => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'])
  expect(w.requests).toHaveLength(1)
})

test("a dispatched agent's steps go out as the engine sent them", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0.8, 0.1, 0.05, 0.03, 0.02]) })
  await w.submit('派两个 agent 分头查一下这两个文件')
  await w.step({ index: 0 })
  // Each dispatched agent runs its own loop: its own turn id, its agentId.
  await w.step({ index: 0, turnId: 'sub-1', agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'medium' })
  await w.step({ index: 1, turnId: 'sub-1', agentId: 'a1', model: 'claude-sonnet-5-5', effort: 'medium' })
  // Haiku takes no effort: the engine sends none, and none is added.
  await w.step({ index: 0, turnId: 'sub-2', agentId: 'a2', model: 'claude-haiku-4-5-20251001', effort: null })

  expect(w.steps).toEqual([
    { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'low', agentId: undefined },
    { turnId: 'sub-1', index: 0, model: 'claude-sonnet-5-5', effort: 'medium', agentId: 'a1' },
    { turnId: 'sub-1', index: 1, model: 'claude-sonnet-5-5', effort: 'medium', agentId: 'a1' },
    { turnId: 'sub-2', index: 0, model: 'claude-haiku-4-5-20251001', effort: undefined, agentId: 'a2' },
  ])
})

test("the main agent's node shows the effort the turn goes out at, and the old status line draws it from there", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => jev(n === 1 ? [0.05, 0.1, 0.7, 0.1, 0.05] : [0.9, 0.05, 0.05, 0, 0])(request) })
  await w.submit('把登录模块重构成三层')
  await w.step({ index: 0 })
  expect((await w.board()).main).toMatchObject({ turn: 1, effort: 'high', routed: true })
  expect(w.status()).toBe('dp effort high')
  await w.step({ index: 1 })
  await w.submit('好，提交吧')
  await w.step({ index: 0 })
  expect((await w.board()).main).toMatchObject({ turn: 2, effort: 'low', routed: true })
  expect(w.status()).toBe('dp effort low')
  // Set when it changes, not on every step.
  expect(w.statuses).toEqual(['dp effort high', 'dp effort low'])
})

test('no answer within timeoutMs: the prompt goes in without waiting longer, the turn keeps the engine effort, the board says why', { options: { ...KEY, timeoutMs: 800 } }, async ($, on) => {
  // Jev answers only after a minute of (mock) time.
  const w = world($, on, { backend: (request) => ({ after: 60_000, reply: jev([0, 0, 1, 0, 0])(request) }) })

  const submitting = w.submit('看看这个报错是怎么回事')
  await w.clock.settle() // the hook is now waiting on the request and its timer
  await w.clock.advance(800)
  await submitting // resolved at 800 ms: the prompt was not held for the slow answer
  await w.step({ index: 0, effort: 'xhigh' })
  await w.step({ index: 1, effort: 'xhigh' })

  expect(w.requests).toHaveLength(1)
  expect(w.prompts).toEqual([{ text: '看看这个报错是怎么回事', context: undefined, origin: { kind: 'composer' } }])
  expect(w.steps.map((s) => s.effort)).toEqual(['xhigh', 'xhigh'])
  expect((await w.board()).main).toMatchObject({ effort: 'xhigh', routed: false, failure: { backend: 'jev', kind: 'timeout' } })
})

// `kind` is what the board records of the failure; `status` the old status line's words for it.
const failures: { name: string; reply: Reply; kind: string; status: string }[] = [
  { name: 'the key is refused (401)', reply: { status: 401, body: { detail: 'Invalid API key' } }, kind: 'config', status: 'jev: key refused (HTTP 401)' },
  { name: 'rate limited (429)', reply: { status: 429, body: { detail: 'Too Many Requests' } }, kind: 'busy', status: 'jev: busy (HTTP 429)' },
  { name: 'a server error (500)', reply: { status: 500, body: 'Internal Server Error' }, kind: 'http', status: 'jev: HTTP 500' },
  { name: 'the network is down', reply: { reject: 'getaddrinfo ENOTFOUND api.typesafe.ai' }, kind: 'network', status: 'jev: unreachable' },
  { name: 'a 200 that is not an answer', reply: { status: 200, body: '<html>maintenance</html>' }, kind: 'parse', status: 'jev: unreadable answer' },
  { name: 'an answer without the effort question', reply: { status: 200, body: { model: 'jev-1.13.0', answers: {} } }, kind: 'parse', status: 'jev: unreadable answer' },
]

for (const failure of failures) {
  test(`${failure.name}: the turn keeps the engine effort and the board says why (and the old status line)`, { options: KEY }, async ($, on) => {
    const w = world($, on, { backend: () => failure.reply })
    await w.submit('解释一下这个函数做了什么')
    await w.step({ index: 0, effort: 'medium' })

    expect(w.requests).toHaveLength(1)
    expect(w.prompts).toHaveLength(1)
    expect(w.steps.map((s) => s.effort)).toEqual(['medium'])
    expect((await w.board()).main).toMatchObject({ effort: 'medium', routed: false, failure: { backend: 'jev', kind: failure.kind } })
    expect(w.status()).toBe(`dp effort medium (not routed) | ${failure.status}`)
  })
}

test('no TypeSafe key: nothing is sent, the turn keeps the engine effort, the board says to set the key', async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  await w.submit('解释一下这个函数做了什么')
  await w.step({ index: 0, effort: 'medium' })

  expect(w.requests).toHaveLength(0)
  expect(w.steps.map((s) => s.effort)).toEqual(['medium'])
  expect((await w.board()).main).toMatchObject({ effort: 'medium', routed: false, failure: { backend: 'jev', kind: 'config', detail: 'no TypeSafe API key: set typesafeApiKey' } })
})

test('a decision that comes back after a failure clears the reason from the status line', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => (n === 1 ? { status: 503, body: 'overloaded' } : jev([0, 1, 0, 0, 0])(request)) })
  await w.submit('第一条')
  await w.step({ index: 0, effort: 'xhigh' })
  expect(w.status()).toBe('dp effort xhigh (not routed) | jev: busy (HTTP 503)')
  await w.submit('第二条')
  await w.step({ index: 0, effort: 'xhigh' })
  expect(w.status()).toBe('dp effort medium')
})

test("what is not the person's own new message is not decided, and changes no turn's effort", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  await w.submit('把这个模块重构一下')
  await w.step({ index: 0 })
  // Delivered into the running turn t1: a dispatched agent's hand-back, a background task's notice.
  await w.submit('<agent-message from="a1">done</agent-message>', { origin: { kind: 'peer' }, turnId: 't1' })
  await w.submit('Background task "build" completed', { origin: { kind: 'task-notification' }, turnId: 't1' })
  await w.step({ index: 1 })
  // Nor a plugin's own message or an empty prompt (t2, t3). A local command (/compact) submits no prompt at all.
  await w.submit('dashboard refreshed', { origin: { kind: 'plugin', name: 'other-mod' } })
  await w.command('compact', 'keep the API notes')
  await w.submit('   ')

  expect(w.requests).toHaveLength(1)
  expect(w.steps.map((s) => `${s.turnId}:${String(s.effort)}`)).toEqual(['t1:high', 't1:high'])
})

// A turn that a dispatched agent's hand-back or a background task's notice starts (the session was idle: no running turn
// to join) is the main agent's turn like any other: it gets the same effort question, the report's text read as the message.
// Nothing is asked about skills (it is no request of the person's), and a lock of the person's still holds.

const REPORTS = [
  { name: 'a background task notice', origin: { kind: 'task-notification' } as const, text: 'Background task "lint" completed' },
  { name: "a dispatched agent's hand-back", origin: { kind: 'peer' } as const, text: '<agent-message from="a1">tests pass, 3 files changed</agent-message>' },
]

for (const report of REPORTS) {
  test(`${report.name} that starts a turn gets the effort question, and the turn goes out at the decided effort`, { options: KEY }, async ($, on) => {
    const w = world($, on, { backend: jev([0.9, 0.1, 0, 0, 0]) })
    await w.submit(report.text, { origin: report.origin })
    await w.step({ index: 0, effort: 'xhigh' })

    expect(w.requests).toHaveLength(1)
    expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['effort.level'])
    expect(w.requests[0]?.body.state.user_message).toBe(report.text)
    expect(w.steps.map((s) => String(s.effort))).toEqual(['low'])
    expect((await w.board()).main).toMatchObject({ effort: 'low', routed: true })
    expect(w.logs.map((l) => l.text)).toContainEqual(expect.stringMatching(/^effort low for /))
    expect(await w.command('dp', 'log')).toMatch(/main-effort \(agent report\): effort low/)
  })
}

test('a report that starts a turn is asked no skill question, though a message of the person is', { options: KEY }, async ($, on) => {
  const skills = { commands: [{ name: 'tdd', description: 'Test-driven development.', source: 'user' as const }], listed: [{ name: 'tdd', source: 'userSettings', tokens: 52 }] }
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]), skills })
  await w.submit('先写一个失败的测试')
  await w.submit('Background task "lint" completed', { origin: { kind: 'task-notification' } })

  expect(Object.keys(w.requests[0]?.body.questions)).toContain('skills.which')
  expect(Object.keys(w.requests.at(-1)?.body.questions)).toEqual(['effort.level'])
})

test("the person's lock holds over a report's decision: the turn goes out at the locked effort", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([1, 0, 0, 0, 0]), session: true })
  await w.start()
  await w.command('dp', 'lock max')
  await w.submit('Background task "lint" completed', { origin: { kind: 'task-notification' } })
  await w.step({ index: 0, effort: 'xhigh' })

  expect(w.steps.map((s) => String(s.effort))).toEqual(['max'])
  expect((await w.board()).main).toMatchObject({ effort: 'max', locked: true })
})

test('a report delivered into a running turn starts no turn and is not decided; a failed decision for one that does leaves the engine effort and says why', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => (n === 1 ? jev([0, 0, 1, 0, 0])(request) : { status: 500, body: 'down' }) })
  await w.submit('把这个模块重构一下')
  await w.step({ index: 0 })
  await w.submit('<agent-message from="a1">done</agent-message>', { origin: { kind: 'peer' }, turnId: 't1' })
  expect(w.requests).toHaveLength(1)

  await w.submit('Background task "lint" completed', { origin: { kind: 'task-notification' } })
  await w.step({ index: 0, effort: 'medium' })
  expect(w.steps.map((s) => `${s.turnId}:${String(s.effort)}`)).toEqual(['t1:high', 't2:medium'])
  expect((await w.board()).main).toMatchObject({ turn: 2, effort: 'medium', routed: false, failure: { backend: 'jev', kind: 'http', status: 500 } })
})

test('a message the person sends from claude -p, the Remote Control bridge, Slack or as typed by a plugin for them is decided', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  await w.submit('one', { origin: { kind: 'sdk' } })
  await w.submit('two', { origin: { kind: 'bridge' } })
  await w.submit('three', { origin: { kind: 'slack-ping' } })
  await w.submit('four', { origin: { kind: 'plugin', name: 'voice-input', asUser: true } })

  expect(w.requests.map((r) => r.body.state.user_message)).toEqual(['one', 'two', 'three', 'four'])
})

test('a message typed during a turn is decided and sets the running turn from its next step', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => jev(n === 1 ? [1, 0, 0, 0, 0] : [0, 0, 0, 1, 0])(request) })
  await w.submit('先看看目录结构')
  await w.step({ index: 0 })
  // Typed while t1 runs: the engine delivers it into t1 at its next step.
  await w.submit('等等，顺便把那个并发问题彻底查清楚', { turnId: 't1' })
  await w.step({ index: 1 })
  await w.step({ index: 2 })

  expect(w.requests).toHaveLength(2)
  expect(w.steps.map((s) => s.effort)).toEqual(['low', 'xhigh', 'xhigh'])
  expect((await w.board()).main).toMatchObject({ turn: 1, effort: 'xhigh', routed: true })
})

test('a message typed during a turn that ends before it is delivered goes out with the turn it starts', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => jev(n === 1 ? [1, 0, 0, 0, 0] : [0, 0, 1, 0, 0])(request) })
  await w.submit('先跑一下测试')
  await w.step({ index: 0 })
  // Queued during t1 (asked to wait, ctrl+x enter), but t1 makes no further request:
  await w.submit('然后把失败的用例修好', { turnId: 't1', wait: true })
  // the queued message starts a turn of its own.
  const t2 = await w.startTurn('然后把失败的用例修好')
  await w.step({ index: 0, turnId: t2 })
  await w.step({ index: 1, turnId: t2 })

  expect(w.steps.map((s) => `${s.turnId}:${String(s.effort)}`)).toEqual(['t1:low', 't2:high', 't2:high'])
})

test("a message a hook beneath refuses leaves no decision behind for a later turn with the same text", { options: KEY }, async ($, on) => {
  let refuse = true
  const w = world($, on, {
    backend: (request, n) => (n === 1 ? jev([0, 0, 0, 0, 1])(request) : { status: 500, body: 'down' }),
    beneath: { drop: () => (refuse ? 'blocked by a UserPromptSubmit hook' : undefined) },
  })
  expect(await w.submit('部署到生产环境')).toEqual({ drop: 'blocked by a UserPromptSubmit hook' })
  refuse = false
  // Sent again, this time without a decision (the backend is down).
  await w.submit('部署到生产环境')
  await w.step({ index: 0, effort: 'medium' })

  expect(w.requests).toHaveLength(2)
  expect(w.steps.map((s) => s.effort)).toEqual(['medium'])
})

test('the decision reaches its turn even when a hook beneath rewrote the prompt text', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), beneath: { rewrite: (text) => `${text}\n\n(Answer in English.)` } })
  await w.submit('给这个函数加上缓存')
  await w.step({ index: 0 })

  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
})

// The transcript as $.session.messages() returns it: the assistant's output
// one row per block (tool calls, text), tool results as user rows without text.
const TRANSCRIPT: SessionMessage[] = [
  { role: 'user', text: '帮我看一下 src/auth/session.ts 里的过期逻辑', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: { file_path: 'src/auth/session.ts' }, text: 'export const TTL = 3600 // FILE BODY' }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text: 'export const TTL = 3600 // FILE BODY', isError: false, result: {} }] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u2', tool: 'Bash', input: { command: 'npm test' }, text: 'FAIL auth/session.test.ts', isError: true }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u2', text: 'FAIL auth/session.test.ts', isError: true, result: {} }] },
  { role: 'assistant', text: '过期时间写死成了 3600 秒，签名用的 key 是 sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx。\n要我改成读配置吗？', toolUses: [] },
]

test('the decision model reads the message and the recent conversation: text and tool names only, secrets masked', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]), messages: TRANSCRIPT })
  await w.submit('改吧，顺便把 token=abcd1234efgh5678 这个硬编码也去掉')

  expect(w.requests[0]?.body.state).toEqual({
    user_message: '改吧，顺便把 token=[REDACTED] 这个硬编码也去掉',
    recent_context: [
      'user: 帮我看一下 src/auth/session.ts 里的过期逻辑',
      'assistant: [tools: Read, Bash (failed)] 过期时间写死成了 3600 秒，签名用的 key 是 [REDACTED]。 要我改成读配置吗？',
    ].join('\n'),
  })
  const sent = JSON.stringify(w.requests[0]?.body)
  expect(sent).not.toContain('FILE BODY')
  expect(sent).not.toContain('FAIL auth/session.test.ts')
  expect(sent).not.toContain('npm test')
})

test('contextMessages sets how many recent messages go along, contextTokens how many tokens the state may take', { options: { ...KEY, contextMessages: 1, contextTokens: 100 } }, async ($, on) => {
  const messages: SessionMessage[] = [
    ...TRANSCRIPT,
    { role: 'user', text: '还有别的问题吗', toolUses: [] },
    { role: 'assistant', text: `${'我检查了会话模块的每一处过期判断，'.repeat(12)}要不要我一起改掉？`, toolUses: [] },
  ]
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]), messages })
  await w.submit('改吧')

  const state = w.requests[0]?.body.state
  const context: string = state.recent_context
  // One message, the newest, cut to fit the 100 tokens: its beginning and its end (the question).
  expect(context.startsWith('assistant: 我检查了会话模块')).toBe(true)
  expect(context.endsWith('要不要我一起改掉？')).toBe(true)
  expect(context).toContain(' … ')
  expect(context).not.toContain('user:')
  expect(estimateTokens(state.user_message) + estimateTokens(context)).toBeLessThanOrEqual(100)
})

test('what the mod sends is exactly what the decision module builds, so the eval measures the live request (spec #67)', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]), messages: TRANSCRIPT })
  await w.submit('改吧，顺便把 token=abcd1234efgh5678 这个硬编码也去掉')

  // Jev is asked about the effort in Chinese (core/setup.ts BACKEND_DEFAULTS turnStartLanguage).
  const built = mergeParts(turnStartState({ prompt: '改吧，顺便把 token=abcd1234efgh5678 这个硬编码也去掉', messages: TRANSCRIPT, limits: { messages: 4, tokens: 2000 } }), [turnStartEffortPart({ language: 'zh' })])
  expect(w.requests[0]?.body).toEqual({ model: JEV_MODEL, ...built })
})

test("the turn's record keeps its message masked and cut to the context budget, as later decisions read it", { options: { ...KEY, contextTokens: 100 } }, async ($, on) => {
  const writes: { key: string; id: string | undefined; value: unknown }[] = []
  on('state.set', async (_$, e, next) => {
    const write = e as { key: string; id?: string; value: unknown }
    writes.push({ key: write.key, id: write.id, value: write.value })
    return next(e)
  })
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]) })
  await w.submit(`把 token=abcd1234efgh5678 换成读环境变量。${'顺便检查一下其他地方有没有类似的硬编码。'.repeat(20)}`)

  const record = writes.find((write) => write.key === 'turns' && write.id === 'main:t1')?.value as { prompt: string } | undefined
  expect(record?.prompt.startsWith('把 token=[REDACTED] 换成读环境变量。')).toBe(true)
  expect(record?.prompt).not.toContain('abcd1234efgh5678')
  expect(estimateTokens(record?.prompt ?? '')).toBeLessThanOrEqual(100)
  // The decision model was shown the same message, masked the same, a little shorter: the budget holds for its whole state as sent.
  const shown = String(w.requests[0]?.body.state.user_message)
  expect(shown.startsWith('把 token=[REDACTED] 换成读环境变量。')).toBe(true)
  expect(estimateTokens(JSON.stringify(w.requests[0]?.body.state))).toBeLessThanOrEqual(100)
})

test('contextMessages 0: only the message itself goes', { options: { ...KEY, contextMessages: 0 } }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]), messages: TRANSCRIPT })
  await w.submit('改吧')
  expect(w.requests[0]?.body.state).toEqual({ user_message: '改吧', recent_context: '' })
})

test('each request and decision is written to the debug log, never into the conversation', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => (n === 1 ? jev([0.05, 0.1, 0.6, 0.2, 0.05])(request) : { status: 500, body: 'boom' }) })
  await w.submit('把登录模块重构成三层')
  await w.submit('再看看别的')

  expect(w.logs.map((l) => l.to)).toEqual(['debug', 'debug', 'debug'])
  expect(w.logs.map((l) => l.text)).toEqual([
    'request [effort.level] to jev: answered in 0 ms by jev-1.13.0 (300 input tokens)',
    'effort high for "把登录模块重构成三层": p low 0.05, medium 0.10, high 0.60, xhigh 0.20, max 0.05; confidence 0.70',
    'request [effort.level] to jev: http: HTTP 500: boom (0 ms)',
  ])
})

test('max is used only when its own probability reaches thetaMax', { options: { ...KEY, thetaMax: 0.6 } }, async ($, on) => {
  // Most likely max, but at 0.5, below thetaMax: the most likely of the rest.
  const w = world($, on, { backend: (request, n) => jev(n === 1 ? [0, 0.1, 0.15, 0.25, 0.5] : [0, 0, 0.1, 0.25, 0.65])(request) })
  await w.submit('设计一个跨区域的数据迁移方案，保证零停机')
  await w.step({ index: 0 })
  await w.submit('这个迁移方案里的回滚路径再推敲一遍，任何数据丢失都不可接受')
  await w.step({ index: 0 })

  expect(w.steps.map((s) => s.effort)).toEqual(['xhigh', 'max'])
})
