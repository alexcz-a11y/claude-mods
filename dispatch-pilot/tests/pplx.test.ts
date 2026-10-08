// Perplexity's decision model as a backend (#43): the Decisions API at
// POST https://api.perplexity.ai/v1/decisions, asked through the same Backend
// interface as Jev. The seam is `pplxBackend(key).ask(io, request,
// timeoutMs)` over a fake network, so only the network is pretend; the replies
// are what docs.perplexity.ai/docs/decisions/quickstart says the API sends (and
// what a probe of the real API sent on 2026-10-07).

import type { HttpResponse } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { BackendIo } from '../hooks/decision/backend.ts'
import { PPLX_MODEL, PPLX_URL, pplxBackend } from '../hooks/decision/pplx.ts'
import { answersFor, type DecisionRequest, type Part } from '../hooks/decision/system-one.ts'

/** The documentation's example request: one question of each type about one review. */
const REQUEST: DecisionRequest = {
  state: { title: 'Battery died after two weeks', review: 'The headphones sound great, but the battery stopped charging after two weeks.' },
  questions: {
    'review.defect': { type: 'noul', instructions: 'Does the review report a product defect?' },
    'review.sentiment': {
      type: 'choice',
      instructions: 'What is the overall sentiment of the review?',
      criteria: { positive: 'Mostly satisfied', mixed: 'Praise and complaints in one review', negative: 'Mostly dissatisfied' },
    },
    'review.severity': { type: 'score', instructions: 'How severe is the reported problem?', criteria: ['Cosmetic', 'Inconvenient', 'Product unusable'] },
  },
}

/** The same questions as one part, to read the answers back the way a feature does. */
const PART: Part = {
  part: 'review',
  questions: { defect: REQUEST.questions['review.defect']!, sentiment: REQUEST.questions['review.sentiment']!, severity: REQUEST.questions['review.severity']! },
}

/** The documentation's example response (the values as the API sent them). */
const DOCUMENTED = {
  model: 'pplx-decider-v1.1-27b',
  answers: {
    'review.defect': { type: 'noul', noul: 0.9424522889347015 },
    'review.sentiment': {
      type: 'choice',
      choice: 'mixed',
      confidence: 0.9255246944002182,
      probabilities: { positive: 0.020649883775315993, mixed: 0.9503497962668123, negative: 0.02900031995787183 },
    },
    'review.severity': {
      type: 'score',
      score: 1.7838686319784252,
      confidence: 0.7838686319784252,
      legend: { '0': 'Cosmetic', '1': 'Inconvenient', '2': 'Product unusable' },
      probabilities: { '0': 0.008423954913615923, '1': 0.199283458194343, '2': 0.7922925868920411 },
    },
  },
  usage: { input_tokens: 367, output_tokens: 3 },
}

/** A key as long as a real one: a short one would also match inside the words of a failure. */
const KEY = 'pplx-test-key'

type Seen = { url: string; method: string | undefined; headers: Record<string, string>; body: any }

/** A fake network: `reply` answers each request (a response, or a rejection); the requests are kept. */
function network(reply: (seen: Seen) => Partial<HttpResponse> & { status: number }, options: { never?: boolean } = {}) {
  const seen: Seen[] = []
  const io: BackendIo = {
    fetch: async (url, init) => {
      const one: Seen = { url, method: init.method, headers: { ...(init.headers as Record<string, string>) }, body: JSON.parse(String(init.body)) }
      seen.push(one)
      if (options.never) return new Promise<HttpResponse>(() => {})
      const out = reply(one)
      return { ok: out.status >= 200 && out.status < 300, headers: {}, text: '', ...out }
    },
    // The timeout timer: fires at once when the test says no answer will come, otherwise never (it is aborted).
    sleep: (_ms, signal) => (options.never ? Promise.resolve() : new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted'))))),
  }
  return { io, seen }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, headers, text: JSON.stringify(body) })

test('a request goes to the Decisions API as the model, the state and the questions, with the key as a Bearer token and nothing else in the body', async () => {
  const net = network(() => json(200, DOCUMENTED))
  const asked = await pplxBackend(KEY).ask(net.io, REQUEST, 1500)

  expect(asked.ok).toBe(true)
  expect(net.seen).toHaveLength(1)
  const [sent] = net.seen
  expect(sent?.url).toBe('https://api.perplexity.ai/v1/decisions')
  expect(PPLX_URL).toBe('https://api.perplexity.ai/v1/decisions')
  expect(sent?.method).toBe('POST')
  expect(sent?.headers.authorization).toBe(`Bearer ${KEY}`)
  expect(sent?.headers['content-type']).toBe('application/json')
  // The API answers 400 to an unknown top-level field: the body is these three and no more. The name is the one the docs say to pin.
  expect(Object.keys(sent?.body).sort()).toEqual(['model', 'questions', 'state'])
  expect(sent?.body.model).toBe('pplx-decider-v1.1-27b')
  expect(PPLX_MODEL).toBe('pplx-decider-v1.1-27b')
  expect(sent?.body.state).toEqual(REQUEST.state)
  expect(sent?.body.questions).toEqual(REQUEST.questions)
})

