import { expect, test } from 'claude-code/testing'
import type { Answer } from '../hooks/backend.ts'
import { readConfig } from '../hooks/config.ts'
import { START, submitLevel } from '../hooks/decide.ts'
import { settleSubmit } from '../hooks/submit.ts'
import { CHOSEN_BARS, START_BARS, mark, outcomeOf, shortlistOf } from '../eval/lib/read.ts'
import type { Bars, Stored } from '../eval/lib/read.ts'
import { conservativeFor, gridFor, plateau, ruledValue, sweep, valueAt } from '../eval/lib/sweep.ts'
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

test('CHOSEN_BARS 是选项的默认值（mod 不设选项时用的门槛），START_BARS 是起步值', () => {
  expect(CHOSEN_BARS).toEqual(readConfig({}).bars)
  expect(CHOSEN_BARS.agent).toEqual({ ...START, down: 0.95 })
  expect(START_BARS).toEqual({ submit: START, midrun: START, agent: START, skill: { action: 0.3, named: 0.5, fits: 0.3 } })
})

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

test('上一轮说「接着做」：沿用上一轮的档位，和 mod 一样', () => {
  const previous = { request: 'migrate the store', lastReply: 'Shall I go on?', ended: 'answered' as const, level: 'xhigh' as const }
  const c: SubmitCase = { ...submitCase, input: { ...submitCase.input, previous } }
  const flat = [0.2, 0.2, 0.2, 0.2, 0.2]
  expect(outcomeOf(c, ok({ open: score(flat), mechanical: n(0.1), unknown_cause: n(0.1), continues: n(0.9) }), START_BARS)?.level).toBe('xhigh')
  expect(outcomeOf(c, ok({ open: score(flat), mechanical: n(0.1), unknown_cause: n(0.1), continues: n(0.1) }), START_BARS)?.level).toBe('medium')
})

