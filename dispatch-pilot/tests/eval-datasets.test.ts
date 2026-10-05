// The eval datasets' format (seam 2's data side): what `eval/validate.ts`
// accepts and refuses, for each of the four kinds of dataset. Pure: the
// validator reads parsed JSONL, no disk.

import { expect, test } from 'claude-code/testing'
import { parseJsonl, validateDataset } from '../eval/lib/datasets.ts'

/** A well-formed effort-submit item; `change` edits a copy. */
function submit(id: string, change: (item: any) => void = () => {}): any {
  const item = {
    id,
    zh: {
      message: '继续',
      recent_context: [
        { role: 'user', text: '把 `fetchData` 统一改名成 `loadData`' },
        { role: 'assistant', text: '已改完 70 个文件，要继续吗？', tools: ['Grep', 'Edit'] },
      ],
    },
    en: {
      message: 'Continue.',
      recent_context: [
        { role: 'user', text: 'Rename every `fetchData` to `loadData`.' },
        { role: 'assistant', text: '70 files are done; shall I go on?', tools: ['Grep', 'Edit'] },
      ],
    },
    gold: 'low',
    accept: ['low', 'medium'],
    rationale: 'gold 为 low：照着已定的改法继续机械替换。',
    difficulty: 'hard',
    tags: ['continuation'],
  }
  change(item)
  return item
}

test('an effort-submit dataset passes when every item is well formed', () => {
  const checked = validateDataset('effort-submit', [submit('submit-001'), submit('submit-002', (i) => (i.zh.recent_context = i.en.recent_context = []))])
  expect(checked.errors).toEqual([])
  expect(checked.warnings).toEqual([])
})

test('each broken effort-submit rule is reported with the id of the item that breaks it', () => {
  const items = [
    submit('submit-001', (i) => (i.accept = ['medium', 'high'])), // gold not accepted
    submit('submit-002', (i) => {
      i.gold = 'medium'
      i.accept = ['low', 'medium', 'xhigh'] // a gap
    }),
    submit('submit-003', (i) => (i.gold = 'huge')),
    submit('submit-004', (i) => i.en.recent_context.pop()), // zh and en differ
    submit('submit-005', (i) => (i.en.recent_context[1].tools = ['Grep'])),
    submit('submit-006', (i) => (i.zh.message = '')),
    submit('submit-007', (i) => (i.difficulty = 'easy')),
    submit('submit-008', (i) => delete i.rationale),
    submit('submit-008'), // the same id twice
  ]
  const { errors } = validateDataset('effort-submit', items)
  const byId = (id: string) => errors.filter((e) => e.startsWith(`${id}:`))
  expect(byId('submit-001').join('\n')).toMatch(/gold "low" is not in accept/)
  expect(byId('submit-002').join('\n')).toMatch(/not contiguous/)
  expect(byId('submit-003').join('\n')).toMatch(/gold.*not an effort level/)
  expect(byId('submit-004').join('\n')).toMatch(/recent_context/)
  expect(byId('submit-005').join('\n')).toMatch(/tools/)
  expect(byId('submit-006').join('\n')).toMatch(/zh\.message/)
  expect(byId('submit-007').join('\n')).toMatch(/difficulty/)
  expect(byId('submit-008').join('\n')).toMatch(/rationale/)
  expect(byId('submit-008').join('\n')).toMatch(/appears twice/)
  expect(errors.length).toBe(9)
})

test('a dataset-wide quota the drafting rules ask for is a warning, not an error', () => {
  const items = ['001', '002', '003', '004'].map((n, i) => submit(`submit-${n}`, (item) => (item.difficulty = i < 2 ? 'hard' : 'medium')))
  const checked = validateDataset('effort-submit', items)
  expect(checked.errors).toEqual([])
  expect(checked.warnings.join('\n')).toMatch(/hard.*50%.*70%/)
})

