// visual_check with a series of quality levels (#61, ADR 0008): the agent hands over screenshots of one view at rising levels, and
// the tool compares each two neighbours in every part the checks name, by the zoomed re-check, and says from which level on the
// higher ones no longer look different. "No difference" needs every part to pass. Seam 1, as visual-check.test.ts: the tool call in,
// the answer out, the decision model a fake that answers by pair (tests/support/series.ts).

import { expect, test } from 'claude-code/testing'
import { level, levels, seriesBackend } from './support/series.ts'
import { world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }
const FOAM = { part: 'the waves near the horizon', property: 'foam density' }
const SUN = { part: 'the reflection of the sun', property: 'brightness' }

type Block = { type: string; text?: string }
/** The answer's text, as lines; the answer is one block of text. */
function read(answer: { result?: unknown }): string[] {
  const blocks = answer.result as Block[]
  expect(Array.isArray(blocks)).toBe(true)
  expect(blocks.map((block) => block.type)).toEqual(['text'])
  return (blocks[0]?.text ?? '').split('\n')
}

test('each two neighbouring levels are compared in the named part, and the answer says from which level on the higher ones look alike', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: levels(3), process: true, backend: seriesBackend({ zoom: { '1-2': 0.1, '2-3': 0.95 } }) })
  await w.start()
  const lines = read(await w.visualCheck({ images: [level(1), level(2), level(3)], sequence: true, checks: [FOAM] }))

  expect(lines).toEqual([
    'Visual check of a series of 3 quality levels, in the order given:',
    'level 1: /levels/1.png',
    'level 2: /levels/2.png',
    'level 3: /levels/3.png',
    'Level 1 to level 2: DIFFERENT',
    '  1. FAIL 0.10 (zoomed crop) the waves near the horizon: foam density',
    'Level 2 to level 3: NO DIFFERENCE',
    '  1. PASS 0.95 (zoomed crop) the waves near the horizon: foam density',
    'Result: from level 2 upward no difference was seen in the parts you named. Level 2 is the lowest level beyond which a higher one looks the same there.',
    'PASS only means that nothing obviously wrong was seen; it is not an acceptance. A still shows no flicker or jitter: compare frames of a recording for those.',
    'In your final report list the levels you tried, the parts you compared, and the result with these probabilities.',
  ])
})

test('every pair is asked about on its own: the parts located in both of its images, then one question for each part on the crops', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: levels(3), process: true, backend: seriesBackend({ zoom: { '1-2': 0.1, '2-3': 0.95 } }) })
  await w.start()
  await w.visualCheck({ images: [level(1), level(2), level(3)], sequence: true, checks: [FOAM, SUN] })

  // For each pair: one request of Boxes (the part in both images, and where they differ) and one of crops; the higher level is the candidate.
  const ids = w.requests.map((request) => Object.keys(request.body.questions))
  expect(ids.filter((one) => one.includes('box.0.candidate'))).toHaveLength(2)
  expect(ids.filter((one) => one[0] === 'box.0.candidate')[0]).toEqual(['box.0.candidate', 'box.0.other', 'box.1.candidate', 'box.1.other', 'where.screen'])
  expect(ids.filter((one) => one[0]?.startsWith('zoom.'))).toEqual([['zoom.0.0', 'zoom.1.0'], ['zoom.0.0', 'zoom.1.0']])
  expect(w.requests).toHaveLength(4)
})

test('many large levels go out in waves: the pairs of a wave at once, a wave after the other, so that every request waits within its own limit', { options: JEV }, async ($, on) => {
  // 9 levels of 1568 x 1568: a pair is about 12,800 tokens of images, so five pairs fill a wave (72,000), and 8 pairs are two waves.
  const w = world($, on, {
    session: true,
    files: levels(9, { width: 1568, height: 1568 }),
    process: true,
    backend: (request) => ({ after: 1000, reply: seriesBackend({ zoom: { '1-2': 0.95 } })(request) }),
  })
  await w.start()
  const call = w.visualCheck({ images: Array.from({ length: 9 }, (_, i) => level(i + 1)), sequence: true, checks: [FOAM] })
  for (let i = 0; i < 8; i++) {
    await w.clock.settle()
    await w.clock.advance(1000)
  }
  const lines = read(await call)

  // The Boxes of the first five pairs go out together, the other three after the first wave is done (a request of Boxes and one of crops, a second each).
  const boxes = w.requests.filter((request) => Object.keys(request.body.questions).includes('box.0.candidate'))
  expect(boxes.map((request) => request.at)).toEqual([0, 0, 0, 0, 0, 2000, 2000, 2000])
  expect(lines.filter((line) => line.startsWith('Level ')).length).toBe(8)
})

