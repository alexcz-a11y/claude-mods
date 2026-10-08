// The eval v2 dataset (#45): long conversations assembled from a pool of one-round segments around hand-written rounds.
// eval/datasets/eval-v2/FORMAT.md is what the authors write to; this module is that format's statement, as datasets.ts is
// the other datasets': the checks `eval/eval-v2-check.ts` and `eval/validate.ts` run, and the types the generator reads.
//
//   pool/<domain>-<relation>-<nn>.json   one round of ordinary work: the person's message and the main agent's reply
//   items/<category>-<nn>.json           one question: the rounds around the long middle, written out (no answers)
//   gold-author/<id>.json, gold-labeler/<id>.json   the answers, each side blind to the other
//
// Pure: no Node API.

import { estimateTokens, messageText, recentLines } from '../../hooks/decision/context.ts'
import { EFFORTS, isEffort, type Effort } from '../../hooks/decision/effort.ts'
import { redactSecrets } from '../../hooks/decision/redact.ts'
import { UNRESOLVED_OPTIONS, type UnresolvedOption } from '../../hooks/decision/unresolved.ts'
import { isRecord } from './datasets.ts'

export type Checked = { errors: string[]; warnings: string[] }

/** The ten areas of work; each is one made-up repository (FORMAT.md), and an item's conversation stays in its own. */
export const DOMAINS = ['frontend', 'backend-api', 'database', 'ios', 'data-scripts', 'devops-ci', 'cc-mods', 'docs-writing', 'perf', 'security'] as const
export type Domain = (typeof DOMAINS)[number]

/** What a segment is to the problem of the item it lands in: more work on it with no conclusion, or other work in the repository. */
export const RELATIONS = ['same-problem', 'unrelated'] as const
export type Relation = (typeof RELATIONS)[number]

/**
 * What a same-problem segment says in place of the item's own words; the item gives each its value. Only an uppercase
 * name in double braces is a placeholder: `{{ .Values.image }}` in a Helm chart, `${{ github.sha }}` in a workflow are code.
 */
export const PLACEHOLDERS = ['FEATURE', 'SYMPTOM', 'ERROR', 'FILE', 'FILE2', 'SYMBOL', 'COMMAND'] as const
export type Placeholder = (typeof PLACEHOLDERS)[number]

/** The values a segment is measured with (the generator fills in the item's own). */
export const SAMPLE_VALUES: Readonly<Record<Placeholder, string>> = {
  FEATURE: '订单列表的分页',
  SYMPTOM: '翻到第二页时列表是空的',
  ERROR: "TypeError: Cannot read properties of undefined (reading 'items')",
  FILE: 'src/pages/orders/OrderList.tsx',
  FILE2: 'src/api/orders.ts',
  SYMBOL: 'useOrderPagination',
  COMMAND: 'npx vitest run src/pages/orders',
}

/** How long a segment is: its two lines in the state, in the mod's estimated tokens. */
export const SEGMENT_TOKENS = { least: 3000, most: 5000 } as const

/** The tools of Claude Code a reply may name (and any MCP tool, `mcp__…`); another name is a warning, not an error. */
export const TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'Bash', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'TodoWrite', 'Skill', 'Workflow', 'LSP', 'AskUserQuestion', 'ExitPlanMode', 'ToolSearch'] as const

/** A pool segment: one round, the person's message and the main agent's reply (its text, and the tools it called, by name). */
export type Segment = { id: string; domain: Domain; relation: Relation; user: string; assistant: { text: string; tools: string[] } }

const PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]*)\}\}/g

/** The placeholders a text uses, by name, known or not. */
function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] as string)
}

/** `text` with each known placeholder replaced by its value. */
export function fill(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => values[name] ?? whole)
}

function isPlaceholder(name: string): name is Placeholder {
  return (PLACEHOLDERS as readonly string[]).includes(name)
}

/**
 * What one message costs the state, in the mod's estimated tokens, as the mod counts it when it picks the messages a state
 * holds (`turnStartState`, newest first while they fit): its line of `recent_context` as the mod writes it (`recentLines`:
 * role, tools, whitespace collapsed, secrets masked), and one for the newline after it. Segment sizes, item sizes, depths
 * and totals are all in this count (the long-context dataset's `conversationTokens` is the same).
 */
export function lineTokens(entry: { role: 'user' | 'assistant'; text: string; tools?: readonly string[] }): number {
  return lineCosts(entry)[0]
}

/**
 * A message's two costs: as the mod counts its line when it picks lines (above), and as the state is sent: JSON, where each
 * quote and backslash is escaped. The mod picks by the first; when the state as sent comes out over its budget it picks
 * again with a smaller budget, a few times at most (`withinTokens`). So a budget starts to read a line somewhere between
 * the line's two depths, and the generator keeps the decisive rounds clear of the test budgets by both (BINS).
 */
function lineCosts(entry: { role: 'user' | 'assistant'; text: string; tools?: readonly string[] }): [number, number] {
  const [line] = recentLines([{ role: entry.role, text: entry.text, toolUses: (entry.tools ?? []).map((tool) => ({ tool })) }], '\u0000', 1)
  return line === undefined ? [0, 0] : [estimateTokens(line) + 1, estimateTokens(JSON.stringify(line).slice(1, -1)) + 1]
}

/** The message asked about: as the mod counts it (its state field), and as sent with the state's own field names. */
function messageCosts(text: string): [number, number] {
  const message = messageText(text, Number.MAX_SAFE_INTEGER)
  return [estimateTokens(message), estimateTokens(JSON.stringify({ user_message: message, recent_context: '' }))]
}

