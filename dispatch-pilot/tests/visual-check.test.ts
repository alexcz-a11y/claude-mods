// visual_check (#57, ADR 0008): an agent hands the tool screenshots and checks, and the decision model answers pass, fail or
// unsure for each. Seam 1: the engine's session start and tool call in; the files and programs the mod meets (the world's
// disk and its sips), the requests that reach the decision model and the tool's answer out. The pure parts (the questions, the
// verdicts, the sizes) are only tested through here.

import { expect, test } from 'claude-code/testing'
import { readFake } from './support/images.ts'
import { jev, world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }
const PPLX = { perplexityApiKey: 'pplx-test-key' }

const TOOL = 'visual_check'

// ---- Registration -------------------------------------------------------------

test('with a TypeSafe key visual_check is registered in the tool list: it takes images, one comparison and checks; its description never changes', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true })
  await w.start()
  // Loaded again later in the same session, the switch turned off meanwhile.
  await w.command('dp', 'visual-check off')
  await w.start()

  const registered = w.tools.filter((tool) => tool.name === TOOL)
  expect(registered).toHaveLength(2)
  const [first, again] = registered
  expect(first?.isDeferred).toBe(false)
  expect(first?.inputSchema).toMatchObject({
    type: 'object',
    required: ['images'],
    properties: {
      images: { type: 'array' },
      reference: {},
      compare_to: { type: 'string' },
      sequence: { type: 'boolean' },
      spec: { type: 'string' },
      same_view: { type: 'boolean' },
      checks: { type: 'array' },
      look: { type: 'boolean' },
    },
  })
  expect(again).toEqual(first)
  // Jev can crop the part a check names out of both images and look at it again.
  expect(first?.description).toContain('enlarged')
})

test('with only a Perplexity key the tool is registered, and its description does not promise a zoomed re-check', { options: PPLX }, async ($, on) => {
  const w = world($, on, { session: true })
  await w.start()
  const tool = w.tools.find((registered) => registered.name === TOOL)
  expect(tool?.isDeferred).toBe(false)
  expect(tool?.description).toBeTruthy()
  expect(tool?.description).not.toContain('enlarged')
})

// The engine cuts the description of an MCP tool to its first 4096 characters (Claude Code 2.1.300: "Tool "visual_check" description
// truncated from 4445 to 4096 chars"), so what stands past that never reaches the model. Both versions have to fit.
const ENGINE_DESCRIPTION_LIMIT = 4096

for (const [name, options] of [['Jev', JEV], ['pplx', PPLX]] as const) {
  test(`the ${name} description of visual_check fits what the engine passes on to the model`, { options }, async ($, on) => {
    const w = world($, on, { session: true })
    await w.start()
    const description = w.tools.find((tool) => tool.name === TOOL)?.description ?? ''
    expect(description.length).toBeGreaterThan(0)
    expect(description.length).toBeLessThanOrEqual(ENGINE_DESCRIPTION_LIMIT)
  })

  // Should the description ever outgrow the limit again, the engine cuts the end: so what every call needs stands before the
  // details of the zoomed re-check, of a series and of a recording.
  test(`the ${name} description puts the guidance every call needs before the details`, { options }, async ($, on) => {
    const w = world($, on, { session: true })
    await w.start()
    const description = w.tools.find((tool) => tool.name === TOOL)?.description ?? ''
    const details = ['enlarged', 'quality level', 'screen recording', 'it can only look at the whole images'].map((marker) => description.indexOf(marker)).filter((at) => at >= 0)
    expect(details.length).toBeGreaterThan(0)
    const detailsStart = Math.min(...details)
    for (const guidance of [
      'Each check names one part of the image and one visible property of it',
      'Write each check against something visible in the image (another element, the edge of the frame, a marked target), not against pixel coordinates.',
      'It cannot verify numbers (sizes, corner radii, color values, font weights): read those from the code or the runtime',
      'PASS only means that nothing obviously wrong was seen',
      'If the same check fails twice in a row, look at the image yourself before you change anything else',
      'With look: true',
      'look at the final result yourself once',
      'in your final report',
    ]) {
      const at = description.indexOf(guidance)
      expect(at, guidance).toBeGreaterThanOrEqual(0)
      expect(at, guidance).toBeLessThan(detailsStart)
    }
  })
}

test('with neither key the tool is not registered: no decision model could take an image', async ($, on) => {
  const w = world($, on, { session: true })
  await w.start()
  expect(w.tools.find((tool) => tool.name === TOOL)).toBeUndefined()
})

// ---- Checks against a spec ----------------------------------------------------------

const SHOT = '/shots/home.png'
/** A screenshot within what Jev takes: no program needs to touch it. */
const FILES = { [SHOT]: { format: 'png', width: 1200, height: 800 } }
const ACCOUNT_CHECKS = [
  { part: 'the primary button', property: 'has the label Upgrade to Premium' },
  { part: 'the tab bar', property: 'shows four tabs' },
]

test('the checks against a spec go to Jev in one request with the screenshot in its assets, and a probability of 0.8 or more is a PASS the answer reports in words', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.95, 'check.1': 0.93 } }) })
  await w.start()
  const answer = await w.visualCheck({ images: [SHOT], spec: 'The Account screen of the app.', checks: ACCOUNT_CHECKS })

  expect(w.requests).toHaveLength(1)
  const sent = w.requests[0]
  expect(sent?.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(sent?.headers['TypeSafe-Danger-Zone-Images']).toBe('true')
  expect(sent?.body.model).toBe('jev-1.14.0')
  const [reference, ...others] = Object.keys(sent?.body.assets)
  expect(others).toEqual([])
  expect(reference).toMatch(/-screenshot$/)
  expect(sent?.body.state).toEqual({ screenshot: reference, specification: 'The Account screen of the app.' })
  const picture = sent?.body.assets[reference as string]
  expect(picture).toMatchObject({ type: 'image', format: 'png' })
  expect(readFake(picture.data_base64)).toMatchObject({ format: 'png', width: 1200, height: 800 })
  expect(sent?.body.questions).toEqual({
    'check.0': {
      type: 'noul',
      instructions: 'In `screenshot`, does the primary button meet this requirement: has the label Upgrade to Premium? The specification it belongs to is in `specification`.',
    },
    'check.1': {
      type: 'noul',
      instructions: 'In `screenshot`, does the tab bar meet this requirement: shows four tabs? The specification it belongs to is in `specification`.',
    },
  })

  // A PASS brings no image: the answer is one block of text.
  expect(answer.result).toEqual([
    {
      type: 'text',
      text: [
        'Visual check of /shots/home.png against the spec: 2 PASS.',
        '1. PASS 0.95 (whole image) the primary button: has the label Upgrade to Premium',
        '2. PASS 0.93 (whole image) the tab bar: shows four tabs',
        'The number is the probability that the check holds. PASS only means that nothing obviously wrong was seen; it is not an acceptance.',
      ].join('\n'),
    },
  ])
})
