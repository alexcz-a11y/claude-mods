// visual_check (#59): against a reference or another screenshot the verdict of a check is read off the crops: "the same" at 0.9 or more
// passes, at 0.2 or less fails, between is unsure (ADR 0008). Where the crops could not be made or judged, the whole images' answer
// stands, but only a fail from it is taken. Seam 1, as visual-check.test.ts: the world's backend answers the two requests.

import { expect, test } from 'claude-code/testing'
import { sips } from './support/images.ts'
import { box, zoomBackend } from './support/zoom.ts'
import { pplx, world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }
const SHOT = '/shots/home.png'
const DESIGN = '/design/home.png'
const FILES = {
  [SHOT]: { format: 'png', width: 1000, height: 1000 },
  [DESIGN]: { format: 'png', width: 1000, height: 1000 },
  '/photos/side.png': { format: 'png', width: 800, height: 600 },
  '/photos/front.png': { format: 'png', width: 800, height: 600 },
}
const BUTTON = { part: 'the primary button', property: 'corner radius' }
const TITLE = { part: 'the title', property: 'font weight' }

/** The answer's lines and the types of its blocks. */
function read(answer: { result?: unknown }) {
  const blocks = answer.result as { type: string; text?: string }[]
  expect(Array.isArray(blocks)).toBe(true)
  return { lines: (blocks[0]?.text ?? '').split('\n'), types: blocks.map((block) => block.type) }
}

test('a check passes at 0.9 on its crops, fails at 0.2, and is unsure between: the crops decide, whatever the whole images said', { options: JEV }, async ($, on) => {
  // The whole images said the opposite of the crops for the first two: the primary button is "different" there, the title is "the same".
  const w = world($, on, {
    session: true,
    files: FILES,
    process: true,
    backend: zoomBackend({ whole: { 'check.0': 0.1, 'check.1': 0.99, 'check.2': 0.5 }, zoom: { 'zoom.0.0': 0.95, 'zoom.1.0': 0.2, 'zoom.2.0': 0.5 } }),
  })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON, TITLE, { part: 'the footer', property: 'margin' }] }))

  expect(answer.lines.slice(0, 4)).toEqual([
    'Visual check of /shots/home.png against the reference: 1 PASS, 1 FAIL, 1 UNSURE.',
    '1. PASS 0.95 (zoomed crop) the primary button: corner radius',
    '2. FAIL 0.20 (zoomed crop) the title: font weight',
    '3. UNSURE 0.50 (zoomed crop) the footer: margin (the decision model is not sure either way)',
  ])
  // 0.9 is in: the bar is "at least".
})

test('0.9 passes and nothing under it does; only the crops are asked, as Noul: no choice question decides', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ zoom: { 'zoom.0.0': 0.9, 'zoom.1.0': 0.89 } }) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON, TITLE] }))

  expect(answer.lines[1]).toContain('1. PASS 0.90 (zoomed crop)')
  expect(answer.lines[2]).toContain('2. UNSURE 0.89 (zoomed crop)')
  for (const request of w.requests) expect(new Set(Object.values(request.body.questions).map((question: any) => question.type))).toEqual(new Set(request.body.questions['zoom.0.0'] === undefined ? ['noul', 'box'] : ['noul']))
})

test('against another screenshot a match can pass on the crops too', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ zoom: 0.96 }) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], compare_to: DESIGN, checks: [BUTTON] }))

  expect(answer.lines.slice(0, 2)).toEqual(['Visual check of /shots/home.png against the other screenshot: 1 PASS.', '1. PASS 0.96 (zoomed crop) the primary button: corner radius'])
  // A pass brings no image along.
  expect(answer.types).toEqual(['text'])
})

test('when the second request fails, a fail of the whole images stands and anything else is unsure, with the reason', { options: JEV }, async ($, on) => {
  const w = world($, on, {
    session: true,
    files: FILES,
    process: true,
    backend: zoomBackend({ whole: { 'check.0': 0.1, 'check.1': 0.97 }, zoomReply: { status: 503, body: 'overloaded' } }),
  })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON, TITLE] }))

  expect(answer.lines.slice(1, 3)).toEqual([
    '1. FAIL 0.10 (whole image) the primary button: corner radius',
    '2. UNSURE 0.97 (whole image) the title: font weight (the zoomed re-check failed (jev: busy (HTTP 503)); a match with a reference cannot be confirmed from the whole image)',
  ])
})