test('a request that waits longer than the limit is given up on, and only the checks of its pair are unsure', { options: JEV }, async ($, on) => {
  const w = world($, on, {
    session: true,
    files: levels(3),
    process: true,
    backend: seriesBackend({ zoom: { '2-3': 0.95 }, reply: { '1-2': { after: 20_000, reply: { status: 200, body: {} } } } }),
  })
  await w.start()
  const call = w.visualCheck({ images: [level(1), level(2), level(3)], sequence: true, checks: [FOAM] })
  await w.clock.settle()
  await w.clock.advance(8000)
  const lines = read(await call)

  expect(lines).toContain('Level 1 to level 2: UNSURE')
  expect(lines).toContain('  1. UNSURE n/a (whole image) the waves near the horizon: foam density (the parts could not be located (jev: no answer in 8000 ms))')
  expect(lines).toContain('Level 2 to level 3: NO DIFFERENCE')
  expect(result(lines)).toContain('from level 2 upward')
})

const result = (lines: string[]): string => lines.find((line) => line.startsWith('Result:')) ?? ''

test('one named part that fails is enough: the pair is not the same, and when it is the top pair there is no level from which the higher ones look alike', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: levels(3), process: true, backend: seriesBackend({ zoom: { '1-2': 0.97, '2-3': { 'zoom.0.0': 0.97, 'zoom.1.0': 0.1 } } }) })
  await w.start()
  const lines = read(await w.visualCheck({ images: [level(1), level(2), level(3)], sequence: true, checks: [FOAM, SUN] }))

  expect(lines).toContain('Level 1 to level 2: NO DIFFERENCE')
  expect(lines).toContain('Level 2 to level 3: DIFFERENT')
  expect(lines).toContain('  1. PASS 0.97 (zoomed crop) the waves near the horizon: foam density')
  expect(lines).toContain('  2. FAIL 0.10 (zoomed crop) the reflection of the sun: brightness')
  expect(result(lines)).toBe('Result: no level was found from which the higher ones look the same: the top pair, level 2 to level 3, still differs.')
})

test('when every pair differs, every level does', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: levels(4), process: true, backend: seriesBackend({ zoom: { '1-2': 0.05, '2-3': 0.1, '3-4': 0.15 } }) })
  await w.start()
  const lines = read(await w.visualCheck({ images: [level(1), level(2), level(3), level(4)], sequence: true, checks: [FOAM] }))

  expect(result(lines)).toBe('Result: every level differs from the next in the parts you named, up to the top: no level was found from which the higher ones look the same.')
  expect(lines.join('\n')).not.toContain('PASS only means')
})

test('a part the model is not sure of is not a pass: the pair is UNSURE, and a top pair that is unsure leaves the level unknown', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: levels(3), process: true, backend: seriesBackend({ zoom: { '1-2': 0.97, '2-3': 0.6 } }) })
  await w.start()
  const lines = read(await w.visualCheck({ images: [level(1), level(2), level(3)], sequence: true, checks: [FOAM] }))

  expect(lines).toContain('Level 2 to level 3: UNSURE')
  expect(lines).toContain('  1. UNSURE 0.60 (zoomed crop) the waves near the horizon: foam density (the decision model is not sure either way)')
  expect(result(lines)).toBe('Result: it could not be told from which level on the higher ones look alike: the top pair, level 2 to level 3, is UNSURE. Look at those two levels yourself (visual_check with look: true).')
})

test('when every pair looks the same the higher levels look like the first from the start', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: levels(3), process: true, backend: seriesBackend({ zoom: { '1-2': 0.95, '2-3': 0.93 } }) })
  await w.start()
  const lines = read(await w.visualCheck({ images: [level(1), level(2), level(3)], sequence: true, checks: [FOAM] }))

  expect(result(lines)).toBe('Result: from level 1 upward no difference was seen in the parts you named. Level 1 is the lowest level beyond which a higher one looks the same there.')
})

test('the place the whole screen differs in, which no check named, is told under its pair; it does not change the pair\'s result', { options: JEV }, async ($, on) => {
  const place = { box: { top: 0.1, bottom: 0.3, left: 0.1, right: 0.6 }, confidence: 0.4 }
  const w = world($, on, { session: true, files: levels(2), process: true, backend: seriesBackend({ zoom: { '1-2': 0.95 }, boxes: { 'where.screen': place } }) })
  await w.start()
  const lines = read(await w.visualCheck({ images: [level(1), level(2)], sequence: true, checks: [FOAM], same_view: true }))

  expect(lines).toContain('Level 1 to level 2: NO DIFFERENCE')
  expect(lines).toContain('  Another place may differ, which none of your checks named: 10% to 60% across and 10% to 30% down the screenshot (10% of it; the model is 0.40 sure of the place). Look at it yourself.')
})