/** Checks a pool segment; `name` is its file's name without `.json`. `tokens` is its size with the sample values filled in. */
export function checkSegment(raw: unknown, name: string): Checked & { tokens: number | null } {
  const errors: string[] = []
  const warnings: string[] = []
  const done = (tokens: number | null = null) => ({ errors, warnings, tokens })
  if (!isRecord(raw)) {
    errors.push('not a JSON object')
    return done()
  }
  exactKeys(raw, ['id', 'domain', 'relation', 'user', 'assistant'], '', errors)
  const domainOk = oneOf(raw.domain, DOMAINS, 'domain', errors)
  const relationOk = typeof raw.relation === 'string' && (RELATIONS as readonly string[]).includes(raw.relation)
  if (!relationOk) errors.push(`relation ${JSON.stringify(raw.relation)} is not same-problem or unrelated`)
  if (typeof raw.id !== 'string' || raw.id !== name) errors.push(`id ${JSON.stringify(raw.id)} must be the file's name ${JSON.stringify(name)}`)
  if (domainOk && relationOk && typeof raw.id === 'string' && !new RegExp(`^${raw.domain}-${raw.relation}-\\d{2}$`).test(raw.id)) {
    errors.push(`id must be ${raw.domain}-${raw.relation}-<nn> (two digits), as its domain and relation say`)
  }
  if (!nonEmpty(raw.user)) errors.push('user must be a non-empty string')
  const assistant = raw.assistant
  let text: string | null = null
  let tools: string[] = []
  if (!isRecord(assistant)) errors.push('assistant must be { text, tools }')
  else {
    exactKeys(assistant, ['text', 'tools'], 'assistant', errors)
    if (nonEmpty(assistant.text)) text = assistant.text
    else errors.push('assistant.text must be a non-empty string')
    tools = checkTools(assistant.tools, 'assistant.tools', true, errors, warnings)
  }
  const user = nonEmpty(raw.user) ? raw.user : null
  for (const [field, value] of [['user', user], ['assistant.text', text]] as const) {
    if (value === null) continue
    if (/<\/?system-reminder>/.test(value)) errors.push(`${field} holds <system-reminder>: the mod drops what it wraps`)
    const used = placeholdersIn(value)
    for (const unknown of new Set(used.filter((name) => !isPlaceholder(name)))) errors.push(`{{${unknown}}} is not a placeholder (${PLACEHOLDERS.join(', ')})`)
    const known = [...new Set(used.filter(isPlaceholder))]
    if (raw.relation === 'same-problem' && known.length === 0) errors.push(`${field} has no placeholder: a same-problem segment names the item's problem with them (${PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')})`)
    if (raw.relation === 'unrelated' && known.length > 0) errors.push(`an unrelated segment has no placeholders: ${known.map((p) => `{{${p}}}`).join(', ')}`)
    warnings.push(...oneBrace(value))
  }
  if (user === null || text === null) return done()
  const filled = { user: fill(user, SAMPLE_VALUES), text: fill(text, SAMPLE_VALUES) }
  const asked = lineCosts({ role: 'user', text: filled.user })
  const answered = lineCosts({ role: 'assistant', text: filled.text, tools })
  const tokens = asked[0] + answered[0]
  const swell = (asked[1] + answered[1]) / tokens - 1
  if (swell > 0.1) warnings.push(`it is ${Math.round(swell * 100)}% bigger as sent (JSON escapes every quote and backslash): fine now and then, but a pool of such segments leaves the deepest bin less room`)
  if (tokens < SEGMENT_TOKENS.least || tokens > SEGMENT_TOKENS.most) {
    errors.push(`${tokens} tokens: a segment is ${SEGMENT_TOKENS.least} to ${SEGMENT_TOKENS.most} (the mod's estimate of its two lines, placeholders filled with the sample values)`)
  }
  warnings.push(...masked(`${filled.user}\n${filled.text}`))
  if (raw.relation === 'same-problem') warnings.push(...concluding(`${user}\n${text}`))
  return done(tokens)
}

/** The ten kinds of question, twelve items each (issue #45); an item's id is `<category>-<nn>`. */
export const V2_CATEGORIES = [
  'explicit-unresolved',
  'implicit-unresolved',
  'single-attempt',
  'resolved',
  'new-topic',
  'cheap-agreement',
  'looks-hard-is-easy',
  'misleading-history',
  'hard-constraint',
  'command-turn',
] as const
export type V2Category = (typeof V2_CATEGORIES)[number]

/** How deep the decisive rounds are from the end: under 24k, 24k–48k, 48k–135k, over 135k estimated tokens (FORMAT.md). */
export const BIN_NAMES = ['d1', 'd2', 'd3', 'd4'] as const
export type Bin = (typeof BIN_NAMES)[number]

/** The most an item's own rounds may take, in estimated tokens: so that the shallowest bin still fits them and a segment. */
export const ITEM_LIMITS = { opening: 8000, decisive: 9000, final: 6000 } as const

/** A message of an item's rounds: the person's (`msg` in the decisive rounds, `command` on a command turn's last) or the assistant's (`tools`). */
export type Entry = { role: 'user' | 'assistant'; text: string; tools?: string[]; msg?: string; command?: { name: string; description: string } }

/** An item: the rounds around the long middle, written out; the generator puts the pool's segments between them. */
export type V2Item = {
  id: string
  category: V2Category
  domain: Domain
  bin: Bin
  relation: Relation
  placeholders: Partial<Record<Placeholder, string>>
  opening: Entry[]
  decisive: Entry[]
  final: Entry[]
  middle_hint: string
}

