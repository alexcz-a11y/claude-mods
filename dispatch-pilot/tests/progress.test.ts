import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteInput, ModelCompleteResult } from 'claude-code'

import { readConfig } from '../hooks/config.ts'
import type { Decision } from '../hooks/log.ts'
import { followCall, nextFlight, parseProgress, progressPrompt, readCompletion } from '../hooks/progress.ts'
import type { ProgressInput, ProgressOutcome } from '../hooks/progress.ts'
import type { SessionState, TurnState } from '../hooks/state.ts'
import { estimateTokens } from '../hooks/statebuild.ts'
import { assistantToolUse, promptRow, scriptByPoll } from './support/rows.ts'
import { KEYS, appendAll, complete, dp, drexOk, noul, score, start, step, submit, turns, world } from './support/world.ts'

type World = ReturnType<typeof world>

const ON = { ...KEYS, progressNote: true }
const SYSTEM = 'You keep a short progress note on a coding task. Reply with one JSON object and nothing else: {"done": string, "remaining": string, "cause_known": boolean}. "done" and "remaining" are one sentence each. Report only what the results show.'
const TASK = 'Fix the flaky retry in the uploader'

// What the mod recorded and wrote, and what reached the engine.
const logged = (w: World): Decision[] => (w.storeWrites.filter((s) => s.key === 'log').at(-1)?.value ?? []) as Decision[]
const ofKind = (w: World, kind: Decision['kind']): Decision[] => logged(w).filter((d) => d.kind === kind)
const session = (w: World): SessionState => w.stateWrites.filter((s) => s.key === 'session' && s.isSet).at(-1)?.value as SessionState
const turnState = (w: World): TurnState => w.stateWrites.filter((s) => s.key === 'turn' && s.isSet).at(-1)?.value as TurnState
/** The mid-run requests to Drex (the message's own has no same_failure question), and the state each carried. */
const asked = (w: World) => w.fetched.filter((f) => 'same_failure' in f.body.questions)
const states = (w: World): any[] => asked(w).map((f) => f.body.state)
/** The parsed prompt of the n-th progress call. */
const promptOf = (w: World, n: number): any => JSON.parse(w.completes[n]!.prompt)

// The message holds at medium; every mid-run check holds too, so nothing but the notes changes between tests.
const SUBMIT_HOLD = { open: score([0.05, 0.3, 0.3, 0.3, 0.05]), mechanical: noul(0.1), unknown_cause: noul(0.2) }
const HOLD = { open: score([0.05, 0.3, 0.3, 0.3, 0.05]), same_failure: noul(0.1), cause_found: noul(0.2), only_carrying_out: noul(0.2), contradicts_plan: noul(0.1) }
function answers({ body }: { body: any }): string {
  if ('same_failure' in body.questions) return drexOk(HOLD)
  return drexOk('continues' in body.questions ? { ...SUBMIT_HOLD, continues: noul(0.1) } : SUBMIT_HOLD)
}

const NOTE_A = { done: 'Reproduced the failing upload test.', remaining: 'Find why the retry fires twice.', cause_known: false }
const NOTE_B = { done: 'Found the double timer in the retry loop.', remaining: 'Remove one timer and rerun the tests.', cause_known: true }
const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const apiError = (status: number | null): ModelCompleteResult => ({ isAnswered: false, reason: 'api-error', status, error: 'unknown', usage }) as ModelCompleteResult
const TIMED_OUT = { isAnswered: false, reason: 'aborted', usage } as ModelCompleteResult

/** Answers the n-th progress call (from 0) with what `replies` holds for it; past the end, the last one. */
function replies(list: (string | ModelCompleteResult | null)[]) {
  let n = 0
  return (_e: ModelCompleteInput) => list[Math.min(n++, list.length - 1)]!
}

async function begin($: Engine) {
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
}

/** Script n of turn t1 in Code Mode (checked at its Poll row), then the step after it. */
async function script($: Engine, w: World, n: number, result = `result ${n}`, turnId = 't1') {
  const rows = scriptByPoll(n, `script ${n}`, result)
  await appendAll($, rows)
  await w.clock.settle()
  await step($, { turnId, index: n, effort: 'medium' })
  return rows
}

// The brief's eight.

