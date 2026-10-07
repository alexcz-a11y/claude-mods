// The strong hint (#41): seam 1 (engine events in; what reaches the decision backend, the decision log and the card
// out). A message of the person's, and a mid-turn re-decision, read the problem summary, the count and, once the count
// reaches `unresolvedMaxAfter`, a hint in the effort question; a dispatched agent reads the first two and no hint. The
// effort is still the decision model's to pick (ADR 0005): no rule here depends on the count.

import { expect, test } from 'claude-code/testing'
import { renderSummary } from '../hooks/decision/summary.ts'
import { COUNT_FIELD } from '../hooks/decision/unresolved.ts'
import { jev, world, type Reply, type Sent } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }
const HIGH = [0.05, 0.1, 0.7, 0.1, 0.05]
const MAX = [0, 0, 0.1, 0.1, 0.8]

const SUMMARY = { problem: '登录接口返回 502', tried: [{ text: '把超时调到 30 秒', unresolved: true as const }, { text: '重启 nginx' }], status: '助手在等新的日志', turn: 't1' }
/** What the decision model reads of the summary, in the language the effort questions are written in (Chinese with Jev). */
const WORDS = renderSummary(SUMMARY, 'zh')

const UNSURE = { still_unresolved: 0.3, resolved: 0.4, new_or_unrelated: 0.3 }
const STILL = { still_unresolved: 0.8, resolved: 0.05, new_or_unrelated: 0.15 }

const effortOf = (request: Sent | undefined) => request?.body.questions['effort.level']
/** The keys of the effort question's instructions: one more when the hint is given. */
const instructionKeys = (request: Sent | undefined): string[] => Object.keys(effortOf(request)?.instructions ?? {})

/** Jev answering with `levels` and the unresolved question as `shares` (the count does not move on an unsure answer). */
function backend(levels: readonly number[] = HIGH, shares: Record<string, number> = UNSURE) {
  return (request: Sent) => jev(levels, { shares: { 'effort.unresolved': shares } })(request)
}

test('the effort request of a message carries the summary and the count; the hint comes once the count has reached unresolvedMaxAfter (default 3), not before', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(), seed: { unresolved: { count: 2, summary: SUMMARY } } })
  await w.submit('还是不行')
  const before = w.requests[0]
  expect(before?.body.state[COUNT_FIELD]).toBe(2)
  expect(before?.body.state.problem_summary).toBe(WORDS)
  expect(instructionKeys(before)).toEqual(['问题', '评什么', '简短回复'])
})

test('three times unresolved: the next message\'s effort question has one more instruction, and the count of 3 goes along', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(), seed: { unresolved: { count: 3, summary: SUMMARY } } })
  await w.submit('还是不行')
  const request = w.requests[0]
  expect(request?.body.state[COUNT_FIELD]).toBe(3)
  expect(instructionKeys(request)).toEqual(['问题', '评什么', '简短回复', '未解决'])
  expect(JSON.stringify(effortOf(request)?.instructions)).toContain(COUNT_FIELD)
  // The three-way question is not hinted.
  expect(JSON.stringify(request?.body.questions['effort.unresolved'])).not.toContain(COUNT_FIELD)
})

test('no count and no summary until a message said "still unresolved"; the first unresolved message\'s own request has none either (it is not known yet)', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(HIGH, STILL) })
  await w.submit('登录接口返回 502')
  expect(w.requests[0]?.body.state).not.toHaveProperty(COUNT_FIELD)
  expect(w.requests[0]?.body.state).not.toHaveProperty('problem_summary')
  await w.complete()
  await w.submit('还是不行')
  // The count is one now, and goes along; no hint at 1.
  expect(w.requests[1]?.body.state[COUNT_FIELD]).toBe(1)
  expect(instructionKeys(w.requests[1])).toEqual(instructionKeys(w.requests[0]))
})

for (const [maxAfter, count, hinted] of [
  [1, 1, true],
  [1, 0, false],
  [5, 4, false],
  [5, 5, true],
  [0, 9, false],
  // The setting reads as 10 at the most.
  [50, 9, false],
  [50, 10, true],
] as const) {
  test(`unresolvedMaxAfter ${maxAfter}, count ${count}: ${hinted ? 'the hint is given' : 'no hint'}`, { options: { ...KEY, unresolvedMaxAfter: maxAfter } }, async ($, on) => {
    const w = world($, on, { backend: backend(), seed: { unresolved: { count } } })
    await w.submit('还是不行')
    const keys = instructionKeys(w.requests[0])
    expect(keys.includes('未解决')).toBe(hinted)
  })
}

