// The dispatched-agent decision module's own interface: what the eval (#15)
// imports to build, from an item of subagent.jsonl, the request the mod sends
// at agent.spawn, and to read the answers the way the mod does; and what the
// Workflow rewriter (#8) reuses for each agent() of a script. Pure, no `$`.

import { expect, test } from 'claude-code/testing'
import { estimateTokens } from '../hooks/decision/context.ts'
import { AGENT_MODELS, decideDispatch, dispatchBrief, dispatchPart, dispatchReason, dispatchState, mentionsEffort, type Dispatch } from '../hooks/decision/dispatched-agent.ts'
import { mergeParts, QUESTION_ID, type Answer } from '../hooks/decision/system-one.ts'

/** subagent.jsonl's item shape (`zh`). */
const REVIEW: Dispatch = {
  user_message: '这个改动涉及权限判断，帮我认真审一下',
  kind: 'agent',
  agent_type: 'general-purpose',
  description: '审查权限改动',
  prompt: '审查当前分支相对 main 的 diff（约 30 行，改了 src/policies/document.ts 的 canEdit 和 canShare），列出权限扩大的边界情况和触发条件。',
  requested_model: 'opus',
  workflow_description: null,
  label: null,
}

function choice(probabilities: Record<string, number>): Answer {
  const [top = ''] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] ?? []
  return { type: 'choice', choice: top, probabilities, confidence: null }
}

function score(levels: readonly number[]): Answer {
  return { type: 'score', score: 0, probabilities: Object.fromEntries(levels.map((p, i) => [String(i), p])), confidence: null }
}

function noul(p: number): Answer {
  return { type: 'noul', noul: p }
}

const SETTINGS = { thetaOverride: 0.6, thetaMax: 0.5 }

test("the state about one agent: its brief first, then the person's words; secrets masked; the words take at most a third of the budget, cut keeping their end", () => {
  const item: Dispatch = {
    ...REVIEW,
    user_message: `${'这个改动涉及权限判断，'.repeat(200)}最后用 opus 审`,
    description: 'Review with key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx',
    prompt: `${'Check each policy rule against the new same-department rule. '.repeat(200)}Report the findings as a table.`,
  }
  const state = dispatchState(item, 900)
  const brief = state.brief as Record<string, string>
  const words = state.user_message as string

  expect(Object.keys(state)).toEqual(['brief', 'user_message'])
  expect(Object.keys(brief)).toEqual(['description', 'agent_type', 'prompt'])
  expect(brief.description).toBe('Review with key [REDACTED]')
  expect(estimateTokens(words)).toBeLessThanOrEqual(300)
  expect(words.endsWith('最后用 opus 审')).toBe(true)
  expect(brief.prompt?.endsWith('Report the findings as a table.')).toBe(true)
  const total = [words, ...Object.values(brief)].reduce((sum, text) => sum + estimateTokens(text), 0)
  expect(total).toBeLessThanOrEqual(900)
})

test("a workflow's agent: the workflow's description and the agent()'s label join its brief, before its prompt", () => {
  const item: Dispatch = {
    user_message: 'utils.ts 太大了要拆，你看着办',
    kind: 'workflow',
    agent_type: null,
    description: null,
    prompt: '按下面的映射表更新 ${dir} 下所有文件的 import，不要改其他代码。',
    requested_model: 'sonnet',
    workflow_description: '把 src/lib/utils.ts 按领域拆成几个模块',
    label: 'update-imports:${dir}',
  }
  const brief = dispatchState(item, 2000).brief as Record<string, string>

  expect(brief).toEqual({
    workflow_description: '把 src/lib/utils.ts 按领域拆成几个模块',
    label: 'update-imports:${dir}',
    prompt: '按下面的映射表更新 ${dir} 下所有文件的 import，不要改其他代码。',
  })
})

test('eval variables: options named by the kind of work (read back as models), the questions in Chinese, effort as a Choice', () => {
  const shape = { models: AGENT_MODELS, ask: { options: 'work' as const, language: 'zh' as const, primitive: 'choice' as const } }
  const part = dispatchPart(REVIEW, shape)
  const model = part.questions.model

  expect(model?.type === 'choice' && Object.keys(model.criteria)).toEqual(['read_and_report', 'specified_work', 'judgment_work', 'frontier_work'])
  expect(JSON.stringify(model?.instructions)).toMatch(/最便宜/)
  // The hint names the main agent's pick by its option.
  expect(JSON.stringify(model?.instructions)).toContain('judgment_work')
  expect(part.questions.effort?.type).toBe('choice')

  // Of four options p 0.8 is confidence 0.73: sure enough to replace opus.
  const answers = { model: choice({ read_and_report: 0.05, specified_work: 0.05, judgment_work: 0.1, frontier_work: 0.8 }), effort: choice({ low: 0, medium: 0, high: 0.2, xhigh: 0.8, max: 0 }) }
  expect(decideDispatch(answers, REVIEW, { ...shape, ...SETTINGS })).toMatchObject({ model: 'fable', effort: 'xhigh', source: 'decided' })
})

