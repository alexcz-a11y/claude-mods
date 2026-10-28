// The unresolved count (#39, ADR 0014): seam 1 (engine events in, what reaches the
// decision backend, `$.state` and the board out). Every message of the person's
// carries three Nouls about the problem in the effort request (still failing,
// solved, a new task); their answers move the count; the count lives in `$.state`
// and is kept whatever the switches say. The summary has a switch of its own.

import { expect, test } from 'claude-code/testing'
import { jev, KEY, type Sent, UNRESOLVED_ON, world } from './support/world.ts'

/** What the decision model says of the problem, by the Nouls' ids in the request. */
const said = (still: number, solved: number, task: number) => ({ 'effort.still_failing': still, 'effort.solved': solved, 'effort.new_task': task })
const SAYS = {
  still: said(0.85, 0.05, 0.1),
  solved: said(0.05, 0.85, 0.1),
  elsewhere: said(0.05, 0.1, 0.85),
  unsure: said(0.5, 0.4, 0.3),
} as const
type Says = keyof typeof SAYS

const HIGH = [0.05, 0.1, 0.7, 0.1, 0.05]
const ABOUT_THE_PROBLEM = ['effort.still_failing', 'effort.solved', 'effort.new_task']

/** Jev answering the effort question with `levels` and the Nouls about the problem as `now.says` says (changeable between messages). */
function backend(now: { says: Says }, levels: readonly number[] = HIGH) {
  return (request: Sent) => jev(levels, { nouls: SAYS[now.says] })(request)
}

const questionsOf = (request: Sent | undefined) => Object.keys(request?.body.questions ?? {})

test('a message of the person asks the three Nouls about the problem in the effort request; "still failing" adds one to the count', { options: KEY }, async ($, on) => {
  const now = { says: 'still' as Says }
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(now) })

  await w.submit('登录接口还是 502')
  for (const id of ABOUT_THE_PROBLEM) {
    expect(questionsOf(w.requests[0])).toContain(id)
    expect(w.requests[0]?.body.questions[id].type).toBe('noul')
  }
  expect(w.unresolved()).toBe(1)
  await w.submit('还是不行')
  expect(w.unresolved()).toBe(2)
  // The count is a fact of the state from then on, not a question.
  expect(w.requests[1]?.body.state.unresolved_count).toBe(1)
  // The effort decision is made as before: under unresolvedMaxAfter (3) the count lifts nothing.
  await w.step({ index: 0 })
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
})

test('the count moves by the Nouls: still failing yes adds; solved yes, or a new task with still failing no, clears; anything else keeps it', { options: KEY }, async ($, on) => {
  let nouls: Record<string, number> = SAYS.still
  const w = world($, on, { switches: UNRESOLVED_ON, backend: (request) => jev(HIGH, { nouls })(request) })
  const says = async (text: string, answer: Record<string, number>) => {
    nouls = answer
    await w.submit(text)
    return w.unresolved()
  }

  expect(await says('还是 502', said(0.7, 0.2, 0.3))).toBe(1)
  expect(await says('还是 502 啊', said(0.9, 0.1, 0.1))).toBe(2)
  // In the band (between 0.3 and 0.7): the count stays, whichever way it leans.
  expect(await says('嗯', SAYS.unsure)).toBe(2)
  expect(await says('好像好了？', said(0.1, 0.6, 0.3))).toBe(2)
  // Another task while the old one may still fail: the count stands.
  expect(await says('顺便给 README 加个徽章', said(0.5, 0.1, 0.9))).toBe(2)
  // Solved clears it.
  expect(await says('好了，谢谢', said(0.1, 0.7, 0.2))).toBe(0)
  expect(await says('再看一次', SAYS.still)).toBe(1)
  // Another task, the old one not said to fail: cleared.
  expect(await says('换个话题：给 README 加个徽章', SAYS.elsewhere)).toBe(0)
})

test('the count is in $.state: a hot reload keeps it (the next message goes on from it)', { options: KEY }, async ($, on) => {
  const now = { says: 'still' as Says }
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(now), seed: { unresolved: { count: 1 } } })
  await w.submit('还是不行')
  expect(w.unresolved()).toBe(2)
})

