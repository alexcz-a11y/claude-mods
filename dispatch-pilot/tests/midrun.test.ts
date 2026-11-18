import { expect, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { SessionAppendInput } from 'claude-code'

import { readConfig } from '../hooks/config.ts'
import { START } from '../hooks/decide.ts'
import { emptyJournal } from '../hooks/journal.ts'
import type { TurnJournal } from '../hooks/journal.ts'
import type { Decision } from '../hooks/log.ts'
import { applyShift, carrierOf, carriesNote, emptyCounters, gapOk, isCheckpoint, noteText, notesLeft, withNote } from '../hooks/midrun.ts'
import type { MidrunCounters } from '../hooks/midrun.ts'
import { newTurn } from '../hooks/state.ts'
import type { SessionState, TurnState } from '../hooks/state.ts'
import {
  assistantText,
  assistantToolUse,
  attachmentRow,
  deliveryEvent,
  emptyDelivery,
  innerCall,
  innerToolUse,
  pollResult,
  promptRow,
  queueRow,
  replReceipt,
  scriptByDelivery,
  scriptByPoll,
  toolResult,
} from './support/rows.ts'
import { KEYS, append, appendAll, complete, dp, drexOk, noul, score, start, step, submit, turnStart, turns, world } from './support/world.ts'

type World = ReturnType<typeof world>

// What the mod recorded and wrote, and what reached the engine.
const logged = (w: World): Decision[] => (w.storeWrites.filter((s) => s.key === 'log').at(-1)?.value ?? []) as Decision[]
const midruns = (w: World): Decision[] => logged(w).filter((d) => d.kind === 'midrun')
const session = (w: World): SessionState => w.stateWrites.filter((s) => s.key === 'session' && s.isSet).at(-1)?.value as SessionState
const turnState = (w: World): TurnState => w.stateWrites.filter((s) => s.key === 'turn' && s.isSet).at(-1)?.value as TurnState
const efforts = (w: World): unknown[] => w.stepsSent.map((s) => s.effort)
/** The mid-run requests (the message's own has no same_failure question). */
const asked = (w: World) => w.fetched.filter((f) => 'same_failure' in f.body.questions)
/** The row as it reached the engine, found by its uuid (pinned). */
const reached = (w: World, row: SessionAppendInput): SessionAppendInput | undefined => w.appended.find((a) => a.uuid === row.uuid)
const noteBlock = (text: string) => ({ type: 'text', text })

const NOTE_HIGH = '[dispatch-pilot] effort is now high: the same failure came back after a fix.'

// The message's own judgement: from medium, SUBMIT_HOLD holds and SUBMIT_RAISE goes to high.
const SUBMIT_HOLD = { open: score([0.05, 0.3, 0.3, 0.3, 0.05]), mechanical: noul(0.1), unknown_cause: noul(0.2) }
const SUBMIT_RAISE = { open: score([0.02, 0.08, 0.25, 0.55, 0.1]), mechanical: noul(0.1), unknown_cause: noul(0.2) }

// Mid-run answers. HOLD stays put from medium, high and xhigh (each side under its bar).
const FLAGS_NO = { same_failure: noul(0.1), cause_found: noul(0.2), only_carrying_out: noul(0.2), contradicts_plan: noul(0.1) }
const HOLD = { open: score([0.05, 0.3, 0.3, 0.3, 0.05]), ...FLAGS_NO }
/** One level up: the same failure after a fix. */
const SAME_FAILURE = { ...HOLD, same_failure: noul(0.9) }
const CONTRADICTS = { ...HOLD, contradicts_plan: noul(0.9) }
/** From high or xhigh down to medium: the cause is found. Holds at medium. */
const CAUSE_FOUND = { open: score([0.1, 0.8, 0.05, 0.05, 0]), ...FLAGS_NO, cause_found: noul(0.9) }
/** Wants max: 0.95 above high, so high goes to xhigh, and the mid-run cap stops it there. */
const TO_TOP = { open: score([0, 0, 0.05, 0.15, 0.8]), ...FLAGS_NO }

type Answers = Record<string, unknown>

// Answers the message's questions with `message` (and continues 0.1 when asked), the mid-run ones with
// `midrun`, or with what it returns for the state sent.
function answers(message: Answers, midrun: Answers | ((state: any) => Answers)) {
  return ({ body }: { body: any }) => {
    if ('same_failure' in body.questions) return drexOk(typeof midrun === 'function' ? midrun(body.state) : midrun)
    return drexOk('continues' in body.questions ? { ...message, continues: noul(0.1) } : message)
  }
}

const TASK = 'Fix the flaky retry in the uploader'

// A turn under way: the session started, the message sent and judged, its first step taken at medium.
async function begin($: Engine) {
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
}

/** Step `index` of t1, where the session's own effort is medium. */
const stepT1 = ($: Engine, index: number) => step($, { turnId: 't1', index, effort: 'medium' })

// The brief's eleven.

test('Code Mode：Poll 结果行到达时判断，说明加在这一行，下一步是新档', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, SAME_FAILURE) })
  await begin($)
  const receipt = replReceipt(1)
  const result = pollResult(1, 'FAIL test_upload: expected 200, got 500')
  await appendAll($, [assistantToolUse('REPL', { code: 'await $`npm test`', description: 'rerun the upload test' }), receipt, result])
  await stepT1($, 1)

  // The note is one more text block at the end of Poll's row; the result block before it is as it came.
  const polled = reached(w, result)!
  expect(polled.message.content).toEqual([result.message.content[0], noteBlock(NOTE_HIGH)])
  expect(reached(w, receipt)).toEqual(receipt)
  expect(efforts(w)).toEqual(['medium', 'high'])

  expect(asked(w)).toHaveLength(1)
  const body = asked(w)[0]!.body
  expect(Object.keys(body.questions)).toEqual(['open', 'same_failure', 'cause_found', 'only_carrying_out', 'contradicts_plan'])
  expect(body.state).toMatchObject({
    request: TASK,
    current_level: 'medium',
    steps_so_far: 1,
    failed_steps: 0,
    recent: [],
    latest: { did: 'rerun the upload test', tools: ['REPL'], outcome: 'ok', result: 'FAIL test_upload: expected 200, got 500' },
  })

  const d = midruns(w)
  expect(d).toHaveLength(1)
  expect(d[0]).toMatchObject({
    kind: 'midrun',
    backend: 'drex',
    model: 'drex-max-v1.1',
    from: 'medium',
    to: 'high',
    reason: 'same-failure',
    detail: '',
    bars: START,
    failure: null,
    requestId: null,
    applied: true,
    sent: null,
    turnId: 't1',
    step: 1,
  })
  expect(d[0]!.raw).toEqual({
    open: { type: 'score', score: HOLD.open.score, probabilities: [0.05, 0.3, 0.3, 0.3, 0.05] },
    same_failure: { type: 'noul', noul: 0.9 },
    cause_found: { type: 'noul', noul: 0.2 },
    only_carrying_out: { type: 'noul', noul: 0.2 },
    contradicts_plan: { type: 'noul', noul: 0.1 },
  })
  expect(turnState(w)).toMatchObject({ wanted: 'high', pendingNote: null, midrun: { notes: 1, lastShiftAt: 1, stepsSinceCheck: 0, scriptsSinceCheck: 0 } })
})

