import { expect, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'

import { DREX_URL } from '../hooks/backend.ts'
import { START } from '../hooks/decide.ts'
import type { Decision } from '../hooks/log.ts'
import type { SessionState, TurnState } from '../hooks/state.ts'
import { estimateTokens } from '../hooks/statebuild.ts'
import { KEYS, NO_BACKEND, complete, dp, drexOk, noul, score, start, step, submit, turnStart, turns, world } from './support/world.ts'

type World = ReturnType<typeof world>

// What the mod recorded: $.store's log (the machine's) and the state key recent (this session's).
const logged = (w: World): Decision[] => (w.storeWrites.filter((s) => s.key === 'log').at(-1)?.value ?? []) as Decision[]
const recent = (w: World): Decision[] => (w.stateWrites.filter((s) => s.key === 'recent' && s.isSet).at(-1)?.value ?? []) as Decision[]
const session = (w: World): SessionState => w.stateWrites.filter((s) => s.key === 'session' && s.isSet).at(-1)?.value as SessionState
const efforts = (w: World): unknown[] => w.stepsSent.map((s) => s.effort)
const turnState = (w: World): TurnState => w.stateWrites.filter((s) => s.key === 'turn' && s.isSet).at(-1)?.value as TurnState

// Answers whose level, read from medium, is high: the open question moves one level up and no further.
const RAISE = { open: score([0.02, 0.08, 0.25, 0.55, 0.1]), mechanical: noul(0.1), unknown_cause: noul(0.2) }
// From medium to xhigh: 0.95 above medium, 0.85 above high (the stricter bar 0.8 for xhigh), 0.05 above xhigh.
const TO_XHIGH = { open: score([0, 0.05, 0.1, 0.8, 0.05]), mechanical: noul(0.1), unknown_cause: noul(0.2) }
// Holds from medium and from xhigh alike: 0.65 on each side of either, below every bar.
const HOLD = { open: score([0.05, 0.3, 0.3, 0.3, 0.05]), mechanical: noul(0.1), unknown_cause: noul(0.2) }

// Answers every question asked: these, and continues as given once the message has a previous turn.
const answering =
  (a: Record<string, unknown>, continues = 0.1) =>
  ({ body }: { body: any }) =>
    drexOk('continues' in body.questions ? { ...a, continues: noul(continues) } : a)

const TASK = 'Fix the flaky retry in the uploader'
const OPUS = 'claude-opus-5-5'

// The brief's nine.

test('人发的消息：发一个请求，之后每一步都是决定的档，模型不变', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: () => drexOk(RAISE) })
  await start($)
  await submit($, TASK)
  for (const index of [0, 1, 2]) await step($, { turnId: 't1', index, effort: 'medium' })

  expect(w.fetched).toHaveLength(1)
  expect(w.fetched[0]!.url).toBe(DREX_URL)
  // The first message of a session has no previous turn, so no continues question either.
  expect(Object.keys(w.fetched[0]!.body.questions)).toEqual(['open', 'mechanical', 'unknown_cause'])
  expect(w.fetched[0]!.body.state.request).toBe(TASK)
  expect(w.fetched[0]!.body.state.previous_turn).toBeUndefined()
  // The prompt went in as it was typed.
  expect(w.submitted.map((s) => s.text)).toEqual([TASK])

  expect(efforts(w)).toEqual(['high', 'high', 'high'])
  expect(w.stepsSent.map((s) => s.model)).toEqual([OPUS, OPUS, OPUS])

  const d = logged(w)
  expect(d).toHaveLength(1)
  expect(d[0]).toMatchObject({
    kind: 'submit',
    backend: 'drex',
    model: 'drex-max-v1.1',
    from: 'medium',
    to: 'high',
    reason: 'more-open',
    detail: '',
    turnId: 't1',
    step: 0,
    bars: START,
    failure: null,
    applied: true,
    sent: null,
  })
  expect(d[0]!.raw).toEqual({
    open: { type: 'score', score: RAISE.open.score, probabilities: [0.02, 0.08, 0.25, 0.55, 0.1] },
    mechanical: { type: 'noul', noul: 0.1 },
    unknown_cause: { type: 'noul', noul: 0.2 },
  })
  expect(recent(w)).toEqual(d)
})

