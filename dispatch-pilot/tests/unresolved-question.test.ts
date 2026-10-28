// The message's effort part (ADR 0014): its questions by turn kind, the state fields it adds (only when they have something
// in them), the Nouls about the problem and how they move the count, the lasting rules kept. Seam 2, the pure functions the
// mod and the eval share. No network, no `$`.

import { expect, test } from 'claude-code/testing'
import { constraintOf, CONSTRAINTS_FIELD, lastParagraph, MOST_CONSTRAINTS, withConstraint } from '../hooks/decision/constraints.ts'
import { EFFORT_PART } from '../hooks/decision/effort.ts'
import type { TurnFacts } from '../hooks/decision/escalation.ts'
import { summaryState, type Summary } from '../hooks/decision/summary.ts'
import { answersFor, mergeParts, QUESTION_ID } from '../hooks/decision/system-one.ts'
import { LAST_TURN_FIELD, lastTurnState, turnStartPart } from '../hooks/decision/turn-start.ts'
import { countAfter, judgeUnresolved, readUnresolved, UNRESOLVED_OPTIONS } from '../hooks/decision/unresolved.ts'

const STATE = { user_message: '还是不行，同样的报错', recent_context: '用户：登录接口 502\n助手：已修复' }
const noul = (p: number) => ({ type: 'noul' as const, noul: p })
const SUMMARY: Summary = { problem: 'Login returns 502', tried: [{ text: 'raised the timeout', unresolved: true }, { text: 'switched to fake timers' }], status: 'waiting for the log' }
const FACTS: TurnFacts = { effort: 'high', calls: 9, failed: 3, blocked: 1, stuck: true, errors: ['Bash: npm ERR! missing script: test'] }

test("the person's own message asks eleven questions in one part; a report's turn only the effort question, the stakes and the unknown cause", () => {
  const own = turnStartPart()
  expect(own.part).toBe(EFFORT_PART)
  expect(Object.keys(own.questions)).toEqual(['level', 'stakes.undo', 'stakes.live', 'stakes.access', 'cause_unknown', 'still_failing', 'solved', 'new_task', 'constraint', 'confirm', 'escalate'])
  expect(Object.keys(turnStartPart({ kind: 'report' }).questions)).toEqual(['level', 'stakes.undo', 'stakes.live', 'stakes.access', 'cause_unknown'])
  // Every id is one every decision model takes, prefixed by the part in the request.
  for (const id of Object.keys(mergeParts(STATE, [own]).questions)) expect(QUESTION_ID.test(id)).toBe(true)
  // The Score and ten Nouls; each Noul's true and false are situations.
  for (const [id, question] of Object.entries(own.questions)) {
    if (id === 'level') expect(question.type).toBe('score')
    else {
      expect(question.type).toBe('noul')
      expect(question.type === 'noul' && typeof question.criteria?.true === 'string' && typeof question.criteria?.false === 'string').toBe(true)
    }
  }
})

