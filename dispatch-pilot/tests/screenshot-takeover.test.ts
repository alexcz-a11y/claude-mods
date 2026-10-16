// The screenshot takeover (#62, spec #55 「截图接管」): with the switch on, an image the agent's own loop made does not reach the
// agent. A Read of such a file, and the image blocks of a screenshot tool's result, are swapped for a note that says where the
// image is and how to have it checked. Seam 1: the world plays the engine under the mod (`w.read`, `w.callTool` call
// `$.tool.call`, which runs the mod's hooks and ends at the world's tools); what a test reads is the result the agent gets.

import { expect, test } from 'claude-code/testing'
import { jev, KEY, world } from './support/world.ts'

const OPTIONS = { ...KEY, rejudgeEvery: 0 }
const ON = { 'screenshot-takeover': true }
const SHOT = '/shots/home.png'
const IMAGE = { format: 'png', width: 1200, height: 800 }
const BACKEND = jev([0, 1, 0, 0, 0])

/** What the agent is told in place of an image: the text of a Read result in its text form. */
function noteOf(result: any): string {
  return result.result?.file?.content ?? ''
}

/** What a Read gave: `image` when the agent was shown the image, `text` when it got a note or a file's text. */
const kindOf = (read: { result?: unknown }): unknown => (read.result as { type?: unknown } | undefined)?.type

test('the takeover is off until the person turns it on: the agent reads its own screenshot as an image', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, process: true, backend: BACKEND })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  w.save(SHOT, IMAGE)

  const read = await w.read(SHOT)
  expect(kindOf(read)).toBe('image')
  expect(read.text).toContain('[Image:')
})

test('on: a screenshot the loop made is read as a note, never as an image, and nothing of the engine\'s [Image: ...] stays', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, process: true, switches: ON, backend: BACKEND })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  w.save(SHOT, IMAGE)

  const read = await w.read(SHOT)
  expect(kindOf(read)).toBe('text')
  expect((read.result as any).file.filePath).toBe(SHOT)
  const note = noteOf(read)
  expect(note).toContain(SHOT)
  expect(note).toContain('1200x800')
  expect(note).toContain('visual_check')
  expect(note).toContain('look: true')
  // No image block, no [Image: ...] text, no reference to the engine's own message for it.
  const everything = JSON.stringify(read)
  expect(everything).not.toContain('[Image:')
  expect(everything).not.toContain('"image"')
  expect(everything).not.toContain('base64')
  expect(read.text).toBeUndefined()
  expect(read.ref).toBeUndefined()
})

test('an image file that was there before the loop began is read as an image: a reference image, the design the agent was given', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, process: true, switches: ON, files: { '/design/home.png': { ...IMAGE, mtimeMs: 1000 } }, backend: BACKEND })
  await w.start()
  await w.clock.advance(60_000)
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })

  const read = await w.read('/design/home.png')
  expect(kindOf(read)).toBe('image')
  expect(read.text).toContain('[Image:')
})

test('a file saved in the very millisecond the loop began is the loop\'s; one saved a millisecond before is a reference', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, process: true, switches: ON, backend: BACKEND })
  await w.start()
  await w.clock.advance(5000)
  w.save('/design/older.png', IMAGE)
  await w.clock.advance(1)
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  w.save('/shots/same-moment.png', IMAGE)

  expect(kindOf(await w.read('/design/older.png'))).toBe('image')
  expect(kindOf(await w.read('/shots/same-moment.png'))).toBe('text')
})

test('a new turn is a new loop: what an earlier turn made is a reference image in the next', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, process: true, switches: ON, backend: BACKEND })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  await w.clock.advance(1000)
  w.save(SHOT, IMAGE)
  expect(kindOf(await w.read(SHOT))).toBe('text')
  await w.complete()

  await w.clock.advance(60_000)
  await w.submit('再改一下按钮')
  await w.step({ index: 0 })
  expect(kindOf(await w.read(SHOT))).toBe('image')
})

