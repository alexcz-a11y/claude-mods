// The subagent suite: a dispatched agent's model and effort (#6's feature),
// decided once, when the main agent dispatches the agent; and an agent() of
// a Workflow script, decided the same way (#8). An item is one such agent:
// the person's message this turn and the agent's brief as the main agent
// wrote it. The requests are built by the decision modules the mod uses
// (hooks/decision/dispatched-agent.ts; for a Workflow's agents,
// hooks/decision/workflow.ts), with the mod's settings, so the eval measures
// the prompt the mod sends.
//
// A Workflow's agents are asked about as #8 asks about a script's agent()
// calls: the dataset's items of one workflow (the same description and the
// same message) stand for its calls, in the dataset's order, and share
// requests as `workflowBatches` groups them, each in a part and a brief of its
// own. Each item sends its script's request (the one holding its call) and
// reads its own part; the others' answers in it are not used, so a run sends
// a script's request once per item of it.
//
// Variants (spec #70, guide §4.2): the model question's options named by the
// models (the mod today) or by the kind of work each suits (`work`); the main
// agent's pick a hint inside the model question (the mod today) or a question
// of its own, `requested_fits` (`noul`); `-single`: each of a Workflow's
// agents in a request of its own (a dispatched agent is asked as in
// `models-hint`).
//
// Pure: no Node API.

import { dispatchSettings } from '../../hooks/core/setup.ts'
import { messageText } from '../../hooks/decision/context.ts'
import {
  AGENT_MODELS,
  DEFAULT_AGENT_MODELS,
  DEFAULT_DISPATCH_ASK,
  EFFORT,
  MODEL,
  NAMED_EFFORT,
  decideDispatch,
  dispatchPart,
  dispatchState,
  type Dispatch,
  type DispatchAsk,
  type DispatchDecision,
  type DispatchSettings,
} from '../../hooks/decision/dispatched-agent.ts'
import type { Asked } from '../../hooks/decision/backend.ts'
import { DEFAULT_ASK, EFFORTS, type Effort } from '../../hooks/decision/effort.ts'
import { answersFor, mergeParts, type Answer, type DecisionRequest, type Part } from '../../hooks/decision/system-one.ts'
import { MAX_PER_REQUEST, readOutcomes, workflowBatches } from '../../hooks/decision/workflow.ts'
import type { AgentCall, ParsedWorkflow } from '../../hooks/decision/workflow-script.ts'
import { PRIORITIES, type Language, type SubagentAnswer, type SubagentItem } from './datasets.ts'
import type { Row } from './runner.ts'
import type { Ask, Decided, Grade, Settings, Suite } from './suite.ts'

/** How a variant asks: the questions (`ask`), and how many of a Workflow's agents share a request at most. */
type SubagentVariant = { ask: DispatchAsk; perRequest: number }

/** The variants by name: `<option names>-<the main agent's pick>[-single]`; the first is how the mod asks today (DEFAULT_DISPATCH_ASK, MAX_PER_REQUEST). */
export const SUBAGENT_VARIANTS: Readonly<Record<string, SubagentVariant>> = {
  'models-hint': { ask: DEFAULT_DISPATCH_ASK, perRequest: MAX_PER_REQUEST },
  'work-hint': { ask: { ...DEFAULT_DISPATCH_ASK, options: 'work' }, perRequest: MAX_PER_REQUEST },
  'models-noul': { ask: { ...DEFAULT_DISPATCH_ASK, requested: 'noul' }, perRequest: MAX_PER_REQUEST },
  'work-noul': { ask: { ...DEFAULT_DISPATCH_ASK, options: 'work', requested: 'noul' }, perRequest: MAX_PER_REQUEST },
  'models-hint-single': { ask: DEFAULT_DISPATCH_ASK, perRequest: 1 },
}

function variantOf(variant: string): SubagentVariant {
  const known = SUBAGENT_VARIANTS[variant]
  if (known === undefined) throw new RangeError(`no variant "${variant}" (${Object.keys(SUBAGENT_VARIANTS).join(', ')})`)
  return known
}

function variantAsk(variant: string): DispatchAsk {
  return variantOf(variant).ask
}

