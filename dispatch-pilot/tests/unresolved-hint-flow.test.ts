// The strong hint (#41): seam 1 (engine events in; what reaches the decision backend, the decision log and the card
// out). A message of the person's, and a mid-turn re-decision, read the problem summary, the count and, once the count
// reaches `unresolvedMaxAfter`, the strong hint; a dispatched agent reads the first two and no hint. At a message the hint
// is a second effort question (`effort.level_unsolved`) beside the unchanged `effort.level`, and its answer is the one used
// only when the same request's three-way answer says the problem is still unresolved; a mid-turn re-decision carries the hint
// in `midturn.level` itself. The effort is still the decision model's to pick (ADR 0005): the one rule the hint touches is
// max's threshold (hintThetaMax, for an answer to a hinted question).

import { expect, test } from 'claude-code/testing'
import { BACKEND_DEFAULTS } from '../hooks/core/setup.ts'
import { renderSummary } from '../hooks/decision/summary.ts'
import { COUNT_FIELD } from '../hooks/decision/unresolved.ts'
import { jev, KEY, type Reply, type Sent, UNRESOLVED_ON, world } from './support/world.ts'

const HIGH = [0.05, 0.1, 0.7, 0.1, 0.05]
const MAX = [0, 0, 0.1, 0.1, 0.8]

const SUMMARY = { problem: '登录接口返回 502', tried: [{ text: '把超时调到 30 秒', unresolved: true as const }, { text: '重启 nginx' }], status: '助手在等新的日志', turn: 't1' }
/** What the decision model reads of the summary, in the language the effort questions are written in (Chinese with Jev). */
const WORDS = renderSummary(SUMMARY, 'zh')

const UNSURE = { still_unresolved: 0.3, resolved: 0.4, new_or_unrelated: 0.3 }
const STILL = { still_unresolved: 0.8, resolved: 0.05, new_or_unrelated: 0.15 }
const SOLVED = { still_unresolved: 0.05, resolved: 0.85, new_or_unrelated: 0.1 }
const ELSEWHERE = { still_unresolved: 0.05, resolved: 0.1, new_or_unrelated: 0.85 }

const effortOf = (request: Sent | undefined) => request?.body.questions['effort.level']
/** The keys of the effort question's instructions: never the hint's, which is in the hinted copy of the question. */
const instructionKeys = (request: Sent | undefined): string[] => Object.keys(effortOf(request)?.instructions ?? {})
/** The hinted copy of the effort question the request carries beside the plain one, once the count has reached the threshold. */
const hintedOf = (request: Sent | undefined) => request?.body.questions['effort.level_unsolved']
const hintedKeys = (request: Sent | undefined): string[] => Object.keys(hintedOf(request)?.instructions ?? {})
/** Whether the request gave the strong hint. */
const given = (request: Sent | undefined): boolean => hintedOf(request) !== undefined

/**
 * Jev answering with `levels` and the unresolved question as `shares` (the count does not move on an unsure answer).
 * `hinted`: what it answers the hinted copy of the effort question where that differs from `levels`.
 */
function backend(levels: readonly number[] = HIGH, shares: Record<string, number> = UNSURE, hinted?: readonly number[]) {
  return (request: Sent) => jev(levels, { shares: { 'effort.unresolved': shares }, ...(hinted === undefined ? {} : { scores: { 'effort.level_unsolved': hinted } }) })(request)
}

test('the effort request of a message carries the summary and the count; the hint comes once the count has reached unresolvedMaxAfter (default 3), not before', { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(), seed: { unresolved: { count: 2, summary: SUMMARY } } })
  await w.submit('还是不行')
  const before = w.requests[0]
  expect(before?.body.state[COUNT_FIELD]).toBe(2)
  expect(before?.body.state.problem_summary).toBe(WORDS)
  expect(instructionKeys(before)).toEqual(['问题', '评什么', '简短回复'])
})

