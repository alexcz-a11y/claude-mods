// visual_check (#60): a recording the mod cannot read into frames ends the checks UNSURE with the reason in the answer, and the tool
// itself never fails: no ffmpeg, a file ffmpeg cannot read, a frame it cannot cut. Also what a recording is not for (a comparison),
// and `look` on one. Seam 1, as visual-check-recording.test.ts.

import { expect, test } from 'claude-code/testing'
import { ffmpeg, type FakeVideo, readFake } from './support/images.ts'
import { jev, world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }
const REC = '/rec/transition.mov'
const VIDEOS: Record<string, FakeVideo> = { [REC]: { seconds: 3.5, width: 390, height: 844 } }
const CHECKS = [{ part: 'the card', property: 'settles in its place without bouncing back' }]

type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } }

/** The answer's blocks: the text of the first, and the kinds of all. */
function read(answer: { result?: unknown }) {
  const blocks = answer.result as Block[]
  expect(Array.isArray(blocks)).toBe(true)
  return { text: blocks[0]?.text ?? '', types: blocks.map((block) => block.type), blocks }
}

// ---- When the frames cannot be got ---------------------------------------------------------------------

test('without ffmpeg on the machine the checks are UNSURE: the reason says so, nothing is asked, and the agent is told to look at the recording', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: { programs: { ffmpeg: null } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [REC], checks: CHECKS }))

  expect(w.requests).toHaveLength(0)
  expect(answer.text).toContain('1. UNSURE n/a (frames) the card: settles in its place without bouncing back (ffmpeg could not be run (spawn ffmpeg ENOENT), so /rec/transition.mov cannot be read: take screenshots of the moments to check and give those instead)')
  expect(answer.text).toContain('For what is UNSURE, look at the recording yourself: visual_check with look: true and its path (and from_seconds and to_seconds) returns 8 frames of it.')
  // There is no one screenshot to hand back.
  expect(answer.types).toEqual(['text'])
})

test('outside the CLI, where there is no $.process.run, a recording is as good as unreadable: the checks are UNSURE with what the engine said', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: { unavailable: 'process.run is only in the CLI' }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [REC], checks: CHECKS }))

  expect(w.requests).toHaveLength(0)
  expect(answer.text).toContain('ffmpeg could not be run (process.run is only in the CLI)')
})

test('a recording ffmpeg cannot read, or that is not there, gives UNSURE checks that carry ffmpeg\'s last word', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: { programs: { ffmpeg: ffmpeg(VIDEOS) } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  const gone = read(await w.visualCheck({ images: ['/rec/gone.mov'], checks: CHECKS }))

  expect(w.requests).toHaveLength(0)
  expect(gone.text).toContain('(ffmpeg could not read /rec/gone.mov (Error opening input files: No such file or directory))')
})

test('a frame ffmpeg fails to cut makes the checks UNSURE with its message, and nothing is asked', { options: JEV }, async ($, on) => {
  const probe = ffmpeg(VIDEOS)
  const failing: typeof probe = (args, disk, init) => (args.includes('-ss') ? { exitCode: 3, stdout: '', stderr: 'cannot decode\nthe stream is damaged\n' } : probe(args, disk, init))
  const w = world($, on, { session: true, process: { programs: { ffmpeg: failing } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [REC], checks: CHECKS }))

  expect(w.requests).toHaveLength(0)
  expect(answer.text).toContain('(ffmpeg could not cut the frame of /rec/transition.mov at 0 s (exit code 3: the stream is damaged))')
})