/** A well-formed effort-midturn item: the next step of a turn, given the turn so far. */
function midturn(id: string, change: (item: any) => void = () => {}): any {
  const asked = (language: 'zh' | 'en') => ({
    message: language === 'zh' ? '给 `parseDuration` 先写测试再实现' : 'Write the tests for `parseDuration` first, then implement it.',
    step: 3,
    current_effort: 'medium',
    counts: { judgments: 2, changes: 0, failures: 1, hook_blocks: 0 },
    recent_steps: [
      {
        assistant_text: language === 'zh' ? '跑一下，预期全部失败。' : 'Running them; I expect them all to fail.',
        tools: [
          {
            name: 'Bash',
            result: language === 'zh' ? '失败：7 个新用例失败' : 'Failed: the 7 new cases failed',
            input: { command: 'npx vitest run duration', description: language === 'zh' ? '跑 duration 的测试' : 'Run the duration tests' },
          },
        ],
      },
    ],
  })
  const item = { id, zh: asked('zh'), en: asked('en'), gold: 'medium', accept: ['medium'], rationale: '计划内的 TDD 红灯，保持。', difficulty: 'hard', tags: ['tdd-red'] }
  change(item)
  return item
}

test("effort-midturn: each tool call's input holds only the arguments that say what it worked on, the same in both languages but for its description", () => {
  const items = [
    midturn('midturn-001', (i) => delete i.zh.recent_steps[0].tools[0].input),
    midturn('midturn-002', (i) => (i.en.recent_steps[0].tools[0].input.new_string = 'expect(parseDuration("1h")).toBe(3600)')),
    midturn('midturn-003', (i) => (i.en.recent_steps[0].tools[0].input.command = 'npx vitest run')),
    midturn('midturn-004', (i) => (i.zh.recent_steps[0].tools[0].input.command = '')),
  ]
  const { errors } = validateDataset('effort-midturn', items)
  const of = (id: string) => errors.filter((e) => e.startsWith(`${id}:`)).join('\n')
  expect(of('midturn-001')).toMatch(/zh\.recent_steps\[0\]\.tools\[0\]\.input must be an object/)
  expect(of('midturn-002')).toMatch(/en\.recent_steps\[0\]\.tools\[0\]\.input has new_string: an input holds only description, skill, name, file_path, notebook_path, pattern, query, url, command/)
  expect(of('midturn-003')).toMatch(/recent_steps\[0\]\.tools\[0\]\.input\.command differs between zh and en/)
  expect(of('midturn-004')).toMatch(/zh\.recent_steps\[0\]\.tools\[0\]\.input\.command must be a non-empty string/)
})

test('effort-midturn: the turn so far is the same in both languages, each tool result says how it ended, accept is at most two levels', () => {
  expect(validateDataset('effort-midturn', [midturn('midturn-001')])).toEqual({ errors: [], warnings: [] })

  const items = [
    midturn('midturn-001', (i) => (i.en.step = 4)),
    midturn('midturn-002', (i) => (i.en.counts.failures = 2)),
    midturn('midturn-003', (i) => (i.zh.current_effort = 'high')),
    midturn('midturn-004', (i) => (i.zh.recent_steps[0].tools[0].result = '7 个新用例失败')), // no outcome prefix
    midturn('midturn-005', (i) => (i.en.recent_steps[0].tools[0].result = 'Success: all passed')), // outcomes differ
    midturn('midturn-006', (i) => (i.en.recent_steps[0].tools[0].name = 'Read')),
    midturn('midturn-007', (i) => {
      i.gold = 'high'
      i.accept = ['medium', 'high', 'xhigh']
    }),
    midturn('midturn-008', (i) => (i.zh.counts = { judgments: 2, changes: 0, failures: -1, hook_blocks: 0 })),
  ]
  const { errors } = validateDataset('effort-midturn', items)
  const of = (id: string) => errors.filter((e) => e.startsWith(`${id}:`)).join('\n')
  expect(of('midturn-001')).toMatch(/step differs between zh and en/)
  expect(of('midturn-002')).toMatch(/counts differ between zh and en/)
  expect(of('midturn-003')).toMatch(/current_effort differs between zh and en/)
  expect(of('midturn-004')).toMatch(/zh\.recent_steps\[0\]\.tools\[0\]\.result must start with/)
  expect(of('midturn-005')).toMatch(/outcome differs between zh and en/)
  expect(of('midturn-006')).toMatch(/name differs between zh and en/)
  expect(of('midturn-007')).toMatch(/at most two levels/)
  expect(of('midturn-008')).toMatch(/zh\.counts\.failures must be a whole number/)
  expect(errors.length).toBe(9) // 008: its counts also differ from en's
})

