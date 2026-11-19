import { expect, test } from 'claude-code/testing'
import type { Answer } from '../hooks/backend.ts'
import { START, submitLevel } from '../hooks/decide.ts'
import { START_BARS, mark, outcomeOf } from '../eval/lib/read.ts'
import type { Bars, Stored } from '../eval/lib/read.ts'
import { conservativeFor, gridFor, plateau, sweep } from '../eval/lib/sweep.ts'
import type { Row } from '../eval/lib/sweep.ts'
import type { AgentCase, MidrunCase, SkillCase, SubmitCase } from '../eval/lib/case.ts'

const label = { by: 'model' as const, rationale: '手写的用例。' }
const n = (p: number): Answer => ({ type: 'noul', noul: p })
const score = (probabilities: number[]): Answer => ({ type: 'score', score: probabilities.indexOf(Math.max(...probabilities)), probabilities })
const choice = (choice: string, probabilities: Record<string, number>): Answer => ({ type: 'choice', choice, probabilities })
const ok = (answers: Record<string, Answer>): Stored => ({ ok: true, model: 'drex-max-v1.1', answers })

const submitCase: SubmitCase = {
  id: 'submit-01', category: 'submit', source: 'written', difficulty: 'typical', set: 'fit', tags: [], label,
  input: { request: 'rename the flag in the docs', previous: null, base: 'medium' },
  expect: { accept: ['low'] },
}
// Mostly low: the open score takes it one step down from medium.
const lowOpen = [0.8, 0.15, 0.05, 0, 0]
const submitAnswers = { open: score(lowOpen), mechanical: n(0.2), unknown_cause: n(0.1) }

test('回答失败或 model 不是 drex-max-v1.1：不是答案', () => {
  expect(outcomeOf(submitCase, { ok: false, reason: 'timeout' }, START_BARS)).toBe(null)
  expect(outcomeOf(submitCase, { ok: true, model: 'drex-max-v1.0', answers: submitAnswers }, START_BARS)).toBe(null)
})

test('缺题：不是答案', () => {
  expect(outcomeOf(submitCase, ok({ open: score(lowOpen), mechanical: n(0.2) }), START_BARS)).toBe(null)
  expect(outcomeOf(submitCase, ok(submitAnswers), START_BARS, { form: 'direct' })).toBe(null)
})

test('submit 在 START_BARS 下的档位和 submitLevel 一样', () => {
  const o = outcomeOf(submitCase, ok(submitAnswers), START_BARS)
  const want = submitLevel('medium', { open: lowOpen, mechanical: 0.2, unknownCause: 0.1 }, START).level
  expect(o).toEqual({ level: want, model: null, skill: null })
  expect(mark(submitCase, o!)).toBe('right')
})

test('上一轮说「接着做」：从上一轮的档位起算，和 mod 一样', () => {
  const previous = { request: 'migrate the store', lastReply: 'Shall I go on?', ended: 'answered' as const, level: 'xhigh' as const }
  const c: SubmitCase = { ...submitCase, input: { ...submitCase.input, previous } }
  const flat = [0.2, 0.2, 0.2, 0.2, 0.2]
  expect(outcomeOf(c, ok({ open: score(flat), mechanical: n(0.1), unknown_cause: n(0.1), continues: n(0.9) }), START_BARS)?.level).toBe('xhigh')
  expect(outcomeOf(c, ok({ open: score(flat), mechanical: n(0.1), unknown_cause: n(0.1), continues: n(0.1) }), START_BARS)?.level).toBe('medium')
})

test("form 'direct'：取 readDirect 的档位", () => {
  const answers = { ...submitAnswers, direct: choice('high', { low: 0.05, medium: 0.1, high: 0.7, xhigh: 0.1, max: 0.05 }) }
  expect(outcomeOf(submitCase, ok(answers), START_BARS, { form: 'direct' })?.level).toBe('high')
  expect(mark(submitCase, outcomeOf(submitCase, ok(answers), START_BARS, { form: 'direct' })!)).toBe('over')
})

test('longUnattended：那题读成「是」时不低于 high，读成「否」时不动', () => {
  expect(outcomeOf(submitCase, ok({ ...submitAnswers, long_unattended: n(0.9) }), START_BARS, { longUnattended: true })?.level).toBe('high')
  expect(outcomeOf(submitCase, ok({ ...submitAnswers, long_unattended: n(0.1) }), START_BARS, { longUnattended: true })?.level).toBe('low')
  expect(outcomeOf(submitCase, ok(submitAnswers), START_BARS, { longUnattended: true })).toBe(null)
})

