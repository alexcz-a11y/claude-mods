import { expect, test } from 'claude-code/testing'
import { OPEN_LEVELS, agentQuestions, midrunQuestions, submitQuestions } from '../hooks/questions.ts'
import { STATE_BUDGET, agentState, clip, estimateTokens, fitState, midrunState, submitState } from '../hooks/statebuild.ts'

test('每处问的题', () => {
  expect(Object.keys(submitQuestions(false))).toEqual(['open', 'mechanical', 'unknown_cause'])
  expect(Object.keys(submitQuestions(true))).toContain('continues')
  expect(Object.keys(midrunQuestions())).toEqual(['open', 'same_failure', 'cause_found', 'only_carrying_out', 'contradicts_plan'])
  expect(Object.keys(agentQuestions())).toEqual(['open', 'mechanical', 'unknown_cause', 'read_only'])
})
test('分档题五档，每档单独成句；是非题两边都写了情形', () => {
  expect(OPEN_LEVELS).toHaveLength(5)
  for (const q of Object.values({ ...submitQuestions(true), ...midrunQuestions(), ...agentQuestions() })) {
    if (q.type === 'noul') expect(q.criteria.true.length > 10 && q.criteria.false.length > 10).toBe(true)
    if (q.type === 'score') expect(q.criteria).toEqual([...OPEN_LEVELS])
  }
})
test('题面里反引号指到的字段都在 state 里', () => {
  const state = midrunState({ request: 'r', current: 'medium', stepsSoFar: 2, failedSteps: 1, recent: [{ did: 'a', tools: ['Read'], ok: true, result: 'x' }], latest: { did: 'b', tools: ['Bash'], ok: false, result: 'boom' }, progress: null })
  const top = [...JSON.stringify(midrunQuestions()).matchAll(/`([a-z_]+)/g)].map((m) => m[1])
  for (const name of top) expect(Object.keys(state)).toContain(name)
})
test('很长的消息：state 不超预算，头尾都在（Review Focus 4）', () => {
  const long = 'HEAD ' + 'x'.repeat(200_000) + ' TAIL'
  const state = submitState({ request: long, previous: null })
  expect(estimateTokens(JSON.stringify(state))).toBeLessThanOrEqual(STATE_BUDGET)
  expect(String(state.request).startsWith('HEAD')).toBe(true)
  expect(String(state.request).endsWith('TAIL')).toBe(true)
  expect(clip('短', 100)).toBe('短')
})
test('没有上一轮就没有 previous_turn 字段', () => {
  expect('previous_turn' in submitState({ request: 'r', previous: null })).toBe(false)
})

// Beyond the brief's contract.
const step = (n: number, result = 'ok'): { did: string; tools: string[]; ok: boolean; result: string } => ({ did: 'step ' + n, tools: ['Read'], ok: true, result })

test('题面里的字段在三处的 state 里都对得上', () => {
  const submit = submitState({ request: 'r', previous: { request: 'p', lastReply: 'l', ended: 'answered', level: null } })
  const agent = agentState({ task: 't', agentType: 'x', description: 'd' })
  const names = (qs: object): string[] => [...JSON.stringify(qs).matchAll(/`([a-z_]+)/g)].map((m) => m[1]!)
  for (const n of names(submitQuestions(true))) expect(Object.keys(submit)).toContain(n)
  for (const n of names(agentQuestions())) expect(Object.keys(agent)).toContain(n)
})
test('mechanical 和 unknown_cause 在发消息处指 request，在 agent 处指 task', () => {
  expect(submitQuestions(false).mechanical!.instructions.startsWith('In `request`, ')).toBe(true)
  expect(agentQuestions().unknown_cause!.instructions.startsWith('In `task`, ')).toBe(true)
})
test('agentState 的字段', () => {
  const s = agentState({ task: 'do it', agentType: 'Explore', description: 'look around' })
  expect(Object.keys(s)).toEqual(['note', 'task', 'agent_type', 'description'])
  expect(s.task).toBe('do it')
  expect(s.agent_type).toBe('Explore')
  expect(s.description).toBe('look around')
})
test('有上一轮时 previous_turn 带四个字段', () => {
  const s = submitState({ request: 'go on', previous: { request: 'fix it', lastReply: 'done?', ended: 'interrupted', level: 'high' } })
  expect(s.previous_turn).toEqual({ request: 'fix it', last_reply: 'done?', ended: 'interrupted', level: 'high' })
})
test('recent 最多 5 条，从早到晚；字段形状和 latest 一致', () => {
  const recent = [1, 2, 3, 4, 5, 6, 7].map((n) => step(n))
  const s = midrunState({ request: 'r', current: 'low', stepsSoFar: 8, failedSteps: 0, recent, latest: { ...step(8), ok: false }, progress: null })
  const got = s.recent as { did: string; outcome: string }[]
  expect(got.map((e) => e.did)).toEqual(['step 3', 'step 4', 'step 5', 'step 6', 'step 7'])
  expect(got[0]).toEqual({ did: 'step 3', tools: ['Read'], outcome: 'ok', result: 'ok' })
  expect((s.latest as { outcome: string }).outcome).toBe('error')
  expect([s.current_level, s.steps_so_far, s.failed_steps]).toEqual(['low', 8, 0])
})
test('中途 state 的 note：progress 是另一个模型的转述，仍按结果判断', () => {
  const s = midrunState({ request: 'r', current: 'medium', stepsSoFar: 1, failedSteps: 0, recent: [], latest: step(1), progress: { done: 'a', remaining: 'b', cause_known: false } })
  expect(s.note).toBe('Entries in "recent" are oldest first. Judge by the results, not by what the assistant says it achieved; "progress" is another model\'s paraphrase of the turn so far, not a result.')
  expect(String(s.note).includes('stated_next')).toBe(false)
})
test('progress 为 null 时不放，有就放；助手写的下一步打算（stated_next）不放', () => {
  const base = { request: 'r', current: 'medium' as const, stepsSoFar: 1, failedSteps: 0, recent: [], latest: step(1) }
  const bare = midrunState({ ...base, progress: null })
  expect('progress' in bare).toBe(false)
  const full = midrunState({ ...base, progress: { done: 'a', remaining: 'b', cause_known: true } })
  // Every field the state carries, in order: stated_next is not among them.
  expect(Object.keys(full)).toEqual(['note', 'request', 'current_level', 'steps_so_far', 'failed_steps', 'recent', 'latest', 'progress'])
  expect(full.progress).toEqual({ done: 'a', remaining: 'b', cause_known: true })
})
test('clip：中间放 …，头尾各一半，截断后不超预算', () => {
  const text = 'A'.repeat(500) + 'B'.repeat(500)
  const out = clip(text, 100)
  expect(out.includes(' … ')).toBe(true)
  expect(out.startsWith('AAAA')).toBe(true)
  expect(out.endsWith('BBBB')).toBe(true)
  expect(estimateTokens(out)).toBeLessThanOrEqual(100)
  const [head, tail] = out.split(' … ')
  expect(Math.abs(head!.length - tail!.length)).toBeLessThanOrEqual(1)
})
test('clip：中文（每字三字节）和表情也不超预算', () => {
  for (const unit of ['汉', '😀', 'é']) {
    const out = clip(unit.repeat(2000), 50)
    expect(estimateTokens(out)).toBeLessThanOrEqual(50)
    expect(out.includes(' … ')).toBe(true)
  }
})
test('中途 state：五条很长的结果、很长的 progress 也不超预算', () => {
  const long = 'E'.repeat(50_000)
  const s = midrunState({
    request: long, current: 'high', stepsSoFar: 30, failedSteps: 9,
    recent: [1, 2, 3, 4, 5].map((n) => ({ did: long, tools: ['Bash'], ok: false, result: long })),
    latest: { did: long, tools: ['Bash'], ok: false, result: long },
    progress: { done: long, remaining: long, cause_known: false },
  })
  expect(estimateTokens(JSON.stringify(s))).toBeLessThanOrEqual(STATE_BUDGET)
})