test('parseProgress：纯 JSON、前后带话的 JSON、缺字段、过长的字符串', () => {
  expect(parseProgress(JSON.stringify(NOTE_A))).toEqual(NOTE_A)
  // Words around it, a fence, a brace inside a string, and a brace before it that opens no JSON.
  const wrapped = 'Here is the note {draft}:\n```json\n{"done": "Read {upload.ts}.", "remaining": "Fix it.", "cause_known": true}\n```\nDone.'
  expect(parseProgress(wrapped)).toEqual({ done: 'Read {upload.ts}.', remaining: 'Fix it.', cause_known: true })
  expect(parseProgress('{"done": "a", "remaining": "b"}')).toBeNull()
  expect(parseProgress('{"done": "a", "remaining": "b", "cause_known": "yes"}')).toBeNull()
  expect(parseProgress('{"done": 1, "remaining": "b", "cause_known": true}')).toBeNull()
  expect(parseProgress('no note today')).toBeNull()
  // The first object, wherever it sits.
  expect(parseProgress('[{"done": "a", "remaining": "b", "cause_known": true}]')).toEqual({ done: 'a', remaining: 'b', cause_known: true })
  const long = 'HEAD ' + 'word '.repeat(400) + 'TAIL'
  const clipped = parseProgress(JSON.stringify({ done: long, remaining: long, cause_known: false }))!
  expect(clipped.cause_known).toBe(false)
  for (const s of [clipped.done, clipped.remaining]) {
    expect(estimateTokens(s)).toBeLessThanOrEqual(60)
    expect(s.startsWith('HEAD')).toBe(true)
    expect(s.endsWith('TAIL')).toBe(true)
    expect(s).toContain(' … ')
  }
})

test('开着时：第一个检查点的请求里没有 progress；记录写好后，下一个检查点的 state.progress 有三个字段', { options: ON }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers, complete: replies([JSON.stringify(NOTE_A), JSON.stringify(NOTE_B)]) })
  await begin($)
  await script($, w, 1, 'FAIL test_upload: expected 200, got 500')
  expect(asked(w)).toHaveLength(1)
  expect('progress' in states(w)[0]).toBe(false)
  // One call, made after the first checkpoint, exactly as design 5.13 asks.
  expect(w.completes).toHaveLength(1)
  expect(w.completes[0]).toMatchObject({ model: 'haiku', effort: 'low', maxTokens: 200, timeoutMs: 8000, system: SYSTEM })
  expect(promptOf(w, 0)).toEqual({
    request: TASK,
    previous_note: null,
    latest_step: { did: 'script 1', tools: ['REPL'], outcome: 'ok', result: 'FAIL test_upload: expected 200, got 500' },
  })

  await script($, w, 2, 'found a second timer')
  expect(states(w)[1].progress).toEqual(NOTE_A)
  // The next call carries the note it replaces.
  expect(w.completes).toHaveLength(2)
  expect(promptOf(w, 1)).toEqual({ request: TASK, previous_note: NOTE_A, latest_step: { did: 'script 2', tools: ['REPL'], outcome: 'ok', result: 'found a second timer' } })

  // The second call answered at once: its note was written on the first main-loop row after that checkpoint.
  expect(turnState(w).progress).toEqual(NOTE_B)
  await script($, w, 3)
  expect(states(w)[2].progress).toEqual(NOTE_B)
  // A note that was written records nothing.
  expect(ofKind(w, 'progress')).toEqual([])
  expect(ofKind(w, 'midrun')).toHaveLength(3)
})

test('hook 不等记录写完：model.complete 的桩还挂着时，这一行已经返回', { options: ON }, async ($, on) => {
  const w: World = world(on, {
    onSubmit: turns($),
    answer: answers,
    complete: async () => {
      await w.clock.sleep(60_000)
      return JSON.stringify(NOTE_A)
    },
  })
  await begin($)
  const rows = scriptByPoll(1, 'script 1', 'result 1')
  // Every row reached the engine, as it came, while the call is still out.
  await appendAll($, rows)
  expect(w.appended.slice(-rows.length)).toEqual(rows)
  expect(w.completes).toHaveLength(1)
  expect(asked(w)).toHaveLength(1)
  expect(turnState(w).progress).toBeNull()
  await step($, { turnId: 't1', index: 1, effort: 'medium' })
  expect(w.stepsSent.map((s) => s.effort)).toEqual(['medium', 'medium'])

  // Once the call comes back, the next main-loop row writes the note, and the next checkpoint carries it.
  await w.clock.advance(60_000)
  await w.clock.settle()
  await script($, w, 2)
  expect(turnState(w).progress).toEqual(NOTE_A)
  expect(states(w)[1].progress).toEqual(NOTE_A)
})

