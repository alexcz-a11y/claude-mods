import { expect, test } from 'claude-code/testing'
import { DIRECT_LEVEL, LONG_UNATTENDED, readDirect } from '../eval/lib/controls.ts'
import { VARIANTS, build } from '../eval/lib/request.ts'
import type { Variant } from '../eval/lib/request.ts'
import type { AgentCase, MidrunCase, SkillCase, SubmitCase } from '../eval/lib/case.ts'
import { agentQuestions, midrunQuestions, submitQuestions } from '../hooks/questions.ts'
import { stageOne } from '../hooks/skills.ts'
import { midrunState, submitState } from '../hooks/statebuild.ts'

const label = { by: 'model' as const, rationale: '只是改一个拼写。' }
const previous = { request: 'add a flag', lastReply: 'Added --dry-run.', ended: 'answered' as const, level: 'medium' as const }
const step = (n: number) => ({ did: `step ${n}`, tools: ['Bash'], ok: true, result: `result ${n}` })

const submitCase: SubmitCase = {
  id: 'submit-01', category: 'submit', source: 'written', difficulty: 'typical', set: 'fit', tags: [], label,
  input: { request: 'now add the same flag to the other command', previous, base: 'medium' },
  expect: { accept: ['medium'] },
}
const before = { done: 'read the failing test', remaining: 'find why it fails', cause_known: false }
const after = { done: 'found the race in the cache', remaining: 'fix it and rerun', cause_known: true }
const midrunCase: MidrunCase = {
  id: 'midrun-01', category: 'midrun', source: 'written', difficulty: 'typical', set: 'fit', tags: [], label,
  input: {
    request: 'make the flaky test pass', current: 'high', stepsSoFar: 6, failedSteps: 1,
    recent: [step(1), step(2), step(3), step(4)], latest: step(5), statedNext: 'add a lock around the cache', codeMode: false,
    notes: { before, after },
  },
  expect: { action: 'hold', accept: ['high'] },
}
const agentCase: AgentCase = {
  id: 'agent-01', category: 'agent', source: 'written', difficulty: 'typical', set: 'fit', tags: [], label,
  input: { task: 'list the files under hooks/', agentType: 'Explore', description: 'list hooks', inherit: { level: 'high', tier: 'opus' } },
  expect: { accept: ['low'], models: ['haiku'] },
}
const skillCase: SkillCase = {
  id: 'skill-01', category: 'skill', source: 'written', difficulty: 'typical', set: 'fit', tags: [], label,
  input: { request: 'review this branch since main', previous: null },
  expect: { skill: 'code-review', alsoOk: [] },
}
const skills = [
  { name: 'code-review', description: 'Review the changes since a fixed point.' },
  { name: 'tdd', description: 'Test-driven development.' },
  { name: 'diagnosing-bugs', description: 'Diagnosis loop for hard bugs.' },
  { name: 'grilling', description: 'Grill the user about a plan.' },
  { name: 'prototype', description: 'Build a throwaway prototype.' },
  { name: 'research', description: 'Investigate a question against primary sources.' },
]
const ctx = { skills }

function variant(category: keyof typeof VARIANTS, name: string): Variant {
  const v = VARIANTS[category].find((x) => x.name === name)
  if (v === undefined) throw new Error(`no variant ${name} for ${category}`)
  return v
}
const optionsOf = (q: unknown): string[] => Object.keys((q as { criteria: Record<string, unknown> }).criteria)

test('每一类登记的给法和名字；第一项是 default（skill 是 stage-1）', () => {
  expect(VARIANTS.submit.map((v) => v.name)).toEqual(['default', 'no-previous', 'direct-shuffled', 'with-skills'])
  expect(VARIANTS.midrun.map((v) => v.name)).toEqual(['default', 'recent-1', 'recent-3', 'no-stated-next', 'progress-before', 'progress-after', 'direct-shuffled'])
  expect(VARIANTS.agent.map((v) => v.name)).toEqual(['default', 'direct-shuffled'])
  expect(VARIANTS.skill.map((v) => v.name)).toEqual(['stage-1', 'stage-2', 'stage-1-shuffled', 'stage-2-shuffled'])
})