/** Checks an item; `name` is its file's name without `.json`. `sizes` are its rounds' sizes in estimated tokens. */
export function checkItem(raw: unknown, name: string): Checked & { sizes: { opening: number; decisive: number; final: number } | null } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isRecord(raw)) return { errors: ['not a JSON object'], warnings, sizes: null }
  exactKeys(raw, ['id', 'category', 'domain', 'bin', 'relation', 'placeholders', 'opening', 'decisive', 'final', 'middle_hint'], '', errors)
  const categoryOk = oneOf(raw.category, V2_CATEGORIES, 'category', errors)
  oneOf(raw.domain, DOMAINS, 'domain', errors)
  oneOf(raw.bin, BIN_NAMES, 'bin', errors)
  const relationOk = typeof raw.relation === 'string' && (RELATIONS as readonly string[]).includes(raw.relation)
  if (!relationOk) errors.push(`relation ${JSON.stringify(raw.relation)} is not same-problem or unrelated`)
  if (typeof raw.id !== 'string' || raw.id !== name) errors.push(`id ${JSON.stringify(raw.id)} must be the file's name ${JSON.stringify(name)}`)
  if (categoryOk && typeof raw.id === 'string' && !new RegExp(`^${raw.category}-\\d{2}$`).test(raw.id)) errors.push(`id must be ${raw.category}-<nn> (two digits), as its category says`)
  if (relationOk) checkValues(raw.placeholders, raw.relation as Relation, errors)
  if (!nonEmpty(raw.middle_hint)) errors.push('middle_hint must be a non-empty string')

  const before = errors.length
  const opening = checkRounds(raw.opening, 'opening', errors, warnings)
  const decisive = checkRounds(raw.decisive, 'decisive', errors, warnings)
  const final = checkRounds(raw.final, 'final', errors, warnings)
  if (Array.isArray(raw.decisive) && raw.decisive.length === 0) errors.push('decisive must hold at least one round')
  const last = final?.at(-1)
  if (last !== undefined && categoryOk) {
    if (raw.category === 'command-turn' && last.command === undefined) errors.push('a command-turn item ends with a command: the last message needs command { name, description }')
    if (raw.category !== 'command-turn' && last.command !== undefined) errors.push('only a command-turn item ends with a command')
  }
  if (last?.command !== undefined && isRecord(last.command) && nonEmpty(last.command.name) && !new RegExp(`^/${escapeRegExp(last.command.name)}(\\s|$)`).test(last.text)) {
    errors.push(`final's last message must start with /${last.command.name}, the command it names`)
  }
  if (opening === null || decisive === null || final === null || errors.length > before) return { errors, warnings, sizes: null }

  const sizes = { opening: sum(opening.map(lineTokens)), decisive: sum(decisive.map(lineTokens)), final: sum(final.map(lineTokens)) }
  for (const part of ['opening', 'decisive', 'final'] as const) {
    if (sizes[part] > ITEM_LIMITS[part]) errors.push(`${part} is ${sizes[part]} tokens: at most ${ITEM_LIMITS[part]} (so that the shallowest bin, under 24000, still holds the rounds and a segment)`)
  }
  const said = [...opening, ...decisive].map((entry) => entry.text).join('\n')
  const values = isRecord(raw.placeholders) ? raw.placeholders : {}
  const named = (['FILE', 'SYMBOL', 'ERROR'] as const).filter((key) => typeof values[key] === 'string' && said.includes(values[key] as string))
  if (raw.relation === 'same-problem' && named.length === 0) {
    warnings.push('none of FILE, SYMBOL, ERROR appears in opening or decisive: the segments will talk about them as the problem the rounds were on, so name at least one there')
  }
  const people = final.filter((entry) => entry.role === 'user').length
  if (people > 1) warnings.push(`final has ${people} messages of the person: only the last is scored, so the earlier ones must not say anything of the problem (put that in decisive)`)
  return { errors, warnings, sizes }
}

/** The three-way question's answers, as the mod names its options (`hooks/decision/unresolved.ts`). */
export const TRIAGE_ANSWERS = UNRESOLVED_OPTIONS

/** A gold file: the author's or the labeler's answers to an item, the same fields on both sides. */
export type V2Gold = {
  id: string
  effort: Effort
  accept: Effort[]
  effort_without_decisive: Effort
  triage_final: UnresolvedOption
  triage_decisive: { msg: string; triage: UnresolvedOption }[]
  rationale: string
}

/**
 * Where a final gold file's answers come from: both sides agreed (the author's file), both agreed on the level but not
 * on what else is acceptable (the union of the two accept sets), or the person ruled on a disagreement.
 */
export const GOLD_SOURCES = ['agreed', 'agreed+accept-union', 'user:author', 'user:labeler', 'user:custom'] as const

/** A final gold file (`gold/<id>.json`, what the eval scores against): a gold file's fields and where it came from. */
export type FinalGold = V2Gold & { source: (typeof GOLD_SOURCES)[number] }

/**
 * Checks a final gold file as `checkGold` checks a side's, with its `source`; `asked` are the decisive messages of the
 * person it must answer, in order (null: not checked).
 */
export function checkFinalGold(raw: unknown, name: string, asked: readonly string[] | null): Checked {
  if (!isRecord(raw)) return { errors: ['not a JSON object'], warnings: [] }
  const { source, ...rest } = raw
  const checked = checkGoldFields(rest, name, asked)
  if (!(GOLD_SOURCES as readonly unknown[]).includes(source)) checked.errors.push(`source ${JSON.stringify(source)} is not one of ${GOLD_SOURCES.join(', ')}`)
  return checked
}

/**
 * Checks a gold file; `name` is its file's name without `.json`, `item` the item it answers (null when there is none yet:
 * then its decisive messages are not checked).
 */
export function checkGold(raw: unknown, name: string, item: V2Item | null): Checked {
  const checked = checkGoldFields(raw, name, item === null ? null : item.decisive.flatMap((entry) => (entry.msg === undefined ? [] : [entry.msg])))
  if (item === null) checked.warnings.push(`no items/${name}.json for this gold: its decisive messages are not checked`)
  return checked
}

