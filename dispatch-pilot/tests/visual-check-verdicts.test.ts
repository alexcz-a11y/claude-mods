// visual_check (#57): how the decision model's probabilities become verdicts, and what the answer carries with them. Seam 1, as
// visual-check.test.ts.

import { expect, test } from 'claude-code/testing'
import { jev, world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }

const SHOT = '/shots/home.png'
/** A screenshot within what Jev takes: no program needs to touch it. */
const FILES = { [SHOT]: { format: 'png', width: 1200, height: 800 } }
const ACCOUNT_CHECKS = [
  { part: 'the primary button', property: 'has the label Upgrade to Premium' },
  { part: 'the tab bar', property: 'shows four tabs' },
]

test('a probability of 0.2 or less is a FAIL, and between the bars a check is UNSURE: its reason is in the answer, and the screenshot comes along, scaled down, for the agent to look at', { options: JEV }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.95, 'check.1': 0.12, 'check.2': 0.55 } }) })
  await w.start()
  const answer = await w.visualCheck({
    images: [SHOT],
    spec: 'The Account screen of the app.',
    checks: [...ACCOUNT_CHECKS, { part: 'the title', property: 'reads "Account"' }],
  })

  const assets = w.requests[0]?.body.assets
  const picture = assets[Object.keys(assets)[0] as string]
  expect(answer.result).toEqual([
    {
      type: 'text',
      text: [
        'Visual check of /shots/home.png against the spec: 1 PASS, 1 FAIL, 1 UNSURE.',
        '1. PASS 0.95 (whole image) the primary button: has the label Upgrade to Premium',
        '2. FAIL 0.12 (whole image) the tab bar: shows four tabs',
        '3. UNSURE 0.55 (whole image) the title: reads "Account" (the decision model is not sure either way)',
        'The number is the probability that the check holds. PASS only means that nothing obviously wrong was seen; it is not an acceptance.',
        'The screenshot is attached, scaled down: look at it yourself for what is UNSURE.',
      ].join('\n'),
    },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: picture.data_base64 } },
  ])
})

test('the bars are 0.9 and 0.2 and both are in: 0.9 passes, 0.89 is unsure, 0.21 is unsure, 0.2 fails', { options: JEV }, async ($, on) => {
  const nouls = { 'check.0': 0.9, 'check.1': 0.89, 'check.2': 0.21, 'check.3': 0.2 }
  const w = world($, on, { session: true, files: FILES, process: true, backend: jev([0, 1, 0, 0, 0], { nouls }) })
  await w.start()
  const answer = await w.visualCheck({ images: [SHOT], checks: ['a', 'b', 'c', 'd'].map((property) => ({ part: 'the button', property })) })

  const blocks = answer.result as { type: string; text?: string }[]
  expect(blocks[0]?.text?.split('\n').slice(1, 5).map((line) => line.split(' ').slice(0, 3).join(' '))).toEqual(['1. PASS 0.90', '2. UNSURE 0.89', '3. UNSURE 0.21', '4. FAIL 0.20'])
})
