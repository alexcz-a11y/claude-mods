// The complexity reading (#63, ADR 0008), seam 2: the question that asks how complex it is to build what reference images show,
// how its answer is read, what the effort request is told of it, and how a group of images is recognised again. Pure, shared with
// the eval (#65) and with the mid-turn re-decision and the dispatched agents (#64), which read the same way.

import { expect, test } from 'claude-code/testing'
import {
  COMPLEXITY_LEVELS,
  complexityLimits,
  complexityRequest,
  MAX_REFERENCE_IMAGES,
  readComplexity,
  REFERENCE_FIELD,
  referenceKey,
  referenceState,
  REFERENCE_MAX_PIXELS,
} from '../hooks/decision/complexity.ts'
import { limitsFor } from '../hooks/decision/image-fit.ts'
import { imageRef } from '../hooks/decision/images.ts'

const picture = (base64: string, width = 800, height = 600) => ({ format: 'png' as const, base64, width, height })

test('the reading is one Score question of five levels, asked in English about the images in the state', () => {
  const { request, part } = complexityRequest([picture('AAAA'), picture('BBBB')])

  expect(Object.keys(request.questions)).toEqual(['complexity.level'])
  const question = request.questions['complexity.level']
  expect(question?.type).toBe('score')
  if (question?.type !== 'score') throw new Error('not a score')
  expect(question.criteria).toHaveLength(5)
  expect(question.criteria).toEqual(COMPLEXITY_LEVELS.map((level) => level.en))
  expect(String(question.instructions)).toContain('reference_images')
  expect(String(question.instructions)).toMatch(/build/i)
  // The images travel by name, and the state points at them where the question says to look.
  expect(request.images?.map((image) => image.name)).toEqual(['reference-1', 'reference-2'])
  expect(request.state).toEqual({ reference_images: [{ image: imageRef('reference-1') }, { image: imageRef('reference-2') }] })
  expect(Object.keys(part.questions)).toEqual(['level'])
})

test('a reading is the level the answer leans to, the expected level rounded, and the number of images it came from', () => {
  const { part } = complexityRequest([picture('AAAA')])
  const answer = (probabilities: Record<string, number>) => ({ 'complexity.level': { type: 'score', score: 0, probabilities, confidence: 0.8 } })

  expect(readComplexity(part, answer({ '0': 0.05, '1': 0.1, '2': 0.1, '3': 0.7, '4': 0.05 }), 2)).toEqual({ level: 3, images: 2 })
  // A spread over the middle is the middle; the expectation, not the single most likely level, is the reading.
  expect(readComplexity(part, answer({ '0': 0.3, '1': 0.1, '2': 0.1, '3': 0.1, '4': 0.4 }), 1)).toEqual({ level: 2, images: 1 })
  expect(readComplexity(part, answer({ '0': 0.9, '1': 0.1, '2': 0, '3': 0, '4': 0 }), 1)).toEqual({ level: 0, images: 1 })
})

test('an answer that is missing, of another kind or without any probability reads as nothing', () => {
  const { part } = complexityRequest([picture('AAAA')])
  expect(readComplexity(part, {}, 1)).toBeNull()
  expect(readComplexity(part, { 'complexity.level': { type: 'noul', noul: 0.5 } }, 1)).toBeNull()
  expect(readComplexity(part, { 'complexity.level': { type: 'score', score: 0, probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0 }, confidence: null } }, 1)).toBeNull()
})

test('the effort request is told the level, its words, the scale and how many images it came from; the question itself is not touched', () => {
  const state = referenceState({ level: 3, images: 2 })
  expect(state).toEqual({
    level: 3,
    scale: '0 (trivial) to 4 (very complex)',
    description: COMPLEXITY_LEVELS[3]?.summary,
    images: 2,
  })
  expect(REFERENCE_FIELD).toBe('reference_complexity')
  expect(String(state.description)).toMatch(/complex/)
})

test('a group of images is recognised by their content, whatever the order, and not by anything else', async () => {
  const a = await referenceKey([{ base64: 'AAAA' }, { base64: 'BBBB' }])
  const b = await referenceKey([{ base64: 'BBBB' }, { base64: 'AAAA' }])
  const other = await referenceKey([{ base64: 'AAAA' }, { base64: 'CCCC' }])
  const one = await referenceKey([{ base64: 'AAAA' }])

  expect(a).toBe(b)
  expect(a).not.toBe(other)
  expect(a).not.toBe(one)
  expect(a).toMatch(/^[0-9a-f]{16}$/)
})

test('a group is at most six images of about a megapixel each, within what the decision model takes', () => {
  expect(MAX_REFERENCE_IMAGES).toBe(6)
  expect(REFERENCE_MAX_PIXELS).toBe(1_000_000)
  expect(complexityLimits('jev')).toEqual({ ...limitsFor('jev'), maxPixels: 1_000_000 })
  expect(complexityLimits('pplx')).toEqual({ ...limitsFor('pplx'), maxPixels: 1_000_000 })
})
