// visual_check (#57): the images of one request together cost Jev about 2,600 input tokens a megapixel, and its context holds 32k
// for one question, so the images are kept to about 24k in all (ADR 0008); pplx counts an image again for every question, so there
// the share of the budget an image gets falls as checks are added. Seam 1: the images in the request are read as a decoder would.

import { expect, test } from 'claude-code/testing'
import { readFake } from './support/images.ts'
import { jev, pplx, world } from './support/world.ts'

const CHECKS = [{ part: 'the title', property: 'is fully visible' }]
const big = { format: 'png', width: 1568, height: 1568 }
/** The pixels of every image in a Jev request, in megapixels. */
function megapixels(request: { body: any } | undefined): number {
  const assets = Object.values(request?.body.assets ?? {}) as { data_base64: string }[]
  return assets.reduce((sum, asset) => sum + (readFake(asset.data_base64)?.width ?? 0) * (readFake(asset.data_base64)?.height ?? 0), 0) / 1_000_000
}

test('four large images, which would cost Jev 25,000 tokens, are all scaled down together to about 24,000 and no further', { options: { typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const files = { '/shots/a.png': big, '/design/1.png': big, '/design/2.png': big, '/design/3.png': big }
  const w = world($, on, { session: true, files, process: true, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: ['/shots/a.png'], reference: ['/design/1.png', '/design/2.png', '/design/3.png'], checks: CHECKS })

  // 2,600 tokens a megapixel: 24,000 tokens are 9.23 megapixels; the four images were 9.83.
  expect(megapixels(w.requests[0])).toBeLessThanOrEqual(24_000 / 2600)
  expect(megapixels(w.requests[0])).toBeGreaterThan(8.8)
  const shapes = Object.values(w.requests[0]?.body.assets).map((asset: any) => readFake(asset.data_base64))
  for (const shape of shapes) expect(shape?.width).toBe(shape?.height)
})

test('images within the budget are not touched', { options: { typesafeApiKey: 'ts-test-key' } }, async ($, on) => {
  const files = { '/shots/a.png': big, '/design/1.png': { format: 'png', width: 1000, height: 700 } }
  const w = world($, on, { session: true, files, process: true, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: ['/shots/a.png'], reference: ['/design/1.png'], checks: CHECKS })

  expect(w.ran.filter((argv) => argv.includes('--out'))).toEqual([])
})

test('with pplx an image is counted again for every check, so many checks leave each image a smaller share of the budget', { options: { perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, files: { '/shots/a.png': { format: 'png', width: 1400, height: 1400 } }, process: true, backend: pplx([0, 1, 0, 0, 0]) })
  await w.start()
  const few = Array.from({ length: 4 }, (_, i) => ({ part: 'part', property: `property ${i}` }))
  const many = Array.from({ length: 20 }, (_, i) => ({ part: 'part', property: `property ${i}` }))
  await w.visualCheck({ images: ['/shots/a.png'], checks: few })
  await w.visualCheck({ images: ['/shots/a.png'], checks: many })

  const pixels = (request: { body: any } | undefined) => {
    const url: string = request?.body.state[2].image_url.url
    const shape = readFake(url.slice('data:image/png;base64,'.length))
    return ((shape?.width ?? 0) * (shape?.height ?? 0)) / 1_000_000
  }
  // 32,000 tokens at about 1,000 a megapixel for each check: 8 megapixels for 4 checks, 1.6 for 20.
  expect(pixels(w.requests[0])).toBeGreaterThan(1.9)
  expect(pixels(w.requests[1])).toBeLessThanOrEqual(1.6)
  expect(pixels(w.requests[1])).toBeGreaterThan(1.4)
})