function checkGoldFields(raw: unknown, name: string, asked: readonly string[] | null): Checked {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isRecord(raw)) return { errors: ['not a JSON object'], warnings }
  exactKeys(raw, ['id', 'effort', 'accept', 'effort_without_decisive', 'triage_final', 'triage_decisive', 'rationale'], '', errors)
  if (typeof raw.id !== 'string' || raw.id !== name) errors.push(`id ${JSON.stringify(raw.id)} must be the file's name ${JSON.stringify(name)}`)
  const level = (field: string) => {
    if (!isEffort(raw[field])) errors.push(`${field} ${JSON.stringify(raw[field])} is not an effort level (${EFFORTS.join(', ')})`)
  }
  level('effort')
  level('effort_without_decisive')
  const accept = raw.accept
  if (!Array.isArray(accept) || accept.length === 0 || !accept.every(isEffort)) errors.push(`accept must be a non-empty array of effort levels (${EFFORTS.join(', ')})`)
  else {
    if (new Set(accept).size !== accept.length) errors.push(`accept ${JSON.stringify(accept)} names a level twice`)
    if (!contiguous(accept)) errors.push(`accept ${JSON.stringify(accept)} is not contiguous: acceptable levels are adjacent`)
    if (isEffort(raw.effort) && !accept.includes(raw.effort)) errors.push(`effort "${raw.effort}" is not in accept ${JSON.stringify(accept)}`)
  }
  const triage = (value: unknown, field: string) => {
    if (!(TRIAGE_ANSWERS as readonly unknown[]).includes(value)) errors.push(`${field} ${JSON.stringify(value)} is not one of ${TRIAGE_ANSWERS.join(', ')}`)
  }
  triage(raw.triage_final, 'triage_final')
  const answers = raw.triage_decisive
  if (!Array.isArray(answers)) errors.push('triage_decisive must be an array of { msg, triage }')
  else {
    answers.forEach((answer, i) => {
      const at = `triage_decisive[${i}]`
      if (!isRecord(answer)) return errors.push(`${at} must be { msg, triage }`)
      exactKeys(answer, ['msg', 'triage'], at, errors)
      triage(answer.triage, `${at}.triage`)
    })
    if (asked !== null) {
      const given = answers.map((answer) => (isRecord(answer) ? answer.msg : undefined))
      if (JSON.stringify(given) !== JSON.stringify(asked)) errors.push(`triage_decisive must answer ${asked.join(', ')} in order (the item's decisive messages of the person), not ${given.map(String).join(', ') || 'none'}`)
    }
  }
  if (!nonEmpty(raw.rationale)) errors.push('rationale must be a non-empty string')
  return { errors, warnings }
}

/** Whether `levels` are adjacent levels (in any order). */
function contiguous(levels: readonly Effort[]): boolean {
  const at = [...new Set(levels)].map((level) => EFFORTS.indexOf(level)).sort((a, b) => a - b)
  return at.every((index, i) => i === 0 || index === (at[i - 1] as number) + 1)
}

/** The placeholders' values: all of them for a same-problem item (any segment may use any), none for an unrelated one. */
function checkValues(value: unknown, relation: Relation, errors: string[]): void {
  if (relation === 'unrelated') {
    if (!isRecord(value) || Object.keys(value).length > 0) errors.push('placeholders must be {} for an unrelated item (its segments have none)')
    return
  }
  if (!isRecord(value)) {
    errors.push(`placeholders must be { ${PLACEHOLDERS.join(', ')} }`)
    return
  }
  exactKeys(value, PLACEHOLDERS, 'placeholders', errors)
  for (const key of PLACEHOLDERS) {
    const text = value[key]
    if (!(key in value)) continue
    if (!nonEmpty(text) || /[\n\r]/.test(text) || text.includes('{{')) errors.push(`placeholders.${key} must be one line of text, without {{`)
    else if (['FILE', 'FILE2', 'SYMBOL'].includes(key) && /\s/.test(text)) errors.push(`placeholders.${key} must have no spaces: it stands for a ${key === 'SYMBOL' ? 'name in the code' : 'path'}`)
  }
  if (nonEmpty(value.FILE) && value.FILE === value.FILE2) errors.push('placeholders.FILE and FILE2 must differ')
}

/**
 * A list of whole rounds, the person first: opening and decisive end with the assistant, final with the person's message
 * the item asks about. Ids (`msg`) only on the decisive rounds' messages of the person, d1, d2, … in order; `command` only
 * on final's last message. Null when it is not a list of messages.
 */
