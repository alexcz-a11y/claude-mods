// Stored answers decided again under the rules of the AA routing (README, 「它做什么」; DEVELOPMENT.md,
// 「按 AA 基准校正」), each against the rule before it (0.2.1), without asking again: the effort a
// level-probability answer picks (the level above the most likely one taken at 0.3 or more), the level a
// mid-turn answer sends (the gates the mod ships, 0.3 up and since 0.2.3 0.55 down, against 0.4 and 0.6;
// `scanThetaDown` runs the lowering gate over a list of values), and a dispatched agent's
// effort lifted to its model's floor. Nothing here asks a decision model: every figure comes from the
// probabilities a result file kept (`p`, `p_effort` ...), graded against the dataset as the suites grade.
//
// What it cannot say: the model options of a dispatched agent were reworded, so stored answers about the
// model are no longer what the mod would be given; the model part is taken as it was stored, and only the
// effort part is decided again. Rerun the subagent suite (eval/run.ts) for the effect of the new wording.
//
// Pure: no Node API; eval/rescore.ts reads the files.

import { dispatchSettings, readConfig } from '../../hooks/core/setup.ts'
import { DEFAULT_ASK, EFFORTS, pickEffort, type Effort, type EffortReading } from '../../hooks/decision/effort.ts'
import { decideDispatch, type DispatchDecision } from '../../hooks/decision/dispatched-agent.ts'
import { judgeMidturn, type MidturnRules } from '../../hooks/decision/midturn.ts'
import { isRecord, type AgentItem, type EffortMidturnItem, type EffortSubmitItem, type Language } from './datasets.ts'
import { gradeEffort } from './effort-submit.ts'
import { answersOf, AGENT_VARIANTS, gradeAgent } from './subagent.ts'
import { rate } from './metrics.ts'

/** What a result file holds that is read here; the rest is kept as it is. */
export type StoredAnswers = {
  settings: { thetaMax: number; options?: Readonly<Record<string, unknown>> }
  summary: { variants: readonly { variant: string }[] }
  answers: readonly Readonly<Record<string, unknown>>[]
}

/**
 * The figures of one rule over the answers that were decided (`n`): the share in `accept` (`accuracy`), the share
 * exactly `gold`, and the share too high (`over`) and too low (`under`) against the acceptable levels. For an agent
 * `accuracy` is the model and the effort both right, `gold` both exactly, `over` and `under` the effort part's
 * misses, and `effort` the effort part right.
 */
export type Tally = { n: number; accuracy: number; gold: number; over: number; under: number; effort?: number }

/** A variant (and what is decided: `picked` the level of the answer, `sent` the level the mod goes on at) under the rule before and under the rule now. */
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

/** The mid-turn gates as they were before the AA routing. */
export const LEGACY_RULES: Omit<MidturnRules, 'thetaMax'> = { thetaUp: 0.4, thetaDown: 0.6, holdSteps: 3 }

/**
 * What the mod went on at after a mid-turn answer, by the rule before: the
 * answer's level (`legacyPickEffort`) when higher and sure enough, one level
 * down when lower and surer still, else the level it was at. (`judgeMidturn`
 * is the rule now; a re-decision here never has a raise to hold.)
 */
function legacySent(reading: EffortReading, current: Effort, thetaMax: number): Effort {
  const picked = legacyPickEffort(reading, thetaMax)
  const at = (level: Effort) => EFFORTS.indexOf(level)
  const confidence = reading.confidence ?? Math.max(...reading.probabilities)
  if (at(picked) > at(current)) return confidence >= LEGACY_RULES.thetaUp ? picked : current
  if (at(picked) < at(current)) return confidence >= Math.max(LEGACY_RULES.thetaDown, LEGACY_RULES.thetaUp) ? (EFFORTS[at(current) - 1] as Effort) : current
  return current
}

