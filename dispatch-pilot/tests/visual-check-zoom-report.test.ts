// visual_check (#59): what the answer carries of the zoomed re-check. A check that fails on its crops brings the crops (the
// screenshot's and the other image's) along; a pass brings no image. The box of "where do the two images differ" is reported as
// "another place may differ", with crops of it, when the model is at least 0.2 sure of it and it covers at most a quarter of the
// screen; the confidence of a named part's box says only how well the model knows the part, and decides nothing. Seam 1, as
// visual-check.test.ts.

import { expect, test } from 'claude-code/testing'
import { readFake } from './support/images.ts'
import { box, zoomBackend } from './support/zoom.ts'
import { world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }
const SHOT = '/shots/home.png'
const DESIGN = '/design/home.png'
const FILES = {
  [SHOT]: { format: 'png', width: 1000, height: 1000 },
  [DESIGN]: { format: 'png', width: 1000, height: 1000 },
}
const BUTTON = { part: 'the primary button', property: 'corner radius' }
const TITLE = { part: 'the title', property: 'font weight' }

type Block = { type: string; text?: string; source?: { data: string } }
function read(answer: { result?: unknown }) {
  const blocks = answer.result as Block[]
  expect(Array.isArray(blocks)).toBe(true)
  const images = blocks.filter((block) => block.type === 'image').map((block) => readFake(block.source?.data as string))
  return { lines: (blocks[0]?.text ?? '').split('\n'), types: blocks.map((block) => block.type), images }
}

test('a check that fails on its crops brings them along: the screenshot\'s first, then the other image\'s, and the text says which is which', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ boxes: { 'box.0.candidate': box(0.4, 0.56, 0.4, 0.6), 'box.0.reference': box(0.4, 0.56, 0.4, 0.6) }, zoom: 0.1 }) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] }))

  expect(answer.types).toEqual(['text', 'image', 'image'])
  expect(answer.images[0]).toMatchObject({ width: 1000, height: 800 })
  expect(answer.images[0]?.label).toContain(`${SHOT} > crop 260x208+370+376`)
  expect(answer.images[1]?.label).toContain(`${DESIGN} > crop 260x208+370+376`)
  expect(answer.lines).toContain('Zoomed crops are attached, in this order: check 1: your screenshot; check 1: the image it is compared with.')
})

test('a pass brings no image; an unsure check brings the screenshot, after the crops of a check that failed', { options: JEV }, async ($, on) => {
  let answering = zoomBackend({ zoom: 0.95 })
  const w = world($, on, { session: true, files: FILES, process: true, backend: (request) => answering(request) })
  await w.start()
  expect(read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] })).types).toEqual(['text'])

  answering = zoomBackend({ zoom: { 'zoom.0.0': 0.1, 'zoom.1.0': 0.5 } })
  const answer = read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON, TITLE] }))
  expect(answer.types).toEqual(['text', 'image', 'image', 'image'])
  // The last image is the whole screenshot, as before.
  expect(answer.images[2]).toMatchObject({ width: 1000, height: 1000, label: '' })
  expect(answer.lines).toContain('Zoomed crops are attached before the screenshot, in this order: check 1: your screenshot; check 1: the image it is compared with.')
  expect(answer.lines).toContain('The screenshot is attached, scaled down: look at it yourself for what is UNSURE.')
})

test('a crop that is nearly all of the image is not brought along: the agent has the image', { options: JEV }, async ($, on) => {
  const everything = box(0, 1, 0, 1)
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ boxes: { 'box.0.candidate': everything, 'box.0.reference': everything }, zoom: 0.1 }) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] }))

  expect(answer.lines[1]).toContain('1. FAIL 0.10 (zoomed crop)')
  expect(answer.types).toEqual(['text'])
})

test('the crops of at most three failed checks go along', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ zoom: 0.05 }) })
  await w.start()
  const checks = ['a', 'b', 'c', 'd'].map((part) => ({ part: `part ${part}`, property: 'shape' }))
  const answer = read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks }))

  expect(answer.lines[0]).toBe('Visual check of /shots/home.png against the reference: 4 FAIL.')
  expect(answer.types).toEqual(['text', ...Array(6).fill('image')])
})

