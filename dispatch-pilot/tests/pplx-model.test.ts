// `decisionModel: pplx` (#50, B′ of ADR 0006): Perplexity's pplx-decider-v1.1-27b makes every decision, with its own
// defaults. Seam 1 (engine events in; the requests the decision backend gets, what reaches the engine and the board out).
// The values it takes (the table in core/setup.ts) are checked beside Jev's in backend-defaults.test.ts, the failures of its
// API in pplx.test.ts (seam 2).

import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { estimateTokens } from '../hooks/decision/context.ts'
import type { SkillsWorld } from './support/world.ts'
import { jev, pplx, rates, world, type Sent } from './support/world.ts'

const PPLX = { decisionModel: 'pplx', perplexityApiKey: 'pplx-test-key' }

/** A message 25000 tokens long as the mod counts them, three times over: longer than any budget. */
const LONG = '把登录模块重构成三层'.repeat(7500)

/** How many of the mod's tokens a request's user_message took. */
const messageTokens = (request: Sent | undefined): number => estimateTokens(String(request?.body.state.user_message))

/** The state as sent, in the mod's tokens. */
const sentTokens = (state: unknown) => estimateTokens(JSON.stringify(state))

/** The ids of a request's questions. */
const ids = (request: Sent | undefined): string[] => Object.keys(request?.body?.questions ?? {})

/** The names of every question's instructions in a request: a question asked in Chinese names them in Chinese (`问题`, `评什么`). */
const instructionNames = (request: Sent): string[] => Object.values(request.body.questions as Record<string, { instructions?: Record<string, unknown> }>).flatMap((question) => Object.keys(question.instructions ?? {}))

// ---- the request ---------------------------------------------------------------------------------

test('a message gets one pplx decision on the Decisions API with the Bearer key, and its turn goes out at the decided effort', { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: pplx([0.05, 0.1, 0.7, 0.1, 0.05]) })
  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step({ index: 0 })

  expect(w.requests).toHaveLength(1)
  const [request] = w.requests
  expect(request?.url).toBe('https://api.perplexity.ai/v1/decisions')
  expect(request?.method).toBe('POST')
  expect(request?.headers.authorization).toBe('Bearer pplx-test-key')
  // Only the three fields the API takes; the model by the name the docs give.
  expect(Object.keys(request?.body).sort()).toEqual(['model', 'questions', 'state'])
  expect(request?.body.model).toBe('pplx-decider-v1.1-27b')
  expect(request?.body.state.user_message).toBe('把登录模块重构成三层，并补上测试')
  expect(ids(request)).toEqual(['effort.level'])
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  expect((await w.board()).main).toMatchObject({ effort: 'high', routed: true })
})