test('上一次还在途时不并发：第二个检查点不发新的调用，在途的回来后才发', { options: ON }, async ($, on) => {
  let calls = 0
  const w: World = world(on, {
    onSubmit: turns($),
    answer: answers,
    complete: async () => {
      calls += 1
      if (calls === 1) await w.clock.sleep(60_000)
      return JSON.stringify(calls === 1 ? NOTE_A : NOTE_B)
    },
  })
  await begin($)
  await script($, w, 1)
  await script($, w, 2, 'second result')
  // Two checkpoints, one call: the second waits behind the first.
  expect(asked(w)).toHaveLength(2)
  expect(w.completes).toHaveLength(1)

  await w.clock.advance(60_000)
  await w.clock.settle()
  // The next main-loop row reads the first note and starts the waiting call, with that note as its previous one.
  await appendAll($, [assistantToolUse('REPL', { code: 'await $`ls`', description: 'script 3' })])
  await w.clock.settle()
  expect(turnState(w).progress).toEqual(NOTE_A)
  expect(w.completes).toHaveLength(2)
  expect(promptOf(w, 1)).toEqual({ request: TASK, previous_note: NOTE_A, latest_step: { did: 'script 2', tools: ['REPL'], outcome: 'ok', result: 'second result' } })
})

test('回答不是三个字段：保留旧记录，记一条 progress 的失败', { options: ON }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers, complete: replies([JSON.stringify(NOTE_A), 'Sorry, I cannot summarise this.', JSON.stringify(NOTE_B)]) })
  await begin($)
  await script($, w, 1)
  await script($, w, 2)
  expect(turnState(w).progress).toEqual(NOTE_A)
  await script($, w, 3)
  // The second reply was no note: the first one stands, and the third checkpoint still asks with it.
  expect(states(w).map((s) => s.progress ?? null)).toEqual([null, NOTE_A, NOTE_A])
  // The third call's prompt was given the note that stood.
  expect(promptOf(w, 2).previous_note).toEqual(NOTE_A)
  const failed = ofKind(w, 'progress')
  expect(failed).toHaveLength(1)
  expect(failed[0]).toMatchObject({
    kind: 'progress',
    backend: null,
    model: 'haiku',
    raw: null,
    from: null,
    to: null,
    reason: null,
    bars: null,
    detail: '回答不是三个字段',
    failure: 'bad-answer',
    requestId: null,
    applied: false,
    sent: null,
    turnId: 't1',
    step: 2,
  })
  // The session goes on calling: the third checkpoint started a call.
  expect(w.completes).toHaveLength(3)
  expect(session(w).progressBlocked).toBe(false)
})

test('模型被拒绝（api-error 403）：这个会话不再调', { options: ON }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers, complete: replies([apiError(403)]) })
  await begin($)
  await script($, w, 1)
  await script($, w, 2)
  await script($, w, 3)
  await script($, w, 4)
  expect(session(w).progressBlocked).toBe(true)
  expect(w.completes).toHaveLength(1)
  const failed = ofKind(w, 'progress')
  expect(failed).toHaveLength(1)
  expect(failed[0]).toMatchObject({ kind: 'progress', model: 'haiku', detail: '模型被拒绝：HTTP 403', failure: 'http', applied: false, turnId: 't1', step: 1 })
  // The mid-run checks go on unchanged: each script was asked about, with no progress field, and every step went at medium.
  expect(asked(w)).toHaveLength(4)
  expect(states(w).every((s) => !('progress' in s))).toBe(true)
  expect(w.stepsSent.map((s) => s.effort)).toEqual(['medium', 'medium', 'medium', 'medium', 'medium'])
  // Still blocked in the next turn.
  await complete($, 't1')
  await submit($, 'Now the downloader')
  await step($, { turnId: 't2', index: 0, effort: 'medium' })
  await script($, w, 1, 'r', 't2')
  expect(asked(w)).toHaveLength(5)
  expect(w.completes).toHaveLength(1)
})

