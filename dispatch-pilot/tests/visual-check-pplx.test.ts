// visual_check (#57): without a TypeSafe key the images go to pplx (ADR 0008): the state is an array with the images in it, an
// image covers at most 2,048 tiles of 32 by 32 pixels, a request holds at most 8 images, and the request waits its turn at the
// rate limit like every pplx request. Seam 1, as visual-check.test.ts.

import { expect, test } from 'claude-code/testing'
import { readFake } from './support/images.ts'
import { pplx, world } from './support/world.ts'

const PPLX = { perplexityApiKey: 'pplx-test-key' }
const SHOT = '/shots/home.png'
const CHECKS = [{ part: 'the title', property: 'is fully visible' }]
/** How many 32 by 32 tiles an image covers, as pplx counts them. */
const tiles = (width: number, height: number) => Math.ceil(width / 32) * Math.ceil(height / 32)

test('pplx gets the checks as one request whose state is an array: the state as text, then the screenshot as an image_url part', { options: PPLX }, async ($, on) => {
  const w = world($, on, { session: true, files: { [SHOT]: { format: 'png', width: 1200, height: 800 } }, process: true, backend: pplx([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.95 } }) })
  await w.start()
  const answer = await w.visualCheck({ images: [SHOT], spec: 'The Account screen.', checks: CHECKS })

  expect(w.requests).toHaveLength(1)
  const sent = w.requests[0]
  expect(sent?.url).toBe('https://api.perplexity.ai/v1/decisions')
  expect(sent?.headers['TypeSafe-Danger-Zone-Images']).toBeUndefined()
  expect(sent?.body.model).toBe('pplx-decider-v1.1-27b')
  expect(sent?.body.state).toHaveLength(3)
  expect(JSON.parse(sent?.body.state[0])).toEqual({ screenshot: '[image 1: screenshot]', specification: 'The Account screen.' })
  expect(sent?.body.state[1]).toBe('[image 1: screenshot]:')
  const url: string = sent?.body.state[2].image_url.url
  expect(url.startsWith('data:image/png;base64,')).toBe(true)
  expect(readFake(url.slice('data:image/png;base64,'.length))).toMatchObject({ width: 1200, height: 800 })
  expect(Object.keys(sent?.body.questions)).toEqual(['check.0'])
  expect(JSON.stringify(answer.result)).toContain('1. PASS 0.95 (whole image) the title: is fully visible')
  // It went through the rate limit, which keeps the time of every send.
  expect(w.pplxRate()).toHaveLength(1)
})

test('an image pplx would hang on (over 2,048 tiles) is scaled down until it covers no more, and not further', { options: PPLX }, async ($, on) => {
  const w = world($, on, { session: true, files: { [SHOT]: { format: 'png', width: 2400, height: 1600 } }, process: true, backend: pplx([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: [SHOT], checks: CHECKS })

  const url: string = w.requests[0]?.body.state[2].image_url.url
  const sent = readFake(url.slice('data:image/png;base64,'.length))
  expect(tiles(sent?.width ?? 0, sent?.height ?? 0)).toBeLessThanOrEqual(2048)
  // Scaled by about three quarters, not to a thumbnail.
  expect(tiles(sent?.width ?? 0, sent?.height ?? 0)).toBeGreaterThan(1900)
  expect(Math.abs((sent?.width ?? 0) / (sent?.height ?? 1) - 1.5)).toBeLessThan(0.02)
})

test('a request holds at most 8 images: with more the checks are UNSURE and the answer says how many were given', { options: PPLX }, async ($, on) => {
  const files: Record<string, { format: string; width: number; height: number }> = { [SHOT]: { format: 'png', width: 800, height: 600 } }
  const references = Array.from({ length: 8 }, (_, i) => `/photos/${i}.png`)
  for (const path of references) files[path] = { format: 'png', width: 800, height: 600 }
  const w = world($, on, { session: true, files, process: true, backend: pplx([0, 1, 0, 0, 0]) })
  await w.start()
  const answer = await w.visualCheck({ images: [SHOT], reference: references, checks: CHECKS })

  expect(w.requests).toHaveLength(0)
  expect(JSON.stringify(answer.result)).toContain('(pplx takes at most 8 images in one request, and this call has 9)')
})