test('submit 的 default：state 和 mod 发的一样，题是 mod 的题加两道对照题', () => {
  const b = build(submitCase, variant('submit', 'default'), ctx)
  expect(b.caseId).toBe('submit-01')
  expect(b.variant).toBe('default')
  expect(b.state).toEqual(submitState({ request: submitCase.input.request, previous }))
  const own = submitQuestions(true)
  for (const [id, q] of Object.entries(own)) expect(b.questions[id]).toEqual(q)
  expect(b.questions.direct).toEqual(DIRECT_LEVEL)
  expect(b.questions.long_unattended).toEqual(LONG_UNATTENDED)
  expect(Object.keys(b.questions).length).toBe(Object.keys(own).length + 2)
})

test('submit 的 no-previous：没有 previous_turn，也没有 continues', () => {
  const b = build(submitCase, variant('submit', 'no-previous'), ctx)
  expect(b.state).toEqual(submitState({ request: submitCase.input.request, previous: null }))
  expect(b.questions.continues).toBe(undefined)
})

test('midrun 的 default：最近 5 条、带 stated_next、不带进展记录，对照题只问 direct', () => {
  const b = build(midrunCase, variant('midrun', 'default'), ctx)
  const i = midrunCase.input
  expect(b.state).toEqual({ ...midrunState({ ...i, progress: null }), stated_next: i.statedNext })
  expect(b.state.progress).toBe(undefined)
  for (const [id, q] of Object.entries(midrunQuestions())) expect(b.questions[id]).toEqual(q)
  expect(b.questions.direct).toEqual(DIRECT_LEVEL)
  expect(b.questions.long_unattended).toBe(undefined)
})

test('midrunState 不再放 stated_next；statedNext: true 的给法照原来的位置和截法加上', () => {
  const i = midrunCase.input
  // The case's input carries statedNext; midrunState leaves it out whatever it is given.
  const plain = midrunState({ ...i, progress: after })
  expect('stated_next' in plain).toBe(false)
  const withIt = build(midrunCase, { name: 'x', statedNext: true, progress: 'after' }, ctx)
  expect(withIt.state.stated_next).toBe('add a lock around the cache')
  // Where midrunState used to put it: after latest, before progress.
  expect(Object.keys(withIt.state)).toEqual(['note', 'request', 'current_level', 'steps_so_far', 'failed_steps', 'recent', 'latest', 'stated_next', 'progress'])
  expect('stated_next' in build(midrunCase, { name: 'x' }, ctx).state).toBe(false)
})

test('midrun 的 recent-1 只给最近 1 条，no-stated-next 没有 stated_next', () => {
  expect((build(midrunCase, variant('midrun', 'recent-1'), ctx).state.recent as unknown[]).length).toBe(1)
  expect((build(midrunCase, variant('midrun', 'recent-3'), ctx).state.recent as unknown[]).length).toBe(3)
  expect(build(midrunCase, variant('midrun', 'no-stated-next'), ctx).state.stated_next).toBe(undefined)
})

test('midrun 的进展记录：progress-before 取 notes.before，progress-after 取 notes.after', () => {
  expect(build(midrunCase, variant('midrun', 'progress-before'), ctx).state.progress).toEqual(before)
  expect(build(midrunCase, variant('midrun', 'progress-after'), ctx).state.progress).toEqual(after)
})

test('agent 的 default：mod 的题加两道对照题', () => {
  const b = build(agentCase, variant('agent', 'default'), ctx)
  for (const [id, q] of Object.entries(agentQuestions())) expect(b.questions[id]).toEqual(q)
  expect(b.questions.direct).toEqual(DIRECT_LEVEL)
  expect(b.questions.long_unattended).toEqual(LONG_UNATTENDED)
})

test('同一用例同一给法两次 build 的 hash 相同，改一个字就不同', () => {
  const v = variant('submit', 'default')
  const a = build(submitCase, v, ctx)
  expect(build(submitCase, v, ctx).hash).toBe(a.hash)
  expect(a.hash).toMatch(/^[0-9a-f]{16}$/)
  const changed = build({ ...submitCase, input: { ...submitCase.input, request: submitCase.input.request.replace('flag', 'flog') } }, v, ctx)
  expect(changed.hash === a.hash).toBe(false)
})