test('without decisionModel the decision still goes to Jev: the default moves in #52, not here', { options: { typesafeApiKey: 'ts-test-key', perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  await w.submit('解释一下这个函数做了什么')
  expect(w.requests.map((request) => request.url)).toEqual(['https://api.typesafe.ai/v1/systemone'])
})

// ---- the key -------------------------------------------------------------------------------------

test('the key can come from the environment alone: PERPLEXITY_API_KEY', { options: { decisionModel: 'pplx' } }, async ($, on) => {
  const w = world($, on, { env: { PERPLEXITY_API_KEY: 'env-key' }, backend: pplx([0, 0, 1, 0, 0], { key: 'env-key' }) })
  await w.submit('解释一下这个函数做了什么')
  await w.step({ index: 0, effort: 'low' })

  expect(w.requests[0]?.headers.authorization).toBe('Bearer env-key')
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
})

test('the key in the options wins over the environment when both are set', { options: PPLX }, async ($, on) => {
  const w = world($, on, { env: { PERPLEXITY_API_KEY: 'env-key' }, backend: pplx([0, 0, 1, 0, 0]) })
  await w.submit('解释一下这个函数做了什么')
  expect(w.requests.map((request) => request.headers.authorization)).toEqual(['Bearer pplx-test-key'])
})

test('a key with spaces around it in the environment is sent without them', { options: { decisionModel: 'pplx' } }, async ($, on) => {
  const w = world($, on, { env: { PERPLEXITY_API_KEY: '  env-key\n' }, backend: pplx([0, 0, 1, 0, 0], { key: 'env-key' }) })
  await w.submit('解释一下这个函数做了什么')
  expect(w.requests.map((request) => request.headers.authorization)).toEqual(['Bearer env-key'])
})

test('no key in the options or the environment: nothing is sent, the turn keeps the engine effort, the board says which key is missing', { options: { decisionModel: 'pplx' } }, async ($, on) => {
  const w = world($, on, { env: {}, backend: pplx([0, 0, 1, 0, 0]) })
  await w.submit('解释一下这个函数做了什么')
  await w.step({ index: 0, effort: 'medium' })

  expect(w.requests).toHaveLength(0)
  expect(w.steps.map((s) => s.effort)).toEqual(['medium'])
  expect((await w.board()).main).toMatchObject({
    effort: 'medium',
    routed: false,
    why: 'pplx：没有填 perplexityApiKey 或 PERPLEXITY_API_KEY',
    failure: { backend: 'pplx', kind: 'config', detail: expect.stringContaining('PERPLEXITY_API_KEY') },
  })
})

test('the key is refused (401): the board says so, and the key appears nowhere the mod writes', { options: PPLX }, async ($, on) => {
  const w = world($, on, { env: { PERPLEXITY_API_KEY: 'env-key-9f3a' }, session: true, backend: pplx([0, 0, 1, 0, 0], { key: 'another-key' }) })
  await w.start()
  await w.submit('解释一下这个函数做了什么')
  await w.step({ index: 0, effort: 'medium' })

  expect((await w.board()).main).toMatchObject({ routed: false, why: 'pplx：密钥被拒绝（状态码 401）', failure: { backend: 'pplx', kind: 'config', status: 401 } })
  expect(w.requests[0]?.headers.authorization).toBe('Bearer pplx-test-key')
  // Neither key is written to the debug log, the board, the decision log or the toasts.
  const written = JSON.stringify({ logs: w.logs, board: await w.board(), toasts: w.toasts, statuses: w.statuses })
  expect(written).not.toContain('pplx-test-key')
  expect(written).not.toContain('env-key-9f3a')
})

test('a key the API echoes in an error is kept out of the decision log, the board and the debug log', { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: () => ({ status: 400, body: { error: { type: 'invalid_request_error', message: 'bad header Bearer pplx-test-key' } } }) })
  await w.submit('解释一下这个函数做了什么')
  await w.step({ index: 0, effort: 'medium' })

  expect((await w.board()).main).toMatchObject({ routed: false, failure: { backend: 'pplx', kind: 'http', status: 400 } })
  const written = JSON.stringify({ logs: w.logs, board: await w.board(), toasts: w.toasts })
  expect(written).toContain('request [effort.level] to pplx')
  expect(written).not.toContain('pplx-test-key')
})

// ---- the thresholds -------------------------------------------------------------------------------

test('max goes out at 0.47 with pplx', { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: pplx([0, 0, 0.2, 0.32, 0.48]) })
  await w.submit('把这个死锁查清楚')
  await w.step({ index: 0, effort: 'low' })
  expect(w.steps.map((s) => s.effort)).toEqual(['max'])
  expect((await w.board()).log[0]?.trace?.[1]).toMatchObject({ rule: 'max-gate', applied: false, thetaMax: 0.47 })
})

test('the same answer with Jev stays at xhigh: Jev needs 0.5 for max', { options: { typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 0.2, 0.32, 0.48]) })
  await w.submit('把这个死锁查清楚')
  await w.step({ index: 0, effort: 'low' })
  expect(w.steps.map((s) => s.effort)).toEqual(['xhigh'])
})

test('the level above is not taken below 0.45 with pplx (Jev: 0.3); the rule trace shows the threshold', { options: PPLX }, async ($, on) => {
  // 0.55 on medium, 0.4 on high: Jev would round up to high, pplx stays at medium.
  const w = world($, on, { backend: pplx([0, 0.55, 0.4, 0.05, 0]) })
  await w.submit('把这个死锁查清楚')
  await w.step({ index: 0, effort: 'low' })
  expect(w.steps.map((s) => s.effort)).toEqual(['medium'])
  expect((await w.board()).log[0]?.trace?.[2]).toMatchObject({ rule: 'round-up', applied: false, above: 'high', p: 0.4, threshold: 0.45 })
})

test('the level above is taken at 0.45 with pplx', { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: pplx([0, 0.5, 0.45, 0.05, 0]) })
  await w.submit('把这个死锁查清楚')
  await w.step({ index: 0, effort: 'low' })
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  expect((await w.board()).log[0]?.trace?.[2]).toMatchObject({ rule: 'round-up', applied: true, threshold: 0.45 })
})

// ---- what the state holds ------------------------------------------------------------------------

