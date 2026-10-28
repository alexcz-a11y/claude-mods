// Stored answers decided again under the effort question's base rule of 0.9.0 (ADR 0014: the position rounded, one up when
// two-peaked; a dispatched agent's lifted to its model's floor), each against the rule the run itself had (the most likely
// level, the max gate at the file's `thetaMax`, the level above at its `roundUp`), without asking again. A stored answer
// has the effort question's probabilities only, not the Nouls the floors read, so this measures the base rule alone.
// Nothing here asks a decision model: every figure comes from the probabilities a result file kept (`p`, `p_effort` ...),
// graded against the dataset as the suites grade.
//
// What it cannot say: a dispatched agent's model is chosen by the model table on yes/no questions a run before 0.9.0
// never asked (ADR 0015), so the model part is taken as the run stored it (its answer), and only the effort part is
// decided again: the base rule and the model's floor, the floors' Nouls not being stored. Rerun the subagent suite
// (eval/run.ts) for the effect of the table.
//
// Pure: no Node API; eval/rescore.ts reads the files.

import { baseEffort, EFFORTS, isEffort, traceEffort, type Effort, type EffortReading } from '../../hooks/decision/effort.ts'
import { AGENT_MODELS, effortFloor, type AgentModel } from '../../hooks/decision/dispatched-agent.ts'
import { isRecord, type AgentItem, type EffortSubmitItem, type Language } from './datasets.ts'
import { gradeEffort } from './effort-submit.ts'
import { gradeAgent } from './subagent.ts'
import { rate } from './metrics.ts'

/** What a result file holds that is read here; the rest is kept as it is. A file written from 0.9.0 on records no `thetaMax`. */
export type StoredAnswers = {
  settings: { thetaMax?: number; roundUp?: number; options?: Readonly<Record<string, unknown>> }
  summary: { variants: readonly { variant: string }[] }
  answers: readonly Readonly<Record<string, unknown>>[]
}

/** The threshold for taking the level above in a result file that does not record one: the constant it was before it became a decision model's setting (#49). */
const ROUND_UP_BEFORE_THE_TABLE = 0.3

/** The thresholds of the rule a run had before 0.9.0 (`thetaMax`, and `roundUp` when the file records it). */
export type RecordedRules = { thetaMax: number; roundUp: number }

/** The recorded rule's thresholds as the run had them; null for a run of 0.9.0 or later, which decided by the base rule. */
function rulesOf(result: StoredAnswers): RecordedRules | null {
  const { thetaMax, roundUp } = result.settings
  return thetaMax === undefined ? null : { thetaMax, roundUp: roundUp ?? ROUND_UP_BEFORE_THE_TABLE }
}

/**
 * The rule before 0.9.0, as a run recorded it: the most probable level (a tie to the higher), `max` only at `thetaMax`, then
 * the level above when it has `roundUp` (max again only at `thetaMax`). Kept to measure the base rule against; a run that
 * recorded none (`null`) had the base rule.
 */
export function recordedPickEffort(reading: EffortReading, rules: RecordedRules | null): Effort {
  if (rules === null) return baseEffort(reading)
  const p = reading.probabilities
  const at = (i: number) => p[i] ?? 0
  const last = EFFORTS.length - 1
  let level = EFFORTS.indexOf(legacyPickEffort(reading, rules.thetaMax))
  const above = level + 1
  if (above <= last && at(above) >= rules.roundUp && (above < last || at(above) >= rules.thetaMax)) level = above
  return EFFORTS[level] as Effort
}

/**
 * The figures of one rule over the answers that were decided (`n`): the share in `accept` (`accuracy`), the share
 * exactly `gold`, and the share too high (`over`) and too low (`under`) against the acceptable levels. For an agent
 * `accuracy` is the model and the effort both right, `gold` both exactly, `over` and `under` the effort part's
 * misses, and `effort` the effort part right.
 */
export type Tally = { n: number; accuracy: number; gold: number; over: number; under: number; effort?: number }