test('several agents can share one request: each has its own part name and brief field (the Workflow rewriter, #8)', () => {
  const search: Dispatch = { ...REVIEW, description: '查找 legacyAuth 引用', prompt: '找出仓库中所有对 legacyAuth 的引用，只汇报。', requested_model: null }
  const first = dispatchPart(REVIEW, { part: 'agent-0', field: 'brief_0' })
  const second = dispatchPart(search, { part: 'agent-1', field: 'brief_1' })
  const request = mergeParts({ brief_0: dispatchBrief(REVIEW, 600), brief_1: dispatchBrief(search, 600), user_message: REVIEW.user_message }, [first, second])

  expect(Object.keys(request.questions)).toEqual(['agent-0.model', 'agent-0.effort', 'agent-1.model', 'agent-1.effort'])
  expect(JSON.stringify(request.questions['agent-1.model']?.instructions)).toContain('`brief_1.prompt`')
  for (const id of Object.keys(request.questions)) expect(QUESTION_ID.test(id)).toBe(true)
})

test('the person naming and ruling out models: the thresholds are settings; a ruled-out pick of the main agent goes; with every option ruled out nothing is decided', () => {
  const item = { ...REVIEW, user_message: '别用 haiku、sonnet 和 opus 了' }
  const effort = score([0, 0, 1, 0, 0])
  // A named answer of 0.6 counts at the default 0.5, not at 0.7.
  const named = { model: choice({ haiku: 0.1, sonnet: 0.1, opus: 0.8 }), effort, 'named.sonnet': noul(0.6) }
  expect(decideDispatch(named, item, SETTINGS).model).toBe('sonnet')
  expect(decideDispatch(named, item, { ...SETTINGS, thetaNamed: 0.7 }).model).toBe('opus')

  const all = { model: choice({ haiku: 0.2, sonnet: 0.3, opus: 0.5 }), effort, 'banned.haiku': noul(0.9), 'banned.sonnet': noul(0.9), 'banned.opus': noul(0.9) }
  expect(decideDispatch(all, item, SETTINGS)).toMatchObject({ model: null, source: 'none', pick: null, banned: ['haiku', 'sonnet', 'opus'] })
  // The main agent asked for a model nobody ruled out: it stands.
  expect(decideDispatch(all, { ...item, requested_model: 'fable' }, SETTINGS)).toMatchObject({ model: 'fable', source: 'requested', effort: 'high' })
})

test("a model ruled out is in no branch the one the agent ends on: with no probability left on the others the nearest one to the answer's choice (a tie to the cheaper), else to the main agent's pick, takes its place; with none left nothing is decided", () => {
  const effort = score([0, 0, 1, 0, 0])
  const out = (model: Record<string, number> | null, banned: string[], item: Dispatch = { ...REVIEW, requested_model: null }) =>
    decideDispatch({ ...(model === null ? {} : { model: choice(model) }), effort, ...Object.fromEntries(banned.map((m) => [`banned.${m}`, noul(0.9)])) }, item, SETTINGS)

  // Everything on opus, opus ruled out: sonnet is the nearest left; the answer is no confident one.
  expect(out({ haiku: 0, sonnet: 0, opus: 1 }, ['opus'])).toMatchObject({ model: 'sonnet', source: 'decided', pick: { model: 'sonnet', confidence: 0, nearest: true } })
  // Everything on sonnet, sonnet ruled out: haiku and opus are as near; the cheaper.
  expect(out({ haiku: 0, sonnet: 1, opus: 0 }, ['sonnet'])).toMatchObject({ model: 'haiku' })
  // Even asked for by the main agent, and even with the answer lacking altogether (only the effort was answered).
  expect(out({ haiku: 0, sonnet: 0, opus: 1 }, ['opus'], REVIEW)).toMatchObject({ model: 'sonnet', source: 'decided' })
  expect(out(null, ['opus'], REVIEW)).toMatchObject({ model: 'sonnet', source: 'decided' })
  // Some probability left on the others: the most probable of them, as before.
  expect(out({ haiku: 0.1, sonnet: 0, opus: 0.9 }, ['opus'])).toMatchObject({ model: 'haiku', pick: { confidence: 1 } })
  // Nothing ruled out and no model answer: the engine's choice stands.
  expect(out(null, [])).toMatchObject({ model: null, source: 'none' })
  expect(out({ haiku: 0, sonnet: 0, opus: 0 }, [])).toMatchObject({ model: null, source: 'none' })
})