// The user's decision of 2026-11-19: on by default, so a session with no option set writes the notes.
test('默认开：不设任何选项，每个检查点之后都写一次进展记录，下一个检查点带着它', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers, complete: replies([JSON.stringify(NOTE_A)]) })
  await begin($)
  await script($, w, 1)
  await script($, w, 2)
  expect(asked(w)).toHaveLength(2)
  expect(w.completes).toHaveLength(2)
  expect('progress' in states(w)[0]).toBe(false)
  expect(states(w)[1].progress).toEqual(NOTE_A)
  expect(readConfig({}).progressNote).toBe(true)
})

test('progressNote 关：一次 model.complete 都没有', { options: { ...KEYS, progressNote: false } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers, complete: replies([JSON.stringify(NOTE_A)]) })
  await begin($)
  await script($, w, 1)
  await script($, w, 2)
  expect(asked(w)).toHaveLength(2)
  expect(w.completes).toEqual([])
  expect(states(w).every((s) => !('progress' in s))).toBe(true)
  expect(turnState(w).progress).toBeNull()
})

test('新的一轮开始时记录清空', { options: ON }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers, complete: replies([JSON.stringify(NOTE_A), JSON.stringify(NOTE_B)]) })
  await begin($)
  await script($, w, 1)
  await script($, w, 2)
  expect(turnState(w).progress).toEqual(NOTE_B)
  await complete($, 't1')
  await submit($, 'Now the downloader')
  expect(turnState(w)).toMatchObject({ turnId: 't2', progress: null })
  await step($, { turnId: 't2', index: 0, effort: 'medium' })
  await script($, w, 1, 'r', 't2')
  // t2's first checkpoint has no note, and its call starts from none.
  expect(states(w).at(-1)).toMatchObject({ request: 'Now the downloader' })
  expect('progress' in states(w).at(-1)).toBe(false)
  expect(w.completes).toHaveLength(3)
  expect(promptOf(w, 2)).toMatchObject({ request: 'Now the downloader', previous_note: null })
  // t2's own note, from its own call (the third), lands on the row after its checkpoint.
  expect(turnState(w)).toMatchObject({ turnId: 't2', progress: NOTE_B })
})

// What the eight do not reach.

test('在途时排着的只留最新的一份', { options: ON }, async ($, on) => {
  let calls = 0
  const w: World = world(on, {
    onSubmit: turns($),
    answer: answers,
    complete: async () => {
      calls += 1
      if (calls === 1) await w.clock.sleep(60_000)
      return JSON.stringify(calls === 1 ? NOTE_A : NOTE_B)
    },
  })
  await begin($)
  await script($, w, 1)
  await script($, w, 2, 'second result')
  await script($, w, 3, 'third result')
  expect(asked(w)).toHaveLength(3)
  expect(w.completes).toHaveLength(1)
  await w.clock.advance(60_000)
  await w.clock.settle()
  await script($, w, 4, 'fourth result')
  // On script 4's first row the first note is read and the newest input waiting (script 3's) is sent, with that
  // note; script 2's is gone. That call answers at once, so script 4's own checkpoint finds none in the air.
  expect(promptOf(w, 1)).toEqual({ request: TASK, previous_note: NOTE_A, latest_step: { did: 'script 3', tools: ['REPL'], outcome: 'ok', result: 'third result' } })
  expect(w.completes.map((c) => JSON.parse(c.prompt).latest_step.did)).toEqual(['script 1', 'script 3', 'script 4'])
  expect(w.completes.map((c) => JSON.parse(c.prompt).previous_note)).toEqual([null, NOTE_A, NOTE_B])
  expect(states(w).map((s) => s.progress ?? null)).toEqual([null, null, null, NOTE_B])
})

