// What the person's message asks of the work beyond the work (ADR 0016): `confirm` (they only go on with what was offered)
// keeps at least the effort of their previous turn, `escalate` (they ask for more thought or a stronger model) goes to xhigh
// at least; neither moves the unresolved count, and `solved` names going ahead as no solution. Both read at the decision
// model's bars (TypeSafe's for Jev, Liquid's for d1-ultra). Pure modules first, then seam 1 (engine events in; requests and
// the effort each step goes out at, out).

import { expect, test } from 'claude-code/testing'
import { askQuestions, CONFIRM, ESCALATE } from '../hooks/decision/asks.ts'
import type { EffortReading } from '../hooks/decision/effort.ts'
import { LIQUID_GUIDE, TYPESAFE_GUIDE } from '../hooks/decision/guides.ts'
import { decideMessage, type MessageSignals } from '../hooks/decision/message-effort.ts'
import { turnStartPart } from '../hooks/decision/turn-start.ts'
import { judgeUnresolved, unresolvedQuestions } from '../hooks/decision/unresolved.ts'
import { jev, KEY, type Sent, world } from './support/world.ts'

const read = (probabilities: number[], confidence: number | null = 0.9): EffortReading => ({ probabilities, confidence })
const LOW = read([1, 0, 0, 0, 0])
const QUIET: MessageSignals = { ultrathink: false, stakes: { undo: 0, live: 0, access: 0 }, causeUnknown: 0, stillFailing: 0, confirm: 0, escalate: 0, lastTurn: null, count: 0, maxAfter: 3, lock: null }
const stepOf = (signals: Partial<MessageSignals>, rule: string, guide = TYPESAFE_GUIDE) => decideMessage(LOW, { ...QUIET, ...signals }, guide).steps.find((step) => step.rule === rule)

test('the two questions are asked of the person\'s own message only, each one judgment with true and false as situations', () => {
  const own = turnStartPart()
  expect(Object.keys(own.questions).slice(-2)).toEqual([CONFIRM, ESCALATE])
  expect(Object.keys(turnStartPart({ kind: 'report' }).questions)).not.toContain(CONFIRM)
  for (const language of ['en', 'zh'] as const) {
    for (const question of Object.values(askQuestions(language))) {
      expect(question.type).toBe('noul')
      expect(question.type === 'noul' && typeof question.criteria?.true === 'string' && typeof question.criteria?.false === 'string').toBe(true)
    }
  }
  expect(JSON.stringify(askQuestions('en').confirm)).toContain('选 2')
  expect(JSON.stringify(askQuestions('en').escalate)).toContain('stronger model')
})

test('confirm yes keeps at least the effort of the previous turn; in the band, no, or with no previous turn, nothing', () => {
  expect(decideMessage(LOW, { ...QUIET, confirm: 0.9, lastTurn: { effort: 'xhigh', stuck: false } }).effort).toBe('xhigh')
  expect(stepOf({ confirm: 0.9, lastTurn: { effort: 'xhigh', stuck: false } }, 'confirm')).toMatchObject({ applied: true, floor: 'xhigh', lastEffort: 'xhigh', verdict: 'yes', yes: 0.7, inclusive: true })
  expect(decideMessage(LOW, { ...QUIET, confirm: 0.5, lastTurn: { effort: 'xhigh', stuck: false } }).effort).toBe('low')
  expect(decideMessage(LOW, { ...QUIET, confirm: 0.9, lastTurn: null }).effort).toBe('low')
  // A floor only lifts: a previous turn below the base leaves the base.
  expect(decideMessage(read([0, 0, 1, 0, 0]), { ...QUIET, confirm: 0.9, lastTurn: { effort: 'low', stuck: false } }).effort).toBe('high')
})