test('fitState：放得下就原样返回', () => {
  const s = submitState({ request: 'short', previous: null })
  expect(fitState(s)).toBe(s)
})
test('fitState：满是引号和换行的 state，转义后超预算，截到预算内', () => {
  const quotes = '"'.repeat(5000)
  const lines = 'line\n'.repeat(2000)
  const s = midrunState({
    request: quotes, current: 'high', stepsSoFar: 12, failedSteps: 3,
    recent: [1, 2, 3, 4, 5].map((n) => ({ did: 'step ' + n, tools: ['Bash'], ok: false, result: lines })),
    latest: { did: 'run tests', tools: ['Bash'], ok: false, result: quotes },
    progress: { done: quotes, remaining: lines, cause_known: false },
  })
  // Each field is within its own clip budget, but escaping doubles every quote and newline.
  expect(estimateTokens(JSON.stringify(s))).toBeGreaterThan(STATE_BUDGET)
  const fitted = fitState(s)
  expect(estimateTokens(JSON.stringify(fitted))).toBeLessThanOrEqual(STATE_BUDGET)
  // Same shape: only string values got shorter.
  expect(Object.keys(fitted)).toEqual(Object.keys(s))
  expect((fitted.recent as unknown[]).length).toBe(5)
  expect([fitted.current_level, fitted.steps_so_far, fitted.failed_steps]).toEqual(['high', 12, 3])
  expect((fitted.latest as { did: string }).did).toBe('run tests')
  // The input is not changed.
  expect(estimateTokens(JSON.stringify(s))).toBeGreaterThan(STATE_BUDGET)
})
test('fitState：工具名的列表截到 12 个，最长的字符串先截', () => {
  const tools = Array.from({ length: 40 }, (_, i) => 'mcp__server__tool_number_' + i)
  const s = { note: 'n', latest: { tools, result: '"'.repeat(9000) }, short: 'keep me' }
  const fitted = fitState(s)
  expect(estimateTokens(JSON.stringify(fitted))).toBeLessThanOrEqual(STATE_BUDGET)
  expect(fitted.latest.tools).toEqual(tools.slice(0, 12))
  expect(fitted.short).toBe('keep me')
  expect(fitted.note).toBe('n')
  expect(fitted.latest.result.includes(' … ')).toBe(true)
})
