import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { TRACK_KEEP, boardModel } from '../hooks/board/model.ts'
import { readConfig } from '../hooks/config.ts'
import { openStep, readout } from '../hooks/flows/readout.ts'
import type { SessionState, TrackCell, TurnState } from '../hooks/state.ts'
import { assistantToolUse, deliveryResult, replReceipt, scriptByPoll, toolResult } from './support/rows.ts'
import { seedOf, standIn } from './support/standin.ts'
import { KEYS, appendAll, complete, dp, drexOk, noul, score, start, step, submit, turns, world } from './support/world.ts'

type World = ReturnType<typeof world>

// The state as the mod's last landed write of each key left it (the world records every write).
const lastOf = (w: World, key: string): unknown => w.stateWrites.filter((s) => s.key === key && s.isSet).at(-1)?.value
const turnState = (w: World): TurnState => lastOf(w, 'turn') as TurnState
const session = (w: World): SessionState => lastOf(w, 'session') as SessionState
/** The timeline as [level, mark]: the engine-driven run reads no request, so sent is asserted apart. */
const cells = (w: World): [string, string | null][] => turnState(w).track.map((c) => [c.level, c.mark])
const efforts = (w: World): unknown[] => w.stepsSent.map((s) => s.effort)

const TASK = 'Fix the flaky retry in the uploader'
const OPUS = 'claude-opus-5-5'
const MESSAGES = 'https://api.anthropic.com/v1/messages?beta=true'

// The message's own judgement: from medium, SUBMIT_HOLD holds and SUBMIT_RAISE goes to high.
const SUBMIT_HOLD = { open: score([0.05, 0.3, 0.3, 0.3, 0.05]), mechanical: noul(0.1), unknown_cause: noul(0.2) }
const SUBMIT_RAISE = { open: score([0.02, 0.08, 0.25, 0.55, 0.1]), mechanical: noul(0.1), unknown_cause: noul(0.2) }
// Mid-run answers: HOLD stays put; SAME_FAILURE goes one level up.
const HOLD = { open: score([0.05, 0.3, 0.3, 0.3, 0.05]), same_failure: noul(0.1), cause_found: noul(0.2), only_carrying_out: noul(0.2), contradicts_plan: noul(0.1) }
const SAME_FAILURE = { ...HOLD, same_failure: noul(0.9) }

type Answers = Record<string, unknown>

/** The message's questions get `message`; the n-th mid-run check (from 1) gets midrun(n), null for a network failure. */
function answers(message: Answers, midrun: (n: number) => Answers | null) {
  let n = 0
  return ({ body }: { body: any }) => {
    if (!('same_failure' in body.questions)) return drexOk(message)
    const a = midrun(++n)
    return a === null ? null : drexOk(a)
  }
}

const stepT1 = ($: Engine, index: number, effort: unknown = 'medium') => step($, { turnId: 't1', index, effort })

/** One work step of an ordinary session: a Bash call and its result. */
const bash = ($: Engine, result = '3 passed') => appendAll($, [assistantToolUse('Bash', { command: 'npm test' }), toolResult('Bash', result)])

/** A main-loop request body as the engine sends it (E15): a thread, and the level at the top. */
const body = (effort: string) => JSON.stringify({ model: OPUS, thread: { id: 'th' }, output_config: { effort }, messages: [{ role: 'user', content: 'x' }] })

/** The engine sending the step's model requests, each read by the readout, while the main-loop step is open. */
async function sendIn(f: ReturnType<typeof standIn>, s: { turnId: string; index: number }, efforts: string[]): Promise<void> {
  const close = openStep({ ...s, model: OPUS })
  try {
    for (const effort of efforts) await readout(f.$, { url: MESSAGES, init: { method: 'POST', headers: {}, body: body(effort) } }, 'engine')
  } finally {
    close()
  }
}

// The brief's five.