test('escalate yes goes to xhigh at least, as ultrathink does; in the band or no, nothing', () => {
  expect(decideMessage(LOW, { ...QUIET, escalate: 0.95 })).toMatchObject({ effort: 'xhigh', lifted: 'escalate' })
  expect(decideMessage(LOW, { ...QUIET, escalate: 0.6 }).effort).toBe('low')
  expect(decideMessage(read([0, 0, 0, 0, 1]), { ...QUIET, escalate: 0.95 }).effort).toBe('max')
})

test("Liquid's bars for the two: yes only above 0.8, so 0.8 itself and 0.75 are the band and lift nothing", () => {
  expect(decideMessage(LOW, { ...QUIET, escalate: 0.75 }, LIQUID_GUIDE).effort).toBe('low')
  expect(decideMessage(LOW, { ...QUIET, escalate: 0.8 }, LIQUID_GUIDE).effort).toBe('low')
  expect(decideMessage(LOW, { ...QUIET, escalate: 0.81 }, LIQUID_GUIDE).effort).toBe('xhigh')
  expect(stepOf({ confirm: 0.85, lastTurn: { effort: 'high', stuck: false } }, 'confirm', LIQUID_GUIDE)).toMatchObject({ applied: true, level: 'high', yes: 0.8, no: 0.2, inclusive: false })
  // The same 0.75 is a yes on TypeSafe's bars.
  expect(decideMessage(LOW, { ...QUIET, escalate: 0.75 }).effort).toBe('xhigh')
})

test('solved names going ahead as no solution, in both languages; the count reads only its three questions', () => {
  const solved = (language: 'en' | 'zh') => JSON.stringify(unresolvedQuestions(language).solved)
  expect(solved('en')).toContain('go ahead')
  expect(solved('zh')).toContain('不算问题已经解决')
  expect(judgeUnresolved({ probabilities: { still_failing: 0.05, solved: 0.1, new_task: 0.1 } }).change).toBe('keep')
  expect(judgeUnresolved({ probabilities: { still_failing: 0.05, solved: 0.9, new_task: 0.1 } }).change).toBe('reset')
})

// ---- seam 1 --------------------------------------------------------------------------------------

const XHIGH = [0, 0, 0, 1, 0]
const LOW_LEVELS = [1, 0, 0, 0, 0]

test('a message that only approves goes out at least at the previous turn\'s effort, and the unresolved count stays where it was', { options: KEY }, async ($, on) => {
  const now: { levels: number[]; nouls: Record<string, number> } = { levels: XHIGH, nouls: { 'effort.still_failing': 0.9 } }
  const w = world($, on, { backend: (request: Sent) => jev(now.levels, { nouls: now.nouls })(request) })
  await w.submit('还是不行，同样的报错')
  await w.step({ index: 0 })
  await w.complete()
  expect(w.unresolved()).toBe(1)

  // "ok, do it": the effort question rates the reply itself low; confirm keeps the turn's xhigh. The count is not cleared.
  now.levels = LOW_LEVELS
  now.nouls = { 'effort.confirm': 0.9, 'effort.solved': 0.1 }
  await w.submit('好，就按这个来')
  await w.step({ index: 0 })
  expect(w.steps.map((s) => s.effort)).toEqual(['xhigh', 'xhigh'])
  expect(w.unresolved()).toBe(1)
  const entry = (await w.board()).log.filter((one) => one.feature === 'main-effort').at(-1)
  expect(entry?.trace?.find((step) => step.rule === 'confirm')).toMatchObject({ applied: true, level: 'xhigh', lastEffort: 'xhigh' })
})

test('a message that asks for more thought goes out at xhigh at least', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev(LOW_LEVELS, { nouls: { 'effort.escalate': 0.95 } }) })
  await w.submit('这次仔细一点，认真想想再改')
  await w.step({ index: 0 })
  expect(w.steps.map((s) => s.effort)).toEqual(['xhigh'])
  expect(w.requests[0]?.body.questions['effort.escalate']?.type).toBe('noul')
})
