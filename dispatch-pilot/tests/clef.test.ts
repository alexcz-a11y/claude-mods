// The decision model chosen in the config is Clef: seam 1 (engine events in,
// what reaches Cloudflare and the engine out), against the Cloudflare twin in
// support/cloudflare.ts. The Jev tests stay in main-effort.test.ts.

import { expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import { turnStartState } from '../hooks/decision/context.ts'
import { turnStartEffortPart } from '../hooks/decision/effort.ts'
import { mergeParts } from '../hooks/decision/system-one.ts'
import { ACCOUNT, CLEF_OPTIONS, CLEF_URL, TOKEN, clef, clefInputProblems, cloudflareError } from './support/cloudflare.ts'
import { jev, world, type Reply } from './support/world.ts'

test('with Clef chosen, the decision goes to Cloudflare Workers AI and its answer sets the turn effort', { options: CLEF_OPTIONS }, async ($, on) => {
  const w = world($, on, { backend: clef([0.05, 0.1, 0.7, 0.1, 0.05]) })

  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step({ index: 0 })

  expect(w.requests).toHaveLength(1)
  const [request] = w.requests
  expect(request?.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/clef`)
  expect(request?.url).toBe(CLEF_URL)
  expect(request?.method).toBe('POST')
  expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`)
  expect(request?.headers['content-type']).toBe('application/json')
  expect(request?.body.model).toBe('clef')
  expect(request?.body.state.user_message).toBe('把登录模块重构成三层，并补上测试')
  expect(Object.keys(request?.body.questions)).toEqual(['effort.level'])
  // The answer is read from the envelope's result: high is the most likely level.
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  expect((await w.board()).main).toMatchObject({ effort: 'high', routed: true })
})

test('the debug log says the request went to Clef, who answered it and how many tokens it read', { options: CLEF_OPTIONS }, async ($, on) => {
  const w = world($, on, { backend: clef([0.05, 0.1, 0.6, 0.2, 0.05]) })
  await w.submit('把登录模块重构成三层')

  expect(w.logs.map((entry) => entry.to)).toEqual(['debug', 'debug'])
  expect(w.logs.map((entry) => entry.text)).toEqual([
    'request [effort.level] to clef: answered in 0 ms by clef (151 input tokens)',
    'effort high for "把登录模块重构成三层": p low 0.05, medium 0.10, high 0.60, xhigh 0.20, max 0.05; confidence 0.70',
  ])
})

const TRANSCRIPT: SessionMessage[] = [
  { role: 'user', text: '帮我看一下 src/auth/session.ts 里的过期逻辑', toolUses: [] },
  { role: 'assistant', text: '过期时间写死成了 3600 秒。要我改成读配置吗？', toolUses: [] },
]

test('what the mod sends to Clef is the decision module\'s request with the model named, so the eval measures the live request (spec #67)', { options: CLEF_OPTIONS }, async ($, on) => {
  const w = world($, on, { backend: clef([0, 1, 0, 0, 0]), messages: TRANSCRIPT })
  await w.submit('改吧')

  const built = mergeParts(turnStartState({ prompt: '改吧', messages: TRANSCRIPT, limits: { messages: 4, tokens: 2000 } }), [turnStartEffortPart()])
  expect(w.requests[0]?.body).toEqual({ model: 'clef', ...built })
  // Sent with the message first, as the question guide asks. Clef's encoder sorts a state's keys before it reads its
  // head, so no order is relied on with Clef: the budget holds for the whole state (tests/backend-defaults.test.ts).
  expect(Object.keys(w.requests[0]?.body.state)).toEqual(['user_message', 'recent_context'])
})

test("the request the mod sends keeps Clef's input rules (question ids, counts), and the Cloudflare twin refuses what breaks them", { options: CLEF_OPTIONS }, async ($, on) => {
  const w = world($, on, { backend: clef([0, 0, 1, 0, 0]) })
  await w.submit('把登录模块重构成三层')

  expect(clefInputProblems(w.requests[0]?.body)).toEqual([])
  // The rules as Cloudflare's schema states them: the twin must be able to tell.
  const noul = { type: 'noul', instructions: 'Is x a letter?' }
  expect(clefInputProblems({ model: 'clef', state: 'x', questions: { q: noul } })).toEqual([])
  expect(clefInputProblems({ model: 'jev-latest', state: 'x', questions: { q: noul } })).toHaveLength(1)
  expect(clefInputProblems({ model: 'clef', state: 'x', questions: { 'fits::cloudflare:wrangler': noul } })).toHaveLength(1)
  expect(clefInputProblems({ model: 'clef', state: 'x', questions: { ['a'.repeat(101)]: noul } })).toHaveLength(1)
  expect(clefInputProblems({ model: 'clef', state: 'x', questions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, noul])) })).toHaveLength(1)
  expect(clefInputProblems({ model: 'clef', state: 'x', questions: { q: { type: 'choice', instructions: 'Which?', criteria: { only: null } } } })).toHaveLength(1)
  expect(clefInputProblems({ model: 'clef', state: 'x', questions: { q: { type: 'score', instructions: 'How much?', criteria: Array.from({ length: 11 }, () => 'level') } } })).toHaveLength(1)
  expect(clefInputProblems({ model: 'clef', state: 'x', questions: { q: { type: 'noul', instructions: '' } } })).toHaveLength(1)
})

