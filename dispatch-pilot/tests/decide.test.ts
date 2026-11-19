import { expect, test } from 'claude-code/testing'
import { START, agentPlan, decide, margins, midrunLevel, readNoul, submitLevel } from '../hooks/decide.ts'
import { REASON_EN, messageLevel } from '../hooks/decide.ts'

test('设计里的例子：从 medium 升到 high，不到 xhigh', () => {
  expect(decide('medium', [0.02, 0.08, 0.25, 0.55, 0.1], START)).toBe('high')
})
test('两边都不到门槛时不动', () => {
  expect(decide('high', [0.1, 0.3, 0.3, 0.2, 0.1], START)).toBe('high')
})
test('可以连降几档', () => {
  expect(decide('xhigh', [0.9, 0.05, 0.03, 0.01, 0.01], START)).toBe('low')
})
test('cap 封顶', () => {
  expect(decide('high', [0, 0, 0, 0.05, 0.95], START, 'xhigh')).toBe('xhigh')
})
test('noul 的三种读法', () => {
  expect([readNoul(0.7, START), readNoul(0.3, START), readNoul(0.5, START), readNoul(undefined, START)]).toEqual(['yes', 'no', 'unsure', 'unsure'])
})
test('发消息的 reason', () => {
  expect(submitLevel('medium', { open: [0.02, 0.08, 0.25, 0.55, 0.1] }, START)).toEqual({ level: 'high', reason: 'more-open' })
  expect(submitLevel('high', { open: [0.2, 0.2, 0.2, 0.2, 0.2] }, START)).toEqual({ level: 'high', reason: 'hold' })
})
test('margins：再升一档和再降一档各差多少', () => {
  const m = margins('high', [0.03, 0.1, 0.46, 0.33, 0.08], START)
  expect(m.up?.bar).toBe(0.8)
  // the test kit has no toBeCloseTo
  expect(Math.abs((m.up?.sum ?? NaN) - 0.41)).toBeLessThan(1e-9)
  expect(m.down?.bar).toBe(0.7)
  expect(Math.abs((m.down?.sum ?? NaN) - 0.13)).toBeLessThan(1e-9)
  expect(margins('max', [0, 0, 0, 0, 1], START).up).toBe(null)
  expect(margins('low', [1, 0, 0, 0, 0], START).down).toBe(null)
})
test('发消息：机械改动封顶 medium，原因未知保底 high，两条都成立取 high', () => {
  const flat = [0.2, 0.2, 0.2, 0.2, 0.2]
  expect(submitLevel('xhigh', { open: flat, mechanical: 0.9 }, START).level).toBe('medium')
  expect(submitLevel('low', { open: flat, unknownCause: 0.9 }, START).level).toBe('high')
  expect(submitLevel('low', { open: flat, mechanical: 0.9, unknownCause: 0.9 }, START).level).toBe('high')
})
test('中途：默认不动；同一失败复现升一档；降档要两个条件', () => {
  const flat = [0.2, 0.2, 0.2, 0.2, 0.2]
  const easy = [0.8, 0.15, 0.05, 0, 0]
  expect(midrunLevel('high', { open: flat }, START).level).toBe('high')
  expect(midrunLevel('medium', { open: flat, sameFailure: 0.8 }, START)).toEqual({ level: 'high', reason: 'same-failure' })
  expect(midrunLevel('high', { open: easy }, START).level).toBe('high')
  expect(midrunLevel('high', { open: easy, onlyCarryingOut: 0.8 }, START).level).toBe('low')
  expect(midrunLevel('xhigh', { open: [0, 0, 0, 0, 1], contradictsPlan: 0.9 }, START).level).toBe('xhigh')
})
test('agent：fableAgents 关着时继承的 fable 降到 opus，即使没有回答', () => {
  const opts = { agentModels: ['haiku', 'sonnet', 'opus'] as const, fableAgents: false }
  expect(agentPlan({ level: 'high', tier: 'fable' }, { open: [0.2, 0.2, 0.2, 0.2, 0.2] }, opts, START).model).toBe('opus')
  expect(agentPlan({ level: 'high', tier: 'opus' }, { open: [0.9, 0.1, 0, 0, 0], readOnly: 0.9, mechanical: 0.9 }, opts, START).model).toBe('haiku')
  expect(agentPlan({ level: 'high', tier: 'opus' }, { open: [0.5, 0.4, 0.1, 0, 0] }, opts, START).model).toBe('sonnet')
  expect(agentPlan({ level: null, tier: null }, { open: [1, 0, 0, 0, 0] }, opts, START)).toMatchObject({ effort: null, model: null })
})

