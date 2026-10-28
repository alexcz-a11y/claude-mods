// The dispatched-agent decision module's own interface: what the eval (#15)
// imports to build, from an item of subagent.jsonl, the request the mod sends
// at agent.spawn, and to read the answers the way the mod does; and what the
// Workflow rewriter (#8) reuses for each agent() of a script. Pure, no `$`.
// The model is the model table's on the Nouls about the brief (ADR 0015).

import { expect, test } from 'claude-code/testing'
import { estimateTokens } from '../hooks/decision/context.ts'
import {
  AGENT_MODELS,
  BRIEF_NOULS,
  DEFAULT_AGENT_MODELS,
  decideDispatch,
  dispatchBrief,
  dispatchNote,
  dispatchPart,
  dispatchReason,
  dispatchState,
  mentionsEffort,
  nearestAllowed,
  type AgentModel,
  type Dispatch,
} from '../hooks/decision/dispatched-agent.ts'
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
/** The same work with no pick of the main agent's. */
const FREE: Dispatch = { ...REVIEW, requested_model: null }

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

/** Every Noul about the brief answered: each at 0 (no) unless `given` says otherwise; a medium effort unless `effort` does. */
function brief(given: Record<string, number> = {}, effort: readonly number[] = [0, 1, 0, 0, 0]): Record<string, Answer> {
  return { ...Object.fromEntries(BRIEF_NOULS.map((id) => [id, noul(given[id] ?? 0)])), effort: score(effort) }
}
/** A read-only lookup of a step or two: the table's row 4. */
const LOOKUP = { writes: 0.05, few_steps: 0.9, report_only: 0.85 }
const WITH_FABLE = { models: AGENT_MODELS }

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

test('the questions: one yes/no question per judgment about the brief, each naming the fields it reads, true as yes; frontier only with fable; the effort Score; in English unless asked in Chinese', () => {
  const part = dispatchPart(REVIEW)
  expect(Object.keys(part.questions)).toEqual(['writes', 'few_steps', 'report_only', 'stakes.undo', 'stakes.live', 'stakes.access', 'cause_unknown', 'design_open', 'outside_facts', 'science_code', 'effort'])
  for (const id of BRIEF_NOULS.filter((id) => id !== 'frontier')) {
    const question = part.questions[id]
    expect(question?.type).toBe('noul')
    const text = JSON.stringify(question)
    expect(text).toContain('`brief.prompt`')
    expect(text).toContain('`user_message`')
    expect(question?.type === 'noul' && Object.keys(question.criteria ?? {})).toEqual(['true', 'false'])
  }
  expect(part.questions.writes?.instructions).toMatchObject({ question: 'Does `brief.prompt` ask the agent to create, change or delete files, or to run commands that change something?' })
  expect(part.questions.few_steps?.instructions).toMatchObject({ question: 'Can the work in `brief.prompt` be done with one or two tool calls?' })
  expect(part.questions.report_only?.instructions).toMatchObject({ question: 'Is the result of `brief.prompt` only gathered and laid out as asked (a list, a table, a count), with nothing to decide?' })
  expect(part.questions.effort?.type).toBe('score')
  // No question names the main agent's pick: it never anchors a judgment (the table weighs it afterwards).
  expect(JSON.stringify(part.questions)).not.toContain('opus')

  expect(Object.keys(dispatchPart(REVIEW, WITH_FABLE).questions)).toContain('frontier')
  const chinese = dispatchPart(REVIEW, { ask: { language: 'zh', primitive: 'choice' } })
  expect(JSON.stringify(chinese.questions.design_open)).toMatch(/自己选一个任务里没给出的做法/)
  expect(chinese.questions.effort?.type).toBe('choice')
})

test('several agents can share one request: each has its own part name and brief field (the Workflow rewriter, #8)', () => {
  const search: Dispatch = { ...REVIEW, description: '查找 legacyAuth 引用', prompt: '找出仓库中所有对 legacyAuth 的引用，只汇报。', requested_model: null }
  const first = dispatchPart(REVIEW, { part: 'agent-0', field: 'brief_0' })
  const second = dispatchPart(search, { part: 'agent-1', field: 'brief_1' })
  const request = mergeParts({ brief_0: dispatchBrief(REVIEW, 600), brief_1: dispatchBrief(search, 600), user_message: REVIEW.user_message }, [first, second])

  expect(Object.keys(request.questions)).toHaveLength(22)
  expect(Object.keys(request.questions).slice(0, 2)).toEqual(['agent-0.writes', 'agent-0.few_steps'])
  expect(JSON.stringify(request.questions['agent-1.cause_unknown']?.instructions)).toContain('`brief_1.prompt`')
  for (const id of Object.keys(request.questions)) expect(QUESTION_ID.test(id)).toBe(true)
})

