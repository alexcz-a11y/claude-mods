// visual_check (#59): the zoomed re-check cuts the named part out of both images with sips and sends the crops in a second request,
// one Noul for each pair, the crops in its instructions. With the same view the two images are cut at the same place (the union of the
// two boxes, by proportion); with another view each is cut around its own box. Around the box goes a margin of 15%; a crop is at least
// 160 pixels each way and at most 3.5 to 1, and is enlarged until its long side is 1000 pixels. Seam 1, as visual-check.test.ts:
// the world's sips cuts and enlarges, and a test reads the arguments it ran with and the images in the request.

import { expect, test } from 'claude-code/testing'
import { readFake } from './support/images.ts'
import { box, zoomBackend } from './support/zoom.ts'
import { world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }
const SHOT = '/shots/home.png'
const DESIGN = '/design/home.png'
const PHOTO = '/photos/real.png'
const FILES = {
  [SHOT]: { format: 'png', width: 1000, height: 1000 },
  [DESIGN]: { format: 'png', width: 1000, height: 1000 },
  [PHOTO]: { format: 'png', width: 800, height: 600 },
}
const BUTTON = { part: 'the primary button', property: 'corner radius' }

/** The sips calls that cut a crop out of a file, as `[source, rect arguments...]`: `-c height width --cropOffset y x`. */
function crops(ran: readonly (readonly string[])[]) {
  return ran.filter((argv) => argv[0] === 'sips' && argv[1] === '-c').map((argv) => ({ source: argv[7], args: argv.slice(1, 7), out: argv[9] }))
}

/** The sips calls that enlarge a file, as `[long side, file]`. */
function enlargements(ran: readonly (readonly string[])[]) {
  return ran.filter((argv) => argv[0] === 'sips' && argv[1] === '-Z').map((argv) => ({ longSide: argv[2], file: argv[3], out: argv[5] }))
}

/** The crops of a second request: the images of its assets, read as a decoder would, by the name they go by. */
function sent(request: { body: any } | undefined) {
  return Object.fromEntries(Object.entries(request?.body.assets ?? {}).map(([reference, asset]: [string, any]) => [reference.slice(37), readFake(asset.data_base64)]))
}

test('with the same view both images are cut at the union of the two boxes, with a margin of 15%, and enlarged to 1000 pixels on the long side', { options: JEV }, async ($, on) => {
  const boxes = { 'box.0.candidate': box(0.4, 0.56, 0.4, 0.6), 'box.0.reference': box(0.4, 0.56, 0.46, 0.66) }
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ boxes }) })
  await w.start()
  await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] })

  // The union is 260 x 160 pixels (x 400 to 660, y 400 to 560); with 15% on each side 338 x 208, centred on (530, 480).
  const cut = ['-c', '208', '338', '--cropOffset', '376', '361']
  expect(crops(w.ran).map(({ source, args }) => ({ source, args }))).toEqual([
    { source: SHOT, args: cut },
    { source: DESIGN, args: cut },
  ])
  // Each crop is enlarged where it lies, to 1000 on the long side.
  expect(enlargements(w.ran).map(({ longSide }) => longSide)).toEqual(['1000', '1000'])
  for (const crop of crops(w.ran)) expect(enlargements(w.ran).map(({ file }) => file)).toContain(crop.out)

  expect(w.requests).toHaveLength(2)
  expect(sent(w.requests[1])).toEqual({
    'zoom-0-candidate': { format: 'png', width: 1000, height: 615, label: `${SHOT} > crop 338x208+361+376 > fit 1000x615` },
    'zoom-0-reference': { format: 'png', width: 1000, height: 615, label: `${DESIGN} > crop 338x208+361+376 > fit 1000x615` },
  })
})

test('with another view each image is cut around its own box', { options: JEV }, async ($, on) => {
  const boxes = { 'box.0.candidate': box(0.4, 0.56, 0.4, 0.6), 'box.0.reference': box(0.3, 0.5, 0.2, 0.6) }
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ boxes }) })
  await w.start()
  await w.visualCheck({ images: [SHOT], reference: [PHOTO], checks: [BUTTON] })

  // The screenshot: 200 x 160 pixels, 260 x 208 with the margin, centred on (500, 480). The photo: 320 x 120, 416 x 156 (160 at the least), centred on (320, 240).
  expect(crops(w.ran).map(({ source, args }) => ({ source, args }))).toEqual([
    { source: SHOT, args: ['-c', '208', '260', '--cropOffset', '376', '370'] },
    { source: PHOTO, args: ['-c', '160', '416', '--cropOffset', '160', '112'] },
  ])
  expect(sent(w.requests[1])).toEqual({
    'zoom-0-candidate': { format: 'png', width: 1000, height: 800, label: `${SHOT} > crop 260x208+370+376 > fit 1000x800` },
    'zoom-0-reference': { format: 'png', width: 1000, height: 385, label: `${PHOTO} > crop 416x160+112+160 > fit 1000x385` },
  })
})