/** A variant (and what is decided: `picked` the level of the answer, `agent` an agent's model and effort) under the run's recorded rule (`before`) and the base rule now. */
export type Compared = { variant: string; what: string; before: Tally; now: Tally }

/**
 * The rule before the AA routing: the most probable level, a tie going to
 * the higher; `max` only when its own probability reaches `thetaMax`, else the
 * most probable of the others. Kept to measure the change against.
 */
export function legacyPickEffort(reading: EffortReading, thetaMax: number): Effort {
  const p = reading.probabilities
  const top = (count: number): number => {
    let best = 0
    for (let i = 1; i < count; i++) if ((p[i] ?? 0) >= (p[best] ?? 0)) best = i
    return best
  }
  let level = top(EFFORTS.length)
  if (level === EFFORTS.length - 1 && (p[level] ?? 0) < thetaMax) level = top(EFFORTS.length - 1)
  return EFFORTS[level] as Effort
}

/**
 * The answers one variant holds, with the item each is about: those that were decided (they kept their level probabilities).
 * A run that asked more than once has a line for each time (`repeat`); the first time's are read, as its `summary` is.
 */
function rowsOf<I extends { id: string }>(result: StoredAnswers, items: readonly I[], variant: string, field: string): { item: I; language: Language; detail: Readonly<Record<string, unknown>> }[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  return result.answers.flatMap((line) => {
    if (line.repeat !== undefined && line.repeat !== 1) return []
    const detail = line[variant]
    const item = byId.get(String(line.id))
    const language = line.language === 'zh' || line.language === 'en' ? line.language : null
    return item !== undefined && language !== null && isRecord(detail) && Array.isArray(detail[field]) ? [{ item, language, detail }] : []
  })
}

/** The reading a stored answer's `p` makes: the probabilities and the backend's confidence. */
function readingOf(detail: Readonly<Record<string, unknown>>, field = 'p'): EffortReading {
  const confidence = detail.confidence
  return { probabilities: (detail[field] as unknown[]).map(Number), confidence: typeof confidence === 'number' ? confidence : null }
}

/** The figures of a set of levels against the items they are about. */
function tally(graded: readonly { item: { gold: Effort; accept: readonly Effort[] }; effort: Effort }[]): Tally {
  const grades = graded.map(({ item, effort }) => gradeEffort(item, effort))
  const share = (count: number) => rate(count, grades.length)
  return {
    n: grades.length,
    accuracy: share(grades.filter((g) => g.correct).length),
    gold: share(grades.filter((g) => g.exact).length),
    over: share(grades.filter((g) => g.miss === 'over').length),
    under: share(grades.filter((g) => g.miss === 'under').length),
  }
}

/** The effort-submit variants of a result: the level picked from each stored answer, under the recorded rule and the base rule. */
export function rescoreSubmit(result: StoredAnswers, items: readonly EffortSubmitItem[]): Compared[] {
  const rules = rulesOf(result)
  return result.summary.variants.map(({ variant }) => {
    const rows = rowsOf(result, items, variant, 'p')
    return {
      variant,
      what: 'picked',
      before: tally(rows.map(({ item, detail }) => ({ item, effort: recordedPickEffort(readingOf(detail), rules) }))),
      now: tally(rows.map(({ item, detail }) => ({ item, effort: baseEffort(readingOf(detail)) }))),
    }
  })
}

/** A stored answer about an agent: the model the run gave it (its answer's first word), its effort reading, the effort the person named. */
type StoredAgent = { model: AgentModel; reading: EffortReading; named: Effort | null }

function storedAgent(detail: Readonly<Record<string, unknown>>): StoredAgent | null {
  const model = typeof detail.answer === 'string' ? detail.answer.split(' ')[0] : undefined
  if (!(AGENT_MODELS as readonly unknown[]).includes(model)) return null
  return { model: model as AgentModel, reading: readingOf(detail, 'p_effort'), named: isEffort(detail.named_effort) ? detail.named_effort : null }
}