test('with the unresolved switch off the effort request still goes alone but has no summary, no count and no hint', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(), session: true, seed: { unresolved: { count: 5, summary: SUMMARY } } })
  await w.start()
  await w.command('dp', 'unresolved off')
  await w.submit('还是不行')
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['effort.level'])
  expect(w.requests[0]?.body.state).not.toHaveProperty(COUNT_FIELD)
  expect(w.requests[0]?.body.state).not.toHaveProperty('problem_summary')
  expect(instructionKeys(w.requests[0]).includes('未解决')).toBe(false)
  expect((await w.board()).log.some((entry) => entry.hint !== undefined)).toBe(false)
})

test('a report that starts a turn is no word of the person\'s: no count, no summary, no hint in its request', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(), seed: { unresolved: { count: 5, summary: SUMMARY } } })
  await w.submit('<agent-message from="a1">tests pass</agent-message>', { origin: { kind: 'peer' } })
  expect(w.requests[0]?.body.state).not.toHaveProperty(COUNT_FIELD)
  expect(instructionKeys(w.requests[0]).includes('未解决')).toBe(false)
})

test('the hint changes no rule: the level is the decision model\'s, with or without it (max still needs thetaMax)', { options: KEY }, async ($, on) => {
  // The decision model leans to max at 0.4: under thetaMax 0.5 the level is the next one down, hint or no hint.
  const lean = [0, 0, 0.1, 0.5, 0.4]
  const w = world($, on, { backend: backend(lean), seed: { unresolved: { count: 6, summary: SUMMARY } } })
  await w.submit('还是不行')
  await w.step({ index: 0 })
  expect(instructionKeys(w.requests[0]).includes('未解决')).toBe(true)
  expect(w.steps.map((s) => s.effort)).toEqual(['xhigh'])
})

test('and when the decision model does answer max with the hint given, the turn goes out at max', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MAX), seed: { unresolved: { count: 6, summary: SUMMARY } } })
  await w.submit('还是不行')
  await w.step({ index: 0 })
  expect(w.steps.map((s) => s.effort)).toEqual(['max'])
})

test('a mid-turn request carries the summary and the count, and the hint once the count has reached the threshold', { options: KEY }, async ($, on) => {
  const answers = (request: Sent): Reply => (Object.keys(request.body.questions).includes('midturn.level') ? jev(MAX)(request) : backend()(request))
  const w = world($, on, { backend: answers, seed: { unresolved: { count: 3, summary: SUMMARY } } })
  await w.submit('还是不行')
  const step = (index: number) => ({ index, answer: `第 ${index} 步`, tools: [{ tool: 'Read', input: { file_path: `/repo/src/f${index}.ts` } }] })
  await w.step(step(0))
  await w.step(step(1))
  await w.step(step(2))

  const mid = w.requests.find((request) => 'midturn.level' in request.body.questions)
  expect(mid?.body.state[COUNT_FIELD]).toBe(3)
  // Worded in the language the mid-turn question is asked in (English unless set otherwise).
  expect(mid?.body.state.problem_summary).toBe(renderSummary(SUMMARY, 'en'))
  expect(Object.keys(mid?.body.questions['midturn.level'].instructions)).toContain('unsolved')
})

test('a mid-turn request below the threshold has the summary and the count but no hint', { options: KEY }, async ($, on) => {
  const answers = (request: Sent): Reply => (Object.keys(request.body.questions).includes('midturn.level') ? jev(HIGH)(request) : backend()(request))
  const w = world($, on, { backend: answers, seed: { unresolved: { count: 2, summary: SUMMARY } } })
  await w.submit('还是不行')
  const step = (index: number) => ({ index, answer: `第 ${index} 步`, tools: [{ tool: 'Read', input: { file_path: `/repo/src/f${index}.ts` } }] })
  await w.step(step(0))
  await w.step(step(1))
  await w.step(step(2))

  const mid = w.requests.find((request) => 'midturn.level' in request.body.questions)
  expect(mid?.body.state[COUNT_FIELD]).toBe(2)
  expect(Object.keys(mid?.body.questions['midturn.level'].instructions)).not.toContain('unsolved')
})