test('where the picture of a recording stood still to its end and ffmpeg has no frame there, the frame is cut from just before, and says when', { options: JEV }, async ($, on) => {
  // The last frame of this recording is at 3 s, though it runs to 3.5 s.
  const w = world($, on, { session: true, process: { programs: { ffmpeg: ffmpeg({ [REC]: { seconds: 3.5, width: 390, height: 844, gapAtEnd: 0.5 } }) } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.visualCheck({ images: [REC], checks: CHECKS })

  const listed: { seconds: number; frame: string }[] = w.requests[0]?.body.state.frames
  expect(listed).toHaveLength(12)
  // The moment 3.09 s had no frame: 0.25 s before it (2.84 s) one. The moment 3.4 s none, nor 0.25 s before it (3.15 s); 1 s before it (2.4 s) one.
  expect(listed.map((frame) => frame.seconds).slice(-3)).toEqual([2.78, 2.84, 2.4])
  for (const frame of listed) expect(readFake(w.requests[0]?.body.assets[frame.frame].data_base64)?.label).toBe(`${REC} @${frame.seconds.toFixed(3)}s`)
})

// ---- What a recording is not for -----------------------------------------------------------------------

test('a recording is not compared with a reference or another screenshot, nor can a reference be one: the checks are UNSURE and the reason says so', { options: JEV }, async ($, on) => {
  const files = { '/design/card.png': { format: 'png', width: 390, height: 844 }, '/shots/now.png': { format: 'png', width: 390, height: 844 } }
  const w = world($, on, { session: true, files, process: { programs: { ffmpeg: ffmpeg(VIDEOS) } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  const against = read(await w.visualCheck({ images: [REC], reference: ['/design/card.png'], checks: CHECKS }))
  const other = read(await w.visualCheck({ images: [REC], compare_to: '/shots/now.png', checks: CHECKS }))
  const asReference = read(await w.visualCheck({ images: ['/shots/now.png'], reference: [REC], checks: CHECKS }))

  expect(w.requests).toHaveLength(0)
  expect(against.text).toContain('(/rec/transition.mov is a recording, which is checked against a spec or on the wording of the checks alone, not against a reference)')
  expect(other.text).toContain('not against another screenshot)')
  expect(asReference.text).toContain('(/rec/transition.mov is a recording, and only the screenshot to check can be one)')
})

test('a span that is not a span is answered with what is wrong, and asks nothing', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: { programs: { ffmpeg: ffmpeg(VIDEOS) } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  const call = async (input: Record<string, unknown>) => (await w.visualCheck({ images: [REC], checks: CHECKS, ...input })).result

  expect(await call({ from_seconds: -1 })).toBe('visual_check: from_seconds must be a number of seconds, 0 or more.')
  expect(await call({ to_seconds: 'soon' })).toBe('visual_check: to_seconds must be a number of seconds, 0 or more.')
  expect(await call({ from_seconds: 2, to_seconds: 2 })).toBe('visual_check: to_seconds (2) must be after from_seconds (2).')
  expect(w.requests).toHaveLength(0)
  // A number of seconds as a string is a number of seconds.
  expect(JSON.stringify(await call({ from_seconds: '1', to_seconds: '2' }))).toContain('Visual check of /rec/transition.mov')
})

// ---- look ---------------------------------------------------------------------------------------------

test('look on a recording hands back 8 frames of it, through the span named, after a line that says when each was cut; nothing is asked', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: { programs: { ffmpeg: ffmpeg(VIDEOS) } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  const answer = read(await w.visualCheck({ images: [REC], look: true, from_seconds: 1, to_seconds: 2.4 }))

  expect(answer.types).toEqual(['text', ...Array(8).fill('image')])
  expect(answer.text).toBe('Frames of /rec/transition.mov, in order of time, cut at 1 s, 1.2 s, 1.4 s, 1.6 s, 1.8 s, 2 s, 2.2 s, 2.4 s.')
  expect(answer.blocks.slice(1).map((block) => readFake(block.source?.data ?? '')?.label)).toEqual([1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4].map((seconds) => `${REC} @${seconds.toFixed(3)}s`))
  expect(w.requests).toHaveLength(0)
})

test('look on a recording ffmpeg cannot read is a line saying why, among the other images', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, process: { programs: { ffmpeg: null } }, files: { '/shots/a.png': { format: 'png', width: 800, height: 600 } }, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  const answer = read(await w.visualCheck({ images: ['/shots/a.png', REC], look: true }))

  expect(answer.types).toEqual(['image', 'text'])
  expect(answer.blocks[1]?.text).toContain('ffmpeg could not be run (spawn ffmpeg ENOENT)')
})