test('task-notification、peer 开始的轮不判断', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: () => drexOk(RAISE) })
  await start($)
  await submit($, 'Background task finished', { kind: 'task-notification' })
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  await complete($, 't1')
  await submit($, 'Another session says hello', { kind: 'peer' })
  await step($, { turnId: 't2', index: 0, effort: 'low' })

  expect(w.fetched).toHaveLength(0)
  expect(w.submitted.map((s) => s.origin.kind)).toEqual(['task-notification', 'peer'])
  expect(efforts(w)).toEqual(['medium', 'low'])
  expect(logged(w)).toHaveLength(0)
})

// No backend can be asked: nothing is asked and nothing recorded, as with submitShift off (ruling R37).
for (const [name, options] of NO_BACKEND) {
  test(`没有可用的后端（${name}）：不发请求、不记录，第 0 步从引擎的档位起`, { options }, async ($, on) => {
    const w = world(on, { onSubmit: turns($), answer: () => drexOk(RAISE) })
    await start($)
    await submit($, TASK)
    await step($, { turnId: 't1', index: 0, effort: 'medium' })
    await step($, { turnId: 't1', index: 1, effort: 'medium' })

    expect(w.submitted.map((s) => s.text)).toEqual([TASK])
    expect(efforts(w)).toEqual(['medium', 'medium'])
    expect(w.fetched).toHaveLength(0)
    // No pending result was ever written; the turn starts from the engine's level and nothing was decided for it.
    expect(w.stateWrites.filter((s) => s.key === 'session' && (s.value as SessionState).pending !== null)).toHaveLength(0)
    expect(turnState(w)).toMatchObject({ turnId: 't1', base: 'medium', wanted: null, pendingMark: null })
    expect(w.storeWrites.filter((s) => s.key === 'log')).toHaveLength(0)
    expect(w.stateWrites.filter((s) => s.key === 'recent')).toHaveLength(0)
  })
}

test('回答缺题：effort 不变，记录里 failure 是 bad-answer（Review Focus 2）', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: () => drexOk({ open: RAISE.open, mechanical: RAISE.mechanical }) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  await step($, { turnId: 't1', index: 1, effort: 'medium' })

  expect(w.fetched).toHaveLength(1)
  expect(efforts(w)).toEqual(['medium', 'medium'])
  const d = logged(w)
  expect(d).toHaveLength(1)
  expect(d[0]).toMatchObject({ failure: 'bad-answer', backend: 'drex', from: 'medium', to: 'medium', reason: null, raw: null, applied: false, requestId: 'req_test', turnId: 't1', step: 0 })
  expect(d[0]!.detail).not.toBe('')
})

test('e.effort 缺省或是数字：原样放行（Review Focus 3）', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answering(RAISE) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0 })
  await step($, { turnId: 't1', index: 1, effort: 31999 })
  await complete($, 't1')
  await submit($, 'Now the downloader')
  await step($, { turnId: 't2', index: 0, effort: 31999 })
  await step($, { turnId: 't2', index: 1 })

  expect(w.fetched).toHaveLength(2)
  expect(efforts(w)).toEqual([undefined, 31999, 31999, undefined])
  // Each judgement is still recorded, as one that changed nothing.
  const d = logged(w)
  expect(d.map((x) => [x.turnId, x.from, x.to, x.applied, x.failure])).toEqual([
    ['t1', null, null, false, null],
    ['t2', null, null, false, null],
  ])
  expect(d[0]!.raw).toMatchObject({ mechanical: { type: 'noul', noul: 0.1 } })
  expect(d[0]!.detail).not.toBe('')
})

test('到时限放行', { options: KEYS }, async ($, on) => {
  const late: { clock: MockClock | null } = { clock: null }
  const w = world(on, {
    onSubmit: turns($),
    answer: async () => {
      await late.clock!.sleep(60_000)
      return drexOk(RAISE)
    },
  })
  late.clock = w.clock
  await start($)
  const sent = submit($, TASK)
  await w.clock.settle()
  await w.clock.advance(4000)
  await sent
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  await step($, { turnId: 't1', index: 1, effort: 'medium' })

  expect(w.fetched).toHaveLength(1)
  expect(w.submitted.map((s) => s.text)).toEqual([TASK])
  expect(efforts(w)).toEqual(['medium', 'medium'])
  const d = logged(w)
  expect(d).toHaveLength(1)
  expect(d[0]).toMatchObject({ failure: 'timeout', backend: 'drex', ms: 4000, from: 'medium', to: 'medium', reason: null, raw: null, applied: false, turnId: 't1' })
  expect(d[0]!.detail).not.toBe('')
})

