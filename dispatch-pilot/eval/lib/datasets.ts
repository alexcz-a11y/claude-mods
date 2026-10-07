// The eval datasets (seam 2): one JSONL file per kind of decision under
// `eval/datasets/<kind>.jsonl`, one item per line. Every item asks one
// question twice, as a Chinese user wrote it (`zh`) and as its faithful
// English translation (`en`), with the best answer (`gold`), every acceptable
// answer (`accept`, which holds `gold`), a rationale in Chinese, a difficulty
// (`hard` or `medium`) and free tags for reading the errors. This module is
// the format's statement: the rules below are what `eval/validate.ts` checks,
// and the item types are what the suites read.
//
// Errors are rules an item breaks (the item cannot be scored as it is);
// warnings are dataset-wide quotas the drafting asked for, which a reviewer's
// decision may move (a review edit is never refused for them).
//
// Pure: no Node API. The tests and the Node scripts import it as it is.

import { BACKEND_DEFAULTS } from '../../hooks/core/setup.ts'
import { estimateTokens, recentLines, type ContextMessage } from '../../hooks/decision/context.ts'
import { EFFORTS, isEffort, type Effort } from '../../hooks/decision/effort.ts'
import { DETAIL_KEYS, OUTCOME_WORDS, type MidturnInput } from '../../hooks/decision/midturn.ts'

export const KINDS = ['effort-submit', 'effort-midturn', 'subagent', 'skill', 'unresolved'] as const
export type Kind = (typeof KINDS)[number]

export function isKind(name: string): name is Kind {
  return (KINDS as readonly string[]).includes(name)
}

export type Language = 'zh' | 'en'
export const LANGUAGES: readonly Language[] = ['zh', 'en']

/** A message before the one asked about: its text and the names of the tools it called (never their output). */
export type ContextEntry = { role: 'user' | 'assistant'; text: string; tools?: string[] }

/** What every kind shares; `Asked` is one language's version of the question. */
export type Item<Asked, Answer, Accept> = {
  id: string
  zh: Asked
  en: Asked
  gold: Answer
  accept: Accept
  rationale: string
  difficulty: 'hard' | 'medium'
  tags: string[]
}

/** effort-submit: the message the person sent and what came before it. */
export type SubmitAsked = { message: string; recent_context: ContextEntry[] }
export type EffortSubmitItem = Item<SubmitAsked, Effort, Effort[]>

/**
 * unresolved: an effort-submit item (the message and the conversation before
 * it) from a thread that may have gone round several times on one problem,
 * plus the answer to the three-way question about the message (`triage`).
 * `command` is there when the message starts a command turn: the command as
 * the person typed it (`message`), and what it is for, as the mod gives it to
 * the decision model beside the message (`name`, `description`).
 */
export const TRIAGES = ['unresolved', 'resolved', 'new'] as const
export type Triage = (typeof TRIAGES)[number]
export type UnresolvedAsked = SubmitAsked & { command?: { name: string; description: string } }
export type UnresolvedItem = Item<UnresolvedAsked, Effort, Effort[]> & { triage: Triage }

/**
 * The tag of an unresolved item whose conversation overruns what the mod
 * reads of it when a message is sent (the state's budget, `BACKEND_DEFAULTS.jev.contextTokens`): its earlier rounds fall outside.
 */
export const OVER_BUDGET = 'over-budget'

/**
 * One tool call of an effort-midturn row: its name; `input`, the arguments
 * that say what it worked on (only those the mod's toolDetail reads,
 * DETAIL_KEYS; never what it wrote or returned); `result`, how it ended (the
 * words the mod's line starts with) and, in the dataset's own words, what
 * came of it. The mod never sends what came of a call: the suite writes each
 * call's line from its outcome and `input`, as the mod does.
 */
export type MidturnRowTool = { name: string; result: string; input: Readonly<Record<string, string>> }
export type MidturnRowStep = { assistant_text: string; tools: readonly MidturnRowTool[] }

/**
 * effort-midturn: a snippet of a turn as the mid-turn re-decision reads it,
 * field for field (MidturnInput): the person's message, the step about to go
 * out, the level it goes at, the turn's counts and its latest steps, each
 * call as the dataset writes it (MidturnRowTool). A row has no `trouble`; a
 * suite adds one where #7 would.
 */
