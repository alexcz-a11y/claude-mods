// The mid-turn decision's own interface (decision/midturn.ts): what the eval
// (#14) imports to build, from a row of the effort-midturn dataset, exactly
// the request the mod sends mid-turn, and to read its answer the way the mod
// does. Pure functions, no `$`.

import { expect, test } from 'claude-code/testing'
import { estimateTokens } from '../hooks/decision/context.ts'
import { turnStartEffortPart } from '../hooks/decision/effort.ts'
import { troubleText } from '../hooks/decision/escalation.ts'
import {
  contentLanguage,
  judgeMidturn,
  midturnEffortPart,
  midturnState,
  outcomeOf,
  resultLine,
  toolDetail,
  type MidturnInput,
  type MidturnRules,
} from '../hooks/decision/midturn.ts'
import { mergeParts } from '../hooks/decision/system-one.ts'

/** midturn-001 of the effort-midturn dataset, its `zh` object as it is. */
const ROW: MidturnInput = {
  message: '给 `src/utils/duration.ts` 加一个 `parseDuration`，支持 `1h30m`、`45s` 这种写法，先写测试再实现',
  step: 3,
  current_effort: 'medium',
  counts: { judgments: 2, changes: 0, failures: 1, hook_blocks: 0 },
  recent_steps: [
    {
      assistant_text: '先看一下现有的 duration 工具和测试风格。',
      tools: [
        { name: 'Read', result: '成功：src/utils/duration.ts，现有一个 formatDuration 函数，约 40 行' },
        { name: 'Glob', result: '成功：找到 src/utils/__tests__/duration.test.ts' },
      ],
    },
    { assistant_text: '按 TDD，先补 parseDuration 的用例：正常组合、单一单位、非法输入。', tools: [{ name: 'Edit', result: '成功：duration.test.ts 新增 7 个 parseDuration 用例' }] },
    {
      assistant_text: '跑一下，预期全部失败，因为函数还不存在。',
      tools: [{ name: 'Bash', result: '失败：npx vitest run duration：7 个新用例失败（parseDuration is not a function），原有 5 个通过' }],
    },
  ],
}

const LIMITS = { steps: 4, tokens: 2000 }

test('a dataset row becomes the state as it is: the message first, then the step, the level, the counts and the latest steps', () => {
  const state = midturnState(ROW, LIMITS)
  expect(Object.keys(state)).toEqual(['user_message', 'step', 'current_effort', 'counts', 'recent_steps'])
  expect(state).toEqual({
    user_message: ROW.message,
    step: 3,
    current_effort: 'medium',
    counts: { judgments: 2, changes: 0, failures: 1, hook_blocks: 0 },
    recent_steps: ROW.recent_steps,
  })
})

test('the request is one Score question on the same five levels as at the turn start, asked about the rest of the work', () => {
  const request = mergeParts(midturnState(ROW, LIMITS), [midturnEffortPart()])
  expect(Object.keys(request.questions)).toEqual(['midturn.level'])
  const question = request.questions['midturn.level']
  const start = turnStartEffortPart().questions.level
  expect(question?.type).toBe('score')
  expect(question?.type === 'score' && question.criteria).toEqual(start?.type === 'score' ? start.criteria : [])
  expect(JSON.stringify(question?.instructions)).toContain('`recent_steps`')
  expect(JSON.stringify(question?.instructions)).not.toContain('trouble')
  // In Chinese: the same shape, written in Chinese.
  const zh = midturnEffortPart({ language: 'zh' }).questions.level
  expect(JSON.stringify(zh?.instructions)).toMatch(/剩下的工作/)
  expect(JSON.stringify(zh?.instructions)).not.toMatch(/step-by-step/)
})

test("a stuck turn's re-decision (#7) carries its trouble right after the message, and the question says what to do with it", () => {
  const trouble = troubleText({ failures: 2, hookBlocks: 0 })
  const state = midturnState({ ...ROW, trouble }, LIMITS)
  expect(Object.keys(state)).toEqual(['user_message', 'trouble', 'step', 'current_effort', 'counts', 'recent_steps'])
  expect(state.trouble).toBe(trouble)
  for (const language of ['en', 'zh'] as const) {
    expect(JSON.stringify(midturnEffortPart({ language }, { trouble: true }).questions.level?.instructions)).toContain('`trouble`')
  }
})