test('skill 的 stage-1 是 mod 第一次请求的题；stage-2 要给 short', () => {
  const b = build(skillCase, variant('skill', 'stage-1'), ctx)
  expect(b.questions).toEqual(stageOne(skills, 'drex', true))
  expect(b.state).toEqual(submitState({ request: skillCase.input.request, previous: null }))
  const two = build(skillCase, variant('skill', 'stage-2'), { skills, short: skills.slice(0, 3) })
  expect(optionsOf(two.questions.which)).toEqual(['code-review', 'tdd', 'diagnosing-bugs', 'other'])
  expect(() => build(skillCase, variant('skill', 'stage-2'), ctx)).toThrow()
})

test('stage-1-shuffled 的选项集合和 stage-1 相同而顺序不同，other 仍在最后', () => {
  const plain = optionsOf(build(skillCase, variant('skill', 'stage-1'), ctx).questions.skill_0)
  const shuffled = optionsOf(build(skillCase, variant('skill', 'stage-1-shuffled'), ctx).questions.skill_0)
  expect([...shuffled].sort()).toEqual([...plain].sort())
  expect(shuffled.join() === plain.join()).toBe(false)
  expect(shuffled.at(-1)).toBe('other')
  // the same seed gives the same order
  expect(optionsOf(build(skillCase, variant('skill', 'stage-1-shuffled'), ctx).questions.skill_0)).toEqual(shuffled)
})

test('direct-shuffled（修订 A13）：只有 direct 的选项换了顺序，其余题和 state 与 default 相同', () => {
  for (const c of [submitCase, midrunCase, agentCase]) {
    const plain = build(c, variant(c.category, 'default'), ctx)
    const shuffled = build(c, variant(c.category, 'direct-shuffled'), ctx)
    expect(shuffled.state).toEqual(plain.state)
    const a = optionsOf(plain.questions.direct)
    const b = optionsOf(shuffled.questions.direct)
    expect([...b].sort()).toEqual([...a].sort())
    expect(b.join() === a.join()).toBe(false)
    expect(Object.keys(shuffled.questions)).toEqual(Object.keys(plain.questions))
    for (const id of Object.keys(plain.questions)) if (id !== 'direct') expect(shuffled.questions[id]).toEqual(plain.questions[id])
  }
})

test('submit、midrun、agent 的每一种给法都带对照题：题号和这一类的 default 相同（no-previous 只少 continues）', () => {
  for (const c of [submitCase, midrunCase, agentCase]) {
    const ids = Object.keys(build(c, variant(c.category, 'default'), ctx).questions).sort()
    for (const v of VARIANTS[c.category]) {
      if (v.name === 'with-skills') continue
      const got = Object.keys(build(c, v, ctx).questions).sort()
      // The mod asks continues only when there is a previous turn to go on from.
      const want = v.name === 'no-previous' ? ids.filter((id) => id !== 'continues') : ids
      expect([c.category, v.name, got]).toEqual([c.category, v.name, want])
    }
  }
})

test('submit 的 with-skills：default 的题加上 mod 为 skill 加的第一次请求的题，state 和 default 相同', () => {
  const plain = build(submitCase, variant('submit', 'default'), ctx)
  const b = build(submitCase, variant('submit', 'with-skills'), ctx)
  expect(b.state).toEqual(plain.state)
  expect(b.questions).toEqual({ ...plain.questions, ...stageOne(skills, 'drex', true) })
  expect(b.hash === plain.hash).toBe(false)
})

test('readDirect：选中项不低于 0.5 取它，否则取概率最高两项里较低的一档', () => {
  const choice = (choice: string, probabilities: Record<string, number>) => ({ type: 'choice' as const, choice, probabilities })
  expect(readDirect(choice('high', { low: 0.02, medium: 0.3, high: 0.6, xhigh: 0.05, max: 0.03 }))).toBe('high')
  expect(readDirect(choice('high', { low: 0.05, medium: 0.4, high: 0.45, xhigh: 0.07, max: 0.03 }))).toBe('medium')
  expect(readDirect(choice('medium', { low: 0.05, medium: 0.45, high: 0.4, xhigh: 0.07, max: 0.03 }))).toBe('medium')
  expect(readDirect(undefined)).toBe(null)
  expect(readDirect({ type: 'noul', noul: 0.9 })).toBe(null)
})
