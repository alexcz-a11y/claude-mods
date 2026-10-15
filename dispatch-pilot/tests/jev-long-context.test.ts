// Jev's long context (docs.typesafe.ai/models, Long context; 2026-10-14): a request that carries the
// `TypeSafe-Danger-Zone-Long-Context: true` header may hold 262k tokens for the request and for the state with any one
// question, on Jev 1.14 and 1.13 alike. The eval asks with it (eval/run.ts --long-context) to measure what a longer state
// gains; the mod's own backend is built without it, so its requests go out exactly as before. Seam 2: the backend's `ask`
// over a fake network, as image-request.test.ts has it.

import type { HttpResponse } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { BackendIo } from '../hooks/decision/backend.ts'
import { imageRef } from '../hooks/decision/images.ts'
import { JEV_LONG_CONTEXT_HEADER, jevBackend } from '../hooks/decision/jev.ts'
import type { DecisionRequest } from '../hooks/decision/system-one.ts'

const KEY = 'ts-test-key-1234567890'

type Seen = { headers: Record<string, string>; body: any }

function network() {
  const seen: Seen[] = []
  const io: BackendIo = {
    fetch: async (_url, init) => {
      seen.push({ headers: { ...(init.headers as Record<string, string>) }, body: JSON.parse(String(init.body)) })
      const out: Partial<HttpResponse> & { status: number } = { status: 200, text: JSON.stringify({ model: 'jev-1.14.0', answers: { done: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 90000, output_tokens: 0 } }) }
      return { headers: {}, text: '', ...out, ok: true }
    },
    sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))),
  }
  return { io, seen }
}

const PLAIN: DecisionRequest = { state: { messages: ['a long conversation'] }, questions: { done: { type: 'noul', instructions: 'Is it done?' } } }

test('a Jev backend built for long context sends every request with the long-context header, and the body as it always was', async () => {
  const net = network()
  const asked = await jevBackend(KEY, { model: 'jev-1.14.0', longContext: true }).ask(net.io, PLAIN, 60_000)

  expect(asked.ok).toBe(true)
  const [sent] = net.seen
  expect(JEV_LONG_CONTEXT_HEADER).toBe('TypeSafe-Danger-Zone-Long-Context')
  expect(sent?.headers['TypeSafe-Danger-Zone-Long-Context']).toBe('true')
  expect(sent?.headers.authorization).toBe(`Bearer ${KEY}`)
  expect(sent?.body).toEqual({ model: 'jev-1.14.0', state: PLAIN.state, questions: PLAIN.questions })
})

test('a Jev backend built as the mod builds it sends no long-context header', async () => {
  const net = network()
  await jevBackend(KEY).ask(net.io, PLAIN, 1500)

  const [sent] = net.seen
  expect(Object.keys(sent?.headers ?? {}).some((name) => name.toLowerCase() === 'typesafe-danger-zone-long-context')).toBe(false)
})

test('a request with images to a long-context backend carries both headers', async () => {
  const net = network()
  const withImage: DecisionRequest = { state: { shot: imageRef('shot') }, questions: { done: { type: 'noul', instructions: 'Is `shot` blank?' } }, images: [{ name: 'shot', format: 'png', base64: 'SHOTBASE64==', width: 800, height: 600 }] }
  await jevBackend(KEY, { longContext: true, newId: () => 'u1' }).ask(net.io, withImage, 8000)

  const [sent] = net.seen
  expect(sent?.headers['TypeSafe-Danger-Zone-Images']).toBe('true')
  expect(sent?.headers['TypeSafe-Danger-Zone-Long-Context']).toBe('true')
})
