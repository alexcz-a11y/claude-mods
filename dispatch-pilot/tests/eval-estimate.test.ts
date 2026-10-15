// What a run is estimated to send (`eval/run.ts --estimate`, `--max-usd`): the mod's token estimate of the text, and, for a request with
// images, the pixels' tokens the decision model counts (Jev about 2,600 a megapixel, once; pplx about 1,000, for each question), never the
// length of the base64 the images travel as (a text estimate would take that for about 0.25 token a character, far more than any model bills).

import { expect, test } from 'claude-code/testing'
import { estimateTokens } from '../hooks/decision/context.ts'
import { estimateRequest, estimateRun } from '../eval/lib/estimate.ts'
import { imageRef } from '../hooks/decision/images.ts'
import type { DecisionRequest } from '../hooks/decision/system-one.ts'

const TEXT: DecisionRequest = { state: { user_message: 'Rename the helper everywhere' }, questions: { 'effort.level': { type: 'score', instructions: 'How much effort?', criteria: ['low', 'high'] } } }
/** A request with one picture of a megapixel whose bytes are a million characters: 0.25 token each, as text, would be 250,000 tokens. */
const PICTURE: DecisionRequest = {
  state: { candidate: imageRef('candidate') },
  questions: { 'check.0': { type: 'noul', instructions: 'Same?' }, 'check.1': { type: 'noul', instructions: 'Same too?' }, 'check.2': { type: 'noul', instructions: 'And this?' } },
  images: [{ name: 'candidate', format: 'png', base64: 'A'.repeat(1_000_000), width: 1000, height: 1000 }],
}

test('a request without images is estimated as it always was: the mod\'s estimate of the request as it goes out, with its model', () => {
  const text = estimateRequest(TEXT, 'jev-latest', 'jev')
  expect(text).toEqual({ text: estimateTokens(JSON.stringify({ model: 'jev-latest', ...TEXT })), images: 0 })
  expect(text.text).toBeGreaterThan(0)
})

test('the pixels of an image are what it costs, however long its bytes are: Jev counts a megapixel once whatever the questions, about 2,600 tokens', () => {
  const estimate = estimateRequest(PICTURE, 'jev-1.14.0', 'jev')
  expect(estimate.images).toBe(2600)
  // The text is the request without its pictures.
  const { images: _images, ...without } = PICTURE
  expect(estimate.text).toBe(estimateTokens(JSON.stringify({ model: 'jev-1.14.0', ...without })))
  expect(estimate.text).toBeLessThan(200)
})

test('pplx counts the pixels again for each question: about 1,000 tokens a megapixel, three questions, 3,000', () => {
  expect(estimateRequest(PICTURE, 'pplx-decider-v1.1-27b', 'pplx').images).toBe(3000)
})

test("the price of a run is the text's estimate times the factor (what the decision model counted over what the mod estimates), plus the pictures' tokens as they are, at the decision model's price", () => {
  const requests = [TEXT, PICTURE]
  const sums = requests.map((request) => estimateRequest(request, 'jev-1.14.0', 'jev'))
  const tokens = Math.round(1.6 * (sums[0]!.text + sums[1]!.text) + sums[0]!.images + sums[1]!.images)
  expect(estimateRun(requests, { model: 'jev-1.14.0', backend: 'jev', factor: 1.6, usdPerMillionTokens: 0.042 })).toEqual({ tokens, usd: (tokens * 0.042) / 1e6 })
  // Without a picture it is the sum the text estimate always gave.
  expect(estimateRun([TEXT], { model: 'jev-1.14.0', backend: 'jev', factor: 1.6, usdPerMillionTokens: 0.042 }).tokens).toBe(Math.round(1.6 * estimateTokens(JSON.stringify({ model: 'jev-1.14.0', ...TEXT }))))
})