test('档位低于 accept：under', () => {
  expect(mark({ ...submitCase, expect: { accept: ['high', 'xhigh'] } }, { level: 'medium', model: null, skill: null })).toBe('under')
})

const step = { did: 'ran the tests', tools: ['Bash'], ok: false, result: '1 failed' }
const midrunCase: MidrunCase = {
  id: 'midrun-01', category: 'midrun', source: 'written', difficulty: 'typical', set: 'fit', tags: [], label,
  input: { request: 'fix the failing test', current: 'medium', stepsSoFar: 4, failedSteps: 1, recent: [step], latest: step, statedNext: 'look again', codeMode: false, notes: null },
  expect: { action: 'hold', accept: ['medium'] },
}
const quiet = { same_failure: n(0.1), cause_found: n(0.1), only_carrying_out: n(0.1), contradicts_plan: n(0.1) }

test('midrun：期望 hold 而换了挡是 needless-shift；期望换而没换是 missed-shift', () => {
  const up = outcomeOf(midrunCase, ok({ open: score([0, 0.05, 0.15, 0.8, 0]), ...quiet }), START_BARS)!
  expect(up.level === 'medium').toBe(false)
  expect(mark(midrunCase, up)).toBe('needless-shift')
  const stays = outcomeOf(midrunCase, ok({ open: score([0.1, 0.8, 0.1, 0, 0]), ...quiet }), START_BARS)!
  expect(stays.level).toBe('medium')
  expect(mark(midrunCase, stays)).toBe('right')
  expect(mark({ ...midrunCase, expect: { action: 'up', accept: ['high'] } }, stays)).toBe('missed-shift')
})

const agentCase: AgentCase = {
  id: 'agent-01', category: 'agent', source: 'written', difficulty: 'typical', set: 'fit', tags: [], label,
  input: { task: 'list the files under hooks/', agentType: 'Explore', description: 'list hooks', inherit: { level: 'medium', tier: 'opus' } },
  expect: { accept: ['low'], models: ['haiku'] },
}

test('agent：模型按默认配置算；档位对而模型不在 models 里是 wrong-model', () => {
  const lowest = outcomeOf(agentCase, ok({ open: score(lowOpen), mechanical: n(0.9), unknown_cause: n(0.05), read_only: n(0.95) }), START_BARS)!
  expect(lowest).toEqual({ level: 'low', model: 'haiku', skill: null })
  expect(mark(agentCase, lowest)).toBe('right')
  const kept = outcomeOf(agentCase, ok({ open: score([0.75, 0.0, 0.05, 0.1, 0.1]), mechanical: n(0.4), unknown_cause: n(0.05), read_only: n(0.4) }), START_BARS)!
  expect(kept.level).toBe('low')
  expect(kept.model).toBe('opus')
  expect(mark(agentCase, kept)).toBe('wrong-model')
})

const skillCase: SkillCase = {
  id: 'skill-01', category: 'skill', source: 'written', difficulty: 'typical', set: 'fit', tags: [], label,
  input: { request: 'review this branch since main', previous: null },
  expect: { skill: 'code-review', alsoOk: [] },
}
const acting = { acts_on_user_system: n(0.9), would_follow_documented_procedure: n(0.9), prose_suffices: n(0.1), named: n(0.2) }
const idle = { acts_on_user_system: n(0.05), would_follow_documented_procedure: n(0.05), prose_suffices: n(0.95), named: n(0.1) }
const firstOf = (gate: Record<string, Answer>): Stored =>
  ok({ skill_0: choice('code-review', { 'code-review': 0.6, tdd: 0.25, research: 0.1, other: 0.05 }), ...gate })
const secondOf = (pick: string, fits: number[]): Stored =>
  ok({ which: choice(pick, { 'code-review': 0.1, tdd: 0.1, research: 0.1, other: 0.1, [pick]: 0.7 }), ...Object.fromEntries(fits.map((f, i) => [`fits_${i}`, n(f)])) })

test('skill：推荐了别的是 wrong-skill', () => {
  const o = outcomeOf(skillCase, firstOf(acting), START_BARS, { second: secondOf('tdd', [0.4, 0.8, 0.1]) })!
  expect(o.skill).toBe('tdd')
  expect(mark(skillCase, o)).toBe('wrong-skill')
  expect(mark({ ...skillCase, expect: { skill: 'code-review', alsoOk: ['tdd'] } }, o)).toBe('right')
})

