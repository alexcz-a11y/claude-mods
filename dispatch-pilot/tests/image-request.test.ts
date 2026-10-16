// Decision requests that carry images (#56, ADR 0008): how each backend sends them. Seam 2 (the backend's `ask` over a fake
// network, as pplx.test.ts has it): a request holds `images` (a name, the bytes as base64, the size) and its state and
// questions refer to each by `imageRef(name)`; Jev sends them in the top-level `assets` under references that start with a
// new id for each request, with the images header and the pinned model; pplx sends a state that is an array of text and
// `image_url` parts. A request without images goes out exactly as before (pplx.test.ts and the rest of the suite).

import type { HttpResponse } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { describeAsked, type BackendIo } from '../hooks/decision/backend.ts'
import { imageRef, imageTokens } from '../hooks/decision/images.ts'
import { JEV_MODEL, jevBackend } from '../hooks/decision/jev.ts'
import { pplxBackend } from '../hooks/decision/pplx.ts'
import type { DecisionRequest, RequestImage } from '../hooks/decision/system-one.ts'

const KEY = 'ts-test-key-1234567890'

type Seen = { url: string; headers: Record<string, string>; body: any }

/** A fake network: every request is kept and answered with `reply`. */
function network(reply: (seen: Seen) => Partial<HttpResponse> & { status: number }) {
  const seen: Seen[] = []
  const io: BackendIo = {
    fetch: async (url, init) => {
      const one: Seen = { url, headers: { ...(init.headers as Record<string, string>) }, body: JSON.parse(String(init.body)) }
      seen.push(one)
      const out = reply(one)
      return { headers: {}, text: '', ...out, ok: out.status >= 200 && out.status < 300 }
    },
    sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))),
  }
  return { io, seen }
}