/** The answers one variant holds, with the item each is about: those that were decided (they kept their level probabilities). */
function rowsOf<I extends { id: string }>(result: StoredAnswers, items: readonly I[], variant: string, field: string): { item: I; language: Language; detail: Readonly<Record<string, unknown>> }[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  return result.answers.flatMap((line) => {
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

/** The effort-submit variants of a result: the level picked from each stored answer, before and now. */
export function rescoreSubmit(result: StoredAnswers, items: readonly EffortSubmitItem[]): Compared[] {
  const { thetaMax } = result.settings
  return result.summary.variants.map(({ variant }) => {
    const rows = rowsOf(result, items, variant, 'p')
    return {
      variant,
      what: 'picked',
      before: tally(rows.map(({ item, detail }) => ({ item, effort: legacyPickEffort(readingOf(detail), thetaMax) }))),
      now: tally(rows.map(({ item, detail }) => ({ item, effort: pickEffort(readingOf(detail), thetaMax) }))),
    }
  })
}

/**
 * The effort-midturn variants of a result: the level each stored answer picks and the level the mod would go on
 * at, before (the pick and gates of 0.2.1) and now (the current pick and `rules`, by default the gates the mod ships).
 */
export function rescoreMidturn(result: StoredAnswers, items: readonly EffortMidturnItem[], rules: MidturnRules = readConfig({}).midturn.rules): Compared[] {
  const { thetaMax } = result.settings
  return result.summary.variants.flatMap(({ variant }) => {
    const rows = rowsOf(result, items, variant, 'p').map(({ item, language, detail }) => ({ item, reading: readingOf(detail), current: item[language].current_effort }))
    return [
      {
        variant,
        what: 'picked',
        before: tally(rows.map(({ item, reading }) => ({ item, effort: legacyPickEffort(reading, thetaMax) }))),
        now: tally(rows.map(({ item, reading }) => ({ item, effort: pickEffort(reading, thetaMax) }))),
      },
      {
        variant,
        what: 'sent',
        before: tally(rows.map(({ item, reading, current }) => ({ item, effort: legacySent(reading, current, thetaMax) }))),
        now: tally(rows.map(({ item, reading, current }) => ({ item, effort: judgeMidturn(reading, { current, sinceRaise: null }, { ...rules, thetaMax }).effort }))),
      },
    ]
  })
}

/** The level a mid-turn variant sends at one `thetaDown`, over the answers of one language (`both`: all of them). */
export type ThetaDownRow = { variant: string; language: Language | 'both'; thetaDown: number; sent: Tally }

/**
 * A scan of the lowering gate over the stored answers of an effort-midturn result: for each variant, each language
 * and both together, each of `thetas`, the level the mod goes on at (`judgeMidturn`, `rules` otherwise as the mod
 * ships them, `thetaMax` as the run had it) graded as `sent`. Only `thetaDown` differs from row to row; nothing is
 * asked again.
 */
export function scanThetaDown(result: StoredAnswers, items: readonly EffortMidturnItem[], thetas: readonly number[], rules: MidturnRules = readConfig({}).midturn.rules): ThetaDownRow[] {
  const { thetaMax } = result.settings
  return result.summary.variants.flatMap(({ variant }) => {
    const rows = rowsOf(result, items, variant, 'p').map(({ item, language, detail }) => ({ item, language, reading: readingOf(detail), current: item[language].current_effort }))
    return thetas.flatMap((thetaDown) =>
      (['both', 'zh', 'en'] as const).map((language) => ({
        variant,
        language,
        thetaDown,
        sent: tally(
          rows
            .filter((row) => language === 'both' || row.language === language)
            .map(({ item, reading, current }) => ({ item, effort: judgeMidturn(reading, { current, sinceRaise: null }, { ...rules, thetaDown, thetaMax }).effort })),
        ),
      })),
    )
  })
}

/**
 * The dispatched-agent variants of a result: each stored answer decided again from its probabilities (`answersOf`),
 * the model as the mod decides it from them, the effort under the rule before (the level picked as before, the person's
 * named effort kept, none on haiku) and under the rule now (`decideDispatch`: the pick, the level above, the floor).
 */
export function rescoreAgents(result: StoredAnswers, items: readonly AgentItem[]): Compared[] {
  const config = readConfig({ ...(result.settings.options ?? {}), thetaMax: result.settings.thetaMax } as Parameters<typeof readConfig>[0])
  return result.summary.variants.flatMap(({ variant }) => {
    const variantAsk = AGENT_VARIANTS[variant]?.ask
    if (variantAsk === undefined) return []
    const shape = dispatchSettings({ config, ask: DEFAULT_ASK }, variantAsk)
    const decided = rowsOf(result, items, variant, 'p_effort').flatMap(({ item, language, detail }) => {
      const answers = answersOf(detail)
      const decision = decideDispatch(answers, item[language], shape)
      return decision.answered && decision.model !== null && decision.reading !== null ? [{ item, decision, thetaMax: shape.thetaMax }] : []
    })
    const prediction = (kind: 'before' | 'now') =>
      decided.map(({ item, decision, thetaMax }) => ({ item, prediction: { model: decision.model as AgentItem['gold']['model'], effort: effortUnder(kind, decision, thetaMax) } }))
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

/** The effort a decision gives an agent under the rule before (`before`) or now: haiku none, the person's named effort theirs. */
function effortUnder(kind: 'before' | 'now', decision: DispatchDecision, thetaMax: number): Effort | null {
  if (kind === 'now' || decision.reading === null) return decision.effort
  if (decision.model === 'haiku') return null
  return decision.namedEffort ?? legacyPickEffort(decision.reading, thetaMax)
}