/**
 * What decides an agent, as the mod decides it (core/setup.ts
 * `dispatchSettings`, the one features/dispatched-agents.ts uses): fable is
 * offered when `agentFable` is on; `agentOverride` is how sure the decision
 * model must be to replace the main agent's pick.
 */
function agentSettings(settings: Settings, ask: DispatchAsk): DispatchSettings {
  return dispatchSettings({ config: settings, ask: DEFAULT_ASK }, ask)
}

/** The request the mod sends about the item's dispatched agent in `language`, asked as `variant` says. */
function subagentRequest(item: SubagentItem, language: Language, variant: string, settings: Settings): { request: DecisionRequest; part: Part; dispatch: Dispatch; shape: DispatchSettings } {
  const asked = item[language]
  // The person's words as the mod keeps them for the turn (`said`): masked and cut to the context budget.
  const dispatch: Dispatch = { ...asked, user_message: messageText(asked.user_message, settings.context.tokens) }
  const shape = agentSettings(settings, variantAsk(variant))
  const part = dispatchPart(dispatch, shape)
  return { request: mergeParts(dispatchState(dispatch, settings.context.tokens), [part]), part, dispatch, shape }
}

/**
 * The agent() calls of the workflow a Workflow item belongs to, in
 * `language`: the dataset's items with its description and its message, in
 * the dataset's order (the item itself among them, last when the dataset
 * does not hold it).
 */
function workflowOf(dataset: readonly SubagentItem[], item: SubagentItem, language: Language): SubagentItem[] {
  const key = (one: SubagentItem) => `${one[language].workflow_description ?? ''}\n${one[language].user_message}`
  const mine = dataset.filter((one) => one[language].kind === 'workflow' && key(one) === key(item))
  return mine.some((one) => one.id === item.id) ? mine : [...mine, item]
}

/** The script those items' calls stand for, as #8 reads a submitted one: its description, and each call's prompt, label, agent type and model as written. */
function scriptOf(items: readonly SubagentItem[], language: Language): ParsedWorkflow {
  return {
    script: '',
    meta: { name: null, description: items[0]?.[language].workflow_description ?? null },
    calls: items.map((one, index): AgentCall => {
      const asked = one[language]
      return {
        index,
        line: index + 1,
        prompt: asked.prompt,
        label: asked.label,
        labelKind: asked.label === null ? 'none' : asked.label.includes('${') ? 'template' : 'string',
        agentType: asked.agent_type,
        model: asked.requested_model === null ? { kind: 'none' } : { kind: 'literal', value: asked.requested_model },
        effort: { kind: 'none' },
        edit: null,
      }
    }),
  }
}

/**
 * A Workflow item decided as #8 decides its call: the request holding the
 * call among its script's (`workflowBatches`, at most `perRequest` calls a
 * request; the dataset's scripts have at most 4 calls, within its
 * MAX_REQUESTS), read as #8 reads it (`readOutcomes`).
 */
async function decideWorkflowAgent(dataset: readonly SubagentItem[], item: SubagentItem, language: Language, variant: string, ask: Ask, settings: Settings): Promise<Decided<SubagentAnswer>> {
  const group = workflowOf(dataset, item, language)
  const index = group.findIndex((one) => one.id === item.id)
  const parsed = scriptOf(group, language)
  // The person's words as #8 reads them: the turn's, as the mod keeps them (masked and cut to the context budget).
  const words = messageText(item[language].user_message, settings.context.tokens)
  const { ask: asking, perRequest } = variantOf(variant)
  const shape = agentSettings(settings, asking)
  const plan = workflowBatches(parsed, words, shape, settings.context.tokens, perRequest)
  const at = plan.batches.findIndex((batch) => batch.calls.includes(index))
  const batch = plan.batches[at]
  if (batch === undefined) {
    const reason = plan.skipped.find((skip) => skip.index === index)?.reason ?? 'unanswered'
    return { ok: false, failure: reason === 'unreadable' ? 'left: its prompt does not say what the work is (left to #9)' : `left: ${reason}` }
  }
  const { asked } = await ask(batch.request)
  if (!asked.ok) return { ok: false, failure: `${asked.failure.kind}: ${asked.failure.detail}` }
  const results: Asked[] = []
  results[at] = asked
  const outcome = readOutcomes(parsed, plan, results, words, shape)[index]
  if (outcome === undefined || outcome.kind === 'left') return { ok: false, failure: 'parse: no answer about the agent' }
  return predictionOf(answersFor(batch.parts[batch.calls.indexOf(index)] as Part, asked.answers), outcome.decision, shape)
}