test('a dispatched agent\'s request carries the summary and the count and no hint, however high the count is', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: (request) => jev([0, 0, 1, 0, 0], { shares: { 'agent.model': { sonnet: 1 }, 'effort.unresolved': UNSURE } })(request), seed: { unresolved: { count: 6, summary: SUMMARY } } })
  await w.submit('还是不行，让它去查一下日志')
  await w.spawn({ prompt: 'Read app.log and report the last error.', description: 'Read the log' })
  const agent = w.requests.find((request) => 'agent.model' in request.body.questions)
  expect(agent?.body.state[COUNT_FIELD]).toBe(6)
  expect(agent?.body.state.problem_summary).toBe(renderSummary(SUMMARY, 'en'))
  expect(JSON.stringify(agent?.body.questions)).not.toContain(COUNT_FIELD)
  expect(JSON.stringify(agent?.body.questions)).not.toMatch(/unsolved|未解决/)
})

test('a dispatched agent\'s request has neither while the unresolved switch is off', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: (request) => jev([0, 0, 1, 0, 0], { shares: { 'agent.model': { sonnet: 1 }, 'effort.unresolved': UNSURE } })(request), session: true, seed: { unresolved: { count: 6, summary: SUMMARY } } })
  await w.start()
  await w.command('dp', 'unresolved off')
  await w.submit('让它去查一下日志')
  await w.spawn({ prompt: 'Read app.log and report the last error.', description: 'Read the log' })
  const agent = w.requests.find((request) => 'agent.model' in request.body.questions)
  expect(agent?.body.state).not.toHaveProperty(COUNT_FIELD)
  expect(agent?.body.state).not.toHaveProperty('problem_summary')
})

test('each time the hint is given the decision log gets an entry: the count, that it was given, the level the decision model came to; the card says so; the board has no new event', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(MAX), seed: { unresolved: { count: 3, summary: SUMMARY } } })
  await w.submit('还是不行')
  await w.step({ index: 0 })

  const { log } = await w.board()
  const hinted = log.filter((entry) => entry.hint !== undefined && entry.feature === 'unresolved')
  expect(hinted).toHaveLength(1)
  expect(hinted[0]).toMatchObject({ agent: 'main', effort: 'max', outcome: '已给强提示（次数 3）', hint: { count: 3, maxAfter: 3 } })
  expect(hinted[0]?.reason).toContain('max')
  // The effort decision itself carries it for the card.
  expect(log.find((entry) => entry.feature === 'main-effort')?.hint).toEqual({ count: 3, maxAfter: 3 })

  const ui = await w.pane()
  expect(JSON.stringify(await ui.find({ key: 'pane-card-hint' }))).toContain('已给强提示')
  // The log's row for it says so, with the level.
  const rows = (await ui.findAll({ type: 'Box' })).filter((box) => box.key?.startsWith('pane-entry-')).map((box) => JSON.stringify(box))
  expect(rows.some((row) => row.includes('给了强提示') && row.includes('次数 3'))).toBe(true)

  // The band draws nothing of it.
  const band = await w.band()
  expect((await band.findAll({ type: 'Box' })).map((box) => JSON.stringify(box)).join('\n')).not.toContain('强提示')
})

test('a message below the threshold leaves no hint entry and no row on the card', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: backend(), seed: { unresolved: { count: 2, summary: SUMMARY } } })
  await w.submit('还是不行')
  await w.step({ index: 0 })
  const { log } = await w.board()
  expect(log.some((entry) => entry.hint !== undefined)).toBe(false)
  expect(await (await w.pane()).find({ key: 'pane-card-hint' })).toBeUndefined()
})

test('a mid-turn re-decision that was given the hint is in the log too, with the level the decision model answered', { options: KEY }, async ($, on) => {
  const answers = (request: Sent): Reply => (Object.keys(request.body.questions).includes('midturn.level') ? jev(MAX)(request) : backend()(request))
  const w = world($, on, { backend: answers, seed: { unresolved: { count: 3, summary: SUMMARY } } })
  await w.submit('还是不行')
  const step = (index: number) => ({ index, answer: `第 ${index} 步`, tools: [{ tool: 'Read', input: { file_path: `/repo/src/f${index}.ts` } }] })
  await w.step(step(0))
  await w.step(step(1))
  await w.step(step(2))
  await w.step(step(3))

  const { log } = await w.board()
  // One for the message, one for the re-decision.
  const hinted = log.filter((entry) => entry.feature === 'unresolved' && entry.hint !== undefined)
  expect(hinted.map((entry) => entry.hint?.where ?? 'start')).toEqual(['start', 'mid'])
  expect(hinted[1]).toMatchObject({ outcome: '已给强提示（次数 3）', effort: 'max' })
})

