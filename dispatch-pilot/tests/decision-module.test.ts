// The decision request module's own interface: what the Node eval scripts
// import to build exactly the requests the mod sends (seam 2's code side; no
// network here). Pure functions, no `$`.

import { expect, test } from 'claude-code/testing'
import { estimateTokens, turnStartState } from '../hooks/decision/context.ts'
import { EFFORTS, pickEffort, readEffort, turnStartEffortPart } from '../hooks/decision/effort.ts'
import { redactSecrets } from '../hooks/decision/redact.ts'
import { answersFor, mergeParts, QUESTION_ID, type Part } from '../hooks/decision/system-one.ts'

const STATE = { user_message: '把登录模块重构成三层', recent_context: '' }

test('the effort question in each eval variant: English or Chinese, Score or Choice, the same five levels', () => {
  const english = turnStartEffortPart()
  const chinese = turnStartEffortPart({ language: 'zh' })
  const choice = turnStartEffortPart({ primitive: 'choice' })
  const request = mergeParts(STATE, [english])

  // Defaults (spec): English instructions, a five-level Score, id effort.level.
  expect(Object.keys(request.questions)).toEqual(['effort.level'])
  expect(request.state).toEqual(STATE)
  const score = english.questions.level
  expect(score?.type).toBe('score')
  expect(score?.type === 'score' && score.criteria.length).toBe(5)
  expect(JSON.stringify(score?.instructions)).toContain('`user_message`')
  // Chinese: the same shape, written in Chinese.
  const zh = chinese.questions.level
  expect(zh?.type).toBe('score')
  expect(JSON.stringify(zh)).toMatch(/逐步推理/)
  expect(JSON.stringify(zh)).not.toMatch(/step-by-step/)
  // Choice: options named after the levels, lowest first, the same descriptions.
  const named = choice.questions.level
  expect(named?.type === 'choice' && Object.keys(named.criteria)).toEqual([...EFFORTS])
  expect(named?.type === 'choice' && Object.values(named.criteria)).toEqual(score?.type === 'score' ? [...score.criteria] : [])
  // Ids both backends accept (Clef's rule): no colon, at most 100 characters.
  for (const id of Object.keys(mergeParts(STATE, [chinese]).questions)) expect(QUESTION_ID.test(id)).toBe(true)
})

test('an answer reads back the same from a Score and a Choice: normalized, ties up, max only past thetaMax', () => {
  const fromScore = readEffort({ type: 'score', score: 2.1, probabilities: { 0: 0.0, 1: 0.1, 2: 0.4, 3: 0.4, 4: 0.1 }, confidence: 0.5 })
  const fromChoice = readEffort({ type: 'choice', choice: 'high', probabilities: { low: 0, medium: 0.1, high: 0.4, xhigh: 0.4, max: 0.1 }, confidence: 0.5 })
  expect(fromScore?.probabilities).toEqual([0, 0.1, 0.4, 0.4, 0.1])
  expect(fromChoice?.probabilities).toEqual([0, 0.1, 0.4, 0.4, 0.1])
  // A tie goes to the higher level.
  expect(pickEffort(fromScore!, 0.5)).toBe('xhigh')
  // Rounded probabilities are normalized before use.
  const rounded = readEffort({ type: 'score', score: 0, probabilities: { 0: 0.5, 1: 0.5, 2: 0, 3: 0, 4: 0.5 }, confidence: null })
  expect(rounded?.probabilities.map((p) => Number(p.toFixed(3)))).toEqual([0.333, 0.333, 0, 0, 0.333])
  expect(pickEffort(rounded!, 0.3)).toBe('max')
  expect(pickEffort(rounded!, 0.4)).toBe('medium')
  // No usable answer: no reading.
  expect(readEffort(undefined)).toBeNull()
  expect(readEffort({ type: 'score', score: 0, probabilities: {}, confidence: null })).toBeNull()
})

test('several parts share one request; each gets back its own answers under its own ids', () => {
  const skills: Part = {
    part: 'skills',
    questions: {
      which: { type: 'choice', instructions: 'Which skill fits `user_message`?', criteria: { 'cloudflare:wrangler': 'Deploy Workers', none: null } },
      'fit.0': { type: 'noul', instructions: 'Does the first candidate fit?' },
    },
  }
  const effort = turnStartEffortPart()
  const request = mergeParts(STATE, [effort, skills])
  expect(Object.keys(request.questions)).toEqual(['effort.level', 'skills.which', 'skills.fit.0'])

  const answers = {
    'effort.level': { type: 'score', score: 1, probabilities: { 0: 0, 1: 1, 2: 0, 3: 0, 4: 0 }, confidence: 1 },
    'skills.which': { type: 'choice', choice: 'none', probabilities: { 'cloudflare:wrangler': 0.2, none: 0.8 }, confidence: 0.6 },
    // Of the wrong type: left out, as if not answered.
    'skills.fit.0': { type: 'score', score: 0, probabilities: {}, confidence: 0 },
  }
  expect(Object.keys(answersFor(effort, answers))).toEqual(['level'])
  expect(answersFor(skills, answers)).toEqual({
    which: { type: 'choice', choice: 'none', probabilities: { 'cloudflare:wrangler': 0.2, none: 0.8 }, confidence: 0.6 },
  })
})