test('skill：该推荐而没推荐是 missed-skill（动手题和点名题都没过门槛）', () => {
  const o = outcomeOf(skillCase, firstOf(idle), START_BARS)!
  expect(o).toEqual({ level: null, model: null, skill: null })
  expect(mark(skillCase, o)).toBe('missed-skill')
})

test('skill：不该推荐却推荐了是 needless-skill', () => {
  const none: SkillCase = { ...skillCase, expect: { skill: null, alsoOk: [] } }
  const o = outcomeOf(none, firstOf(acting), START_BARS, { second: secondOf('code-review', [0.9, 0.1, 0.1]) })!
  expect(o.skill).toBe('code-review')
  expect(mark(none, o)).toBe('needless-skill')
})

test('skill：门槛按给的 bars 读（fits 的门槛高了就不推荐）；要第二次请求而没有它：不是答案', () => {
  const second = secondOf('code-review', [0.5, 0.1, 0.1])
  expect(outcomeOf(skillCase, firstOf(acting), START_BARS, { second })?.skill).toBe('code-review')
  const strict: Bars = { ...START_BARS, skill: { ...START_BARS.skill, fits: 0.6 } }
  expect(outcomeOf(skillCase, firstOf(acting), strict, { second })?.skill).toBe(null)
  expect(outcomeOf(skillCase, firstOf(acting), START_BARS)).toBe(null)
})

test('gridFor 按门槛给网格，conservativeFor 只有 no 取低的一端（修订 A3）', () => {
  const up = gridFor('submit.up')
  expect(up.length).toBe(10)
  expect(up[0]).toBe(0.5)
  expect(up.at(-1)).toBe(0.95)
  const no = gridFor('submit.no')
  expect(no.length).toBe(10)
  expect(no[0]).toBe(0.05)
  expect(no.at(-1)).toBe(0.5)
  expect(gridFor('skill.named').length).toBe(11)
  expect(gridFor('skill.named')[0]).toBe(0.3)
  expect(gridFor('skill.named').at(-1)).toBe(0.8)
  expect(gridFor('skill.fits').length).toBe(11)
  expect(gridFor('skill.fits')[0]).toBe(0.1)
  expect(gridFor('skill.fits').at(-1)).toBe(0.6)
  expect(gridFor('midrun.no')[3]).toBe(0.2)
  expect(conservativeFor('midrun.no')).toBe('low')
  expect(conservativeFor('agent.modelDown')).toBe('high')
  expect(conservativeFor('skill.action')).toBe('high')
})

test('sweep 只动一个门槛：submit.up 给出 10 行，value 从 0.5 到 0.95', () => {
  const stored = (id: string, variant: string): Stored | undefined => (id === 'submit-01' && variant === 'default' ? ok(submitAnswers) : undefined)
  const rows = sweep([submitCase], stored, START_BARS, 'submit.up')
  expect(rows.length).toBe(10)
  expect(rows[0]!.value).toBe(0.5)
  expect(rows.at(-1)!.value).toBe(0.95)
  for (const r of rows) {
    expect(r.right).toBe(1)
    expect(r.marks).toEqual({ 'submit-01': 'right' })
  }
  expect(() => sweep([submitCase], stored, START_BARS, 'submit.sideways')).toThrow()
})

test('sweep 读 skill 用例的两次请求', () => {
  const stored = (id: string, variant: string): Stored | undefined =>
    id !== 'skill-01' ? undefined : variant === 'stage-1' ? firstOf(acting) : variant === 'stage-2' ? secondOf('code-review', [0.45, 0.1, 0.1]) : undefined
  const rows = sweep([skillCase], stored, START_BARS, 'skill.fits')
  // fits 0.45 reaches the bar up to 0.45 and no further
  expect(rows.filter((r) => r.right === 1).map((r) => r.value)).toEqual([0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45])
  expect(rows.at(-1)!.marks).toEqual({ 'skill-01': 'missed-skill' })
})

test('plateau：对得最多的一段，high 取最大的值，low 取最小的', () => {
  const rows: Row[] = [3, 5, 5, 5, 4].map((right, i) => ({ value: [0.5, 0.55, 0.6, 0.65, 0.7][i]!, right, marks: {} }))
  expect(plateau(rows, 'high')).toEqual({ best: 5, from: 0.55, to: 0.65, pick: 0.65 })
  expect(plateau(rows, 'low')).toEqual({ best: 5, from: 0.55, to: 0.65, pick: 0.55 })
})