test('all three question types are read from the answer, the score and choice probabilities by their string keys, with the model and the input tokens', async () => {
  const net = network(() => json(200, DOCUMENTED))
  const asked = await pplxBackend(KEY).ask(net.io, REQUEST, 1500)
  if (!asked.ok) throw new Error(`not answered: ${asked.failure.detail}`)

  expect(asked.model).toBe('pplx-decider-v1.1-27b')
  expect(asked.inputTokens).toBe(367)
  // As a feature reads them: under the part's own ids, typed.
  const answers = answersFor(PART, asked.answers)
  expect(answers.defect).toEqual({ type: 'noul', noul: 0.9424522889347015 })
  expect(answers.sentiment).toMatchObject({ type: 'choice', choice: 'mixed', confidence: 0.9255246944002182 })
  expect(answers.sentiment).toMatchObject({ probabilities: { positive: 0.020649883775315993, mixed: 0.9503497962668123, negative: 0.02900031995787183 } })
  expect(answers.severity).toMatchObject({ type: 'score', score: 1.7838686319784252, confidence: 0.7838686319784252 })
  expect(answers.severity).toMatchObject({ probabilities: { '0': 0.008423954913615923, '1': 0.199283458194343, '2': 0.7922925868920411 } })
})

test('without a key nothing is sent: a config failure that says what to set', async () => {
  const net = network(() => json(200, DOCUMENTED))
  const backend = pplxBackend('')
  expect(backend.name).toBe('pplx')
  expect(backend.configured).toBe(false)
  const asked = await backend.ask(net.io, REQUEST, 1500)

  expect(net.seen).toEqual([])
  expect(asked).toEqual({ ok: false, failure: { kind: 'config', detail: expect.stringContaining('PERPLEXITY_API_KEY') } })
})