/**
 * What the mod starts the agent with for a decision: without an answer about
 * the agent, or a model to start it on, it goes out as the main agent asked
 * (no decision). A model ruled out that the answer favours is replaced by the
 * nearest one left: there is always a model, unless none is left.
 */
function predictionOf(answers: Readonly<Record<string, Answer>>, decision: DispatchDecision, shape: DispatchSettings): Decided<SubagentAnswer> {
  if (!decision.answered) return { ok: false, failure: 'parse: no answer about the agent' }
  if (decision.model === null) {
    const { banned } = decision
    const left = (shape.models ?? DEFAULT_AGENT_MODELS).filter((model) => !banned.includes(model))
    if (banned.length > 0 && left.length === 0) return { ok: false, failure: `none: every model offered was ruled out: ${banned.join(', ')}` }
    return { ok: false, failure: 'parse: no model answer' }
  }
  return { ok: true, prediction: { model: decision.model, effort: decision.effort }, detail: detailOf(answers, decision) }
}

/**
 * A prediction scores against an item's acceptable sets, part by part. The
 * model: one of `accept.model`. The effort: one of `accept.effort`, a single
 * set every acceptable model shares (with two acceptable models, either one
 * with any acceptable level counts); haiku runs without an effort (null),
 * acceptable exactly when haiku is, and any other model needs a level. The
 * answer is right when both parts are, exact when it is gold. A miss names
 * each part that missed and which way: `model-under` (cheaper than every
 * acceptable model) or `model-over`; `effort-under` (below every acceptable
 * level, where no effort is below every level) or `effort-over`;
 * `effort-none` (a model that takes an effort, without one).
 */
export function gradeAgent(item: SubagentItem, prediction: SubagentAnswer): Grade {
  const { accept, gold } = item
  const model = accept.model.includes(prediction.model)
  const effort = prediction.model === 'haiku' ? prediction.effort === null && accept.effort.includes(null) : prediction.effort !== null && accept.effort.includes(prediction.effort)
  const misses: string[] = []
  if (!model) misses.push(`model-${side(AGENT_MODELS.indexOf(prediction.model), accept.model.map((m) => AGENT_MODELS.indexOf(m)))}`)
  if (!effort) misses.push(prediction.model !== 'haiku' && prediction.effort === null ? 'effort-none' : `effort-${side(rank(prediction.effort), accept.effort.map(rank))}`)
  return {
    correct: model && effort,
    exact: prediction.model === gold.model && prediction.effort === gold.effort,
    parts: { model, effort },
    ...(misses.length > 0 ? { miss: misses.join(' ') } : {}),
  }
}

/** An effort's place among the levels; no effort (haiku) below every level. */
function rank(effort: Effort | null): number {
  return effort === null ? -1 : EFFORTS.indexOf(effort)
}

/** Where `at` falls against the acceptable places: below every one, above every one, or between them. */
function side(at: number, acceptable: readonly number[]): 'under' | 'over' | 'off' {
  if (acceptable.every((place) => at < place)) return 'under'
  if (acceptable.every((place) => at > place)) return 'over'
  return 'off'
}

/**
 * What a run keeps of a decision: where its model came from (`user`,
 * `decided` or `requested`), the decision model's own pick and its
 * confidence, and the answers as the backend gave them (the model question's
 * probability per option, the effort levels' lowest first, each yes/no
 * question's), from which a decision can be made again under other
 * thresholds without asking again (`redecide`).
 */
function detailOf(answers: Readonly<Record<string, Answer>>, decision: DispatchDecision): Record<string, unknown> {
  const model = answers[MODEL]
  const effort = answers[EFFORT]
  const named = answers[NAMED_EFFORT]
  return {
    source: decision.source,
    pick: decision.pick?.model ?? null,
    confidence: decision.pick === null ? null : Math.round(decision.pick.confidence * 1000) / 1000,
    p_model: model?.type === 'choice' ? model.probabilities : null,
    p_effort: effort === undefined || effort.type === 'noul' ? null : EFFORTS.map((level, i) => effort.probabilities[effort.type === 'score' ? String(i) : level] ?? 0),
    nouls: Object.fromEntries(Object.entries(answers).flatMap(([id, answer]) => (answer.type === 'noul' ? [[id, answer.noul]] : []))),
    // Only when the person's words may name an effort (the question is asked then).
    ...(named?.type === 'choice' ? { p_named_effort: named.probabilities } : {}),
    ...(decision.namedEffort != null ? { named_effort: decision.namedEffort } : {}),
  }
}