test('shadow：发请求、记一条，但 effort 不变', { options: { ...KEYS, mode: 'shadow' } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: () => drexOk(RAISE) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  await step($, { turnId: 't1', index: 1, effort: 'medium' })

  expect(w.fetched).toHaveLength(1)
  expect(efforts(w)).toEqual(['medium', 'medium'])
  expect(logged(w)).toHaveLength(1)
  expect(logged(w)[0]).toMatchObject({ from: 'medium', to: 'high', reason: 'more-open', applied: false, failure: null })
})

test('续做：上一轮定在 xhigh，这一条 continues 为是，从 xhigh 起算', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: ({ body }) => drexOk('continues' in body.questions ? { ...HOLD, continues: noul(0.9) } : TO_XHIGH) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  await complete($, 't1', { answer: 'I found the race in the retry loop. Shall I apply the fix?' })
  await submit($, 'yes, go on')
  await step($, { turnId: 't2', index: 0, effort: 'medium' })
  await step($, { turnId: 't2', index: 1, effort: 'medium' })

  expect(w.fetched).toHaveLength(2)
  const second = w.fetched[1]!.body
  expect(Object.keys(second.questions)).toEqual(['open', 'mechanical', 'unknown_cause', 'continues'])
  expect(second.state.request).toBe('yes, go on')
  expect(second.state.previous_turn).toEqual({
    request: TASK,
    last_reply: 'I found the race in the retry loop. Shall I apply the fix?',
    ended: 'answered',
    level: 'xhigh',
  })
  expect(efforts(w)).toEqual(['xhigh', 'xhigh', 'xhigh'])
  expect(logged(w).map((d) => [d.turnId, d.from, d.to, d.reason])).toEqual([
    ['t1', 'medium', 'xhigh', 'more-open'],
    ['t2', 'xhigh', 'xhigh', 'hold'],
  ])
})

test('一轮被打断后，下一轮不带着上一轮的档位', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: ({ body }) => drexOk('continues' in body.questions ? { ...HOLD, continues: noul(0.1) } : TO_XHIGH) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  await step($, { turnId: 't1', index: 1, effort: 'medium' })
  await complete($, 't1', { isAborted: true })
  await submit($, 'Stop that, look at the logs instead')
  await step($, { turnId: 't2', index: 0, effort: 'medium' })
  await step($, { turnId: 't2', index: 1, effort: 'medium' })

  expect(w.fetched[1]!.body.state.previous_turn).toMatchObject({ ended: 'interrupted', level: 'xhigh' })
  expect(efforts(w)).toEqual(['xhigh', 'xhigh', 'medium', 'medium'])
  expect(logged(w).map((d) => [d.turnId, d.from, d.to])).toEqual([
    ['t1', 'medium', 'xhigh'],
    ['t2', 'medium', 'medium'],
  ])
})

// What the nine do not reach.

test('sdk 和 bridge 发来的消息照样判断', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answering(RAISE) })
  await start($)
  await submit($, TASK, { kind: 'sdk' })
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  await complete($, 't1')
  await submit($, 'Now the downloader', { kind: 'bridge' })
  await step($, { turnId: 't2', index: 0, effort: 'medium' })

  expect(w.fetched).toHaveLength(2)
  expect(w.fetched.map((f) => f.body.state.request)).toEqual([TASK, 'Now the downloader'])
  expect(efforts(w)).toEqual(['high', 'high'])
  expect(logged(w).map((d) => d.turnId)).toEqual(['t1', 't2'])
})

test('enabled 关着：不发请求，effort 不变', { options: { ...KEYS, enabled: false } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: () => drexOk(RAISE) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  expect(w.submitted.map((s) => s.text)).toEqual([TASK])
  expect(w.fetched).toHaveLength(0)
  expect(efforts(w)).toEqual(['medium'])
  expect(logged(w)).toHaveLength(0)
})

test('submitShift 关着：不发请求，effort 不变', { options: { ...KEYS, submitShift: false } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: () => drexOk(RAISE) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  expect(w.submitted.map((s) => s.text)).toEqual([TASK])
  expect(w.fetched).toHaveLength(0)
  expect(efforts(w)).toEqual(['medium'])
  expect(logged(w)).toHaveLength(0)
})

test('锁定时不判断，每步是锁定的档', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: () => drexOk(RAISE) })
  await start($)
  await dp($, 'lock low')
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  await step($, { turnId: 't1', index: 1, effort: 'medium' })
  expect(w.fetched).toHaveLength(0)
  expect(efforts(w)).toEqual(['low', 'low'])
  expect(logged(w)).toHaveLength(0)
})

