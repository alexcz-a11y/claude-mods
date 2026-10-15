// visual_check (#60, ADR 0008): a screen recording is handed over as it is. The mod reads frames out of it with ffmpeg, evenly through
// the time span the agent names (the whole recording if it names none), 12 for Jev and 8 for pplx, and puts them in one request, in
// order of time, as frames and not as a contact sheet. Only coarse questions of motion are asked. Seam 1: the engine's tool call in;
// the world's disk and ffmpeg, the requests that reach the decision model and the tool's answer out.

import { expect, test } from 'claude-code/testing'
import { ffmpeg, type FakeVideo, readFake } from './support/images.ts'
import { jev, pplx, world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }

const REC = '/rec/transition.mov'
const VIDEOS: Record<string, FakeVideo> = { [REC]: { seconds: 3.5, width: 390, height: 844 } }
const CHECKS = [{ part: 'the card', property: 'settles in its place without bouncing back' }]
const SPEC = 'A card slides up from the bottom and stops at the middle of the screen.'

/** The frames of a Jev request in the order the state lists them: the time each is said to be at, and where the file it came from was cut. */
function framesOf(request: { body: any } | undefined) {
  const listed: { seconds: number; frame: string }[] = request?.body.state.frames
  return listed.map((frame) => ({ seconds: frame.seconds, label: readFake(request?.body.assets[frame.frame].data_base64)?.label }))
}

// ---- The frames ----------------------------------------------------------------------------------------

test('a recording becomes 12 frames, evenly through its length, in one request in order of time: the last one just before the end', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: { programs: { ffmpeg: ffmpeg(VIDEOS) } }, backend: jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.95 } }) })
  await w.start()
  const answer = await w.visualCheck({ images: [REC], spec: SPEC, checks: CHECKS })

  expect(w.requests).toHaveLength(1)
  const frames = framesOf(w.requests[0])
  expect(frames.map((frame) => frame.seconds)).toEqual([0, 0.31, 0.62, 0.93, 1.24, 1.55, 1.85, 2.16, 2.47, 2.78, 3.09, 3.4])
  // Each picture is the frame ffmpeg cut at the time the state names, 390 by 844 as the recording is.
  expect(frames.map((frame) => frame.label)).toEqual(frames.map((frame) => `${REC} @${frame.seconds.toFixed(3)}s`))
  // The images are only the frames: there is no contact sheet and no whole-recording picture.
  expect(Object.keys(w.requests[0]?.body.assets)).toHaveLength(12)
  expect(JSON.stringify(answer.result)).toContain('1. PASS 0.95 (frames) the card: settles in its place without bouncing back')
})

test('the time span the agent names is where the frames are cut: from its first second to its last, 12 of them, and ffmpeg is asked for each one', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: { programs: { ffmpeg: ffmpeg(VIDEOS) } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: [REC], spec: SPEC, checks: CHECKS, from_seconds: 1, to_seconds: 2.1 })

  expect(framesOf(w.requests[0]).map((frame) => frame.seconds)).toEqual([1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.1])
  // One call to learn how long the recording is, then one for each frame, with the recording named as a path of its own.
  const ffmpegCalls = w.ran.filter((argv) => argv[0] === 'ffmpeg')
  expect(ffmpegCalls).toHaveLength(13)
  expect(ffmpegCalls[0]).toEqual(['ffmpeg', '-hide_banner', '-i', REC])
  expect(ffmpegCalls[1]?.slice(0, 9)).toEqual(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-ss', '1.000', '-i', REC])
  expect(ffmpegCalls[12]?.slice(5, 7)).toEqual(['-ss', '2.100'])
})

test('a span that runs past the end of the recording stops at its last frame, and one that starts after it cuts nothing', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: { programs: { ffmpeg: ffmpeg(VIDEOS) } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: [REC], spec: SPEC, checks: CHECKS, from_seconds: 3, to_seconds: 60 })
  expect(framesOf(w.requests[0]).map((frame) => frame.seconds)).toEqual([3, 3.04, 3.07, 3.11, 3.15, 3.18, 3.22, 3.25, 3.29, 3.33, 3.36, 3.4])

  const late = await w.visualCheck({ images: [REC], spec: SPEC, checks: CHECKS, from_seconds: 4 })
  expect(w.requests).toHaveLength(1)
  expect(JSON.stringify(late.result)).toContain('(/rec/transition.mov: the span starts at 4 s, and the recording is 3.5 s long)')
})

test('a path that starts with a dash, or is not absolute, is handed to ffmpeg as ./path, never as an option or a protocol', { options: JEV }, async ($, on) => {
  const small = { seconds: 2, width: 390, height: 844 }
  const w = world($, on, { session: true, process: { programs: { ffmpeg: ffmpeg({ '/work/-i.mov': small, '/work/http:.mov': small }) } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: ['-i.mov'], spec: SPEC, checks: CHECKS })
  await w.visualCheck({ images: ['http:.mov'], spec: SPEC, checks: CHECKS })

  const inputs = w.ran.filter((argv) => argv[0] === 'ffmpeg').map((argv) => argv[argv.indexOf('-i') + 1])
  expect(new Set(inputs)).toEqual(new Set(['./-i.mov', './http:.mov']))
  expect(w.requests).toHaveLength(2)
})

test('the debug log has the frames as images: how many, their sizes and about what they cost, never their content', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: { programs: { ffmpeg: ffmpeg(VIDEOS) } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: [REC], spec: SPEC, checks: CHECKS })

  const lines = w.logs.filter((log) => log.to === 'debug' && log.text.startsWith('visual_check'))
  expect(lines).toHaveLength(1)
  expect(lines[0]?.text).toContain(`images: 12 (${Array(12).fill('390x844').join(', ')}), about 10270 tokens`)
})