/**
 * The subagent suite over `dataset`, the items of the run's dataset: a
 * Workflow item is asked about with the other agent() calls of its workflow
 * (`workflowOf`), as the mod asks about the script.
 */
export function subagentSuite(dataset: readonly SubagentItem[]): Suite<SubagentItem, SubagentAnswer> {
  return { ...SUITE, decide: (item, language, variant, ask, settings) => decideAgent(dataset, item, language, variant, ask, settings) }
}

/** An item decided as the mod decides its agent: a dispatched agent on its own, a Workflow's agent with its script's. */
async function decideAgent(dataset: readonly SubagentItem[], item: SubagentItem, language: Language, variant: string, ask: Ask, settings: Settings): Promise<Decided<SubagentAnswer>> {
  if (item[language].kind === 'workflow') return decideWorkflowAgent(dataset, item, language, variant, ask, settings)
  const { request, part, dispatch, shape } = subagentRequest(item, language, variant, settings)
  const { asked } = await ask(request)
  if (!asked.ok) return { ok: false, failure: `${asked.failure.kind}: ${asked.failure.detail}` }
  const answers = answersFor(part, asked.answers)
  return predictionOf(answers, decideDispatch(answers, dispatch, shape), shape)
}

const SUITE: Omit<Suite<SubagentItem, SubagentAnswer>, 'decide'> = {
  name: 'subagent',
  variants: Object.keys(SUBAGENT_VARIANTS),
  grade: gradeAgent,
  breakdown: (items, rows, variant, settings): SubagentBreakdown => {
    const [zh, en] = [answersIn(rows, 'zh'), answersIn(rows, 'en')]
    return {
      agreement: agreement(items, zh, en),
      kinds: (['agent', 'workflow'] as const).map((kind) => ({ kind, ...wrongIn(items.filter((item) => item.zh.kind === kind), zh, en) })),
      sources: sourcesByPriority(items, zh, en),
      sweeps: sweeps(items, { zh, en }, variantAsk(variant), settings),
    }
  },
  report: (summary) => {
    const own = summary.breakdown as SubagentBreakdown | undefined
    if (own === undefined) return []
    const pct = (rate: number | null) => (rate === null ? '-' : `${(rate * 100).toFixed(1)}%`)
    const pair = (counts: Record<Language, number> | undefined) => `${counts?.zh ?? 0}/${counts?.en ?? 0}`
    const wrong = (entry: { items: number; wrong: Record<Language, number>; parts?: Record<string, Record<Language, number>> }) =>
      `${pair(entry.wrong)} of ${entry.items} (model ${pair(entry.parts?.model)}, effort ${pair(entry.parts?.effort)})`
    const from = (counts: Record<string, number> | undefined) => Object.entries(counts ?? {}).map(([source, n]) => `${source} ${n}`).join(', ') || 'none'
    const lines = [`${summary.variant}: agreement on the model ${pct(own.agreement.model)}, on the effort ${pct(own.agreement.effort)} (${own.agreement.items} items answered in both); wrong zh/en:`]
    for (const priority of PRIORITIES) {
      const tag = summary.tags.find((entry) => entry.tag === priority)
      if (tag !== undefined) lines.push(`  ${priority} ${wrong(tag)}; model from zh: ${from(own.sources[priority]?.zh)}; en: ${from(own.sources[priority]?.en)}`)
    }
    for (const kind of own.kinds) lines.push(`  ${kind.kind} ${wrong(kind)}`)
    for (const [name, swept] of Object.entries(own.sweeps)) {
      lines.push(`  ${name} (* the run's), whole answer right zh/en: ${swept.map((s) => `${s.value}${s.current ? '*' : ''} ${pct(s.zh.joint)}/${pct(s.en.joint)}`).join(', ')}`)
    }
    return lines
  },
  show: (prediction) => (prediction.effort === null ? prediction.model : `${prediction.model} ${prediction.effort}`),
  constants: [{ model: 'haiku', effort: null }, ...(['sonnet', 'opus'] as const).flatMap((model) => EFFORTS.map((effort) => ({ model, effort })))],
  questions: (variant) => dispatchPart(SAMPLE, { ask: variantAsk(variant) }).questions,
  scoring:
    'model: right when in accept.model. effort: right when in accept.effort, one set of levels shared by every acceptable model, so with two acceptable models either model with any acceptable level counts (e.g. subagent-089 opus/low); haiku runs without an effort (null), right exactly when haiku is acceptable; any other model needs a level. Whole answer (accuracy): both right; exact: the gold model and effort. No decision (a failed request, no answer about the agent, no model left once the models the person ruled out are taken away) is wrong.',
}