test('发消息升到 high：第一格是 high，记号是 up；每个工作步开一格', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_RAISE, () => HOLD) })
  await start($)
  await submit($, TASK)
  await stepT1($, 0)
  expect(turnState(w)).toMatchObject({ stepNo: 1, track: [{ level: 'high', sent: null, mark: 'up' }], pendingMark: null })
  expect(session(w)).toMatchObject({ turnNo: 1, sessionLevel: 'medium' })
  await bash($)
  await stepT1($, 1)
  // An ordinary session checks every 8 steps: no check came before the second step, so its cell has no mark.
  expect(cells(w)).toEqual([['high', 'up'], ['high', null]])
  expect(turnState(w)).toMatchObject({ stepNo: 2, journal: { workSteps: 1 } })
  expect(efforts(w)).toEqual(['high', 'high'])
})

test('中途升档：记号落在下一格上，那一格是新档', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, () => SAME_FAILURE) })
  await start($)
  await submit($, TASK)
  await stepT1($, 0)
  await appendAll($, scriptByPoll(1, 'rerun the upload test', 'FAIL test_upload: expected 200, got 500'))
  // The check's mark waits on the turn for the cell of the step it was made before.
  expect(turnState(w)).toMatchObject({ wanted: 'high', pendingMark: 'up', stepNo: 1 })
  await stepT1($, 1)
  expect(cells(w)).toEqual([['medium', 'hold'], ['high', 'up']])
  expect(turnState(w).pendingMark).toBe(null)
  expect(efforts(w)).toEqual(['medium', 'high'])
})

test('同一个工作步里的第二次请求不开新格', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, () => HOLD) })
  await start($)
  await submit($, TASK)
  await stepT1($, 0)
  // Code Mode: the receipt comes back at once and the model is asked again, in the same work step.
  await appendAll($, [assistantToolUse('REPL', { code: '…', description: 'run the upload test' }), replReceipt(1)])
  await stepT1($, 1)
  expect(turnState(w)).toMatchObject({ stepNo: 1, journal: { workSteps: 0 } })
  expect(cells(w)).toEqual([['medium', 'hold']])
  // The script's result ends the work step; the next step is the second cell.
  await appendAll($, [deliveryResult(1, '3 passed')])
  await stepT1($, 2)
  expect(turnState(w)).toMatchObject({ stepNo: 2, journal: { workSteps: 1 } })
  expect(cells(w)).toEqual([['medium', 'hold'], ['medium', 'hold']])
  expect(efforts(w)).toEqual(['medium', 'medium', 'medium'])
})

test('模型不收 effort：不开格', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, () => HOLD) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0 })
  await bash($)
  await step($, { turnId: 't1', index: 1 })
  await bash($)
  await step($, { turnId: 't1', index: 2, effort: 31999 })
  // The work steps are counted (stepNo), but no step carried a level: no cell, and no level of the session.
  expect(turnState(w)).toMatchObject({ stepNo: 3, track: [], journal: { workSteps: 2 } })
  expect(session(w)).toMatchObject({ turnNo: 1, sessionLevel: null })
  const m = boardModel(readConfig(KEYS), { session: session(w), turn: turnState(w), recent: [], skills: [] })
  expect([m.where, m.status.kind, m.next.main]).toEqual(['第 1 轮 · 第 3 步', 'none', '不评估'])
  expect(efforts(w)).toEqual([undefined, undefined, 31999])
})

test('超过 300 格只留最后 300 格，stepNo 照常往上数', { options: { ...KEYS, midrunShift: false } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, () => HOLD) })
  await start($)
  await submit($, TASK)
  await stepT1($, 0)
  expect(cells(w)).toEqual([['medium', 'hold']])
  const total = TRACK_KEEP + 2
  for (let index = 1; index < total; index++) {
    await bash($)
    await stepT1($, index)
  }
  const t = turnState(w)
  expect([t.track.length, t.stepNo, t.journal.workSteps]).toEqual([300, total, total - 1])
  // The first two cells went: the one marked by the message's check among them.
  expect(t.track.every((c: TrackCell) => c.level === 'medium' && c.mark === null)).toBe(true)
})

// Beyond the brief.