test('a part may add state fields of its own after the shared ones; a field two parts claim is refused', () => {
  const question = { type: 'noul' as const, instructions: 'Does a platform skill fit `user_message`?' }
  const skills: Part = { part: 'skills', questions: { fit: question }, state: { project_platforms: 'Cloudflare Workers' } }
  const request = mergeParts(STATE, [turnStartEffortPart(), skills])
  // The message stays first, as the question guide asks (Clef's encoder sorts the keys: no order is relied on there).
  expect(Object.keys(request.state)).toEqual(['user_message', 'recent_context', 'project_platforms'])
  expect(request.state.project_platforms).toBe('Cloudflare Workers')

  const clash: Part = { part: 'other', questions: { q: question }, state: { user_message: 'overridden' } }
  expect(() => mergeParts(STATE, [clash])).toThrow(/state field "user_message"/)
})

test('a malformed ballot is refused before anything is sent', () => {
  const question = { type: 'noul' as const, instructions: 'x' }
  expect(() => mergeParts(STATE, [{ part: 'skills.v2', questions: { a: question } }])).toThrow(/part name/)
  expect(() => mergeParts(STATE, [{ part: 'p', questions: { a: question } }, { part: 'p', questions: { b: question } }])).toThrow(/twice/)
  expect(() => mergeParts(STATE, [{ part: 'skills', questions: { 'fit::cloudflare:wrangler': question } }])).toThrow(/question id/)
  expect(() => mergeParts(STATE, [{ part: 'p', questions: {} }])).toThrow(/at least one/)
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`q${i}`, question]))
  expect(() => mergeParts(STATE, [{ part: 'p', questions: many }])).toThrow(/at most 64/)
})

const LIMITS = { messages: 4, tokens: 100 }

test('tokens, not characters: Chinese and English texts of the same token estimate are cut to the same budget', () => {
  const zh = '把登录模块重构成三层并补上测试'.repeat(30) // 450 characters
  const en = 'Refactor the login module into three layers. '.repeat(40) // 1800 characters
  expect(estimateTokens(zh)).toBe(450)
  expect(estimateTokens(en)).toBe(450)

  const stateZh = turnStartState({ prompt: zh, messages: [], limits: LIMITS })
  const stateEn = turnStartState({ prompt: en, messages: [], limits: LIMITS })
  const [fromZh, fromEn] = [stateZh.user_message as string, stateEn.user_message as string]
  for (const cut of [fromZh, fromEn]) expect(estimateTokens(cut)).toBeGreaterThan(80)
  // The budget holds for the whole state as sent: the field names and the JSON around the message take the rest.
  for (const state of [stateZh, stateEn]) expect(estimateTokens(JSON.stringify(state))).toBeLessThanOrEqual(100)
  // The same budget holds about four times as many English characters.
  expect(fromEn.length).toBeGreaterThan(fromZh.length * 3)
  // A message too long keeps its beginning and its end.
  expect(fromZh.startsWith('把登录模块')).toBe(true)
  expect(fromZh.endsWith('补上测试')).toBe(true)
})

test('the message comes first in the budget; older messages are dropped whole, the newest is cut to fit', () => {
  const messages = [
    { role: 'user' as const, text: 'oldest '.repeat(40), toolUses: [] },
    { role: 'assistant' as const, text: 'older '.repeat(40), toolUses: [] },
    { role: 'user' as const, text: 'newest question?', toolUses: [] },
    { role: 'assistant' as const, text: `${'newest answer '.repeat(30)}Shall I start?`, toolUses: [] },
  ]
  const state = turnStartState({ prompt: 'yes', messages, limits: { messages: 4, tokens: 60 } })
  expect(Object.keys(state)).toEqual(['user_message', 'recent_context'])
  expect(state.user_message).toBe('yes')
  const context = state.recent_context as string
  expect(context).not.toContain('oldest')
  expect(context).not.toContain('older')
  expect(context.startsWith('assistant: newest answer')).toBe(true)
  expect(context.endsWith('Shall I start?')).toBe(true)
  expect(estimateTokens(context) + estimateTokens('yes')).toBeLessThanOrEqual(60)
})

test('common secret formats are masked, ordinary text is not', () => {
  const cases: [string, string][] = [
    ['key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx in env', 'key [REDACTED] in env'],
    ['OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx', 'OPENAI_API_KEY=[REDACTED]'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked', 'token [REDACTED] leaked'],
    ['aws AKIAIOSFODNN7EXAMPLE id', 'aws [REDACTED] id'],
    ['slack xoxb-123456789012-abcdefghijkl', 'slack [REDACTED]'],
    ['google AIzaSyA-abcdefghijklmnopqrstuvwxyz12345 key', 'google [REDACTED] key'],
    ['Authorization: Bearer abcdef0123456789abcdef', 'Authorization: Bearer [REDACTED]'],
    ['db postgres://admin:hunter2pass@db.internal:5432/app', 'db postgres://admin:[REDACTED]@db.internal:5432/app'],
    ['password: "correct horse battery"', 'password: "[REDACTED]"'],
    ['client_secret=4f9a8b7c6d5e', 'client_secret=[REDACTED]'],
    ['数据库密码是 Passw0rd!2026，别外传', '数据库密码是 [REDACTED]，别外传'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'jwt [REDACTED]'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY----- done', '[REDACTED PRIVATE KEY] done'],
  ]
  for (const [text, masked] of cases) expect(redactSecrets(text)).toBe(masked)

  const ordinary = 'Set the token budget to 2000 and the password policy doc lives in docs/auth.md; sk-learn is a library.'
  expect(redactSecrets(ordinary)).toBe(ordinary)
})