type Answered = ReadonlyMap<string, Row<SubagentAnswer>>

/** One language's answers of a variant, by item id. */
function answersIn(rows: readonly Row<SubagentAnswer>[], language: Language): Answered {
  return new Map(rows.filter((row) => row.language === language).map((row) => [row.id, row]))
}

/** Of the items answered in both languages, the share given the same model, and the same effort. */
function agreement(items: readonly SubagentItem[], zh: Answered, en: Answered): { items: number; model: number | null; effort: number | null } {
  let both = 0
  let model = 0
  let effort = 0
  for (const item of items) {
    const [a, b] = [zh.get(item.id)?.prediction, en.get(item.id)?.prediction]
    if (!a || !b) continue
    both++
    if (a.model === b.model) model++
    if (a.effort === b.effort) effort++
  }
  return { items: both, model: both === 0 ? null : rate(model, both), effort: both === 0 ? null : rate(effort, both) }
}

/** Wrong answers among `items` in each language, whole and by part (as metrics.ts counts them by tag); an unanswered item is wrong in every part. */
function wrongIn(items: readonly SubagentItem[], zh: Answered, en: Answered): Wrong {
  const count = (wrong: (row: Row<SubagentAnswer>) => boolean) => ({
    zh: items.filter((item) => isWrong(zh.get(item.id), wrong)).length,
    en: items.filter((item) => isWrong(en.get(item.id), wrong)).length,
  })
  return {
    items: items.length,
    wrong: count((row) => !row.correct),
    parts: { model: count((row) => row.parts?.model !== true), effort: count((row) => row.parts?.effort !== true) },
  }
}

function isWrong(row: Row<SubagentAnswer> | undefined, wrong: (row: Row<SubagentAnswer>) => boolean): boolean {
  return row !== undefined && wrong(row)
}

/** Where each answer's model came from (`user`, `decided`, `requested`; `failed` without an answer), in each priority case and language. */
function sourcesByPriority(items: readonly SubagentItem[], zh: Answered, en: Answered): Record<string, Record<Language, Record<string, number>>> {
  const sources: Record<string, Record<Language, Record<string, number>>> = {}
  for (const item of items) {
    const priority = item.tags.find((tag) => tag.startsWith('priority:'))
    if (priority === undefined) continue
    const counts = (sources[priority] ??= { zh: {}, en: {} })
    for (const [language, answered] of [['zh', zh], ['en', en]] as const) {
      const row = answered.get(item.id)
      if (row === undefined) continue
      const source = row.ok ? String(row.detail?.source) : 'failed'
      counts[language][source] = (counts[language][source] ?? 0) + 1
    }
  }
  return sources
}

/**
 * The thresholds that read the answers, and the values each is swept over
 * (the run's own value is added when it is not among them): how sure the
 * decision model must be to replace the main agent's pick (agentOverride);
 * how sure a yes must be for a model to count as named or ruled out by the
 * person; under what requested_fits the main agent's pick may go (the noul
 * variants only); what probability max needs.
 */
const SWEPT = {
  thetaOverride: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1],
  thetaNamed: [0.3, 0.5, 0.7, 0.9],
  thetaFit: [0.3, 0.5, 0.7],
  thetaMax: [0.3, 0.5, 0.7, 0.9],
} as const