test('the model table, row by row: the first that matches wins; a Noul reads yes from 0.7 and no up to 0.3, the band between', () => {
  const row = (given: Record<string, number>, settings = {}) => {
    const decision = decideDispatch(brief(given), FREE, settings)
    return { row: decision.table?.row, model: decision.model }
  }
  // Row 2: frontier yes, with fable offered; without it the question is not asked, and its answer is not read.
  expect(row({ frontier: 0.8, 'stakes.undo': 0.9 }, WITH_FABLE)).toEqual({ row: '2', model: 'fable' })
  expect(row({ frontier: 0.8 })).toEqual({ row: '5', model: 'sonnet' })
  expect(row({ frontier: 0.6 }, WITH_FABLE)).toEqual({ row: '5', model: 'sonnet' })
  // Row 3: any of the seven careful Nouls yes, even beside a lookup.
  for (const id of ['stakes.undo', 'stakes.live', 'stakes.access', 'cause_unknown', 'design_open', 'outside_facts', 'science_code']) {
    expect(row({ [id]: 0.7, ...LOOKUP })).toEqual({ row: '3', model: 'opus' })
  }
  // Row 3b: none of them yes, one in the band: sonnet (and max effort, below).
  expect(row({ design_open: 0.5, ...LOOKUP })).toEqual({ row: '3b', model: 'sonnet' })
  expect(row({ outside_facts: 0.31 })).toEqual({ row: '3b', model: 'sonnet' })
  expect(row({ outside_facts: 0.3 })).toEqual({ row: '5', model: 'sonnet' })
  // Row 4: writes no, few_steps yes and report_only yes.
  expect(row(LOOKUP)).toEqual({ row: '4', model: 'haiku' })
  expect(row({ ...LOOKUP, writes: 0.4 })).toEqual({ row: '5', model: 'sonnet' })
  expect(row({ ...LOOKUP, few_steps: 0.69 })).toEqual({ row: '5', model: 'sonnet' })
  expect(row({ ...LOOKUP, report_only: 0.5 })).toEqual({ row: '5', model: 'sonnet' })
  // Row 5: anything else.
  expect(row({ writes: 0.9 })).toEqual({ row: '5', model: 'sonnet' })
  // A missing answer makes no haiku: the three must be said.
  const { writes: _, ...unsaid } = brief(LOOKUP)
  expect(decideDispatch(unsaid, FREE, {})).toMatchObject({ model: 'sonnet', table: { row: '5' } })
  // Nothing about the brief answered (a failed request): no table, and the engine's model stands unless the main agent asked for one.
  expect(decideDispatch({}, FREE, {})).toMatchObject({ model: null, source: 'none', table: null, answered: false })
  expect(decideDispatch({ effort: score([0, 0, 1, 0, 0]) }, REVIEW, {})).toMatchObject({ model: 'opus', source: 'requested', table: null, answered: true })
})

test("the main agent's pick: kept unless the table's model is stronger, then raised to it; never lowered", () => {
  const as = (requested: AgentModel, given: Record<string, number>, settings = {}) => {
    const decision = decideDispatch(brief(given), { ...REVIEW, requested_model: requested }, settings)
    return { model: decision.model, source: decision.source, requested: decision.requested }
  }
  // The table says haiku: opus and sonnet stay as asked; haiku is haiku.
  expect(as('opus', LOOKUP)).toEqual({ model: 'opus', source: 'requested', requested: { model: 'opus', outcome: 'kept' } })
  expect(as('sonnet', LOOKUP)).toEqual({ model: 'sonnet', source: 'requested', requested: { model: 'sonnet', outcome: 'kept' } })
  expect(as('haiku', LOOKUP)).toEqual({ model: 'haiku', source: 'requested', requested: { model: 'haiku', outcome: 'kept' } })
  // The table says opus: haiku and sonnet are raised; fable, stronger, is kept (agentFable or not).
  expect(as('haiku', { cause_unknown: 0.9 })).toEqual({ model: 'opus', source: 'table', requested: { model: 'haiku', outcome: 'upgraded' } })
  expect(as('sonnet', { cause_unknown: 0.9 })).toEqual({ model: 'opus', source: 'table', requested: { model: 'sonnet', outcome: 'upgraded' } })
  expect(as('fable', { cause_unknown: 0.9 })).toEqual({ model: 'fable', source: 'requested', requested: { model: 'fable', outcome: 'kept' } })
  // An id counts by its family.
  expect(decideDispatch(brief(LOOKUP), { ...REVIEW, requested_model: 'claude-sonnet-5-5' }, {})).toMatchObject({ model: 'sonnet', source: 'requested' })
  // The steps say whose pick it was: a Workflow call's is the script's.
  const script = decideDispatch(brief({ design_open: 0.9 }), { ...REVIEW, kind: 'workflow', requested_model: 'sonnet' }, {})
  expect(script.steps.find((step) => step.rule === 'main-pick')).toMatchObject({ asker: 'script', requested: 'sonnet', table: 'opus', model: 'opus', outcome: 'upgraded' })
})