test('three times unresolved: the next request has a second effort question with one more instruction, effort.level stays what it was, and the count of 3 goes along', { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(), seed: { unresolved: { count: 3, summary: SUMMARY } } })
  await w.submit('还是不行')
  const request = w.requests[0]
  expect(request?.body.state[COUNT_FIELD]).toBe(3)
  expect(Object.keys(request?.body.questions)).toEqual(['effort.level', 'effort.unresolved', 'effort.level_unsolved'])
  // The hint is in the copy only; effort.level has the instructions it has without the hint.
  expect(instructionKeys(request)).toEqual(['问题', '评什么', '简短回复'])
  expect(hintedKeys(request)).toEqual(['问题', '评什么', '简短回复', '未解决'])
  expect(JSON.stringify(effortOf(request)?.instructions)).not.toContain(COUNT_FIELD)
  expect(JSON.stringify(hintedOf(request)?.instructions)).toContain(COUNT_FIELD)
  // The three-way question is not hinted.
  expect(JSON.stringify(request?.body.questions['effort.unresolved'])).not.toContain(COUNT_FIELD)
})

test('effort.level is byte for byte the one of the message before the hint: the message that takes the count to 3 and the one after it differ in the second question and the count only', { options: KEY }, async ($, on) => {
  // Count 2 -> this message is still unresolved -> 3 -> the next message gets the hint.
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(HIGH, STILL), seed: { unresolved: { count: 2, summary: SUMMARY } } })
  await w.submit('还是不行')
  await w.complete()
  await w.submit('还是不行')
  expect(given(w.requests[0])).toBe(false)
  expect(given(w.requests[1])).toBe(true)
  expect(w.requests[1]?.body.state[COUNT_FIELD]).toBe(3)
  expect(JSON.stringify(effortOf(w.requests[1]))).toBe(JSON.stringify(effortOf(w.requests[0])))
  expect(JSON.stringify(w.requests[1]?.body.questions['effort.unresolved'])).toBe(JSON.stringify(w.requests[0]?.body.questions['effort.unresolved']))
})

test('no count and no summary until a message said "still unresolved"; the first unresolved message\'s own request has none either (it is not known yet)', { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(HIGH, STILL) })
  await w.submit('登录接口返回 502')
  expect(w.requests[0]?.body.state).not.toHaveProperty(COUNT_FIELD)
  expect(w.requests[0]?.body.state).not.toHaveProperty('problem_summary')
  await w.complete()
  await w.submit('还是不行')
  // The count is one now, and goes along; no hint at 1.
  expect(w.requests[1]?.body.state[COUNT_FIELD]).toBe(1)
  expect(instructionKeys(w.requests[1])).toEqual(instructionKeys(w.requests[0]))
  expect(given(w.requests[1])).toBe(false)
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
    const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(), seed: { unresolved: { count } } })
    await w.submit('还是不行')
    expect(given(w.requests[0])).toBe(hinted)
    // Whatever the count, the hint never reaches effort.level.
    expect(instructionKeys(w.requests[0]).includes('未解决')).toBe(false)
    expect(hintedKeys(w.requests[0]).includes('未解决')).toBe(hinted)
  })
}

test('with the unresolved switch off the effort request still goes alone but has no summary, no count and no hint', { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(), session: true, seed: { unresolved: { count: 5, summary: SUMMARY } } })
  await w.start()
  await w.command('dp', 'unresolved off')
  await w.submit('还是不行')
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['effort.level'])
  expect(w.requests[0]?.body.state).not.toHaveProperty(COUNT_FIELD)
  expect(w.requests[0]?.body.state).not.toHaveProperty('problem_summary')
  expect(given(w.requests[0])).toBe(false)
  expect(instructionKeys(w.requests[0]).includes('未解决')).toBe(false)
  expect((await w.board()).log.some((entry) => entry.hint !== undefined)).toBe(false)
})

test('a report that starts a turn is no word of the person\'s: no count, no summary, no hint in its request', { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(), seed: { unresolved: { count: 5, summary: SUMMARY } } })
  await w.submit('<agent-message from="a1">tests pass</agent-message>', { origin: { kind: 'peer' } })
  expect(w.requests[0]?.body.state).not.toHaveProperty(COUNT_FIELD)
  expect(given(w.requests[0])).toBe(false)
  expect(instructionKeys(w.requests[0]).includes('未解决')).toBe(false)
})

/** The probabilities with max at exactly `p` and the rest on xhigh: max wins at a threshold of `p` or less, else xhigh. */
const maxAt = (p: number): number[] => [0, 0, 0.1, 0.9 - p, p]