test('结果经 delivery 行到达：这一行不改，说明加在下一条回执行上', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, (s) => (s.current_level === 'medium' ? SAME_FAILURE : HOLD)) })
  await begin($)
  const first = scriptByDelivery(1, 'run the upload test', 'FAIL test_upload')
  await appendAll($, first)
  // Judged on the delivery row, which cannot carry a shift: the row is left as it came and the note waits.
  const delivered = first.find((r) => r.door === 'delivery')!
  expect(reached(w, delivered)).toEqual(delivered)
  for (const r of first) expect(reached(w, r)).toEqual(r)
  expect(asked(w)).toHaveLength(1)
  expect(midruns(w)[0]).toMatchObject({ from: 'medium', to: 'high', reason: 'same-failure', applied: true, step: 1 })
  expect(turnState(w)).toMatchObject({ wanted: 'high', pendingNote: NOTE_HIGH, midrun: { notes: 1, lastShiftAt: 1 } })

  await stepT1($, 1)
  const second = scriptByPoll(2, 'fix the retry and rerun', '3 passed')
  await appendAll($, second)
  const receipt = second.find((r) => r.door === 'tool-result' && r.origin.kind === 'tool' && r.origin.tool === 'REPL')!
  expect(reached(w, receipt)!.message.content).toEqual([receipt.message.content[0], noteBlock(NOTE_HIGH)])
  // Every other row of the second script went on as it came; its result was judged (hold) and got nothing.
  for (const r of second.filter((r) => r !== receipt)) expect(reached(w, r)).toEqual(r)
  expect(asked(w)).toHaveLength(2)
  expect(midruns(w)[1]).toMatchObject({ from: 'high', to: 'high', reason: 'hold', applied: false, step: 2 })
  expect(turnState(w)).toMatchObject({ wanted: 'high', pendingNote: null, midrun: { notes: 1, lastShiftAt: 1 } })
  await stepT1($, 2)
  expect(efforts(w)).toEqual(['medium', 'high', 'high'])
})

test('回答落在中间带：不加说明，档位不变', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, HOLD) })
  await begin($)
  const rows = scriptByPoll(1, 'read the uploader', 'upload.ts: 3 retries, no backoff')
  await appendAll($, rows)
  await stepT1($, 1)

  expect(asked(w)).toHaveLength(1)
  for (const r of rows) expect(reached(w, r)).toEqual(r)
  expect(efforts(w)).toEqual(['medium', 'medium'])
  expect(midruns(w)).toHaveLength(1)
  expect(midruns(w)[0]).toMatchObject({ kind: 'midrun', from: 'medium', to: 'medium', reason: 'hold', applied: false, failure: null, detail: '', bars: START, step: 1 })
  expect(turnState(w)).toMatchObject({ wanted: 'medium', pendingNote: null, midrun: { notes: 0, lastShiftAt: null, stepsSinceCheck: 0, scriptsSinceCheck: 0 } })
})

test('midrunEveryScripts 为 2：第一次脚本结果不发请求，第二次才发', { options: { ...KEYS, midrunEveryScripts: 2 } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, HOLD) })
  await begin($)
  const seen: [number, TurnState['midrun']][] = []
  const scripts = [scriptByPoll(1, 'a', 'r1'), scriptByPoll(2, 'b', 'r2'), scriptByDelivery(3, 'c', 'r3'), scriptByPoll(4, 'd', 'r4')]
  for (const rows of scripts) {
    await appendAll($, rows)
    seen.push([asked(w).length, turnState(w).midrun])
  }
  expect(seen).toEqual([
    [0, { notes: 0, lastShiftAt: null, stepsSinceCheck: 1, scriptsSinceCheck: 1 }],
    [1, { notes: 0, lastShiftAt: null, stepsSinceCheck: 0, scriptsSinceCheck: 0 }],
    [1, { notes: 0, lastShiftAt: null, stepsSinceCheck: 1, scriptsSinceCheck: 1 }],
    [2, { notes: 0, lastShiftAt: null, stepsSinceCheck: 0, scriptsSinceCheck: 0 }],
  ])
  expect(midruns(w).map((d) => d.step)).toEqual([2, 4])
  expect(asked(w).map((f) => f.body.state.latest.result)).toEqual(['r2', 'r4'])
})