// The debug log is a file on the person's disk: whatever a failure echoes of
// the address (it holds the account ID) or of the request (it held the token)
// stays out of it.
for (const [name, reply] of [
  ['an error that quotes the address and the header', { reject: `fetch failed: POST ${CLEF_URL} with Authorization: Bearer ${TOKEN}` }],
  ['a Cloudflare error that names the account', cloudflareError(404, 7003, `No route for account ${ACCOUNT} (token ${TOKEN})`)],
] as [string, Reply][]) {
  test(`${name} does not carry the account ID or the token into the debug log`, { options: CLEF_OPTIONS }, async ($, on) => {
    const w = world($, on, { backend: () => reply })
    await w.submit('解释一下这个函数做了什么')

    const logged = w.logs.map((entry) => entry.text).join('\n')
    expect(logged).toContain('request [effort.level] to clef:')
    expect(logged).toContain('[REDACTED]')
    expect(logged).not.toContain(ACCOUNT)
    expect(logged).not.toContain(TOKEN)
  })
}

test('no answer within timeoutMs: the prompt goes in without waiting longer, the turn keeps the engine effort, the board says why', { options: { ...CLEF_OPTIONS, timeoutMs: 800 } }, async ($, on) => {
  // Clef answers only after a minute of (mock) time.
  const w = world($, on, { backend: (request) => ({ after: 60_000, reply: clef([0, 0, 1, 0, 0])(request) }) })

  const submitting = w.submit('看看这个报错是怎么回事')
  await w.clock.settle() // the hook is now waiting on the request and its timer
  await w.clock.advance(800)
  await submitting // resolved at 800 ms: the prompt was not held for the slow answer
  await w.step({ index: 0, effort: 'xhigh' })

  expect(w.requests).toHaveLength(1)
  expect(w.prompts).toHaveLength(1)
  expect(w.steps.map((s) => s.effort)).toEqual(['xhigh'])
  expect((await w.board()).main).toMatchObject({ effort: 'xhigh', routed: false, failure: { backend: 'clef', kind: 'timeout', detail: 'no answer in 800 ms' } })
})

