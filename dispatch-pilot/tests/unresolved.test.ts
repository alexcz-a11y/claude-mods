// The unresolved count (#39): seam 1 (engine events in, what reaches the decision
// backend, `$.state` and the board out). Every message of the person's carries the
// three-way question in the effort request; its answer moves the count by two bars;
// the count lives in `$.state`.

import { expect, test } from 'claude-code/testing'
import { asClef, CLEF_OPTIONS, clefInputProblems } from './support/cloudflare.ts'
import { jev, world, type Sent } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }
/** What the decision model leans to, as shares of the question's three options. */
const SAYS = {
  still: { still_unresolved: 0.8, resolved: 0.05, new_or_unrelated: 0.15 },
  solved: { still_unresolved: 0.05, resolved: 0.85, new_or_unrelated: 0.1 },
  elsewhere: { still_unresolved: 0.05, resolved: 0.1, new_or_unrelated: 0.85 },
  unsure: { still_unresolved: 0.3, resolved: 0.4, new_or_unrelated: 0.3 },
} as const
type Says = keyof typeof SAYS

/** Jev answering the effort question with `levels` and the unresolved question as `said.now` says (changeable between messages). */
function backend(said: { now: Says }, levels: readonly number[] = [0.05, 0.1, 0.7, 0.1, 0.05]) {
  return (request: Sent) => jev(levels, { shares: { 'effort.unresolved': SAYS[said.now] } })(request)
}

const questionsOf = (request: Sent | undefined) => Object.keys(request?.body.questions ?? {})

test('a message of the person adds one to the count when the answer is "still unresolved"; it asks the question in the effort request', { options: KEY }, async ($, on) => {
  const said = { now: 'still' as Says }
  const w = world($, on, { backend: backend(said) })

  await w.submit('登录接口还是 502')
  expect(questionsOf(w.requests[0])).toEqual(['effort.level', 'effort.unresolved'])
  expect(w.requests[0]?.body.questions['effort.unresolved'].type).toBe('choice')
  expect(w.unresolved()).toBe(1)
  await w.submit('还是不行')
  expect(w.unresolved()).toBe(2)
  // The effort decision is made as before.
  await w.step({ index: 0 })
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
})

test('the count moves by two bars: "still unresolved" adds at 0.5, "resolved" or a new problem clears only at 0.7, anything short of both leaves it', { options: KEY }, async ($, on) => {
  let shares: Record<string, number> = SAYS.still
  const w = world($, on, { backend: (request) => jev([0.05, 0.1, 0.7, 0.1, 0.05], { shares: { 'effort.unresolved': shares } })(request) })
  const says = async (text: string, answer: Record<string, number>) => {
    shares = answer
    await w.submit(text)
    return w.unresolved()
  }

  expect(await says('还是 502', { still_unresolved: 0.5, resolved: 0.2, new_or_unrelated: 0.3 })).toBe(1)
  expect(await says('还是 502 啊', { still_unresolved: 0.5, resolved: 0.2, new_or_unrelated: 0.3 })).toBe(2)
  // Not enough for either bar: the count stays, whichever way it leans.
  expect(await says('嗯', SAYS.unsure)).toBe(2)
  expect(await says('好像好了？', { still_unresolved: 0.1, resolved: 0.6, new_or_unrelated: 0.3 })).toBe(2)
  // The lower bar adds even when "resolved" is not far behind; the higher one clears.
  expect(await says('好了，谢谢', { still_unresolved: 0.1, resolved: 0.7, new_or_unrelated: 0.2 })).toBe(0)
  expect(await says('再看一次', SAYS.still)).toBe(1)
  expect(await says('换个话题：给 README 加个徽章', SAYS.elsewhere)).toBe(0)
})

test('the count is in $.state: a hot reload keeps it (the next message goes on from it)', { options: KEY }, async ($, on) => {
  const said = { now: 'still' as Says }
  const w = world($, on, { backend: backend(said), seed: { unresolved: { count: 2 } } })
  await w.submit('还是不行')
  expect(w.unresolved()).toBe(3)
})

test('/clear and a new session start the count over; /compact keeps it', { options: KEY }, async ($, on) => {
  const said = { now: 'still' as Says }
  const w = world($, on, { backend: backend(said), session: true })
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
})