test('一轮最多 4 条说明，用完之后脚本结果不再发请求；两次换挡之间不足 3 个工作步时照常评估但不换', { options: KEYS }, async ($, on) => {
  // Up from medium, down from high: every check wants to move.
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, (s) => (s.current_level === 'medium' ? SAME_FAILURE : CAUSE_FOUND)) })
  await begin($)
  const results: SessionAppendInput[] = []
  const asks: number[] = []
  for (let n = 1; n <= 12; n++) {
    const rows = scriptByPoll(n, `script ${n}`, `result ${n}`)
    await appendAll($, rows)
    results.push(rows.find((r) => r.origin.kind === 'tool' && r.origin.tool === 'Poll')!)
    asks.push(asked(w).length)
    await stepT1($, n)
  }
  // Every script is judged until the fourth note; after it, script results send nothing.
  expect(asks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10])
  // Shifts at work steps 1, 4, 7 and 10 (three apart); the checks between were made but changed nothing.
  expect(midruns(w).map((d) => [d.step, d.from, d.to, d.applied])).toEqual([
    [1, 'medium', 'high', true],
    [2, 'high', 'medium', false],
    [3, 'high', 'medium', false],
    [4, 'high', 'medium', true],
    [5, 'medium', 'high', false],
    [6, 'medium', 'high', false],
    [7, 'medium', 'high', true],
    [8, 'high', 'medium', false],
    [9, 'high', 'medium', false],
    [10, 'high', 'medium', true],
  ])
  const DOWN = '[dispatch-pilot] effort is now medium: the cause is found and what remains is routine.'
  const notes = results.map((r) => {
    const content = reached(w, r)!.message.content
    return content.length === 1 ? null : content.at(-1)
  })
  expect(notes).toEqual([noteBlock(NOTE_HIGH), null, null, noteBlock(DOWN), null, null, noteBlock(NOTE_HIGH), null, null, noteBlock(DOWN), null, null])
  expect(efforts(w)).toEqual(['medium', 'high', 'high', 'high', 'medium', 'medium', 'medium', 'high', 'high', 'high', 'medium', 'medium', 'medium'])
  expect(turnState(w).midrun).toMatchObject({ notes: 4, lastShiftAt: 10 })
})

test('中途最高到 xhigh', { options: KEYS }, async ($, on) => {
  // The first check wants max; every later one wants it too and adds both flags that raise.
  const w = world(on, {
    onSubmit: turns($),
    answer: answers(SUBMIT_RAISE, (s) => (s.steps_so_far === 1 ? TO_TOP : { ...TO_TOP, same_failure: noul(0.9), contradicts_plan: noul(0.9) })),
  })
  await begin($)
  const first = scriptByPoll(1, 'trace the retry loop', 'race between two timers')
  await appendAll($, first)
  await stepT1($, 1)
  const poll = first.find((r) => r.origin.kind === 'tool' && r.origin.tool === 'Poll')!
  expect(reached(w, poll)!.message.content.at(-1)).toEqual(noteBlock('[dispatch-pilot] effort is now xhigh: the remaining problem is more open than assumed.'))
  for (let n = 2; n <= 5; n++) {
    await appendAll($, scriptByPoll(n, `script ${n}`, 'still racing'))
    await stepT1($, n)
  }
  expect(efforts(w)).toEqual(['high', 'xhigh', 'xhigh', 'xhigh', 'xhigh', 'xhigh'])
  expect(midruns(w).map((d) => [d.step, d.from, d.to, d.reason, d.applied])).toEqual([
    [1, 'high', 'xhigh', 'more-open', true],
    [2, 'xhigh', 'xhigh', 'hold', false],
    [3, 'xhigh', 'xhigh', 'hold', false],
    [4, 'xhigh', 'xhigh', 'hold', false],
    [5, 'xhigh', 'xhigh', 'hold', false],
  ])
  expect(turnState(w).midrun.notes).toBe(1)
})

test('普通会话：同一步的两条并行结果行，只在一条上加说明（Review Focus 5）', { options: { ...KEYS, midrunEverySteps: 1 } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, SAME_FAILURE) })
  await begin($)
  const upload = toolResult('Bash', 'FAIL test_upload', { error: true })
  const download = toolResult('Bash', 'FAIL test_download', { error: true })
  await appendAll($, [assistantToolUse('Bash', { command: 'npm test -- upload' }), assistantToolUse('Bash', { command: 'npm test -- download' }), upload, download])
  await stepT1($, 1)

  // Both rows are checkpoints and both are judged; the second comes within the gap, so only the first is noted.
  expect(asked(w)).toHaveLength(2)
  expect(reached(w, upload)!.message.content).toEqual([upload.message.content[0], noteBlock(NOTE_HIGH)])
  expect(reached(w, download)).toEqual(download)
  expect(midruns(w).map((d) => [d.step, d.from, d.to, d.applied])).toEqual([
    [1, 'medium', 'high', true],
    [2, 'high', 'xhigh', false],
  ])
  expect(efforts(w)).toEqual(['medium', 'high'])
  expect(turnState(w).midrun).toMatchObject({ notes: 1, lastShiftAt: 1 })
  expect(session(w).codeMode).toBe(false)
})

test('普通会话：连续两步失败是检查点；单独一次失败不是', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, HOLD) })
  await begin($)
  const plan: [string, string, boolean][] = [
    ['Read', 'upload.ts', false],
    ['Bash', 'FAIL test_upload', true],
    ['Read', 'retry.ts', false],
    ['Bash', 'FAIL test_upload', true],
    ['Bash', 'FAIL test_download', true],
    ['Edit', 'ok', false],
    // The same error again after an edit: a checkpoint although only one step failed in a row.
    ['Bash', 'FAIL test_download', true],
  ]
  const counts: number[] = []
  for (const [tool, text, error] of plan) {
    await appendAll($, [assistantToolUse(tool), toolResult(tool, text, { error })])
    counts.push(asked(w).length)
  }
  expect(counts).toEqual([0, 0, 0, 0, 1, 1, 2])
  expect(midruns(w).map((d) => d.step)).toEqual([5, 7])
  expect(asked(w)[0]!.body.state).toMatchObject({ steps_so_far: 5, failed_steps: 3, latest: { did: 'Bash', outcome: 'error', result: 'FAIL test_download' } })
})