test('/clear and a new session start the count over; /compact keeps it', { options: KEY }, async ($, on) => {
  const now = { says: 'still' as Says }
  const w = world($, on, { backend: backend(now), session: true })
  await w.start()
  await w.submit('还是不行')
  await w.submit('还是不行')
  expect(w.unresolved()).toBe(2)

  await w.compact()
  expect(w.unresolved()).toBe(2)
  await w.submit('还是不行')
  expect(w.unresolved()).toBe(3)

  await w.clear()
  expect(w.unresolved()).toBe(0)
  await w.submit('还是不行')
  expect(w.unresolved()).toBe(1)

  // The session ends for good (quit, resume elsewhere): the next one starts from 0, as after a /clear.
  await w.end('prompt_input_exit')
  expect(w.unresolved()).toBe(0)
})

test("a hand-back or a task notice that starts a turn is asked only what is not about the person's words, and does not touch the count; a message typed into a running turn counts", { options: KEY }, async ($, on) => {
  const now = { says: 'still' as Says }
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(now) })
  await w.submit('登录接口还是 502')
  await w.step({ index: 0 })
  expect(w.unresolved()).toBe(1)

  await w.complete()
  await w.submit('<agent-message from="a1">tests pass, 3 files changed</agent-message>', { origin: { kind: 'peer' } })
  await w.complete()
  await w.submit('Background task "lint" completed', { origin: { kind: 'task-notification' } })
  // Their requests carry the effort question, the stakes and the unknown cause; the count stays and is not in their state.
  const report = ['effort.level', 'effort.stakes.undo', 'effort.stakes.live', 'effort.stakes.access', 'effort.cause_unknown']
  expect(w.requests.slice(1).map(questionsOf)).toEqual([report, report])
  expect(w.requests.slice(1).map((request) => 'unresolved_count' in request.body.state)).toEqual([false, false])
  expect(w.unresolved()).toBe(1)

  // Typed into a turn that runs: the person's own message all the same.
  await w.submit('还是不行，同样的报错', { turnId: 't3' })
  expect(questionsOf(w.requests.at(-1))).toEqual(expect.arrayContaining(ABOUT_THE_PROBLEM))
  expect(w.unresolved()).toBe(2)
})

test('a command turn counts like a message; a locked effort or one the person named does not stop the counting', { options: KEY }, async ($, on) => {
  const now = { says: 'still' as Says }
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(now), skills: { commands: [{ name: 'implement', description: 'Implement an issue.', source: 'user' }], listed: [] } })
  await w.slash('implement', '#19')
  expect(w.unresolved()).toBe(1)
  expect(questionsOf(w.requests.at(-1))).toEqual(expect.arrayContaining(ABOUT_THE_PROBLEM))

  await w.command('dp', 'lock low')
  await w.submit('还是不行')
  expect(w.unresolved()).toBe(2)
  await w.step({ index: 0, effort: 'high' })
  expect(w.steps.at(-1)?.effort).toBe('low')

  await w.command('dp', 'unlock')
  await w.submit('effort 拉到 high，再来一次')
  expect(w.unresolved()).toBe(3)
})

for (const set of [true, false]) {
  test(`the count has no switch: a setting kept under the old name (unresolved ${set ? 'on' : 'off'}) changes nothing, and /dp lists no such switch`, { options: KEY }, async ($, on) => {
    const w = world($, on, { backend: backend({ says: 'still' }), session: true, store: { switches: { unresolved: set } } })
    await w.start()
    await w.submit('还是不行')
    expect(questionsOf(w.requests[0])).toEqual(expect.arrayContaining(ABOUT_THE_PROBLEM))
    expect(w.unresolved()).toBe(1)
    const status = await w.command('dp', 'status')
    expect(status).toMatch(/开\s+summary/)
    expect(status).not.toMatch(/[开关]\s+unresolved/)
  })
}