test("an effort the person names: asked only when their words may name one; the level the answer favours, when it beats none and reaches 0.5; haiku takes none", () => {
  expect(mentionsEffort('用 sonnet、effort 开 low 跑就行')).toBe(true)
  expect(mentionsEffort('all agents at extra high please')).toBe(true)
  expect(mentionsEffort('推理强度拉满')).toBe(true)
  expect(mentionsEffort('给 utils/date.ts 补几个边界情况的单测')).toBe(false)
  // "think" and "reason" alone are everyday words: only a way of asking for more thought counts.
  expect(mentionsEffort('I think the cache is stale; find the reason it never refreshes')).toBe(false)
  expect(mentionsEffort('Is this a reasonable fix? Rethink the retry loop if not.')).toBe(false)
  expect(mentionsEffort('think hard about the locking before you touch it')).toBe(true)
  expect(mentionsEffort('give the review agent more reasoning, the diff is subtle')).toBe(true)
  expect(mentionsEffort('ultrathink this one')).toBe(true)
  const part = dispatchPart({ ...REVIEW, user_message: '这次所有 agent 的 effort 都开 high' })
  const question = part.questions.named_effort
  expect(question?.type === 'choice' && Object.keys(question.criteria)).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  expect(Object.keys(dispatchPart(REVIEW).questions)).not.toContain('named_effort')

  const sonnet = choice({ haiku: 0, sonnet: 1, opus: 0 })
  const effort = score([0, 0, 0, 1, 0])
  const sure = decideDispatch({ model: sonnet, effort, named_effort: choice({ none: 0.05, low: 0.9, medium: 0.05 }) }, REVIEW, SETTINGS)
  expect(sure).toMatchObject({ model: 'sonnet', effort: 'low', namedEffort: 'low', effortSource: 'user' })
  // Unsure (0.4), or none the most probable: the decided effort stands.
  expect(decideDispatch({ model: sonnet, effort, named_effort: choice({ none: 0.3, low: 0.4, medium: 0.3 }) }, REVIEW, SETTINGS)).toMatchObject({ effort: 'xhigh', namedEffort: null, effortSource: 'decided' })
  expect(decideDispatch({ model: sonnet, effort, named_effort: choice({ none: 0.6, low: 0.4 }) }, REVIEW, SETTINGS)).toMatchObject({ effort: 'xhigh', namedEffort: null })
  // The threshold is thetaNamed, as for a model.
  expect(decideDispatch({ model: sonnet, effort, named_effort: choice({ none: 0.1, low: 0.6, medium: 0.3 }) }, REVIEW, { ...SETTINGS, thetaNamed: 0.7 })).toMatchObject({ effort: 'xhigh', namedEffort: null })
  // Without an effort answer the named level still stands; on haiku it cannot be set.
  expect(decideDispatch({ model: sonnet, named_effort: choice({ none: 0, max: 1 }) }, REVIEW, SETTINGS)).toMatchObject({ effort: 'max', effortSource: 'user' })
  const haiku = decideDispatch({ model: choice({ haiku: 1, sonnet: 0, opus: 0 }), effort, named_effort: choice({ none: 0, high: 1 }), 'named.haiku': noul(0.9) }, { ...REVIEW, requested_model: null }, SETTINGS)
  expect(haiku).toMatchObject({ model: 'haiku', effort: null, namedEffort: 'high', effortSource: 'none' })
})