test('新输入的行：换挡但不加说明', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, (s) => (s.latest.did === 'new input' ? CONTRADICTS : HOLD)) })
  await begin($)
  await appendAll($, scriptByPoll(1, 'read the uploader', 'upload.ts: 3 retries'))
  await stepT1($, 1)
  const typed = promptRow('Also make the retry count configurable')
  await append($, typed)
  await stepT1($, 2)

  // The row carries input, so the step after it sends the new level without a note.
  expect(reached(w, typed)).toEqual(typed)
  expect(efforts(w)).toEqual(['medium', 'medium', 'high'])
  expect(asked(w)).toHaveLength(2)
  expect(asked(w)[1]!.body.state).toMatchObject({
    current_level: 'medium',
    steps_so_far: 1,
    recent: [{ did: 'read the uploader', tools: ['REPL'], outcome: 'ok', result: 'upload.ts: 3 retries' }],
    latest: { did: 'new input', tools: [], outcome: 'ok', result: 'Also make the retry count configurable' },
  })
  expect(midruns(w)[1]).toMatchObject({ from: 'medium', to: 'high', reason: 'contradicts-plan', applied: true, step: 1 })
  expect(turnState(w)).toMatchObject({ wanted: 'high', pendingNote: null, midrun: { notes: 0, lastShiftAt: 1 } })
})

test('经 delivery 行来的新输入：照常判断，换挡的说明排到下一条能带它的行上，占一条说明；发出的文字去掉外壳和 nonce 行', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, (s) => (s.latest.did === 'new input' ? CONTRADICTS : HOLD)) })
  await begin($)
  await appendAll($, scriptByPoll(1, 'read the uploader', 'upload.ts: 3 retries'))
  await stepT1($, 1)
  const notice = deliveryEvent('task-notification', 'agent-1 finished: the server rejects retries after 2', 7)
  await append($, notice)

  // The delivery row cannot carry the shift (design E13): it goes on as it came, and the note waits.
  expect(reached(w, notice)).toEqual(notice)
  expect(asked(w)).toHaveLength(2)
  expect(asked(w)[1]!.body.state.latest).toEqual({
    did: 'new input',
    tools: [],
    outcome: 'ok',
    result: '<event nonce="N7" kind="task-notification" at="2026-11-18T12:56:20.570Z">\nagent-1 finished: the server rejects retries after 2\n</event>',
  })
  const CONTRADICTS_NOTE = '[dispatch-pilot] effort is now high: a result contradicts the plan.'
  expect(midruns(w)[1]).toMatchObject({ from: 'medium', to: 'high', reason: 'contradicts-plan', applied: true, step: 1 })
  expect(turnState(w)).toMatchObject({ wanted: 'high', pendingNote: CONTRADICTS_NOTE, midrun: { notes: 1, lastShiftAt: 1 } })

  await stepT1($, 2)
  const next = scriptByPoll(2, 'cap the retries at 2', 'ok')
  await appendAll($, next)
  const receipt = next.find((r) => r.origin.kind === 'tool' && r.origin.tool === 'REPL')!
  expect(reached(w, receipt)!.message.content).toEqual([receipt.message.content[0], noteBlock(CONTRADICTS_NOTE)])
  expect(turnState(w)).toMatchObject({ pendingNote: null, midrun: { notes: 1 } })
})

test('同一步的两条结果行，两个请求同时在途：写入时再核对一次，只有一条换挡、一条说明', { options: { ...KEYS, midrunEverySteps: 1 } }, async ($, on) => {
  const late: { clock: MockClock | null } = { clock: null }
  const w = world(on, {
    onSubmit: turns($),
    answer: async ({ body }) => {
      if (!('same_failure' in body.questions)) return drexOk(SUBMIT_HOLD)
      await late.clock!.sleep(500)
      return drexOk(SAME_FAILURE)
    },
  })
  late.clock = w.clock
  await begin($)
  await appendAll($, [assistantToolUse('Bash', { command: 'npm test -- upload' }), assistantToolUse('Bash', { command: 'npm test -- download' })])
  const upload = toolResult('Bash', 'FAIL test_upload', { error: true })
  const download = toolResult('Bash', 'FAIL test_download', { error: true })
  // Both rows are appended before either answer comes back.
  const first = append($, upload)
  const second = append($, download)
  await w.clock.settle()
  expect(asked(w)).toHaveLength(2)
  await w.clock.advance(500)
  await Promise.all([first, second])
  await stepT1($, 1)

  // Both were asked about medium and both answers say high; only the first write finds the turn still at medium.
  const noted = [upload, download].filter((r) => reached(w, r)!.message.content.length === 2)
  expect(noted).toHaveLength(1)
  expect(reached(w, noted[0]!)!.message.content.at(-1)).toEqual(noteBlock(NOTE_HIGH))
  expect(midruns(w).map((d) => [d.from, d.to])).toEqual([
    ['medium', 'high'],
    ['medium', 'high'],
  ])
  expect(midruns(w).map((d) => d.applied).sort()).toEqual([false, true])
  expect(turnState(w)).toMatchObject({ wanted: 'high', midrun: { notes: 1 } })
  expect(efforts(w)).toEqual(['medium', 'high'])
})

test('时限到了：行原样放行', { options: KEYS }, async ($, on) => {
  const late: { clock: MockClock | null } = { clock: null }
  const w = world(on, {
    onSubmit: turns($),
    answer: async ({ body }) => {
      if (!('same_failure' in body.questions)) return drexOk(SUBMIT_HOLD)
      await late.clock!.sleep(60_000)
      return drexOk(SAME_FAILURE)
    },
  })
  late.clock = w.clock
  await begin($)
  await appendAll($, [assistantToolUse('REPL', { description: 'rerun the upload test' }), replReceipt(1)])
  const result = pollResult(1, 'FAIL test_upload')
  const held = append($, result)
  await w.clock.settle()
  // The row waits while the question is out.
  expect(reached(w, result)).toBeUndefined()
  await w.clock.advance(2000)
  await held
  await stepT1($, 1)

  expect(reached(w, result)).toEqual(result)
  expect(asked(w)).toHaveLength(1)
  expect(efforts(w)).toEqual(['medium', 'medium'])
  expect(midruns(w)).toHaveLength(1)
  expect(midruns(w)[0]).toMatchObject({
    kind: 'midrun',
    backend: 'drex',
    model: null,
    ms: 2000,
    from: 'medium',
    to: 'medium',
    reason: null,
    raw: null,
    bars: null,
    failure: 'timeout',
    applied: false,
    detail: 'Drex 没有在时限内回答',
    step: 1,
  })
  expect(turnState(w)).toMatchObject({ wanted: 'medium', midrun: { notes: 0, lastShiftAt: null, stepsSinceCheck: 0, scriptsSinceCheck: 0 } })
})

