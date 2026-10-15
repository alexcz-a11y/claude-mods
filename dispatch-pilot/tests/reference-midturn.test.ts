// Image routing, the second half (#64, ADR 0008): a reference image met in the middle of a turn. Seam 1: the engine in (a Read of a
// picture, a message with images typed into a running turn); out, the requests the mod sends (the reading of the images, then the
// mid-turn re-decision with `reference_complexity` in its state) and the effort the next step goes out at.

import { expect, test } from 'claude-code/testing'
import { estimateTokens } from '../hooks/decision/context.ts'
import type { FakeImage } from './support/images.ts'
import type { PastedImage } from './support/pasted.ts'
import { jev, type Reply, type Sent, world } from './support/world.ts'

const JEV = { decisionModel: 'jev', typesafeApiKey: 'ts-test-key' }
const ON = { 'image-routing': true }

/** The level probabilities that read as `level` (0 to 4): for the complexity question and the effort questions alike. */
const at = (level: number): number[] => [0, 1, 2, 3, 4].map((i) => (i === level ? 1 : 0))

/** A picture that was on the disk before the loop began (mtime 0; the tests start the loop at 1000 ms): the reference the person gave a path to. */
const SCENE: FakeImage = { format: 'png', width: 3000, height: 2000, label: 'scene' }
const FILES = { '/refs/scene.png': SCENE }

const kind = (request: Sent | undefined): string => Object.keys(request?.body?.questions ?? {}).filter((id) => id !== 'effort.unresolved').join(',')

/** Jev reading the images at `reading`, deciding the message at `start` and each mid-turn re-decision at `midturn`. */
const answering =
  (reading: number, start: number, midturn: number, other?: (request: Sent) => Reply | undefined) =>
  (request: Sent): Reply =>
    other?.(request) ?? jev(at(midturn), { scores: { 'complexity.level': at(reading), 'effort.level': at(start), 'midturn.level': at(midturn) } })(request)

/** A step whose one call is a Read of the picture at `path` (a file of the world's disk: the tool returns it as the picture itself). */
const reading = (index: number, path: string) => ({ index, effort: 'medium' as const, tools: [{ tool: 'Read', input: { file_path: path } }] })

test('a Read of a picture that was there before the loop began is read at once and the effort is judged again, with the reading in its state, for the next step', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 1, 3) })
  await w.clock.advance(1000)
  await w.submit('Build the scene in three.js to look like the picture')
  await w.step({ index: 0, effort: 'medium' })
  await w.step(reading(1, '/refs/scene.png'))
  await w.step({ index: 2, effort: 'medium' })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'complexity.level', 'midturn.level'])
  const [, read, again] = w.requests
  expect(read?.headers['TypeSafe-Danger-Zone-Images']).toBe('true')
  expect(Object.keys(read?.body.assets)).toHaveLength(1)
  expect(again?.body.state.step).toBe(2)
  expect(again?.body.state.reference_complexity).toMatchObject({ level: 3, images: 1 })
  expect(again?.body.assets).toBeUndefined()
  // The answer is taken before the next step goes out (level 3 is xhigh).
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'xhigh'])
})

test('a picture the agent made in this loop is not a reference: a Read of it asks nothing', { options: JEV }, async ($, on) => {
  // Changed after the turn started (the mock clock reads 0 then): a screenshot or a frame the agent took itself.
  const w = world($, on, { switches: ON, files: { '/shots/now.png': { ...SCENE, label: 'shot', mtimeMs: 5000 } }, process: true, backend: answering(3, 1, 3) })
  await w.clock.advance(1000)
  await w.submit('Build the scene in three.js to look like the picture')
  await w.step({ index: 0, effort: 'medium' })
  await w.step(reading(1, '/shots/now.png'))
  await w.step({ index: 2, effort: 'medium' })

  expect(w.requests.map(kind)).toEqual(['effort.level'])
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'medium'])
})

test('a picture changed in an earlier turn is a reference again in a later one: the loop is the turn', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: { '/shots/old.png': { ...SCENE, label: 'old shot', mtimeMs: 1500 } }, process: true, backend: answering(3, 1, 3) })
  await w.clock.advance(1000)
  await w.submit('Build the scene in three.js')
  await w.step({ index: 0, effort: 'medium' })
  await w.clock.advance(60_000)
  await w.complete()
  await w.submit('Now compare it with the shot you took')
  await w.step({ index: 0, effort: 'medium' })
  await w.step(reading(1, '/shots/old.png'))
  await w.step({ index: 2, effort: 'medium' })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'effort.level', 'complexity.level', 'midturn.level'])
})

