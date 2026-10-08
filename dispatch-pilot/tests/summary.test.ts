// The problem summary (#40): seam 1 (engine events in; what reaches the cheap model, `$.state`, the decision
// backend and the decision log out). After each turn that the person's own message started, a cheap model
// continues the record of the problem in the background (`$.model.complete` is stubbed in `world`); the
// decision never waits for it; the decision model reads it from the next message on.

import type { ModelCompleteRequest, SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { estimateTokens } from '../hooks/decision/context.ts'
import { renderSummary, SUMMARY_TOKENS } from '../hooks/decision/summary.ts'
import { asClef, CLEF_OPTIONS, clefInputProblems } from './support/cloudflare.ts'
import { jev, rates, world, type Completion } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }
/** The switch is off until the person turns it on (#48): these tests are about what it does when on. */
const UNRESOLVED_ON = { unresolved: true }
const MEDIUM = [0.05, 0.7, 0.2, 0.05, 0]

/** What the cheap model answers: the summary as the system prompt asks for it. */
const written = (problem: string, tried: string[], status = '助手在等日志'): Completion => ({ text: JSON.stringify({ problem, tried, status }) })

/** The prompt of a completion as text. */
const promptOf = (request: ModelCompleteRequest | undefined): string => (typeof request?.prompt === 'string' ? request.prompt : (request?.prompt ?? []).map((block) => block.text).join(''))

/** A transcript row: what was said and the tools the assistant called. */
const row = (role: 'user' | 'assistant', text: string, ...tools: string[]): SessionMessage => ({
  role,
  text,
  toolUses: tools.map((tool, i) => ({ tool_use_id: `toolu_${i}`, tool, input: {} })),
})

test('when a turn the person\'s own message started ends, a cheap model continues the summary in the background: the hook does not wait for it', { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON,
    backend: jev(MEDIUM),
    model: () => ({ after: 2500, reply: written('登录接口返回 502', ['把超时调到 30 秒']) }),
    messages: [row('user', '登录接口返回 502'), row('assistant', '我看一下', 'Read', 'Edit'), row('user', ''), row('assistant', '我把超时调到了 30 秒，请再试一次', 'Bash')],
  })
  await w.submit('登录接口返回 502')
  await w.step({ index: 0 })
  await w.complete({ answer: '我把超时调到了 30 秒，请再试一次' })
  await w.clock.settle()

  // Asked at once, of the cheap model: the person's words, the assistant's reply and the tools of the turn.
  expect(w.completions).toHaveLength(1)
  expect(w.completions[0]?.model).toBe('haiku')
  expect(promptOf(w.completions[0])).toContain('登录接口返回 502')
  expect(promptOf(w.completions[0])).toContain('我把超时调到了 30 秒，请再试一次')
  expect(promptOf(w.completions[0])).toContain('Read, Edit, Bash')
  // Nothing waited for it: the turn ended, the answer is not in yet.
  expect(w.clock.now()).toBe(0)
  expect(w.summary()).toBeUndefined()

  await w.clock.advance(2500)
  expect(w.summary()).toEqual({ problem: '登录接口返回 502', tried: [{ text: '把超时调到 30 秒' }], status: '助手在等日志', turn: 't1' })
})

test('only a turn the person\'s own message started is written: a command turn counts; a hand-back, a task notice and a dispatched agent\'s turn do not', { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON,
    backend: jev(MEDIUM),
    model: () => written('p', ['a']),
    session: true,
    skills: { commands: [{ name: 'implement', description: 'Implement an issue.', source: 'user' }], listed: [] },
  })
  await w.start()
  // A dispatched agent's report starts a turn of the main agent, and so does a background task's notice: neither is a word of the person's.
  await w.submit('<agent-message from="a1">tests pass, 3 files changed</agent-message>', { origin: { kind: 'peer' } })
  await w.complete()
  await w.submit('Background task "lint" completed', { origin: { kind: 'task-notification' } })
  await w.complete()
  // A dispatched agent's own turn ends too.
  await w.complete({ agentId: 'a1' })
  await w.clock.settle()
  expect(w.completions).toHaveLength(0)

  await w.slash('implement', '#19')
  await w.complete({ answer: '实现完了' })
  await w.clock.settle()
  expect(w.completions).toHaveLength(1)
  expect(promptOf(w.completions[0])).toContain('/implement #19')
  expect(w.summary()?.turn).toBe('t3')
})

