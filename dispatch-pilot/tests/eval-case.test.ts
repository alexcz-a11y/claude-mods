import { expect, test } from 'claude-code/testing'
import { checkCase, checkSet, secretsIn } from '../eval/lib/case.ts'
import type { AgentCase, CaseSet, Difficulty, MidrunCase, SkillCase, SubmitCase } from '../eval/lib/case.ts'

const label = { by: 'model' as const, rationale: '请求只是改一个拼写，low 就够。' }
const step = { did: 'ran the tests', tools: ['Bash'], ok: true, result: '12 passed' }

const okSubmit: SubmitCase = {
  id: 'submit-01', category: 'submit', source: 'written', difficulty: 'typical', set: 'fit', tags: [], label,
  input: { request: 'fix the typo in README', previous: null, base: 'medium' },
  expect: { accept: ['low'] },
}
const okMidrun: MidrunCase = {
  id: 'midrun-01', category: 'midrun', source: 'written', difficulty: 'typical', set: 'fit', tags: [], label,
  input: {
    request: 'rename the helper everywhere', current: 'medium', stepsSoFar: 3, failedSteps: 0,
    recent: [step], latest: step, statedNext: 'edit the next file', codeMode: false, notes: null,
  },
  expect: { action: 'hold', accept: ['medium'] },
}
const okAgent: AgentCase = {
  id: 'agent-01', category: 'agent', source: 'written', difficulty: 'typical', set: 'fit', tags: [], label,
  input: { task: 'list the files under hooks/', agentType: 'Explore', description: 'list hooks', inherit: { level: 'high', tier: 'opus' } },
  expect: { accept: ['low', 'medium'], models: ['haiku'] },
}
const okSkill: SkillCase = {
  id: 'skill-01', category: 'skill', source: 'written', difficulty: 'typical', set: 'fit', tags: [], label,
  input: { request: 'review this branch since main', previous: null },
  expect: { skill: 'code-review', alsoOk: [] },
}

// Index i of 15: 0-5 fit, 6-9 check, 10-14 heldout; boundary or negative at 0, 1, 2, 10 and 11.
function setOf(i: number): CaseSet {
  return i < 6 ? 'fit' : i < 10 ? 'check' : 'heldout'
}
function difficultyOf(i: number): Difficulty {
  return [0, 2, 10].includes(i) ? 'boundary' : [1, 11].includes(i) ? 'negative' : 'typical'
}
function two(i: number): string {
  return String(i + 1).padStart(2, '0')
}
const previous = { request: 'add a flag', lastReply: 'Added --dry-run.', ended: 'answered' as const, level: 'medium' as const }

const fifteen: SubmitCase[] = Array.from({ length: 15 }, (_, i) => ({
  ...okSubmit, id: `submit-${two(i)}`, set: setOf(i), difficulty: difficultyOf(i),
  tags: i < 2 ? ['continues'] : i < 4 ? ['long-unattended'] : [],
  input: { ...okSubmit.input, previous: i < 5 ? previous : null },
}))

const midrunTags = ['looks-finished', 'looks-finished', 'batch-mechanical', 'batch-mechanical', 'stuck', 'stuck']
function midrunSet(holds: number): MidrunCase[] {
  return Array.from({ length: 15 }, (_, i) => ({
    ...okMidrun, id: `midrun-${two(i)}`, set: setOf(i), difficulty: difficultyOf(i), tags: midrunTags[i] ? [midrunTags[i]] : [],
    input: { ...okMidrun.input, codeMode: i % 2 === 0 },
    expect: i < holds ? { action: 'hold', accept: ['medium'] } : { action: 'up', accept: ['high'] },
  }))
}
const sevenHolds = midrunSet(7)

const agentFifteen: AgentCase[] = Array.from({ length: 15 }, (_, i) => ({
  ...okAgent, id: `agent-${two(i)}`, set: setOf(i), difficulty: difficultyOf(i),
  expect: i < 3 ? okAgent.expect : i < 8 ? { accept: ['high'], models: ['opus'] } : { accept: ['high'], models: ['sonnet', 'opus'] },
}))

const nullTags = ['everyday', 'uncovered', 'named-missing', 'everyday', 'uncovered']
const skillFifteen: SkillCase[] = Array.from({ length: 15 }, (_, i) => ({
  ...okSkill, id: `skill-${two(i)}`, set: setOf(i), difficulty: difficultyOf(i), tags: nullTags[i] ? [nullTags[i]] : [],
  expect: i < 5 ? { skill: null, alsoOk: [] } : okSkill.expect,
}))