/** A well-formed subagent item: one dispatch (`agent`) or one `agent()` of a Workflow script (`workflow`). */
function subagent(id: string, kind: 'agent' | 'workflow', change: (item: any) => void = () => {}): any {
  const asked = (language: 'zh' | 'en') => ({
    user_message: language === 'zh' ? '查一下哪些文件还在用旧的日志库' : 'Find which files still use the old logging library.',
    kind,
    agent_type: kind === 'agent' ? 'Explore' : null,
    description: kind === 'agent' ? (language === 'zh' ? '查找旧日志库' : 'Find old logger uses') : null,
    prompt: language === 'zh' ? '列出 ${file} 里所有 `oldlog` 的调用' : 'List every `oldlog` call in ${file}',
    requested_model: null,
    workflow_description: kind === 'workflow' ? (language === 'zh' ? '逐文件查找 → 汇总' : 'Search each file → summarize') : null,
    label: kind === 'workflow' ? 'find:${file}' : null,
  })
  const item = {
    id,
    zh: asked('zh'),
    en: asked('en'),
    gold: { model: 'haiku', effort: null },
    accept: { model: ['haiku', 'sonnet'], effort: [null, 'low'] },
    rationale: '只读的机械查找，haiku 足够；sonnet low 也可以。',
    difficulty: 'hard',
    tags: ['search', 'priority:none'],
  }
  change(item)
  return item
}

test('subagent: haiku goes with no effort and any other model with a level; the dispatch kind fixes which fields are set; priority tags agree with the answer', () => {
  expect(validateDataset('subagent', [subagent('subagent-001', 'agent'), subagent('subagent-002', 'workflow')]).errors).toEqual([])

  const items = [
    subagent('subagent-001', 'agent', (i) => (i.gold = { model: 'haiku', effort: 'low' })),
    subagent('subagent-002', 'agent', (i) => (i.gold = { model: 'sonnet', effort: null })),
    subagent('subagent-003', 'agent', (i) => (i.accept = { model: ['haiku', 'sonnet'], effort: ['low'] })), // haiku accepted, null not
    subagent('subagent-004', 'agent', (i) => (i.accept = { model: ['haiku', 'sonnet'], effort: [null, 'low', 'high'] })),
    subagent('subagent-005', 'workflow', (i) => (i.en.label = null)),
    subagent('subagent-006', 'agent', (i) => (i.zh.workflow_description = '一个工作流')),
    subagent('subagent-007', 'agent', (i) => (i.en.requested_model = 'opus')),
    subagent('subagent-008', 'agent', (i) => (i.tags = ['search'])), // no priority tag
    subagent('subagent-009', 'agent', (i) => {
      // The person named sonnet: it must be the only acceptable model.
      i.tags = ['priority:user']
      i.gold = { model: 'sonnet', effort: 'low' }
    }),
    subagent('subagent-010', 'agent', (i) => {
      i.zh.requested_model = i.en.requested_model = 'opus'
      i.tags = ['priority:main-kept'] // kept, yet gold is not opus
    }),
    subagent('subagent-011', 'agent', (i) => {
      i.gold = { model: 'fable', effort: 'max' }
      i.accept = { model: ['fable'], effort: ['max'] } // fable without its tag
    }),
  ]
  const { errors } = validateDataset('subagent', items)
  const of = (id: string) => errors.filter((e) => e.startsWith(`${id}:`)).join('\n')
  expect(of('subagent-001')).toMatch(/gold: haiku takes no effort/)
  expect(of('subagent-002')).toMatch(/gold: sonnet needs an effort level/)
  expect(of('subagent-003')).toMatch(/accept\.effort holds null exactly when accept\.model holds haiku/)
  expect(of('subagent-004')).toMatch(/accept\.effort .* not contiguous/)
  expect(of('subagent-005')).toMatch(/en\.label: a workflow agent has a label/)
  expect(of('subagent-006')).toMatch(/zh\.workflow_description: a dispatched agent has none/)
  expect(of('subagent-007')).toMatch(/requested_model differs between zh and en/)
  expect(of('subagent-008')).toMatch(/exactly one priority:\* tag/)
  expect(of('subagent-009')).toMatch(/priority:user.*only acceptable model/)
  expect(of('subagent-010')).toMatch(/priority:main-kept.*gold\.model/)
  expect(of('subagent-011')).toMatch(/fable.*tag/)
})

