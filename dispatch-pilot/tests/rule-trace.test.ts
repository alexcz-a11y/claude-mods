// Seam 2: the rules that turn a message's answers into an effort (ADR 0014), with the steps they walked. Tables: one row
// per rule branch, the expected levels written out by hand from the rules (decision/message-effort.ts's header), not computed.

import { expect, test } from 'claude-code/testing'
import { traceEffort, type EffortReading } from '../hooks/decision/effort.ts'
import { decideMessage, namesUltrathink, type MessageSignals } from '../hooks/decision/message-effort.ts'
import { verdictOf } from '../hooks/decision/nouls.ts'
import { decideDispatch, type Dispatch } from '../hooks/decision/dispatched-agent.ts'

const read = (probabilities: number[], confidence: number | null = 0.6): EffortReading => ({ probabilities, confidence })
const step = (steps: readonly { rule: string }[], name: string) => steps.find((s) => s.rule === name) as Record<string, unknown> | undefined

/** No signal at all: what a message with no stake, no failure and no lock gets. */
const QUIET: MessageSignals = { ultrathink: false, stakes: { undo: 0.05, live: 0.05, access: 0.05 }, causeUnknown: 0.05, stillFailing: 0.05, confirm: 0.05, escalate: 0.05, lastTurn: null, count: 0, maxAfter: 3, lock: null }

test('the base: the probability-weighted position rounded to the nearest level, half going up', () => {
  const rows: { p: number[]; position: number; effort: string }[] = [
    { p: [0, 1, 0, 0, 0], position: 1, effort: 'medium' },
    { p: [0, 0.6, 0.4, 0, 0], position: 1.4, effort: 'medium' },
    { p: [0, 0.5, 0.5, 0, 0], position: 1.5, effort: 'high' },
    { p: [0.1, 0.1, 0.2, 0.3, 0.3], position: 2.6, effort: 'xhigh' },
    { p: [0, 0, 0, 0.4, 0.6], position: 3.6, effort: 'max' },
    { p: [0.9, 0.1, 0, 0, 0], position: 0.1, effort: 'low' },
  ]
  for (const row of rows) {
    const { effort, steps } = traceEffort(read(row.p))
    expect([row.p, effort]).toEqual([row.p, row.effort])
    expect(Number((step(steps, 'position')?.position as number).toFixed(6))).toBe(row.position)
    expect(step(steps, 'two-peaked')?.applied).toBe(false)
  }
})

test('two-peaked: a level two or more above the base with at least 0.3 takes the base one level up, once', () => {
  // low 0.6, max 0.4: position 1.6 rounds to high; max (two above high) has 0.4 ≥ 0.3, so xhigh.
  const torn = traceEffort(read([0.6, 0, 0, 0, 0.4]))
  expect(torn.effort).toBe('xhigh')
  expect(step(torn.steps, 'two-peaked')).toEqual({ rule: 'two-peaked', applied: true, level: 'xhigh', peak: 'max', p: 0.4, threshold: 0.3 })
  // A second peak right above the base is no second peak: medium 0.6, high 0.4 stays medium.
  expect(traceEffort(read([0, 0.6, 0.4, 0, 0])).effort).toBe('medium')
  // Under 0.3 two levels up is no peak: medium 0.8, xhigh 0.2 (position 1.4) stays medium.
  expect(traceEffort(read([0, 0.8, 0, 0.2, 0])).effort).toBe('medium')
  // Exactly 0.3 is one: low 0.7, xhigh 0.3: position 0.9 rounds to medium, xhigh is two above, so high.
  expect(traceEffort(read([0.7, 0, 0, 0.3, 0])).effort).toBe('high')
})

test("an agent's effort: the same base rule, then its model's floor (sonnet and opus at least medium)", () => {
  const lifted = traceEffort(read([1, 0, 0, 0, 0]), { model: { name: 'sonnet', floor: 'medium' } })
  expect(lifted.effort).toBe('medium')
  expect(step(lifted.steps, 'model-floor')).toEqual({ rule: 'model-floor', applied: true, level: 'medium', from: 'low', model: 'sonnet', floor: 'medium' })
  expect(traceEffort(read([1, 0, 0, 0, 0]), { model: { name: 'haiku', floor: null } }).effort).toBe('low')
})