test('still unresolved (the same request\'s three-way answer adds one): the hinted answer is the one used, and max needs only hintThetaMax', { options: KEY }, async ($, on) => {
  const { thetaMax, hintThetaMax } = BACKEND_DEFAULTS.jev
  expect(hintThetaMax).toBeLessThan(thetaMax)
  // The plain answer is high and the hinted one has max at the hint's threshold: the turn goes out at max only by the hinted one.
  const hinted = world($, on, { switches: UNRESOLVED_ON, backend: backend(HIGH, STILL, maxAt(hintThetaMax)), seed: { unresolved: { count: 6, summary: SUMMARY } } })
  await hinted.submit('还是不行')
  await hinted.step({ index: 0 })
  expect(given(hinted.requests[0])).toBe(true)
  expect(hinted.steps.map((s) => s.effort)).toEqual(['max'])
})

test('still unresolved, but the hinted answer has max just under hintThetaMax: not max (the level is still the decision model\'s)', { options: KEY }, async ($, on) => {
  const { hintThetaMax } = BACKEND_DEFAULTS.jev
  // Max 0.01 under the hint's bar: the answer is read at hintThetaMax, so xhigh (the most probable level), even though the plain answer would be max.
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(MAX, STILL, maxAt(hintThetaMax - 0.01)), seed: { unresolved: { count: 6, summary: SUMMARY } } })
  await w.submit('还是不行')
  await w.step({ index: 0 })
  expect(w.steps.map((s) => s.effort)).toEqual(['xhigh'])
})

// The three-way answers that do not add one: resolved and new_or_unrelated reset the count, unsure leaves it.
for (const [name, shares] of [['resolved', SOLVED], ['new or unrelated', ELSEWHERE], ['unsure', UNSURE]] as const) {
  test(`${name} (the three-way answer adds nothing): the plain answer is used at thetaMax, even if the hinted answer says max`, { options: KEY }, async ($, on) => {
    const { thetaMax, hintThetaMax } = BACKEND_DEFAULTS.jev
    // The hinted copy was asked (the count is 6) and answers max outright, and the plain answer has max at the hint's bar, under thetaMax.
    const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(maxAt(hintThetaMax), shares, MAX), seed: { unresolved: { count: 6, summary: SUMMARY } } })
    await w.submit('还是不行')
    await w.step({ index: 0 })
    expect(given(w.requests[0])).toBe(true)
    expect(hintThetaMax).toBeLessThan(thetaMax)
    // xhigh: the plain answer at thetaMax (max at 0.4 does not reach 0.5), not the hinted max.
    expect(w.steps.map((s) => s.effort)).toEqual(['xhigh'])
  })
}

test('below the count that gives the hint, the same answer stays under thetaMax', { options: KEY }, async ($, on) => {
  const { hintThetaMax } = BACKEND_DEFAULTS.jev
  // Even a message that is still unresolved: no hinted question was asked, so there is no hinted answer and no lower bar.
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(maxAt(hintThetaMax), STILL), seed: { unresolved: { count: 2, summary: SUMMARY } } })
  await w.submit('还是不行')
  await w.step({ index: 0 })
  expect(given(w.requests[0])).toBe(false)
  expect(w.steps.map((s) => s.effort)).toEqual(['xhigh'])
})

test('and when the decision model does answer max with the hint given, the turn goes out at max', { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(MAX, STILL), seed: { unresolved: { count: 6, summary: SUMMARY } } })
  await w.submit('还是不行')
  await w.step({ index: 0 })
  expect(w.steps.map((s) => s.effort)).toEqual(['max'])
})