type Threshold = keyof typeof SWEPT
type Rates = { model: number; effort: number; joint: number }
type Swept = { value: number; current?: true; zh: Rates; en: Rates }
type Wrong = { items: number; wrong: Record<Language, number>; parts: { model: Record<Language, number>; effort: Record<Language, number> } }

/** The suite's own figures for one variant (Suite.breakdown). */
export type SubagentBreakdown = {
  /** Of the items answered in both languages, the share given the same model, and the same effort. */
  agreement: { items: number; model: number | null; effort: number | null }
  /** Wrong answers among the dispatched agents and among the workflows' agents. */
  kinds: ({ kind: 'agent' | 'workflow' } & Wrong)[]
  /** Where each answer's model came from, by priority case and language. */
  sources: Record<string, Record<Language, Record<string, number>>>
  /** Each threshold swept over the answers the run got. */
  sweeps: Partial<Record<Threshold, Swept[]>>
}

/**
 * Each threshold swept over its values, the others as the run had them: the
 * decision made again from every answer the run got (`redecide`), nothing
 * asked again, and graded. An unanswered item stays wrong.
 */
function sweeps(items: readonly SubagentItem[], answered: Record<Language, Answered>, ask: DispatchAsk, settings: Settings): Partial<Record<Threshold, Swept[]>> {
  const run: Required<Pick<DispatchSettings, Threshold>> & DispatchSettings = { ...agentSettings(settings, ask), thetaNamed: 0.5, thetaFit: 0.5 }
  const out: Partial<Record<Threshold, Swept[]>> = {}
  for (const name of Object.keys(SWEPT) as Threshold[]) {
    if (name === 'thetaFit' && ask.requested !== 'noul') continue
    const current = run[name]
    out[name] = [...new Set([...SWEPT[name], current])]
      .sort((a, b) => a - b)
      .map((value) => {
        const shape = { ...run, [name]: value }
        const rates = (language: Language): Rates => {
          const grades = items.map((item) => {
            const row = answered[language].get(item.id)
            const prediction = row?.ok && row.detail ? redecide(item, language, row.detail, shape) : null
            return prediction === null ? null : gradeAgent(item, prediction)
          })
          const share = (right: (grade: Grade) => boolean) => rate(grades.filter((grade) => grade !== null && right(grade)).length, items.length)
          return { model: share((grade) => grade.parts?.model === true), effort: share((grade) => grade.parts?.effort === true), joint: share((grade) => grade.correct) }
        }
        return { value, ...(value === current ? { current: true as const } : {}), zh: rates('zh'), en: rates('en') }
      })
  }
  return out
}

/**
 * The decision made again from what a run kept of an answer (detailOf),
 * under `shape`, as the mod would have made it: null when there would be no
 * model to start the agent on.
 */
export function redecide(item: SubagentItem, language: Language, detail: Readonly<Record<string, unknown>>, shape: DispatchSettings): SubagentAnswer | null {
  const answers: Record<string, Answer> = {}
  const { p_model: model, p_effort: effort, nouls, p_named_effort: namedEffort } = detail
  if (isRecord(namedEffort)) answers[NAMED_EFFORT] = { type: 'choice', choice: '', probabilities: namedEffort as Record<string, number>, confidence: null }
  if (isRecord(model)) answers[MODEL] = { type: 'choice', choice: '', probabilities: model as Record<string, number>, confidence: null }
  if (Array.isArray(effort)) answers[EFFORT] = { type: 'score', score: Number.NaN, probabilities: Object.fromEntries(effort.map((p, i) => [String(i), Number(p)])), confidence: null }
  if (isRecord(nouls)) for (const [id, p] of Object.entries(nouls)) answers[id] = { type: 'noul', noul: Number(p) }
  const decision = decideDispatch(answers, item[language], shape)
  return decision.answered && decision.model !== null ? { model: decision.model, effort: decision.effort } : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rate(count: number, of: number): number {
  return of === 0 ? 0 : Math.round((count / of) * 10_000) / 10_000
}

/** A dispatch that brings out every kind of question a variant asks: a main agent's pick, a model the person mentions. */
const SAMPLE: Dispatch = {
  user_message: 'Use opus for this, at high effort.',
  agent_type: 'general-purpose',
  description: 'Example',
  prompt: 'Example',
  requested_model: 'opus',
}
