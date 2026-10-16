// The strong hint (#41): seam 2, the pure functions the mod and the eval share. How the effort request of a message
// carries the unresolved count and, once the count reaches the threshold, one more sentence in the effort question
// (ADR 0005: a hint written as a situation, never a level, never a rule). No network, no `$`.

import { expect, test } from 'claude-code/testing'
import { EFFORT_PART, EFFORTS } from '../hooks/decision/effort.ts'
import { midturnEffortPart, midturnState } from '../hooks/decision/midturn.ts'
import { dispatchState } from '../hooks/decision/dispatched-agent.ts'
import { renderSummary, type Summary } from '../hooks/decision/summary.ts'
import { mergeParts } from '../hooks/decision/system-one.ts'
import { messageRequest, turnStartPart } from '../hooks/decision/turn-start.ts'
import { COUNT_FIELD, givesHint, HINTED, usesHinted } from '../hooks/decision/unresolved.ts'

const SUMMARY: Summary = { problem: '登录接口返回 502', tried: [{ text: '把超时调到 30 秒', unresolved: true }], status: '等待新的日志' }
const MESSAGES = [
  { role: 'user' as const, text: '登录接口返回 502' },
  { role: 'assistant' as const, text: '我把超时调到了 30 秒' },
]
const LIMITS = { messages: 32, tokens: 24000 }

/** The instructions of the effort question as the request carries them. */
const effortWords = (part: ReturnType<typeof turnStartPart>) => JSON.stringify(part.questions.level?.instructions)

/** Every word of the part's questions: what the decision model reads of them. */
const allWords = (part: ReturnType<typeof turnStartPart>) => JSON.stringify(part.questions)

test('the hint is given when the count reaches the threshold; below it, or with the threshold at 0, never', () => {
  expect(givesHint(3, 3)).toBe(true)
  expect(givesHint(7, 3)).toBe(true)
  expect(givesHint(2, 3)).toBe(false)
  expect(givesHint(0, 3)).toBe(false)
  // 0 means none, whatever the count.
  expect(givesHint(5, 0)).toBe(false)
  expect(givesHint(0, 0)).toBe(false)
})

/** The key of the instruction on what to rate, in the language asked: the one the hint extends. */
const RATE = { en: 'rate', zh: '评什么' } as const
/** The key the hint adds, in the language asked. */
const HINT_KEY = { en: 'unsolved', zh: '未解决' } as const
/** The top level's description as the dataset's criteria word it, in the language asked: the situation the hint names in its words. */
const TOP_PHRASE = { en: 'a failure that resisted earlier attempts', zh: '之前多次尝试都没解决的故障' } as const

const instructionsOf = (question: { instructions?: unknown } | undefined): Record<string, string> => (question?.instructions ?? {}) as Record<string, string>

test('the effort part carries the count as a state field; the hint is a second effort question beside the plain one, only when the count reaches the threshold', () => {
  for (const language of ['en', 'zh'] as const) {
    const plain = turnStartPart({ ask: { language }, unresolved: true })
    const below = turnStartPart({ ask: { language }, unresolved: true, count: 2, maxAfter: 3 })
    const hinted = turnStartPart({ ask: { language }, unresolved: true, count: 3, maxAfter: 3 })
    // Still the one part: the effort part in the effort request.
    expect(hinted.part).toBe(EFFORT_PART)
    // The count is in the state from the first unresolved message on; none before.
    expect(plain.state?.[COUNT_FIELD]).toBeUndefined()
    expect(below.state?.[COUNT_FIELD]).toBe(2)
    expect(hinted.state?.[COUNT_FIELD]).toBe(3)
    // Below the threshold the questions are as without a count: no second effort question.
    expect(below.questions).toEqual(plain.questions)
    expect(HINTED in plain.questions).toBe(false)
    // At it the questions are the same ones and one more: the hinted copy of the effort question, after them.
    expect(Object.keys(hinted.questions)).toEqual([...Object.keys(plain.questions), HINTED])
    // effort.level is exactly what it is without the hint (byte for byte): a message that turns out solved or
    // about something else is decided as if the hint had not been given. The hint is nowhere in it.
    expect(JSON.stringify(hinted.questions.level)).toBe(JSON.stringify(plain.questions.level))
    expect(effortWords(hinted)).not.toContain(COUNT_FIELD)
    expect(Object.keys(instructionsOf(hinted.questions.level))).not.toContain(HINT_KEY[language])
    // The hinted copy has the hint as one more instruction, and carries the count's field name.
    const own = Object.keys(instructionsOf(hinted.questions[HINTED]))
    expect(own).toEqual([...Object.keys(instructionsOf(plain.questions.level)), HINT_KEY[language]])
    expect(JSON.stringify(hinted.questions[HINTED]?.instructions)).toContain(COUNT_FIELD)
    // It is a copy of the effort question in everything else: the same type and the same descriptions of the levels.
    expect(hinted.questions[HINTED]?.type).toBe(plain.questions.level?.type)
    expect(JSON.stringify((hinted.questions[HINTED] as { criteria?: unknown }).criteria)).toBe(JSON.stringify((plain.questions.level as { criteria?: unknown }).criteria))
    // The three-way question is not hinted: only the effort copy is.
    expect(hinted.questions.unresolved).toEqual(plain.questions.unresolved)
  }
})