test('a mid-turn request carries the summary and the count, and the hint once the count has reached the threshold', { options: KEY }, async ($, on) => {
  const answers = (request: Sent): Reply => (Object.keys(request.body.questions).includes('midturn.level') ? jev(MAX)(request) : backend()(request))
  const w = world($, on, { switches: UNRESOLVED_ON, backend: answers, seed: { unresolved: { count: 3, summary: SUMMARY } } })
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
  const w = world($, on, { switches: UNRESOLVED_ON, backend: answers, seed: { unresolved: { count: 2, summary: SUMMARY } } })
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
  const w = world($, on, { switches: UNRESOLVED_ON, backend: (request) => jev([0, 0, 1, 0, 0], { shares: { 'agent.model': { sonnet: 1 }, 'effort.unresolved': UNSURE } })(request), seed: { unresolved: { count: 6, summary: SUMMARY } } })
  await w.submit('还是不行，让它去查一下日志')
  await w.spawn({ prompt: 'Read app.log and report the last error.', description: 'Read the log' })
  const agent = w.requests.find((request) => 'agent.model' in request.body.questions)
  expect(agent?.body.state[COUNT_FIELD]).toBe(6)
  expect(agent?.body.state.problem_summary).toBe(renderSummary(SUMMARY, 'en'))
  expect(JSON.stringify(agent?.body.questions)).not.toContain(COUNT_FIELD)
  expect(JSON.stringify(agent?.body.questions)).not.toMatch(/unsolved|未解决/)
})

test('a dispatched agent\'s request has neither while the unresolved switch is off', { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: (request) => jev([0, 0, 1, 0, 0], { shares: { 'agent.model': { sonnet: 1 }, 'effort.unresolved': UNSURE } })(request), session: true, seed: { unresolved: { count: 6, summary: SUMMARY } } })
  await w.start()
  await w.command('dp', 'unresolved off')
  await w.submit('让它去查一下日志')
  await w.spawn({ prompt: 'Read app.log and report the last error.', description: 'Read the log' })
  const agent = w.requests.find((request) => 'agent.model' in request.body.questions)
  expect(agent?.body.state).not.toHaveProperty(COUNT_FIELD)
  expect(agent?.body.state).not.toHaveProperty('problem_summary')
})

test('each time the hint is given the decision log gets an entry: the count, that it was given, that its answer was used, the level the decision model came to; the card says so; the board has no new event', { options: KEY }, async ($, on) => {
  // Still unresolved at 0.8: this message's three-way answer adds one, so the hinted answer (max) is the one taken.
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(HIGH, STILL, MAX), seed: { unresolved: { count: 3, summary: SUMMARY } } })
  await w.submit('还是不行')
  await w.step({ index: 0 })

  const { log } = await w.board()
  const hinted = log.filter((entry) => entry.hint !== undefined && entry.feature === 'unresolved')
  expect(hinted).toHaveLength(1)
  expect(hinted[0]).toMatchObject({ agent: 'main', effort: 'max', outcome: '已给强提示（次数 3）', hint: { count: 3, maxAfter: 3, used: true } })
  expect(hinted[0]?.reason).toContain('max')
  // The words say the hinted question was the one taken (and not that the plain one was).
  expect(hinted[0]?.reason).toContain('强提示的')
  expect(hinted[0]?.reason).not.toContain('没判为仍未解决')
  // The effort decision itself carries it for the card; its working is the hinted answer's.
  const decision = log.find((entry) => entry.feature === 'main-effort')
  expect(decision?.hint).toEqual({ count: 3, maxAfter: 3, used: true })
  expect(decision?.effort).toBe('max')

  const ui = await w.pane()
  expect(JSON.stringify(await ui.find({ key: 'pane-card-hint' }))).toContain('已给强提示 · 已采用')
  // The log's row for it says so, with the level.
  const rows = (await ui.findAll({ type: 'Box' })).filter((box) => box.key?.startsWith('pane-entry-')).map((box) => JSON.stringify(box))
  expect(rows.some((row) => row.includes('给了强提示') && row.includes('次数 3'))).toBe(true)

  // The band draws nothing of it.
  const band = await w.band()
  expect((await band.findAll({ type: 'Box' })).map((box) => JSON.stringify(box)).join('\n')).not.toContain('强提示')
})