/** What the decision model answers the unresolved question: by the bars it neither adds nor clears (the summary is left as it is), or it reads "still unresolved", or that the problem is solved, or another one. */
const SAYS = {
  unsure: { still_unresolved: 0.3, resolved: 0.4, new_or_unrelated: 0.3 },
  still: { still_unresolved: 0.8, resolved: 0.05, new_or_unrelated: 0.15 },
  solved: { still_unresolved: 0.05, resolved: 0.85, new_or_unrelated: 0.1 },
  elsewhere: { still_unresolved: 0.05, resolved: 0.1, new_or_unrelated: 0.85 },
} as const
type Says = keyof typeof SAYS

/** Jev answering the effort question as MEDIUM and the unresolved question as `said.now` says (changeable between messages). */
const deciding = (said: { now: Says }) => (request: Parameters<ReturnType<typeof jev>>[0]) => jev(MEDIUM, { shares: { 'effort.unresolved': SAYS[said.now] } })(request)

/** The summary field of a request's state. */
const summaryOf = (request: { body?: { state?: Record<string, unknown> } } | undefined) => request?.body?.state?.problem_summary

test('the summary is in the state of the effort request from the next message on, and in no other request; a message that comes before a write is done is decided with the summary as it was', { options: KEY }, async ($, on) => {
  const said = { now: 'unsure' as Says }
  const w = world($, on, { switches: UNRESOLVED_ON,
    backend: deciding(said),
    model: (_, n) => (n === 1 ? written('登录接口返回 502', ['把超时调到 30 秒']) : { after: 4000, reply: written('登录接口返回 502', ['把超时调到 30 秒', '换成 fake timers']) }),
  })
  await w.submit('登录接口返回 502')
  expect(summaryOf(w.requests[0])).toBeUndefined()
  await w.complete()
  await w.clock.settle()

  await w.submit('嗯，再看看')
  const first = '问题：登录接口返回 502\n试过：\n1. 把超时调到 30 秒\n状态：助手在等日志'
  expect(summaryOf(w.requests[1])).toBe(first)
  // The second turn's write takes 4 seconds: the next message does not wait, it reads the summary there is.
  await w.complete()
  await w.clock.settle()
  const sentAt = w.clock.now()
  await w.submit('还是没好')
  expect(w.clock.now()).toBe(sentAt)
  expect(summaryOf(w.requests[2])).toBe(first)

  await w.clock.advance(4000)
  await w.submit('再来一次')
  expect(summaryOf(w.requests[3])).toBe('问题：登录接口返回 502\n试过：\n1. 把超时调到 30 秒\n2. 换成 fake timers\n状态：助手在等日志')
  // Beside the effort question's request there is none to carry it here, and the summary's field is the effort request's alone.
  expect(w.requests.every((request) => Object.keys(request.body.questions).every((id) => id.startsWith('effort.')))).toBe(true)
})

