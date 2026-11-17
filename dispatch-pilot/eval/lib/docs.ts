// What the docs and the code must agree on, checked as text: the README's configuration table against what the mod ships (#18,
// `checkConfigTable`), DEVELOPMENT.md's 「结构」 tree against the modules under hooks/ (`checkStructureTree`), the README's list of
// switches against the switches the code defines (`checkSwitchList`), each switch against its option in plugin.json
// (`checkSwitchOptions`, ADR 0027), and, over the sources of hooks/, the rules the docs state:
// the decision report is the one writer of what people see (`checkOneWriter`, ADR 0004) and `$` never leaves the file of its
// hook (`checkEngineStaysHome`). Pure: no `$`, no fs. The tests feed it tables of their own (tests/docs-sync.test.ts);
// `node dispatch-pilot/eval/validate.ts` runs it on the real README.md and plugin.json, which a test file cannot read.
//
// The table is every row under the README's `## 配置` heading (its `###`
// groups included) whose first cell is an option's name in backticks, then a cell for each decision model (BACKENDS):
//
//   | 选项 | 作用 | Drex Max | Jev | pplx | d1-ultra | d1.1 |
//   | `timeoutMs` | how long a message waits | `2500` | `1500` | `8000` | `4000` | `3500` |
//   | `contextTokens` | the state's budget | `6000` | `6000` | `6000` | `6000` | `6000` |
//
// Each default cell starts with the default in backticks (`空` for an empty
// text or list, `true` or `false` for a boolean) and may go on with a note
// (起点, a starting point not tuned on eval data; not checked). No cell holds
// a `|`.

import { BACKEND_DEFAULTS, PER_BACKEND_OPTIONS, type BackendDefaults, type BackendName, type PerBackendOption } from '../../hooks/core/setup.ts'
import { MASTER, optionOf } from '../../hooks/core/switches.ts'
import type { OptionSpec } from './suite.ts'

type Row = { option: string; cells: string[] }

/**
 * The decision models, in the order of the table's default columns (after the option and what it does), each with the
 * name its column goes by. A new decision model is one more entry here, one in core/setup.ts BACKEND_DEFAULTS and a cell
 * for it in every row of the README's tables.
 */