test('a time span given with a screenshot is ignored: it is no recording, and ffmpeg is never run', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: true, files: { '/shots/a.png': { format: 'png', width: 800, height: 600 } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: ['/shots/a.png'], spec: SPEC, checks: CHECKS, from_seconds: 1, to_seconds: 2 })

  expect(w.requests).toHaveLength(1)
  expect(w.ran.filter((argv) => argv[0] === 'ffmpeg')).toEqual([])
})

// ---- What the agent reads of it -----------------------------------------------------------------------------

test('the tool\'s description tells of recordings with the frame count of the decision model, and only coarse questions of motion', { options: JEV }, async ($, on) => {
  const withJev = world($, on, { session: true })
  await withJev.start()
  const description = withJev.tools.find((tool) => tool.name === 'visual_check')?.description ?? ''
  expect(description).toContain('12 frames are cut from it, evenly through the part given by from_seconds and to_seconds')
  expect(description).toContain('overshoots and springs back')
  expect(description).toContain('It cannot judge an easing curve')
  expect(withJev.tools.find((tool) => tool.name === 'visual_check')?.inputSchema).toMatchObject({ properties: { from_seconds: { type: 'number' }, to_seconds: { type: 'number' } } })
})

test('with pplx the description says 8 frames', { options: { perplexityApiKey: 'pplx-test-key' } }, async ($, on) => {
  const w = world($, on, { session: true })
  await w.start()
  expect(w.tools.find((tool) => tool.name === 'visual_check')?.description).toContain('8 frames are cut from it')
})

// ---- pplx --------------------------------------------------------------------------------------------

const PPLX = { perplexityApiKey: 'pplx-test-key' }

test('with pplx a recording is 8 frames, in the state as an array, one image part after another, in order of time', { options: PPLX }, async ($, on) => {
  const w = world($, on, { session: true, process: { programs: { ffmpeg: ffmpeg(VIDEOS) } }, backend: pplx([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.95 } }) })
  await w.start()
  const answer = await w.visualCheck({ images: [REC], spec: SPEC, checks: CHECKS })

  expect(w.requests).toHaveLength(1)
  const state: any[] = w.requests[0]?.body.state
  const parts = state.filter((part) => typeof part === 'object')
  expect(parts).toHaveLength(8)
  const times = JSON.parse(state[0]).frames.map((frame: { seconds: number }) => frame.seconds)
  expect(times).toEqual([0, 0.49, 0.97, 1.46, 1.94, 2.43, 2.91, 3.4])
  const labels = parts.map((part) => readFake(part.image_url.url.slice('data:image/jpeg;base64,'.length))?.label)
  expect(labels).toEqual(times.map((seconds: number) => `${REC} @${seconds.toFixed(3)}s`))
  expect(JSON.stringify(answer.result)).toContain('1. PASS 0.95 (frames)')
})

// ---- What the frames cost -------------------------------------------------------------------------------

const BIG = { '/rec/big.mov': { seconds: 3, width: 1920, height: 1080 } }

/** The input tokens the images of a Jev request cost by the estimate of ADR 0008 (2,600 a megapixel, each image once). */
function jevTokens(request: { body: any } | undefined): number {
  const assets = Object.values(request?.body.assets ?? {}) as { data_base64: string }[]
  const pixels = assets.reduce((sum, asset) => sum + (readFake(asset.data_base64)?.width ?? 0) * (readFake(asset.data_base64)?.height ?? 0), 0)
  return Math.round((pixels / 1_000_000) * 2600)
}

test('the 12 frames of a large recording are all scaled down together so that the images come to no more than 24,000 tokens', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: { programs: { ffmpeg: ffmpeg(BIG) } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: ['/rec/big.mov'], spec: SPEC, checks: CHECKS })

  // 12 frames of 2.07 megapixels would be about 64,000 tokens.
  expect(framesOf(w.requests[0])).toHaveLength(12)
  expect(jevTokens(w.requests[0])).toBeLessThanOrEqual(24_000)
  expect(jevTokens(w.requests[0])).toBeGreaterThan(22_000)
})

test('with pplx the 8 frames are counted again for every check, so the more checks, the smaller the frames', { options: PPLX }, async ($, on) => {
  const w = world($, on, { session: true, process: { programs: { ffmpeg: ffmpeg(BIG) } }, backend: pplx([0, 1, 0, 0, 0]) })
  await w.start()
  const few = Array.from({ length: 2 }, (_, i) => ({ part: 'the card', property: `property ${i}` }))
  const many = Array.from({ length: 16 }, (_, i) => ({ part: 'the card', property: `property ${i}` }))
  await w.visualCheck({ images: ['/rec/big.mov'], spec: SPEC, checks: few })
  await w.visualCheck({ images: ['/rec/big.mov'], spec: SPEC, checks: many })

  /** The tokens pplx counts for the images of a request: about 1,000 a megapixel, for each question. */
  const tokens = (request: { body: any } | undefined) => {
    const parts = (request?.body.state as any[]).filter((part) => typeof part === 'object')
    const sizes = parts.map((part) => readFake(part.image_url.url.slice('data:image/jpeg;base64,'.length)))
    const pixels = sizes.reduce((sum, size) => sum + (size?.width ?? 0) * (size?.height ?? 0), 0)
    return Math.round((pixels / 1_000_000) * 1000) * Object.keys(request?.body.questions).length
  }
  expect(tokens(w.requests[0])).toBeLessThanOrEqual(32_000)
  expect(tokens(w.requests[1])).toBeLessThanOrEqual(32_000)
  expect(tokens(w.requests[1])).toBeGreaterThan(28_000)
})