test('a write that fails leaves the summary as it was and puts an entry in the decision log: an API error, a reply without words, a call cut short, a reply that is no summary', { options: KEY }, async ($, on) => {
  const said = { now: 'unsure' as Says }
  let next: Completion = written('登录接口返回 502', ['把超时调到 30 秒'])
  const w = world($, on, { switches: UNRESOLVED_ON, backend: deciding(said), model: () => next })
  const turn = async (text: string) => {
    await w.submit(text)
    await w.complete()
    await w.clock.settle()
  }
  await turn('登录接口返回 502')
  const kept = w.summary()
  expect(kept?.tried).toEqual([{ text: '把超时调到 30 秒' }])
  const failures = () => w.board().then((board) => board.log.filter((entry) => entry.feature === 'unresolved' && entry.outcome === '摘要没写成'))
  expect(await failures()).toEqual([])

  const cases: [Completion, RegExp][] = [
    [{ fails: 'api-error' }, /出错（状态码 529，overloaded）/],
    [{ fails: 'empty-reply' }, /没有给出文字/],
    [{ fails: 'aborted' }, /超过 30 秒，或被中断/],
    [{ text: 'Sorry, I cannot tell what the problem is.' }, /不是摘要的结构：「Sorry, I cannot tell what the problem is.」/],
    // Cut short by the reply's cap: the JSON stops where the model did.
    [{ text: '{"problem": "登录接口返回 502", "tried": ["把超时调到 30 秒", "换成 fake ti' }, /不是摘要的结构/],
  ]
  for (const [i, [reply, why]] of cases.entries()) {
    next = reply
    await turn(`第 ${i + 2} 条`)
    // The summary is the one there was; the log says why, in the person's words, once.
    expect(w.summary()).toEqual(kept)
    const entries = await failures()
    expect(entries).toHaveLength(i + 1)
    expect(entries.at(-1)).toMatchObject({ agent: 'main', tone: 'warn', subject: `"第 ${i + 2} 条"` })
    expect(entries.at(-1)?.reason).toMatch(why)
    expect(entries.at(-1)?.reason).toMatch(/问题摘要保持原样/)
  }
  // The writes go on after it: the next that is answered replaces the summary.
  next = written('登录接口返回 502', ['把超时调到 30 秒', '换成 fake timers'])
  await turn('最后一条')
  expect(w.summary()?.tried).toHaveLength(2)
})

/** One turn: the person says `text`, the turn ends, the write (if any) is done. */
async function turn(w: ReturnType<typeof world>, text: string, answer = 'done') {
  await w.submit(text)
  await w.complete({ answer })
  await w.clock.settle()
}