test('判断结果只用一次：下一轮没有新判断时不沿用', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: () => drexOk(RAISE) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  await complete($, 't1')
  // A turn no person started: nothing is asked, and the last decision is not taken up again.
  await submit($, 'Background task finished', { kind: 'task-notification' })
  await step($, { turnId: 't2', index: 0, effort: 'medium' })
  await step($, { turnId: 't2', index: 1, effort: 'medium' })

  expect(w.fetched).toHaveLength(1)
  expect(efforts(w)).toEqual(['high', 'medium', 'medium'])
  expect(logged(w).map((d) => d.turnId)).toEqual(['t1'])
  expect(session(w).pending).toBeNull()
})

test('agent 的轮不碰主循环的 turn 和 previous', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: () => drexOk(RAISE) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  const before = w.stateWrites.length
  await turnStart($, 'a1', 'Read the uploader and list its retries', 'agent-1')
  await step($, { turnId: 'a1', index: 0, effort: 'low', agentId: 'agent-1' })
  await complete($, 'a1', { answer: 'Three retries, in upload.ts', agentId: 'agent-1' })
  expect(w.stateWrites.slice(before).map((s) => s.key)).toEqual([])
  await step($, { turnId: 't1', index: 1, effort: 'medium' })
  await complete($, 't1', { answer: 'Fixed.' })

  // The agent's step kept its own effort; the main loop's kept the decided one.
  expect(w.stepsSent.map((s) => [s.turnId, s.effort])).toEqual([
    ['t1', 'high'],
    ['a1', 'low'],
    ['t1', 'high'],
  ])
  expect(session(w).previous).toEqual({ request: TASK, lastReply: 'Fixed.', ended: 'answered', level: 'high' })
})

test('turn.complete：每种结束方式记下的上一轮', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($) })
  await start($)
  const endings = [
    [{ reason: 'answer' }, 'answered'],
    [{ isAborted: true }, 'interrupted'],
    [{ reason: 'error' }, 'error'],
    [{ reason: 'refusal' }, 'error'],
  ] as const
  for (const [i, [how, ended]] of endings.entries()) {
    const id = `t${i + 1}`
    await submit($, `message ${i}`, { kind: 'peer' })
    await step($, { turnId: id, index: 0, effort: 'medium' })
    await complete($, id, { answer: `reply ${i}`, ...how })
    // Not judged (a peer's message), so the turn's level is the engine's own at step 0.
    expect(session(w).previous).toEqual({ request: `message ${i}`, lastReply: `reply ${i}`, ended, level: 'medium' })
  }
  // The turn is cleared once it ends.
  expect(w.stateWrites.filter((s) => s.key === 'turn' && s.isSet).at(-1)?.value).toBeNull()
  expect(efforts(w)).toEqual(['medium', 'medium', 'medium', 'medium'])
})

test('turn.complete：上一轮的回答只留 300 token', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: () => drexOk(RAISE) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  const long = 'The retry loop reads the stale socket. '.repeat(200) + 'Shall I fix it?'
  await complete($, 't1', { answer: long })
  const previous = session(w).previous!
  expect(estimateTokens(previous.lastReply)).toBeLessThanOrEqual(300)
  expect(previous.lastReply).toEndWith('Shall I fix it?')
  expect(previous).toMatchObject({ request: TASK, ended: 'answered', level: 'high' })
})

test('一轮中间再来一次 session.start（热重载）：决定的档照旧', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: () => drexOk(RAISE) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  await start($)
  await step($, { turnId: 't1', index: 1, effort: 'medium' })
  await step($, { turnId: 't1', index: 2, effort: 'medium' })
  expect(efforts(w)).toEqual(['high', 'high', 'high'])
  expect(w.commands.map((c) => c.name)).toEqual(['dp', 'dp'])
})

test('判断还在等回答时 /dp lock：锁定和判断结果都留下', { options: KEYS }, async ($, on) => {
  const late: { clock: MockClock | null } = { clock: null }
  const w = world(on, {
    onSubmit: turns($),
    answer: async () => {
      await late.clock!.sleep(1000)
      return drexOk(RAISE)
    },
  })
  late.clock = w.clock
  await start($)
  const sent = submit($, TASK)
  await w.clock.settle()
  expect(await dp($, 'lock xhigh')).toContain('已锁定')
  await w.clock.advance(1000)
  await sent
  expect(session(w)).toMatchObject({ lock: 'xhigh', pending: { request: TASK, result: { ok: true } } })
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  // The lock wins over the decision, which is recorded as not applied.
  expect(efforts(w)).toEqual(['xhigh'])
  expect(logged(w)[0]).toMatchObject({ to: 'high', applied: false })
})

