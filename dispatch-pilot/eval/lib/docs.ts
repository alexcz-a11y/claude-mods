// The README's configuration table against what the mod ships (#18), and
// DEVELOPMENT.md's 「结构」 tree against the modules under hooks/. Pure: no
// `$`, no fs. The tests feed it tables of their own (tests/docs-sync.test.ts);
// `node dispatch-pilot/eval/validate.ts` runs it on the real README.md and
// plugin.json, which a test file cannot read.
//
// The table is every row under the README's `## 配置` heading (its `###`
// groups included) whose first cell is an option's name in backticks:
//
//   | 选项 | 作用 | Jev | pplx |
//   | `timeoutMs` | how long a message waits | `1500` | `8000` |
//   | `thetaUp` | threshold to raise effort | `0.3` 按 AA 基准 | `0` 离线校准 |
//
// Each default cell starts with the default in backticks (`空` for an empty
// text or list, `true` or `false` for a boolean) and may go on with a note
// (起点, a starting point not tuned on eval data; not checked). No cell holds
// a `|`.

import { BACKEND_DEFAULTS, PER_BACKEND_OPTIONS, type BackendDefaults, type BackendName, type PerBackendOption } from '../../hooks/core/setup.ts'
import type { OptionSpec } from './suite.ts'

type Row = { option: string; cells: string[] }

/**
 * The decision models, in the order of the table's default columns (after the option and what it does), each with the
 * name its column goes by. A new decision model is one more entry here, one in core/setup.ts BACKEND_DEFAULTS and a cell
 * for it in every row of the README's tables.
 */
const BACKENDS: readonly { label: string; backend: BackendName }[] = [
  { label: 'Jev', backend: 'jev' },
  { label: 'pplx', backend: 'pplx' },
]

/** Where the default columns start in a row: the option, then what it does. */
const FIRST_DEFAULT = 2

/** The cells of a row: the option, what it does, and a default for each decision model. */
const CELLS = FIRST_DEFAULT + BACKENDS.length

/** The rows of the README's `## 配置` section; null when it has no such section. */
function configRows(readme: string): Row[] | null {
  const lines = readme.split('\n')
  const start = lines.findIndex((line) => /^## 配置\s*$/.test(line))
  if (start < 0) return null
  const end = lines.findIndex((line, i) => i > start && /^## /.test(line))
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .filter((line) => line.trimStart().startsWith('|'))
    .map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()))
    .flatMap((cells) => {
      const name = /^`([A-Za-z_][A-Za-z0-9_]*)`$/.exec(cells[0] ?? '')
      return name?.[1] === undefined ? [] : [{ option: name[1], cells }]
    })
}

/** A default as the table writes it: the number, boolean or text itself; `空` for an empty text or list. Null for a default it cannot write. */
function written(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? '空' : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.length === 0) return '空'
  return null
}

/** Whether a cell's value is the expected one: numbers by value (`0.40` is `0.4`), the rest as written. */
function same(value: string, expected: string): boolean {
  const [a, b] = [Number(value), Number(expected)]
  return value !== '' && expected !== '' && Number.isFinite(a) && Number.isFinite(b) ? a === b : value === expected
}

/**
 * What is wrong with the README's configuration table, one line each; none
 * when it is in step with `userConfig` (plugin.json) and the decision models'
 * defaults (core/setup.ts BACKEND_DEFAULTS).
 */
export function checkConfigTable(readme: string, userConfig: Readonly<Record<string, OptionSpec>>, defaults: Readonly<Record<BackendName, BackendDefaults>> = BACKEND_DEFAULTS): string[] {
  const rows = configRows(readme)
  if (rows === null) return ['the README has no "## 配置" section']
  const problems: string[] = []
  for (const row of rows) {
    if (!(row.option in userConfig)) problems.push(`\`${row.option}\`: a row in the configuration table, but plugin.json declares no such option`)
  }
  for (const [option, decl] of Object.entries(userConfig)) {
    const perBackend = (PER_BACKEND_OPTIONS as readonly string[]).includes(option)
    if (perBackend && 'default' in decl) {
      problems.push(`\`${option}\`: plugin.json gives a default, but this option's default depends on the decision model (BACKEND_DEFAULTS in core/setup.ts): the engine would hand the mod the manifest's, and the model's own could never apply`)
    }
    const found = rows.filter((row) => row.option === option)
    const [row] = found
    if (row === undefined) {
      problems.push(`\`${option}\`: no row in the configuration table`)
      continue
    }
    if (found.length > 1) {
      problems.push(`\`${option}\`: ${found.length} rows in the configuration table`)
      continue
    }
    if (row.cells.length !== CELLS) {
      problems.push(`\`${option}\`: the row has ${row.cells.length} cells, not ${CELLS} (a | inside a cell?)`)
      continue
    }
    if (!perBackend && written(decl.default) === null) {
      problems.push(`\`${option}\`: no default to compare the row with (plugin.json gives none the table can write, and BACKEND_DEFAULTS does not cover it)`)
      continue
    }
    BACKENDS.forEach(({ label, backend }, i) => {
      const cell = row.cells[FIRST_DEFAULT + i] ?? ''
      const value = /^`([^`]*)`/.exec(cell)?.[1]
      const expected = perBackend ? String(defaults[backend][option as PerBackendOption]) : written(decl.default)
      if (value === undefined) problems.push(`\`${option}\`: the ${label} cell does not start with the default in backticks`)
      else if (expected !== null && !same(value, expected)) problems.push(`\`${option}\`: the ${label} cell says ${value}, the default is ${expected}`)
    })
  }
  return problems
}

