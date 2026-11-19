import { expect, test } from 'claude-code/testing'
import { DIRECT_LEVEL, LONG_UNATTENDED, OPEN_LEVELS_B, readDirect } from '../eval/lib/controls.ts'
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
  expect(VARIANTS.submit.map((v) => v.name)).toEqual(['default', 'with-controls', 'no-previous', 'direct-shuffled', 'with-skills', 'open-b'])
  expect(VARIANTS.midrun.map((v) => v.name)).toEqual([
    'default', 'with-controls', 'recent-1', 'recent-3', 'progress-before', 'progress-after',
    'recent-1-with-controls', 'recent-3-with-controls', 'no-stated-next-with-controls', 'direct-shuffled', 'open-b',
  ])
  expect(VARIANTS.agent.map((v) => v.name)).toEqual(['default', 'with-controls', 'direct-shuffled', 'open-b'])
  expect(VARIANTS.skill.map((v) => v.name)).toEqual(['stage-1', 'stage-2', 'stage-1-alone', 'stage-2-alone', 'stage-1-shuffled', 'stage-2-shuffled'])
})

const CONTROLS = ['direct', 'long_unattended']
const noControl = (qs: Record<string, unknown>): boolean => CONTROLS.every((id) => !(id in qs))

test('submit 的 default（修订 A16）：和 mod 发的请求逐题相同，档位题加 skill 第一次请求的题，没有对照题', () => {
  const b = build(submitCase, variant('submit', 'default'), ctx)
  expect(b.caseId).toBe('submit-01')
  expect(b.variant).toBe('default')
  expect(b.state).toEqual(submitState({ request: submitCase.input.request, previous }))
  // Merged as hooks/flows/submit.ts merges them: the level's questions first, the skill questions after.
  const mod = { ...submitQuestions(true), ...stageOne(skills, 'drex', true) }
  expect(Object.keys(b.questions)).toEqual(Object.keys(mod))
  expect(b.questions).toEqual(mod)
  expect(noControl(b.questions)).toBe(true)
  // Asked as the mod asks it when skill questions ride along: an unusable part leaves the other standing.
  expect(b.partial).toBe(true)
})

test('submit 的 default 在没有候选 skill 时只有档位题，不按 partial 问', () => {
  const b = build(submitCase, variant('submit', 'default'), { skills: [] })
  expect(Object.keys(b.questions)).toEqual(Object.keys(submitQuestions(true)))
  expect(b.partial).toBe(false)
})

test('submit 的 with-controls：原来的 default，mod 的档位题加两道对照题，没有 skill 题', () => {
  const b = build(submitCase, variant('submit', 'with-controls'), ctx)
  expect(b.state).toEqual(submitState({ request: submitCase.input.request, previous }))
  const own = submitQuestions(true)
  for (const [id, q] of Object.entries(own)) expect(b.questions[id]).toEqual(q)
  expect(b.questions.direct).toEqual(DIRECT_LEVEL)
  expect(b.questions.long_unattended).toEqual(LONG_UNATTENDED)
  expect(Object.keys(b.questions).length).toBe(Object.keys(own).length + 2)
  expect(b.partial).toBe(false)
})

test('submit 的 no-previous：没有 previous_turn，也没有 continues', () => {
  const b = build(submitCase, variant('submit', 'no-previous'), ctx)
  expect(b.state).toEqual(submitState({ request: submitCase.input.request, previous: null }))
  expect(b.questions.continues).toBe(undefined)
})

test('midrun 的 default（修订 A16）：只有 mod 的题，state 是 midrunState 的（最近 5 条，没有 stated_next，不带进展记录）', () => {
  const b = build(midrunCase, variant('midrun', 'default'), ctx)
  const i = midrunCase.input
  expect(b.state).toEqual(midrunState({ ...i, progress: null }))
  expect('stated_next' in b.state).toBe(false)
  expect(b.state.progress).toBe(undefined)
  expect(Object.keys(b.questions)).toEqual(Object.keys(midrunQuestions()))
  expect(b.questions).toEqual(midrunQuestions())
})

