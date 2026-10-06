// The README's configuration table against what the mod ships (#18): every
// option plugin.json declares has a row, and the Jev and Clef cells give the
// default the mod really uses (the manifest's `default`, or for the options
// whose default depends on the decision model, core/setup.ts BACKEND_DEFAULTS).
//
// The seam is the pure checker `checkConfigTable` (eval/lib/docs.ts), the one
// `node dispatch-pilot/eval/validate.ts` runs on the real README.md and
// plugin.json. These tests feed it small tables of their own: a test file runs
// in an environment with no fs (`claude plugin test` loads it like a hooks
// module), so it cannot read the real files; that run is the Node script's.

import { expect, test } from 'claude-code/testing'
import { BACKEND_DEFAULTS } from '../hooks/core/setup.ts'
import { checkConfigTable, checkOneWriter, checkStructureTree } from '../eval/lib/docs.ts'

/** The decision models' defaults as these tests state them: Clef's timeout is its own, its other values are Jev's. */
const DEFAULTS = {
  jev: { ...BACKEND_DEFAULTS.jev, timeoutMs: 1500, thetaUp: 0.4 },
  clef: { ...BACKEND_DEFAULTS.jev, timeoutMs: 3000, thetaUp: 0.4 },
}

/** Some of plugin.json's options: one of each kind of default, and two whose default depends on the decision model (no `default`). */
const MANIFEST = {
  decisionModel: { type: 'string', default: 'jev' },
  typesafeApiKey: { type: 'string', default: '', sensitive: true },
  rejudgeEvery: { type: 'number', default: 3 },
  agentFable: { type: 'boolean', default: false },
  skillsAlwaysListed: { type: 'string', multiple: true, default: [] },
  timeoutMs: { type: 'number' },
  thetaUp: { type: 'number' },
}

/** The rows that agree with MANIFEST and DEFAULTS. */
const ROWS = {
  decisionModel: '| `decisionModel` | Which decision model decides | `jev` | `jev` |',
  typesafeApiKey: '| `typesafeApiKey` | TypeSafe API key | `空` | `空` |',
  rejudgeEvery: '| `rejudgeEvery` | Re-decide every N steps | `3` 起点 | `3` 起点 |',
  agentFable: '| `agentFable` | Let agents run on fable | `false` | `false` |',
  skillsAlwaysListed: '| `skillsAlwaysListed` | Skills always listed | `空` | `空` |',
  timeoutMs: '| `timeoutMs` | How long a message waits | `1500` | `3000` |',
  thetaUp: '| `thetaUp` | Threshold to raise effort | `0.4` 起点 | `0.4` 未校准 |',
}

/** The rows but those for `options`. */
const without = (...options: (keyof typeof ROWS)[]): string[] => Object.entries(ROWS).flatMap(([name, row]) => (options.some((option) => option === name) ? [] : [row]))

/** A README whose configuration section holds `rows`, with tables of the same shape elsewhere that must not be read. */
function readme(rows: readonly string[], heading = '## 配置'): string {
  return [
    '# Dispatch Pilot',
    '',
    '## 要求',
    '',
    '| 选项 | 作用 | Jev | Clef |',
    '|---|---|---|---|',
    '| `notAnOption` | a row outside the configuration section | `1` | `2` |',
    '',
    heading,
    '',
    '### 决策模型',
    '',
    '| 选项 | 作用 | Jev | Clef |',
    '|---|---|---|---|',
    ...rows,
    '',
    '## 控制',
    '',
    '| `/dp` | not a row either | `x` | `y` |',
    '',
  ].join('\n')
}

test('a table that gives every option its Jev and Clef default passes', () => {
  expect(checkConfigTable(readme(Object.values(ROWS)), MANIFEST, DEFAULTS)).toEqual([])
})

test('an option the table leaves out is named', () => {
  const problems = checkConfigTable(readme(without('rejudgeEvery')), MANIFEST, DEFAULTS)
  expect(problems).toHaveLength(1)
  expect(problems[0]).toContain('`rejudgeEvery`')
  expect(problems[0]).toContain('no row')
})

test("a default that is not the manifest's is reported with both values, once for each decision model's column", () => {
  const stale = '| `rejudgeEvery` | Re-decide every N steps | `5` 起点 | `4` 起点 |'
  const problems = checkConfigTable(readme([...without('rejudgeEvery'), stale]), MANIFEST, DEFAULTS)
  expect(problems).toHaveLength(2)
  expect(problems[0]).toMatch(/`rejudgeEvery`.*Jev.*5.*3/)
  expect(problems[1]).toMatch(/`rejudgeEvery`.*Clef.*4.*3/)
})