test('a pair the second request leaves unanswered is unsure, the others are judged', { options: JEV }, async ($, on) => {
  const reply = () => ({ status: 200, body: { model: 'jev-1.14.0', answers: { 'zoom.0.0': { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 100 } } })
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ zoomReply: reply }) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON, TITLE] }))

  expect(answer.lines[1]).toContain('1. PASS 0.97 (zoomed crop)')
  expect(answer.lines[2]).toBe('2. UNSURE 0.50 (whole image) the title: font weight (the decision model gave no answer to the zoomed re-check; the decision model is not sure either way)')
})

test('a part the model could not box is not cropped: its check falls back on the whole images, and says why', { options: JEV }, async ($, on) => {
  // A box with no extent is no box.
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ whole: { 'check.0': 0.97, 'check.1': 0.1 }, boxes: { 'box.0.candidate': box(0.5, 0.5, 0.2, 0.4), 'box.1.reference': box(0.1, 0.1, 0.3, 0.3) }, zoom: 0.95 }) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON, TITLE] }))

  expect(answer.lines.slice(1, 3)).toEqual([
    '1. UNSURE 0.97 (whole image) the primary button: corner radius (the decision model did not locate the part in the screenshot; a match with a reference cannot be confirmed from the whole image)',
    '2. FAIL 0.10 (whole image) the title: font weight',
  ])
  // No pair was left to ask about.
  expect(w.requests).toHaveLength(1)
})

test('a check that names no part falls back on the whole images, and says why', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ whole: { 'check.0': 0.97 } }) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: ['the layout is the same'] }))

  expect(answer.lines[1]).toBe('1. UNSURE 0.97 (whole image) the layout is the same (the check names no part of the image, so there is nothing to cut out; a match with a reference cannot be confirmed from the whole image)')
  expect(w.requests).toHaveLength(1)
})

test('when sips cannot cut a crop the check falls back on the whole images, with what sips said', { options: JEV }, async ($, on) => {
  const failing = (args: readonly string[], disk: Parameters<typeof sips>[1]) => (args[0] === '-c' ? { exitCode: 13, stdout: '', stderr: 'Error 13: cannot write the image\nsecond line' } : sips(args, disk))
  const w = world($, on, { session: true, files: FILES, process: { programs: { sips: failing } }, backend: zoomBackend({ whole: { 'check.0': 0.97 } }) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] }))

  expect(answer.lines[1]).toContain('1. UNSURE 0.97 (whole image) the primary button: corner radius (sips could not cut a crop out of /shots/home.png (exit code 13: Error 13: cannot write the image); a match with a reference')
  expect(w.requests).toHaveLength(1)
})

test('outside the CLI, where there is no sips, the whole images answer alone', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: { unavailable: 'process.run is only in the CLI' }, backend: zoomBackend({ whole: { 'check.0': 0.1, 'check.1': 0.97 } }) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON, TITLE] }))

  expect(answer.lines[1]).toBe('1. FAIL 0.10 (whole image) the primary button: corner radius')
  expect(answer.lines[2]).toContain('2. UNSURE 0.97 (whole image) the title: font weight (a crop could not be made (')
  expect(answer.lines[2]).toContain('process.run is only in the CLI')
  expect(w.requests).toHaveLength(1)
})

test('with several references a part matches if any one of them shows it as the screenshot does: the highest probability counts', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: zoomBackend({ zoom: { 'zoom.0.0': 0.05, 'zoom.0.1': 0.95 } }) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], reference: ['/photos/side.png', '/photos/front.png'], checks: [{ part: 'the handle', property: 'shape' }] }))

  expect(w.requests[1]?.body.questions['zoom.0.0'].instructions.question).toContain('`reference-1_crop`')
  expect(w.requests[1]?.body.questions['zoom.0.1'].instructions.question).toContain('`reference-2_crop`')
  expect(answer.lines[1]).toBe('1. PASS 0.95 (zoomed crop) the handle: shape')
})

test('with pplx, which has no Box question, it never zooms: a match stays unsure, as in the whole images', { options: { perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: pplx([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.97 } }) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [SHOT], reference: [DESIGN], checks: [BUTTON] }))

  expect(w.ran.filter((argv) => argv[1] === '-c')).toEqual([])
  expect(answer.lines[1]).toContain('1. UNSURE 0.97 (whole image)')
})
