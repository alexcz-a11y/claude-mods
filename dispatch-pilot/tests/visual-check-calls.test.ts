// visual_check (#57): the calls the tool refuses or turns away with a word, the switch, and a dispatched agent's call. Seam 1, as
// visual-check.test.ts: the tool never fails, it answers.

import { expect, test } from 'claude-code/testing'
import { jev, world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }
const SHOT = '/shots/home.png'
const FILES = { [SHOT]: { format: 'png', width: 1200, height: 800 }, '/shots/other.png': { format: 'png', width: 1200, height: 800 } }
const CHECKS = [{ part: 'the title', property: 'is fully visible' }]

// ---- The switch ---------------------------------------------------------------------

test('visual-check is a switch of /dp, on unless the person turns it off; off, a call asks nothing and says it is off', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  expect(await w.command('dp', 'status')).toContain('开  visual-check')
  expect(await w.command('dp', 'visual-check off')).toContain('visual-check 已关闭')

  const answer = await w.visualCheck({ images: [SHOT], checks: CHECKS })
  expect(answer.result).toBe('visual_check is switched off (/dp visual-check on turns it back on), so it checked nothing. Look at the images yourself.')
  expect(w.requests).toHaveLength(0)

  await w.command('dp', 'visual-check on')
  expect(JSON.stringify((await w.visualCheck({ images: [SHOT], checks: CHECKS })).result)).toContain('Visual check of /shots/home.png')
})

test('with Dispatch Pilot switched off as a whole a call asks nothing either', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  await w.command('dp', 'off')
  const answer = await w.visualCheck({ images: [SHOT], checks: CHECKS })

  expect(answer.result).toBe('Dispatch Pilot is switched off (/dp on turns it back on), so visual_check checked nothing. Look at the images yourself.')
  expect(w.requests).toHaveLength(0)
})

// ---- Calls that cannot be taken ------------------------------------------------------------

test('a call that is not whole is answered with what it lacks, and asks nothing', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()
  const call = async (input: Record<string, unknown>) => (await w.visualCheck(input)).result

  expect(await call({ checks: CHECKS })).toBe('visual_check needs images: the path of the screenshot to check.')
  expect(await call({ images: [SHOT] })).toBe(
    'visual_check needs checks: each names a part of the image and one visible property of it, e.g. { "part": "the primary button", "property": "corner radius" }.',
  )
  expect(await call({ images: [SHOT], checks: [{ part: 'a', property: '   ' }] })).toContain('visual_check needs checks')
  expect(await call({ images: [SHOT, '/shots/other.png'], checks: CHECKS })).toBe('visual_check checks one screenshot per call: give one path in images, and call it again for the next screenshot.')
  expect(await call({ images: [SHOT], reference: ['/design/a.png'], spec: 'x', checks: CHECKS })).toBe(
    'visual_check checks against one thing: give only one of reference, compare_to, sequence and spec (you gave reference and spec).',
  )
  expect(await call({ images: [SHOT], checks: Array.from({ length: 25 }, (_, i) => ({ part: 'p', property: `q${i}` })) })).toBe(
    'visual_check takes at most 24 checks in one call (you gave 25): split them over two calls.',
  )
  expect(await call({ images: Array.from({ length: 9 }, (_, i) => `/shots/${i}.png`), look: true })).toBe('visual_check with look: true returns at most 8 images at once (you gave 9).')
  expect(w.requests).toHaveLength(0)
})

test('a path is only trimmed at its ends: a U+202F before AM (a macOS screenshot name) or a run of spaces inside it stays, in images and in compare_to', { options: JEV }, async ($, on) => {
  const MAC = '/shots/Screenshot 2026-10-15 at 10.00.00 AM.png'
  const SPACED = '/shots/two  spaces.png'
  const files = { [MAC]: { format: 'png', width: 1200, height: 800 }, [SPACED]: { format: 'png', width: 1200, height: 800 } }
  const w = world($, on, { session: true, files, process: true, backend: jev([0, 1, 0, 0, 0]) })
  await w.start()

  const mac = JSON.stringify((await w.visualCheck({ images: [`  ${MAC}\n`], checks: CHECKS })).result)
  expect(mac).toContain(`Visual check of ${MAC} `)
  const both = JSON.stringify((await w.visualCheck({ images: [SPACED], compare_to: ` ${MAC} `, checks: CHECKS })).result)
  expect(both).toContain(`Visual check of ${SPACED} against the other screenshot`)
})

// ---- Who calls ---------------------------------------------------------------------------------------

test('a dispatched agent calls it as the main agent does: the same request, the same answer', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.95 } }) })
  await w.start()
  const main = await w.visualCheck({ images: [SHOT], checks: CHECKS })
  const agent = await w.visualCheck({ images: [SHOT], checks: CHECKS }, { agentId: 'a1' })

  expect(agent.result).toEqual(main.result)
  expect(w.requests).toHaveLength(2)
  // Only the references the images get differ: they are new for each request.
  const shape = (body: any) => JSON.stringify(body).replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ID')
  expect(shape(w.requests[1]?.body)).toBe(shape(w.requests[0]?.body))
})