test('a message the three-way question does not call still unresolved: the hint was given but its answer was not used, and the log says so (used false), with the plain answer\'s level', { options: KEY }, async ($, on) => {
  // The hinted copy answers max, the plain one high; the message reads as another problem, so high it is.
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(HIGH, ELSEWHERE, MAX), seed: { unresolved: { count: 3, summary: SUMMARY } } })
  await w.submit('换个话题：帮我看下 README')
  await w.step({ index: 0 })

  const { log } = await w.board()
  const hinted = log.filter((entry) => entry.hint !== undefined && entry.feature === 'unresolved')
  expect(hinted).toHaveLength(1)
  expect(hinted[0]).toMatchObject({ agent: 'main', effort: 'high', outcome: '已给强提示（次数 3）', hint: { count: 3, maxAfter: 3, used: false } })
  // Not the words of a hint that was taken: this one says the plain question was used.
  expect(hinted[0]?.reason).toContain('没判为仍未解决')
  expect(log.find((entry) => entry.feature === 'main-effort')?.hint).toEqual({ count: 3, maxAfter: 3, used: false })
  // The card says a hint was given and that its answer was not the one used.
  const card = JSON.stringify(await (await w.pane()).find({ key: 'pane-card-hint' }))
  expect(card).toContain('已给强提示 · 未采用')
  expect(card).not.toContain('已采用')
})

test('a message below the threshold leaves no hint entry and no row on the card', { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(), seed: { unresolved: { count: 2, summary: SUMMARY } } })
  await w.submit('还是不行')
  await w.step({ index: 0 })
  const { log } = await w.board()
  expect(log.some((entry) => entry.hint !== undefined)).toBe(false)
  expect(await (await w.pane()).find({ key: 'pane-card-hint' })).toBeUndefined()
})

test('a mid-turn re-decision that was given the hint is in the log too, with the level the decision model answered', { options: KEY }, async ($, on) => {
  const answers = (request: Sent): Reply => (Object.keys(request.body.questions).includes('midturn.level') ? jev(MAX)(request) : backend()(request))
  const w = world($, on, { switches: UNRESOLVED_ON, backend: answers, seed: { unresolved: { count: 3, summary: SUMMARY } } })
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

test('a mid-turn re-decision that was given the hint takes max at hintThetaMax (the hint is in midturn.level itself)', { options: KEY }, async ($, on) => {
  const { hintThetaMax } = BACKEND_DEFAULTS.jev
  const step = (index: number) => ({ index, answer: `第 ${index} 步`, tools: [{ tool: 'Read', input: { file_path: `/repo/src/f${index}.ts` } }] })
  const answers = (request: Sent): Reply => (Object.keys(request.body.questions).includes('midturn.level') ? jev(maxAt(hintThetaMax))(request) : backend()(request))
  const w = world($, on, { switches: UNRESOLVED_ON, backend: answers, seed: { unresolved: { count: 3, summary: SUMMARY } } })
  await w.submit('还是不行')
  for (const index of [0, 1, 2, 3]) await w.step(step(index))
  const mid = w.requests.find((request) => 'midturn.level' in request.body.questions)
  expect(Object.keys(mid?.body.questions['midturn.level'].instructions)).toContain('unsolved')
  // No second question mid-turn: there is no three-way answer beside it.
  expect(Object.keys(mid?.body.questions)).not.toContain('midturn.level_unsolved')
  const { log } = await w.board()
  expect(log.find((entry) => entry.mid !== undefined)?.mid?.result).toBe('max')
})

test('without the hint (count 2) the same mid-turn answer is read at thetaMax: xhigh', { options: KEY }, async ($, on) => {
  const { hintThetaMax } = BACKEND_DEFAULTS.jev
  const step = (index: number) => ({ index, answer: `第 ${index} 步`, tools: [{ tool: 'Read', input: { file_path: `/repo/src/f${index}.ts` } }] })
  const answers = (request: Sent): Reply => (Object.keys(request.body.questions).includes('midturn.level') ? jev(maxAt(hintThetaMax))(request) : backend()(request))
  const w = world($, on, { switches: UNRESOLVED_ON, backend: answers, seed: { unresolved: { count: 2, summary: SUMMARY } } })
  await w.submit('还是不行')
  for (const index of [0, 1, 2, 3]) await w.step(step(index))
  const mid = w.requests.find((request) => 'midturn.level' in request.body.questions)
  expect(Object.keys(mid?.body.questions['midturn.level'].instructions)).not.toContain('unsolved')
  const { log } = await w.board()
  expect(log.find((entry) => entry.mid !== undefined)?.mid?.result).toBe('xhigh')
})