test('a model the person rules out is skipped for the nearest allowed: the next stronger first, else the next weaker; a ruled-out pick of the main agent does not count; with every model ruled out none is left', () => {
  expect(nearestAllowed('haiku', ['sonnet', 'opus'])).toBe('sonnet')
  expect(nearestAllowed('sonnet', ['haiku', 'opus'])).toBe('opus')
  expect(nearestAllowed('opus', ['haiku', 'sonnet'])).toBe('sonnet')
  expect(nearestAllowed('fable', ['haiku', 'sonnet', 'opus'])).toBe('opus')
  expect(nearestAllowed('sonnet', ['haiku'])).toBe('haiku')
  expect(nearestAllowed('sonnet', [])).toBeNull()
  const ban = (models: string[]) => Object.fromEntries(models.map((model) => [`banned.${model}`, noul(0.9)]))
  const item = { ...FREE, user_message: '别用 haiku、sonnet 和 opus 了' }
  // Stronger: a lookup with haiku ruled out goes to sonnet.
  expect(decideDispatch({ ...brief(LOOKUP), ...ban(['haiku']) }, item, {})).toMatchObject({ model: 'sonnet', source: 'table', table: { row: '4', wanted: 'haiku', model: 'sonnet' }, banned: ['haiku'] })
  // Weaker, when nothing stronger is allowed: opus ruled out without fable goes to sonnet; fable ruled out goes to opus.
  expect(decideDispatch({ ...brief({ 'stakes.live': 0.9 }), ...ban(['opus']) }, item, {})).toMatchObject({ model: 'sonnet', table: { row: '3', wanted: 'opus', model: 'sonnet' } })
  expect(decideDispatch({ ...brief({ frontier: 0.9 }), ...ban(['fable']) }, item, WITH_FABLE)).toMatchObject({ model: 'opus', table: { row: '2', wanted: 'fable', model: 'opus' } })
  // With fable offered, opus ruled out goes up to fable.
  expect(decideDispatch({ ...brief({ 'stakes.live': 0.9 }), ...ban(['opus']) }, item, WITH_FABLE)).toMatchObject({ model: 'fable' })
  // The main agent asked for opus, which the person ruled out: its pick does not count, the table's model (or its stand-in) does.
  expect(decideDispatch({ ...brief(LOOKUP), ...ban(['opus']) }, { ...item, requested_model: 'opus' }, {})).toMatchObject({ model: 'haiku', source: 'table', requested: null })
  // Under 0.7 a ban is no ban.
  expect(decideDispatch({ ...brief(LOOKUP), 'banned.haiku': noul(0.6) }, item, {})).toMatchObject({ model: 'haiku', banned: [] })
  // Every model ruled out: none is left; a pick of the main agent's nobody ruled out stands.
  const all = { ...brief(LOOKUP), ...ban(['haiku', 'sonnet', 'opus']) }
  expect(decideDispatch(all, item, {})).toMatchObject({ model: null, source: 'none', table: { row: '4', model: null }, banned: ['haiku', 'sonnet', 'opus'] })
  expect(decideDispatch(all, { ...item, requested_model: 'fable' }, {})).toMatchObject({ model: 'fable', source: 'requested', effort: 'medium' })
})

test('a model the person names wins, from 0.7: over the table and over the main agent, in either direction; a name they also rule out stays named', () => {
  const item = { ...REVIEW, user_message: '这个用 haiku 就够了' }
  const named = (p: number) => decideDispatch({ ...brief({ cause_unknown: 0.9 }), 'named.haiku': noul(p) }, item, {})
  expect(named(0.7)).toMatchObject({ model: 'haiku', source: 'user', table: { row: '1', wanted: 'haiku', model: 'haiku' }, requested: null })
  expect(named(0.69)).toMatchObject({ model: 'opus', source: 'requested' })
  // The highest of two named, and a contradiction resolved for the name.
  const two = decideDispatch({ ...brief(), 'named.haiku': noul(0.75), 'named.fable': noul(0.9) }, item, {})
  expect(two).toMatchObject({ model: 'fable', source: 'user' })
  expect(decideDispatch({ ...brief(), 'named.sonnet': noul(0.9), 'banned.sonnet': noul(0.9) }, item, {})).toMatchObject({ model: 'sonnet', banned: [] })
})

