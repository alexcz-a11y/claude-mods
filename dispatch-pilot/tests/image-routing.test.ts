// Image routing (#63, ADR 0008), seam 1: the engine in, a message pasted with reference images; out, the requests the mod sends
// (the reading of the images, then the effort question) and the effort the first step goes out at. The files and sips are the
// world's (tests/support/images.ts), the pasted message's row is appended by the world's engine (tests/support/pasted.ts).

import { expect, test } from 'claude-code/testing'
import { absolute, type Disk, ok, readFake } from './support/images.ts'
import { attachmentsOf, type PastedImage } from './support/pasted.ts'
import { jev, pplx, type Reply, type Sent, world } from './support/world.ts'

const JEV = { decisionModel: 'jev', typesafeApiKey: 'ts-test-key' }
const ON = { 'image-routing': true }

/** The level probabilities that read as `level` (0 to 4), for the complexity question and the effort question. */
const at = (level: number): number[] => [0, 1, 2, 3, 4].map((i) => (i === level ? 1 : 0))

/** The original the engine named for the pasted image (6 MP), and the copy it scaled to fit the model (2000 px). */
const SCENE: PastedImage = { path: '/refs/scene.png', shown: { format: 'png', width: 2000, height: 1333, label: 'shown-scene' } }
const FILES = { '/refs/scene.png': { format: 'png' as const, width: 3000, height: 2000, label: 'scene' } }

const isReading = (request: Sent): boolean => 'complexity.level' in (request.body.questions ?? {})

/** Jev answering the reading with level `reading` and the effort question with level `effort`; `other` may answer a request first. */
const answering =
  (reading: number, effort: number, other?: (request: Sent) => Reply | undefined) =>
  (request: Sent): Reply =>
    other?.(request) ?? jev(at(1), { scores: { 'complexity.level': at(reading), 'effort.level': at(effort) } })(request)

/** The fake Perplexity Decisions API, answering the effort question with `levels` (and other Score questions by their ids). */
const pplxAnswer = (levels: readonly number[], scores: Record<string, readonly number[]> = {}) => pplx(levels, { key: 'pplx-test-key', scores: { 'effort.level': levels, ...scores } })

test('a message with a reference image: the images are read first (to the image backend), then the effort is asked with the reading, and the first step goes out at that effort', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 3) })
  await w.submit('Build this scene in three.js', { images: [SCENE] })
  await w.step({ index: 0 })

  // Two requests, the reading first. The effort question was not asked when the message was sent.
  expect(w.requests).toHaveLength(2)
  const [reading, effort] = w.requests
  expect(Object.keys(reading?.body.questions)).toEqual(['complexity.level'])
  expect(reading?.headers['TypeSafe-Danger-Zone-Images']).toBe('true')
  expect(Object.keys(reading?.body.assets)).toHaveLength(1)
  expect(Object.keys(effort?.body.questions)).toContain('effort.level')
  expect(effort?.body.state.user_message).toBe('Build this scene in three.js')
  expect(effort?.body.state.reference_complexity).toMatchObject({ level: 3, images: 1 })
  expect(effort?.body.assets).toBeUndefined()

  // The first step is at the effort that request decided (level 3 is xhigh).
  expect(w.steps[0]?.effort).toBe('xhigh')
  const board = await w.board()
  expect(board.main?.effort).toBe('xhigh')
  expect(board.log.at(-1)).toMatchObject({ feature: 'main-effort', outcome: 'effort xhigh', reference: { level: 3, images: 1 } })
})

// ---- What does not change ------------------------------------------------------------------------------------------------------

test('by default the feature is off: a message with an image is decided when it is sent, as any message is, and no image leaves the machine', { options: JEV }, async ($, on) => {
  const w = world($, on, { files: FILES, process: true, backend: answering(3, 2) })
  await w.submit('Build this scene in three.js', { images: [SCENE] })
  await w.step({ index: 0 })

  expect(w.requests).toHaveLength(1)
  expect(Object.keys(w.requests[0]?.body.questions)).toContain('effort.level')
  expect(w.requests[0]?.body.state.reference_complexity).toBeUndefined()
  expect(w.requests[0]?.body.assets).toBeUndefined()
  expect(w.steps[0]?.effort).toBe('high')
  expect(w.ran).toEqual([])
})

