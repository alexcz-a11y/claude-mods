// visual_check with a series of quality levels (#61): the calls it turns away with a word, what it does when a level cannot be read,
// what the tool's description tells the agent about it, and that pplx, which cannot do the zoomed re-check a series is made of,
// says so. Seam 1, as visual-check.test.ts: the tool never fails, it answers.

import { expect, test } from 'claude-code/testing'
import { level, levels, seriesBackend } from './support/series.ts'
import { pplx, world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }
const PPLX = { perplexityApiKey: 'pplx-test-key' }
const FOAM = { part: 'the waves near the horizon', property: 'foam density' }

// ---- Calls that cannot be taken ------------------------------------------------------------

test('a series needs at least two levels and at most twelve; the call that gives another number is answered with that, and asks nothing', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: levels(13), process: true, backend: seriesBackend() })
  await w.start()
  const call = async (count: number) => (await w.visualCheck({ images: Array.from({ length: count }, (_, i) => level(i + 1)), sequence: true, checks: [FOAM] })).result

  expect(await call(1)).toBe('visual_check with sequence: true compares each two neighbouring levels: give at least two images in images, lowest level first (you gave 1).')
  expect(await call(13)).toBe('visual_check with sequence: true takes at most 12 levels in one call (you gave 13): compare the ones around the level you suspect.')
  expect(w.requests).toHaveLength(0)
})

test('a series is checked against nothing else: sequence with a reference is turned away', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: levels(3), process: true, backend: seriesBackend() })
  await w.start()
  const answer = await w.visualCheck({ images: [level(1), level(2)], sequence: true, reference: [level(3)], checks: [FOAM] })

  expect(answer.result).toBe('visual_check checks against one thing: give only one of reference, compare_to, sequence and spec (you gave reference and sequence).')
})

// ---- Levels that cannot be used ------------------------------------------------------------

test('a level that cannot be read ends the call with the reason and the way out, and asks nothing', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: levels(2), process: true, backend: seriesBackend() })
  await w.start()
  const answer = await w.visualCheck({ images: [level(1), level(2), '/levels/missing.png'], sequence: true, checks: [FOAM] })

  expect(JSON.stringify(answer.result)).toContain('visual_check could not read the levels: ')
  expect(JSON.stringify(answer.result)).toContain('missing.png')
  expect(JSON.stringify(answer.result)).toContain('Look at the levels yourself (visual_check with look: true).')
  expect(w.requests).toHaveLength(0)
})

test('a recording is not a level: a series is stills, and the answer says how to cut the same moment out of each recording', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: levels(2), process: true, backend: seriesBackend() })
  await w.start()
  const answer = await w.visualCheck({ images: [level(1), '/levels/2.mov'], sequence: true, checks: [FOAM] })

  expect(JSON.stringify(answer.result)).toContain('/levels/2.mov is a recording, and a series is compared on stills: cut the same moment from the recording of each level')
  expect(w.requests).toHaveLength(0)
})

// ---- pplx ----------------------------------------------------------------------------------

test('with pplx a series is not compared: the answer says that it needs the zoomed re-check, which is not available, and asks nothing', { options: PPLX }, async ($, on) => {
  const w = world($, on, { session: true, files: levels(3), process: true, backend: pplx([0, 1, 0, 0, 0]) })
  await w.start()
  const answer = await w.visualCheck({ images: [level(1), level(2), level(3)], sequence: true, checks: [FOAM] })

  expect(answer.result).toBe(
    'visual_check cannot compare a series of quality levels now: a series is compared pair by pair on enlarged crops (the zoomed re-check), which needs a TypeSafe key, and the decision model that takes images here is pplx. Look at the levels yourself (visual_check with look: true), or compare two of them at a time with compare_to, which with pplx catches only clear differences.',
  )
  expect(w.requests).toHaveLength(0)
})

// ---- What the agent reads of the tool ------------------------------------------------------

test('the tool\'s description says what a series is for, that every named part must pass, that motion needs frames of a recording, and what the final report lists', { options: JEV }, async ($, on) => {
  const jev = world($, on, { session: true })
  await jev.start()
  const description = jev.tools.find((tool) => tool.name === 'visual_check')?.description ?? ''

  expect(description).toContain('To find the quality level from which higher ones look no different, give the screenshots of one view at rising levels in images, lowest first (2 to 12 levels), with sequence: true')
  expect(description).toContain('each two neighbouring levels are compared in every part you name')
  expect(description).toContain('no difference only if every part you named passes')
  expect(description).toContain('A still does not show flicker or rippling jitter: for those cut the same moment out of a recording of each level (for example with ffmpeg) and give those frames as the series')
  expect(description).toContain('List the levels you tried, the parts you compared, the result and the probabilities')
})

test('the description of the pplx tool says a series is not available there', { options: PPLX }, async ($, on) => {
  const w = world($, on, { session: true })
  await w.start()
  const description = w.tools.find((tool) => tool.name === 'visual_check')?.description ?? ''

  expect(description).toContain('sequence (a series of quality levels) is not available: it needs the zoomed re-check')
  expect(description).not.toContain('To find the quality level')
})