test("an option whose default depends on the decision model is held to each model's own value: Jev's column to Jev's, Clef's to Clef's", () => {
  const swapped = '| `timeoutMs` | How long a message waits | `3000` | `1500` |'
  const problems = checkConfigTable(readme([...without('timeoutMs'), swapped]), MANIFEST, DEFAULTS)
  expect(problems).toHaveLength(2)
  expect(problems[0]).toMatch(/`timeoutMs`.*Jev.*3000.*1500/)
  expect(problems[1]).toMatch(/`timeoutMs`.*Clef.*1500.*3000/)
})

test('an empty default is written 空 and a boolean true or false: another way of writing them is reported', () => {
  const problems = checkConfigTable(
    readme([...without('typesafeApiKey', 'agentFable'), '| `typesafeApiKey` | TypeSafe API key | `""` | `空` |', '| `agentFable` | Let agents run on fable | `false` | `关` |']),
    MANIFEST,
    DEFAULTS,
  )
  expect(problems).toHaveLength(2)
  expect(problems[0]).toMatch(/`typesafeApiKey`.*Jev.*""/)
  expect(problems[1]).toMatch(/`agentFable`.*Clef.*关.*false/)
})

test('a cell that does not start with its value in backticks is reported', () => {
  const problems = checkConfigTable(readme([...without('rejudgeEvery'), '| `rejudgeEvery` | Re-decide every N steps | 3 | `3` |']), MANIFEST, DEFAULTS)
  expect(problems).toHaveLength(1)
  expect(problems[0]).toMatch(/`rejudgeEvery`.*Jev.*backticks/)
})

test('a number is compared by value, whatever way it is written', () => {
  const problems = checkConfigTable(readme([...without('thetaUp', 'timeoutMs'), '| `thetaUp` | Threshold to raise effort | `0.40` | `0.4` 未校准 |', '| `timeoutMs` | How long a message waits | `1500.0` | `3000` |']), MANIFEST, DEFAULTS)
  expect(problems).toEqual([])
})

test('a row for an option plugin.json does not declare is reported: it is left over from an option that was removed or renamed', () => {
  const problems = checkConfigTable(readme([...Object.values(ROWS), '| `rejudgeEveryN` | Re-decide every N steps | `3` | `3` |']), MANIFEST, DEFAULTS)
  expect(problems).toHaveLength(1)
  expect(problems[0]).toContain('`rejudgeEveryN`')
  expect(problems[0]).toContain('plugin.json')
})

test('an option with two rows is reported', () => {
  const problems = checkConfigTable(readme([...Object.values(ROWS), ROWS.rejudgeEvery]), MANIFEST, DEFAULTS)
  expect(problems).toHaveLength(1)
  expect(problems[0]).toMatch(/`rejudgeEvery`.*(two|2) rows/)
})

test('a row that does not have four cells is reported: a | inside a cell shifts the cells after it', () => {
  const problems = checkConfigTable(readme([...without('rejudgeEvery'), '| `rejudgeEvery` | Every N steps, or 0 | for never | `3` | `3` |']), MANIFEST, DEFAULTS)
  expect(problems).toHaveLength(1)
  expect(problems[0]).toMatch(/`rejudgeEvery`.*5 cells.*4/)
})

test('a README with no configuration section is one problem, not one for each option', () => {
  expect(checkConfigTable(readme(Object.values(ROWS), '## 配置项'), MANIFEST, DEFAULTS)).toEqual(['the README has no "## 配置" section'])
})

test('an option the manifest gives no default and that no decision model gives one has nothing to compare: reported once', () => {
  const problems = checkConfigTable(readme([...Object.values(ROWS), '| `mystery` | An option without a default | `1` | `1` |']), { ...MANIFEST, mystery: { type: 'number' } }, DEFAULTS)
  expect(problems).toHaveLength(1)
  expect(problems[0]).toContain('`mystery`')
})

test("an option whose default depends on the decision model must not also have one in plugin.json: the engine would hand the mod that one, and the decision model's own could never apply", () => {
  const problems = checkConfigTable(readme(Object.values(ROWS)), { ...MANIFEST, timeoutMs: { type: 'number', default: 1500 } }, DEFAULTS)
  expect(problems).toHaveLength(1)
  expect(problems[0]).toMatch(/`timeoutMs`.*plugin\.json.*BACKEND_DEFAULTS/)
})

test("Clef's cell says 未校准 when its value is Jev's, and does not when the value is its own", () => {
  const unmarked = checkConfigTable(readme([...without('thetaUp'), '| `thetaUp` | Threshold to raise effort | `0.4` 起点 | `0.4` |']), MANIFEST, DEFAULTS)
  expect(unmarked).toHaveLength(1)
  expect(unmarked[0]).toMatch(/`thetaUp`.*Clef.*未校准/)
  const stale = checkConfigTable(readme([...without('timeoutMs'), '| `timeoutMs` | How long a message waits | `1500` | `3000` 未校准 |']), MANIFEST, DEFAULTS)
  expect(stale).toHaveLength(1)
  expect(stale[0]).toMatch(/`timeoutMs`.*Clef.*not.*未校准/)
})