test("an effort the person names: asked only when their words may name one; the level the answer favours, when it beats none and reaches 0.7; no floor touches it; on haiku too (Haiku 5.5 takes one)", () => {
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

  const xhigh = [0, 0, 0, 1, 0]
  const sure = decideDispatch({ ...brief({}, xhigh), named_effort: choice({ none: 0.05, low: 0.9, medium: 0.05 }) }, FREE, {})
  expect(sure).toMatchObject({ model: 'sonnet', effort: 'low', namedEffort: 'low', effortSource: 'user' })
  expect(sure.lifted).toBeUndefined()
  expect(sure.steps.at(-1)).toEqual({ rule: 'named-effort', applied: true, level: 'low', decided: 'xhigh' })
  // Under 0.7, or none the most probable: the decided effort stands.
  expect(decideDispatch({ ...brief({}, xhigh), named_effort: choice({ none: 0.1, low: 0.6, medium: 0.3 }) }, FREE, {})).toMatchObject({ effort: 'xhigh', namedEffort: null, effortSource: 'decided' })
  expect(decideDispatch({ ...brief({}, xhigh), named_effort: choice({ none: 0.6, low: 0.4 }) }, FREE, {})).toMatchObject({ effort: 'xhigh', namedEffort: null })
  // No floor touches it: not the stakes' max, not row 3b's, not the model's.
  const stakes = { 'stakes.undo': 0.9, 'stakes.live': 0.9 }
  expect(decideDispatch({ ...brief(stakes, [1, 0, 0, 0, 0]), named_effort: choice({ none: 0, low: 1 }) }, FREE, {})).toMatchObject({ model: 'opus', effort: 'low', effortSource: 'user' })
  expect(decideDispatch({ ...brief({ design_open: 0.5 }), named_effort: choice({ none: 0, medium: 1 }) }, FREE, {})).toMatchObject({ table: { row: '3b' }, effort: 'medium' })
  // Without an effort answer the named level still stands; on haiku too, which takes an effort since Haiku 5.5.
  const { effort: _, ...noEffort } = brief(LOOKUP)
  expect(decideDispatch({ ...noEffort, named_effort: choice({ none: 0, max: 1 }) }, FREE, {})).toMatchObject({ model: 'haiku', effort: 'max', effortSource: 'user' })
})

test('the effort floors over the base: the stakes, the unknown cause, row 3b and the model; each only lifts, the highest stands', () => {
  const effort = (given: Record<string, number>, levels: number[], requested: AgentModel | null = null) => {
    const decision = decideDispatch(brief(given, levels), { ...REVIEW, requested_model: requested }, {})
    return { model: decision.model, effort: decision.effort, lifted: decision.lifted }
  }
  const LOW = [1, 0, 0, 0, 0]
  // The stakes: undo and live (or access) yes → max; any one yes → xhigh; any in the band → high.
  expect(effort({ 'stakes.undo': 0.9, 'stakes.live': 0.8 }, LOW)).toEqual({ model: 'opus', effort: 'max', lifted: { from: 'low', by: 'stakes' } })
  expect(effort({ 'stakes.undo': 0.9, 'stakes.access': 0.8 }, LOW)).toMatchObject({ effort: 'max' })
  expect(effort({ 'stakes.access': 0.9 }, LOW)).toEqual({ model: 'opus', effort: 'xhigh', lifted: { from: 'low', by: 'stakes' } })
  expect(effort({ 'stakes.live': 0.5 }, LOW)).toEqual({ model: 'sonnet', effort: 'max', lifted: { from: 'low', by: 'unsure' } })
  // The unknown cause: yes → xhigh; in the band → high (and row 3b's max over it).
  expect(effort({ cause_unknown: 0.9 }, LOW)).toEqual({ model: 'opus', effort: 'xhigh', lifted: { from: 'low', by: 'cause-unknown' } })
  // Row 3b: max, whatever the base, also when the main agent's opus is kept.
  expect(effort({ science_code: 0.4 }, [0, 1, 0, 0, 0], 'opus')).toEqual({ model: 'opus', effort: 'max', lifted: { from: 'medium', by: 'unsure' } })
  // Row 3 with no stake and a known cause: only the model's floor, medium.
  expect(effort({ design_open: 0.9 }, LOW)).toEqual({ model: 'opus', effort: 'medium', lifted: { from: 'low', by: 'model-floor' } })
  // The model's floor: sonnet and opus at medium; haiku and fable have none.
  expect(effort({}, LOW)).toEqual({ model: 'sonnet', effort: 'medium', lifted: { from: 'low', by: 'model-floor' } })
  expect(effort(LOOKUP, LOW)).toEqual({ model: 'haiku', effort: 'low', lifted: undefined })
  expect(decideDispatch(brief({ frontier: 0.9 }, LOW), FREE, WITH_FABLE)).toMatchObject({ model: 'fable', effort: 'low' })
  // A floor never lowers: a base above it stands, unlifted.
  expect(effort({ 'stakes.access': 0.9 }, [0, 0, 0, 0, 1])).toEqual({ model: 'opus', effort: 'max', lifted: undefined })
  // The base: the position rounded, one up when two-peaked (decision/effort.ts).
  expect(effort({}, [0.6, 0, 0, 0, 0.4])).toMatchObject({ effort: 'xhigh' })
  // Without an effort answer nothing is decided about it.
  const { effort: _, ...noEffort } = brief({ 'stakes.undo': 0.9 })
  expect(decideDispatch(noEffort, FREE, {})).toMatchObject({ model: 'opus', effort: null, effortSource: 'none' })
})