test('a hand-back or a task notice that starts a turn is not asked and does not touch the count; a message typed into a running turn counts', { options: KEY }, async ($, on) => {
  const said = { now: 'still' as Says }
  const w = world($, on, { backend: backend(said) })
  await w.submit('登录接口还是 502')
  await w.step({ index: 0 })
  expect(w.unresolved()).toBe(1)

  await w.complete()
  await w.submit('<agent-message from="a1">tests pass, 3 files changed</agent-message>', { origin: { kind: 'peer' } })
  await w.complete()
  await w.submit('Background task "lint" completed', { origin: { kind: 'task-notification' } })
  // Their requests carry the effort question alone, and the count stays.
  expect(w.requests.slice(1).map(questionsOf)).toEqual([['effort.level'], ['effort.level']])
  expect(w.unresolved()).toBe(1)

  // Typed into a turn that runs: the person's own message all the same.
  await w.submit('还是不行，同样的报错', { turnId: 't3' })
  expect(questionsOf(w.requests.at(-1))).toEqual(['effort.level', 'effort.unresolved'])
  expect(w.unresolved()).toBe(2)
})

test('a command turn counts like a message; a locked effort or one the person named does not stop the counting', { options: KEY }, async ($, on) => {
  const said = { now: 'still' as Says }
  const w = world($, on, { backend: backend(said), session: true, skills: { commands: [{ name: 'implement', description: 'Implement an issue.', source: 'user' }], listed: [] } })
  await w.start()
  await w.slash('implement', '#19')
  expect(w.unresolved()).toBe(1)
  expect(questionsOf(w.requests.at(-1))).toContain('effort.unresolved')

  await w.command('dp', 'lock max')
  await w.submit('还是不行')
  expect(w.unresolved()).toBe(2)
  await w.step({ index: 0, effort: 'low' })
  expect(w.steps.at(-1)?.effort).toBe('max')

  await w.command('dp', 'unlock')
  await w.submit('effort 拉到 high，再来一次')
  expect(w.unresolved()).toBe(3)
})

test('/dp unresolved off: the question is not asked and the count stays; on again, it goes on from where it was', { options: KEY }, async ($, on) => {
  const said = { now: 'still' as Says }
  const w = world($, on, { backend: backend(said), session: true, store: {} })
  await w.start()
  await w.submit('还是不行')
  expect(w.unresolved()).toBe(1)

  expect(await w.command('dp', 'unresolved off')).toMatch(/unresolved/)
  expect(w.stored('switches')).toEqual({ unresolved: false })
  await w.submit('还是不行')
  expect(questionsOf(w.requests.at(-1))).toEqual(['effort.level'])
  expect(w.unresolved()).toBe(1)
  // The effort decision is made as before.
  await w.step({ index: 0 })
  expect(w.steps.at(-1)?.effort).toBe('high')

  await w.command('dp', 'unresolved on')
  expect(w.stored('switches')).toEqual({})
  await w.submit('还是不行')
  expect(w.unresolved()).toBe(2)
})

test('Clef: the question is asked in English within its input rules, and its answer moves the count the same way', { options: CLEF_OPTIONS }, async ($, on) => {
  const said = { now: 'still' as Says }
  const w = world($, on, { backend: asClef(backend(said)) })
  await w.submit('登录接口还是 502')
  expect(questionsOf(w.requests[0])).toEqual(['effort.level', 'effort.unresolved'])
  expect(clefInputProblems(w.requests[0]?.body)).toEqual([])
  expect(JSON.stringify(w.requests[0]?.body.questions['effort.unresolved'].instructions)).not.toMatch(/[一-鿿]/)
  expect(w.unresolved()).toBe(1)
  said.now = 'solved'
  await w.submit('好了，谢谢')
  expect(w.unresolved()).toBe(0)
})

test('the effort and the count are answered separately: a request that fails moves nothing; an answer missing for one leaves the other', { options: KEY }, async ($, on) => {
  const said = { now: 'still' as Says }
  let reply: 'ok' | 'down' | 'no-unresolved' | 'no-effort' = 'ok'
  const w = world($, on, {
    backend: (request) => {
      if (reply === 'down') return { status: 503, body: 'overloaded' }
      const answered = backend(said)(request)
      if (reply === 'ok' || !('body' in answered)) return answered
      const body = answered.body as { answers: Record<string, unknown> }
      delete body.answers[reply === 'no-unresolved' ? 'effort.unresolved' : 'effort.level']
      return answered
    },
  })

  reply = 'down'
  await w.submit('第一条')
  expect(w.unresolved()).toBe(0)
  expect((await w.board()).main).toMatchObject({ routed: false, failure: { kind: 'busy' } })

  // No answer to the count question: the effort is decided, the count stays.
  reply = 'no-unresolved'
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