// Tests below cover behaviour the brief's tests do not reach.
test('阈值比较留 1e-9 的容差：浮点和差一点点也算够', () => {
  // 0.7 + 0.1 is 0.7999999999999999 in floating point, just under the 0.8 bar
  expect(0.7 + 0.1 >= 0.8).toBe(false)
  expect(decide('high', [0, 0, 0.2, 0.7, 0.1], START)).toBe('xhigh')
  expect(readNoul(0.7 + 0.1, { ...START, yes: 0.8 })).toBe('yes')
  expect(readNoul(0.1 + 0.2, START)).toBe('no')
})
test('升 xhigh、max 用 upHigh，升 high 用 up', () => {
  // 0.75 above medium: enough for high (0.7) but not for xhigh (0.8)
  expect(decide('medium', [0, 0.25, 0.75, 0, 0], START)).toBe('high')
  expect(decide('high', [0, 0, 0.25, 0.7, 0.05], START)).toBe('high')
  expect(decide('high', [0, 0, 0.1, 0.1, 0.8], START)).toBe('max')
})
test('decide：升得动就不再看降；概率缺项当 0', () => {
  expect(decide('medium', [0.5, 0, 0.1, 0.1, 0.3], START)).toBe('medium')
  expect(decide('medium', [], START)).toBe('medium')
  expect(decide('low', [1], START)).toBe('low')
})
test('messageLevel 带回它起算的档位：只说接着做时是上一轮的，否则是会话自己的', () => {
  const flat = [0.2, 0.2, 0.2, 0.2, 0.2]
  expect(messageLevel('medium', 'xhigh', { open: flat, continues: 0.9 }, START)).toEqual({ level: 'xhigh', reason: 'continues', base: 'xhigh' })
  expect(messageLevel('medium', 'xhigh', { open: flat, continues: 0.1 }, START)).toEqual({ level: 'medium', reason: 'hold', base: 'medium' })
  expect(messageLevel('medium', null, { open: flat, continues: 0.9 }, START)).toEqual({ level: 'medium', reason: 'hold', base: 'medium' })
})
test('REASON_EN：十个原因都有固定文字', () => {
  expect(Object.keys(REASON_EN).sort()).toEqual(
    ['carrying-out', 'cause-found', 'continues', 'contradicts-plan', 'hold', 'less-open', 'mechanical', 'more-open', 'same-failure', 'unknown-cause'],
  )
  expect(REASON_EN.hold).toBe('no change')
  expect(REASON_EN['unknown-cause']).toBe('a cause has to be found first')
  expect(REASON_EN.continues).toBe("the message only says to go on, so the level is the previous turn's")
})
test('发消息的 reason：降档、机械、原因未知', () => {
  const flat = [0.2, 0.2, 0.2, 0.2, 0.2]
  expect(submitLevel('xhigh', { open: [0.9, 0.05, 0.03, 0.01, 0.01] }, START)).toEqual({ level: 'low', reason: 'less-open' })
  expect(submitLevel('xhigh', { open: flat, mechanical: 0.9 }, START)).toEqual({ level: 'medium', reason: 'mechanical' })
  expect(submitLevel('low', { open: flat, unknownCause: 0.9 }, START)).toEqual({ level: 'high', reason: 'unknown-cause' })
  // both: the floor wins over the cap, and the floor's reason is reported
  expect(submitLevel('xhigh', { open: flat, mechanical: 0.9, unknownCause: 0.9 }, START)).toEqual({ level: 'high', reason: 'unknown-cause' })
  // a flag that changes nothing leaves the decide reason
  expect(submitLevel('medium', { open: flat, mechanical: 0.9 }, START)).toEqual({ level: 'medium', reason: 'hold' })
  expect(submitLevel('xhigh', { open: flat, mechanical: 0.5, unknownCause: 0.5 }, START)).toEqual({ level: 'xhigh', reason: 'hold' })
})
test('中途的 reason：contradicts-plan、more-open、cause-found、carrying-out、hold', () => {
  const flat = [0.2, 0.2, 0.2, 0.2, 0.2]
  const easy = [0.8, 0.15, 0.05, 0, 0]
  expect(midrunLevel('low', { open: flat, contradictsPlan: 0.9 }, START)).toEqual({ level: 'medium', reason: 'contradicts-plan' })
  expect(midrunLevel('medium', { open: flat, sameFailure: 0.9, contradictsPlan: 0.9 }, START)).toEqual({ level: 'high', reason: 'same-failure' })
  expect(midrunLevel('medium', { open: [0, 0, 0.1, 0.1, 0.8] }, START)).toEqual({ level: 'xhigh', reason: 'more-open' })
  expect(midrunLevel('high', { open: easy, causeFound: 0.8 }, START)).toEqual({ level: 'low', reason: 'cause-found' })
  expect(midrunLevel('high', { open: easy, causeFound: 0.8, onlyCarryingOut: 0.8 }, START).reason).toBe('cause-found')
  expect(midrunLevel('high', { open: easy, onlyCarryingOut: 0.8 }, START)).toEqual({ level: 'low', reason: 'carrying-out' })
  expect(midrunLevel('high', { open: easy }, START)).toEqual({ level: 'high', reason: 'hold' })
  // already at the cap: a flag has nothing to raise, and max is never lowered by a flag
  expect(midrunLevel('xhigh', { open: [0, 0, 0, 0, 1], contradictsPlan: 0.9 }, START)).toEqual({ level: 'xhigh', reason: 'hold' })
  expect(midrunLevel('max', { open: flat, sameFailure: 0.9 }, START)).toEqual({ level: 'max', reason: 'hold' })
})
test('agent：modelReason 的四个取值', () => {
  const opts = { agentModels: ['haiku', 'sonnet', 'opus'] as const, fableAgents: false }
  const flat = [0.2, 0.2, 0.2, 0.2, 0.2]
  const easy = [0.5, 0.4, 0.1, 0, 0]
  const ro = { open: flat, readOnly: 0.9, mechanical: 0.9 }
  expect(agentPlan({ level: 'high', tier: 'opus' }, ro, opts, START)).toMatchObject({ model: 'haiku', modelReason: 'lowest' })
  expect(agentPlan({ level: 'high', tier: 'opus' }, { open: easy }, opts, START)).toMatchObject({ model: 'sonnet', modelReason: 'one-down' })
  expect(agentPlan({ level: 'high', tier: 'fable' }, { open: flat }, opts, START)).toMatchObject({ model: 'opus', modelReason: 'capped' })
  expect(agentPlan({ level: 'high', tier: 'opus' }, { open: flat }, opts, START)).toMatchObject({ model: 'opus', modelReason: 'inherit' })
  // the cap applies before the answers: a fable parent plus easy answers goes to sonnet from the capped opus
  expect(agentPlan({ level: 'high', tier: 'fable' }, { open: easy }, opts, START)).toMatchObject({ model: 'sonnet', modelReason: 'one-down' })
  expect(agentPlan({ level: 'high', tier: 'fable' }, ro, opts, START)).toMatchObject({ model: 'haiku', modelReason: 'lowest' })
})
test('agent：候选只取不高于继承的，一层下不低于 sonnet，fableAgents 打开后 fable 可继承', () => {
  const easy = [0.5, 0.4, 0.1, 0, 0]
  const flat = [0.2, 0.2, 0.2, 0.2, 0.2]
  const all = { agentModels: ['haiku', 'sonnet', 'opus', 'fable'] as const, fableAgents: true }
  // sonnet parent: one tier down would be haiku, which is below the floor
  expect(agentPlan({ level: 'high', tier: 'sonnet' }, { open: easy }, all, START)).toMatchObject({ model: 'sonnet', modelReason: 'inherit' })
  // sonnet parent with both flags: the lowest candidate is still allowed to be haiku
  expect(agentPlan({ level: 'high', tier: 'sonnet' }, { open: flat, readOnly: 0.8, mechanical: 0.8 }, all, START)).toMatchObject({ model: 'haiku', modelReason: 'lowest' })
  // the lowest candidate is the parent's own tier: nothing to lower
  expect(agentPlan({ level: 'high', tier: 'haiku' }, { open: easy, readOnly: 0.9, mechanical: 0.9 }, all, START)).toMatchObject({ model: 'haiku', modelReason: 'inherit' })
  // fableAgents on: fable is inherited and can be lowered one tier
  expect(agentPlan({ level: 'high', tier: 'fable' }, { open: flat }, all, START)).toMatchObject({ model: 'fable', modelReason: 'inherit' })
  expect(agentPlan({ level: 'high', tier: 'fable' }, { open: easy }, all, START)).toMatchObject({ model: 'opus', modelReason: 'one-down' })
  // fable in agentModels is ignored while fableAgents is off
  expect(agentPlan({ level: 'high', tier: 'fable' }, { open: flat }, { agentModels: ['fable'], fableAgents: false }, START)).toMatchObject({ model: 'opus', modelReason: 'capped' })
  // the tier below is not in agentModels: stay
  expect(agentPlan({ level: 'high', tier: 'opus' }, { open: easy }, { agentModels: ['haiku', 'opus'], fableAgents: false }, START)).toMatchObject({ model: 'opus', modelReason: 'inherit' })
  // an empty candidate list leaves the parent's tier
  expect(agentPlan({ level: 'high', tier: 'sonnet' }, { open: easy, readOnly: 0.9, mechanical: 0.9 }, { agentModels: ['opus'], fableAgents: false }, START)).toMatchObject({ model: 'sonnet', modelReason: 'inherit' })
})
test('agent：effort 同发消息；没有档位时 effort 为 null，模型照样定', () => {
  const opts = { agentModels: ['haiku', 'sonnet', 'opus'] as const, fableAgents: false }
  const flat = [0.2, 0.2, 0.2, 0.2, 0.2]
  expect(agentPlan({ level: 'xhigh', tier: 'opus' }, { open: flat, mechanical: 0.9 }, opts, START)).toMatchObject({ effort: 'medium', reason: 'mechanical' })
  expect(agentPlan({ level: 'low', tier: 'opus' }, { open: flat, unknownCause: 0.9 }, opts, START)).toMatchObject({ effort: 'high', reason: 'unknown-cause' })
  expect(agentPlan({ level: null, tier: 'opus' }, { open: [0.5, 0.4, 0.1, 0, 0] }, opts, START)).toMatchObject({ effort: null, model: 'sonnet', reason: 'hold' })
})