for (const [name, options, lock] of [
  ['锁定', KEYS, true],
  ['shadow', { ...KEYS, mode: 'shadow' }, false],
  ['midrunShift 关着', { ...KEYS, midrunShift: false }, false],
] as const) {
  test(`锁定、shadow、midrunShift 关着：都不加说明（${name}）`, { options }, async ($, on) => {
    const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, SAME_FAILURE) })
    await start($)
    if (lock) await dp($, 'lock low')
    await submit($, TASK)
    await step($, { turnId: 't1', index: 0, effort: 'medium' })
    const rows = scriptByPoll(1, 'rerun the upload test', 'FAIL test_upload')
    await appendAll($, rows)
    await stepT1($, 1)

    for (const r of rows) expect(reached(w, r)).toEqual(r)
    // The turn's evidence is kept all the same.
    expect(turnState(w).journal.workSteps).toBe(1)
    expect(turnState(w).midrun.notes).toBe(0)
    if (name === 'shadow') {
      // Judged and recorded, nothing changed.
      expect(asked(w)).toHaveLength(1)
      expect(midruns(w)).toHaveLength(1)
      expect(midruns(w)[0]).toMatchObject({ from: 'medium', to: 'high', reason: 'same-failure', applied: false, failure: null })
      expect(turnState(w).wanted).toBe('medium')
      expect(efforts(w)).toEqual(['medium', 'medium'])
    } else {
      expect(asked(w)).toHaveLength(0)
      expect(midruns(w)).toHaveLength(0)
      expect(efforts(w)).toEqual(lock ? ['low', 'low'] : ['medium', 'medium'])
    }
  })
}

// What the eleven do not reach.

test('第一条回执行把 session.codeMode 置上，之后一直是 true', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, HOLD) })
  await begin($)
  await appendAll($, [assistantToolUse('Read'), toolResult('Read', 'upload.ts')])
  expect(session(w).codeMode).toBe(false)
  await appendAll($, scriptByPoll(1, 'scan', 'ok'))
  expect(session(w).codeMode).toBe(true)
  await complete($, 't1')
  await submit($, 'Now the downloader')
  await step($, { turnId: 't2', index: 0, effort: 'medium' })
  await appendAll($, [assistantToolUse('Read'), toolResult('Read', 'download.ts'), ...scriptByPoll(2, 'scan', 'ok')])
  expect(session(w).codeMode).toBe(true)
  // Written once, when it turned true.
  const flips = w.stateWrites.filter((s) => s.key === 'session' && s.isSet).map((s) => (s.value as SessionState).codeMode)
  expect(flips.indexOf(true)).toBeGreaterThan(-1)
  expect(flips.slice(flips.indexOf(true)).every((c) => c)).toBe(true)
})

test('排着的说明加在下一条能带它的行上（这里是 Poll 结果行），这一行不再判断', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, SAME_FAILURE) })
  await begin($)
  await appendAll($, scriptByDelivery(1, 'run the upload test', 'FAIL test_upload'))
  expect(turnState(w).pendingNote).toBe(NOTE_HIGH)
  await stepT1($, 1)
  // The next step only waits on another script: its Poll result is the first row that can carry the note.
  const waited = pollResult(9, 'late result')
  await appendAll($, [assistantToolUse('Poll'), emptyDelivery(), waited])
  expect(reached(w, waited)!.message.content).toEqual([waited.message.content[0], noteBlock(NOTE_HIGH)])
  expect(asked(w)).toHaveLength(1)
  expect(turnState(w)).toMatchObject({ pendingNote: null, midrun: { notes: 1, scriptsSinceCheck: 1 } })
})

test('说明排着时锁定了：不再加它，每步是锁定的档', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, SAME_FAILURE) })
  await begin($)
  await appendAll($, scriptByDelivery(1, 'run the upload test', 'FAIL test_upload'))
  expect(turnState(w).pendingNote).toBe(NOTE_HIGH)
  expect(await dp($, 'lock low')).toContain('已锁定')
  await stepT1($, 1)
  const rows = scriptByPoll(2, 'fix and rerun', '3 passed')
  await appendAll($, rows)
  await stepT1($, 2)

  // The note would claim high while the steps go out at the lock.
  for (const r of rows) expect(reached(w, r)).toEqual(r)
  expect(asked(w)).toHaveLength(1)
  expect(efforts(w)).toEqual(['medium', 'low', 'low'])
  expect(turnState(w)).toMatchObject({ pendingNote: NOTE_HIGH, journal: { workSteps: 2 }, midrun: { notes: 1 } })

  // Kept while locked: after an unlock in the same turn, the next row that can carry it does.
  expect(await dp($, 'unlock')).toContain('已解锁')
  const after = scriptByPoll(3, 'rerun', '3 passed')
  await appendAll($, after)
  await stepT1($, 3)
  const receipt = after.find((r) => r.origin.kind === 'tool' && r.origin.tool === 'REPL')!
  expect(reached(w, receipt)!.message.content).toEqual([receipt.message.content[0], noteBlock(NOTE_HIGH)])
  expect(turnState(w)).toMatchObject({ pendingNote: null, wanted: 'high', midrun: { notes: 1 } })
  expect(efforts(w)).toEqual(['medium', 'low', 'low', 'high'])
})