test('something that is not an image is left alone', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, process: true, switches: ON, disk: { '/work/notes.md': 'hello' }, backend: BACKEND })
  await w.start()
  await w.submit('看看笔记')
  await w.step({ index: 0 })

  const read = await w.read('/work/notes.md')
  expect(read.result).toBe('ok')
  expect(read.text).toBe('ok')
})

test('a dispatched agent\'s loop begins at its agent.spawn: what the main agent saved before it is a reference to the agent, and what the agent saves is its own', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, process: true, switches: ON, backend: BACKEND })
  await w.start()
  await w.submit('审查改动并核对首页')
  await w.step({ index: 0 })
  w.save('/shots/before.png', IMAGE)
  await w.clock.advance(5000)
  const started = await w.spawn({ prompt: 'Check the home screen against the design.', description: '核对首页' })
  await w.step({ index: 0, turnId: 'sub-1', agentId: started.agentId })
  await w.clock.advance(5000)
  w.save('/shots/during.png', IMAGE)

  // The agent: the earlier file is something it was handed; the later one it made.
  expect(kindOf(await w.read('/shots/before.png', { agentId: started.agentId }))).toBe('image')
  expect(kindOf(await w.read('/shots/during.png', { agentId: started.agentId }))).toBe('text')
  // The main agent's loop began with its turn: both files are its own.
  expect(kindOf(await w.read('/shots/before.png'))).toBe('text')
})

test('an agent whose spawn was not seen begins its loop at its first turn.start; one never seen at all is not known to have made anything', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, process: true, switches: ON, backend: BACKEND })
  await w.start()
  await w.submit('审查改动并核对首页')
  await w.step({ index: 0 })
  await w.step({ index: 0, turnId: 'sub-1', agentId: 'ghost' })
  await w.clock.advance(5000)
  w.save(SHOT, IMAGE)

  expect(kindOf(await w.read(SHOT, { agentId: 'ghost' }))).toBe('text')
  // No beginning to measure from: which files are older cannot be told, and the image is left as it is.
  expect(kindOf(await w.read(SHOT, { agentId: 'stranger' }))).toBe('image')
})

test('an agent that is resumed begins a loop again at its spawn', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, process: true, switches: ON, backend: BACKEND })
  await w.start()
  await w.submit('审查改动并核对首页')
  await w.step({ index: 0 })
  const started = await w.spawn({ prompt: 'Check the home screen.', description: '核对首页' })
  await w.step({ index: 0, turnId: 'sub-1', agentId: started.agentId })
  await w.clock.advance(5000)
  w.save(SHOT, IMAGE)
  expect(kindOf(await w.read(SHOT, { agentId: started.agentId }))).toBe('text')

  await w.clock.advance(60_000)
  await w.spawn({ prompt: 'Look at it again.', description: '再核对', resume: { agentId: started.agentId ?? '' } })
  expect(kindOf(await w.read(SHOT, { agentId: started.agentId }))).toBe('image')
})

test('without visual_check to send the images to, the takeover leaves them: the check\'s switch is off', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, process: true, switches: { ...ON, 'visual-check': false }, backend: BACKEND })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  w.save(SHOT, IMAGE)
  expect(kindOf(await w.read(SHOT))).toBe('image')
})

test('without a key for a decision model that takes images, nothing is taken over', { options: { decisionModel: 'jev' } }, async ($, on) => {
  const w = world($, on, { session: true, process: true, switches: ON, backend: BACKEND })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  w.save(SHOT, IMAGE)
  expect(kindOf(await w.read(SHOT))).toBe('image')
})

test('while Dispatch Pilot as a whole is off, nothing is taken over', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, process: true, switches: ON, backend: BACKEND })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  w.save(SHOT, IMAGE)
  await w.command('dp', 'off')
  expect(kindOf(await w.read(SHOT))).toBe('image')
})