/** The catalog snapshot skill items are written against (only the fields the validator reads). */
const CATALOG = {
  skills: [
    { name: 'code-review', status: 'candidate' },
    { name: 'simplify', status: 'candidate' },
    { name: 'pr', status: 'candidate' },
    { name: 'wizard', status: 'user-only-frontmatter' },
    { name: 'claude-handoff', status: 'off' },
  ],
}

function skill(id: string, change: (item: any) => void = () => {}): any {
  const asked = (language: 'zh' | 'en') => ({ message: language === 'zh' ? '这些改动对得上 #7 吗？' : 'Do these changes match #7?', recent_context: [] })
  const item = {
    id,
    zh: asked('zh'),
    en: asked('en'),
    gold: ['code-review'],
    accept: ['code-review'],
    must_not: ['simplify', 'claude-handoff'],
    user_only_hint: [],
    rationale: '对照原始票审查改动，正是 code-review。',
    difficulty: 'hard',
    tags: ['near-duplicate'],
  }
  change(item)
  return item
}

test('skill: answers name skills of the catalog by what they are for: candidates to recommend, user-only ones to hint, any to rule out', () => {
  expect(validateDataset('skill', [skill('skill-001'), skill('skill-002', (i) => (i.gold = i.accept = []))], { catalog: CATALOG }).errors).toEqual([])

  const items = [
    skill('skill-001', (i) => (i.accept = ['pr'])), // gold not accepted
    skill('skill-002', (i) => (i.gold = [])), // nothing to recommend, yet something is acceptable
    skill('skill-003', (i) => (i.must_not = ['code-review'])),
    skill('skill-004', (i) => (i.gold = i.accept = ['wizard'])), // user-only: a hint, never a recommendation
    skill('skill-005', (i) => (i.user_only_hint = ['pr'])),
    skill('skill-006', (i) => (i.must_not = ['no-such-skill'])),
    skill('skill-007', (i) => (i.accept = ['code-review', 'code-review'])),
  ]
  const { errors } = validateDataset('skill', items, { catalog: CATALOG })
  const of = (id: string) => errors.filter((e) => e.startsWith(`${id}:`)).join('\n')
  expect(of('skill-001')).toMatch(/gold "code-review" is not in accept/)
  expect(of('skill-002')).toMatch(/gold is empty.*accept must be empty/)
  expect(of('skill-003')).toMatch(/"code-review" is both acceptable and in must_not/)
  expect(of('skill-004')).toMatch(/gold: "wizard" is not a candidate/)
  expect(of('skill-005')).toMatch(/user_only_hint: "pr" is not a user-only skill/)
  expect(of('skill-006')).toMatch(/must_not: "no-such-skill" is not in the catalog/)
  expect(of('skill-007')).toMatch(/accept names "code-review" twice/)

  // Names cannot be checked without the catalog: that is an error of the run, not of an item.
  expect(validateDataset('skill', [skill('skill-001')]).errors).toEqual(['skill items need the catalog (skill-catalog.json beside skill.jsonl) to check skill names'])
})

test('JSONL lines that are not JSON objects are named by line number', () => {
  const parsed = parseJsonl('{"id":"a"}\n\nnot json\n[1]\n{"id":"b"}\n')
  expect(parsed.items.map((i: any) => i.id)).toEqual(['a', 'b'])
  expect(parsed.errors).toEqual(['line 3: not JSON', 'line 4: not a JSON object'])
})
