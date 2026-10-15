// visual_check (#57): Jev "does not apply the EXIF orientation" (docs.typesafe.ai/images), so a photo that its EXIF says lies on
// its side would be judged on its side. The mod turns the pixels upright with sips (which cannot tell the orientation, so the mod
// reads the tag out of the JPEG itself). Seam 1: the world's disk holds the photo, its sips turns it, a test reads the request.

import { expect, test } from 'claude-code/testing'
import { readFake } from './support/images.ts'
import { jev, world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }
const CHECKS = [{ part: 'the mug', property: 'handle' }]

function sentImage(request: { body: any } | undefined) {
  const assets = Object.values(request?.body.assets ?? {}) as { data_base64: string }[]
  expect(assets).toHaveLength(1)
  return readFake(assets[0]?.data_base64 as string)
}

test('a JPEG whose EXIF orientation is 6 (a quarter turn to the right) is turned upright before it is sent: the sides change places', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: true, files: { '/photos/mug.jpg': { format: 'jpeg', width: 1200, height: 800, orientation: 6 } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: ['/photos/mug.jpg'], checks: CHECKS })

  expect(sentImage(w.requests[0])).toMatchObject({ format: 'jpeg', width: 800, height: 1200 })
  expect(sentImage(w.requests[0])?.label).toContain('> rotate 90')
})

test('the other orientations are undone by the turn and flip that give the same picture as an EXIF-aware viewer shows', { options: JEV }, async ($, on) => {
  // Measured with sips on a picture of eight distinct pixels, against Pillow's exif_transpose.
  const undone: Record<number, string> = { 2: 'flip horizontal', 3: 'rotate 180', 4: 'flip vertical', 5: 'rotate 270 > flip horizontal', 6: 'rotate 90', 7: 'rotate 90 > flip horizontal', 8: 'rotate 270' }
  const files = Object.fromEntries(Object.keys(undone).map((o) => [`/photos/o${o}.jpg`, { format: 'jpeg', width: 1200, height: 800, orientation: Number(o) }]))
  const w = world($, on, { session: true, process: true, files, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  for (const o of Object.keys(undone)) await w.visualCheck({ images: [`/photos/o${o}.jpg`], checks: CHECKS })

  const labels = w.requests.map((request) => sentImage(request)?.label.split(' > ').slice(1).join(' > '))
  expect(labels).toEqual(Object.values(undone))
})

test('a JPEG without an orientation, or an upright one (1), is read as it is', { options: JEV }, async ($, on) => {
  const w = world($, on, {
    session: true,
    process: true,
    files: { '/photos/plain.jpg': { format: 'jpeg', width: 1200, height: 800 }, '/photos/upright.jpg': { format: 'jpeg', width: 1200, height: 800, orientation: 1 } },
    backend: jev([0, 1, 0, 0, 0]),
  })
  await w.start()
  await w.visualCheck({ images: ['/photos/plain.jpg'], checks: CHECKS })
  await w.visualCheck({ images: ['/photos/upright.jpg'], checks: CHECKS })

  for (const request of w.requests) expect(sentImage(request)).toMatchObject({ width: 1200, height: 800, label: '' })
})