test('the verdict of a Noul: yes at 0.7 and above, no at 0.3 and below, the band between', () => {
  expect([0.7, 0.69, 0.31, 0.3, 0, 1].map((p) => verdictOf(p))).toEqual(['yes', 'band', 'band', 'no', 'no', 'yes'])
})

test('every floor row of the truth table: the highest of the base and the floors; a floor never lowers', () => {
  const base = read([0, 1, 0, 0, 0]) // medium
  const rows: { name: string; signals: Partial<MessageSignals>; effort: string; lifted: string | null }[] = [
    { name: 'nothing', signals: {}, effort: 'medium', lifted: null },
    { name: 'R1 ultrathink', signals: { ultrathink: true }, effort: 'xhigh', lifted: 'ultrathink' },
    { name: 'R2 undo and live', signals: { stakes: { undo: 0.9, live: 0.8, access: 0.1 } }, effort: 'max', lifted: 'stakes' },
    { name: 'R2 undo and access', signals: { stakes: { undo: 0.75, live: 0.1, access: 0.7 } }, effort: 'max', lifted: 'stakes' },
    { name: 'R2 one stake yes', signals: { stakes: { undo: 0.1, live: 0.9, access: 0.1 } }, effort: 'xhigh', lifted: 'stakes' },
    { name: 'R2 undo yes alone', signals: { stakes: { undo: 0.8, live: 0.5, access: 0.1 } }, effort: 'xhigh', lifted: 'stakes' },
    { name: 'R2 a stake in the band', signals: { stakes: { undo: 0.5, live: 0.1, access: 0.1 } }, effort: 'high', lifted: 'stakes' },
    { name: 'R2 missing answers lift nothing', signals: { stakes: { undo: null, live: null, access: null } }, effort: 'medium', lifted: null },
    { name: 'R3 cause unknown yes', signals: { causeUnknown: 0.85 }, effort: 'xhigh', lifted: 'cause-unknown' },
    { name: 'R3 cause unknown in the band', signals: { causeUnknown: 0.4 }, effort: 'high', lifted: 'cause-unknown' },
    { name: 'R4 still failing after a stuck turn', signals: { stillFailing: 0.9, lastTurn: { effort: 'high', stuck: true } }, effort: 'xhigh', lifted: 'stuck-again' },
    { name: 'R4 a turn that was not stuck', signals: { stillFailing: 0.9, lastTurn: { effort: 'high', stuck: false } }, effort: 'medium', lifted: null },
    { name: 'R4 still failing in the band', signals: { stillFailing: 0.5, lastTurn: { effort: 'high', stuck: true } }, effort: 'medium', lifted: null },
    { name: 'R4 the stuck turn was at max', signals: { stillFailing: 0.9, lastTurn: { effort: 'max', stuck: true } }, effort: 'max', lifted: 'stuck-again' },
    { name: 'R5 count reached', signals: { stillFailing: 0.8, count: 3, maxAfter: 3 }, effort: 'max', lifted: 'unresolved-count' },
    { name: 'R5 count short of it', signals: { stillFailing: 0.8, count: 2, maxAfter: 3 }, effort: 'medium', lifted: null },
    { name: 'R5 never with maxAfter 0', signals: { stillFailing: 0.8, count: 9, maxAfter: 0 }, effort: 'medium', lifted: null },
    { name: 'R5 needs this message still failing', signals: { stillFailing: 0.2, count: 5, maxAfter: 3 }, effort: 'medium', lifted: null },
  ]
  for (const row of rows) {
    const decided = decideMessage(base, { ...QUIET, ...row.signals })
    expect([row.name, decided.effort, decided.lifted]).toEqual([row.name, row.effort, row.lifted])
    // The trace's last level is what goes out: no lock here.
    expect([row.name, decided.steps.at(-1)?.level]).toEqual([row.name, row.effort])
  }
  // A base already above a floor stays: xhigh with a stake in the band is still xhigh, and the step says it did not lift.
  const high = decideMessage(read([0, 0, 0, 1, 0]), { ...QUIET, stakes: { undo: 0.5, live: 0, access: 0 } })
  expect(high.effort).toBe('xhigh')
  expect(step(high.steps, 'stakes')).toMatchObject({ applied: false, floor: 'high', level: 'xhigh', undoVerdict: 'band' })
})