test('计数：到检查点清零，没到时数工作步和脚本结果', { options: { ...KEYS, midrunEverySteps: 3 } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, HOLD) })
  await begin($)
  const seen: [number, TurnState['midrun']][] = []
  for (const n of [1, 2, 3, 4]) {
    // A reply and a reminder between the steps are no work steps.
    await appendAll($, [assistantText(`Step ${n} next.`), assistantToolUse('Read'), toolResult('Read', `r${n}`), attachmentRow('output_style', 'Concise.')])
    seen.push([asked(w).length, turnState(w).midrun])
  }
  expect(seen).toEqual([
    [0, { notes: 0, lastShiftAt: null, stepsSinceCheck: 1, scriptsSinceCheck: 0 }],
    [0, { notes: 0, lastShiftAt: null, stepsSinceCheck: 2, scriptsSinceCheck: 0 }],
    [1, { notes: 0, lastShiftAt: null, stepsSinceCheck: 0, scriptsSinceCheck: 0 }],
    [1, { notes: 0, lastShiftAt: null, stepsSinceCheck: 1, scriptsSinceCheck: 0 }],
  ])
})

test('这一轮没有档位（模型不收 effort）：没有检查点，记录照记', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, SAME_FAILURE) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0 })
  const rows = [...scriptByPoll(1, 'rerun the upload test', 'FAIL test_upload'), promptRow('also the docs')]
  await appendAll($, rows)
  await step($, { turnId: 't1', index: 1 })

  expect(asked(w)).toHaveLength(0)
  for (const r of rows) expect(reached(w, r)).toEqual(r)
  expect(turnState(w)).toMatchObject({ base: null, wanted: null, journal: { workSteps: 1, scriptResults: 1 } })
  expect(efforts(w)).toEqual([undefined, undefined])
  expect(midruns(w)).toHaveLength(0)
})

test('agent 的行、queue 行、attachment 行、空的和只有 repl-status 的 delivery 行原样放行，不计数', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, HOLD) })
  await begin($)
  await appendAll($, scriptByPoll(1, 'scan', 'r1'))
  expect(asked(w)).toHaveLength(1)
  const writes = w.stateWrites.length
  const agent = (e: SessionAppendInput): SessionAppendInput => ({ ...e, agentId: 'agent-1' })
  const quiet = [
    agent(assistantToolUse('REPL', { description: 'agent script' })),
    agent(replReceipt(7)),
    agent(pollResult(7, 'agent result')),
    agent(toolResult('Bash', 'boom', { error: true })),
    agent(promptRow('the agent was asked this')),
    queueRow(1, 'r1'),
    attachmentRow('output_style', 'Concise output style is active.'),
    attachmentRow('prompt_snapshot'),
    emptyDelivery(),
    deliveryEvent('repl-status', '#2 still running'),
    innerToolUse('Read', { file_path: '/a' }),
  ]
  await appendAll($, quiet)
  for (const r of quiet) expect(reached(w, r)).toEqual(r)
  // Not one state write, not one request.
  expect(w.stateWrites.slice(writes)).toEqual([])
  expect(asked(w)).toHaveLength(1)
  // The next script is the second the turn counts.
  await appendAll($, scriptByPoll(2, 'scan again', 'r2'))
  expect(asked(w)).toHaveLength(2)
  expect(asked(w)[1]!.body.state).toMatchObject({ steps_so_far: 2, latest: { result: 'r2' } })
})

test('这一轮自己的 prompt 行在 turn.start 之前到：不算新输入', { options: KEYS }, async ($, on) => {
  let n = 0
  const own: SessionAppendInput[] = []
  const w = world(on, {
    answer: answers(SUBMIT_HOLD, HOLD),
    onSubmit: async (e) => {
      if (e.turnId !== undefined) return undefined
      // The engine appends the prompt's row and its reminders inside prompt.submit, before turn.start (real-rows.md).
      const rows = [promptRow(e.text), attachmentRow('date', "Today's date is 2026-11-18.")]
      own.push(...rows)
      await appendAll($, rows)
      return turnStart($, `t${++n}`, e.text)
    },
  })
  await begin($)
  expect(asked(w)).toHaveLength(0)
  await appendAll($, scriptByPoll(1, 'scan', 'r1'))
  expect(asked(w)).toHaveLength(1)
  await complete($, 't1')
  await submit($, 'Now the downloader')
  await step($, { turnId: 't2', index: 0, effort: 'medium' })
  expect(asked(w)).toHaveLength(1)
  for (const r of own) expect(reached(w, r)).toEqual(r)
  // A prompt row while the turn runs is input.
  await append($, promptRow('and the docs'))
  expect(asked(w)).toHaveLength(2)
  expect(asked(w)[1]!.body.state).toMatchObject({ request: 'Now the downloader', latest: { did: 'new input', result: 'and the docs' } })
})

test('说明用完之后：脚本结果和经 delivery 来的输入不发请求，prompt 行的新输入照样发，换挡不加说明', { options: { ...KEYS, midrunMaxNotes: 1 } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, (s) => (s.current_level === 'medium' ? SAME_FAILURE : CAUSE_FOUND)) })
  await begin($)
  for (let n = 1; n <= 4; n++) {
    await appendAll($, scriptByPoll(n, `script ${n}`, `r${n}`))
    await stepT1($, n)
  }
  expect(asked(w)).toHaveLength(1)
  // Input by delivery would need a note too: with none left it is no checkpoint.
  const notice = deliveryEvent('task-notification', 'agent-1 finished: the backoff is already configurable')
  await append($, notice)
  expect(asked(w)).toHaveLength(1)
  expect(reached(w, notice)).toEqual(notice)
  const typed = promptRow('The backoff is already configurable, just wire it up')
  await append($, typed)
  await stepT1($, 5)

  expect(asked(w)).toHaveLength(2)
  expect(reached(w, typed)).toEqual(typed)
  expect(midruns(w).map((d) => [d.step, d.from, d.to, d.reason, d.applied])).toEqual([
    [1, 'medium', 'high', 'same-failure', true],
    [4, 'high', 'medium', 'cause-found', true],
  ])
  expect(efforts(w)).toEqual(['medium', 'high', 'high', 'high', 'high', 'medium'])
  expect(turnState(w).midrun).toMatchObject({ notes: 1, lastShiftAt: 4 })
})