test('by default the feature is off: a Read of a picture is read as it always was, no image leaves the machine', { options: JEV }, async ($, on) => {
  const w = world($, on, { files: FILES, process: true, backend: answering(3, 1, 3) })
  await w.clock.advance(1000)
  await w.submit('Build the scene in three.js to look like the picture')
  await w.step({ index: 0, effort: 'medium' })
  await w.step(reading(1, '/refs/scene.png'))
  await w.step({ index: 2, effort: 'medium' })

  expect(w.requests.map(kind)).toEqual(['effort.level'])
  expect(w.ran).toEqual([])
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'medium'])
})

test("the person's lock still wins: the effort of the next step is the locked one", { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, session: true, files: FILES, process: true, backend: answering(3, 1, 3) })
  await w.clock.advance(1000)
  await w.start()
  await w.command('dp', 'lock low')
  await w.submit('Build the scene in three.js to look like the picture')
  await w.step({ index: 0, effort: 'medium' })
  await w.step(reading(1, '/refs/scene.png'))
  await w.step({ index: 2, effort: 'medium' })

  expect(w.requests.map(kind)).not.toContain('midturn.level')
  expect(w.steps.map((s) => String(s.effort))).toEqual(['low', 'low', 'low'])
})

test('a dispatched agent reading a picture does not judge the main agent again', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 1, 3) })
  await w.clock.advance(1000)
  await w.submit('Build the scene in three.js to look like the picture')
  await w.step({ index: 0, effort: 'medium' })
  await w.step({ ...reading(0, '/refs/scene.png'), agentId: 'a1' })
  await w.step({ index: 1, effort: 'medium' })

  expect(w.requests.map(kind)).toEqual(['effort.level'])
})

test('the same pictures read again are not asked twice, and each Read still judges the effort again', { options: { ...JEV, rejudgeEvery: 0 } }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 1, 3) })
  await w.clock.advance(1000)
  await w.submit('Build the scene in three.js to look like the picture')
  await w.step({ index: 0, effort: 'medium' })
  await w.step(reading(1, '/refs/scene.png'))
  await w.step(reading(2, '/refs/scene.png'))
  await w.step({ index: 3, effort: 'medium' })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'complexity.level', 'midturn.level', 'midturn.level'])
  expect(w.requests[3]?.body.state.reference_complexity).toMatchObject({ level: 3, images: 1 })
})

test('several pictures read in one step are one re-decision for the step', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: { ...FILES, '/refs/city.png': { ...SCENE, label: 'city' } }, process: true, backend: answering(3, 1, 3) })
  await w.clock.advance(1000)
  await w.submit('Build the scene in three.js to look like the pictures')
  await w.step({ index: 0, effort: 'medium' })
  await w.step({
    index: 1,
    effort: 'medium',
    parallel: true,
    tools: [
      { tool: 'Read', input: { file_path: '/refs/scene.png' } },
      { tool: 'Read', input: { file_path: '/refs/city.png' } },
    ],
  })
  await w.step({ index: 2, effort: 'medium' })

  expect(w.requests.filter((r) => kind(r) === 'midturn.level')).toHaveLength(1)
})

test('a re-decision the schedule had already asked for the step is replaced by the one that knows of the pictures', { options: { ...JEV, rejudgeEvery: 2 } }, async ($, on) => {
  // Step 1's call starts the schedule's re-decision for step 2; the picture is read in the same step.
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 1, 3) })
  await w.clock.advance(1000)
  await w.submit('Build the scene in three.js to look like the picture')
  await w.step({ index: 0, effort: 'medium' })
  await w.step(reading(1, '/refs/scene.png'))
  await w.step({ index: 2, effort: 'medium' })

  const asked = w.requests.filter((r) => kind(r) === 'midturn.level')
  expect(asked.map((r) => r.body.state.reference_complexity !== undefined)).toEqual([false, true])
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'xhigh'])
})