test('the current level and the counts can be left out (eval variables: the guide warns the level may anchor the answer)', () => {
  expect(Object.keys(midturnState(ROW, LIMITS, { currentEffort: false }))).toEqual(['user_message', 'step', 'counts', 'recent_steps'])
  expect(Object.keys(midturnState(ROW, LIMITS, { counts: false }))).toEqual(['user_message', 'step', 'current_effort', 'recent_steps'])
})

test('only the latest `steps` steps go along', () => {
  const state = midturnState(ROW, { steps: 2, tokens: 2000 })
  expect(state.recent_steps).toEqual(ROW.recent_steps.slice(-2))
})

test('within the token budget: the message takes at most half, the newest steps the rest; an older step is dropped whole, a long text keeps its end', () => {
  const steps = Array.from({ length: 6 }, (_, i) => ({
    assistant_text: `第 ${i} 步：${'先把会话模块里每一处过期判断都读一遍，'.repeat(6)}然后跑测试。`,
    tools: [{ name: 'Bash', result: `成功：第 ${i} 步的命令` }],
  }))
  const input: MidturnInput = { ...ROW, message: '把会话模块的过期逻辑彻底查清楚。'.repeat(30), recent_steps: steps }
  const state = midturnState(input, { steps: 6, tokens: 400 })

  expect(estimateTokens(JSON.stringify(state))).toBeLessThanOrEqual(400)
  expect(estimateTokens(state.user_message as string)).toBeLessThanOrEqual(200)
  const kept = state.recent_steps as { assistant_text: string; tools: { name: string; result: string }[] }[]
  // The newest steps, in order, the oldest left out.
  expect(kept.length).toBeGreaterThan(0)
  expect(kept.length).toBeLessThan(6)
  expect(kept.at(-1)?.tools).toEqual([{ name: 'Bash', result: '成功：第 5 步的命令' }])
  // A step's text too long for its share keeps its end: what the agent is about to do.
  for (const step of kept) expect(step.assistant_text.endsWith('然后跑测试。')).toBe(true)
  expect(kept.at(-1)?.assistant_text).toContain(' … ')
})

test("secrets in what the agent wrote and in a tool's line are masked", () => {
  const input: MidturnInput = {
    ...ROW,
    recent_steps: [{ assistant_text: '用 token=abcd1234efgh5678 调一下接口。', tools: [{ name: 'Bash', result: 'Failed: curl -H "Authorization: Bearer abcdef0123456789abcdef"' }] }],
  }
  const sent = JSON.stringify(midturnState(input, LIMITS))
  expect(sent).not.toContain('abcd1234efgh5678')
  expect(sent).not.toContain('abcdef0123456789abcdef')
  expect(sent).toContain('[REDACTED]')
})

const RULES: MidturnRules = { thetaUp: 0.4, thetaDown: 0.6, thetaMax: 0.5, holdSteps: 3 }
const reading = (probabilities: number[], confidence: number | null) => ({ probabilities, confidence })

