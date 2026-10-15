// visual_check (#57): the images are brought within what the decision model takes before they are sent (Jev: each side 256 to
// 1568 pixels and 78,400 to 2,458,624 in all, PNG or JPEG; the engine reads at most 4 MiB). Seam 1: the world's disk holds the
// files, its sips changes them, and what a test reads is the image in the request.

import { expect, test } from 'claude-code/testing'
import { readFake } from './support/images.ts'
import { jev, world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }
const CHECK = [{ part: 'the title', property: 'is fully visible' }]

/** The single image of a request, read as a decoder would. */
function sentImage(request: { body: any } | undefined) {
  const assets = Object.values(request?.body.assets ?? {}) as { data_base64: string; format: string }[]
  expect(assets).toHaveLength(1)
  return { format: assets[0]?.format, ...readFake(assets[0]?.data_base64 as string) }
}

test('an image larger than 1568 pixels is scaled down to fit, keeping its shape', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: true, files: { '/shots/wide.png': { format: 'png', width: 3000, height: 1000 } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: ['/shots/wide.png'], checks: CHECK })

  expect(sentImage(w.requests[0])).toMatchObject({ format: 'png', width: 1568, height: 523 })
  // The original was left as it was.
  expect(w.files.get('/shots/wide.png')).toMatchObject({ width: 3000, height: 1000 })
})

test('an image smaller than 256 pixels or 78,400 in all is scaled up to the least that is taken', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: true, files: { '/shots/icon.png': { format: 'png', width: 100, height: 60 } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: ['/shots/icon.png'], checks: CHECK })

  const sent = sentImage(w.requests[0])
  expect(sent).toMatchObject({ width: 427, height: 256 })
  // Both sides at least 256, and 78,400 pixels or more in all.
  expect((sent.width ?? 0) * (sent.height ?? 0)).toBeGreaterThanOrEqual(78_400)
})

test('an image that is not a PNG or a JPEG is converted: a TIFF to PNG, a HEIC photo to JPEG', { options: JEV }, async ($, on) => {
  const w = world($, on, {
    session: true,
    process: true,
    files: { '/shots/scan.tiff': { format: 'tiff', width: 800, height: 600 }, '/photos/shot.heic': { format: 'heic', width: 800, height: 600 } },
    backend: jev([0, 1, 0, 0, 0]),
  })
  await w.start()
  await w.visualCheck({ images: ['/shots/scan.tiff'], checks: CHECK })
  await w.visualCheck({ images: ['/photos/shot.heic'], checks: CHECK })

  expect(sentImage(w.requests[0])).toMatchObject({ format: 'png', width: 800, height: 600 })
  expect(sentImage(w.requests[1])).toMatchObject({ format: 'jpeg', width: 800, height: 600 })
})

test('an image over 4 MiB, which the engine will not read, is made smaller first and read then', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: true, files: { '/shots/huge.png': { format: 'png', width: 1500, height: 1500, size: 6 * 1024 * 1024 } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  const answer = await w.visualCheck({ images: ['/shots/huge.png'], checks: CHECK })

  const sent = sentImage(w.requests[0])
  expect(sent.format).toBe('jpeg')
  expect(sent.width).toBeLessThanOrEqual(1500)
  expect(JSON.stringify(answer.result)).toContain('Visual check of /shots/huge.png')
})