test('请求失败：行原样放行，记一条失败的决策', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: ({ body }) => ('same_failure' in body.questions ? null : drexOk(SUBMIT_HOLD)) })
  await begin($)
  const rows = scriptByPoll(1, 'rerun the upload test', 'FAIL test_upload')
  await appendAll($, rows)
  await stepT1($, 1)

  for (const r of rows) expect(reached(w, r)).toEqual(r)
  expect(asked(w)).toHaveLength(1)
  expect(efforts(w)).toEqual(['medium', 'medium'])
  expect(midruns(w)).toHaveLength(1)
  expect(midruns(w)[0]).toMatchObject({ from: 'medium', to: 'medium', reason: null, raw: null, failure: 'network', applied: false, detail: '连不上 Drex', turnId: 't1', step: 1 })
})

test('发出的中途 state：recent 从早到晚、latest、current_level、steps_so_far、failed_steps；没有打算时不带 stated_next', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, HOLD) })
  await begin($)
  await appendAll($, scriptByPoll(1, 'read the uploader', 'r1', { inner: [innerToolUse('Read'), innerCall('Read')] }))
  await appendAll($, scriptByPoll(2, 'run the tests', 'Error: 2 failed', { error: true }))
  await appendAll($, scriptByDelivery(3, 'read the test', 'r3'))
  const third = asked(w)[2]!.body.state
  expect(third).toEqual({
    note: third.note,
    request: TASK,
    current_level: 'medium',
    steps_so_far: 3,
    failed_steps: 1,
    recent: [
      { did: 'read the uploader', tools: ['REPL', 'Read'], outcome: 'ok', result: 'r1' },
      { did: 'run the tests', tools: ['REPL'], outcome: 'error', result: 'Error: 2 failed' },
    ],
    latest: { did: 'read the test', tools: ['REPL'], outcome: 'ok', result: 'r3' },
  })
  expect(typeof third.note).toBe('string')
  expect('stated_next' in third).toBe(false)
  // With a stated plan, it goes in.
  await appendAll($, [assistantText('Next I add a backoff to the retry.'), ...scriptByPoll(4, 'add backoff', 'r4')])
  expect(asked(w)[3]!.body.state.stated_next).toBe('Next I add a backoff to the retry.')
})

// A turn the message judgement did not set (controller ruling after Task 8): its base is the engine's own level at
// step 0, so it gets mid-run checks too.

for (const [name, options, origin] of [
  ['task-notification 开始的轮', KEYS, 'task-notification'],
  ['submitShift 关着', { ...KEYS, submitShift: false }, 'composer'],
] as const) {
  test(`没有发消息时的判断（${name}）：第 0 步的档就是起点，第一次脚本结果就是检查点，可以换挡`, { options }, async ($, on) => {
    const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, SAME_FAILURE) })
    await start($)
    await submit($, 'Background task finished: run the upload test again', { kind: origin })
    await stepT1($, 0)
    // Nothing was asked for the message; step 0 only notes the engine's level, records nothing, rewrites nothing.
    expect(w.fetched).toHaveLength(0)
    expect(turnState(w)).toMatchObject({ base: 'medium', wanted: null })
    expect(logged(w)).toHaveLength(0)

    const rows = scriptByPoll(1, 'rerun the upload test', 'FAIL test_upload')
    await appendAll($, rows)
    await stepT1($, 1)
    const poll = rows.find((r) => r.origin.kind === 'tool' && r.origin.tool === 'Poll')!
    expect(reached(w, poll)!.message.content).toEqual([poll.message.content[0], noteBlock(NOTE_HIGH)])
    expect(w.fetched).toHaveLength(1)
    expect(asked(w)[0]!.body.state.current_level).toBe('medium')
    expect(midruns(w)).toHaveLength(1)
    expect(midruns(w)[0]).toMatchObject({ from: 'medium', to: 'high', reason: 'same-failure', applied: true, step: 1, turnId: 't1' })
    expect(efforts(w)).toEqual(['medium', 'high'])
  })
}

test('没有发消息时的判断、步上的 effort 缺省或是数字：没有起点，也没有检查点', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, SAME_FAILURE) })
  await start($)
  for (const [turnId, effort] of [['t1', undefined], ['t2', 31999]] as const) {
    await submit($, `Background task ${turnId} finished`, { kind: 'task-notification' })
    await step($, { turnId, index: 0, ...(effort === undefined ? {} : { effort }) })
    const rows = scriptByPoll(turnId === 't1' ? 1 : 2, 'rerun the upload test', 'FAIL test_upload')
    await appendAll($, rows)
    for (const r of rows) expect(reached(w, r)).toEqual(r)
    expect(turnState(w)).toMatchObject({ turnId, base: null, wanted: null, journal: { workSteps: 1 } })
    await complete($, turnId)
  }
  expect(w.fetched).toHaveLength(0)
  expect(logged(w)).toHaveLength(0)
  expect(efforts(w)).toEqual([undefined, 31999])
})

// The pure parts, where the engine tests do not reach.

test('noteText、withNote：一行英文说明，加在 content 末尾，不改原来的行', () => {
  expect(noteText('xhigh', 'contradicts-plan')).toBe('[dispatch-pilot] effort is now xhigh: a result contradicts the plan.')
  const row = pollResult(1, 'ok')
  const copy = JSON.parse(JSON.stringify(row))
  const noted = withNote(row, 'note')
  expect(noted.message.content).toEqual([row.message.content[0], { type: 'text', text: 'note' }])
  expect(noted.uuid).toBe(row.uuid)
  expect(noted.door).toBe('tool-result')
  expect(row).toEqual(copy)
})