test("a key given as a function is read when the backend is asked, not when it is built: the mod's key may come from the environment, which is read after", async () => {
  const net = network(() => json(200, DOCUMENTED))
  let key = ''
  const backend = pplxBackend(() => key)
  expect(backend.configured).toBe(false)
  expect(await backend.ask(net.io, REQUEST, 1500)).toMatchObject({ ok: false, failure: { kind: 'config', detail: 'no Perplexity API key: set perplexityApiKey or PERPLEXITY_API_KEY' } })
  expect(net.seen).toEqual([])

  key = KEY
  expect(backend.configured).toBe(true)
  expect(await backend.ask(net.io, REQUEST, 1500)).toMatchObject({ ok: true })
  expect(net.seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`)
})

// What each failure of the Decisions API comes to (quickstart, Errors). The bodies are the documented ones: a JSON
// `error` object for most, an empty body for 404 and 405, an HTML page for a 504.
const failures: { name: string; status: number; text: string; headers?: Record<string, string>; kind: string; detail: RegExp }[] = [
  {
    name: 'a bad request (an unknown model, a field or a limit) is the mod\'s own error, with the API\'s reason',
    status: 400,
    text: JSON.stringify({ error: { message: "Invalid model 'pplx-decider-v1.1-27b-latest'. Permitted models can be found in the documentation.", type: 'invalid_request_error', param: null, code: null } }),
    kind: 'http',
    detail: /^HTTP 400: invalid_request_error: Invalid model 'pplx-decider-v1\.1-27b-latest'/,
  },
  {
    name: 'a refused key (401) is a config failure',
    status: 401,
    text: JSON.stringify({ error: { message: 'Invalid API key provided. You can find your API key at https://console.perplexity.ai.', type: 'invalid_api_key', code: 401 } }),
    kind: 'config',
    detail: /^HTTP 401: invalid_api_key: Invalid API key provided/,
  },
  { name: 'a 404 has an empty body', status: 404, text: '', kind: 'http', detail: /^HTTP 404: empty body$/ },
  { name: 'a 405 has an empty body too', status: 405, text: '', kind: 'http', detail: /^HTTP 405: empty body$/ },
  {
    name: 'a body over the limit (413) is the mod\'s own error',
    status: 413,
    text: JSON.stringify({ error: { code: null, message: 'request body exceeds the maximum allowed size of 33554432 bytes', param: null, type: 'invalid_request_error' } }),
    kind: 'http',
    detail: /^HTTP 413: invalid_request_error: request body exceeds/,
  },
  {
    name: 'over the rate limit (429) is busy, and the detail says how long Retry-After asked to wait',
    status: 429,
    text: JSON.stringify({ error: { code: null, message: 'Request rate limit exceeded, please try again later.', param: null, type: 'too_many_requests' } }),
    headers: { 'retry-after': '2' },
    kind: 'busy',
    detail: /^HTTP 429: too_many_requests: Request rate limit exceeded.* \(retry after 2 s\)$/,
  },
  {
    name: '429 without a Retry-After is busy as well',
    status: 429,
    text: JSON.stringify({ error: { message: 'slow down', type: 'too_many_requests' } }),
    kind: 'busy',
    detail: /^HTTP 429: too_many_requests: slow down$/,
  },
  {
    name: 'a 504 is the model not answering in time, and its HTML page is not copied into the log',
    status: 504,
    text: '<html><head><title>504 Gateway Time-out</title></head><body><center><h1>504 Gateway Time-out</h1></center></body></html>',
    kind: 'timeout',
    detail: /^HTTP 504: an HTML page, not JSON$/,
  },
  { name: 'a 503 is the service failing: busy', status: 503, text: JSON.stringify({ error: { message: 'unavailable', type: 'server_error' } }), kind: 'busy', detail: /^HTTP 503: server_error: unavailable$/ },
  { name: 'a 500 is the service failing: busy', status: 500, text: 'internal error', kind: 'busy', detail: /^HTTP 500: internal error$/ },
]

for (const failure of failures) {
  test(`${failure.name}`, async () => {
    const net = network(() => ({ status: failure.status, text: failure.text, headers: failure.headers ?? {} }))
    const asked = await pplxBackend(KEY).ask(net.io, REQUEST, 1500)

    if (asked.ok) throw new Error('answered')
    expect(asked.failure.kind).toBe(failure.kind)
    expect(asked.failure.status).toBe(failure.status)
    expect(asked.failure.detail).toMatch(failure.detail)
  })
}

test('an answer that is not JSON, or has no answers, is a parse failure with the start of the body', async () => {
  const notJson = await pplxBackend(KEY).ask(network(() => ({ status: 200, text: '<html>welcome</html>' })).io, REQUEST, 1500)
  expect(notJson).toEqual({ ok: false, failure: { kind: 'parse', detail: 'not JSON: <html>welcome</html>' } })

  const noAnswers = await pplxBackend(KEY).ask(network(() => json(200, { model: 'pplx-decider-v1.1-27b', usage: { input_tokens: 1, output_tokens: 0 } })).io, REQUEST, 1500)
  expect(noAnswers).toMatchObject({ ok: false, failure: { kind: 'parse' } })
  expect(noAnswers.ok ? '' : noAnswers.failure.detail).toMatch(/^no answers: /)
})

test('an answer of another type than its question is left out, as with the other backends: the feature reads it as no decision', async () => {
  const wrong = { ...DOCUMENTED, answers: { ...DOCUMENTED.answers, 'review.defect': { type: 'choice', choice: 'x', probabilities: { x: 1 } } } }
  const asked = await pplxBackend(KEY).ask(network(() => json(200, wrong)).io, REQUEST, 1500)
  if (!asked.ok) throw new Error('not answered')
  const answers = answersFor(PART, asked.answers)
  expect(Object.keys(answers).sort()).toEqual(['sentiment', 'severity'])
})

test('a request that never completes is a network failure; one that does not answer in time is a timeout', async () => {
  const dropped: BackendIo = { fetch: async () => Promise.reject(new Error('socket hang up')), sleep: () => new Promise(() => {}) }
  expect(await pplxBackend(KEY).ask(dropped, REQUEST, 1500)).toEqual({ ok: false, failure: { kind: 'network', detail: 'socket hang up' } })

  const slow = network(() => json(200, DOCUMENTED), { never: true })
  expect(await pplxBackend(KEY).ask(slow.io, REQUEST, 1500)).toEqual({ ok: false, failure: { kind: 'timeout', detail: 'no answer in 1500 ms' } })
})

test('the key is never in a failure: where the API echoes it, it is replaced', async () => {
  const net = network(() => json(401, { error: { message: 'Invalid API key provided: pplx-secret-123', type: 'invalid_api_key', code: 401 } }))
  const asked = await pplxBackend('pplx-secret-123').ask(net.io, REQUEST, 1500)

  if (asked.ok) throw new Error('answered')
  expect(asked.failure.detail).not.toContain('pplx-secret-123')
  expect(asked.failure.detail).toContain('[REDACTED]')
})

test('the model can be pinned to the earlier version the API also takes', async () => {
  const net = network(() => json(200, { ...DOCUMENTED, model: 'pplx-decider-v1-27b' }))
  const asked = await pplxBackend(KEY, { model: 'pplx-decider-v1-27b' }).ask(net.io, REQUEST, 1500)

  expect(net.seen[0]?.body.model).toBe('pplx-decider-v1-27b')
  expect(asked).toMatchObject({ ok: true, model: 'pplx-decider-v1-27b' })
})