test('without the three-way question in the part there is no second answer to choose by, so the hint goes into effort.level itself', () => {
  for (const language of ['en', 'zh'] as const) {
    const plain = turnStartPart({ ask: { language } })
    const hinted = turnStartPart({ ask: { language }, count: 3, maxAfter: 3 })
    expect(Object.keys(hinted.questions)).toEqual(Object.keys(plain.questions))
    expect(HINTED in hinted.questions).toBe(false)
    expect(Object.keys(instructionsOf(hinted.questions.level))).toEqual([...Object.keys(instructionsOf(plain.questions.level)), HINT_KEY[language]])
    expect(instructionsOf(hinted.questions.level)[RATE[language]]?.startsWith(instructionsOf(plain.questions.level)[RATE[language]] ?? '\u0000')).toBe(true)
    // The same text as the hinted copy would carry beside the three-way question.
    const beside = turnStartPart({ ask: { language }, unresolved: true, count: 3, maxAfter: 3 })
    expect(JSON.stringify(hinted.questions.level)).toBe(JSON.stringify(beside.questions[HINTED]))
  }
})

test('the hinted answer is used when this message added one to the count (still unresolved) and not otherwise', () => {
  expect(usesHinted('add')).toBe(true)
  // Resolved or another problem clears the count; an unsure answer leaves it: none of these is the hint's situation.
  expect(usesHinted('reset')).toBe(false)
  expect(usesHinted('keep')).toBe(false)
  expect(usesHinted(null)).toBe(false)
})

test('the hint and the count field never name a level or give a number: it says what kind of work this is, the decision model decides the level', () => {
  for (const language of ['en', 'zh'] as const) {
    const plain = turnStartPart({ ask: { language }, unresolved: true })
    const hinted = turnStartPart({ ask: { language }, unresolved: true, count: 4, maxAfter: 3 })
    const was = instructionsOf(plain.questions.level)
    const now = instructionsOf(hinted.questions[HINTED])
    // What the hinted copy says beyond the plain question: the new instruction, and the sentence added to the one on what to rate.
    const added = Object.entries(now).filter(([key]) => !(key in was))
    expect(added).toHaveLength(1)
    const rate = now[RATE[language]] ?? ''
    expect(rate.startsWith(was[RATE[language]] ?? '\u0000')).toBe(true)
    const extension = rate.slice((was[RATE[language]] ?? '').length)
    expect(extension.trim().length).toBeGreaterThan(0)
    // Every other instruction is as it was.
    for (const [key, text] of Object.entries(was)) if (key !== RATE[language]) expect(now[key]).toBe(text)
    const text = JSON.stringify([added, extension])
    for (const level of EFFORTS) expect(text.toLowerCase()).not.toContain(level)
    expect(text).not.toMatch(/\d/)
    expect(text).not.toMatch(/level|档/i)
    // The situation the effort question's last description names, in the language asked, in that description's own words.
    expect(text).toMatch(language === 'zh' ? /没解决/ : /not solved|unsolved/i)
    expect(JSON.stringify(added)).toContain(TOP_PHRASE[language])
    expect(JSON.stringify(plain.questions.level)).toContain(TOP_PHRASE[language])
    expect(language === 'zh' ? /[一-鿿]/.test(text) : !/[一-鿿]/.test(text)).toBe(true)
  }
})

test('the count and the summary travel in the state the mod builds, within the budget; the effort rules are untouched by them', () => {
  const part = turnStartPart({ ask: { language: 'zh' }, unresolved: true, summary: SUMMARY, count: 3, maxAfter: 3 })
  const request = messageRequest({ prompt: '还是不行', messages: MESSAGES, limits: LIMITS, parts: [part] })
  expect(request.state.user_message).toBe('还是不行')
  expect(request.state[COUNT_FIELD]).toBe(3)
  expect(request.state.problem_summary).toBe(renderSummary(SUMMARY, 'zh'))
  // The count adds no question but the hinted copy of the effort question: effort.level and effort.unresolved as before, and effort.level_unsolved.
  expect(Object.keys(request.questions)).toEqual(['effort.level', 'effort.unresolved', `effort.${HINTED}`])
  const bare = messageRequest({ prompt: '还是不行', messages: MESSAGES, limits: LIMITS, parts: [turnStartPart({ ask: { language: 'zh' }, unresolved: true, summary: SUMMARY, count: 2, maxAfter: 3 })] })
  expect(Object.keys(bare.questions)).toEqual(['effort.level', 'effort.unresolved'])
})