/**
 * The dispatched-agent variants of a result: each stored answer's model as the run gave it, its effort under the recorded
 * rule (the person's named effort kept) and under the rule now (the base rule and the model's floor).
 */
export function rescoreAgents(result: StoredAnswers, items: readonly AgentItem[]): Compared[] {
  const run = rulesOf(result)
  return result.summary.variants.flatMap(({ variant }) => {
    const decided = rowsOf(result, items, variant, 'p_effort').flatMap(({ item, detail }) => {
      const agent = storedAgent(detail)
      return agent === null ? [] : [{ item, agent }]
    })
    if (decided.length === 0) return []
    const prediction = (kind: 'before' | 'now') => decided.map(({ item, agent }) => ({ item, prediction: { model: agent.model, effort: effortUnder(kind, agent, run) } }))
    const tallyAgents = (kind: 'before' | 'now'): Tally => {
      const grades = prediction(kind).map(({ item, prediction }) => gradeAgent(item, prediction))
      const share = (count: number) => rate(count, grades.length)
      return {
        n: grades.length,
        accuracy: share(grades.filter((g) => g.correct).length),
        gold: share(grades.filter((g) => g.exact).length),
        over: share(grades.filter((g) => g.miss?.includes('effort-over')).length),
        under: share(grades.filter((g) => g.miss?.includes('effort-under')).length),
        effort: share(grades.filter((g) => g.parts?.effort === true).length),
      }
    }
    return [{ variant, what: 'agent', before: tallyAgents('before'), now: tallyAgents('now') }]
  })
}

/**
 * The effort a stored answer gives its agent under the recorded rule (`before`) or the base rule now with the model's floor:
 * the person's named effort theirs; none on haiku, as the datasets grade it (subagent.ts `gradedEffort`).
 */
function effortUnder(kind: 'before' | 'now', agent: StoredAgent, rules: RecordedRules | null): Effort | null {
  if (agent.model === 'haiku') return null
  if (agent.named !== null) return agent.named
  return kind === 'now' ? traceEffort(agent.reading, { model: { name: agent.model, floor: effortFloor(agent.model) } }).effort : recordedPickEffort(agent.reading, rules)
}

/** One stored answer graded again: its item, language and variant, and whether it is right under the rule given. */
export type Regraded = { id: string; language: Language; variant: string; correct: boolean }

/**
 * Every decided answer of an effort-submit or subagent result graded again: under `rules` when given (the recorded rule
 * with those thresholds), else under the base rule now: the level picked (effort-submit: what its summaries grade), the
 * model and the effort (subagent, as `rescoreAgents` decides them now). An answer that was not decided (a failed request)
 * is not here: the paired test (lib/paired.ts) counts it wrong. Nothing is asked again.
 */
export function regrade(suite: string, result: StoredAnswers, items: readonly { id: string }[], rules?: RecordedRules): Regraded[] {
  const pick = (reading: EffortReading) => (rules === undefined ? baseEffort(reading) : recordedPickEffort(reading, rules))
  if (suite === 'effort-submit') {
    return result.summary.variants.flatMap(({ variant }) =>
      rowsOf(result, items as readonly EffortSubmitItem[], variant, 'p').map(({ item, language, detail }) => ({
        id: item.id,
        language,
        variant,
        correct: gradeEffort(item, pick(readingOf(detail))).correct,
      })),
    )
  }
  if (suite === 'subagent') {
    return result.summary.variants.flatMap(({ variant }) =>
      rowsOf(result, items as readonly AgentItem[], variant, 'p_effort').map(({ item, language, detail }) => {
        const agent = storedAgent(detail)
        const effort = agent === null ? null : effortUnder(rules === undefined ? 'now' : 'before', agent, rules ?? null)
        return { id: item.id, language, variant, correct: agent !== null && gradeAgent(item, { model: agent.model, effort }).correct }
      }),
    )
  }
  throw new RangeError(`no regrading for the ${suite} suite (effort-submit, subagent)`)
}