test('how an answer moves the level (the eval scores the level the mod would send)', () => {
  const xhigh = reading([0, 0, 0.1, 0.8, 0.1], 0.8)
  const low = reading([0.9, 0.1, 0, 0, 0], 0.9)
  expect(judgeMidturn(xhigh, { current: 'medium', sinceRaise: null }, RULES)).toMatchObject({ effort: 'xhigh', why: 'up' })
  expect(judgeMidturn(reading([0, 0, 0.1, 0.8, 0.1], 0.3), { current: 'medium', sinceRaise: null }, RULES)).toMatchObject({ effort: 'medium', why: 'unsure' })
  expect(judgeMidturn(low, { current: 'xhigh', sinceRaise: null }, RULES)).toMatchObject({ effort: 'high', why: 'down' })
  expect(judgeMidturn(reading([0.9, 0.1, 0, 0, 0], 0.5), { current: 'xhigh', sinceRaise: null }, RULES)).toMatchObject({ effort: 'xhigh', why: 'unsure' })
  expect(judgeMidturn(low, { current: 'xhigh', sinceRaise: 2 }, RULES)).toMatchObject({ effort: 'xhigh', why: 'held' })
  expect(judgeMidturn(low, { current: 'xhigh', sinceRaise: 3 }, RULES)).toMatchObject({ effort: 'high', why: 'down' })
  // No confidence from the backend: the most likely level's probability stands in.
  expect(judgeMidturn(reading([0, 0, 0.35, 0.65, 0], null), { current: 'medium', sinceRaise: null }, RULES)).toMatchObject({ effort: 'xhigh', why: 'up', confidence: 0.65 })
  // max only past thetaMax.
  expect(judgeMidturn(reading([0, 0, 0.1, 0.4, 0.5], 0.7), { current: 'high', sinceRaise: null }, { ...RULES, thetaMax: 0.6 })).toMatchObject({ effort: 'xhigh', picked: 'xhigh' })
  // A forced raise: never below atLeast, whatever the answer.
  expect(judgeMidturn(low, { current: 'medium', sinceRaise: null, atLeast: 'high' }, RULES)).toMatchObject({ effort: 'high', why: 'lifted' })
  expect(judgeMidturn(xhigh, { current: 'medium', sinceRaise: null, atLeast: 'high' }, RULES)).toMatchObject({ effort: 'xhigh', why: 'up' })
})

test("a tool's line: how it ended, then what it worked on, in the turn's language", () => {
  expect(resultLine('ok', 'utils/duration.ts', 'zh')).toBe('成功：utils/duration.ts')
  expect(resultLine('failed', 'Run the tests', 'en')).toBe('Failed: Run the tests')
  expect(resultLine('blocked', 'git push', 'en')).toBe('Blocked by hook: git push')
  expect(resultLine('denied', '', 'zh')).toBe('用户拒绝')
  expect(resultLine('running', '查登录 502 的根因', 'zh')).toBe('进行中：查登录 502 的根因')
  expect(contentLanguage('修一下 `src/a.ts` 的 bug')).toBe('zh')
  expect(contentLanguage('fix the bug in src/a.ts')).toBe('en')
})

test('what a call worked on comes from the few arguments that name it, never from what it writes', () => {
  expect(toolDetail({ tool: 'Bash', command: 'npm test -- --token=abcd1234efgh5678', description: 'Run the unit tests' })).toBe('Run the unit tests')
  expect(toolDetail({ tool: 'Bash', command: 'npm test\necho done' })).toBe('npm test')
  expect(toolDetail({ tool: 'Edit', file_path: '/Users/me/repo/src/auth/session.ts', old_string: 'const TTL = 3600', new_string: 'const TTL = ttl()' })).toBe('auth/session.ts')
  expect(toolDetail({ tool: 'Write', file_path: '/repo/README.md', content: '# secret plans' })).toBe('repo/README.md')
  expect(toolDetail({ tool: 'Skill', skill: 'tdd' })).toBe('tdd')
  expect(toolDetail({ tool: 'Grep', pattern: 'parseDuration', path: '/repo/src' })).toBe('parseDuration')
  expect(toolDetail({ tool: 'TodoWrite', todos: [] })).toBe('')
})

test("how a call ended: a hook's refusal, the person's refusal (never read from an MCP tool's own text), an error, or ok", () => {
  const refused = "The user doesn't want to proceed with this tool use. The tool use was rejected."
  expect(outcomeOf('Bash', { result: 'ok', text: 'ok' } as never, false)).toBe('ok')
  expect(outcomeOf('Bash', { isError: true, text: 'exit 1' }, false)).toBe('failed')
  expect(outcomeOf('Bash', { isError: true, text: 'blocked by policy' }, true)).toBe('blocked')
  expect(outcomeOf('Bash', { deny: 'refused by a plugin' }, false)).toBe('blocked')
  expect(outcomeOf('Edit', { isError: true, text: refused }, false)).toBe('denied')
  expect(outcomeOf('Write', { isError: true, text: 'Permission to use Write has been denied.' }, false)).toBe('denied')
  expect(outcomeOf('mcp__github__create_pr', { isError: true, text: refused }, false)).toBe('failed')
})