const ANSWER = { status: 200, text: JSON.stringify({ model: JEV_MODEL, answers: { 'check.same': { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 5000, output_tokens: 0 } }) }

const image = (name: string, extra: Partial<RequestImage> = {}): RequestImage => ({ name, format: 'png', base64: `${name.toUpperCase()}BASE64==`, width: 1000, height: 1000, ...extra })

/** The design and a screenshot to compare it with: both in the state, and a question that points at a crop of each. */
const COMPARE: DecisionRequest = {
  state: { reference: imageRef('reference'), candidate: imageRef('candidate'), note: 'the login screen' },
  questions: {
    'check.same': { type: 'noul', instructions: 'Is `candidate` visually identical to `reference`?' },
    'check.corner': { type: 'noul', instructions: { question: 'Is the corner the same?', a: imageRef('crop-a'), b: `next to ${imageRef('crop-b')}` } },
  },
  images: [image('reference'), image('candidate', { format: 'jpeg' }), image('crop-a'), image('crop-b')],
}

test('a Jev request with images has the images in a top-level assets map, under references that start with an id made for the request, and the state and the questions use those references', async () => {
  const net = network(() => ANSWER)
  const asked = await jevBackend(KEY, { newId: () => 'u1' }).ask(net.io, COMPARE, 1500)

  expect(asked.ok).toBe(true)
  const [sent] = net.seen
  expect(sent?.body.assets).toEqual({
    'u1-reference': { type: 'image', format: 'png', data_base64: 'REFERENCEBASE64==' },
    'u1-candidate': { type: 'image', format: 'jpeg', data_base64: 'CANDIDATEBASE64==' },
    'u1-crop-a': { type: 'image', format: 'png', data_base64: 'CROP-ABASE64==' },
    'u1-crop-b': { type: 'image', format: 'png', data_base64: 'CROP-BBASE64==' },
  })
  expect(sent?.body.state).toEqual({ reference: 'u1-reference', candidate: 'u1-candidate', note: 'the login screen' })
  expect(sent?.body.questions['check.corner'].instructions).toEqual({ question: 'Is the corner the same?', a: 'u1-crop-a', b: 'next to u1-crop-b' })
  // The sizes are the mod's own bookkeeping, not part of the API's body.
  expect(Object.keys(sent?.body).sort()).toEqual(['assets', 'model', 'questions', 'state'])
})

test('a Jev request with images carries the images header and pins the model to jev-1.14.0, whatever model the backend is built with', async () => {
  const net = network(() => ANSWER)
  await jevBackend(KEY, { model: 'jev-1.13.0' }).ask(net.io, COMPARE, 1500)

  const [sent] = net.seen
  expect(sent?.headers['TypeSafe-Danger-Zone-Images']).toBe('true')
  expect(sent?.headers.authorization).toBe(`Bearer ${KEY}`)
  expect(sent?.body.model).toBe('jev-1.14.0')
})

test('each Jev request gets references of its own: the same images in two requests are not under the same references', async () => {
  const net = network(() => ANSWER)
  const backend = jevBackend(KEY)
  await backend.ask(net.io, COMPARE, 1500)
  await backend.ask(net.io, COMPARE, 1500)

  const [first, second] = net.seen.map((sent) => Object.keys(sent.body.assets))
  expect(first).toHaveLength(4)
  expect(first?.every((reference) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-(reference|candidate|crop-a|crop-b)$/.test(reference))).toBe(true)
  expect(first?.some((reference) => second?.includes(reference))).toBe(false)
})

test('a Jev request without images is what it was: the current model, no assets, no images header', async () => {
  const net = network(() => ANSWER)
  const plain: DecisionRequest = { state: { note: 'x' }, questions: { 'check.same': { type: 'noul', instructions: 'Is it?' } } }
  await jevBackend(KEY).ask(net.io, plain, 1500)

  const [sent] = net.seen
  expect(sent?.body).toEqual({ model: JEV_MODEL, state: { note: 'x' }, questions: plain.questions })
  expect(Object.keys(sent?.headers ?? {}).sort()).toEqual(['authorization', 'content-type'])
})

test('an image the request never refers to is a bad request that is not sent (Jev answers 400 to an asset nothing uses)', async () => {
  const net = network(() => ANSWER)
  const asked = await jevBackend(KEY).ask(net.io, { ...COMPARE, images: [...(COMPARE.images ?? []), image('spare')] }, 1500)

  expect(net.seen).toEqual([])
  expect(asked).toEqual({ ok: false, failure: { kind: 'request', detail: expect.stringContaining('spare') } })
})

// ---- what they cost ------------------------------------------------------------------------------------

test('Jev counts about 2,600 tokens a megapixel, once for each image however many questions use it; pplx about 1,000, again for every question', () => {
  const shots = [image('a', { width: 1000, height: 1000 }), image('b', { width: 500, height: 400 })]
  // 1.2 megapixels in all.
  expect(imageTokens('jev', shots, 1)).toBe(3120)
  expect(imageTokens('jev', shots, 7)).toBe(3120)
  expect(imageTokens('pplx', shots, 1)).toBe(1200)
  expect(imageTokens('pplx', shots, 7)).toBe(8400)
  expect(imageTokens('jev', [], 3)).toBe(0)
})

test('the debug log line of a request with images says how many, their sizes and the tokens they are estimated at, and never the images themselves', async () => {
  const jev = await jevBackend(KEY).ask(network(() => ANSWER).io, COMPARE, 1500)
  const pplx = await pplxBackend('pplx-test-key').ask(network(() => PPLX_ANSWER).io, COMPARE, 1500)

  // 4 images of 1000 x 1000 and 2 questions: Jev 4 x 2,600; pplx 4 x 1,000 x 2.
  expect(describeAsked(jev, 310)).toBe(`answered in 310 ms by ${JEV_MODEL} (5000 input tokens); images: 4 (1000x1000, 1000x1000, 1000x1000, 1000x1000), about 10400 tokens`)
  expect(describeAsked(pplx, 310)).toBe('answered in 310 ms by pplx-decider-v1.1-27b (9000 input tokens); images: 4 (1000x1000, 1000x1000, 1000x1000, 1000x1000), about 8000 tokens')
})

test('a request with images that fails says so in the debug log too: a refused one, a bad one, and an HTTP error whose body echoes the images back', async () => {
  const echoing = network((seen) => ({ status: 400, text: `bad request: ${JSON.stringify(seen.body)}` }))
  const heavy = { ...COMPARE, images: COMPARE.images?.map((shot) => ({ ...shot, base64: 'QUJD'.repeat(40) + shot.base64 })) }
  const jev = await jevBackend(KEY).ask(echoing.io, heavy, 1500)
  const pplx = await pplxBackend('pplx-test-key').ask(network(() => ({ status: 400, text: '{"error":{"message":"At most 8 images are allowed per question","type":"invalid_request_error"}}' })).io, COMPARE, 1500)

  expect(describeAsked(jev, 20)).toContain('images: 4 (')
  expect(describeAsked(pplx, 20)).toContain('HTTP 400: invalid_request_error: At most 8 images are allowed per question')
  expect(describeAsked(pplx, 20)).toContain('images: 4 (')
  // Nor the key, if the API echoes that back.
  const keyed = await jevBackend(KEY).ask(network(() => ({ status: 400, text: `unauthorized: Bearer ${KEY}` })).io, COMPARE, 1500)
  expect(describeAsked(keyed, 20)).not.toContain(KEY)
  expect(describeAsked(keyed, 20)).toContain('[REDACTED]')
  // An API that echoes the request back put no image into the log.
  const logged = describeAsked(jev, 20) + JSON.stringify(jev)
  for (const content of ['REFERENCEBASE64', 'CANDIDATEBASE64', 'CROP-ABASE64']) expect(logged).not.toContain(content)
})

// ---- pplx ----------------------------------------------------------------------------------------------

const PPLX_ANSWER = { status: 200, text: JSON.stringify({ model: 'pplx-decider-v1.1-27b', answers: { 'check.same': { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 9000, output_tokens: 0 } }) }

test('a pplx request with images has a state that is an array: the state as text, then each image as an image_url data URL after a line that names it; the references in the state and the questions say which', async () => {
  const net = network(() => PPLX_ANSWER)
  const asked = await pplxBackend('pplx-test-key').ask(net.io, COMPARE, 1500)

  expect(asked.ok).toBe(true)
  const [sent] = net.seen
  expect(Object.keys(sent?.body).sort()).toEqual(['model', 'questions', 'state'])
  expect(sent?.body.model).toBe('pplx-decider-v1.1-27b')
  expect(sent?.body.state).toEqual([
    '{"reference":"[image 1: reference]","candidate":"[image 2: candidate]","note":"the login screen"}',
    '[image 1: reference]:',
    { type: 'image_url', image_url: { url: 'data:image/png;base64,REFERENCEBASE64==' } },
    '[image 2: candidate]:',
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,CANDIDATEBASE64==' } },
    '[image 3: crop-a]:',
    { type: 'image_url', image_url: { url: 'data:image/png;base64,CROP-ABASE64==' } },
    '[image 4: crop-b]:',
    { type: 'image_url', image_url: { url: 'data:image/png;base64,CROP-BBASE64==' } },
  ])
  expect(sent?.body.questions['check.corner'].instructions).toEqual({ question: 'Is the corner the same?', a: '[image 3: crop-a]', b: 'next to [image 4: crop-b]' })
})

test('a pplx request with images takes eight and no more: the ninth is an error when the request is built, and nothing is sent', async () => {
  const names = Array.from({ length: 9 }, (_, i) => `shot-${i}`)
  const nine: DecisionRequest = {
    state: Object.fromEntries(names.map((name) => [name, imageRef(name)])),
    questions: { 'check.same': { type: 'noul', instructions: 'Is it the same in all?' } },
    images: names.map((name) => image(name)),
  }
  const net = network(() => PPLX_ANSWER)
  const backend = pplxBackend('pplx-test-key')

  expect(await backend.ask(net.io, nine, 1500)).toEqual({ ok: false, failure: { kind: 'request', detail: expect.stringContaining('at most 8') } })
  expect(net.seen).toEqual([])
  const eight: DecisionRequest = { ...nine, state: Object.fromEntries(names.slice(0, 8).map((name) => [name, imageRef(name)])), images: nine.images?.slice(0, 8) }
  expect((await backend.ask(net.io, eight, 1500)).ok).toBe(true)
  expect(net.seen).toHaveLength(1)
})

test('a pplx request without images keeps its state an object, as before', async () => {
  const net = network(() => PPLX_ANSWER)
  const plain: DecisionRequest = { state: { note: 'x' }, questions: { 'check.same': { type: 'noul', instructions: 'Is it?' } } }
  await pplxBackend('pplx-test-key').ask(net.io, plain, 1500)
  expect(net.seen[0]?.body).toEqual({ model: 'pplx-decider-v1.1-27b', state: { note: 'x' }, questions: plain.questions })
})