test("the rules' working, step by step, for the card (ADR 0004): the Nouls, the table, the pick, the base, the floors; the log and the main agent's note say the same", () => {
  const decision = decideDispatch(brief({ cause_unknown: 0.45 }, [1, 0, 0, 0, 0]), { ...REVIEW, requested_model: 'haiku' }, {})
  expect(decision.steps.map((step) => [step.rule, step.applied])).toEqual([
    ['lookup-signs', false],
    ['careful-signs', true],
    ['model-table', true],
    ['main-pick', true],
    ['position', true],
    ['two-peaked', false],
    ['stakes', false],
    ['cause-unknown', true],
    ['unsure', true],
    ['model-floor', false],
  ])
  expect(decision.steps[1]).toMatchObject({ cause: 0.45, causeVerdict: 'band', design: 0, designVerdict: 'no', yes: 0.7, no: 0.3 })
  expect(decision.steps[2]).toMatchObject({ row: '3b', wanted: 'sonnet', model: 'sonnet', why: 'cause', banned: null })
  expect(decision.steps[3]).toMatchObject({ asker: 'main', requested: 'haiku', table: 'sonnet', model: 'sonnet', outcome: 'upgraded' })
  expect(decision.steps[7]).toMatchObject({ level: 'high', floor: 'high' })
  expect(decision.steps[8]).toMatchObject({ level: 'max', floor: 'max', row: '3b' })
  expect(dispatchReason(decision, 'haiku', '主 agent 指定的')).toMatch(/^模型表第 3b 行（原因未知拿不准） → sonnet，effort 至少 max；主 agent 指定的 haiku 升级到 sonnet；effort 从 low 抬到 max（拿不准要不要 opus（第 3b 行））；effort 概率 /)
  const note = dispatchNote({ routed: true, decision, started: 'claude-sonnet-5-5', requested: 'haiku' })
  expect(note).toContain('started this agent on sonnet at effort max')
  expect(note).toContain('raised from the haiku you asked for: its rules read the brief as work that may need careful judgment (cause_unknown), which gets sonnet at max effort')
  expect(note).toContain('low lifted to max, as it is unclear whether the work needs careful judgment')
  const kept = decideDispatch(brief(LOOKUP), REVIEW, {})
  expect(dispatchReason(kept, 'opus', '主 agent 指定的')).toMatch(/^沿用主 agent 指定的 opus（模型表第 4 行（写入、一两步、只汇报） → haiku，不比它强）/)
  expect(dispatchNote({ routed: true, decision: kept, started: 'opus', requested: 'opus' })).toContain('kept the opus you asked for (its rules read the brief as a read-only lookup of a step or two whose result is only reported (writes, few_steps, report_only), which gets haiku, which is not stronger)')
})

test('the default models: haiku, sonnet and opus; fable only with agentFable', () => {
  expect(DEFAULT_AGENT_MODELS).toEqual(['haiku', 'sonnet', 'opus'])
  expect(AGENT_MODELS).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
})