test('a message takes up to 48000 tokens of state: a long one is cut to it', { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: pplx([0, 1, 0, 0, 0]) })
  await w.submit(LONG)
  expect(messageTokens(w.requests[0])).toBeLessThanOrEqual(48000)
  expect(messageTokens(w.requests[0])).toBeGreaterThan(47950)
})

test('a budget the person sets is the one used, for every kind of request', { options: { ...PPLX, contextTokens: 4000 } }, async ($, on) => {
  const w = world($, on, { backend: pplx([0, 1, 0, 0, 0]) })
  await w.submit(LONG)
  expect(messageTokens(w.requests[0])).toBeLessThanOrEqual(4000)
  expect(messageTokens(w.requests[0])).toBeGreaterThan(3950)
})

test('with skill suggestions the skills\' request keeps 6000 tokens and the effort request, which goes alone, 48000', { options: PPLX }, async ($, on) => {
  const skills: SkillsWorld = {
    commands: [{ name: 'tdd', description: 'Test-driven development. Use when the user wants to build features or fix bugs test-first.', source: 'user' }],
    listed: [{ name: 'tdd', source: 'userSettings', tokens: 52 }],
  }
  const w = world($, on, { backend: rates({ tdd: 0.5, '(none)': 0.5 }, { tdd: 0.5 }, [0, 1, 0, 0, 0], pplx), skills })
  await w.submit(LONG)
  const effort = w.requests.find((request) => ids(request).includes('effort.level'))
  const asked = w.withoutEffort[0]
  expect(ids(asked)).toContain('skills.which')
  expect(messageTokens(effort)).toBeLessThanOrEqual(48000)
  expect(messageTokens(effort)).toBeGreaterThan(47950)
  expect(messageTokens(asked)).toBeLessThanOrEqual(6000)
  expect(messageTokens(asked)).toBeGreaterThan(5950)
})

test("a dispatched agent's state and a mid-turn re-decision's message take up to 48000 tokens", { options: { ...PPLX, rejudgeEvery: 1 } }, async ($, on) => {
  const w = world($, on, { backend: pplx([0, 1, 0, 0, 0]) })
  await w.submit(LONG)
  const reading = (index: number) => ({ index, answer: `step ${index}`, tools: [{ tool: 'Read', input: { file_path: `/repo/src/f${index}.ts` } }] })
  await w.step(reading(0))
  await w.step(reading(1))
  await w.step({ index: 2 })
  await w.spawn({ prompt: LONG, description: 'Check the cache config' })

  const stateOf = (id: string) => w.requests.find((request) => id in request.body.questions)?.body.state
  const agent = stateOf('agent.model')
  expect(sentTokens(agent)).toBeLessThanOrEqual(48000)
  expect(sentTokens(agent)).toBeGreaterThan(47000)
  // The re-decision keeps the turn's message to half of its budget.
  const midturn = stateOf('midturn.level')
  expect(estimateTokens(String(midturn.user_message))).toBeLessThanOrEqual(24000)
  expect(estimateTokens(String(midturn.user_message))).toBeGreaterThan(23000)
  expect(sentTokens(midturn)).toBeLessThanOrEqual(48000)
})

test('a message carries up to 2000 recent messages, as far as the budget goes', { options: PPLX }, async ($, on) => {
  const messages = Array.from({ length: 2100 }, (_, i): SessionMessage => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `message number ${i}`, toolUses: [] }))
  const w = world($, on, { backend: pplx([0, 1, 0, 0, 0]), messages })
  await w.submit('continue with the next one')
  const lines = String(w.requests[0]?.body.state.recent_context).split('\n')
  expect(lines).toHaveLength(2000)
  expect(lines.at(-1)).toBe('assistant: message number 2099')
})

// ---- how it is asked -----------------------------------------------------------------------------

test('every question is asked in English, the effort question beside a message too', { options: { ...PPLX, rejudgeEvery: 1 } }, async ($, on) => {
  const skills: SkillsWorld = {
    commands: [{ name: 'tdd', description: 'Test-driven development. Use when the user wants to build features or fix bugs test-first.', source: 'user' }],
    listed: [{ name: 'tdd', source: 'userSettings', tokens: 52 }],
  }
  const w = world($, on, { backend: rates({ tdd: 0.8, '(none)': 0.2 }, { tdd: 0.9 }, [0, 1, 0, 0, 0], pplx), skills })
  await w.submit('先写一个失败的测试')
  await w.step({ index: 0, effort: 'medium', tools: [{ tool: 'Skill', input: { skill: 'tdd' } }] })
  await w.spawn({ prompt: 'Run the tests and report what fails.', description: 'Run the tests' })

  const asked = new Set(w.requests.flatMap(ids))
  for (const id of ['effort.level', 'skills.which', 'skills.fits.0', 'midturn.level', 'agent.effort']) expect(asked).toContain(id)
  for (const request of w.requests) for (const name of instructionNames(request)) expect(name).toMatch(/^[a-z_]+$/)
  const effort = w.requests[0]?.body.questions['effort.level']
  expect(Object.keys(effort.instructions)).toEqual(['question', 'rate', 'short_replies'])
  expect(effort.criteria[0]).toMatch(/^Answered from what is already known/)
})