test('上一轮的调用在这一轮回来：丢掉，什么都不记；这一轮的第一个检查点排在它后面', { options: ON }, async ($, on) => {
  let calls = 0
  const w: World = world(on, {
    onSubmit: turns($),
    answer: answers,
    complete: async () => {
      calls += 1
      if (calls === 1) {
        await w.clock.sleep(60_000)
        return 'not a note'
      }
      return JSON.stringify(NOTE_B)
    },
  })
  await begin($)
  await script($, w, 1)
  await complete($, 't1')
  await submit($, 'Now the downloader')
  await step($, { turnId: 't2', index: 0, effort: 'medium' })
  await script($, w, 1, 'r', 't2')
  // t1's call is still out: t2's first checkpoint waits behind it.
  expect(asked(w)).toHaveLength(2)
  expect(w.completes).toHaveLength(1)
  await w.clock.advance(60_000)
  await w.clock.settle()
  await appendAll($, [assistantToolUse('REPL', { code: 'x', description: 'script 2' })])
  await w.clock.settle()
  // t1's reply (a failure) was dropped: no note on t2, nothing recorded; t2's call went out from no note.
  expect(turnState(w)).toMatchObject({ turnId: 't2', progress: null })
  expect(ofKind(w, 'progress')).toEqual([])
  expect(w.completes).toHaveLength(2)
  expect(promptOf(w, 1)).toEqual({ request: 'Now the downloader', previous_note: null, latest_step: { did: 'script 1', tools: ['REPL'], outcome: 'ok', result: 'r' } })
  await script($, w, 2, 'r2', 't2')
  expect(turnState(w).progress).toEqual(NOTE_B)
})

test('上一轮排着的输入在新一轮开始时清掉：在途的回来后不为它发调用', { options: ON }, async ($, on) => {
  const w: World = world(on, {
    onSubmit: turns($),
    answer: answers,
    complete: async () => {
      await w.clock.sleep(60_000)
      return JSON.stringify(NOTE_A)
    },
  })
  await begin($)
  await script($, w, 1)
  await script($, w, 2)
  // Script 2's input waits behind script 1's call when t1 ends.
  expect(asked(w)).toHaveLength(2)
  expect(w.completes).toHaveLength(1)
  await complete($, 't1')
  await submit($, 'Now the downloader')
  await step($, { turnId: 't2', index: 0, effort: 'medium' })
  await w.clock.advance(60_000)
  await w.clock.settle()
  const rows = [assistantToolUse('REPL', { code: 'x', description: 'script 1' })]
  await appendAll($, rows)
  await w.clock.settle()
  // The call came back in t2: dropped, and t1's waiting input was cleared at turn.start, so no call is made for it.
  expect(w.appended.at(-1)).toEqual(rows[0])
  expect(w.completes).toHaveLength(1)
  expect(turnState(w)).toMatchObject({ turnId: 't2', progress: null })
  expect(ofKind(w, 'progress')).toEqual([])
})

test('超时（aborted，不是拒绝）：保留旧记录，记一条失败，会话不封', { options: ON }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers, complete: replies([JSON.stringify(NOTE_A), TIMED_OUT, JSON.stringify(NOTE_B)]) })
  await begin($)
  await script($, w, 1)
  await script($, w, 2)
  await script($, w, 3)
  await script($, w, 4)
  expect(states(w).map((s) => s.progress ?? null)).toEqual([null, NOTE_A, NOTE_A, NOTE_B])
  expect(ofKind(w, 'progress')).toHaveLength(1)
  expect(ofKind(w, 'progress')[0]).toMatchObject({ kind: 'progress', model: 'haiku', detail: '没有在时限内写完', failure: 'timeout', applied: false, turnId: 't1', step: 2 })
  expect(w.completes).toHaveLength(4)
  expect(session(w).progressBlocked).toBe(false)
})

test('api-error：400、403、404 封掉，429、500、没有回应不封；引擎拒绝调用（reject）也封', () => {
  const refusedBy = (r: ModelCompleteResult | null) => readCompletion(r)
  for (const status of [400, 403, 404]) {
    expect(refusedBy(apiError(status))).toEqual({ note: null, refused: true, failure: 'http', detail: `模型被拒绝：HTTP ${status}` })
  }
  for (const status of [401, 429, 500, 529]) {
    expect(refusedBy(apiError(status))).toEqual({ note: null, refused: false, failure: 'http', detail: `HTTP ${status}` })
  }
  expect(refusedBy(apiError(null))).toEqual({ note: null, refused: false, failure: 'network', detail: '没有收到回答' })
  expect(refusedBy(TIMED_OUT)).toEqual({ note: null, refused: false, failure: 'timeout', detail: '没有在时限内写完' })
  expect(refusedBy({ isAnswered: false, reason: 'empty-reply', usage } as ModelCompleteResult)).toEqual({ note: null, refused: false, failure: 'bad-answer', detail: '回答不是三个字段' })
  expect(refusedBy(null)).toEqual({ note: null, refused: true, failure: 'http', detail: '引擎拒绝了这个模型' })
  expect(refusedBy({ isAnswered: true, text: JSON.stringify(NOTE_A), usage } as ModelCompleteResult)).toEqual({ note: NOTE_A, refused: false, failure: null, detail: '' })
})