const BACKENDS: readonly { label: string; backend: BackendName }[] = [
  { label: 'Drex Max', backend: 'drex' },
  { label: 'Jev', backend: 'jev' },
  { label: 'pplx', backend: 'pplx' },
  { label: 'd1-ultra', backend: 'd1-ultra' },
  { label: 'd1.1', backend: 'd1.1' },
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

/**
 * The switches the code defines (`sources`: text by path relative to hooks/): the `name` of every `defineSwitch({ ... })`,
 * a string in quotes or a constant of the same file (`const SWITCH = 'visual-check'`).
 */
export function declaredSwitches(sources: Readonly<Record<string, string>>): string[] {
  const names = new Set<string>()
  for (const text of Object.values(sources)) {
    for (const [, name] of text.matchAll(/defineSwitch\(\s*\{\s*name:\s*([^,\s}]+)/g)) {
      const literal = /^(['"])(.*)\1$/.exec(name ?? '')?.[2]
      const constant = literal === undefined ? new RegExp(`const\\s+${name}\\s*=\\s*(['"])([^'"]*)\\1`).exec(text)?.[2] : undefined
      const found = literal ?? constant
      if (found !== undefined) names.add(found)
    }
  }
  return [...names]
}

/**
 * The README's list of `/dp <功能>` switches against the switches the code defines (`declared`, from declaredSwitches):
 * the sentence that starts with 功能的开关是 (up to its first 。 or ；) names each of them in backticks, and nothing else.
 */
export function checkSwitchList(readme: string, declared: readonly string[]): string[] {
  const sentence = /功能的开关是([^。；\n]*)/.exec(readme)?.[1]
  if (sentence === undefined) return ['the README has no sentence that starts with "功能的开关是"']
  const listed = [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '')
  return [
    ...declared.filter((name) => !listed.includes(name)).map((name) => `\`${name}\`: a switch the code defines, but the README's list of switches (功能的开关是) does not name it`),
    ...listed.filter((name) => !declared.includes(name)).map((name) => `\`${name}\`: in the README's list of switches (功能的开关是), but the code defines no such switch`),
  ]
}

/** A switch as the code defines it: its name, what `/dp` says it does, and whether it is on until flipped. */
export type DeclaredSwitch = { name: string; info: string; default: boolean }

/**
 * The switches the code defines, each with its `info` and default (`sources`: text by path relative to hooks/): every
 * `defineSwitch({ name, info: '...' })` written on one line, as each feature writes it; off by default only with `default: false`.
 */
export function declaredSwitchSpecs(sources: Readonly<Record<string, string>>): DeclaredSwitch[] {
  const found: DeclaredSwitch[] = []
  for (const source of Object.values(sources)) {
    // A comment may show a call as an example (core/switches.ts does): only the code defines a switch.
    const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const [call, name, info] of text.matchAll(/defineSwitch\(\s*\{\s*name:\s*([^,\s}]+),\s*info:\s*'((?:[^'\\]|\\.)*)'[^\n]*/g)) {
      const literal = /^(['"])(.*)\1$/.exec(name ?? '')?.[2]
      const constant = literal === undefined ? new RegExp(`const\\s+${name}\\s*=\\s*(['"])([^'"]*)\\1`).exec(text)?.[2] : undefined
      const named = literal ?? constant
      if (named !== undefined) found.push({ name: named, info: info ?? '', default: !/default:\s*false/.test(call) })
    }
  }
  return found
}

/**
 * ADR 0027: every switch is an option of the plugin's configuration, and the configuration is the only place it is kept.
 * Each switch the code defines (`declared`, from declaredSwitchSpecs) has its option in `userConfig` (core/switches.ts
 * `optionOf`: the name in camel case), a boolean whose `default` is the switch's and whose `description` is the switch's
 * `info`, word for word (what `/config` and `/dp status` say of a switch is one text); the master switch has its own, on
 * by default.
 */
export function checkSwitchOptions(userConfig: Readonly<Record<string, OptionSpec & { description?: unknown }>>, declared: readonly DeclaredSwitch[]): string[] {
  const problems: string[] = []
  for (const spec of [{ name: MASTER, info: null, default: true }, ...declared]) {
    const option = optionOf(spec.name)
    const decl = userConfig[option]
    const what = spec.name === MASTER ? 'the master switch' : `the switch \`${spec.name}\``
    if (decl === undefined) {
      problems.push(`\`${option}\`: plugin.json declares no such option, but ${what} is kept there`)
      continue
    }
    if (decl.type !== 'boolean') problems.push(`\`${option}\`: the option of ${what} must be a boolean, not ${String(decl.type)}`)
    if (decl.default !== spec.default) problems.push(`\`${option}\`: plugin.json's default is ${String(decl.default)}, but ${what} is ${spec.default ? 'on' : 'off'} by default`)
    if (spec.info !== null && decl.description !== spec.info) problems.push(`\`${option}\`: plugin.json's description is not the \`info\` of ${what}, word for word`)
  }
  return problems
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
  // None is left since ADR 0018 took the skill profiles out; a file that should be so goes here.
  const silent: [string, RegExp, string][] = []
  // The status line where the band is not drawn (ADR 0011): set only from what board/status-line.ts says, by these two.
  const statusLine = new Set(['board/screens.tsx', 'features/prompt-hint.ts'])
  const rules: [RegExp, string, Set<string>?][] = [
    [/\$\.ui\.status\(/, 'draws on the status row (`$.ui.status`), which the band and the footer replace (a session without a terminal: board/status-line.ts, ADR 0011)', statusLine],
    [/\$\.ui\.toast\(/, 'raises a toast itself'],
    [/\b(?:setStatus|pauseStatus|recordDecision)\(/, 'calls a writer of the old status line or decision log'],
  ]
  const problems: string[] = []
  for (const [path, text] of Object.entries(sources)) {
    const code = text.split(TOAST_CLOSURE).join('')
    for (const [pattern, what, allowed] of rules) if (pattern.test(code) && allowed?.has(path) !== true) problems.push(`\`${path}\`: ${what}; hand the decision report the data instead (ADR 0004)`)
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

/**
 * DEVELOPMENT.md 「事件和 matcher」: `$` is used only in the file of the hook that holds it. A function another file can import
 * takes closures (`BackendIo`, `Cell`, ...) and never `$`, and `$` is never put in an object (`{ $, s, e }`): the engine refuses
 * a mod that does either when it loads it, and the test kit does not. `sources` is text by path relative to hooks/.
 */
export function checkEngineStaysHome(sources: Readonly<Record<string, string>>): string[] {
  const problems: string[] = []
  const takes = (path: string, name: string) => `\`${path}\`: exports \`${name}\`, which takes \`$\`; take closures instead (BackendIo, Cell, ...): \`$\` may not cross a file`
  for (const [path, text] of Object.entries(sources)) {
    // Comments may mention `$` as they like.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // An exported function or arrow function with a parameter called `$`, first or not.
    for (const [, name, params] of code.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>(]*>)?\(([^)]*)\)/g)) if (/(?:^|,)\s*\$\s*(?::|,|$)/.test(params ?? '')) problems.push(takes(path, name ?? ''))
    for (const [, name, params] of code.matchAll(/export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::[^=]*)?=>/g)) if (/(?:^|,)\s*\$\s*(?::|,|$)/.test(params ?? '')) problems.push(takes(path, name ?? ''))
    if (/[{,]\s*\$\s*[,}]/.test(code)) problems.push(`\`${path}\`: puts \`$\` in an object; pass it as a separate argument within the file, or hand over closures`)
  }
  return problems
}

/** The events Claude Code's Code Mode refuses a mod for (2.1.326, which added `tool.judge` and `tool.run` to 2.1.325's fifteen: it does not start beside a mod whose hooks module registers one of them). */
export const CODE_MODE_REFUSES = /^(?:tool\.call|tool\.check|tool\.judge|tool\.run|agent\.offer|agent\.spawn|session\.send|classic\.(?:PreToolUse|PermissionRequest|PermissionDenied|PostToolUse|PostToolUseFailure|TaskCreated|TaskCompleted|Elicitation|ElicitationResult|WorktreeCreate))$/

/**
 * The bridge (ADR 0028), checked across the two plugins: dispatch-pilot's hooks module registers none of the events
 * Code Mode refuses a mod for; every hook it bridges (`on('dispatchPilot.start', { name })`) is run by one hook of
 * dispatch-pilot-extras (`through($, e, next, name)`) and no other name is; and the copy of that plugin the tests load
 * (tests/support/extras.ts) lists the same hooks on the same events in the same order.
 */
export function checkBridge(sources: Readonly<Record<string, string>>, extras: string, testExtras: string): string[] {
  const problems: string[] = []
  for (const [path, source] of Object.entries(sources)) {
    // Code alone: a comment may spell a registration out (hooks/core/bridge.ts shows the hook a bridged body stands for).
    const code = source.split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line)).join('\n')
    for (const match of code.matchAll(/\bon\(\s*['"]([A-Za-z.]+)['"]/g)) {
      if (CODE_MODE_REFUSES.test(match[1] as string)) problems.push(`hooks/${path} registers ${match[1]}: Code Mode does not start beside a mod that hooks it; bridge the hook (hooks/core/bridge.ts)`)
    }
  }
  const bridged = Object.values(sources).flatMap((source) => [...source.matchAll(/on\('dispatchPilot\.start', \{ name: '([a-z.-]+)' \}/g)].map((match) => match[1] as string))
  const listOf = (text: string): string[] => [...text.matchAll(/on\('([A-Za-z.]+)'[^\n]*?, '([a-z.-]+)'\)\)/g)].map((match) => `${match[1]} ${match[2]}`)
  const run = listOf(extras)
  const names = run.map((row) => row.split(' ')[1] as string)
  for (const name of bridged) if (!names.includes(name)) problems.push(`dispatch-pilot-extras runs no hook named ${name}, which hooks/ bridges`)
  for (const name of names) if (!bridged.includes(name)) problems.push(`dispatch-pilot-extras runs a hook named ${name}, which hooks/ does not bridge`)
  for (const name of new Set(names)) if (names.filter((one) => one === name).length > 1) problems.push(`dispatch-pilot-extras runs the hook ${name} more than once`)
  const tested = listOf(testExtras)
  if (run.join('\n') !== tested.join('\n')) problems.push(`tests/support/extras.ts does not list dispatch-pilot-extras' hooks as that plugin does: ${JSON.stringify(tested)} against ${JSON.stringify(run)}`)
  return problems
}