test("Clef's context budget keeps Jev's default and is still measured: it is capped where Jev's is not, so its cell does not say 未校准", () => {
  const manifest = { contextTokens: { type: 'number' } }
  const defaults = { jev: { ...BACKEND_DEFAULTS.jev, contextTokens: 2000, contextTokensMax: 16000 }, clef: { ...BACKEND_DEFAULTS.jev, contextTokens: 2000, contextTokensMax: 2000 } }
  expect(checkConfigTable(readme(['| `contextTokens` | Context budget | `2000` | `2000`，最多 2000 |']), manifest, defaults)).toEqual([])
  expect(checkConfigTable(readme(['| `contextTokens` | Context budget | `2000` | `2000` 未校准 |']), manifest, defaults)).toHaveLength(1)
})

// DEVELOPMENT.md's 「结构」 tree against the modules under hooks/: every module has its line, under its folder.

/** A DEVELOPMENT.md whose 「结构」 tree lists these lines. */
function development(lines: readonly string[]): string {
  return ['# 开发', '', '### 结构', '', '```', 'hooks/', ...lines, '```', '', '### 测试'].join('\n')
}

const TREE = [
  '├── dispatch-pilot.ts       入口',
  '├── features/               每项功能一个文件',
  '│   └── main-effort.ts      发消息时判断主 agent 的 effort',
  '├── core/                   共用的机制',
  '│   ├── core.ts             核心的 hook',
  '│   └── prompts.ts          isPersonsMessage',
]

test('a tree that lists every module under its folder passes', () => {
  expect(checkStructureTree(development(TREE), ['dispatch-pilot.ts', 'features/main-effort.ts', 'core/core.ts', 'core/prompts.ts'])).toEqual([])
})

test('a module the tree does not list, and a line for a module that is gone, are both problems', () => {
  const problems = checkStructureTree(development(TREE), ['dispatch-pilot.ts', 'features/main-effort.ts', 'core/core.ts', 'core/commands.ts'])
  expect(problems).toHaveLength(2)
  expect(problems[0]).toMatch(/`core\/commands\.ts`.*no line/)
  expect(problems[1]).toMatch(/`core\/prompts\.ts`.*no such module/)
})

// ADR 0004: the decision report is the one writer of what people see, and no screen of the mod is the status row
// (#29): a feature hands over structured data, and reaches the toast only through the closure it hands the report.

test('files that hand the report their data, and only plumb the host to it, pass', () => {
  expect(
    checkOneWriter({
      'features/main-effort.ts': "const io = { debug: log, now: () => $.clock.now(), toast: (text) => $.ui.toast(text) }\nawait reportDecision(io, decision)\nconst why = failureText(name, failure)",
      'core/report.ts': "function stepIo($) { return { toast: (text) => $.ui.toast(text) } }\nio.toast(`主 agent 未路由：${why}`)",
      'board/screens.tsx': "$.ui.invalidate('ui.render')",
    }),
  ).toEqual([])
})

test('a file that draws on the status row, the report included, raises a toast itself, or calls a writer of the old line is a problem', () => {
  const problems = checkOneWriter({
    'core/report.ts': "status: (line) => $.ui.status(line),\n$.ui.status('dp effort high')",
    'features/a.ts': "$.ui.toast('jev: HTTP 500')",
    'features/b.ts': "setStatus('agent', null, show)\nawait recordDecision(cell, log, decision)",
    'board/band.tsx': '$.ui.status(undefined)',
  })
  expect(problems.map((problem) => problem.split(':')[0])).toEqual(['`core/report.ts`', '`features/a.ts`', '`features/b.ts`', '`board/band.tsx`'])
})

test('skill-profiles holds only the debug closure of `$.ui`: a log line, a toast or a status of its own is a problem', () => {
  const closure = "const io = { debug: (line) => $.ui.log(line, { to: 'debug' }), profiles }\nawait reportProfiles(io, event)"
  expect(checkOneWriter({ 'features/skill-profiles.ts': closure })).toEqual([])
  // Other files may log: the rule is skill-profiles'.
  expect(checkOneWriter({ 'features/skills.ts': "$.ui.log('skills: 3', { to: 'debug' })" })).toEqual([])
  for (const direct of ["$.ui.log('skill profiles: 3 kept', { to: 'debug' })", "$.ui.toast('profiles failed')"]) {
    const problems = checkOneWriter({ 'features/skill-profiles.ts': `${closure}\n${direct}` })
    expect(problems).toContainEqual(expect.stringMatching(/^`features\/skill-profiles\.ts`: uses `\$\.ui` itself/))
  }
})
