// Seam 2: the effort rules return the steps they walked with their result (spec #22, ticket #23).
// Tables: one row per rule branch. The expected steps are written out by hand from the rules
// (DEVELOPMENT.md, 「按 AA 基准校正」), not computed.

import { expect, test } from 'claude-code/testing'
import { pickEffort, traceEffort, type EffortReading, type EffortStep } from '../hooks/decision/effort.ts'
import { decideDispatch, type Dispatch } from '../hooks/decision/dispatched-agent.ts'
import { judgeMidturn, type MidturnRules } from '../hooks/decision/midturn.ts'

const read = (probabilities: number[], confidence: number | null = 0.6): EffortReading => ({ probabilities, confidence })
const rule = (steps: readonly { rule: string }[], name: string) => steps.find((s) => s.rule === name)

test('pickEffort walks: most likely, max gate, round up, in that order, each saying whether it took effect', () => {
  const rows: { name: string; p: number[]; thetaMax: number; effort: string; top: object; gate: object; up: object }[] = [
    {
      name: 'plain most likely',
      p: [0, 0.7, 0.2, 0.1, 0],
      thetaMax: 0.5,
      effort: 'medium',
      top: { level: 'medium', p: 0.7, tie: false },
      gate: { applied: false, level: 'medium' },
      up: { applied: false, above: 'high', p: 0.2, level: 'medium' },
    },
    {
      name: 'tie goes to the higher level',
      p: [0, 0.45, 0.45, 0.1, 0],
      thetaMax: 0.5,
      effort: 'high',
      top: { level: 'high', p: 0.45, tie: true },
      gate: { applied: false },
      up: { applied: false, above: 'xhigh', level: 'high' },
    },
    {
      name: 'max held back below thetaMax',
      p: [0, 0, 0.3, 0.3, 0.4],
      thetaMax: 0.5,
      effort: 'xhigh',
      top: { level: 'max', p: 0.4, tie: false },
      gate: { applied: true, level: 'xhigh', p: 0.4, thetaMax: 0.5 },
      up: { applied: false, above: 'max', blockedByMax: true, level: 'xhigh' },
    },
    {
      name: 'max kept at thetaMax',
      p: [0, 0, 0.1, 0.4, 0.5],
      thetaMax: 0.5,
      effort: 'max',
      top: { level: 'max' },
      gate: { applied: false, level: 'max' },
      up: { applied: false, above: null, level: 'max' },
    },
    {
      name: 'round up one level at 0.3',
      p: [0, 0.5, 0.3, 0.2, 0],
      thetaMax: 0.5,
      effort: 'high',
      top: { level: 'medium' },
      gate: { applied: false },
      up: { applied: true, above: 'high', p: 0.3, threshold: 0.3, level: 'high' },
    },
    {
      name: 'just under 0.3 stays',
      p: [0, 0.5, 0.29, 0.21, 0],
      thetaMax: 0.5,
      effort: 'medium',
      top: { level: 'medium' },
      gate: { applied: false },
      up: { applied: false, above: 'high', p: 0.29, level: 'medium' },
    },
    {
      name: 'round up into max needs thetaMax',
      p: [0, 0, 0.2, 0.5, 0.3],
      thetaMax: 0.5,
      effort: 'xhigh',
      top: { level: 'xhigh' },
      gate: { applied: false },
      up: { applied: false, above: 'max', p: 0.3, blockedByMax: true, level: 'xhigh' },
    },
    {
      name: 'round up into max when thetaMax is low enough',
      p: [0, 0, 0.2, 0.5, 0.3],
      thetaMax: 0.3,
      effort: 'max',
      top: { level: 'xhigh' },
      gate: { applied: false },
      up: { applied: true, above: 'max', blockedByMax: false, level: 'max' },
    },
  ]
  for (const row of rows) {
    const reading = read(row.p)
    const traced = traceEffort(reading, row.thetaMax)
    expect({ name: row.name, effort: traced.effort }).toEqual({ name: row.name, effort: row.effort })
    expect({ name: row.name, steps: traced.steps.map((s) => s.rule) }).toEqual({ name: row.name, steps: ['top', 'max-gate', 'round-up'] })
    expect({ name: row.name, step: rule(traced.steps, 'top') }).toMatchObject({ name: row.name, step: { applied: true, ...row.top } })
    expect({ name: row.name, step: rule(traced.steps, 'max-gate') }).toMatchObject({ name: row.name, step: row.gate })
    expect({ name: row.name, step: rule(traced.steps, 'round-up') }).toMatchObject({ name: row.name, step: row.up })
    // pickEffort is the same rules, result only.
    expect(pickEffort(reading, row.thetaMax)).toBe(row.effort)
    // The last step's level is the result.
    expect((traced.steps.at(-1) as EffortStep).level).toBe(row.effort)
  }
})

