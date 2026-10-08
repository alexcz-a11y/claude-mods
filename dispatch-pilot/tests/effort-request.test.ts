// The main agent's effort asked in a decision request of its own (ADR 0005): seam 1
// (engine events in, what reaches the decision backend and the board out). The
// message's other questions (the skills') still go together in one request; the
// two requests go out at once and each fails on its own.

import { expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import { estimateTokens, turnStartState } from '../hooks/decision/context.ts'
import { turnStartEffortPart } from '../hooks/decision/effort.ts'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import { mergeParts } from '../hooks/decision/system-one.ts'
import { withUnresolved } from '../hooks/decision/unresolved.ts'
import { jev, rates, world, type Reply, type Sent, type SkillsWorld } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }
/** The switch is off until the person turns it on (#48): these tests are about what the request is with it on. */
const UNRESOLVED_ON = { unresolved: true }

const SKILLS: SkillsWorld = {
  commands: [
    { name: 'tdd', description: 'Test-driven development. Use when the user wants to build features or fix bugs test-first.', source: 'user' },
    { name: 'code-review', description: 'Review the changes since a fixed point along two axes: Standards and Spec.', source: 'user' },
  ],
  listed: [
    { name: 'tdd', source: 'userSettings', tokens: 52 },
    { name: 'code-review', source: 'userSettings', tokens: 144 },
  ],
}

const ids = (request: Sent) => Object.keys(request.body.questions)
const isEffort = (request: Sent) => ids(request).some((id) => id.startsWith('effort.'))
const isSkills = (request: Sent) => ids(request).some((id) => id.startsWith('skills.'))

/** About `tokens` estimated tokens of Chinese text (one token a character). */
const wordy = (tokens: number, said: string) => `${said}：${'这一段是为了把对话撑长而写的。'.repeat(Math.ceil(tokens / 15))}`.slice(0, tokens)

test("with skills on, the effort question goes alone in its request and the skills' questions keep theirs", { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: rates({ tdd: 0.7, '(none)': 0.3 }, { tdd: 0.9 }, [0.05, 0.1, 0.7, 0.1, 0.05]), skills: SKILLS })
  await w.submit('先写一个失败的测试，再实现登录限流')
  await w.step({ index: 0 })

  const [effort, skills] = w.requests
  expect(ids(effort as Sent)).toEqual(['effort.level', 'effort.unresolved'])
  expect(ids(skills as Sent)).toEqual(['skills.which'])
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  // The skills' second stage follows its own request.
  expect(w.requests.map(ids)).toEqual([['effort.level', 'effort.unresolved'], ['skills.which'], ['skills.fits.0']])
})

test('the effort request is exactly the decision module effort question over the state of a plain message; the skills request carries no effort question', { options: KEY }, async ($, on) => {
  const messages: SessionMessage[] = [
    { role: 'user', text: '登录接口加个限流', toolUses: [] },
    { role: 'assistant', text: '好的，要先写测试吗？', toolUses: [] },
  ]
  const w = world($, on, { switches: UNRESOLVED_ON, backend: rates({ '(none)': 1 }), skills: SKILLS, messages })
  await w.submit('要，先写失败的测试')

  const built = mergeParts(turnStartState({ prompt: '要，先写失败的测试', messages, limits: { messages: 32, tokens: 24000 } }), [withUnresolved(turnStartEffortPart({ language: 'zh' }), 'zh')])
  expect(w.requests.find(isEffort)?.body).toEqual({ model: JEV_MODEL, ...built })
  expect(w.requests.filter(isSkills).some(isEffort)).toBe(false)
})

test('the effort question reads the 24000-token budget of a plain message while the skills request keeps its 6000', { options: KEY }, async ($, on) => {
  // Twelve messages of about a thousand tokens each: 12k tokens of conversation before the message.
  const messages: SessionMessage[] = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? ('user' as const) : ('assistant' as const), text: wordy(1000, `第 ${i} 条`), toolUses: [] }))
  const w = world($, on, { backend: rates({ '(none)': 1 }), skills: SKILLS, messages })
  await w.submit('继续')

  const effort = w.requests.find(isEffort) as Sent
  const skills = w.requests.find(isSkills) as Sent
  const lines = (request: Sent) => String(request.body.state.recent_context).split('\n').filter((line) => line !== '')
  // The whole conversation reaches the effort question; the skills' state stops at 6000 tokens, whole messages only.
  expect(lines(effort)).toHaveLength(12)
  expect(estimateTokens(JSON.stringify(effort.body.state))).toBeLessThanOrEqual(24000)
  expect(lines(skills).length).toBeLessThanOrEqual(5)
  expect(estimateTokens(JSON.stringify(skills.body.state))).toBeLessThanOrEqual(6000)
})