test('the confidence of a named part\'s box says only how well the model knows the part: a part it hardly knows is still judged on its crops', { options: JEV }, async ($, on) => {
  const dim = box(0.4, 0.56, 0.4, 0.6, 0.01)
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ boxes: { 'box.0.candidate': dim, 'box.0.reference': dim }, zoom: 0.95 }) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] }))

  expect(answer.lines[1]).toBe('1. PASS 0.95 (zoomed crop) the primary button: corner radius')
  expect(answer.lines.join('\n')).not.toContain('Another place')
})

test('the box of "where do they differ" is reported as another place, with crops of it, when the model is 0.2 sure of it and it covers a quarter of the screen or less', { options: JEV }, async ($, on) => {
  const place = box(0.1, 0.3, 0.1, 0.6, 0.2)
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ boxes: { 'where.screen': place }, zoom: 0.95 }) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] }))

  expect(answer.lines[0]).toBe('Visual check of /shots/home.png against the reference: 1 PASS.')
  expect(answer.lines).toContain(
    'Another place may differ, which none of your checks named: 10% to 60% across and 10% to 30% down the screenshot (10% of it; the model is 0.20 sure of the place). Crops of it are attached. Look at it yourself.',
  )
  expect(answer.lines).toContain('Zoomed crops are attached, in this order: the other place: your screenshot; the other place: the image it is compared with.')
  // The place is 500 x 200 pixels (x 100 to 600, y 100 to 300): 650 x 260 with the margin, centred on (350, 200); the same piece of both images.
  expect(answer.images.map((image) => image?.label)).toEqual([`${SHOT} > crop 650x260+25+70 > fit 1000x400`, `${DESIGN} > crop 650x260+25+70 > fit 1000x400`])
})

test('a place the model is less than 0.2 sure of, or that covers more than a quarter of the screen, is not reported', { options: JEV }, async ($, on) => {
  let answering = zoomBackend()
  const w = world($, on, { session: true, files: FILES, process: true, backend: (request) => answering(request) })
  await w.start()
  const types = async () => read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] })).types

  answering = zoomBackend({ boxes: { 'where.screen': box(0.1, 0.3, 0.1, 0.6, 0.19) }, zoom: 0.95 })
  expect(await types()).toEqual(['text'])
  answering = zoomBackend({ boxes: { 'where.screen': box(0, 0.5, 0, 0.52, 0.9) }, zoom: 0.95 })
  expect(await types()).toEqual(['text'])
  // A quarter of the screen exactly, and 0.2 exactly, are in.
  answering = zoomBackend({ boxes: { 'where.screen': box(0, 0.5, 0, 0.5, 0.2) }, zoom: 0.95 })
  expect(await types()).toEqual(['text', 'image', 'image'])
})

test('a place inside a part that has failed is not reported again: that check brings its crops', { options: JEV }, async ($, on) => {
  const part = box(0.1, 0.3, 0.1, 0.6)
  const w = world($, on, {
    session: true,
    files: FILES,
    process: true,
    backend: zoomBackend({ boxes: { 'box.0.candidate': part, 'box.0.reference': part, 'where.screen': box(0.15, 0.25, 0.2, 0.5, 0.4) }, zoom: 0.1 }),
  })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] }))

  expect(answer.lines[1]).toContain('1. FAIL 0.10 (zoomed crop)')
  expect(answer.lines.join('\n')).not.toContain('Another place')
  expect(answer.types).toEqual(['text', 'image', 'image'])
})

test('a place whose crops cannot be made is still reported, without them', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: { unavailable: 'process.run is only in the CLI' }, backend: zoomBackend({ boxes: { 'where.screen': box(0.1, 0.3, 0.1, 0.6, 0.4) } }) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] }))

  expect(answer.lines.join('\n')).toContain('Another place may differ, which none of your checks named: 10% to 60% across and 10% to 30% down the screenshot (10% of it; the model is 0.40 sure of the place). Look at it yourself.')
})