function checkRounds(value: unknown, at: 'opening' | 'decisive' | 'final', errors: string[], warnings: string[]): Entry[] | null {
  if (!Array.isArray(value)) {
    errors.push(`${at} must be an array of messages`)
    return null
  }
  let next = 1
  value.forEach((entry, i) => {
    const where = `${at}[${i}]`
    if (!isRecord(entry)) return errors.push(`${where} must be an object`)
    for (const key of Object.keys(entry)) if (!['role', 'text', 'tools', 'msg', 'command'].includes(key)) errors.push(`${where} has an unknown field ${key}`)
    const role = i % 2 === 0 ? 'user' : 'assistant'
    if (entry.role !== role) errors.push(`${where}.role must be "${role}" (rounds alternate, starting with the person)`)
    if (!nonEmpty(entry.text)) errors.push(`${where}.text must be a non-empty string`)
    else {
      for (const name of new Set(placeholdersIn(entry.text).filter(isPlaceholder))) errors.push(`${where}.text has {{${name}}}: an item is written out, no placeholders`)
      if (/<\/?system-reminder>/.test(entry.text)) errors.push(`${where}.text holds <system-reminder>: the mod drops what it wraps`)
      warnings.push(...oneBrace(entry.text), ...masked(entry.text).map((warning) => `${where}: ${warning}`))
    }
    if ('tools' in entry) {
      if (entry.role !== 'assistant') errors.push(`${where}.tools: only the assistant calls tools`)
      else checkTools(entry.tools, `${where}.tools`, false, errors, warnings)
    }
    if (at === 'decisive' && entry.role === 'user') {
      if (entry.msg !== `d${next}`) errors.push(`${where}.msg must be "d${next}" (the person's messages are d1, d2, … in order)`)
      next++
    } else if ('msg' in entry) {
      errors.push(at === 'decisive' ? `${where}.msg: only a message of the person has an id` : `${where}.msg: only the decisive rounds carry ids (the generator numbers the rest)`)
    }
    if ('command' in entry) {
      if (at !== 'final' || i !== value.length - 1) errors.push(`${where}.command: only the last message can be a command`)
      else if (!isRecord(entry.command) || !nonEmpty(entry.command.name) || !nonEmpty(entry.command.description) || Object.keys(entry.command).length !== 2) {
        errors.push(`${where}.command must be { name, description }: the command's name without the slash, and what it is for`)
      }
    }
  })
  if (at === 'final') {
    if (value.length % 2 === 0) errors.push(`final must end with the person's message (the one asked about), so it has an odd number of messages`)
  } else if (value.length % 2 !== 0) errors.push(`${at} must end with the assistant (whole rounds)`)
  return value.every((entry) => isRecord(entry) && nonEmpty(entry.text) && (entry.role === 'user' || entry.role === 'assistant')) ? (value as Entry[]) : null
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Tool names: a non-empty array (when `needed`) of names, each once; a name Claude Code does not have is a warning. */
function checkTools(value: unknown, at: string, needed: boolean, errors: string[], warnings: string[]): string[] {
  if (!Array.isArray(value) || !value.every(nonEmpty) || (needed && value.length === 0)) {
    errors.push(`${at} must be a ${needed ? 'non-empty ' : ''}array of tool names`)
    return []
  }
  for (const name of new Set(value.filter((tool, i) => value.indexOf(tool) !== i))) errors.push(`${at} names ${name} twice: each tool once, in the order it was first called`)
  for (const name of new Set(value)) {
    if (!(TOOLS as readonly string[]).includes(name) && !name.startsWith('mcp__')) warnings.push(`tool "${name}" is not a Claude Code tool name (${TOOLS.join(', ')}, or mcp__…)`)
  }
  return value
}

/** A placeholder's name in single braces (`{FILE}`): most likely a placeholder mistyped. `${HOME}` is left alone. */
function oneBrace(text: string): string[] {
  const names = [...text.matchAll(/(?<![{$])\{([A-Z][A-Z0-9_]*)\}(?!\})/g)].map((match) => match[1] as string).filter(isPlaceholder)
  return [...new Set(names)].map((name) => `{${name}} looks like a placeholder with one brace: write {{${name}}}`)
}

/** How many secret-like strings the mod masks before sending (redact.ts): realistic, but it changes the text. */
function masked(text: string): string[] {
  const count = (s: string) => s.split('[REDACTED').length - 1
  const n = count(redactSecrets(text)) - count(text)
  return n > 0 ? [`the mod masks ${n} secret-like string${n === 1 ? '' : 's'} in it as [REDACTED] (the decision model reads the masked text): rewrite them if that is not meant`] : []
}

/** Words that read like a conclusion about the problem (a cause found, something fixed or solved), unless negated just before. */
const CONCLUSION = /已经?(修复|修好|解决)|修好了|解决了|搞定了|找到了?(根因|原因)|根因(就)?是|原因就是/g

function concluding(text: string): string[] {
  const found = [...text.matchAll(CONCLUSION)].filter((match) => !/[没未不]/.test(text.slice(Math.max(0, (match.index ?? 0) - 3), match.index)))
  return [...new Set(found.map((match) => match[0]))].map((words) => `a same-problem segment does not conclude: "${words}" reads like a conclusion (no cause found, nothing fixed or solved)`)
}

function oneOf<T extends string>(value: unknown, list: readonly T[], field: string, errors: string[]): value is T {
  if (typeof value === 'string' && (list as readonly string[]).includes(value)) return true
  errors.push(`${field} ${JSON.stringify(value)} is not one of ${list.join(', ')}`)
  return false
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], at: string, errors: string[]): void {
  const prefix = at === '' ? '' : `${at}.`
  for (const key of keys) if (!(key in value)) errors.push(`${prefix}${key} is missing`)
  for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(`${at === '' ? '' : `${at} has an `}unknown field ${key}`)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * What the whole dataset is planned to hold (issue #45): 120 items, 12 of each category, 30 in each bin (half of them
 * same-problem), each category over at least 6 domains; in each domain at least 40 same-problem segments (a d4
 * same-problem item alone takes 35 to 45 of its pool, none twice) and 50 unrelated ones (the unrelated middles and every
 * item's lead share them). Measured by simulating 120 items, 12 a domain, over segments of 3000 to 5000 tokens: with 40
 * and 50 every item builds and every total is 80000 or more; shorter segments need a few more (FORMAT.md「素材池要多大」).
 */
export const PLAN = { items: 120, perCategory: 12, perBin: 30, domainsPerCategory: 6, pool: { 'same-problem': 40, unrelated: 50 } } as const

/**
 * The plan's shares, checked over what is written so far: warnings, never errors (the authors write the files a few at a
 * time). `authorGold` and `labelerGold` are the ids of the gold files on each side.
 */
export function datasetWarnings(input: { segments: readonly Segment[]; items: readonly V2Item[]; authorGold: readonly string[]; labelerGold: readonly string[] }): string[] {
  const { segments, items } = input
  const warnings: string[] = []
  const count = <T extends string>(names: readonly T[], of: (item: V2Item) => string) => names.map((name) => [name, items.filter((item) => of(item) === name).length] as const)
  if (items.length !== PLAN.items) warnings.push(`${items.length} of ${PLAN.items} items written`)
  const categories = count(V2_CATEGORIES, (item) => item.category)
  if (categories.some(([, n]) => n !== PLAN.perCategory)) warnings.push(`items by category (the plan is ${PLAN.perCategory} each): ${categories.map(([name, n]) => `${name} ${n}`).join(', ')}`)
  const bins = count(BIN_NAMES, (item) => item.bin)
  if (bins.some(([, n]) => n !== PLAN.perBin)) warnings.push(`items by bin (the plan is ${PLAN.perBin} each): ${bins.map(([name, n]) => `${name} ${n}`).join(', ')}`)
  for (const bin of BIN_NAMES) {
    const same = items.filter((item) => item.bin === bin && item.relation === 'same-problem').length
    const other = items.filter((item) => item.bin === bin && item.relation === 'unrelated').length
    if (same !== other) warnings.push(`${bin}: ${same} same-problem, ${other} unrelated; the plan is half and half`)
  }
  for (const [category, n] of categories) {
    const domains = new Set(items.filter((item) => item.category === category).map((item) => item.domain)).size
    if (n > 0 && domains < PLAN.domainsPerCategory) warnings.push(`${category} covers ${domains} domain${domains === 1 ? '' : 's'}; the plan asks for at least ${PLAN.domainsPerCategory}`)
  }
  const pools = DOMAINS.flatMap((domain) => RELATIONS.map((relation) => [`${domain} ${relation}`, segments.filter((segment) => segment.domain === domain && segment.relation === relation).length, PLAN.pool[relation]] as const))
  if (pools.some(([, n, least]) => n < least)) warnings.push(`pool segments by domain and relation (the plan is at least ${PLAN.pool['same-problem']} same-problem and ${PLAN.pool.unrelated} unrelated in each domain): ${pools.map(([name, n]) => `${name} ${n}`).join(', ')}`)
  for (const [side, ids] of [['gold-author', input.authorGold], ['gold-labeler', input.labelerGold]] as const) {
    const missing = items.filter((item) => !ids.includes(item.id)).map((item) => item.id)
    if (missing.length > 0) warnings.push(`${missing.length} item${missing.length === 1 ? ' has' : 's have'} no ${side} file: ${missing.join(', ')}`)
  }
  return warnings
}

// ---- The generator: an item's conversation from the pool ----

/**
 * Where the whole of an item's decisive rounds lies, by bin, in estimated tokens from the end (the message counted): the
 * newest decisive line at least `least` deep, as the mod counts lines when it picks them (so a state budget under `least`
 * never reads any of them), and the first at most `most` deep as the state is sent, JSON escapes and all (so a budget a
 * few thousand over `most` reads all of them). The test groups read 24000 (Jev), 48000 and 135000 tokens of state (pplx);
 * each range keeps clear of those by 2000 to 8000 tokens, for the problem summary and the count the flow groups add to the
 * state (up to about 600) and the mod's own rounding when it cuts a state to fit. d4 stops at 160000: nothing reads past
 * 135000, and every token past it is one more segment the pool must hold.
 */
export const BINS: Readonly<Record<Bin, { least: number; most: number }>> = {
  d1: { least: 0, most: 21000 },
  d2: { least: 26000, most: 45000 },
  d3: { least: 51000, most: 127000 },
  d4: { least: 140000, most: 160000 },
}

/**
 * The total each item is padded up to with lead segments, drawn per item between these; an item whose depth alone is longer
 * (d4) is as long as its depth makes it. The issue asks most items for 80000 to 200000 (`TOTAL_RANGE`): the lower part
 * of that keeps the pool and the runs smaller, and a lead past the deepest budget reads the same as a shorter one.
 */
export const TOTAL = { least: 82000, most: 150000 } as const
export const TOTAL_RANGE = { least: 80000, most: 200000 } as const

/** How many items may use one segment (issue #45); no item uses one twice. */
export const MAX_USES = 6

/** Where a turn of an assembled conversation comes from. */
export type Part = 'lead' | 'opening' | 'decisive' | 'middle' | 'final'

/**
 * A message of an assembled conversation. Every message of the person has an id: `p<n>` in the lead, `o<n>` in the
 * opening, the item's own `d<n>` in the decisive rounds, `m<n>` in the middle, `f<n>` in the final rounds (the last is the
 * message the item asks about). A turn from the pool names its segment.
 */
export type V2Turn = { role: 'user' | 'assistant'; msg?: string; part: Part; segment?: string; text: string; tools?: string[]; command?: { name: string; description: string } }

/** One line of eval-v2.jsonl: the item's metadata, its whole conversation, and where its decisive rounds are. */
export type V2Record = {
  id: string
  category: V2Category
  domain: Domain
  bin: Bin
  relation: Relation
  middle_hint: string
  turns: V2Turn[]
  /** Each decisive message of the person: its id, its index in `turns`, and its depth. */
  decisive: { msg: string; at: number; depth: number }[]
  /**
   * Depths, in estimated tokens as the mod counts lines when it picks them (`lineTokens`): from the start of a message to
   * the end of the conversation, the message asked about counted (its state field) and every line after it. A state budget
   * under a message's depth never holds it; one at its depth holds it when the state as sent (JSON) fits too, which takes
   * a few percent more where the text has many quotes or backslashes. `depth` is the first decisive message's.
   */
  depth: number
  /** The depth of the newest decisive line (the assistant's reply that ends the decisive rounds). */
  depth_end: number
  /** The whole conversation: the depth of its first message. */
  tokens: number
  segments: { lead: string[]; middle: string[] }
}

export type Built = { records: V2Record[]; errors: string[]; warnings: string[]; uses: Record<string, number> }

/** A segment as it lands in one item: its two messages (placeholders filled with the item's values) and what each costs. */
type Landed = { segment: Segment; user: string; text: string; tokens: [number, number]; sent: number }

/**
 * Assembles every item's conversation: [lead] + opening + decisive + [middle] + final, the lead and the middle from the
 * pool of the item's domain. The middle is the item's relation (same-problem segments get the item's values in place of the
 * placeholders) and is as long as puts the whole of the decisive rounds in the depth range of the item's bin (BINS), at a
 * depth drawn per item; the lead is unrelated segments up to a total drawn per item (TOTAL). No segment twice in an item,
 * none in more than `maxUses` items; the least used go first, ties in an order drawn per item. The middles are chosen
 * deepest bin first, then the leads, by id. The same inputs and seed make the same records.
 */
export function buildEvalV2(input: { segments: readonly Segment[]; items: readonly V2Item[]; seed: string; maxUses?: number }): Built {
  const maxUses = input.maxUses ?? MAX_USES
  const errors: string[] = []
  const warnings: string[] = []
  const uses = new Map<string, number>([...input.segments].sort(byId).map((segment) => [segment.id, 0]))
  const pools = new Map<string, Segment[]>()
  for (const segment of [...input.segments].sort(byId)) {
    const key = `${segment.domain} ${segment.relation}`
    pools.set(key, [...(pools.get(key) ?? []), segment])
  }
  const items = [...input.items].sort(byId)
  const landed = new Map<string, Landed>()
  const land = (segment: Segment, item: V2Item): Landed => {
    const key = segment.relation === 'same-problem' ? `${segment.id} ${item.id}` : segment.id
    const known = landed.get(key)
    if (known !== undefined) return known
    const values = segment.relation === 'same-problem' ? (item.placeholders as Record<string, string>) : {}
    const user = fill(segment.user, values)
    const text = fill(segment.assistant.text, values)
    const asked = lineCosts({ role: 'user', text: user })
    const answered = lineCosts({ role: 'assistant', text, tools: segment.assistant.tools })
    const made: Landed = { segment, user, text, tokens: [asked[0], answered[0]], sent: asked[1] + answered[1] }
    landed.set(key, made)
    return made
  }
  const size = (piece: Landed) => piece.tokens[0] + piece.tokens[1]
  /** The segments an item may still take from a pool, the least used first, ties in the item's own order. */
  const offer = (item: V2Item, relation: Relation, taken: ReadonlySet<string>) =>
    (pools.get(`${item.domain} ${relation}`) ?? [])
      .filter((segment) => !taken.has(segment.id) && (uses.get(segment.id) ?? 0) < maxUses)
      .map((segment) => ({ segment, rank: hash32(`${input.seed}\u0000${item.id}\u0000${segment.id}`) }))
      .sort((a, b) => (uses.get(a.segment.id) ?? 0) - (uses.get(b.segment.id) ?? 0) || a.rank - b.rank || byId(a.segment, b.segment))
      .map(({ segment }) => land(segment, item))

  /** An item's own rounds' costs (as counted, and as sent for the decisive rounds and what follows them), and the segments it takes. */
  type Own = { opening: number[]; decisive: number[]; final: number[]; message: number; sent: { decisive: number; final: number; message: number } }
  type Plan = { draw: () => number; own: Own; middle: Landed[]; lead: Landed[] }
  const plans = new Map<string, Plan>()
  for (const item of items) {
    const message = item.final.at(-1)?.text ?? ''
    const decisive = item.decisive.map(lineCosts)
    const final = item.final.slice(0, -1).map(lineCosts)
    const asked = messageCosts(message)
    plans.set(item.id, {
      draw: random(`${input.seed}\u0000${item.id}`),
      own: {
        opening: item.opening.map(lineTokens),
        decisive: decisive.map(([counted]) => counted),
        final: final.map(([counted]) => counted),
        message: asked[0],
        sent: { decisive: sum(decisive.map(([, sent]) => sent)), final: sum(final.map(([, sent]) => sent)), message: asked[1] },
      },
      middle: [],
      lead: [],
    })
  }

  // The middles, deepest bin first (they need the most segments of one pool, none twice). The middle has to make the
  // newest decisive line at least the bin's `least` deep as counted, and leave the first at most `most` deep as sent.
  const deepFirst = [...items].sort((a, b) => BIN_NAMES.indexOf(b.bin) - BIN_NAMES.indexOf(a.bin) || byId(a, b))
  for (const item of deepFirst) {
    const plan = plans.get(item.id) as Plan
    const bin = BINS[item.bin]
    const least = Math.max(1, bin.least - plan.own.message - sum(plan.own.final) - (plan.own.decisive.at(-1) ?? 0))
    const room = bin.most - plan.own.sent.message - plan.own.sent.final - plan.own.sent.decisive
    const offered = offer(item, item.relation, new Set())
    const biggest = Math.max(0, ...offered.map((piece) => piece.sent))
    const target = Math.round(least + plan.draw() * Math.max(0, room - biggest - least))
    let middle = 0
    let sent = 0
    for (const piece of offered) {
      if (middle >= target) break
      if (sent + piece.sent > room) continue
      plan.middle.push(piece)
      middle += size(piece)
      sent += piece.sent
      uses.set(piece.segment.id, (uses.get(piece.segment.id) ?? 0) + 1)
    }
    if (room < least) errors.push(`${item.id}: its own rounds leave no room for a middle in ${item.bin}`)
    else if (middle < least) {
      const all = pools.get(`${item.domain} ${item.relation}`)?.length ?? 0
      const swell = sum(offered.map((piece) => piece.sent)) / Math.max(1, sum(offered.map(size)))
      errors.push(
        `${item.id}: the ${item.domain} ${item.relation} pool cannot fill its middle: ${item.bin} needs ${least} to ${room} tokens of segments, the ${plan.middle.length} it could take make ${middle} (the pool has ${all}; ${offered.length} were left after the ${maxUses}-use cap)` +
          (swell > 1.08 ? `; its segments are ${Math.round((swell - 1) * 100)}% bigger as sent (quotes and backslashes escaped), which leaves less room under ${bin.most}` : ''),
      )
    }
  }

  // The leads: unrelated segments up to each item's total, one segment an item a round (by id), so that when a pool runs
  // short every item of its domain gets a little less, not the last ones none.
  const leads = items.map((item) => {
    const plan = plans.get(item.id) as Plan
    const target = Math.round(TOTAL.least + plan.draw() * (TOTAL.most - TOTAL.least))
    return { item, plan, target, total: sum(plan.own.opening) + sum(plan.own.decisive) + sum(plan.middle.map(size)) + sum(plan.own.final) + plan.own.message }
  })
  for (let more = true; more; ) {
    more = false
    for (const lead of leads) {
      if (lead.total >= lead.target) continue
      const [piece] = offer(lead.item, 'unrelated', new Set([...lead.plan.middle, ...lead.plan.lead].map((taken) => taken.segment.id)))
      if (piece === undefined) continue
      lead.plan.lead.push(piece)
      lead.total += size(piece)
      uses.set(piece.segment.id, (uses.get(piece.segment.id) ?? 0) + 1)
      more = true
    }
  }

  const records = errors.length > 0 ? [] : items.map((item) => assemble(item, plans.get(item.id) as Plan))
  for (const record of records) {
    const bin = BINS[record.bin]
    const plan = plans.get(record.id) as Plan
    const sent = plan.own.sent.message + plan.own.sent.final + sum(plan.middle.map((piece) => piece.sent)) + plan.own.sent.decisive
    if (sent > bin.most || record.depth_end < bin.least) errors.push(`${record.id}: the decisive rounds are ${record.depth_end} (counted) to ${sent} (as sent) tokens deep, not within ${bin.least} to ${bin.most} (${record.bin})`)
    if (record.tokens < TOTAL_RANGE.least || record.tokens > TOTAL_RANGE.most) warnings.push(`${record.id}: ${record.tokens} tokens in all, outside ${TOTAL_RANGE.least} to ${TOTAL_RANGE.most} (the ${record.domain} unrelated pool ran short for its lead?)`)
  }
  return { records: errors.length > 0 ? [] : records, errors, warnings, uses: Object.fromEntries(uses) }

  function assemble(item: V2Item, plan: Plan): V2Record {
    const turns: V2Turn[] = []
    const costs: number[] = []
    const add = (turn: V2Turn, cost: number) => {
      turns.push(turn)
      costs.push(cost)
    }
    const segmentTurns = (pieces: readonly Landed[], part: 'lead' | 'middle', prefix: string) =>
      pieces.forEach((piece, n) => {
        add({ role: 'user', msg: `${prefix}${n + 1}`, part, segment: piece.segment.id, text: piece.user }, piece.tokens[0])
        add({ role: 'assistant', part, segment: piece.segment.id, text: piece.text, tools: [...piece.segment.assistant.tools] }, piece.tokens[1])
      })
    const ownTurns = (entries: readonly Entry[], part: 'opening' | 'decisive' | 'final', prefix: string) => {
      let n = 0
      entries.forEach((entry, i) => {
        const msg = entry.role === 'user' ? (part === 'decisive' ? entry.msg : `${prefix}${++n}`) : undefined
        const cost = part === 'final' && i === entries.length - 1 ? plan.own.message : lineTokens(entry)
        add({ role: entry.role, ...(msg === undefined ? {} : { msg }), part, text: entry.text, ...(entry.tools === undefined ? {} : { tools: [...entry.tools] }), ...(entry.command === undefined ? {} : { command: { ...entry.command } }) }, cost)
      })
    }
    segmentTurns(plan.lead, 'lead', 'p')
    ownTurns(item.opening, 'opening', 'o')
    ownTurns(item.decisive, 'decisive', 'd')
    segmentTurns(plan.middle, 'middle', 'm')
    ownTurns(item.final, 'final', 'f')
    // depth(i): the message asked about, and every line from i up to it.
    const depths = new Array<number>(turns.length)
    let below = plan.own.message
    depths[turns.length - 1] = below
    for (let i = turns.length - 2; i >= 0; i--) {
      below += costs[i] as number
      depths[i] = below
    }
    const decisiveAt = turns.flatMap((turn, i) => (turn.part === 'decisive' ? [i] : []))
    return {
      id: item.id,
      category: item.category,
      domain: item.domain,
      bin: item.bin,
      relation: item.relation,
      middle_hint: item.middle_hint,
      turns,
      decisive: decisiveAt.filter((i) => turns[i]?.role === 'user').map((i) => ({ msg: turns[i]?.msg as string, at: i, depth: depths[i] as number })),
      depth: depths[decisiveAt[0] as number] as number,
      depth_end: depths[decisiveAt.at(-1) as number] as number,
      tokens: depths[0] as number,
      segments: { lead: plan.lead.map((piece) => piece.segment.id), middle: plan.middle.map((piece) => piece.segment.id) },
    }
  }
}

/** eval-v2.jsonl: one record a line, by id. */
export function evalV2Jsonl(records: readonly V2Record[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('')
}

/**
 * eval-v2/generated.json: what the generator made, committed in place of eval-v2.jsonl (tens of megabytes, not committed).
 * `eval/validate.ts` builds the file again with `seed` and checks this record is what it makes; `sha256` and `bytes` are
 * the JSONL's (Node hashes it). No date: the same inputs make the same record.
 */
export function generatedFile(input: { seed: string; records: readonly V2Record[]; uses: Readonly<Record<string, number>>; sha256: string; bytes: number }): string {
  const counts = Object.values(input.uses)
  const head = {
    about: 'Written by eval/eval-v2-gen.ts. eval-v2.jsonl is not committed: eval/validate.ts builds it again from pool/ and items/ with this seed and checks it against this record. Edit the pool or the items, then run node dispatch-pilot/eval/eval-v2-gen.ts and commit this file.',
    seed: input.seed,
    jsonl: { sha256: input.sha256, bytes: input.bytes, items: input.records.length },
    pool: { segments: counts.length, used: counts.filter((n) => n > 0).length, mostUses: Math.max(0, ...counts) },
  }
  const lines = input.records.map((r) => JSON.stringify({ id: r.id, bin: r.bin, relation: r.relation, domain: r.domain, depth: r.depth, depth_end: r.depth_end, tokens: r.tokens, lead: r.segments.lead.length, middle: r.segments.middle.length }))
  const top = JSON.stringify(head, null, 2)
  return `${top.slice(0, -2)},\n  "items": [${lines.length === 0 ? '' : `\n${lines.map((line) => `    ${line}`).join(',\n')}\n  `}]\n}\n`
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** FNV-1a over a text's UTF-16 code units: a 32-bit number, the same on every machine. */
function hash32(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

/** A seeded generator (mulberry32 over the seed's hash): the same seed, the same numbers. */
function random(seed: string): () => number {
  let a = hash32(seed)
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