test('the two requests are on their way before either has answered', { options: KEY }, async ($, on) => {
  const answer = rates({ '(none)': 1 })
  const w = world($, on, { switches: UNRESOLVED_ON, backend: (request) => ({ after: 400, reply: answer(request) }), skills: SKILLS })

  const submitting = w.submit('先写一个失败的测试')
  await w.clock.settle()
  expect(w.requests.map(ids)).toEqual([['effort.level', 'effort.unresolved'], ['skills.which']])
  await w.clock.advance(400)
  await submitting
  // Answered in parallel: the message waited for the slower of them, not for both.
  expect(w.clock.now()).toBe(400)
})

test("the skills request failing leaves the effort decision as it is; the skills are not suggested, the effort is routed", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: (request) => (isSkills(request) ? { status: 500, body: 'boom' } : jev([0.05, 0.1, 0.7, 0.1, 0.05])(request)), skills: SKILLS })
  await w.submit('先写一个失败的测试')
  await w.step({ index: 0 })

  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  expect((await w.board()).main).toMatchObject({ effort: 'high', routed: true })
  expect(w.prompts[0]?.context).toBeUndefined()
})

test('the effort request failing leaves the skills suggestion as it is; the turn keeps the engine effort, the board says why', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const answer = rates({ tdd: 0.7, '(none)': 0.3 }, { tdd: 0.9 })
  const w = world($, on, { backend: (request) => (isEffort(request) ? { status: 503, body: 'overloaded' } : answer(request)), skills: SKILLS })
  await w.submit('先写一个失败的测试')
  await w.step({ index: 0, effort: 'medium' })

  expect(w.steps.map((s) => s.effort)).toEqual(['medium'])
  expect((await w.board()).main).toMatchObject({ effort: 'medium', routed: false, failure: { backend: 'jev', kind: 'busy' } })
  expect(w.prompts[0]?.context?.[0]).toContain('- tdd (relevance 0.90)')
})

test('one request timing out does not hold back the other: the prompt goes in at timeoutMs with the answer that came', { options: { ...KEY, timeoutMs: 800 } }, async ($, on) => {
  const answer = rates({ tdd: 0.7, '(none)': 0.3 }, { tdd: 0.9 }, [0.05, 0.1, 0.7, 0.1, 0.05])
  // The skills request answers after a minute of (mock) time; the effort request at once.
  const w = world($, on, { backend: (request) => (isSkills(request) ? { after: 60_000, reply: answer(request) } : answer(request)), skills: SKILLS })

  const submitting = w.submit('先写一个失败的测试')
  await w.clock.settle()
  await w.clock.advance(800)
  await submitting
  await w.step({ index: 0, effort: 'xhigh' })

  expect(w.prompts).toHaveLength(1)
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  expect((await w.board()).main).toMatchObject({ effort: 'high', routed: true })
  expect((await w.board()).notes).toMatchObject([{ feature: 'skills', kind: 'skipped', why: 'unanswered' }])
})

test('each request is logged on its own line in the debug log', { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: rates({ '(none)': 1 }), skills: SKILLS })
  await w.submit('先写一个失败的测试')

  const lines = w.logs.map((entry) => entry.text).filter((text) => text.startsWith('request '))
  expect(lines).toEqual([
    'request [effort.level, effort.unresolved] to jev: answered in 0 ms by jev-1.13.0 (300 input tokens)',
    'request [skills.which] to jev: answered in 0 ms by jev-1.13.0 (300 input tokens)',
  ])
})

test('with only the effort question (skills off) one request goes out, none for the skills', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]), skills: SKILLS, store: { switches: { skills: false } }, session: true })
  await w.start()
  await w.submit('先写一个失败的测试')

  expect(w.requests.map(ids)).toEqual([['effort.level']])
})

test('with only the skills question (main-effort off) one request goes out, none for the effort', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ '(none)': 1 }), skills: SKILLS, store: { switches: { 'main-effort': false } }, session: true })
  await w.start()
  await w.submit('先写一个失败的测试')

  expect(w.requests.map(ids)).toEqual([['skills.which']])
})