// What Cloudflare answers when it does not answer: its error body is
// `{ result: null, success: false, errors: [{ code, message }], messages }`,
// and the code, not the HTTP status, tells the daily allowance spent from a
// busy moment (both are 429).
const BARE_ANSWER = { 'effort.level': { type: 'score', score: 2, legend: {}, probabilities: { 0: 0, 1: 0, 2: 1, 3: 0, 4: 0 }, confidence: 1 } }
const failures: { name: string; reply: Reply; why: string }[] = [
  { name: 'the token is refused (401, 10000)', reply: cloudflareError(401, 10000, 'Authentication error'), why: 'clef: key refused (HTTP 401)' },
  { name: 'the account may not run Clef (403, 5035)', reply: cloudflareError(403, 5035, 'This model requires a Workers Paid plan'), why: 'clef: key refused (HTTP 403)' },
  { name: 'the free daily allowance is used up (429, 3036)', reply: cloudflareError(429, 3036, "You have used up your daily free allocation of 10,000 neurons. Please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage."), why: 'clef: daily quota used up' },
  { name: 'capacity is exceeded for the moment (429, 3040)', reply: cloudflareError(429, 3040, 'Capacity temporarily exceeded, please try again.'), why: 'clef: busy (HTTP 429)' },
  { name: 'Cloudflare timed the request out (408, 3007)', reply: cloudflareError(408, 3007, 'Request timeout'), why: 'clef: busy (HTTP 408)' },
  { name: 'the request was refused as malformed (400, 5006)', reply: cloudflareError(400, 5006, 'AiError: model must be "clef"'), why: 'clef: HTTP 400' },
  { name: 'a server error with no Cloudflare body (500)', reply: { status: 500, body: 'Internal Server Error' }, why: 'clef: HTTP 500' },
  { name: 'the network is down', reply: { reject: 'getaddrinfo ENOTFOUND api.cloudflare.com' }, why: 'clef: unreachable' },
  { name: 'a 200 that is not JSON', reply: { status: 200, body: '<html>maintenance</html>' }, why: 'clef: unreadable answer' },
  { name: 'a 200 whose envelope says it failed', reply: { status: 200, body: { result: null, success: false, errors: [{ code: 7003, message: 'No route for the URI' }], messages: [] } }, why: 'clef: unreadable answer' },
  { name: 'answers outside the envelope, as Jev sends them', reply: { status: 200, body: { model: 'clef', answers: BARE_ANSWER, usage: { input_tokens: 151, output_tokens: 0 } } }, why: 'clef: unreadable answer' },
  { name: 'an answer without the effort question', reply: { status: 200, body: { result: { model: 'clef', answers: {}, usage: { input_tokens: 151, output_tokens: 0 } }, success: true, errors: [], messages: [] } }, why: 'clef: unreadable answer' },
]

for (const failure of failures) {
  test(`${failure.name}: the turn keeps the engine effort and the board says why, in Clef's words`, { options: CLEF_OPTIONS }, async ($, on) => {
    const w = world($, on, { backend: () => failure.reply })
    await w.submit('解释一下这个函数做了什么')
    await w.step({ index: 0, effort: 'medium' })

    expect(w.requests).toHaveLength(1)
    expect(w.prompts).toHaveLength(1)
    expect(w.steps.map((s) => s.effort)).toEqual(['medium'])
    expect((await w.board()).main).toMatchObject({ effort: 'medium', routed: false, why: failure.why, failure: { backend: 'clef' } })
  })
}

// One decision model or the other, never both: a missing credential of the
// chosen one is not made up for with the other's key.
const unconfigured: { name: string; options: Record<string, string>; why: string }[] = [
  { name: 'neither the account ID nor the token', options: {}, why: 'clef: no Cloudflare account ID or API token: set cloudflareAccountId and cloudflareApiToken' },
  { name: 'no account ID', options: { cloudflareApiToken: TOKEN }, why: 'clef: no Cloudflare account ID: set cloudflareAccountId' },
  { name: 'no token', options: { cloudflareAccountId: ACCOUNT }, why: 'clef: no Cloudflare API token: set cloudflareApiToken' },
]

for (const { name, options, why } of unconfigured) {
  test(`Clef chosen with ${name}: nothing is sent, not even to Jev; the turn keeps the engine effort and the board says what to set`, { options: { decisionModel: 'clef', typesafeApiKey: 'ts-test-key', ...options } }, async ($, on) => {
    const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
    await w.submit('解释一下这个函数做了什么')
    await w.step({ index: 0, effort: 'medium' })

    expect(w.requests).toHaveLength(0)
    expect(w.prompts).toHaveLength(1)
    expect(w.steps.map((s) => s.effort)).toEqual(['medium'])
    expect((await w.board()).main).toMatchObject({ effort: 'medium', routed: false, why, failure: { backend: 'clef', kind: 'config' } })
  })
}

test('Jev chosen with Cloudflare credentials also set: the decision goes to TypeSafe only', { options: { ...CLEF_OPTIONS, decisionModel: 'jev', typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  await w.submit('给这个函数加上缓存')
  await w.step({ index: 0 })

  expect(w.requests.map((r) => r.url)).toEqual(['https://api.typesafe.ai/v1/systemone'])
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
})