test('hook 出错时放行，并在 debug 日志里写一行（只有 hook 名和错误）', { options: KEYS }, async ($, on) => {
  const w = world(on, { refuse: ['session.surfaces'] })
  await start($)
  // The other half of session.start still ran, and the event went on.
  expect(w.commands.map((c) => c.name)).toEqual(['dp'])
  expect(w.debugLogs).toHaveLength(1)
  expect(w.debugLogs[0]).toContain('session.start')
  expect(w.debugLogs[0]).toContain('refused by the test')
  expect(w.logs).toEqual(w.debugLogs)
})

// A decision belongs to the turn its own message started (controller ruling after Task 6's first review).

test('被丢掉的消息不留判断：下一轮（别的文字开始的）按会话的档走，不记决策', { options: KEYS }, async ($, on) => {
  const next = turns($)
  const w = world(on, {
    answer: () => drexOk(RAISE),
    onSubmit: (e) => (e.text === TASK ? { drop: 'blocked by a hook below' } : next(e)),
  })
  await start($)
  const r = await submit($, TASK)
  expect(r).toMatchObject({ drop: 'blocked by a hook below' })
  // It was asked, and the pending it left is gone once the drop came back.
  expect(w.fetched).toHaveLength(1)
  expect(session(w).pending).toBeNull()
  await submit($, 'Background task finished', { kind: 'task-notification' })
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  await step($, { turnId: 't1', index: 1, effort: 'medium' })

  expect(w.submitted.map((s) => s.text)).toEqual([TASK, 'Background task finished'])
  expect(efforts(w)).toEqual(['medium', 'medium'])
  expect(logged(w)).toHaveLength(0)
})

test('开始这一轮的文字和判断时的消息不同：清掉判断，不用它', { options: KEYS }, async ($, on) => {
  const w = world(on, {
    answer: () => drexOk(RAISE),
    // A hook below rewrote the text: the turn that starts is not the message that was judged.
    onSubmit: (e) => turnStart($, 't1', e.text + ' (rewritten below)'),
  })
  await start($)
  await submit($, TASK)
  expect(w.fetched).toHaveLength(1)
  expect(session(w).pending).toBeNull()
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  await step($, { turnId: 't1', index: 1, effort: 'medium' })

  expect(efforts(w)).toEqual(['medium', 'medium'])
  expect(logged(w)).toHaveLength(0)
  // The turn itself is kept, with the text it started with.
  expect(w.stateWrites.filter((s) => s.key === 'turn' && s.isSet).at(-1)?.value).toMatchObject({ turnId: 't1', request: TASK + ' (rewritten below)', wanted: null })
})

test('第 0 步的轮没见过 turn.start：判断丢掉，不套到这一轮上', { options: KEYS }, async ($, on) => {
  // No onSubmit: nothing raises turn.start, so the step's turn is not the one the message started.
  const w = world(on, { answer: () => drexOk(RAISE) })
  await start($)
  await submit($, TASK)
  expect(session(w).pending).toMatchObject({ request: TASK })
  await step($, { turnId: 't9', index: 0, effort: 'medium' })
  await step($, { turnId: 't9', index: 1, effort: 'medium' })

  expect(efforts(w)).toEqual(['medium', 'medium'])
  expect(logged(w)).toHaveLength(0)
  expect(session(w).pending).toBeNull()
})

test('送进正在跑的一轮的消息（e.turnId 有值）：不发请求，不留判断', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: () => drexOk(RAISE) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  const writes = w.stateWrites.length
  // Delivered into t1, so no turn starts for it: the mid-run check covers such input, not this hook.
  await submit($, 'also check the docs', { kind: 'composer' }, { turnId: 't1' })
  expect(w.submitted.map((s) => s.text)).toEqual([TASK, 'also check the docs'])
  expect(w.fetched).toHaveLength(1)
  expect(w.stateWrites.slice(writes)).toEqual([])
  await step($, { turnId: 't1', index: 1, effort: 'medium' })

  // The running turn keeps the level its own message decided.
  expect(efforts(w)).toEqual(['high', 'high'])
  expect(logged(w).map((d) => d.turnId)).toEqual(['t1'])
})

// Controller fixes after Task 6's review.