test('锁定的轮：格子是锁定的档位，没有判断就没有记号', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_RAISE, () => SAME_FAILURE) })
  await start($)
  await dp($, 'lock xhigh')
  await submit($, TASK)
  await stepT1($, 0)
  await bash($)
  await stepT1($, 1)
  expect(cells(w)).toEqual([['xhigh', null], ['xhigh', null]])
  expect(efforts(w)).toEqual(['xhigh', 'xhigh'])
  // What the engine itself gave, before the lock was written over it.
  expect(session(w)).toMatchObject({ lock: 'xhigh', sessionLevel: 'medium', turnNo: 1 })
})

test('中途评估：不变记 hold，请求失败记 fail，都在下一格', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_RAISE, (n) => (n === 1 ? HOLD : null)) })
  await start($)
  await submit($, TASK)
  await stepT1($, 0)
  await appendAll($, scriptByPoll(1, 'read the uploader', 'upload.ts: 3 retries'))
  await stepT1($, 1)
  await appendAll($, scriptByPoll(2, 'rerun the upload test', 'FAIL test_upload'))
  await stepT1($, 2)
  expect(cells(w)).toEqual([['high', 'up'], ['high', 'hold'], ['high', 'fail']])
})

test('shadow 模式：想换挡的评估没有执行，下一格记 hold，档位不变', { options: { ...KEYS, mode: 'shadow' } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_RAISE, () => SAME_FAILURE) })
  await start($)
  await submit($, TASK)
  await stepT1($, 0)
  await appendAll($, scriptByPoll(1, 'rerun the upload test', 'FAIL test_upload: expected 200, got 500'))
  await stepT1($, 1)
  // Both evaluations wanted a level up (shadow judges on from the level it would have set) and neither was applied:
  // the cells say what the level did.
  const judged = (lastOf(w, 'recent') as { kind: string; from: string; to: string; applied: boolean }[]).map((d) => [d.kind, d.from, d.to, d.applied])
  expect(judged).toEqual([['submit', 'medium', 'high', false], ['midrun', 'high', 'xhigh', false]])
  expect(cells(w)).toEqual([['medium', 'hold'], ['medium', 'hold']])
  expect(efforts(w)).toEqual(['medium', 'medium'])
  // The board, once step 1's request is read: the level the steps go at is the engine's, as sent.
  const f = standIn(seedOf(w))
  await sendIn(f, { turnId: 't1', index: 1 }, ['medium'])
  // The turn holds the level the message's evaluation would have set; the board does not show it as the level.
  expect(f.turn()).toMatchObject({ base: 'medium', wanted: 'high' })
  const m = boardModel(readConfig({ ...KEYS, mode: 'shadow' }), { session: f.session(), turn: f.turn(), recent: f.recent(), skills: [] })
  expect([m.wanted, m.sent, m.level, m.status]).toEqual(['medium', 'medium', 'medium', { kind: 'sent', text: '已发出' }])
  expect(m.last).toMatchObject({ mark: 'hold', text: '想升到 xhigh，未执行' })
  expect(m.track.at(-1)).toEqual({ level: 'medium', sent: 'medium', mark: 'hold' })
})

test('verifyEffort 关着：格子照开，sent 一直是 null', { options: { ...KEYS, verifyEffort: false } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_RAISE, () => HOLD) })
  await start($)
  await submit($, TASK)
  await stepT1($, 0)
  await appendAll($, scriptByPoll(1, 'read the uploader', 'upload.ts: 3 retries'))
  await stepT1($, 1)
  expect(turnState(w).track).toEqual([
    { level: 'high', sent: null, mark: 'up' },
    { level: 'high', sent: null, mark: 'hold' },
  ])
})