test('with the switch on, a message without an image goes as it always did: one request when it is sent, the state as it was, no reading', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 2) })
  await w.submit('Rename the helper to buildQueue everywhere')
  await w.step({ index: 0 })

  expect(w.requests).toHaveLength(1)
  const sent = w.requests[0]
  expect(sent?.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(sent?.body.model).toBe('jev-1.14.0')
  expect(Object.keys(sent?.body.state)).toEqual(['user_message', 'recent_context'])
  expect(Object.keys(sent?.body.questions)).toContain('effort.level')
  expect(sent?.body.assets).toBeUndefined()
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  expect(w.ran).toEqual([])
  expect((await w.board()).log.at(-1)?.reference).toBeUndefined()
})

test('a message typed during a running turn, with an image, is decided when it is sent as before: it starts no turn to wait for', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: (request, n) => answering(3, n === 1 ? 1 : 4, (sent) => ('midturn.level' in (sent.body.questions ?? {}) ? jev(at(4))(sent) : undefined))(request) })
  await w.submit('Look at the log first')
  await w.step({ index: 0 })
  await w.submit('And build this scene too', { turnId: 't1', images: [SCENE] })

  // Its effort question went out when it was sent, with no reading in it. (The running turn then reads the image, and judges its
  // effort again for the next step: features/reference-midturn.ts, tests/reference-midturn.test.ts.)
  expect(w.requests.slice(0, 2).map((request) => Object.keys(request.body.questions))).toEqual([['effort.level'], ['effort.level']])
  expect(w.requests[1]?.body.state.reference_complexity).toBeUndefined()
  expect(w.requests[1]?.body.assets).toBeUndefined()
  await w.step({ index: 1 })
  expect(w.steps[1]?.effort).toBe('max')
})

test('a message whose row never came is decided without a reading: the images of an earlier message are not guessed at', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 2) })
  await w.submit('Look at the log first')
  await w.step({ index: 0 })
  // An earlier message with an image that no turn waited for (typed during the running one): its row is noted, and stays.
  await w.submit('And build this scene too', { turnId: 't1', images: [SCENE] })
  await w.step({ index: 1 })
  // The next message says it has an image, but the engine's row for it does not come (the world appends none).
  await $.prompt.submit({ text: 'Build the city', wait: false, origin: { kind: 'composer' }, attachments: attachmentsOf([{ shown: { format: 'png', width: 2000, height: 1200, label: 'shown-city' } }]) })
  await w.step({ index: 0, turnId: 't2' })

  const efforts = w.requests.filter((request) => request.body.state?.user_message === 'Build the city')
  expect(efforts).toHaveLength(1)
  expect(efforts[0]?.body.state.reference_complexity).toBeUndefined()
})

test('a message a hook beneath refuses leaves nothing waiting for a later turn with the same text', { options: JEV }, async ($, on) => {
  let refuse = true
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 2), beneath: { drop: () => (refuse ? 'blocked by a UserPromptSubmit hook' : undefined) } })
  expect(await w.submit('Build this scene', { images: [SCENE] })).toEqual({ drop: 'blocked by a UserPromptSubmit hook' })
  expect(w.requests).toHaveLength(0)
  refuse = false
  await w.submit('Build this scene')
  await w.step({ index: 0 })

  // Sent again without an image: decided when it was sent, no reading.
  expect(w.requests.filter(isReading)).toHaveLength(0)
  expect(w.requests).toHaveLength(1)
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
})

// ---- The same images are read once ------------------------------------------------------------------------------------------