test('model floor and plan floor lift the result, and say so; without either the steps are absent', () => {
  const low = read([0.8, 0.1, 0.1, 0, 0])
  const bare = traceEffort(low, 0.5)
  expect(bare.steps.map((s) => s.rule)).toEqual(['top', 'max-gate', 'round-up'])

  // sonnet / opus at least medium: low is lifted.
  const sonnet = traceEffort(low, 0.5, { model: { name: 'sonnet', floor: 'medium' } })
  expect(sonnet.effort).toBe('medium')
  expect(rule(sonnet.steps, 'model-floor')).toMatchObject({ applied: true, model: 'sonnet', floor: 'medium', from: 'low', level: 'medium' })
  // Already at the floor: not applied.
  const high = traceEffort(read([0, 0, 1, 0, 0]), 0.5, { model: { name: 'opus', floor: 'medium' } })
  expect(high.effort).toBe('high')
  expect(rule(high.steps, 'model-floor')).toMatchObject({ applied: false, level: 'high' })
  // A model with no floor.
  const fable = traceEffort(low, 0.5, { model: { name: 'fable', floor: null } })
  expect(fable.effort).toBe('low')
  expect(rule(fable.steps, 'model-floor')).toMatchObject({ applied: false, floor: null })

  // The plan's floor, and a forced raise (the same step, marked).
  const plan = traceEffort(low, 0.5, { model: { name: 'sonnet', floor: 'medium' }, plan: { floor: 'xhigh', forced: true } })
  expect(plan.effort).toBe('xhigh')
  expect(plan.steps.map((s) => s.rule)).toEqual(['top', 'max-gate', 'round-up', 'model-floor', 'plan-floor'])
  expect(rule(plan.steps, 'plan-floor')).toMatchObject({ applied: true, floor: 'xhigh', forced: true, from: 'medium', level: 'xhigh' })
  const held = traceEffort(read([0, 0, 0, 1, 0]), 0.5, { plan: { floor: 'high' } })
  expect(held.effort).toBe('xhigh')
  expect(rule(held.steps, 'plan-floor')).toMatchObject({ applied: false, forced: false })
})

const RULES: MidturnRules = { thetaUp: 0.4, thetaDown: 0.6, thetaMax: 0.5, holdSteps: 3 }

test('judgeMidturn walks: suggestion, hold, threshold, one level at a time, floor', () => {
  const xhigh = read([0, 0, 0.1, 0.8, 0.1], 0.8)
  const low = read([0.9, 0.1, 0, 0, 0], 0.9)
  const rows: { name: string; reading: EffortReading; position: Parameters<typeof judgeMidturn>[1]; rules?: MidturnRules; effort: string; steps: object[] }[] = [
    {
      name: 'raise past thetaUp',
      reading: xhigh,
      position: { current: 'medium', sinceRaise: null },
      effort: 'xhigh',
      steps: [
        { rule: 'suggest', picked: 'xhigh', current: 'medium', direction: 'up' },
        { rule: 'theta-up', applied: true, confidence: 0.8, threshold: 0.4 },
      ],
    },
    {
      name: 'raise short of thetaUp',
      reading: read([0, 0, 0.1, 0.8, 0.1], 0.3),
      position: { current: 'medium', sinceRaise: null },
      effort: 'medium',
      steps: [{ rule: 'suggest', direction: 'up' }, { rule: 'theta-up', applied: false, confidence: 0.3, threshold: 0.4 }],
    },
    {
      name: 'lower one level past thetaDown',
      reading: low,
      position: { current: 'xhigh', sinceRaise: null },
      effort: 'high',
      steps: [
        { rule: 'suggest', picked: 'low', current: 'xhigh', direction: 'down' },
        { rule: 'hold', applied: false, sinceRaise: null, holdSteps: 3, remaining: 0 },
        { rule: 'theta-down', applied: true, confidence: 0.9, threshold: 0.6 },
        { rule: 'one-step', applied: true, from: 'xhigh', level: 'high' },
      ],
    },
    {
      name: 'lower short of thetaDown',
      reading: read([0.9, 0.1, 0, 0, 0], 0.5),
      position: { current: 'xhigh', sinceRaise: null },
      effort: 'xhigh',
      steps: [{ rule: 'suggest' }, { rule: 'hold', applied: false }, { rule: 'theta-down', applied: false, confidence: 0.5, threshold: 0.6 }],
    },
    {
      name: 'thetaDown never below thetaUp',
      reading: read([0.9, 0.1, 0, 0, 0], 0.5),
      position: { current: 'xhigh', sinceRaise: null },
      rules: { ...RULES, thetaUp: 0.7, thetaDown: 0.6 },
      effort: 'xhigh',
      steps: [{ rule: 'suggest' }, { rule: 'hold', applied: false }, { rule: 'theta-down', applied: false, threshold: 0.7 }],
    },
    {
      name: 'hold: raised 2 steps ago, 1 more to wait',
      reading: low,
      position: { current: 'xhigh', sinceRaise: 2 },
      effort: 'xhigh',
      steps: [{ rule: 'suggest', direction: 'down' }, { rule: 'hold', applied: true, sinceRaise: 2, holdSteps: 3, remaining: 1 }],
    },
    {
      name: 'hold over after holdSteps',
      reading: low,
      position: { current: 'xhigh', sinceRaise: 3 },
      effort: 'high',
      steps: [{ rule: 'suggest' }, { rule: 'hold', applied: false, sinceRaise: 3, remaining: 0 }, { rule: 'theta-down', applied: true }, { rule: 'one-step', level: 'high' }],
    },
    {
      name: 'same level',
      reading: read([0, 0, 0.9, 0.1, 0], 0.9),
      position: { current: 'high', sinceRaise: null },
      effort: 'high',
      steps: [{ rule: 'suggest', picked: 'high', current: 'high', direction: 'same' }],
    },
    {
      name: 'floor lifts a lowering',
      reading: low,
      position: { current: 'medium', sinceRaise: null, atLeast: 'high' },
      effort: 'high',
      steps: [{ rule: 'suggest' }, { rule: 'hold' }, { rule: 'theta-down', applied: true }, { rule: 'one-step', level: 'low' }, { rule: 'floor', applied: true, floor: 'high', from: 'low', level: 'high' }],
    },
    {
      name: 'floor not needed',
      reading: xhigh,
      position: { current: 'medium', sinceRaise: null, atLeast: 'high' },
      effort: 'xhigh',
      steps: [{ rule: 'suggest' }, { rule: 'theta-up', applied: true }, { rule: 'floor', applied: false, floor: 'high', level: 'xhigh' }],
    },
  ]
  for (const row of rows) {
    const verdict = judgeMidturn(row.reading, row.position, row.rules ?? RULES)
    const where = { name: row.name }
    expect({ ...where, effort: verdict.effort }).toEqual({ ...where, effort: row.effort })
    expect({ ...where, result: verdict.trace.result }).toEqual({ ...where, result: row.effort })
    expect({ ...where, rules: verdict.trace.steps.map((s) => s.rule) }).toEqual({ ...where, rules: row.steps.map((s) => (s as { rule: string }).rule) })
    row.steps.forEach((step, i) => expect({ ...where, step: verdict.trace.steps[i] }).toMatchObject({ ...where, step }))
  }
})