/**
 * DEVELOPMENT.md's 「结构」 tree against the modules under hooks/ (`modules`:
 * paths relative to hooks/, such as `core/commands.ts`): every module has a
 * line under its folder, and every line names a module that exists. The tree
 * is the code block after `### 结构`, up to the first line that leaves hooks/
 * (`scripts/...`); a folder is a line ending in `/`.
 */
export function checkStructureTree(development: string, modules: readonly string[]): string[] {
  const start = development.indexOf('### 结构')
  if (start < 0) return ['DEVELOPMENT.md has no "### 结构" section']
  const block = /```\n([\s\S]*?)```/.exec(development.slice(start))?.[1]
  if (block === undefined) return ['the 「结构」 section has no tree']
  const listed: string[] = []
  let folder = ''
  for (const line of block.split('\n').slice(1)) {
    const entry = /^[│ ]*[├└]── (\S+)/.exec(line)?.[1]
    if (entry === undefined) break
    if (entry.endsWith('/')) {
      folder = entry
      continue
    }
    // A line at the top of the tree is hooks/ itself.
    listed.push(/^[├└]/.test(line) ? entry : `${folder}${entry}`)
  }
  return [
    ...modules.filter((module) => !listed.includes(module)).map((module) => `\`${module}\`: no line in DEVELOPMENT.md's 「结构」 tree`),
    ...listed.filter((entry) => !modules.includes(entry)).map((entry) => `\`${entry}\`: in DEVELOPMENT.md's 「结构」 tree, but hooks/ has no such module`),
  ]
}

/** The host closure through which a feature's report raises a toast (core/report.ts `ReportIo.toast`): the one way to `$.ui.toast`. */
const TOAST_CLOSURE = 'toast: (text) => $.ui.toast(text)'

/**
 * ADR 0004: the decision report is the one writer of what people see, and the
 * terminal no longer has a status row (#29). No module (`sources`: text by
 * path relative to hooks/) draws on `$.ui.status`, the report's own included;
 * a toast is raised only by the report, reached through the host closure a
 * file hands it, `toast: (text) => $.ui.toast(text)`; the old status line's
 * and decision recorder's calls are gone for good.
 */
export function checkOneWriter(sources: Readonly<Record<string, string>>): string[] {
  // The files that show people nothing themselves (#33): the debug log closure they hand the report is the only `$.ui` they hold.
  const silent: [string, RegExp, string][] = [['features/skill-profiles.ts', /\$\.ui\./, 'uses `$.ui` itself (a log line, a toast, the status row)']]
  const rules: [RegExp, string][] = [
    [/\$\.ui\.status\(/, 'draws on the status row (`$.ui.status`), which the band and the footer replace'],
    [/\$\.ui\.toast\(/, 'raises a toast itself'],
    [/\b(?:setStatus|pauseStatus|recordDecision)\(/, 'calls a writer of the old status line or decision log'],
  ]
  const problems: string[] = []
  for (const [path, text] of Object.entries(sources)) {
    const code = text.split(TOAST_CLOSURE).join('')
    for (const [pattern, what] of rules) if (pattern.test(code)) problems.push(`\`${path}\`: ${what}; hand the decision report the data instead (ADR 0004)`)
    const quiet = code.split("debug: (line) => $.ui.log(line, { to: 'debug' })").join('')
    for (const [file, pattern, what] of silent) if (path === file && pattern.test(quiet)) problems.push(`\`${path}\`: ${what}; hand the decision report the data instead (ADR 0004)`)
    // The report's two entries (spec #22): features and screens call `report`, the core `reportStep`.
    if (path === 'core/report.ts') {
      for (const [, name] of code.matchAll(/export\s+(?:async\s+)?(?:function\s+|const\s+)(report\w*)/g)) {
        if (name !== 'report' && name !== 'reportStep') problems.push(`\`${path}\`: exports \`${name}\`, a third entry; give \`report\` a new kind of \`Reported\` instead (spec #22: two entries)`)
      }
    }
  }
  return problems
}