test('what the cheap model is shown has its secrets masked first, and what it writes back is cut to 500 tokens in the fixed structure', { options: KEY }, async ($, on) => {
  const tries = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 次：${'把配置里的某一项改成另一个值再重启服务，'.repeat(3)}`)
  const w = world($, on, { switches: UNRESOLVED_ON, backend: jev(MEDIUM), model: () => written('服务启动后立刻退出', tries, '助手在等日志') })
  await turn(w, '服务起不来，我的 token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', '我查了 DB_PASSWORD=hunter2hunter2 的配置，没发现问题')

  const shown = promptOf(w.completions[0])
  expect(shown).not.toContain('sk-ant-api03')
  expect(shown).not.toContain('hunter2hunter2')
  expect(shown).toContain('[REDACTED]')
  const kept = w.summary()
  expect(kept).toBeDefined()
  expect(Object.keys(kept ?? {}).sort()).toEqual(['problem', 'status', 'tried', 'turn'])
  expect(estimateTokens(renderSummary({ problem: kept?.problem ?? '', tried: kept?.tried ?? [], status: kept?.status ?? '' }, 'zh'))).toBeLessThanOrEqual(SUMMARY_TOKENS)
  expect(kept?.tried.at(-1)?.text).toBe(tries.at(-1))
})

test('Clef reads the summary in English and within its budget: the whole state, summary included, stays within 2000 tokens', { options: CLEF_OPTIONS }, async ($, on) => {
  const kept = { problem: '登录接口返回 502', tried: Array.from({ length: 6 }, (_, i) => ({ text: `第 ${i + 1} 次：${'把配置里的某一项改成另一个值再重启服务，'.repeat(3)}` })), status: '助手在等日志', turn: 't1' }
  // Clef reads the last 4 messages, which alone would take more than its 2000 tokens.
  const messages = Array.from({ length: 40 }, (_, i) => row(i % 2 === 0 ? 'user' : 'assistant', `第 ${i} 轮：${'把配置里的某一项改成另一个值再重启服务。'.repeat(40)}`))
  const w = world($, on, { switches: UNRESOLVED_ON, backend: asClef(jev(MEDIUM)), seed: { unresolved: { count: 1, summary: kept } }, messages })
  await w.submit('还是不行')

  const sent = w.requests[0]?.body
  expect(clefInputProblems(sent)).toEqual([])
  expect(sent.state.problem_summary).toBe(renderSummary(kept, 'en'))
  expect(sent.state.problem_summary).toContain('Problem: 登录接口返回 502')
  expect(sent.state.user_message).toBe('还是不行')
  expect(estimateTokens(JSON.stringify(sent.state))).toBeLessThanOrEqual(2000)
})

test('the skills\' request does not carry the summary: it is a field of the effort request alone', { options: KEY }, async ($, on) => {
  const kept = { problem: '登录接口返回 502', tried: [{ text: '把超时调到 30 秒' }], status: '助手在等日志', turn: 't1' }
  const w = world($, on, { switches: UNRESOLVED_ON,
    backend: rates({ '(none)': 1 }),
    skills: { commands: [{ name: 'tdd', description: 'Test-driven development.', source: 'user' }], listed: [{ name: 'tdd', source: 'userSettings', tokens: 52 }] },
    session: true,
    seed: { unresolved: { count: 1, summary: kept } },
  })
  await w.start()
  await w.submit('先写一个失败的测试')

  const effort = w.requests.find((request) => 'effort.level' in request.body.questions)
  expect(effort?.body.state.problem_summary).toBe(renderSummary(kept, 'zh'))
  expect(w.withoutEffort.length).toBeGreaterThan(0)
  expect(w.withoutEffort.every((request) => !('problem_summary' in request.body.state))).toBe(true)
})

test('"still unresolved" marks the last attempt of the summary (the unresolved count goes up with it), and the next write continues the summary with the mark', { options: KEY }, async ($, on) => {
  const said = { now: 'unsure' as Says }
  const w = world($, on, { switches: UNRESOLVED_ON,
    backend: deciding(said),
    model: (_, n) => (n === 1 ? written('登录接口返回 502', ['把超时调到 30 秒']) : written('登录接口返回 502', ['把超时调到 30 秒 [unresolved]', '换成 fake timers'])),
  })
  await turn(w, '登录接口返回 502')
  expect(w.summary()?.tried).toEqual([{ text: '把超时调到 30 秒' }])

  said.now = 'still'
  await w.submit('还是 502')
  expect(w.unresolved()).toBe(1)
  expect(w.summary()?.tried).toEqual([{ text: '把超时调到 30 秒', unresolved: true }])
  // What the decision model reads next says so, and so does what the cheap model continues.
  await w.complete()
  await w.clock.settle()
  expect(promptOf(w.completions[1])).toContain('"tried":["把超时调到 30 秒 [unresolved]"]')
  expect(w.summary()?.tried).toEqual([{ text: '把超时调到 30 秒', unresolved: true }, { text: '换成 fake timers' }])
  said.now = 'unsure'
  await w.submit('嗯')
  expect(summaryOf(w.requests.at(-1))).toContain('1. 把超时调到 30 秒（未解决）\n2. 换成 fake timers')
})

for (const [label, now] of [['the problem is solved', 'solved'], ['another problem begins', 'elsewhere']] as const) {
  test(`when ${label} the summary is cleared with the count, and the next one is written from scratch`, { options: KEY }, async ($, on) => {
    const said = { now: 'still' as Says }
    const w = world($, on, { switches: UNRESOLVED_ON, backend: deciding(said), model: () => written('登录接口返回 502', ['把超时调到 30 秒']) })
    await turn(w, '登录接口返回 502')
    await turn(w, '还是 502')
    expect(w.unresolved()).toBe(2)
    expect(w.summary()).toBeDefined()

    said.now = now
    await w.submit(now === 'solved' ? '好了，谢谢' : '换个话题：给 README 加个徽章')
    expect(w.unresolved()).toBe(0)
    expect(w.summary()).toBeUndefined()
    // The message itself was asked about before its answer cleared anything, so it read the summary there was; the cheap model is shown none.
    expect(summaryOf(w.requests.at(-1))).toContain('登录接口返回 502')
    await w.complete()
    await w.clock.settle()
    expect(promptOf(w.completions.at(-1))).toMatch(/none yet/i)
    expect(w.summary()?.turn).toBe('t3')
  })
}

test('/clear and a new session start the summary over; /compact keeps it', { options: KEY }, async ($, on) => {
  const said = { now: 'unsure' as Says }
  const w = world($, on, { switches: UNRESOLVED_ON, backend: deciding(said), model: () => written('登录接口返回 502', ['把超时调到 30 秒']), session: true })
  await w.start()
  await turn(w, '登录接口返回 502')

  await w.compact()
  expect(w.summary()?.problem).toBe('登录接口返回 502')
  await w.clear()
  expect(w.summary()).toBeUndefined()
  expect(w.unresolvedState()).toEqual({ count: 0 })
})

test('a message that says "still unresolved" before the last turn\'s write is done: the attempt it is about is marked when that write lands', { options: KEY }, async ($, on) => {
  const said = { now: 'unsure' as Says }
  const w = world($, on, { switches: UNRESOLVED_ON,
    backend: deciding(said),
    model: (_, n) => (n === 1 ? written('登录接口返回 502', ['把超时调到 30 秒']) : { after: 4000, reply: written('登录接口返回 502', ['把超时调到 30 秒', '换成 fake timers']) }),
  })
  await turn(w, '登录接口返回 502')
  await turn(w, '嗯，再看看')
  // The second write is still going on when the person answers.
  said.now = 'still'
  await w.submit('还是没好')
  expect(w.unresolved()).toBe(1)
  expect(w.summary()?.tried).toEqual([{ text: '把超时调到 30 秒' }])

  await w.clock.advance(4000)
  // It is the last turn's attempt that the message was about.
  expect(w.summary()?.tried).toEqual([{ text: '把超时调到 30 秒' }, { text: '换成 fake timers', unresolved: true }])
  expect(w.unresolvedState().owed).toBeUndefined()
  expect(w.unresolvedState().writing).toBeUndefined()
})

test('the problem is cleared before a write is done: the write is dropped when it lands, with no entry in the log', { options: KEY }, async ($, on) => {
  const said = { now: 'unsure' as Says }
  const w = world($, on, { switches: UNRESOLVED_ON, backend: deciding(said), model: (_, n) => (n === 1 ? written('登录接口返回 502', ['把超时调到 30 秒']) : { after: 4000, reply: written('登录接口返回 502', ['把超时调到 30 秒', '换成 fake timers']) }) })
  await turn(w, '登录接口返回 502')
  await turn(w, '嗯，再看看')
  said.now = 'solved'
  await w.submit('好了，谢谢')
  expect(w.summary()).toBeUndefined()

  await w.clock.advance(4000)
  expect(w.summary()).toBeUndefined()
  expect(w.unresolvedState()).toEqual({ count: 0 })
  expect((await w.board()).log.filter((entry) => entry.outcome === '摘要没写成')).toEqual([])
})

test('a reload of the mod loses a write in flight: the summary stays as it was and the log says so', { options: KEY }, async ($, on) => {
  const kept = { problem: '登录接口返回 502', tried: [{ text: '把超时调到 30 秒' }], status: '助手在等日志', turn: 't1' }
  const w = world($, on, { switches: UNRESOLVED_ON, backend: jev(MEDIUM), session: true, seed: { unresolved: { count: 1, summary: kept, writing: ['t2'], owed: 't2' } } })
  await w.start()

  expect(w.unresolvedState()).toEqual({ count: 1, summary: kept })
  const entries = (await w.board()).log.filter((entry) => entry.feature === 'unresolved')
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({ outcome: '摘要没写成', tone: 'warn' })
  expect(entries[0]?.reason).toContain('热重载')
  // Starting the session again finds nothing more to tell.
  await w.start()
  expect((await w.board()).log.filter((entry) => entry.feature === 'unresolved')).toHaveLength(1)
})

test('writes go one after the other: a turn that ends before the last write is done waits for it, and continues what it wrote', { options: KEY }, async ($, on) => {
  const said = { now: 'unsure' as Says }
  const w = world($, on, { switches: UNRESOLVED_ON,
    backend: deciding(said),
    model: (_, n) => (n === 1 ? { after: 3000, reply: written('登录接口返回 502', ['把超时调到 30 秒']) } : written('登录接口返回 502', ['把超时调到 30 秒', '换成 fake timers'])),
  })
  await turn(w, '登录接口返回 502')
  await turn(w, '嗯，再看看')
  expect(w.completions).toHaveLength(1)

  await w.clock.advance(3000)
  expect(w.completions).toHaveLength(2)
  expect(promptOf(w.completions[1])).toContain('"tried":["把超时调到 30 秒"]')
  expect(w.summary()).toMatchObject({ tried: [{ text: '把超时调到 30 秒' }, { text: '换成 fake timers' }], turn: 't2' })
})

test('a reply that is no summary is quoted in the log with its secrets masked', { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: jev(MEDIUM), model: () => ({ text: 'I cannot summarize this: DB_PASSWORD=hunter2hunter2' }) })
  await turn(w, '登录接口返回 502')
  const [entry] = (await w.board()).log.filter((one) => one.outcome === '摘要没写成')
  expect(entry?.reason).toContain('DB_PASSWORD=[REDACTED]')
  expect(entry?.reason).not.toContain('hunter2hunter2')
})

test('an engine that refuses the model is told once, and not asked again this session', { options: KEY }, async ($, on) => {
  const said = { now: 'unsure' as Says }
  const w = world($, on, { switches: UNRESOLVED_ON, backend: deciding(said), model: () => ({ reject: 'model haiku is not allowed' }), session: true })
  await w.start()
  for (const text of ['第一条', '第二条', '第三条']) {
    await w.submit(text)
    await w.complete()
    await w.clock.settle()
  }

  expect(w.completions).toHaveLength(1)
  const entries = (await w.board()).log.filter((entry) => entry.feature === 'unresolved')
  expect(entries).toHaveLength(1)
  expect(entries[0]?.reason).toContain('引擎拒绝了写摘要的模型 haiku')
  expect(entries[0]?.reason).toContain('model haiku is not allowed')
  // A new conversation tries again.
  await w.clear()
  await w.submit('新的一条')
  await w.complete()
  await w.clock.settle()
  expect(w.completions).toHaveLength(2)
})

test('summaryModel names the model that writes it (haiku is the default, in the first test)', { options: { ...KEY, summaryModel: 'claude-sonnet-5-5' } }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: jev(MEDIUM), model: () => written('p', ['a']) })
  await w.submit('登录接口返回 502')
  await w.complete()
  await w.clock.settle()
  expect(w.completions.map((request) => request.model)).toEqual(['claude-sonnet-5-5'])
})

for (const { label, options, off } of [
  { label: '/dp unresolved is off', options: KEY, off: true },
  { label: 'there is no decision model to read it (no key)', options: {} },
  { label: 'the person sends the decision model no conversation (contextMessages 0)', options: { ...KEY, contextMessages: 0 } },
]) {
  test(`no summary is written when ${label}`, { options }, async ($, on) => {
    const w = world($, on, { switches: UNRESOLVED_ON, backend: jev(MEDIUM), model: () => written('p', ['a']), session: true, store: {} })
    await w.start()
    if (off) await w.command('dp', 'unresolved off')
    await w.submit('登录接口返回 502')
    await w.complete({ answer: '改好了' })
    await w.clock.settle()

    expect(w.completions).toEqual([])
    expect(w.summary()).toBeUndefined()
    expect(w.unresolvedState().writing).toBeUndefined()
  })
}