export type MidturnAsked = Omit<MidturnInput, 'trouble' | 'recent_steps'> & { recent_steps: readonly MidturnRowStep[] }
export type EffortMidturnItem = Item<MidturnAsked, Effort, Effort[]>

/** `subagent` (dispatched agents): the models a dispatched agent can be given (fable only where an item really needs it). */
export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export type Model = (typeof MODELS)[number]

/**
 * `subagent` (dispatched agents): one dispatch through the Agent tool (`kind: 'agent'`, with its
 * `description` and `agent_type`) or one `agent()` of a Workflow script
 * (`kind: 'workflow'`, with the workflow's description and the agent's
 * `label`; `agent_type` only when the script passes one). The prompt and
 * label keep placeholders such as `${file}`.
 */
export type AgentAsked = {
  user_message: string
  kind: 'agent' | 'workflow'
  agent_type: string | null
  description: string | null
  prompt: string
  requested_model: Model | null
  workflow_description: string | null
  label: string | null
}
/** haiku takes no effort (null); any other model one level. */
export type AgentAnswer = { model: Model; effort: Effort | null }
export type AgentItem = Item<AgentAsked, AgentAnswer, { model: Model[]; effort: (Effort | null)[] }>

/**
 * skill: what to recommend for a message, by skill name as the main agent's
 * skill listing writes it. `gold` the best (in order; empty when no skill
 * should be recommended), `accept` every name that counts as right,
 * `must_not` names that are wrong to recommend (look-alikes), and
 * `user_only_hint` user-only skills (`disable-model-invocation`) to hint on
 * the status line instead of recommending.
 */
export type SkillItem = Item<SubmitAsked, string[], string[]> & { must_not: string[]; user_only_hint: string[] }

/**
 * The snapshot of the person's skills the skill items are written against
 * (`skill-catalog.json`): `status` is `candidate` (the main agent may load
 * it: the only names gold and accept take), `user-only-frontmatter` (the
 * only names user_only_hint takes) or `off`.
 */
export type SkillCatalog = { skills: readonly { name: string; status: string }[] }

/** What some kinds are checked against besides their items. */
export type Extra = { catalog?: unknown }

export type Checked = { errors: string[]; warnings: string[] }

/** The items of a JSONL text; blank lines are skipped, a line that is not a JSON object is an error. */
export function parseJsonl(text: string): { items: Record<string, unknown>[]; errors: string[] } {
  const items: Record<string, unknown>[] = []
  const errors: string[] = []
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      errors.push(`line ${i + 1}: not JSON`)
      return
    }
    if (isRecord(value)) items.push(value)
    else errors.push(`line ${i + 1}: not a JSON object`)
  })
  return { items, errors }
}

