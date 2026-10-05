// The README's configuration table against what the mod ships (#18). Pure: no
// `$`, no fs. The tests feed it tables of their own (tests/docs-sync.test.ts);
// `node dispatch-pilot/eval/validate.ts` runs it on the real README.md and
// plugin.json, which a test file cannot read.
//
// The table is every row under the README's `## 配置` heading (its `###`
// groups included) whose first cell is an option's name in backticks:
//
//   | 选项 | 作用 | Jev | Clef |
//   | `timeoutMs` | how long a message waits | `1500` | `3000` |
//   | `thetaUp` | threshold to raise effort | `0.4` 起点 | `0.4` 未校准 |
//
// Each default cell starts with the default in backticks (`空` for an empty
// text or list, `true` or `false` for a boolean) and may go on with a note:
// 起点 (a starting point, not tuned on eval data; not checked) or, in the
// Clef cell, 未校准 (the value is Jev's, not measured on Clef; checked). No
// cell holds a `|`.

import { BACKEND_DEFAULTS, PER_BACKEND_OPTIONS, type BackendDefaults, type BackendName, type PerBackendOption } from '../../hooks/core/setup.ts'
import type { OptionSpec } from './suite.ts'

type Row = { option: string; cells: string[] }

/** The decision models, as the table's two default columns name them. */
const BACKENDS = [
  { column: 2, label: 'Jev', backend: 'jev' },
  { column: 3, label: 'Clef', backend: 'clef' },
] as const

/** The note that says a Clef value is Jev's. */
const NOT_CALIBRATED = '未校准'

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
 * Whether Clef's value for a per-backend option is Jev's, taken as it is: not
 * measured on Clef. A value of Clef's own (one that differs from Jev's) is not
 * borrowed. A context budget that happens to equal Jev's is still Clef's own
 * measurement when Clef has a most of its own (#17: Clef sometimes reads only
 * the start of a long state), which Jev's budget does not have.
 */
function borrowedByClef(option: PerBackendOption, defaults: Readonly<Record<BackendName, BackendDefaults>>): boolean {
  const measured = option === 'contextTokens' && defaults.clef.contextTokensMax !== defaults.jev.contextTokensMax
  return defaults.clef[option] === defaults.jev[option] && !measured
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
    if (row.cells.length !== 4) {
      problems.push(`\`${option}\`: the row has ${row.cells.length} cells, not 4 (a | inside a cell?)`)
      continue
    }
    if (!perBackend && written(decl.default) === null) {
      problems.push(`\`${option}\`: no default to compare the row with (plugin.json gives none the table can write, and BACKEND_DEFAULTS does not cover it)`)
      continue
    }
    const valid = BACKENDS.map(({ column, label, backend }) => {
      const cell = row.cells[column] ?? ''
      const value = /^`([^`]*)`/.exec(cell)?.[1]
      const expected = perBackend ? String(defaults[backend][option as PerBackendOption]) : written(decl.default)
      if (value === undefined) problems.push(`\`${option}\`: the ${label} cell does not start with the default in backticks`)
      else if (expected !== null && !same(value, expected)) problems.push(`\`${option}\`: the ${label} cell says ${value}, the default is ${expected}`)
      else return true
      return false
    })
    if (perBackend && valid.every(Boolean)) {
      const borrowed = borrowedByClef(option as PerBackendOption, defaults)
      const marked = (row.cells[3] ?? '').includes(NOT_CALIBRATED)
      if (borrowed && !marked) problems.push(`\`${option}\`: the Clef cell should say ${NOT_CALIBRATED}: its value is Jev's, not measured on Clef`)
      if (!borrowed && marked) problems.push(`\`${option}\`: the Clef cell should not say ${NOT_CALIBRATED}: Clef has a value of its own`)
    }
  }
  return problems
}