test('the lock wins over every rule, and the trace says what the rules had decided', () => {
  const decided = decideMessage(read([0, 1, 0, 0, 0]), { ...QUIET, stakes: { undo: 0.9, live: 0.9, access: 0 }, lock: 'low' })
  expect([decided.effort, decided.sent]).toEqual(['max', 'low'])
  expect(decided.steps.at(-1)).toEqual({ rule: 'lock', applied: true, level: 'low', floor: null, decided: 'max' })
})

test('the steps come in a fixed order, each with its probabilities and verdicts', () => {
  const decided = decideMessage(read([0, 1, 0, 0, 0]), { ...QUIET, causeUnknown: 0.5 })
  expect(decided.steps.map((s) => s.rule)).toEqual(['position', 'two-peaked', 'ultrathink', 'escalate', 'confirm', 'stakes', 'cause-unknown', 'stuck-again', 'unresolved-count'])
  expect(step(decided.steps, 'cause-unknown')).toEqual({ rule: 'cause-unknown', applied: true, level: 'high', floor: 'high', p: 0.5, verdict: 'band', yes: 0.7, no: 0.3, inclusive: true })
})

test('ultrathink is asked for where Claude Code would take it: a word of its own, not quoted, not in a path or a code block', () => {
  const asks = ['ultrathink 一下这个并发问题', 'please ultrathink', 'Ultrathink: why does it hang?', '请ultrathink一下', 'think hard. ultrathink.']
  const not = ['the word "ultrathink" raises effort', "what does 'ultrathink' do", '`ultrathink` 是什么', 'see docs/ultrathink.md', 'open ~/notes/ultrathink/today', 'ultrathinking about it', 'run --ultrathink', '「ultrathink」这个词', '```\nultrathink\n```']
  for (const text of asks) expect([text, namesUltrathink(text)]).toEqual([text, true])
  for (const text of not) expect([text, namesUltrathink(text)]).toEqual([text, false])
})

test("a dispatched agent's effort: the base rule, the floors and its model's floor, each a step (ADR 0015)", () => {
  const dispatch: Dispatch = { description: 'd', prompt: 'p', agent_type: 'general-purpose', user_message: '改一下', requested_model: null }
  const score = (probabilities: Record<string, number>) => ({ type: 'score' as const, score: 0, probabilities, confidence: 0.5 })
  const noul = (p: number) => ({ type: 'noul' as const, noul: p })
  const nouls = (given: Record<string, number>) => Object.fromEntries(['writes', 'few_steps', 'report_only', 'stakes.undo', 'stakes.live', 'stakes.access', 'cause_unknown', 'design_open', 'outside_facts', 'science_code'].map((id) => [id, noul(given[id] ?? 0)]))
  // Two-peaked on sonnet (row 5): low 0.6, max 0.4 → xhigh.
  const torn = decideDispatch({ ...nouls({}), effort: score({ 0: 0.6, 1: 0, 2: 0, 3: 0, 4: 0.4 }) }, dispatch, {})
  expect([torn.model, torn.effort]).toEqual(['sonnet', 'xhigh'])
  // Low on opus (row 3, an open design): lifted to the model's floor.
  const floored = decideDispatch({ ...nouls({ design_open: 0.9 }), effort: score({ 0: 1, 1: 0, 2: 0, 3: 0, 4: 0 }) }, dispatch, {})
  expect([floored.model, floored.effort, floored.lifted]).toEqual(['opus', 'medium', { from: 'low', by: 'model-floor' }])
  expect(step(floored.steps, 'model-floor')).toEqual({ rule: 'model-floor', applied: true, level: 'medium', from: 'low', model: 'opus', floor: 'medium' })
  // A stake: the same step a message's stakes take.
  const staked = decideDispatch({ ...nouls({ 'stakes.access': 0.8 }), effort: score({ 0: 1, 1: 0, 2: 0, 3: 0, 4: 0 }) }, dispatch, {})
  expect(step(staked.steps, 'stakes')).toEqual({ rule: 'stakes', applied: true, level: 'xhigh', floor: 'xhigh', undo: 0, undoVerdict: 'no', live: 0, liveVerdict: 'no', access: 0.8, accessVerdict: 'yes', yes: 0.7, no: 0.3, inclusive: true })
})