test('the questions are English by default and Chinese when asked so; no level name or number is in them', () => {
  const en = JSON.stringify(turnStartPart().questions)
  const zh = JSON.stringify(turnStartPart({ ask: { language: 'zh' } }).questions)
  // Chinese only in a quoted example of what the person may type (`"继续"`).
  expect(en.replace(/\\"[^\\"]*\\"/g, '')).not.toMatch(/[一-鿿]/)
  expect(zh).toMatch(/[一-鿿]/)
  for (const name of ['xhigh', '"max"', '"low"']) expect(en.includes(name)).toBe(false)
  // The effort question measures reasoning only: what it risks and what failed before are questions and facts of their own.
  const level = JSON.stringify(turnStartPart().questions.level)
  expect(level.includes('resisted earlier attempts')).toBe(false)
  expect(level.includes('hard to undo')).toBe(false)
  expect(level).toContain('until it next stops and waits for the person')
})

test('a state field goes in only when it has something in it; the questions name standing_constraints and last_turn only then', () => {
  const bare = turnStartPart()
  expect(bare.state).toBeUndefined()
  expect(JSON.stringify(bare.questions)).not.toContain(CONSTRAINTS_FIELD)
  expect(JSON.stringify(bare.questions)).not.toContain(LAST_TURN_FIELD)
  const rule = constraintOf('这是真钱，生产库千万别动', '我准备直接在生产库上跑迁移。\n\n要不要先备份？')
  const full = turnStartPart({ summary: SUMMARY, count: 2, lastTurn: FACTS, constraints: [rule] })
  expect(Object.keys(full.state ?? {})).toEqual(['problem_summary', 'unresolved_count', LAST_TURN_FIELD, CONSTRAINTS_FIELD])
  expect(full.state?.problem_summary).toEqual(summaryState(SUMMARY))
  expect(full.state?.[LAST_TURN_FIELD]).toEqual({ effort: 'high', tool_calls: 9, failed_calls: 3, hook_blocked_calls: 1, reached_escalate_after: true, last_errors: ['Bash: npm ERR! missing script: test'] })
  expect(full.state?.[CONSTRAINTS_FIELD]).toEqual([{ person_said: '这是真钱，生产库千万别动', assistant_before: '要不要先备份？' }])
  expect(JSON.stringify(full.questions['stakes.undo'])).toContain(CONSTRAINTS_FIELD)
  expect(JSON.stringify(full.questions.cause_unknown)).toContain(LAST_TURN_FIELD)
  // A count of 0, a turn with no failure, no rule: nothing.
  const quiet = turnStartPart({ count: 0, lastTurn: { ...FACTS, failed: 0, blocked: 0 }, constraints: [] })
  expect(quiet.state).toBeUndefined()
  expect(lastTurnState(null)).toBeNull()
  // A report's turn carries no word of the person's: no summary, count or rules (the previous turn's failures it may read).
  expect(Object.keys(turnStartPart({ kind: 'report', summary: SUMMARY, count: 4, constraints: [rule], lastTurn: FACTS }).state ?? {})).toEqual([LAST_TURN_FIELD])
})

test('the summary goes as named fields, each try with whether the person said it did not work', () => {
  expect(summaryState(SUMMARY)).toEqual({ problem: 'Login returns 502', tried: [{ text: 'raised the timeout', unresolved: true }, { text: 'switched to fake timers', unresolved: false }], status: 'waiting for the log' })
})

test('the three Nouls about the problem read back by their own ids; missing ones read as null, none at all as nothing', () => {
  const part = turnStartPart()
  const answers = answersFor(part, { 'effort.still_failing': noul(0.8), 'effort.solved': noul(0.1) })
  expect(readUnresolved(answers)?.probabilities).toEqual({ still_failing: 0.8, solved: 0.1, new_task: null })
  expect(readUnresolved({})).toBeNull()
  expect([...UNRESOLVED_OPTIONS]).toEqual(['still_failing', 'solved', 'new_task'])
})

test('the count moves: still failing adds; solved, or a new task with still failing no, clears; anything else keeps it', () => {
  const judge = (still: number | null, solved: number | null, task: number | null) => judgeUnresolved({ probabilities: { still_failing: still, solved, new_task: task } }).change
  expect(judge(0.7, 0.9, 0.9)).toBe('add')
  expect(judge(0.69, 0.1, 0.1)).toBe('keep')
  expect(judge(0.1, 0.7, 0.1)).toBe('reset')
  expect(judge(0.3, 0.1, 0.8)).toBe('reset')
  // A new task while the old one may still fail (still failing in the band): the count stands.
  expect(judge(0.5, 0.1, 0.9)).toBe('keep')
  expect(judge(null, null, 0.9)).toBe('keep')
  expect(judge(0.2, 0.6, 0.6)).toBe('keep')
  expect([countAfter(2, 'add'), countAfter(2, 'reset'), countAfter(2, 'keep')]).toEqual([3, 0, 2])
  expect(judgeUnresolved({ probabilities: { still_failing: 0.5, solved: 0.1, new_task: 0.9 } }).verdicts).toEqual({ still_failing: 'band', solved: 'no', new_task: 'yes' })
})

test('a lasting rule is kept verbatim with the paragraph before it, masked and clipped; at most five, the oldest dropped, none twice', () => {
  expect(lastParagraph('先说一句。\n\n要不要直接删表？')).toBe('要不要直接删表？')
  expect(lastParagraph('')).toBe('')
  const masked = constraintOf('用这个 key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 但别动生产', '')
  expect(masked.person_said.includes('abcdefghijklmnopqrstuvwxyz0123456789')).toBe(false)
  expect(masked.assistant_before).toBe('')
  let list: ReturnType<typeof constraintOf>[] = []
  for (let i = 1; i <= MOST_CONSTRAINTS + 2; i++) list = withConstraint(list, constraintOf(`规矩 ${i}`, ''))
  expect(list.map((one) => one.person_said)).toEqual(['规矩 3', '规矩 4', '规矩 5', '规矩 6', '规矩 7'])
  expect(withConstraint(list, constraintOf('规矩 5', '')).map((one) => one.person_said)).toEqual(['规矩 3', '规矩 4', '规矩 6', '规矩 7', '规矩 5'])
})