test('turn.complete 对不上手上的轮（或手上没有轮）：不写 previous，也不清掉手上的轮', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: () => drexOk(RAISE) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  const writes = w.stateWrites.length
  // The end of a turn this mod never saw start changes nothing.
  await complete($, 't-other', { answer: 'not ours' })
  expect(w.stateWrites.slice(writes)).toEqual([])
  await step($, { turnId: 't1', index: 1, effort: 'medium' })
  expect(efforts(w)).toEqual(['high', 'high'])
  await complete($, 't1', { answer: 'Fixed.' })
  expect(session(w).previous).toEqual({ request: TASK, lastReply: 'Fixed.', ended: 'answered', level: 'high' })
  // With no turn held, an end writes nothing either: previous stays the real one.
  const after = w.stateWrites.length
  await complete($, 't1', { answer: 'again' })
  await complete($, 't2', { answer: 'never started' })
  expect(w.stateWrites.slice(after)).toEqual([])
  expect(session(w).previous).toMatchObject({ request: TASK, lastReply: 'Fixed.' })
})

test('turn.start 清掉旧判断的同时，这一轮自己的判断写进来：update 里重新比对，留下它', { options: KEYS }, async ($, on) => {
  let armed = false
  const w = world(on, {
    answer: () => drexOk(RAISE),
    // Lands the judgement of the turn's own message in the middle of turn.start's write that clears the old one.
    onStateSet: async (e) => {
      if (!armed || e.key !== 'session' || (e.value as SessionState).pending !== null) return
      armed = false
      await submit($, 'Now the downloader')
    },
  })
  await start($)
  // A judged message that started no turn leaves its decision pending.
  await submit($, TASK)
  expect(session(w).pending).toMatchObject({ request: TASK })
  armed = true
  await turnStart($, 't1', 'Now the downloader')
  expect(armed).toBe(false)
  // The decision written meanwhile belongs to this turn: kept, and taken by its first step.
  expect(session(w).pending).toMatchObject({ request: 'Now the downloader' })
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  expect(efforts(w)).toEqual(['high'])
  expect(logged(w).map((d) => [d.turnId, d.to])).toEqual([['t1', 'high']])
})

test('续做：上一轮没有判断过（task-notification），它的档就是会话的档，续做从这一档起算', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: ({ body }) => drexOk('continues' in body.questions ? { ...HOLD, continues: noul(0.9) } : RAISE) })
  await start($)
  await submit($, 'Background task finished', { kind: 'task-notification' })
  await step($, { turnId: 't1', index: 0, effort: 'high' })
  await complete($, 't1', { answer: 'The build passed. Shall I deploy?' })
  expect(session(w).previous).toMatchObject({ request: 'Background task finished', level: 'high' })
  await submit($, 'yes, go on')
  await step($, { turnId: 't2', index: 0, effort: 'high' })
  await step($, { turnId: 't2', index: 1, effort: 'high' })

  expect(w.fetched).toHaveLength(1)
  expect(w.fetched[0]!.body.state.previous_turn).toMatchObject({ level: 'high' })
  // Continuing starts from the previous turn's level, which is the session's: HOLD keeps it.
  expect(logged(w).map((d) => [d.turnId, d.from, d.to, d.reason])).toEqual([['t2', 'high', 'high', 'hold']])
  expect(efforts(w)).toEqual(['high', 'high', 'high'])
})


// Controller ruling (review of fcce8f2): when the mod has decided nothing, it writes nothing.

test('submitShift 关着，这一轮没有自己的判断：后面的步带着引擎的另一个档位照原样过去', { options: { ...KEYS, submitShift: false } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answering(RAISE) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  // The session's own level changed during the turn (/effort): the mod set none, so the step goes as it came.
  await step($, { turnId: 't1', index: 1, effort: 'high' })
  expect(w.fetched).toHaveLength(0)
  expect(efforts(w)).toEqual(['medium', 'high'])
})

test('发消息的评估失败：base 有了而 wanted 没有，后面的步照原样过去', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: () => null })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  await step($, { turnId: 't1', index: 1, effort: 'low' })
  expect(logged(w)[0]).toMatchObject({ kind: 'submit', failure: 'network', applied: false })
  expect(efforts(w)).toEqual(['medium', 'low'])
})

test('这一轮定了档：后面的步带着引擎的另一个档位，照样改成定的档', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answering(RAISE) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  await step($, { turnId: 't1', index: 1, effort: 'low' })
  expect(efforts(w)).toEqual(['high', 'high'])
})