test('一步的第一次主循环请求填进最后一格的 sent，之后的请求不改它', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_RAISE, () => HOLD) })
  await start($)
  await submit($, TASK)
  await stepT1($, 0)
  await appendAll($, scriptByPoll(1, 'read the uploader', 'upload.ts: 3 retries'))
  await stepT1($, 1)
  // Code Mode: the second script's receipt, then the request of the same work step.
  await appendAll($, [assistantToolUse('REPL', { code: '…', description: 'run the upload test' }), replReceipt(2)])
  expect(cells(w)).toEqual([['high', 'up'], ['high', 'hold']])

  const f = standIn(seedOf(w))
  // Step 1's request: the last cell takes the level it carried; a second request of the step is not the main loop's.
  await sendIn(f, { turnId: 't1', index: 1 }, ['high', 'low'])
  expect(f.turn()!.track).toEqual([
    { level: 'high', sent: null, mark: 'up' },
    { level: 'high', sent: 'high', mark: 'hold' },
  ])
  // Step 2 is the same work step (after the receipt): its request is read, but the cell keeps its first level.
  await sendIn(f, { turnId: 't1', index: 2 }, ['medium'])
  expect(f.turn()!.track.at(-1)).toEqual({ level: 'high', sent: 'high', mark: 'hold' })
  expect(f.session().lastSent).toBe('medium')
  // A request of a step of another turn writes no cell.
  const g = standIn(seedOf(w))
  await sendIn(g, { turnId: 't0', index: 1 }, ['high'])
  expect(g.turn()!.track.map((c) => c.sent)).toEqual([null, null])
  expect(g.session().lastSent).toBe('high')
})

// No backend can be asked (ruling R37): nothing is evaluated, so no cell carries a mark and no mark ever waits.
test('没有密钥：一轮里每格都没有记号，pendingMark 从没写过，每格是引擎自己的档', { options: {} }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_RAISE, () => SAME_FAILURE) })
  await start($)
  await submit($, TASK)
  await stepT1($, 0)
  for (const n of [1, 2, 3]) {
    await appendAll($, scriptByPoll(n, 'rerun the upload test', 'FAIL test_upload: expected 200, got 500'))
    await stepT1($, n)
  }
  expect(cells(w)).toEqual([
    ['medium', null],
    ['medium', null],
    ['medium', null],
    ['medium', null],
  ])
  expect(turnState(w)).toMatchObject({ stepNo: 4, base: 'medium', wanted: null })
  const turnWrites = w.stateWrites.filter((s) => s.key === 'turn' && s.value !== null).map((s) => s.value as TurnState)
  expect(turnWrites.length).toBeGreaterThan(0)
  expect(turnWrites.filter((t) => t.pendingMark !== null)).toHaveLength(0)
  expect(efforts(w)).toEqual(['medium', 'medium', 'medium', 'medium'])
  expect(w.fetched).toHaveLength(0)
})

// The board built from what the mod wrote (controller ruling): between turn.start and step 0 the turn is starting.
const boardOf = (w: World, options: Record<string, unknown> = KEYS) => boardModel(readConfig(options), { session: session(w), turn: turnState(w), recent: [], skills: [] })

test('turn.start 之后、第 0 步之前看板是 starting；第 0 步带档位之后不是', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, () => HOLD) })
  await start($)
  await submit($, TASK)
  await stepT1($, 0)
  await complete($, 't1')
  // The last turn's step left the session's level: the next turn's first row shows it while its own is unknown.
  await submit($, 'Now the downloader')
  expect(turnState(w)).toMatchObject({ turnId: 't2', stepNo: 0, track: [] })
  expect(boardOf(w).status).toEqual({ kind: 'starting', text: '这一轮刚开始' })
  expect(boardOf(w).where).toBe('第 2 轮 · 刚开始')
  expect(boardOf(w).level).toBe('medium')
  await step($, { turnId: 't2', index: 0, effort: 'medium' })
  expect(turnState(w).stepNo).toBe(1)
  expect(boardOf(w).status.kind).not.toBe('starting')
  expect(boardOf(w).status.kind).not.toBe('none')
  expect(boardOf(w).level).toBe('medium')
})

test('第 0 步没有档位（模型不收 effort）：之后看板才说不收 effort', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, () => HOLD) })
  await start($)
  await submit($, TASK)
  expect(boardOf(w).status.kind).toBe('starting')
  expect(boardOf(w).level).toBe(null)
  await step($, { turnId: 't1', index: 0 })
  expect(turnState(w).stepNo).toBe(1)
  expect(boardOf(w).status).toEqual({ kind: 'none', text: '这个模型不收 effort' })
})