// ---- how long it is waited for -------------------------------------------------------------------

test('a message waits 8000 ms for the decision, then goes on unrouted', { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: (request) => ({ after: 60_000, reply: pplx([0, 0, 1, 0, 0])(request) }) })
  const submitting = w.submit('看看这个报错是怎么回事')
  await w.clock.settle()
  await w.clock.advance(8000)
  await submitting
  await w.step({ index: 0, effort: 'xhigh' })
  expect((await w.board()).main).toMatchObject({ effort: 'xhigh', routed: false, failure: { backend: 'pplx', kind: 'timeout', detail: 'no answer in 8000 ms' } })
})

test('a timeout the person sets is the one used with pplx too', { options: { ...PPLX, timeoutMs: 2500 } }, async ($, on) => {
  const w = world($, on, { backend: (request) => ({ after: 60_000, reply: pplx([0, 0, 1, 0, 0])(request) }) })
  const submitting = w.submit('看看这个报错是怎么回事')
  await w.clock.settle()
  await w.clock.advance(2500)
  await submitting
  await w.step({ index: 0, effort: 'xhigh' })
  expect((await w.board()).main).toMatchObject({ routed: false, failure: { backend: 'pplx', kind: 'timeout', detail: 'no answer in 2500 ms' } })
})

/** A step whose response calls one tool (the call a re-decision goes out with). */
const working = (index: number) => ({ index, answer: `step ${index}`, tools: [{ tool: 'Read', input: { file_path: `/repo/src/f${index}.ts` } }] })

/** pplx answering the message's request with a medium effort and each mid-turn request with xhigh, `after` ms late. */
const lateMidturn = (after: number) => (request: Sent) => {
  const answer = ids(request).includes('midturn.level') ? pplx([0, 0, 0.1, 0.8, 0.1], { confidence: 0.8 })(request) : pplx([0, 1, 0, 0, 0])(request)
  return ids(request).includes('midturn.level') ? { after, reply: answer } : answer
}

test('a step waits 6000 ms for a re-decision that is late, keeps its effort when the wait runs out, and takes the answer when it comes', { options: { ...PPLX, rejudgeEvery: 2 } }, async ($, on) => {
  const w = world($, on, { backend: lateMidturn(7000) })
  await w.submit('把这个死锁查清楚')
  await w.step(working(0))
  await w.step(working(1))

  const late = w.step(working(2))
  await w.clock.settle()
  await w.clock.advance(6000)
  await late
  expect((await w.board()).main?.midturn).toEqual({ steps: 3, judged: 1, changed: 0, late: true })

  await w.clock.advance(1000) // the answer comes
  await w.step({ index: 3 })
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'medium', 'xhigh'])
})

test('a re-decision that takes 5 s is waited for, and the step goes at the new level', { options: { ...PPLX, rejudgeEvery: 2 } }, async ($, on) => {
  const w = world($, on, { backend: lateMidturn(5000) })
  await w.submit('把这个死锁查清楚')
  await w.step(working(0))
  await w.step(working(1))

  const waiting = w.step(working(2))
  await w.clock.settle()
  await w.clock.advance(5000)
  await waiting
  expect((await w.board()).main?.midturn).toEqual({ steps: 3, judged: 2, changed: 1 })
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'xhigh'])
})

test('a rejudgeWaitMs the person sets comes first', { options: { ...PPLX, rejudgeEvery: 2, rejudgeWaitMs: 300 } }, async ($, on) => {
  const w = world($, on, { backend: lateMidturn(1000) })
  await w.submit('把这个死锁查清楚')
  await w.step(working(0))
  await w.step(working(1))

  const late = w.step(working(2))
  await w.clock.settle()
  await w.clock.advance(300)
  await late
  expect((await w.board()).main?.midturn).toEqual({ steps: 3, judged: 1, changed: 0, late: true })
})