test('a request merged with the part has the hint only in effort.level_unsolved\'s instructions; effort.level is the request it was', () => {
  const hinted = mergeParts({ user_message: 'm', recent_context: 'c' }, [turnStartPart({ ask: { language: 'en' }, unresolved: true, count: 3, maxAfter: 3 })])
  const plain = mergeParts({ user_message: 'm', recent_context: 'c' }, [turnStartPart({ ask: { language: 'en' }, unresolved: true })])
  expect(hinted.questions['effort.unresolved']).toEqual(plain.questions['effort.unresolved'])
  expect(JSON.stringify(hinted.questions['effort.level'])).toEqual(JSON.stringify(plain.questions['effort.level']))
  expect(JSON.stringify(hinted.questions['effort.level_unsolved'])).not.toEqual(JSON.stringify(plain.questions['effort.level']))
  expect(Object.keys(instructionsOf(hinted.questions['effort.level_unsolved']))).toContain('unsolved')
  expect(plain.questions['effort.level_unsolved']).toBeUndefined()
  expect(JSON.stringify(plain)).not.toContain(COUNT_FIELD)
  // The words allWords reads back from a part are the same ones.
  expect(allWords(turnStartPart({ unresolved: true, count: 3, maxAfter: 3 }))).toContain(COUNT_FIELD)
})

const STEP = { assistant_text: '先看一眼日志', tools: [{ name: 'Read', result: '成功：app.log' }] }
const MID = {
  message: '还是不行',
  step: 3,
  current_effort: 'high' as const,
  counts: { judgments: 1, changes: 0, failures: 0, hook_blocks: 0 },
  recent_steps: [STEP],
}

test('a mid-turn request carries the summary and the count, and the hint when the count reaches the threshold; without them it is the request it was', () => {
  const bare = midturnState(MID, { steps: 6, tokens: 24000 })
  expect(Object.keys(bare)).toEqual(['user_message', 'step', 'current_effort', 'counts', 'recent_steps'])

  const state = midturnState({ ...MID, problem_summary: renderSummary(SUMMARY, 'zh'), unresolved_count: 3 }, { steps: 6, tokens: 24000 })
  expect(state.problem_summary).toBe(renderSummary(SUMMARY, 'zh'))
  expect(state[COUNT_FIELD]).toBe(3)

  for (const language of ['en', 'zh'] as const) {
    const plain = midturnEffortPart({ language })
    const hinted = midturnEffortPart({ language }, { hint: true })
    expect(Object.keys(hinted.questions)).toEqual(Object.keys(plain.questions))
    expect(Object.keys(hinted.questions.level?.instructions ?? {}).length).toBe(Object.keys(plain.questions.level?.instructions ?? {}).length + 1)
    const text = JSON.stringify(hinted.questions.level?.instructions)
    expect(text).toContain(COUNT_FIELD)
    for (const level of EFFORTS) expect(JSON.stringify(Object.values(hinted.questions.level?.instructions ?? {}).slice(-1)).toLowerCase()).not.toContain(level)
    // A mid-turn re-decision has no three-way answer beside it (it is asked once the message was judged): the hint is in midturn.level itself, no second question.
    expect(HINTED in hinted.questions).toBe(false)
    // The instruction on what to rate is extended there too, as in the hinted copy at a message.
    const was = instructionsOf(plain.questions.level)
    const now = instructionsOf(hinted.questions.level)
    const rated = Object.keys(was).filter((key) => now[key] !== was[key])
    expect(rated).toEqual([RATE[language]])
    expect(now[RATE[language]]?.startsWith(was[RATE[language]] ?? '\u0000')).toBe(true)
  }
})

test('a dispatched agent\'s request carries the summary and the count, and no hint', () => {
  const dispatch = { user_message: '还是不行', agent_type: 'Explore', description: '看日志', prompt: '读 app.log', requested_model: null }
  const bare = dispatchState(dispatch, 8000)
  expect(Object.keys(bare)).toEqual(['brief', 'user_message'])
  const state = dispatchState({ ...dispatch, problem_summary: renderSummary(SUMMARY, 'zh'), unresolved_count: 4 }, 8000)
  expect(state.problem_summary).toBe(renderSummary(SUMMARY, 'zh'))
  expect(state[COUNT_FIELD]).toBe(4)
  expect(JSON.stringify(state)).not.toMatch(/强提示|hint/i)
})
