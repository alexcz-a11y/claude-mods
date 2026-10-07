// The unresolved-count question and how its answer is read (#39): seam 2, the
// pure functions the mod and the eval share. No network, no `$`.

import { expect, test } from 'claude-code/testing'
import { EFFORT_PART, turnStartEffortPart } from '../hooks/decision/effort.ts'
import { answersFor, mergeParts, QUESTION_ID } from '../hooks/decision/system-one.ts'
import { UNRESOLVED, UNRESOLVED_OPTIONS, judgeUnresolved, readUnresolved, withUnresolved } from '../hooks/decision/unresolved.ts'

const STATE = { user_message: '还是不行，同样的报错', recent_context: '用户：登录接口 502\n助手：已修复' }

/** A Choice answer over the three options, in their order. */
const choice = (still: number, resolved: number, other: number, confidence: number | null = 0.5) => ({
  type: 'choice' as const,
  choice: 'still_unresolved',
  probabilities: { still_unresolved: still, resolved, new_or_unrelated: other },
  confidence,
})

test('the effort part with the unresolved question: one more Choice in the same part, three options in a fixed order, in both languages', () => {
  const plain = turnStartEffortPart({ language: 'zh' })
  for (const language of ['en', 'zh'] as const) {
    const part = withUnresolved(turnStartEffortPart({ language }), language)
    // The same part (so it travels in the effort request): effort.level and effort.unresolved.
    expect(part.part).toBe(EFFORT_PART)
    expect(Object.keys(part.questions)).toEqual(['level', UNRESOLVED])
    const question = part.questions[UNRESOLVED]
    expect(question?.type).toBe('choice')
    expect(question?.type === 'choice' && Object.keys(question.criteria)).toEqual([...UNRESOLVED_OPTIONS])
    // A situation each, none of them null: the option names say little on their own.
    expect(question?.type === 'choice' && Object.values(question.criteria).every((text) => typeof text === 'string' && text.length > 20)).toBe(true)
    // It reads the shared state by name, and a level's name or number is nowhere in it.
    expect(JSON.stringify(question)).toContain('`user_message`')
    expect(JSON.stringify(question)).toContain('`recent_context`')
    for (const id of Object.keys(mergeParts(STATE, [part]).questions)) expect(QUESTION_ID.test(id)).toBe(true)
  }
  // Written in the language asked: Chinese has no English sentence in its instructions, English no Chinese.
  const zh = withUnresolved(plain, 'zh').questions[UNRESOLVED]
  const en = withUnresolved(turnStartEffortPart(), 'en').questions[UNRESOLVED]
  expect(JSON.stringify(zh?.instructions)).toMatch(/[一-鿿]/)
  expect(JSON.stringify(en?.instructions)).not.toMatch(/[一-鿿]/)
  // The effort question itself is untouched.
  expect(withUnresolved(plain, 'zh').questions.level).toEqual(plain.questions.level)
})

test('an answer to the question reads back as three probabilities, normalized; a missing, malformed or other-typed answer reads as nothing', () => {
  const part = withUnresolved(turnStartEffortPart(), 'en')
  const request = mergeParts(STATE, [part])
  const answers = answersFor(part, { 'effort.unresolved': choice(0.6, 0.1, 0.1) })
  expect(Object.keys(request.questions)).toContain('effort.unresolved')
  const read = readUnresolved(answers[UNRESOLVED])
  expect(read?.confidence).toBe(0.5)
  expect(UNRESOLVED_OPTIONS.map((option) => Number((read?.probabilities[option] ?? 0).toFixed(6)))).toEqual([0.75, 0.125, 0.125])
  expect(readUnresolved(undefined)).toBeNull()
  expect(readUnresolved({ type: 'noul', noul: 0.9 })).toBeNull()
  expect(readUnresolved(choice(0, 0, 0))).toBeNull()
  // An answer with options that are not these reads as nothing, not as a guess.
  expect(readUnresolved({ type: 'choice', choice: 'low', probabilities: { low: 1, max: 0 }, confidence: 1 })).toBeNull()
})

test('two thresholds: still unresolved adds at the lower one, resolved or a new problem resets at the higher one, anything short of both keeps the count', () => {
  const read = (still: number, resolved: number, other: number) => readUnresolved(choice(still, resolved, other)) as NonNullable<ReturnType<typeof readUnresolved>>
  const thresholds = { add: 0.5, reset: 0.7 }
  expect(judgeUnresolved(read(0.5, 0.2, 0.3), thresholds)).toMatchObject({ change: 'add', top: 'still_unresolved' })
  expect(judgeUnresolved(read(0.49, 0.01, 0.5), thresholds)).toMatchObject({ change: 'keep' })
  // The higher bar for clearing: 0.6 of "resolved" is the most probable and still no reset.
  expect(judgeUnresolved(read(0.1, 0.6, 0.3), thresholds)).toMatchObject({ change: 'keep', top: 'resolved' })
  expect(judgeUnresolved(read(0.1, 0.7, 0.2), thresholds)).toMatchObject({ change: 'reset', top: 'resolved' })
  expect(judgeUnresolved(read(0.05, 0.1, 0.85), thresholds)).toMatchObject({ change: 'reset', top: 'new_or_unrelated' })
  // A split between "resolved" and "new" does not add up to a reset: each is held to the bar on its own.
  expect(judgeUnresolved(read(0.2, 0.4, 0.4), thresholds)).toMatchObject({ change: 'keep' })
})

test('the provisional thresholds the mod uses: adding takes less certainty than clearing, and the two can never both be met', () => {
  const reading = readUnresolved(choice(0.5, 0.25, 0.25)) as NonNullable<ReturnType<typeof readUnresolved>>
  const judged = judgeUnresolved(reading)
  expect(judged.thresholds.add).toBeLessThan(judged.thresholds.reset)
  // One answer sums to 1: both bars cannot be reached, so the order they are checked in never decides.
  expect(judged.thresholds.add + judged.thresholds.reset).toBeGreaterThan(1)
  expect(judged).toMatchObject({ change: 'add' })
})