test('the effort and the count are answered separately: a request that fails moves nothing; answers missing for one leave the other', { options: KEY }, async ($, on) => {
  const now = { says: 'still' as Says }
  let reply: 'ok' | 'down' | 'no-problem' | 'no-effort' = 'ok'
  const w = world($, on, {
    switches: UNRESOLVED_ON,
    backend: (request) => {
      if (reply === 'down') return { status: 503, body: 'overloaded' }
      const answered = backend(now)(request)
      if (reply === 'ok' || !('body' in answered)) return answered
      const body = answered.body as { answers: Record<string, unknown> }
      for (const id of reply === 'no-problem' ? ABOUT_THE_PROBLEM : ['effort.level']) delete body.answers[id]
      return answered
    },
  })

  reply = 'down'
  await w.submit('第一条')
  expect(w.unresolved()).toBe(0)
  expect((await w.board()).main).toMatchObject({ routed: false, failure: { kind: 'busy' } })

  // No answer about the problem: the effort is decided, the count stays.
  reply = 'no-problem'
  await w.submit('第二条')
  expect(w.unresolved()).toBe(0)
  expect((await w.board()).main).toMatchObject({ routed: true })
  expect((await w.board()).log.filter((entry) => entry.feature === 'unresolved')).toEqual([])

  // No answer to the effort question: the turn is not routed, the count still moves.
  reply = 'no-effort'
  await w.submit('第三条')
  expect(w.unresolved()).toBe(1)
  expect((await w.board()).main).toMatchObject({ routed: false, failure: { kind: 'parse' } })
})

// ---- rule R5: the count reaching unresolvedMaxAfter ----------------------------------

test('a message still failing once the count, with it, reaches unresolvedMaxAfter goes out at max; 0 never does', { options: { ...KEY, unresolvedMaxAfter: 2 } }, async ($, on) => {
  const now = { says: 'still' as Says }
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(now) })
  await w.submit('还是不行')
  await w.step({ index: 0 })
  await w.complete()
  // The second "still failing" makes the count 2: max, and the trace says which rule lifted it.
  await w.submit('还是不行，同样的报错')
  await w.step({ index: 0 })
  expect(w.steps.map((s) => s.effort)).toEqual(['high', 'max'])
  const decided = (await w.board()).log.filter((entry) => entry.feature === 'main-effort').at(-1)
  expect(decided?.trace?.find((step) => step.rule === 'unresolved-count')).toMatchObject({ applied: true, level: 'max', count: 2, maxAfter: 2 })
})

test('with unresolvedMaxAfter 0 the count lifts nothing, however high it is', { options: { ...KEY, unresolvedMaxAfter: 0 } }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend({ says: 'still' }), seed: { unresolved: { count: 9 } } })
  await w.submit('还是不行')
  await w.step({ index: 0 })
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  expect(w.unresolved()).toBe(10)
})

// ---- the summary's switch -----------------------------------------------------------

test('/dp summary off stops the summary being written and sent; the count goes on; on again, the summary is written again', { options: KEY }, async ($, on) => {
  const now = { says: 'still' as Says }
  const reply = JSON.stringify({ problem: 'Login returns 502', tried: ['raised the timeout'], status: 'waiting for the log' })
  const w = world($, on, { backend: backend(now), session: true, store: {}, model: () => ({ text: reply }) })
  await w.start()
  // On by default: the turn's summary is written, and the next message carries it.
  expect(await w.command('dp', 'status')).toMatch(/开\s+summary/)
  await w.submit('登录接口还是 502')
  await w.complete()
  await w.clock.settle()
  expect(w.completions).toHaveLength(1)
  await w.submit('还是不行')
  // As it stood when the message was sent: its own "still failing" marks the last try after the request.
  expect(w.requests.at(-1)?.body.state.problem_summary).toEqual({ problem: 'Login returns 502', tried: [{ text: 'raised the timeout', unresolved: false }], status: 'waiting for the log' })

  expect(await w.command('dp', 'summary off')).toMatch(/summary/)
  await w.complete()
  await w.clock.settle()
  // Nothing more is written, and none goes in the state; the count still moves.
  expect(w.completions).toHaveLength(1)
  await w.submit('还是不行')
  expect(w.requests.at(-1)?.body.state).not.toHaveProperty('problem_summary')
  expect(w.requests.at(-1)?.body.state.unresolved_count).toBe(2)
  expect(w.unresolved()).toBe(3)

  await w.command('dp', 'summary on')
  await w.complete()
  await w.clock.settle()
  expect(w.completions).toHaveLength(2)
})