test('api-error 500：记一条失败，下一个检查点照样调', { options: ON }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers, complete: replies([apiError(500), JSON.stringify(NOTE_A)]) })
  await begin($)
  await script($, w, 1)
  await script($, w, 2)
  await script($, w, 3)
  expect(session(w).progressBlocked).toBe(false)
  expect(ofKind(w, 'progress')).toEqual([expect.objectContaining({ detail: 'HTTP 500', failure: 'http', step: 1 })])
  expect(w.completes).toHaveLength(3)
  expect(states(w)[2].progress).toEqual(NOTE_A)
})

test('引擎拒绝调用（reject）：记一条失败，这个会话不再调', { options: ON }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers, complete: replies([null]) })
  await begin($)
  await script($, w, 1)
  await script($, w, 2)
  await script($, w, 3)
  expect(session(w).progressBlocked).toBe(true)
  expect(w.completes).toHaveLength(1)
  expect(ofKind(w, 'progress')).toEqual([expect.objectContaining({ detail: '引擎拒绝了这个模型', failure: 'http', step: 1 })])
  expect(asked(w)).toHaveLength(3)
})

test('shadow：检查点照样评估，也写记录（校准要比较）', { options: { ...ON, mode: 'shadow' } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers, complete: replies([JSON.stringify(NOTE_A)]) })
  await begin($)
  await script($, w, 1)
  await script($, w, 2)
  expect(w.completes).toHaveLength(2)
  expect(w.completes[0]).toMatchObject({ model: 'haiku', effort: 'low' })
  expect(states(w)[1].progress).toEqual(NOTE_A)
  expect(turnState(w).progress).toEqual(NOTE_A)
})

test('/dp lock：没有检查点，也不调', { options: ON }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers, complete: replies([JSON.stringify(NOTE_A)]) })
  await begin($)
  expect(await dp($, 'lock high')).toContain('已锁定')
  await script($, w, 1)
  await script($, w, 2)
  expect(asked(w)).toEqual([])
  expect(w.completes).toEqual([])
  // The steps went at the lock, and the journal still counted them.
  expect(w.stepsSent.map((s) => s.effort)).toEqual(['medium', 'high', 'high'])
  expect(turnState(w).journal.workSteps).toBe(2)
})

test('nextFlight：在途时只排最新的；关着或封了就什么都不发、不排', () => {
  const input = (n: number): ProgressInput => ({ turnId: 't1', request: 'r', latest: { did: `s${n}`, tools: [], ok: true, result: '' } })
  const base = { on: true, blocked: false, busy: false, queued: null, fresh: null, turnId: 't1' }
  expect(nextFlight({ ...base, fresh: input(1) })).toEqual({ start: input(1), queue: null })
  expect(nextFlight({ ...base, busy: true, fresh: input(2), queued: input(1) })).toEqual({ start: null, queue: input(2) })
  expect(nextFlight({ ...base, busy: true, queued: input(1) })).toEqual({ start: null, queue: input(1) })
  expect(nextFlight({ ...base, queued: input(1) })).toEqual({ start: input(1), queue: null })
  expect(nextFlight({ ...base, blocked: true, fresh: input(1), queued: input(2) })).toEqual({ start: null, queue: null })
  expect(nextFlight({ ...base, on: false, fresh: input(1) })).toEqual({ start: null, queue: null })
  // A waiting input of another turn, or with no turn held, is dropped.
  expect(nextFlight({ ...base, turnId: null, queued: input(1) })).toEqual({ start: null, queue: null })
  expect(nextFlight({ ...base, turnId: 't2', queued: input(1) })).toEqual({ start: null, queue: null })
  expect(nextFlight({ ...base, turnId: 't2', busy: true, queued: input(1) })).toEqual({ start: null, queue: null })
})