test('without a reading the effort is judged again all the same: the image could not be read', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 1, 3, (request) => (kind(request) === 'complexity.level' ? { status: 500, body: 'down' } : undefined)) })
  await w.clock.advance(1000)
  await w.submit('Build the scene in three.js to look like the picture')
  await w.step({ index: 0, effort: 'medium' })
  await w.step(reading(1, '/refs/scene.png'))
  await w.step({ index: 2, effort: 'medium' })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'complexity.level', 'midturn.level'])
  expect(w.requests[2]?.body.state.reference_complexity).toBeUndefined()
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'xhigh'])
  expect((await w.board()).notes).toEqual([expect.objectContaining({ feature: 'image-routing', kind: 'failed' })])
  expect(w.toasts).toEqual([])
})

test('the re-decision made with a reading says so on its card', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 1, 3) })
  await w.clock.advance(1000)
  await w.submit('Build the scene in three.js to look like the picture')
  await w.step({ index: 0, effort: 'medium' })
  await w.step(reading(1, '/refs/scene.png'))
  await w.step({ index: 2, effort: 'medium' })

  expect((await w.board()).log.find((entry) => entry.feature === 'midturn-effort')).toMatchObject({ outcome: expect.stringContaining('xhigh'), reference: { level: 3, images: 1 } })
})

test('the re-decision with the reading stays within the budget of a re-decision: the reading takes its place and the steps are cut to the rest', { options: { ...JEV, contextTokens: 300 } }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 1, 3) })
  await w.clock.advance(1000)
  await w.submit('Build the scene in three.js to look like the picture')
  await w.step({ index: 0, effort: 'medium', answer: 'a long thought about the lighthouse '.repeat(40) })
  await w.step({ ...reading(1, '/refs/scene.png'), answer: 'another long thought about the planks '.repeat(40) })
  await w.step({ index: 2, effort: 'medium' })

  const state = w.requests.find((request) => kind(request) === 'midturn.level')?.body.state
  expect(state.reference_complexity).toMatchObject({ level: 3 })
  expect(estimateTokens(JSON.stringify(state))).toBeLessThanOrEqual(300)
})

// ---- A message with images typed into the running turn ------------------------------------------------------------------------------

/** The picture the person pastes: the engine's scaled copy, and the original the row names. */
const PASTED: PastedImage = { path: '/refs/scene.png', shown: { format: 'png', width: 2000, height: 1333, label: 'shown-scene' } }

test('a message with images typed into the running turn is read and the effort judged again, for the next step', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 1, 3) })
  await w.clock.advance(1000)
  await w.submit('Build the scene in three.js')
  await w.step({ index: 0, effort: 'medium' })
  await w.submit('Here is what it should look like', { turnId: 't1', images: [PASTED] })
  await w.step({ index: 1, effort: 'medium' })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'effort.level', 'complexity.level', 'midturn.level'])
  expect(w.requests[3]?.body.state.reference_complexity).toMatchObject({ level: 3, images: 1 })
  expect(w.requests[3]?.body.assets).toBeUndefined()
  expect(w.steps.at(-1)?.effort).toBe('xhigh')
})

test('a message typed in without images reads nothing', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 1, 3) })
  await w.clock.advance(1000)
  await w.submit('Build the scene in three.js')
  await w.step({ index: 0, effort: 'medium' })
  await w.submit('Make the water bluer', { turnId: 't1' })
  await w.step({ index: 1, effort: 'medium' })

  expect(w.requests.map(kind)).toEqual(['effort.level', 'effort.level'])
})

test('a message with images that a hook beneath refuses reads nothing', { options: JEV }, async ($, on) => {
  const w = world($, on, { switches: ON, files: FILES, process: true, backend: answering(3, 1, 3), beneath: { drop: (text) => (text.startsWith('Here') ? 'blocked' : undefined) } })
  await w.clock.advance(1000)
  await w.submit('Build the scene in three.js')
  await w.step({ index: 0, effort: 'medium' })
  expect(await w.submit('Here is what it should look like', { turnId: 't1', images: [PASTED] })).toEqual({ drop: 'blocked' })
  await w.step({ index: 1, effort: 'medium' })

  // The message's effort was asked when it was sent, as any message's; its images were not read.
  expect(w.requests.map(kind)).toEqual(['effort.level', 'effort.level'])
})