test('midrun 的 with-controls：原来的 default，带 stated_next，对照题只问 direct', () => {
  const b = build(midrunCase, variant('midrun', 'with-controls'), ctx)
  const i = midrunCase.input
  expect(b.state).toEqual({ ...midrunState({ ...i, progress: null }), stated_next: i.statedNext })
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

test('midrun 的 recent-1、recent-3 是新 default 少给几条；带 -with-controls 的是原来的请求', () => {
  const plain = build(midrunCase, variant('midrun', 'default'), ctx)
  for (const [name, n] of [['recent-1', 1], ['recent-3', 3]] as const) {
    const b = build(midrunCase, variant('midrun', name), ctx)
    expect((b.state.recent as unknown[]).length).toBe(n)
    expect('stated_next' in b.state).toBe(false)
    expect(b.questions).toEqual(plain.questions)
    const old = build(midrunCase, variant('midrun', name + '-with-controls'), ctx)
    expect((old.state.recent as unknown[]).length).toBe(n)
    expect(old.state.stated_next).toBe(midrunCase.input.statedNext)
    expect(old.questions.direct).toEqual(DIRECT_LEVEL)
  }
  const noNext = build(midrunCase, variant('midrun', 'no-stated-next-with-controls'), ctx)
  expect('stated_next' in noNext.state).toBe(false)
  expect(noNext.questions.direct).toEqual(DIRECT_LEVEL)
})

test('midrun 的进展记录：progress-before 取 notes.before，progress-after 取 notes.after，其余和新 default 相同', () => {
  const plain = build(midrunCase, variant('midrun', 'default'), ctx)
  const b = build(midrunCase, variant('midrun', 'progress-before'), ctx)
  expect(b.state.progress).toEqual(before)
  expect(build(midrunCase, variant('midrun', 'progress-after'), ctx).state.progress).toEqual(after)
  expect({ ...b.state, progress: undefined }).toEqual({ ...plain.state, progress: undefined })
  expect(b.questions).toEqual(plain.questions)
})

test('agent 的 default（修订 A16）：只有 mod 的题', () => {
  const b = build(agentCase, variant('agent', 'default'), ctx)
  expect(Object.keys(b.questions)).toEqual(Object.keys(agentQuestions()))
  expect(b.questions).toEqual(agentQuestions())
})

test('agent 的 with-controls：原来的 default，mod 的题加两道对照题', () => {
  const b = build(agentCase, variant('agent', 'with-controls'), ctx)
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

test('skill 的 stage-1（修订 A16）：mod 一条消息两件事都问时的请求，档位题加 skill 的题；和同样输入的 submit default 是同一个请求', () => {
  const b = build(skillCase, variant('skill', 'stage-1'), ctx)
  expect(b.questions).toEqual({ ...submitQuestions(false), ...stageOne(skills, 'drex', true) })
  expect(noControl(b.questions)).toBe(true)
  expect(b.state).toEqual(submitState({ request: skillCase.input.request, previous: null }))
  expect(b.partial).toBe(true)
  const asSubmit: SubmitCase = { ...submitCase, input: { request: skillCase.input.request, previous: null, base: 'medium' } }
  const s = build(asSubmit, variant('submit', 'default'), ctx)
  expect(s.hash).toBe(b.hash)
  expect([s.state, s.questions, s.partial]).toEqual([b.state, b.questions, b.partial])
})

test('skill 的 stage-1-alone 是原来的 stage-1，只有 skill 第一次请求的题；stage-2 要给 short', () => {
  const b = build(skillCase, variant('skill', 'stage-1-alone'), ctx)
  expect(b.questions).toEqual(stageOne(skills, 'drex', true))
  expect(b.state).toEqual(submitState({ request: skillCase.input.request, previous: null }))
  expect(b.partial).toBe(false)
  const two = build(skillCase, variant('skill', 'stage-2'), { skills, short: skills.slice(0, 3) })
  expect(optionsOf(two.questions.which)).toEqual(['code-review', 'tdd', 'diagnosing-bugs', 'other'])
  expect(() => build(skillCase, variant('skill', 'stage-2'), ctx)).toThrow()
})

test('stage-1-shuffled 的选项集合和 stage-1-alone 相同而顺序不同，other 仍在最后', () => {
  const alone = build(skillCase, variant('skill', 'stage-1-alone'), ctx)
  expect(Object.keys(build(skillCase, variant('skill', 'stage-1-shuffled'), ctx).questions)).toEqual(Object.keys(alone.questions))
  const plain = optionsOf(alone.questions.skill_0)
  const shuffled = optionsOf(build(skillCase, variant('skill', 'stage-1-shuffled'), ctx).questions.skill_0)
  expect([...shuffled].sort()).toEqual([...plain].sort())
  expect(shuffled.join() === plain.join()).toBe(false)
  expect(shuffled.at(-1)).toBe('other')
  // the same seed gives the same order
  expect(optionsOf(build(skillCase, variant('skill', 'stage-1-shuffled'), ctx).questions.skill_0)).toEqual(shuffled)
})

test('direct-shuffled（修订 A13）：只有 direct 的选项换了顺序，其余题和 state 与 with-controls 相同', () => {
  for (const c of [submitCase, midrunCase, agentCase]) {
    const plain = build(c, variant(c.category, 'with-controls'), ctx)
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

test('submit、midrun、agent：带对照题的给法题号和 with-controls 相同（no-previous 只少 continues），其余和 default 相同', () => {
  const withControls = ['with-controls', 'no-previous', 'direct-shuffled', 'recent-1-with-controls', 'recent-3-with-controls', 'no-stated-next-with-controls']
  for (const c of [submitCase, midrunCase, agentCase]) {
    const idsOf = (name: string): string[] => Object.keys(build(c, variant(c.category, name), ctx).questions).sort()
    for (const v of VARIANTS[c.category]) {
      if (v.name === 'with-skills') continue
      const got = Object.keys(build(c, v, ctx).questions).sort()
      const ids = idsOf(withControls.includes(v.name) ? 'with-controls' : 'default')
      // The mod asks continues only when there is a previous turn to go on from.
      const want = v.name === 'no-previous' ? ids.filter((id) => id !== 'continues') : ids
      expect([c.category, v.name, got]).toEqual([c.category, v.name, want])
    }
  }
})

test('submit 的 with-skills：with-controls 的题加上 mod 为 skill 加的第一次请求的题，state 相同，照旧不按 partial 问', () => {
  const plain = build(submitCase, variant('submit', 'with-controls'), ctx)
  const b = build(submitCase, variant('submit', 'with-skills'), ctx)
  expect(b.state).toEqual(plain.state)
  expect(b.questions).toEqual({ ...plain.questions, ...stageOne(skills, 'drex', true) })
  expect(b.hash === plain.hash).toBe(false)
  expect(b.partial).toBe(false)
})

test('open-b：和 default 只差 open 的 criteria，换成 OPEN_LEVELS_B（同一题号、同一说明，其余题和 state 不变）', () => {
  for (const c of [submitCase, midrunCase, agentCase]) {
    const plain = build(c, variant(c.category, 'default'), ctx)
    const b = build(c, variant(c.category, 'open-b'), ctx)
    expect(b.state).toEqual(plain.state)
    expect(b.partial).toBe(plain.partial)
    expect(Object.keys(b.questions)).toEqual(Object.keys(plain.questions))
    expect(b.questions.open).toEqual({ ...plain.questions.open!, criteria: OPEN_LEVELS_B })
    expect(b.questions.open!.criteria).toEqual(OPEN_LEVELS_B)
    for (const id of Object.keys(plain.questions)) if (id !== 'open') expect(b.questions[id]).toEqual(plain.questions[id])
  }
})

test('readDirect：选中项不低于 0.5 取它，否则取概率最高两项里较低的一档', () => {
  const choice = (choice: string, probabilities: Record<string, number>) => ({ type: 'choice' as const, choice, probabilities })
  expect(readDirect(choice('high', { low: 0.02, medium: 0.3, high: 0.6, xhigh: 0.05, max: 0.03 }))).toBe('high')
  expect(readDirect(choice('high', { low: 0.05, medium: 0.4, high: 0.45, xhigh: 0.07, max: 0.03 }))).toBe('medium')
  expect(readDirect(choice('medium', { low: 0.05, medium: 0.45, high: 0.4, xhigh: 0.07, max: 0.03 }))).toBe('medium')
  expect(readDirect(undefined)).toBe(null)
  expect(readDirect({ type: 'noul', noul: 0.9 })).toBe(null)
})