test('the same reference image sent again in the conversation is read once: the second message is decided with the reading kept', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 2) })
  await w.submit('Build this scene', { images: [SCENE] })
  await w.step({ index: 0 })
  await w.submit('Now make the water darker', { images: [SCENE] })
  await w.step({ index: 0 })

  expect(w.requests.filter(isReading)).toHaveLength(1)
  expect(w.requests).toHaveLength(3)
  expect(w.requests[2]?.body.state.reference_complexity).toMatchObject({ level: 3, images: 1 })
  expect(w.steps.map((s) => s.effort)).toEqual(['high', 'high'])
})

test('another image is another reading', { options: JEV }, async ($, on) => {
  const other: PastedImage = { path: '/refs/city.png', shown: { format: 'png', width: 2000, height: 1200, label: 'shown-city' } }
  const w = world($, on, { switches: ON, files: { ...FILES, '/refs/city.png': { format: 'png', width: 2400, height: 1440, label: 'city' } }, process: true, backend: answering(3, 2) })
  await w.submit('Build this scene', { images: [SCENE] })
  await w.submit('Build this city', { images: [other] })

  expect(w.requests.filter(isReading)).toHaveLength(2)
})

// ---- When the reading does not come ---------------------------------------------------------------------------------------------

test('a reading that fails: the effort is decided without it, the first step still goes out at it, and the board notes the failure without a toast', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 3, (request) => (isReading(request) ? { status: 500, body: 'down' } : undefined)) })
  await w.submit('Build this scene', { images: [SCENE] })
  await w.step({ index: 0 })

  expect(w.requests).toHaveLength(2)
  expect(w.requests[1]?.body.state.reference_complexity).toBeUndefined()
  expect(w.steps[0]?.effort).toBe('xhigh')
  const board = await w.board()
  expect(board.log.at(-1)).toMatchObject({ outcome: 'effort xhigh' })
  expect(board.log.at(-1)?.reference).toBeUndefined()
  expect(board.notes).toEqual([expect.objectContaining({ feature: 'image-routing', kind: 'failed', id: 'main' })])
  expect(w.toasts).toEqual([])
})

test('a reading that takes more than about 3 seconds is not waited for: the effort is decided without it', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 2, (request) => (isReading(request) ? { after: 60_000, reply: jev(at(3))(request) } : undefined)) })
  const submitting = w.submit('Build this scene', { images: [SCENE] })
  await w.clock.settle()
  await w.clock.advance(3000)
  await submitting
  await w.step({ index: 0 })

  expect(w.requests).toHaveLength(2)
  expect(w.requests[1]?.body.state.reference_complexity).toBeUndefined()
  expect(w.steps[0]?.effort).toBe('high')
  expect((await w.board()).notes).toEqual([expect.objectContaining({ feature: 'image-routing', kind: 'failed' })])
})

test('an image that cannot be read (the file is gone) is no reading: no request for it, the effort is decided without it', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: {}, process: true, backend: answering(3, 2) })
  await w.submit('Build this scene', { images: [SCENE] })
  await w.step({ index: 0 })

  expect(w.requests).toHaveLength(1)
  expect(w.requests[0]?.body.state.reference_complexity).toBeUndefined()
  expect(w.steps[0]?.effort).toBe('high')
})

test('an image the row gives only as a block, where no program can write it to a file, is no reading: the effort is decided without it', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 2) })
  await w.submit('Build this scene', { images: [{ shown: { format: 'png', width: 2000, height: 1333 } }] })
  await w.step({ index: 0 })

  expect(w.requests.filter(isReading)).toHaveLength(0)
  expect(w.steps[0]?.effort).toBe('high')
})

test('when the effort request fails too, the turn is not routed and says why: it goes out at the engine effort', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 3, (request) => (isReading(request) ? undefined : { status: 503, body: 'overloaded' })) })
  await w.submit('Build this scene', { images: [SCENE] })
  await w.step({ index: 0, effort: 'medium' })

  expect(w.requests).toHaveLength(2)
  expect(w.steps[0]?.effort).toBe('medium')
  expect((await w.board()).main).toMatchObject({ routed: false, effort: 'medium', failure: { backend: 'jev', kind: 'busy' } })
  expect(w.toasts).toHaveLength(1)
})

