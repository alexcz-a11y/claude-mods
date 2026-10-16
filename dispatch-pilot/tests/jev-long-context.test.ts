// Jev's long context (docs.typesafe.ai/models, Long context; 2026-10-14): a request that carries the
// `TypeSafe-Danger-Zone-Long-Context: true` header may hold 262k tokens for the request and for the state with any one
// question, on Jev 1.14 and 1.13 alike. The mod's backend sends it on a request past the regular limits (2026-10-15,
// ADR 0009): a state over 24000 estimated tokens, or a state and its questions over 48000; every other request goes out
// exactly as before. The eval's --long-context sends it on every request. Seam 2: the backend's `ask` over a fake network,
// as image-request.test.ts has it.

import type { HttpResponse } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { BackendIo } from '../hooks/decision/backend.ts'
import { estimateTokens } from '../hooks/decision/context.ts'
import { imageRef } from '../hooks/decision/images.ts'
import { JEV_LONG_CONTEXT_HEADER, JEV_MODEL, JEV_REGULAR_REQUEST, JEV_REGULAR_STATE, jevBackend, needsLongContext } from '../hooks/decision/jev.ts'
import type { DecisionRequest } from '../hooks/decision/system-one.ts'

const KEY = 'ts-test-key-1234567890'

type Seen = { headers: Record<string, string>; body: any }

function network() {
  const seen: Seen[] = []
  const io: BackendIo = {
    fetch: async (_url, init) => {
      seen.push({ headers: { ...(init.headers as Record<string, string>) }, body: JSON.parse(String(init.body)) })
      const out: Partial<HttpResponse> & { status: number } = { status: 200, text: JSON.stringify({ model: JEV_MODEL, answers: { done: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 90000, output_tokens: 0 } }) }
      return { headers: {}, text: '', ...out, ok: true }
    },
    sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))),
  }
  return { io, seen }
}

const PLAIN: DecisionRequest = { state: { messages: ['a long conversation'] }, questions: { done: { type: 'noul', instructions: 'Is it done?' } } }

/** A request whose state is `tokens` estimated tokens as it is sent (`{"c":"…"}` around Chinese text, one token a character). */
function stateOf(tokens: number): DecisionRequest {
  const request: DecisionRequest = { state: { c: '会'.repeat(tokens - 2) }, questions: PLAIN.questions }
  if (estimateTokens(JSON.stringify(request.state)) !== tokens) throw new Error('the state is not the size asked for')
  return request
}

const hasHeader = (sent: Seen | undefined) => Object.keys(sent?.headers ?? {}).some((name) => name.toLowerCase() === 'typesafe-danger-zone-long-context')

test('a Jev backend built for long context sends every request with the long-context header, and the body as it always was', async () => {
  const net = network()
  const asked = await jevBackend(KEY, { model: JEV_MODEL, longContext: true }).ask(net.io, PLAIN, 60_000)

  expect(asked.ok).toBe(true)
  const [sent] = net.seen
  expect(JEV_LONG_CONTEXT_HEADER).toBe('TypeSafe-Danger-Zone-Long-Context')
  expect(sent?.headers['TypeSafe-Danger-Zone-Long-Context']).toBe('true')
  expect(sent?.headers.authorization).toBe(`Bearer ${KEY}`)
  expect(sent?.body).toEqual({ model: JEV_MODEL, state: PLAIN.state, questions: PLAIN.questions })
})

test('a Jev backend built as the mod builds it sends no long-context header on a request within the regular limits', async () => {
  const net = network()
  await jevBackend(KEY).ask(net.io, PLAIN, 1500)
  await jevBackend(KEY).ask(net.io, stateOf(JEV_REGULAR_STATE), 1500)
  expect(net.seen.map(hasHeader)).toEqual([false, false])
})

test('a request past the regular limits goes with the header, the body as it always was: a state over 24000 estimated tokens, or a state and its questions over 48000', async () => {
  const net = network()
  const backend = jevBackend(KEY)
  const over = stateOf(JEV_REGULAR_STATE + 1)
  await backend.ask(net.io, over, 3000)
  expect(net.seen[0]?.headers['TypeSafe-Danger-Zone-Long-Context']).toBe('true')
  expect(net.seen[0]?.body.state).toEqual(over.state)
  // What waits for it knows it too (core/setup.ts waitFor).
  expect([backend.longContext?.(over), backend.longContext?.(stateOf(JEV_REGULAR_STATE))]).toEqual([true, false])

  // A small state with many long questions: the whole request is what counts.
  const questions = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`q${i}`, { type: 'noul' as const, instructions: '问'.repeat(1300) }]))
  const many: DecisionRequest = { state: { c: 'short' }, questions }
  expect(estimateTokens(JSON.stringify(questions))).toBeGreaterThan(JEV_REGULAR_REQUEST)
  expect(needsLongContext(many)).toBe(true)
})

test('a request with images never goes with the long-context header from the mod: its features keep it within the regular limits', async () => {
  const net = network()
  const withImage: DecisionRequest = { state: { shot: imageRef('shot'), c: '会'.repeat(30000) }, questions: { done: { type: 'noul', instructions: 'Is `shot` blank?' } }, images: [{ name: 'shot', format: 'png', base64: 'SHOTBASE64==', width: 800, height: 600 }] }
  await jevBackend(KEY, { newId: () => 'u1' }).ask(net.io, withImage, 8000)
  expect(net.seen[0]?.headers['TypeSafe-Danger-Zone-Images']).toBe('true')
  expect(hasHeader(net.seen[0])).toBe(false)
})

test('a request with images to a long-context backend carries both headers', async () => {
  const net = network()
  const withImage: DecisionRequest = { state: { shot: imageRef('shot') }, questions: { done: { type: 'noul', instructions: 'Is `shot` blank?' } }, images: [{ name: 'shot', format: 'png', base64: 'SHOTBASE64==', width: 800, height: 600 }] }
  await jevBackend(KEY, { longContext: true, newId: () => 'u1' }).ask(net.io, withImage, 8000)

  const [sent] = net.seen
  expect(sent?.headers['TypeSafe-Danger-Zone-Images']).toBe('true')
  expect(sent?.headers['TypeSafe-Danger-Zone-Long-Context']).toBe('true')
})