test('followCall：没有发出（同步抛错）不封；reject 封；回答的形状认不出时记失败，照样结束', async () => {
  const seen: ProgressOutcome[] = []
  const done = (o: ProgressOutcome) => seen.push(o)
  followCall(null, done)
  followCall(Promise.reject(new Error('blocked model')), done)
  followCall(Promise.resolve(undefined as unknown as ModelCompleteResult), done)
  followCall(Promise.resolve({ isAnswered: true, text: JSON.stringify(NOTE_A), usage } as ModelCompleteResult), done)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  expect(seen).toEqual([
    { note: null, refused: false, failure: 'network', detail: '没有发出调用' },
    { note: null, refused: true, failure: 'http', detail: '引擎拒绝了这个模型' },
    { note: null, refused: false, failure: 'bad-answer', detail: '回答不是三个字段' },
    { note: NOTE_A, refused: false, failure: null, detail: '' },
  ])
})

test('调用回来的东西认不出（undefined）：记一条失败，不卡住，下一个检查点照样调', { options: ON }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers, complete: replies([undefined as unknown as string, JSON.stringify(NOTE_A)]) })
  await begin($)
  await script($, w, 1)
  await script($, w, 2)
  await script($, w, 3)
  expect(ofKind(w, 'progress')).toEqual([expect.objectContaining({ detail: '回答不是三个字段', failure: 'bad-answer', step: 1 })])
  expect(session(w).progressBlocked).toBe(false)
  expect(w.completes).toHaveLength(3)
  expect(states(w)[2].progress).toEqual(NOTE_A)
})

test('上一轮结束时一个在途、一个排着；在途的在 turn.complete 之后回来，下一条消息的 prompt 行不发调用，t2 的第一个检查点马上发自己的', { options: ON }, async ($, on) => {
  let calls = 0
  const w: World = world(on, {
    onSubmit: turns($),
    answer: answers,
    complete: async () => {
      calls += 1
      if (calls === 1) await w.clock.sleep(60_000)
      return JSON.stringify(calls === 1 ? NOTE_A : NOTE_B)
    },
  })
  await begin($)
  await script($, w, 1)
  await script($, w, 2)
  expect(w.completes).toHaveLength(1)
  await complete($, 't1')
  await w.clock.advance(60_000)
  await w.clock.settle()
  // The next message's own row comes before its turn.start: it reads the settled call (dropped) and starts nothing.
  const prompt = promptRow('Now the downloader')
  await appendAll($, [prompt])
  await w.clock.settle()
  expect(w.appended.at(-1)).toEqual(prompt)
  expect(w.completes).toHaveLength(1)
  await submit($, 'Now the downloader')
  await step($, { turnId: 't2', index: 0, effort: 'medium' })
  await script($, w, 1, 'r', 't2')
  expect(w.completes).toHaveLength(2)
  expect(promptOf(w, 1)).toEqual({ request: 'Now the downloader', previous_note: null, latest_step: { did: 'script 1', tools: ['REPL'], outcome: 'ok', result: 'r' } })
  expect(ofKind(w, 'progress')).toEqual([])
})

test('progressPrompt：request 和 result 各截到 400 token，结果头尾都在', () => {
  const long = 'HEAD ' + 'x'.repeat(5000) + ' TAIL'
  const p = progressPrompt({ request: long, previous: NOTE_A, latest: { did: 'run tests', tools: ['Bash'], ok: false, result: long } })
  expect(p.system).toBe(SYSTEM)
  const body = JSON.parse(p.prompt)
  expect(Object.keys(body)).toEqual(['request', 'previous_note', 'latest_step'])
  expect(body.previous_note).toEqual(NOTE_A)
  expect(body.latest_step).toMatchObject({ did: 'run tests', tools: ['Bash'], outcome: 'error' })
  for (const s of [body.request, body.latest_step.result]) {
    expect(estimateTokens(s)).toBeLessThanOrEqual(400)
    expect(s.startsWith('HEAD')).toBe(true)
    expect(s.endsWith('TAIL')).toBe(true)
  }
})