test('gapOk、notesLeft、carriesNote', () => {
  const j = (workSteps: number): TurnJournal => ({ ...emptyJournal(), workSteps })
  const m = (o: Partial<MidrunCounters>): MidrunCounters => ({ ...emptyCounters(), ...o })
  expect(emptyCounters()).toEqual({ notes: 0, lastShiftAt: null, stepsSinceCheck: 0, scriptsSinceCheck: 0 })
  expect([gapOk(m({}), j(0)), gapOk(m({ lastShiftAt: 2 }), j(4)), gapOk(m({ lastShiftAt: 2 }), j(5))]).toEqual([true, false, true])
  const cfg = readConfig({ midrunMaxNotes: 4 })
  expect([notesLeft(m({ notes: 1 }), cfg), notesLeft(m({ notes: 4 }), cfg), notesLeft(m({ notes: 6 }), cfg)]).toEqual([3, 0, 0])
  const kinds = ['receipt', 'script-result-poll', 'script-result-delivery', 'inner-call', 'tool-result', 'new-input', 'delivered-input', 'assistant', 'other'] as const
  expect(kinds.filter(carriesNote)).toEqual(['receipt', 'script-result-poll', 'tool-result'])
  expect(kinds.map(carrierOf)).toEqual(['row', 'row', 'queue', null, 'row', 'input', 'queue', null, null])
})

test('isCheckpoint：0 关掉按数的检查，失败成簇照样算；Code Mode 里普通结果行不算；说明用完只剩新输入', () => {
  const j = (o: Partial<TurnJournal> = {}): TurnJournal => ({ ...emptyJournal(), ...o })
  const fresh = emptyCounters()
  const off = readConfig({ midrunEverySteps: 0, midrunEveryScripts: 0 })
  expect(isCheckpoint('script-result-poll', j(), fresh, off, true)).toBe(false)
  expect(isCheckpoint('tool-result', j(), { ...fresh, stepsSinceCheck: 100 }, off, false)).toBe(false)
  expect(isCheckpoint('tool-result', j({ consecutiveFailures: 2 }), fresh, off, false)).toBe(true)
  expect(isCheckpoint('tool-result', j({ sameErrorRepeated: true }), fresh, off, false)).toBe(true)
  const on = readConfig({})
  // In Code Mode a refused REPL or another tool's result is no checkpoint, failing or not; a receipt never is.
  expect(isCheckpoint('tool-result', j({ consecutiveFailures: 3 }), fresh, on, true)).toBe(false)
  expect(isCheckpoint('receipt', j(), fresh, on, true)).toBe(false)
  expect(isCheckpoint('script-result-delivery', j(), fresh, on, true)).toBe(true)
  // Script results in an ordinary session (no receipt seen) are not counted as scripts.
  expect(isCheckpoint('script-result-poll', j(), fresh, on, false)).toBe(false)
  const spent = { ...fresh, notes: 4 }
  expect(isCheckpoint('script-result-poll', j(), spent, on, true)).toBe(false)
  expect(isCheckpoint('tool-result', j({ consecutiveFailures: 2 }), spent, on, false)).toBe(false)
  expect(isCheckpoint('new-input', j(), spent, on, true)).toBe(true)
  expect(isCheckpoint('new-input', j(), spent, off, false)).toBe(true)
  // Input by delivery is a checkpoint in both kinds of session, but needs a note like a result does.
  expect([isCheckpoint('delivered-input', j(), fresh, off, true), isCheckpoint('delivered-input', j(), fresh, off, false)]).toEqual([true, true])
  expect(isCheckpoint('delivered-input', j(), spent, on, true)).toBe(false)
})


test('applyShift：prompt 行的换挡清掉还排着的旧说明，不计条数', () => {
  const cfg = readConfig({})
  const OLD = '[dispatch-pilot] effort is now high: the same failure came back after a fix.'
  // A note queued for high at work step 1, not yet placed; four steps later the person's input asks for low.
  const turn: TurnState = { ...newTurn('t1', 'x'), wanted: 'high', pendingNote: OLD, journal: { ...emptyJournal(), workSteps: 5 }, midrun: { ...emptyCounters(), notes: 1, lastShiftAt: 1 } }
  const out = applyShift(turn, { to: 'low', note: null, queued: null }, { asked: 'high', cfg, locked: false })
  expect(out).toMatchObject({ wanted: 'low', pendingNote: null, midrun: { notes: 1, lastShiftAt: 5 } })
})

test('applyShift：后一条排着的说明替换前一条时只算一条；前面没有排着的才加一', () => {
  const cfg = readConfig({})
  const OLD = '[dispatch-pilot] effort is now high: the same failure came back after a fix.'
  const NEW = noteText('xhigh', 'contradicts-plan')
  const base: TurnState = { ...newTurn('t1', 'x'), wanted: 'high', journal: { ...emptyJournal(), workSteps: 5 }, midrun: { ...emptyCounters(), notes: 1, lastShiftAt: 1 } }
  const replaced = applyShift({ ...base, pendingNote: OLD }, { to: 'xhigh', note: null, queued: NEW }, { asked: 'high', cfg, locked: false })
  expect(replaced).toMatchObject({ wanted: 'xhigh', pendingNote: NEW, midrun: { notes: 1, lastShiftAt: 5 } })
  const fresh = applyShift({ ...base, pendingNote: null }, { to: 'xhigh', note: null, queued: NEW }, { asked: 'high', cfg, locked: false })
  expect(fresh).toMatchObject({ wanted: 'xhigh', pendingNote: NEW, midrun: { notes: 2, lastShiftAt: 5 } })
  // A note on the row itself, with nothing queued, is counted.
  const onRow = applyShift({ ...base, pendingNote: null }, { to: 'xhigh', note: NEW, queued: null }, { asked: 'high', cfg, locked: false })
  expect(onRow).toMatchObject({ wanted: 'xhigh', pendingNote: null, midrun: { notes: 2 } })
})