test('只说接着做（裁定 C38）：outcomeOf 的档位和 mod 的 settleSubmit 一样，沿用上一轮的档位', () => {
  const down = score([0.8, 0.14, 0.03, 0.02, 0.01])
  const up = score([0, 0.05, 0.1, 0.8, 0.05])
  const quiet = { mechanical: n(0.1), unknown_cause: n(0.1) }
  const rows: { previous: 'low' | 'xhigh' | null; answers: Record<string, Answer>; want: string }[] = [
    { previous: 'xhigh', answers: { open: down, ...quiet, continues: n(0.9) }, want: 'xhigh' },
    { previous: 'low', answers: { open: up, ...quiet, continues: n(0.9) }, want: 'low' },
    { previous: 'xhigh', answers: { open: down, ...quiet, continues: n(0.5) }, want: 'low' },
    { previous: null, answers: { open: down, ...quiet }, want: 'low' },
  ]
  for (const r of rows) {
    const previous = r.previous === null ? null : { request: 'migrate the store', lastReply: 'Shall I go on?', ended: 'answered' as const, level: r.previous }
    const c: SubmitCase = { ...submitCase, input: { ...submitCase.input, previous } }
    const mod = settleSubmit({ ok: true, answers: r.answers, model: 'drex-max-v1.1', backend: 'drex', ms: 1 }, { effort: c.input.base, previousLevel: r.previous, writes: true, turnId: 't', id: 'd', at: 0, bars: CHOSEN_BARS.submit })
    const level = outcomeOf(c, ok(r.answers), START_BARS)?.level
    expect([r.previous, level]).toEqual([r.previous, r.want])
    expect([r.previous, level]).toEqual([r.previous, mod.wanted])
  }
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

test("midrun 的 form 'direct'：升档和 midrunLevel 一样不超过 xhigh，已在 xhigh 以上不再升；降档照读", () => {
  const direct = (pick: string) => ok({ direct: choice(pick, { low: 0.02, medium: 0.03, high: 0.05, xhigh: 0.1, max: 0.8, [pick]: 0.8 }) })
  const at = (current: MidrunCase['input']['current'], pick: string) => outcomeOf({ ...midrunCase, input: { ...midrunCase.input, current } }, direct(pick), START_BARS, { form: 'direct' })?.level
  expect(at('medium', 'max')).toBe('xhigh')
  expect(at('xhigh', 'max')).toBe('xhigh')
  expect(at('max', 'max')).toBe('max')
  expect(at('medium', 'high')).toBe('high')
  expect(at('max', 'low')).toBe('low')
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

// Below the start bar (0.3) only: the action answers' mean is 0.25.
const borderline = { acts_on_user_system: n(0.25), would_follow_documented_procedure: n(0.25), prose_suffices: n(0.75), named: n(0.1) }
const skillCase2: SkillCase = { ...skillCase, id: 'skill-02' }

test('sweep 把 skill.action 降到初值以下：两次请求都有回答的用例每一行都在（unusable 为 0）', () => {
  const stored = (id: string, variant: string): Stored | undefined =>
    variant === 'stage-1' ? firstOf(id === 'skill-01' ? acting : borderline) : variant === 'stage-2' ? secondOf('code-review', [0.8, 0.1, 0.1]) : undefined
  const rows = sweep([skillCase, skillCase2], stored, START_BARS, 'skill.action')
  for (const r of rows) {
    expect(Object.keys(r.marks).sort()).toEqual(['skill-01', 'skill-02'])
    expect(r.unusable).toBe(0)
  }
  // skill-02 passes the gate only where the bar is at or below its mean
  expect(rows.filter((r) => r.marks['skill-02'] === 'right').map((r) => r.value)).toEqual([0.1, 0.15, 0.2, 0.25])
})

test('sweep：没有第二次请求的回答的用例记进 unusable，不是悄悄少一例', () => {
  const stored = (id: string, variant: string): Stored | undefined =>
    variant === 'stage-1' ? firstOf(id === 'skill-01' ? acting : borderline) : variant === 'stage-2' && id === 'skill-01' ? secondOf('code-review', [0.8, 0.1, 0.1]) : undefined
  const rows = sweep([skillCase, skillCase2], stored, START_BARS, 'skill.action')
  for (const r of rows) {
    const lets = r.value <= 0.25
    expect([r.value, r.unusable, r.marks['skill-02']]).toEqual([r.value, lets ? 1 : 0, lets ? undefined : 'missed-skill'])
    expect(r.marks['skill-01']).toBe('right')
  }
})

test('shortlistOf：第一次请求的回答给出的 short，和读第二次请求时用的是同一个', () => {
  const first = firstOf(acting)
  expect(first.ok && shortlistOf(first.answers).map((s) => s.name)).toEqual(['code-review', 'tdd', 'research'])
  // A tie at the cut: the second request asked about the list shortlistOf gives is read; one about the other tied name is not.
  const tied = { skill_0: choice('a', { a: 0.4, b: 0.2, c: 0.15, d: 0.15, other: 0.1 }), ...acting }
  const short = shortlistOf(tied).map((s) => s.name)
  expect(short.length).toBe(3)
  const second = (names: string[]): Stored =>
    ok({ which: choice('a', { ...Object.fromEntries(names.map((x) => [x, 0.1])), a: 0.7, other: 0.0 }), fits_0: n(0.8), fits_1: n(0.1), fits_2: n(0.1) })
  const other = ['a', 'b', short[2] === 'c' ? 'd' : 'c']
  const c: SkillCase = { ...skillCase, expect: { skill: 'a', alsoOk: [] } }
  expect(outcomeOf(c, ok(tied), START_BARS, { second: second(short) })?.skill).toBe('a')
  expect(outcomeOf(c, ok(tied), START_BARS, { second: second(other) })).toBe(null)
})

test('plateau：对得最多的一段，high 取最大的值，low 取最小的', () => {
  const rows: Row[] = [3, 5, 5, 5, 4].map((right, i) => ({ value: [0.5, 0.55, 0.6, 0.65, 0.7][i]!, right, unusable: 0, marks: {} }))
  expect(plateau(rows, 'high')).toEqual({ best: 5, from: 0.55, to: 0.65, pick: 0.65 })
  expect(plateau(rows, 'low')).toEqual({ best: 5, from: 0.55, to: 0.65, pick: 0.55 })
})

const rowsOf = (values: readonly number[], rights: readonly number[]): Row[] => values.map((value, i) => ({ value, right: rights[i]!, unusable: 0, marks: {} }))

test('ruledValue：最好的一段盖住整个网格，保留初值（修订 A14）', () => {
  const grid = gridFor('submit.up')
  expect(ruledValue(rowsOf(grid, grid.map(() => 4)), 'submit.up', 0.7)).toEqual({ value: 0.7, rule: 'A14' })
})

test('ruledValue：初值在最好的一段里，保留初值（修订 A15）；no 也一样', () => {
  const grid = gridFor('submit.up')
  // 0.50-0.60 score 3, 0.65-0.95 score 5: the start value 0.70 is inside.
  expect(ruledValue(rowsOf(grid, grid.map((v) => (v < 0.65 ? 3 : 5))), 'submit.up', 0.7)).toEqual({ value: 0.7, rule: 'A15' })
  const noGrid = gridFor('submit.no')
  expect(ruledValue(rowsOf(noGrid, noGrid.map((v) => (v > 0.4 ? 2 : 4))), 'submit.no', 0.3)).toEqual({ value: 0.3, rule: 'A15' })
  // Two stretches tie for best: the start value in either is kept.
  expect(ruledValue(rowsOf(grid, grid.map((v) => (v === 0.7 || v === 0.9 ? 5 : 3))), 'submit.up', 0.7)).toEqual({ value: 0.7, rule: 'A15' })
})

test('ruledValue：初值在最好的一段之外，取那一段保守的一端（修订 A3）', () => {
  const grid = gridFor('agent.down')
  // As agent.down on fit: 2 right from 0.50 to 0.75, 3 from 0.80 to 0.95; the start 0.70 is outside.
  expect(ruledValue(rowsOf(grid, grid.map((v) => (v < 0.8 ? 2 : 3))), 'agent.down', 0.7)).toEqual({ value: 0.95, rule: 'A3' })
  const noGrid = gridFor('midrun.no')
  expect(ruledValue(rowsOf(noGrid, noGrid.map((v) => (v >= 0.35 ? 5 : 4))), 'midrun.no', 0.3)).toEqual({ value: 0.35, rule: 'A3' })
})

test('valueAt：一个门槛在 Bars 里的值', () => {
  expect(valueAt(START_BARS, 'agent.modelDown')).toBe(START.modelDown)
  expect(valueAt(START_BARS, 'skill.named')).toBe(START_BARS.skill.named)
  expect(() => valueAt(START_BARS, 'agent.nope')).toThrow()
})