test('一例合格的 submit 用例没有问题', () => {
  expect(checkCase(okSubmit, [])).toEqual([])
})
test('合格的 midrun、agent、skill 用例没有问题', () => {
  expect(checkCase(okMidrun, [])).toEqual([])
  expect(checkCase(okAgent, [])).toEqual([])
  expect(checkCase(okSkill, ['code-review'])).toEqual([])
})
test('accept 里两个档位不相邻：是问题', () => {
  expect(checkCase({ ...okSubmit, expect: { accept: ['low', 'high'] } }, [])).toHaveLength(1)
})
test('accept 是空的或多于两个档位：是问题', () => {
  expect(checkCase({ ...okSubmit, expect: { accept: [] } }, [])).toHaveLength(1)
  expect(checkCase({ ...okSubmit, expect: { accept: ['low', 'medium', 'high'] } }, [])).toHaveLength(1)
})
test('id 要形如 <category>-<两位数字>', () => {
  expect(checkCase({ ...okSubmit, id: 'submit-1' }, [])).toHaveLength(1)
  expect(checkCase({ ...okSubmit, id: 'midrun-01' }, [])).toHaveLength(1)
})
test('hold 的 midrun 用例 accept 必须是 [current]', () => {
  expect(checkCase({ ...okMidrun, expect: { action: 'hold', accept: ['high'] } }, [])).toHaveLength(1)
})
test('up 的 midrun 用例：accept 都高于 current（可以到 max）；down 的都低于 current', () => {
  expect(checkCase({ ...okMidrun, expect: { action: 'up', accept: ['high', 'xhigh'] } }, [])).toEqual([])
  expect(checkCase({ ...okMidrun, expect: { action: 'up', accept: ['medium', 'high'] } }, [])).toHaveLength(1)
  expect(checkCase({ ...okMidrun, expect: { action: 'up', accept: ['xhigh', 'max'] } }, [])).toEqual([])
  expect(checkCase({ ...okMidrun, expect: { action: 'down', accept: ['low'] } }, [])).toEqual([])
  expect(checkCase({ ...okMidrun, expect: { action: 'down', accept: ['medium'] } }, [])).toHaveLength(1)
})
test('midrun 的 recent 多于 5 条：是问题', () => {
  expect(checkCase({ ...okMidrun, input: { ...okMidrun.input, recent: Array(6).fill(step) } }, [])).toHaveLength(1)
})
test('agent 的 models 高于 inherit.tier：是问题', () => {
  expect(checkCase({ ...okAgent, expect: { accept: ['high'], models: ['opus', 'fable'] } }, [])).toHaveLength(1)
})
test('skill 用例期望的名字不在候选里：是问题', () => {
  expect(checkCase(okSkill, ['other'])).toHaveLength(1)
  expect(checkCase({ ...okSkill, expect: { skill: 'code-review', alsoOk: ['tdd'] } }, ['code-review'])).toHaveLength(1)
  expect(checkCase({ ...okSkill, expect: { skill: null, alsoOk: [] } }, [])).toEqual([])
})
test('理由是空的：是问题', () => {
  expect(checkCase({ ...okSubmit, label: { by: 'human', rationale: '  ' } }, [])).toHaveLength(1)
})
test('取自真实会话的用例要带 8 位的 session', () => {
  expect(checkCase({ ...okSubmit, source: 'real', session: '0a10ce6b' }, [])).toEqual([])
  expect(checkCase({ ...okSubmit, source: 'real' }, [])).toHaveLength(1)
  expect(checkCase({ ...okSubmit, source: 'real', session: '0a10ce6b-598d' }, [])).toHaveLength(1)
})
test('不是用例的东西：是问题，不抛异常', () => {
  expect(checkCase(null, []).length).toBeGreaterThan(0)
  expect(checkCase({ ...okSubmit, category: 'other' }, []).length).toBeGreaterThan(0)
})
test('文字里有密钥或带用户名的路径：是问题', () => {
  expect(secretsIn('key nace_sk_abcdefghijklmnop')).toHaveLength(1)
  expect(secretsIn('at /Users/someone/project/a.ts')).toHaveLength(1)
  expect(secretsIn('at /Users/user/project/a.ts')).toEqual([])
})
test('不以斜杠结尾的用户路径也算；/Users/user 不算', () => {
  expect(secretsIn('cd /Users/someone')).toHaveLength(1)
  expect(secretsIn('cd /Users/user')).toEqual([])
  expect(secretsIn('/Users/user/x')).toEqual([])
})
test('midrun 的进展记录不是 null：合格的通过，缺 cause_known 是一个问题', () => {
  const after = { done: 'found the race', remaining: 'fix it and rerun', cause_known: true }
  expect(checkCase({ ...okMidrun, input: { ...okMidrun.input, notes: { before: null, after } } }, [])).toEqual([])
  const { cause_known: _, ...partial } = after
  expect(checkCase({ ...okMidrun, input: { ...okMidrun.input, notes: { before: null, after: partial } } }, [])).toHaveLength(1)
})
test('secretsIn 认的其余几种', () => {
  expect(secretsIn('OPENAI=sk-proj-abc123def456')).toHaveLength(1)
  expect(secretsIn('token ghp_A1b2C3d4E5f6G7h8')).toHaveLength(1)
  expect(secretsIn('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9')).toHaveLength(1)
  expect(secretsIn('sha 0123456789abcdef0123456789abcdef')).toHaveLength(1)
  expect(secretsIn('blob QmFzZTY0IGVuY29kZWQgc2VjcmV0IGhlcmU9PQ==')).toHaveLength(1)
  expect(secretsIn('log in /home/someone/.ssh')).toHaveLength(1)
  expect(secretsIn('a short sha 5798d05, a task-runner, a risk-free change, Bearer authentication')).toEqual([])
})
test('用例的任何文字字段里有密钥：是问题', () => {
  expect(checkCase({ ...okSubmit, input: { ...okSubmit.input, request: 'use ghp_A1b2C3d4E5f6G7h8 to push' } }, [])).toHaveLength(1)
  expect(checkCase({ ...okMidrun, input: { ...okMidrun.input, latest: { ...step, result: 'wrote /Users/someone/a.ts' } } }, [])).toHaveLength(1)
})
test('一类 15 例：分组 6/4/5、边界和反例不少于 5 且留出集里不少于 2', () => {
  expect(checkSet('submit', fifteen)).toEqual([])
})
test('分组不是 6/4/5、边界和反例不够、id 重复、例数不是 15：都是问题', () => {
  expect(checkSet('submit', fifteen.map((c, i) => (i === 6 ? { ...c, set: 'fit' as const } : c)))).toHaveLength(1)
  expect(checkSet('submit', fifteen.map((c, i) => (i === 0 ? { ...c, difficulty: 'typical' as const } : c)))).toHaveLength(1)
  expect(checkSet('submit', fifteen.map((c, i) => (i === 10 ? { ...c, difficulty: 'typical' as const } : i === 3 ? { ...c, difficulty: 'hard' as const } : c)))).toHaveLength(2)
  expect(checkSet('submit', fifteen.map((c, i) => (i === 1 ? { ...c, id: 'submit-01' } : c)))).toHaveLength(1)
  expect(checkSet('submit', fifteen.slice(0, 14)).length).toBeGreaterThan(0)
})
test('submit：带上一轮的少于 5 例、continues 或 long-unattended 少于 2 例：是问题', () => {
  expect(checkSet('submit', fifteen.map((c, i) => (i === 4 ? { ...c, input: { ...c.input, previous: null } } : c)))).toHaveLength(1)
  expect(checkSet('submit', fifteen.map((c, i) => (i === 1 ? { ...c, tags: [] } : c)))).toHaveLength(1)
  expect(checkSet('submit', fifteen.map((c, i) => (i === 3 ? { ...c, tags: [] } : c)))).toHaveLength(1)
})
test('midrun 合格的一类 15 例没有问题', () => {
  expect(checkSet('midrun', midrunSet(8))).toEqual([])
})
test('midrun 里 hold 少于 8 例：是问题', () => {
  expect(checkSet('midrun', sevenHolds)).toHaveLength(1)
})
test('midrun：某个标签少于 2 例、codeMode 真或假少于 5 例：是问题', () => {
  expect(checkSet('midrun', midrunSet(8).map((c, i) => (i === 5 ? { ...c, tags: [] } : c)))).toHaveLength(1)
  expect(checkSet('midrun', midrunSet(8).map((c) => ({ ...c, input: { ...c.input, codeMode: true } })))).toHaveLength(1)
})
test('agent：应该换低的不少于 3、不该换的不少于 5', () => {
  expect(checkSet('agent', agentFifteen)).toEqual([])
  expect(checkSet('agent', agentFifteen.map((c, i) => (i === 0 ? { ...c, expect: { accept: ['high' as const], models: ['opus' as const] } } : c)))).toHaveLength(1)
  expect(checkSet('agent', agentFifteen.map((c, i) => (i === 3 ? { ...c, expect: { accept: ['high' as const], models: ['sonnet' as const, 'opus' as const] } } : c)))).toHaveLength(1)
})
test('skill：期望不推荐的少于 5 例：是问题', () => {
  expect(checkSet('skill', skillFifteen)).toEqual([])
  expect(checkSet('skill', skillFifteen.map((c, i) => (i === 4 ? { ...c, expect: okSkill.expect } : c)))).toHaveLength(1)
})
test('skill：不推荐的用例里 everyday、uncovered、named-missing 各要有（修订 A7）', () => {
  expect(checkSet('skill', skillFifteen.map((c, i) => (i === 2 ? { ...c, tags: ['everyday'] } : c)))).toHaveLength(1)
  // the tag counts only on a case whose expect.skill is null
  expect(checkSet('skill', skillFifteen.map((c, i) => (i === 2 ? { ...c, tags: ['everyday'] } : i === 7 ? { ...c, tags: ['named-missing'] } : c)))).toHaveLength(1)
})
test('同一会话的用例必须都在同一组（修订 A2、A13）', () => {
  const real = (c: SubmitCase, session: string): SubmitCase => ({ ...c, source: 'real', session })
  const sameSet = fifteen.map((c, i) => (i === 0 || i === 1 ? real(c, '0a10ce6b') : c))
  expect(checkSet('submit', sameSet)).toEqual([])
  const fitAndCheck = fifteen.map((c, i) => (i === 0 || i === 6 ? real(c, '0a10ce6b') : c))
  expect(checkSet('submit', fitAndCheck)).toHaveLength(1)
  const fitAndHeldout = fifteen.map((c, i) => (i === 0 || i === 12 ? real(c, '0a10ce6b') : c))
  expect(checkSet('submit', fitAndHeldout)).toHaveLength(1)
})