/** Checks a dataset of `kind`: every item's rules (errors, prefixed with its id) and the dataset's quotas (warnings). */
export function validateDataset(kind: Kind, items: readonly unknown[], extra: Extra = {}): Checked {
  const errors: string[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  let statusOf: ((name: string) => string | undefined) | null = null
  if (kind === 'skill') {
    statusOf = catalogLookup(extra.catalog)
    if (statusOf === null) errors.push('skill items need the catalog (skill-catalog.json beside skill.jsonl) to check skill names')
  }
  items.forEach((raw, i) => {
    const id = isRecord(raw) && typeof raw.id === 'string' && raw.id !== '' ? raw.id : null
    const name = id ?? `item ${i + 1}`
    const add = (message: string) => errors.push(`${name}: ${message}`)
    if (!isRecord(raw)) return add('not a JSON object')
    if (id === null) add('id must be a non-empty string')
    else if (seen.has(id)) add('appears twice')
    else seen.add(id)
    checkCommon(kind, raw, add)
    if (!isRecord(raw.zh) || !isRecord(raw.en)) return
    RULES[kind](raw, add)
    if (kind === 'skill' && statusOf !== null) checkSkillNames(raw, statusOf, add)
  })
  const records = items.filter(isRecord)
  warnings.push(...hardQuota(records), ...QUOTAS[kind](records))
  return { errors, warnings }
}

type Add = (message: string) => void

/** Top-level fields of each kind's items. */
const FIELDS: Record<Kind, readonly string[]> = {
  'effort-submit': ['id', 'zh', 'en', 'gold', 'accept', 'rationale', 'difficulty', 'tags'],
  'effort-midturn': ['id', 'zh', 'en', 'gold', 'accept', 'rationale', 'difficulty', 'tags'],
  subagent: ['id', 'zh', 'en', 'gold', 'accept', 'rationale', 'difficulty', 'tags'],
  skill: ['id', 'zh', 'en', 'gold', 'accept', 'must_not', 'user_only_hint', 'rationale', 'difficulty', 'tags'],
  unresolved: ['id', 'zh', 'en', 'gold', 'accept', 'triage', 'rationale', 'difficulty', 'tags'],
}

function checkCommon(kind: Kind, item: Record<string, unknown>, add: Add): void {
  for (const field of FIELDS[kind]) if (!(field in item)) add(`${field} is missing`)
  for (const field of Object.keys(item)) if (!FIELDS[kind].includes(field)) add(`unknown field ${field}`)
  if ('zh' in item && !isRecord(item.zh)) add('zh must be an object')
  if ('en' in item && !isRecord(item.en)) add('en must be an object')
  if ('rationale' in item && !nonEmpty(item.rationale)) add('rationale must be a non-empty string')
  if ('difficulty' in item && item.difficulty !== 'hard' && item.difficulty !== 'medium') add('difficulty must be "hard" or "medium"')
  if ('tags' in item && !(Array.isArray(item.tags) && item.tags.every(nonEmpty))) add('tags must be an array of non-empty strings')
}

const RULES: Record<Kind, (item: Record<string, unknown>, add: Add) => void> = {
  'effort-submit': (item, add) => {
    checkSubmitAsked(item, add)
    checkEffortAnswer(item, add)
  },
  'effort-midturn': (item, add) => {
    checkMidturnAsked(item, add)
    checkEffortAnswer(item, add)
    if (Array.isArray(item.accept) && item.accept.length > 2) add(`accept ${JSON.stringify(item.accept)} is wider than at most two levels`)
  },
  subagent: (item, add) => {
    checkAgentAsked(item, add)
    checkAgentAnswer(item, add)
    checkPriority(item, add)
    checkFable(item, add)
  },
  skill: (item, add) => {
    checkSubmitAsked(item, add)
    checkSkillAnswer(item, add)
  },
  unresolved: (item, add) => {
    checkSubmitAsked(item, add, ['command'])
    checkCommand(item, add)
    checkEffortAnswer(item, add)
    if (!(TRIAGES as readonly unknown[]).includes(item.triage)) add(`triage ${JSON.stringify(item.triage)} is not one of ${TRIAGES.join(', ')}`)
    checkOverBudget(item, add)
  },
}

const SKILL_LISTS = ['gold', 'accept', 'must_not', 'user_only_hint'] as const

/** The four lists hold names, each once; gold within accept (both empty when nothing should be recommended); no name both right and wrong. */
function checkSkillAnswer(item: Record<string, unknown>, add: Add): void {
  const lists: Partial<Record<(typeof SKILL_LISTS)[number], string[]>> = {}
  for (const field of SKILL_LISTS) {
    const list = item[field]
    if (!Array.isArray(list) || !list.every(nonEmpty)) {
      add(`${field} must be an array of skill names`)
      continue
    }
    for (const name of new Set(list.filter((name, i) => list.indexOf(name) !== i))) add(`${field} names "${name}" twice`)
    lists[field] = list
  }
  const { gold, accept, must_not: mustNot, user_only_hint: hints } = lists
  if (gold === undefined || accept === undefined || mustNot === undefined || hints === undefined) return
  for (const name of gold) if (!accept.includes(name)) add(`gold "${name}" is not in accept`)
  if (gold.length === 0 && accept.length > 0) add('gold is empty (recommend nothing), so accept must be empty too')
  for (const name of accept) if (mustNot.includes(name)) add(`"${name}" is both acceptable and in must_not`)
  for (const name of hints) if (accept.includes(name) || mustNot.includes(name)) add(`"${name}" is both a user-only hint and in ${accept.includes(name) ? 'accept' : 'must_not'}`)
}

/** Every name is in the catalog: gold and accept candidates, user_only_hint user-only skills, must_not any. */
function checkSkillNames(item: Record<string, unknown>, statusOf: (name: string) => string | undefined, add: Add): void {
  const names = (field: string): string[] => (Array.isArray(item[field]) ? item[field].filter(nonEmpty) : [])
  const where = (status: string | undefined) => (status === undefined ? 'not in the catalog' : `status ${status}`)
  for (const field of ['gold', 'accept'] as const) {
    for (const name of names(field)) if (statusOf(name) !== 'candidate') add(`${field}: "${name}" is not a candidate (${where(statusOf(name))})`)
  }
  for (const name of names('user_only_hint')) if (statusOf(name) !== 'user-only-frontmatter') add(`user_only_hint: "${name}" is not a user-only skill (${where(statusOf(name))})`)
  for (const name of names('must_not')) if (statusOf(name) === undefined) add(`must_not: "${name}" is not in the catalog`)
}

/** A skill's status by name, or null when `catalog` is not a catalog. */
function catalogLookup(catalog: unknown): ((name: string) => string | undefined) | null {
  if (!isRecord(catalog) || !Array.isArray(catalog.skills)) return null
  const status = new Map<string, string>()
  for (const skill of catalog.skills) if (isRecord(skill) && typeof skill.name === 'string' && typeof skill.status === 'string') status.set(skill.name, skill.status)
  return (name) => status.get(name)
}

/** `{ message, recent_context }` in both languages, the context the same shape in both (roles, tools). */
function checkSubmitAsked(item: Record<string, unknown>, add: Add, optional: readonly string[] = []): void {
  const contexts: Partial<Record<Language, unknown[]>> = {}
  for (const language of LANGUAGES) {
    const asked = item[language] as Record<string, unknown>
    exactKeys(asked, ['message', 'recent_context', ...optional.filter((key) => key in asked)], language, add)
    if (!nonEmpty(asked.message)) add(`${language}.message must be a non-empty string`)
    if (!Array.isArray(asked.recent_context)) {
      add(`${language}.recent_context must be an array`)
      continue
    }
    contexts[language] = asked.recent_context
    asked.recent_context.forEach((entry, i) => checkContextEntry(entry, `${language}.recent_context[${i}]`, add))
  }
  const { zh, en } = contexts
  if (zh === undefined || en === undefined) return
  if (zh.length !== en.length) return add(`zh.recent_context has ${zh.length} entries, en.recent_context ${en.length}`)
  zh.forEach((entry, i) => {
    const other = en[i]
    if (!isRecord(entry) || !isRecord(other)) return
    if (entry.role !== other.role) add(`recent_context[${i}].role differs between zh and en`)
    if (JSON.stringify(entry.tools ?? []) !== JSON.stringify(other.tools ?? [])) add(`recent_context[${i}].tools differ between zh and en`)
  })
}

/** `command`, when there is one: a name (the same in both languages) and a description, each a non-empty string; in both languages or in neither. */
function checkCommand(item: Record<string, unknown>, add: Add): void {
  const [zh, en] = [item.zh as Record<string, unknown>, item.en as Record<string, unknown>]
  if ('command' in zh !== 'command' in en) return add('command is in one language only')
  for (const language of LANGUAGES) {
    const command = (item[language] as Record<string, unknown>).command
    if (command === undefined) continue
    if (!isRecord(command)) return add(`${language}.command must be { name, description }`)
    exactKeys(command, ['name', 'description'], `${language}.command`, add)
    for (const field of ['name', 'description'] as const) if (!nonEmpty(command[field])) add(`${language}.command.${field} must be a non-empty string`)
  }
  if (isRecord(zh.command) && isRecord(en.command) && zh.command.name !== en.command.name) add('command.name differs between zh and en')
}

/** What the mod's state would hold of the conversation before the message, with no budget: the lines and the message, as the mod writes them. */
export function stateTokens(asked: SubmitAsked): number {
  const messages: ContextMessage[] = asked.recent_context.map((entry) => ({ role: entry.role, text: entry.text, toolUses: (entry.tools ?? []).map((tool) => ({ tool })) }))
  return estimateTokens(JSON.stringify({ user_message: asked.message, recent_context: recentLines(messages, asked.message, Number.MAX_SAFE_INTEGER).join('\n') }))
}

/** The context budget of the state a message's request has today, in estimated tokens. */
const BUDGET = BACKEND_DEFAULTS.jev.contextTokens

/** An item is tagged `over-budget` exactly when its state overruns the budget in both languages (no item is long in one language only). */
function checkOverBudget(item: Record<string, unknown>, add: Add): void {
  const tagged = Array.isArray(item.tags) && item.tags.includes(OVER_BUDGET)
  const sizes = LANGUAGES.map((language) => [language, stateTokens(item[language] as SubmitAsked)] as const)
  if (sizes.some(([, size]) => !Number.isFinite(size))) return
  const over = sizes.filter(([, size]) => size > BUDGET)
  const list = sizes.map(([language, size]) => `${language} ${size}`).join(', ')
  if (tagged && over.length < LANGUAGES.length) add(`tagged ${OVER_BUDGET}, but the conversation fits ${BUDGET} tokens in ${sizes.filter(([, size]) => size <= BUDGET).map(([language]) => language).join(' and ')} (${list})`)
  else if (!tagged && over.length > 0) add(`the conversation overruns ${BUDGET} tokens in ${over.map(([language]) => language).join(' and ')} (${list}) and has no ${OVER_BUDGET} tag`)
}

/**
 * How a tool call ended, as each tool result of a midturn item starts: the
 * words the mod's line starts with (OUTCOME_WORDS), then `：` or `: `. A row
 * holds only calls that have ended, so none is still running.
 */
const OUTCOMES: Record<Language, readonly string[]> = {
  zh: (['ok', 'failed', 'blocked', 'denied'] as const).map((outcome) => `${OUTCOME_WORDS.zh[outcome]}：`),
  en: (['ok', 'failed', 'blocked', 'denied'] as const).map((outcome) => `${OUTCOME_WORDS.en[outcome]}: `),
}
const COUNTS = ['judgments', 'changes', 'failures', 'hook_blocks'] as const

/**
 * `{ message, step, current_effort, counts, recent_steps }` in both languages:
 * the step (`turn.step`'s index, from 0), the current level and the counts
 * the same in both, the recent steps oldest first, the same tools in both,
 * each result starting with how the call ended (`成功：` / `Success: ` ...),
 * each input the same in both but for its description. `counts.failures`
 * counts since the counts last started over (the turn's start, or a forced
 * escalation), as the mod counts them; hook blocks and denials are not
 * failures.
 */
function checkMidturnAsked(item: Record<string, unknown>, add: Add): void {
  const steps: Partial<Record<Language, unknown[]>> = {}
  for (const language of LANGUAGES) {
    const asked = item[language] as Record<string, unknown>
    exactKeys(asked, ['message', 'step', 'current_effort', 'counts', 'recent_steps'], language, add)
    if (!nonEmpty(asked.message)) add(`${language}.message must be a non-empty string`)
    if (!wholeNumber(asked.step)) add(`${language}.step must be a whole number (the step's index, from 0)`)
    if (!isEffort(asked.current_effort)) add(`${language}.current_effort must be an effort level`)
    if (!isRecord(asked.counts)) add(`${language}.counts must be an object`)
    else {
      exactKeys(asked.counts, COUNTS, `${language}.counts`, add)
      for (const key of COUNTS) if (key in asked.counts && !wholeNumber(asked.counts[key])) add(`${language}.counts.${key} must be a whole number`)
    }
    if (!Array.isArray(asked.recent_steps)) {
      add(`${language}.recent_steps must be an array`)
      continue
    }
    steps[language] = asked.recent_steps
    asked.recent_steps.forEach((step, i) => checkRecentStep(step, language, `${language}.recent_steps[${i}]`, add))
  }
  const zh = item.zh as Record<string, unknown>
  const en = item.en as Record<string, unknown>
  for (const field of ['step', 'current_effort'] as const) if (zh[field] !== en[field]) add(`${field} differs between zh and en`)
  if (JSON.stringify(zh.counts) !== JSON.stringify(en.counts)) add('counts differ between zh and en')
  const [zhSteps, enSteps] = [steps.zh, steps.en]
  if (zhSteps === undefined || enSteps === undefined) return
  if (zhSteps.length !== enSteps.length) return add(`zh.recent_steps has ${zhSteps.length} steps, en.recent_steps ${enSteps.length}`)
  zhSteps.forEach((step, i) => {
    const other = enSteps[i]
    const tools = isRecord(step) && Array.isArray(step.tools) ? step.tools : []
    const others = isRecord(other) && Array.isArray(other.tools) ? other.tools : []
    if (tools.length !== others.length) return add(`recent_steps[${i}] calls ${tools.length} tools in zh, ${others.length} in en`)
    tools.forEach((tool, j) => {
      const twin = others[j]
      if (!isRecord(tool) || !isRecord(twin)) return
      if (tool.name !== twin.name) add(`recent_steps[${i}].tools[${j}].name differs between zh and en`)
      const [a, b] = [outcome(tool.result, 'zh'), outcome(twin.result, 'en')]
      if (a !== -1 && b !== -1 && a !== b) add(`recent_steps[${i}].tools[${j}] outcome differs between zh and en`)
      // What a call worked on is the same in both languages; its description is the model's words, in the turn's language.
      if (!isRecord(tool.input) || !isRecord(twin.input)) return
      for (const key of new Set([...Object.keys(tool.input), ...Object.keys(twin.input)])) {
        if (key === 'description' ? key in tool.input !== key in twin.input : tool.input[key] !== twin.input[key]) add(`recent_steps[${i}].tools[${j}].input.${key} differs between zh and en`)
      }
    })
  })
}

function checkRecentStep(step: unknown, language: Language, at: string, add: Add): void {
  if (!isRecord(step)) return add(`${at} must be an object`)
  exactKeys(step, ['assistant_text', 'tools'], at, add)
  if (typeof step.assistant_text !== 'string') add(`${at}.assistant_text must be a string`)
  if (!Array.isArray(step.tools)) return add(`${at}.tools must be an array`)
  step.tools.forEach((tool, j) => {
    const where = `${at}.tools[${j}]`
    if (!isRecord(tool)) return add(`${where} must be an object`)
    exactKeys(tool, ['name', 'result', 'input'], where, add)
    if (!nonEmpty(tool.name)) add(`${where}.name must be a tool name`)
    if (outcome(tool.result, language) === -1) add(`${where}.result must start with one of ${OUTCOMES[language].map((p) => JSON.stringify(p)).join(', ')}`)
    if (!isRecord(tool.input)) return add(`${where}.input must be an object (the arguments that say what the call worked on; {} for none)`)
    for (const [key, value] of Object.entries(tool.input)) {
      if (!(DETAIL_KEYS as readonly string[]).includes(key)) add(`${where}.input has ${key}: an input holds only ${DETAIL_KEYS.join(', ')}`)
      else if (!nonEmpty(value)) add(`${where}.input.${key} must be a non-empty string`)
    }
  })
}

/** Which way a tool result says the call ended (an index into OUTCOMES), -1 when it does not say. */
function outcome(result: unknown, language: Language): number {
  return typeof result === 'string' ? OUTCOMES[language].findIndex((prefix) => result.startsWith(prefix)) : -1
}

const AGENT_FIELDS = ['user_message', 'kind', 'agent_type', 'description', 'prompt', 'requested_model', 'workflow_description', 'label'] as const

/** Both languages: the same kind, agent type, requested model and label; the fields each kind sets, and only those. */
function checkAgentAsked(item: Record<string, unknown>, add: Add): void {
  for (const language of LANGUAGES) {
    const asked = item[language] as Record<string, unknown>
    exactKeys(asked, AGENT_FIELDS, language, add)
    for (const field of ['user_message', 'prompt'] as const) if (!nonEmpty(asked[field])) add(`${language}.${field} must be a non-empty string`)
    if (asked.agent_type !== null && !nonEmpty(asked.agent_type)) add(`${language}.agent_type must be a name or null`)
    if (asked.requested_model !== null && !isModel(asked.requested_model)) add(`${language}.requested_model must be one of ${MODELS.join(', ')} or null`)
    const has = (field: 'description' | 'workflow_description' | 'label') => nonEmpty(asked[field])
    const none = (field: 'description' | 'workflow_description' | 'label') => asked[field] === null
    if (asked.kind === 'workflow') {
      if (!has('workflow_description')) add(`${language}.workflow_description: a workflow agent has the workflow's description`)
      if (!has('label')) add(`${language}.label: a workflow agent has a label`)
      if (!none('description')) add(`${language}.description: a workflow agent has none (null)`)
    } else if (asked.kind === 'agent') {
      if (!has('description')) add(`${language}.description: a dispatched agent has one`)
      if (!none('workflow_description')) add(`${language}.workflow_description: a dispatched agent has none (null)`)
      if (!none('label')) add(`${language}.label: a dispatched agent has none (null)`)
    } else add(`${language}.kind must be "agent" or "workflow"`)
  }
  const zh = item.zh as Record<string, unknown>
  const en = item.en as Record<string, unknown>
  for (const field of ['kind', 'agent_type', 'requested_model', 'label'] as const) if (zh[field] !== en[field]) add(`${field} differs between zh and en`)
}

/** `gold` one model and its effort (null for haiku); `accept` the acceptable models and efforts, null among the efforts exactly when haiku is among the models. */
function checkAgentAnswer(item: Record<string, unknown>, add: Add): void {
  const { gold, accept } = item
  if (!isRecord(gold) || !isModel(gold.model)) add(`gold must be { model: ${MODELS.join(' | ')}, effort }`)
  else if (gold.model === 'haiku' && gold.effort !== null) add('gold: haiku takes no effort (null)')
  else if (gold.model !== 'haiku' && !isEffort(gold.effort)) add(`gold: ${gold.model} needs an effort level`)
  if (!isRecord(accept) || !Array.isArray(accept.model) || !Array.isArray(accept.effort)) return add('accept must be { model: [...], effort: [...] }')
  const models = accept.model
  const efforts = accept.effort
  if (models.length === 0 || !models.every(isModel) || new Set(models).size !== models.length) return add(`accept.model must name models (${MODELS.join(', ')}), each once`)
  if (efforts.length === 0 || !efforts.every((e) => e === null || isEffort(e)) || new Set(efforts).size !== efforts.length) return add('accept.effort must name effort levels or null, each once')
  if (efforts.includes(null) !== models.includes('haiku')) add('accept.effort holds null exactly when accept.model holds haiku')
  const levels = efforts.filter(isEffort)
  if (models.some((model) => model !== 'haiku') && levels.length === 0) add('accept.effort has no level for the models other than haiku')
  if (!contiguous(levels)) add(`accept.effort ${JSON.stringify(efforts)} is not contiguous: acceptable levels must be adjacent`)
  if (isRecord(gold) && isModel(gold.model) && (!models.includes(gold.model) || !efforts.includes(gold.effort as Effort | null))) add(`gold ${JSON.stringify(gold)} is not in accept`)
}

export const PRIORITIES = ['priority:user', 'priority:main-kept', 'priority:main-overridden', 'priority:none'] as const

/**
 * Which priority case an item tests, one tag each: the person named a model
 * (it is the only acceptable model), the main agent's choice is kept (gold)
 * or overridden (not gold), or no model was asked for.
 */
function checkPriority(item: Record<string, unknown>, add: Add): void {
  const tags = Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string' && tag.startsWith('priority:')) : []
  if (tags.length !== 1 || !(PRIORITIES as readonly string[]).includes(tags[0] as string)) return add(`needs exactly one priority:* tag (${PRIORITIES.join(', ')})`)
  const requested = (item.zh as Record<string, unknown>).requested_model
  const model = isRecord(item.gold) ? item.gold.model : undefined
  const accepted = isRecord(item.accept) && Array.isArray(item.accept.model) ? item.accept.model : []
  switch (tags[0]) {
    case 'priority:user':
      if (accepted.length !== 1) add(`priority:user: the model the person named is the only acceptable model; accept.model is ${JSON.stringify(accepted)}`)
      break
    case 'priority:main-kept':
      if (requested === null || model !== requested) add(`priority:main-kept: gold.model must be the main agent's requested_model (${String(requested)})`)
      break
    case 'priority:main-overridden':
      if (requested === null || model === requested) add(`priority:main-overridden: gold.model must differ from the main agent's requested_model (${String(requested)})`)
      break
    default:
      if (requested !== null) add('priority:none: requested_model must be null')
  }
}

/** fable is off by default: an item that answers, asks for or mentions it carries the `fable` tag. */
function checkFable(item: Record<string, unknown>, add: Add): void {
  const tagged = Array.isArray(item.tags) && item.tags.includes('fable')
  const answers = JSON.stringify([item.gold, item.accept])
  const texts = LANGUAGES.map((language) => JSON.stringify(item[language])).join(' ')
  if (!tagged && (answers.includes('"fable"') || /fable/i.test(texts))) add('fable is answered, asked for or mentioned, but the item has no fable tag')
}

function isModel(value: unknown): value is Model {
  return typeof value === 'string' && (MODELS as readonly string[]).includes(value)
}

function checkContextEntry(entry: unknown, at: string, add: Add): void {
  if (!isRecord(entry)) return add(`${at} must be an object`)
  for (const key of Object.keys(entry)) if (!['role', 'text', 'tools'].includes(key)) add(`${at} has an unknown field ${key}`)
  if (entry.role !== 'user' && entry.role !== 'assistant') add(`${at}.role must be "user" or "assistant"`)
  if (typeof entry.text !== 'string') add(`${at}.text must be a string`)
  if ('tools' in entry && !(Array.isArray(entry.tools) && entry.tools.every(nonEmpty))) add(`${at}.tools must be an array of tool names`)
}

/** An effort answer: `gold` one level, `accept` a run of adjacent levels that holds it. */
function checkEffortAnswer(item: Record<string, unknown>, add: Add): void {
  const { gold, accept } = item
  if (!isEffort(gold)) add(`gold ${JSON.stringify(gold)} is not an effort level (${EFFORTS.join(', ')})`)
  if (!Array.isArray(accept) || accept.length === 0) return add('accept must be a non-empty array of effort levels')
  const bad = accept.filter((level) => !isEffort(level))
  if (bad.length > 0) return add(`accept holds ${JSON.stringify(bad)}, not effort levels`)
  if (new Set(accept).size !== accept.length) add(`accept ${JSON.stringify(accept)} names a level twice`)
  if (isEffort(gold) && !accept.includes(gold)) add(`gold "${gold}" is not in accept ${JSON.stringify(accept)}`)
  if (!contiguous(accept as Effort[])) add(`accept ${JSON.stringify(accept)} is not contiguous: acceptable levels must be adjacent`)
}

/** Whether `levels` are adjacent levels (in any order). */
function contiguous(levels: readonly Effort[]): boolean {
  const at = [...new Set(levels)].map((level) => EFFORTS.indexOf(level)).sort((a, b) => a - b)
  return at.every((index, i) => i === 0 || index === (at[i - 1] as number) + 1)
}

/** Every kind's items lean hard: at least 70% (spec: 题目偏难). */
function hardQuota(items: readonly Record<string, unknown>[]): string[] {
  const hard = share(items, (item) => item.difficulty === 'hard')
  return hard < 0.7 ? [`hard items are ${percent(hard)}; the drafting rules ask for at least 70%`] : []
}

/** Each kind's own dataset-wide shares. */
const QUOTAS: Record<Kind, (items: readonly Record<string, unknown>[]) => string[]> = {
  'effort-submit': () => [],
  'effort-midturn': () => [],
  subagent: (items) => {
    const workflow = share(items, (item) => isRecord(item.zh) && item.zh.kind === 'workflow')
    return workflow < 0.3 ? [`workflow agents are ${percent(workflow)} of items; the drafting rules ask for at least 30%`] : []
  },
  skill: (items) => {
    const warnings: string[] = []
    const none = share(items, (item) => Array.isArray(item.gold) && item.gold.length === 0)
    if (none < 0.2) warnings.push(`items where no skill fits are ${percent(none)}; the drafting rules ask for at least 20%`)
    const hinted = items.filter((item) => Array.isArray(item.user_only_hint) && item.user_only_hint.length > 0).length
    if (hinted < 10) warnings.push(`${hinted} items hint a user-only skill; the drafting rules ask for at least 10`)
    return warnings
  },
  unresolved: (items) => {
    const warnings: string[] = []
    for (const answer of TRIAGES) {
      const n = items.filter((item) => item.triage === answer).length
      if (n < 5) warnings.push(`${n} items have triage "${answer}"; the drafting rules ask for at least 5`)
    }
    const over = share(items, (item) => Array.isArray(item.tags) && item.tags.includes(OVER_BUDGET))
    if (over < 0.25) warnings.push(`${OVER_BUDGET} items are ${percent(over)} of the dataset; the drafting rules ask for at least 25%`)
    const top = items.filter((item) => item.gold === 'max').length
    if (top < 8) warnings.push(`${top} items have gold max; the drafting rules ask for at least 8 (a recall of the top level needs a sample)`)
    return warnings
  },
}

function share<T>(items: readonly T[], test: (item: T) => boolean): number {
  return items.length === 0 ? 0 : items.filter(test).length / items.length
}

function percent(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], at: string, add: Add): void {
  for (const key of keys) if (!(key in value)) add(`${at}.${key} is missing`)
  for (const key of Object.keys(value)) if (!keys.includes(key)) add(`${at} has an unknown field ${key}`)
}

function wholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** A JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