// ---- The order of precedence is the same ---------------------------------------------------------------------------------------

test("the person's lock still wins: the decision is made and logged, the step goes out at the locked effort", { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, session: true, files: FILES, process: true, backend: answering(3, 4) })
  await w.start()
  await w.command('dp', 'lock low')
  await w.submit('Build this scene', { images: [SCENE] })
  await w.step({ index: 0, effort: 'medium' })

  expect(w.steps.map((s) => String(s.effort))).toEqual(['low'])
  const board = await w.board()
  expect(board.main).toMatchObject({ effort: 'low', locked: true })
  expect(board.log.at(-1)).toMatchObject({ outcome: 'effort max', reference: { level: 3, images: 1 } })
})

// ---- Which decision model gets what ------------------------------------------------------------------------------------------------

test('the images go to Jev, and the effort question to the decision model the person chose (pplx by default)', { options: { typesafeApiKey: 'ts-test-key', perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, {
    switches: ON,
    files: FILES,
    process: true,
    backend: (request) => (request.url.includes('typesafe') ? jev(at(1), { scores: { 'complexity.level': at(3) } })(request) : pplxAnswer(at(2))(request)),
  })
  await w.submit('Build this scene', { images: [SCENE] })
  await w.step({ index: 0 })

  expect(w.requests.map((r) => r.url)).toEqual(['https://api.typesafe.ai/v1/systemone', 'https://api.perplexity.ai/v1/decisions'])
  expect(w.requests[1]?.body.state.reference_complexity).toMatchObject({ level: 3, images: 1 })
  expect(w.steps[0]?.effort).toBe('high')
})

test('with only a Perplexity key the images go to pplx (as image parts of its state), and the effort question too', { options: { perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: pplxAnswer(at(2), { 'complexity.level': at(4) }) })
  await w.submit('Build this scene', { images: [SCENE] })
  await w.step({ index: 0 })

  expect(w.requests.map((r) => r.url)).toEqual(['https://api.perplexity.ai/v1/decisions', 'https://api.perplexity.ai/v1/decisions'])
  const [reading, effort] = w.requests
  expect(Array.isArray(reading?.body.state)).toBe(true)
  expect((reading?.body.state as unknown[]).some((part) => typeof part === 'object' && (part as { type?: string }).type === 'image_url')).toBe(true)
  expect(effort?.body.state.reference_complexity).toMatchObject({ level: 4, images: 1 })
})

// ---- Where the image comes from ---------------------------------------------------------------------------------------------------

test('a row that names no file: the image block itself is written to a file and read', { options: JEV }, async ($, on) => {
  // macOS's `base64 -D -o <file>` decodes its standard input into a file.
  const base64 = (args: readonly string[], disk: Disk, init?: { stdin?: string }) => {
    const out = args[args.indexOf('-o') + 1] as string
    const header = readFake(init?.stdin ?? '')
    if (header === null) return { exitCode: 1, stdout: '', stderr: 'invalid input' }
    disk.files.set(absolute(out), { format: header.format, width: header.width, height: header.height, label: header.label })
    return ok()
  }
  const w = world($, on, { switches: ON, files: {}, process: { programs: { base64 } }, backend: answering(2, 2) })
  await w.submit('Build this scene', { images: [{ shown: { format: 'png', width: 2000, height: 1333, label: 'block-only' } }] })
  await w.step({ index: 0 })

  expect(w.requests.filter(isReading)).toHaveLength(1)
  const asset = Object.values(w.requests[0]?.body.assets)[0] as { data_base64: string }
  expect(readFake(asset.data_base64)?.label).toContain('block-only')
  expect(w.requests[1]?.body.state.reference_complexity).toMatchObject({ level: 2 })
})
