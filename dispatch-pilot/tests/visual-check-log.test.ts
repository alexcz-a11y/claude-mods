// visual_check (#57): what the debug log says of a call. The images are heavy and private: it records how many there were, their
// sizes and what they cost, and never their content (nor a key). Seam 1: the log lines the world collects.

import { expect, test } from 'claude-code/testing'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import { jev, world } from './support/world.ts'

const KEY = 'ts-test-key-4d9e'
const SHOT = '/shots/home.png'
const FILES = { [SHOT]: { format: 'png', width: 1200, height: 800 } }
const CHECK = [{ part: 'the title', property: 'is fully visible' }]

/** The base64 of the first image of the request the world last got. */
function imageOf(request: { body: any } | undefined): string {
  return (Object.values(request?.body.assets ?? {})[0] as { data_base64: string }).data_base64
}

test('the debug log has one line for the request: its questions, who answered, how many images, their sizes and about what they cost; the images and the key are not in it', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.95 } }) })
  await w.start()
  await w.visualCheck({ images: [SHOT], checks: CHECK })

  const lines = w.logs.filter((log) => log.to === 'debug' && log.text.startsWith('visual_check'))
  expect(lines.map((log) => log.text)).toEqual([`visual_check request [check.0] to jev: answered in 0 ms by ${JEV_MODEL} (300 input tokens); images: 1 (1200x800), about 2496 tokens`])
  for (const log of w.logs) {
    expect(log.text).not.toContain(imageOf(w.requests[0]))
    expect(log.text).not.toContain(KEY)
  }
})

test('a failure whose body echoes the image and the key is logged with neither', { options: { typesafeApiKey: KEY } }, async ($, on) => {
  const echo = (request: { body: any }) => ({ status: 400, body: `bad image ${imageOf(request)}, key ${KEY}` })
  const w = world($, on, { session: true, files: FILES, process: true, backend: echo })
  await w.start()
  const answer = await w.visualCheck({ images: [SHOT], checks: CHECK })

  const line = w.logs.find((log) => log.to === 'debug' && log.text.startsWith('visual_check request'))
  expect(line?.text).toContain('HTTP 400: bad image [base64 left out]')
  for (const log of w.logs) {
    expect(log.text).not.toContain(imageOf(w.requests[0]))
    expect(log.text).not.toContain(KEY)
  }
  // The agent’s answer carries neither.
  expect(JSON.stringify(answer.result)).not.toContain(KEY)
})
