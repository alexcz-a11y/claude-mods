// visual_check (#57): whatever goes wrong, the checks it touches end UNSURE with the reason in the answer, and the tool itself
// never fails: a timeout, an HTTP error, sips failing, no CLI, a file that is not there. Seam 1, as visual-check.test.ts.

import { expect, test } from 'claude-code/testing'
import { ffmpeg, sips } from './support/images.ts'
import { jev, world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }
const SHOT = '/shots/home.png'
const FILES = { [SHOT]: { format: 'png', width: 1200, height: 800 } }
const CHECKS = [{ part: 'the title', property: 'is fully visible' }]

/** The answer's text block and the number of blocks. */
function read(answer: { result?: unknown }) {
  const blocks = answer.result as { type: string; text?: string }[]
  expect(Array.isArray(blocks)).toBe(true)
  return { text: blocks[0]?.text ?? '', types: blocks.map((block) => block.type) }
}

test('outside the CLI, where there is no $.process.run, an image within the limits that is a PNG or a JPEG is sent as it is', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: { unavailable: 'process.run is only in the CLI' }, backend: jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.95 } }) })
  await w.start()
  const answer = await w.visualCheck({ images: [SHOT], checks: CHECKS })

  expect(w.requests).toHaveLength(1)
  expect(read(answer).text).toContain('1. PASS 0.95 (whole image) the title: is fully visible')
})

test('outside the CLI an image that would need sips is not sent: its checks are UNSURE, and the answer says why', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: { '/shots/wide.png': { format: 'png', width: 3000, height: 1000 }, '/shots/scan.tiff': { format: 'tiff', width: 800, height: 600 } }, process: { unavailable: 'process.run is only in the CLI' }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  const wide = read(await w.visualCheck({ images: ['/shots/wide.png'], checks: CHECKS }))
  const scan = read(await w.visualCheck({ images: ['/shots/scan.tiff'], checks: CHECKS }))

  expect(w.requests).toHaveLength(0)
  expect(wide.text).toContain('1. UNSURE n/a (whole image) the title: is fully visible (/shots/wide.png is 3000x1000, which the decision model does not take, and sips could not run to resize it (')
  expect(scan.text).toContain('(/shots/scan.tiff is not a PNG or a JPEG, and sips could not run to convert it (')
  // The reason carries what the engine said of running sips.
  expect(wide.text).toContain('process.run is only in the CLI')
  // Nothing was made of the image, so there is none to attach.
  expect(wide.types).toEqual(['text'])
})

test('when sips fails to prepare an image, the checks are UNSURE with its message, and nothing is asked', { options: JEV }, async ($, on) => {
  const failing = (args: readonly string[], disk: Parameters<typeof sips>[1]) => (args.includes('--out') ? { exitCode: 13, stdout: '', stderr: 'Error 13: cannot write the image\nsecond line' } : sips(args, disk))
  const w = world($, on, { session: true, files: { '/shots/wide.png': { format: 'png', width: 3000, height: 1000 } }, process: { programs: { sips: failing } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  const answer = await w.visualCheck({ images: ['/shots/wide.png'], checks: CHECKS })

  expect(w.requests).toHaveLength(0)
  expect(read(answer).text).toContain('(sips could not prepare /shots/wide.png (exit code 13: Error 13: cannot write the image))')
})

test('a path that is no image file, or no file, gives UNSURE checks that say so', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: { '/notes/readme.png': { base64: 'bm90IGFuIGltYWdl' } }, process: true, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  const notImage = read(await w.visualCheck({ images: ['/notes/readme.png'], checks: CHECKS }))
  const missing = read(await w.visualCheck({ images: ['/shots/nothing.png'], checks: CHECKS }))

  expect(w.requests).toHaveLength(0)
  expect(notImage.text).toContain('(/notes/readme.png is not an image sips can read (is the path right?))')
  expect(missing.text).toContain('(/shots/nothing.png is not an image sips can read (is the path right?))')
})

test('a path that starts with a dash is never handed to sips as an option', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: { '/work/-Z': { format: 'png', width: 1200, height: 800 } }, process: true, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: ['-Z'], checks: CHECKS })

  // Every sips call that names the file names it as ./-Z (the engine reads a relative path from the session's directory as well).
  const named = w.ran.filter((argv) => argv[0] === 'sips').map((argv) => argv.filter((arg) => arg.endsWith('-Z')))
  expect(named.length).toBeGreaterThan(0)
  for (const arguments_ of named) expect(arguments_).toEqual(['./-Z'])
})

test('an HTTP error from the decision model makes the checks UNSURE, with the screenshot attached to look at', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: () => ({ status: 503, body: 'overloaded' }) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], checks: CHECKS }))

  expect(answer.text).toContain('1. UNSURE n/a (whole image) the title: is fully visible (jev: busy (HTTP 503))')
  expect(answer.types).toEqual(['text', 'image'])
})

test('a decision model that does not answer in 8 seconds is given up on: the checks are UNSURE', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: () => ({ after: 20_000, reply: { status: 200, body: {} } }) })
  await w.start()
  const call = w.visualCheck({ images: [SHOT], checks: CHECKS })
  await w.clock.settle()
  await w.clock.advance(8000)
  const answer = read(await call)

  expect(answer.text).toContain('(jev: no answer in 8000 ms)')
  expect(answer.types).toEqual(['text', 'image'])
})

test('a call that fails as a whole (a bug of the mod\'s own) answers with why, and the screenshot whole when it can be read', { options: JEV }, async ($, on) => {
  let broken = false
  on('http.fetch', { url: /(?:)/ }, (_$, e, next) => (broken ? { value: { status: 500, ok: false, headers: {} } as never } : next(e)))
  const w = world($, on, { session: true, files: FILES, process: true, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  broken = true
  const answer = read(await w.visualCheck({ images: [SHOT], checks: CHECKS }))

  expect(w.requests).toHaveLength(0)
  expect(answer.text).toContain('visual_check could not run (an error in Dispatch Pilot, written to the debug log). Look at the images yourself.')
  expect(answer.types).toEqual(['text', 'image'])
})

test('a call that fails as a whole, about a recording (no one image to hand back), answers with the text alone', { options: JEV }, async ($, on) => {
  let broken = false
  on('http.fetch', { url: /(?:)/ }, (_$, e, next) => (broken ? { value: { status: 500, ok: false, headers: {} } as never } : next(e)))
  const w = world($, on, { session: true, process: { programs: { ffmpeg: ffmpeg({ '/rec/a.mov': { seconds: 3, width: 390, height: 844 } }) } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  broken = true
  const answer = read(await w.visualCheck({ images: ['/rec/a.mov'], checks: CHECKS }))

  expect(answer.text).toContain('visual_check could not run')
  expect(answer.types).toEqual(['text'])
})

test('a check the answer leaves out is UNSURE, the others are judged', { options: JEV }, async ($, on) => {
  const answered = (request: { body: any }) => ({ status: 200, body: { model: 'jev-1.14.0', answers: { 'check.0': { type: 'noul', noul: 0.95 } }, usage: { input_tokens: 100 } }, request })
  const w = world($, on, { session: true, files: FILES, process: true, backend: (request) => answered(request) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], checks: [...CHECKS, { part: 'the footer', property: 'is visible' }] }))

  expect(answer.text).toContain('1. PASS 0.95')
  expect(answer.text).toContain('2. UNSURE n/a (whole image) the footer: is visible (the decision model gave no answer to this check)')
})