test('the agent can say that the views are the same (or not) when the shapes of the images would say otherwise', { options: JEV }, async ($, on) => {
  const boxes = { 'box.0.candidate': box(0.4, 0.56, 0.4, 0.6), 'box.0.reference': box(0.3, 0.5, 0.2, 0.6) }
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ boxes }) })
  await w.start()
  // 1000 x 1000 and 800 x 600 are not alike in shape; the agent says they are the same view (a cropped export of the same screen).
  await w.visualCheck({ images: [SHOT], reference: [PHOTO], same_view: true, checks: [BUTTON] })

  // One rect, by proportion: the union (0.2 to 0.6 across, 0.3 to 0.56 down) is 400 x 260 pixels of the screenshot, 520 x 338 with the margin, centred on (400, 430).
  const [first, second] = crops(w.ran)
  expect(first?.args).toEqual(['-c', '338', '520', '--cropOffset', '261', '140'])
  // The photo is 800 x 600: the same piece of it, by proportion (0.8 across, 0.6 down).
  expect(second?.args).toEqual(['-c', '203', '416', '--cropOffset', '157', '112'])
})

test('a crop is at least 160 pixels each way: a tiny part is cut with room around it', { options: JEV }, async ($, on) => {
  const boxes = { 'box.0.candidate': box(0.5, 0.51, 0.5, 0.51), 'box.0.reference': box(0.5, 0.51, 0.5, 0.51) }
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ boxes }) })
  await w.start()
  await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] })

  expect(crops(w.ran)[0]?.args).toEqual(['-c', '160', '160', '--cropOffset', '425', '425'])
  expect(sent(w.requests[1])['zoom-0-candidate']).toMatchObject({ width: 1000, height: 1000 })
})

test('a crop is at most 3.5 to 1: a strip of a part gets the short side made longer', { options: JEV }, async ($, on) => {
  const strip = box(0.5, 0.52, 0.1, 0.9)
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ boxes: { 'box.0.candidate': strip, 'box.0.reference': strip } }) })
  await w.start()
  await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] })

  // 800 x 20 pixels: 1040 wide with the margin, which the 1000 pixels of the image cannot hold, and 297 high (1040 / 3.5 = 297.1): 3.4 to 1.
  expect(crops(w.ran)[0]?.args).toEqual(['-c', '297', '1000', '--cropOffset', '362', '0'])
  expect(sent(w.requests[1])['zoom-0-candidate']).toMatchObject({ width: 1000, height: 297 })
})

test('a crop of a part at the edge of the image is moved to lie within it', { options: JEV }, async ($, on) => {
  const corner = box(0.95, 1, 0.95, 1)
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ boxes: { 'box.0.candidate': corner, 'box.0.reference': corner } }) })
  await w.start()
  await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] })

  // The corner of the screenshot: 50 x 50 pixels, 160 x 160 with the least; centred on the corner it would run out of the image, so it ends at the corner.
  expect(crops(w.ran)[0]?.args).toEqual(['-c', '160', '160', '--cropOffset', '840', '840'])
})

test('the second request has a Noul for each pair of crops, with the two crops in its instructions and nothing else of the images in the state', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend() })
  await w.start()
  await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON, { part: 'the title', property: 'font weight' }] })

  const second = w.requests[1]?.body
  expect(second.model).toBe('jev-1.14.0')
  expect(w.requests[1]?.headers['TypeSafe-Danger-Zone-Images']).toBe('true')
  expect(Object.keys(second.questions)).toEqual(['zoom.0.0', 'zoom.1.0'])
  const reference = (name: string): string => Object.keys(second.assets).find((key) => key.endsWith(`-${name}`)) as string
  expect(second.questions['zoom.0.0']).toEqual({
    type: 'noul',
    instructions: {
      question: 'Both images are enlarged crops that show the primary button, cut out of two images. Is the corner radius of the primary button the same in `candidate_crop` as in `reference_crop`?',
      candidate_crop: reference('zoom-0-candidate'),
      reference_crop: reference('zoom-0-reference'),
    },
  })
  expect(second.questions['zoom.1.0'].instructions.candidate_crop).toBe(reference('zoom-1-candidate'))
  expect(Object.keys(second.assets)).toHaveLength(4)
  // The state holds no image: the crops are in the questions, where each costs only its own question.
  expect(JSON.stringify(second.state)).not.toContain(reference('zoom-0-candidate'))
})

test('against another screenshot the second crop is `other_crop`', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend() })
  await w.start()
  await w.visualCheck({ images: [SHOT], compare_to: DESIGN, checks: [BUTTON] })

  const instructions = w.requests[1]?.body.questions['zoom.0.0'].instructions
  expect(Object.keys(instructions)).toEqual(['question', 'candidate_crop', 'other_crop'])
  expect(instructions.question).toContain('in `candidate_crop` as in `other_crop`?')
})