test("a model's effort floor (AA: sonnet's scores fall steeply with effort): sonnet goes at high at least, at medium when low has 0.8; opus at medium at least; haiku takes none; the person's effort is never lifted", () => {
  const as = (model: 'haiku' | 'sonnet' | 'opus' | 'fable', levels: number[], more: Record<string, Answer> = {}) =>
    decideDispatch({ model: choice({ [model]: 1 }), effort: score(levels), ...more }, { ...REVIEW, requested_model: null }, { ...SETTINGS, models: AGENT_MODELS })
  // Sonnet: low, or low with a medium raised to at least high.
  expect(as('sonnet', [0.5, 0.5, 0, 0, 0])).toMatchObject({ model: 'sonnet', effort: 'high', liftedFrom: 'medium' })
  expect(as('sonnet', [0.7, 0.3, 0, 0, 0])).toMatchObject({ effort: 'high', liftedFrom: 'medium' })
  expect(as('sonnet', [0, 1, 0, 0, 0])).toMatchObject({ effort: 'high', liftedFrom: 'medium' })
  // Low has 0.8 (or more): medium is the floor.
  expect(as('sonnet', [0.8, 0.2, 0, 0, 0])).toMatchObject({ effort: 'medium', liftedFrom: 'low' })
  expect(as('sonnet', [1, 0, 0, 0, 0])).toMatchObject({ effort: 'medium', liftedFrom: 'low' })
  expect(as('sonnet', [0.79, 0.21, 0, 0, 0])).toMatchObject({ effort: 'high' })
  // Not lifted when already there or above.
  expect(as('sonnet', [0, 0, 1, 0, 0])).toMatchObject({ effort: 'high' })
  expect(as('sonnet', [0, 0, 0, 1, 0]).liftedFrom).toBeUndefined()
  expect(as('sonnet', [0, 0, 0, 1, 0])).toMatchObject({ effort: 'xhigh' })
  // Opus: medium at least.
  expect(as('opus', [1, 0, 0, 0, 0])).toMatchObject({ model: 'opus', effort: 'medium', liftedFrom: 'low' })
  expect(as('opus', [0, 1, 0, 0, 0])).toMatchObject({ effort: 'medium' })
  expect(as('opus', [0, 0, 1, 0, 0])).toMatchObject({ effort: 'high' })
  // Haiku takes no effort; fable has no floor.
  expect(as('haiku', [1, 0, 0, 0, 0])).toMatchObject({ model: 'haiku', effort: null })
  expect(as('fable', [1, 0, 0, 0, 0])).toMatchObject({ model: 'fable', effort: 'low' })
  // An effort the person names is theirs: no floor lifts it.
  const low = { named_effort: choice({ none: 0.05, low: 0.9, medium: 0.05 }) }
  expect(as('sonnet', [0, 0, 0, 1, 0], low)).toMatchObject({ effort: 'low', effortSource: 'user' })
  expect(as('opus', [0, 0, 0, 1, 0], low)).toMatchObject({ effort: 'low', effortSource: 'user' })
  expect(as('sonnet', [0, 0, 0, 1, 0], low).liftedFrom).toBeUndefined()
  // The person naming the model does not lift the effort of its own decision less than the floor says.
  expect(decideDispatch({ model: choice({ haiku: 1 }), effort: score([1, 0, 0, 0, 0]), 'named.sonnet': noul(0.9) }, { ...REVIEW, user_message: '用 sonnet 跑', requested_model: null }, SETTINGS)).toMatchObject({ model: 'sonnet', source: 'user', effort: 'medium' })
  // No effort answer: nothing is decided about it, whatever the model.
  expect(decideDispatch({ model: choice({ sonnet: 1 }) }, { ...REVIEW, requested_model: null }, SETTINGS)).toMatchObject({ model: 'sonnet', effort: null })
  // The log says what the floor did.
  expect(dispatchReason(as('sonnet', [1, 0, 0, 0, 0]), null, 0.6, 'the main agent')).toContain('effort lifted from low to medium (floor for sonnet)')
})

test("requested_fits variant: the main agent's pick is no hint but a question of its own, and goes only when the work is also outside what it covers", () => {
  const shape = { ask: { requested: 'noul' as const } }
  const part = dispatchPart(REVIEW, shape)
  expect(Object.keys(part.questions)).toEqual(['model', 'effort', 'requested_fits'])
  expect(JSON.stringify(part.questions.model?.instructions)).not.toContain('opus')
  expect(JSON.stringify(part.questions.requested_fits?.instructions)).toContain('careful judgment')

  // Sure of haiku (confidence 0.85): the pick goes only if it does not fit.
  const settings = { ...shape, thetaOverride: 0.6, thetaMax: 0.5 }
  const sure = { model: choice({ haiku: 0.9, sonnet: 0.05, opus: 0.05 }) }
  expect(decideDispatch({ ...sure, requested_fits: { type: 'noul', noul: 0.2 } }, REVIEW, settings).model).toBe('haiku')
  expect(decideDispatch({ ...sure, requested_fits: { type: 'noul', noul: 0.8 } }, REVIEW, settings).model).toBe('opus')
})