test('judgeMidturn trace carries the pick walk and where the confidence came from', () => {
  const withBackend = judgeMidturn(read([0, 0, 0.35, 0.65, 0], 0.7), { current: 'medium', sinceRaise: null }, RULES)
  expect(withBackend.trace.confidence).toEqual({ value: 0.7, from: 'backend' })
  expect(withBackend.trace.pick.effort).toBe('xhigh')
  expect(withBackend.trace.pick.steps.map((s) => s.rule)).toEqual(['top', 'max-gate', 'round-up'])
  // No confidence from the backend: the most likely level's probability stands in.
  const without = judgeMidturn(read([0, 0, 0.35, 0.65, 0], null), { current: 'medium', sinceRaise: null }, RULES)
  expect(without.trace.confidence).toEqual({ value: 0.65, from: 'probability' })
  // The pick walk uses the rules' thetaMax.
  const gated = judgeMidturn(read([0, 0, 0.1, 0.4, 0.5], 0.7), { current: 'high', sinceRaise: null }, { ...RULES, thetaMax: 0.6 })
  expect(gated.trace.pick.steps.find((s) => s.rule === 'max-gate')).toMatchObject({ applied: true, thetaMax: 0.6 })
})

test("a dispatched agent's decision carries the walk with its model's floor; the effort it goes at is as before", () => {
  const score = (levels: number[]) => ({ type: 'score' as const, score: 0, probabilities: Object.fromEntries(levels.map((p, i) => [String(i), p])), confidence: null })
  const item: Dispatch = { user_message: '查一下 legacyAuth 在哪', kind: 'agent', agent_type: 'general-purpose', description: '查引用', prompt: '找出所有引用', requested_model: 'sonnet', workflow_description: null, label: null }
  const decided = decideDispatch({ effort: score([0.9, 0.1, 0, 0, 0]) }, item, { thetaOverride: 0.6, thetaMax: 0.5 })
  expect(decided).toMatchObject({ model: 'sonnet', effort: 'medium', liftedFrom: 'low' })
  expect(decided.trace?.effort).toBe('medium')
  expect(decided.trace?.steps.map((s) => s.rule)).toEqual(['top', 'max-gate', 'round-up', 'model-floor'])
  expect(decided.trace?.steps.at(-1)).toMatchObject({ rule: 'model-floor', applied: true, model: 'sonnet', floor: 'medium', from: 'low' })
  // No usable answer: no walk.
  expect(decideDispatch({}, item, { thetaOverride: 0.6, thetaMax: 0.5 }).trace).toBeNull()
})
