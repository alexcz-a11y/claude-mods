// The effort-midturn suite: the main agent's effort, decided again while a
// turn runs (#5's feature, the mid-turn re-decision). An item is a snippet of
// a turn: the person's message, the step about to go out, the level it goes
// at, the turn's counts and its latest steps. The request is built by the
// decision module the mod uses (hooks/decision/midturn.ts), so the eval
// measures the prompt the mod sends mid-turn (spec #67).
//
// Graded: the level the answer picks (pickEffort: the most likely, max only
// past thetaMax), the judgment the dataset labels (its gold is the level the
// work up to the next re-decision needs). Beside it each answer records the
// level the mod would then go on at (judgeMidturn: a raise needs thetaUp, a
// drop thetaDown and goes one level at a time), with each level's
// probability and the confidence, to calibrate those thresholds (#17). A row
// does not say when the turn last went up, so the mod's hold after a raise
// (holdSteps) is never in play here; nor is a forced raise's floor: whether
// failures force one is the decision model's call under #7.
//
// Pure: no Node API.

import { numberIn } from '../../hooks/core/setup.ts'
import { DEFAULT_ASK, EFFORTS, isEffort, readEffort, type Effort, type EffortAsk } from '../../hooks/decision/effort.ts'
import {
  judgeMidturn,
  midturnEffortPart,
  midturnState,
  MIDTURN_LEVEL,
  type MidturnInput,
  type MidturnLimits,
  type MidturnRules,
  type MidturnShow,
} from '../../hooks/decision/midturn.ts'
import { answersFor, mergeParts, type DecisionRequest, type Part } from '../../hooks/decision/system-one.ts'
import type { EffortMidturnItem, Language } from './datasets.ts'
import { gradeEffort } from './effort-submit.ts'
import type { Row } from './runner.ts'
import type { Settings, Suite } from './suite.ts'

/**
 * One way of asking (an eval variable): how the question is written, what
 * the state shows (the guide's §4.1 worries the current level anchors the
 * answer), and whether a turn that is stuck carries a `trouble`, as #7 has
 * the mod do.
 */
type MidturnVariant = { ask: EffortAsk; show: MidturnShow; trouble: boolean }

/** The variants by name; the first is how the mod asks today. */
export const MIDTURN_VARIANTS: Readonly<Record<string, MidturnVariant>> = {
  'en-score': { ask: DEFAULT_ASK, show: {}, trouble: false },
  'zh-score': { ask: { language: 'zh', primitive: 'score' }, show: {}, trouble: false },
  'no-current-effort': { ask: DEFAULT_ASK, show: { currentEffort: false }, trouble: false },
  'no-counts': { ask: DEFAULT_ASK, show: { counts: false }, trouble: false },
  trouble: { ask: DEFAULT_ASK, show: {}, trouble: true },
}

function variantOf(variant: string): MidturnVariant {
  const how = MIDTURN_VARIANTS[variant]
  if (how === undefined) throw new RangeError(`no variant "${variant}" (${Object.keys(MIDTURN_VARIANTS).join(', ')})`)
  return how
}

/** Failed calls at which #7 demands a re-decision with a trouble: its default threshold (spec: M, 2). */
export const TROUBLE_FAILURES = 2

/**
 * The trouble a stuck turn's re-decision carries: one English sentence, as
 * #7 writes it into its demand (README, 中途重判). Until #7 lands this
 * stands in for its words; once it does, take them from #7 so the eval asks
 * what the mod asks. Not "in a row": the count runs since the last forced
 * raise, with other calls between the failures.
 */
export function troubleOf(failures: number): string {
  return `${failures} tool calls have failed while working on this request`
}

/**
 * What the re-decision reads, from the mod's settings as the feature reads
 * them (features/midturn-effort.ts, with the same bounds and defaults): the
 * latest `rejudgeSteps` steps, within `contextTokens`.
 */
export function midturnLimits(settings: Settings): MidturnLimits {
  return { steps: Math.round(numberIn(settings.options.rejudgeSteps, 1, 16, 4)), tokens: settings.context.tokens }
}

/** How an answer moves the level, from the mod's settings as the feature reads them (the same bounds and defaults). */
export function midturnRules(settings: Settings): MidturnRules {
  const { options } = settings
  return {
    thetaUp: numberIn(options.thetaUp, 0, 1, 0.4),
    thetaDown: numberIn(options.thetaDown, 0, 1, 0.6),
    thetaMax: settings.thetaMax,
    holdSteps: Math.round(numberIn(options.holdSteps, 0, 50, 3)),
  }
}

const DIRECTIONS = ['up', 'down', 'keep'] as const
type Direction = (typeof DIRECTIONS)[number]

/** Which way an item's level should move: its gold against the level the turn goes at now. */
export function directionOf(item: EffortMidturnItem): Direction {
  const [gold, current] = [EFFORTS.indexOf(item.gold), EFFORTS.indexOf(item.zh.current_effort)]
  return gold > current ? 'up' : gold < current ? 'down' : 'keep'
}

/**
 * The suite's own figures for one variant (Suite.breakdown): the accuracy of
 * the items that should go up, down or keep their level, and of the level
 * the mod would send (`sent`), in each language (an unanswered item is wrong).
 */
type MidturnBreakdown = {
  directions: { direction: Direction; items: number; accuracy: Record<Language, number> }[]
  sent: Record<Language, number>
}

function rate(count: number, of: number): number {
  return of === 0 ? 0 : Math.round((count / of) * 10_000) / 10_000
}

export const effortMidturn: Suite<EffortMidturnItem, Effort> = {
  name: 'effort-midturn',
  variants: Object.keys(MIDTURN_VARIANTS),
  async decide(item, language, variant, ask, settings) {
    const { request, part } = midturnRequest(item, language, variant, settings)
    const { asked } = await ask(request)
    if (!asked.ok) return { ok: false, failure: `${asked.failure.kind}: ${asked.failure.detail}` }
    const reading = readEffort(answersFor(part, asked.answers)[MIDTURN_LEVEL])
    if (reading === null) return { ok: false, failure: 'parse: no effort answer' }
    const verdict = judgeMidturn(reading, { current: item[language].current_effort, sinceRaise: null }, midturnRules(settings))
    return {
      ok: true,
      prediction: verdict.picked,
      detail: { p: reading.probabilities.map((p) => Math.round(p * 1000) / 1000), confidence: reading.confidence, sent: verdict.effort, why: verdict.why },
    }
  },
  grade: gradeEffort,
  show: (effort) => effort,
  constants: EFFORTS,
  // Never moving the level: the answer a re-decision is worth nothing against.
  baselines: { current: (item) => item.zh.current_effort },
  questions: (variant) => {
    const how = variantOf(variant)
    return midturnEffortPart(how.ask, { trouble: how.trouble }).questions
  },
  breakdown: (items, rows): MidturnBreakdown => {
    const answers = (language: Language) => new Map(rows.filter((row) => row.language === language).map((row) => [row.id, row]))
    const [zh, en] = [answers('zh'), answers('en')]
    const share = (members: readonly EffortMidturnItem[], right: (item: EffortMidturnItem, row: Row<Effort> | undefined) => boolean) => ({
      zh: rate(members.filter((item) => right(item, zh.get(item.id))).length, members.length),
      en: rate(members.filter((item) => right(item, en.get(item.id))).length, members.length),
    })
    return {
      directions: DIRECTIONS.map((direction) => {
        const members = items.filter((item) => directionOf(item) === direction)
        return { direction, items: members.length, accuracy: share(members, (_item, row) => row?.correct === true) }
      }),
      sent: share(items, (item, row) => {
        const sent = row?.detail?.sent
        return isEffort(sent) && item.accept.includes(sent)
      }),
    }
  },
  report: (summary) => {
    const breakdown = summary.breakdown as MidturnBreakdown | undefined
    if (breakdown === undefined) return []
    const pct = (value: number) => `${(value * 100).toFixed(1)}%`
    const directions = breakdown.directions.map((d) => `${d.direction} ${pct(d.accuracy.zh)}/${pct(d.accuracy.en)} of ${d.items}`).join(', ')
    return [
      `${summary.variant}: right by the way the level should move (zh/en of n): ${directions}`,
      `${summary.variant}: the level the mod would go on at (sent) right: zh ${pct(breakdown.sent.zh)}, en ${pct(breakdown.sent.en)}`,
    ]
  },
  scoring:
    'Right when the level the answer picks (the most likely; max only at thetaMax or above) is in accept: the dataset labels the level the work up to the next re-decision needs. ' +
    'Each answer also records `sent`, the level the mod would then go on at (judgeMidturn: a raise needs thetaUp, a drop needs thetaDown and goes one level at a time), and why; ' +
    'holdSteps never applies (an item does not say when the level last went up), nor does a forced raise. ' +
    '`current` scores keeping the current level; `breakdown.directions` groups items by gold against the current level; `breakdown.sent` scores `sent` against accept.',
}

/**
 * The request the mod sends mid-turn for the item's turn in `language`,
 * asked as `variant` says. A trouble goes only where #7 would demand a
 * re-decision (TROUBLE_FAILURES failed calls); elsewhere the trouble variant
 * asks as the mod does every N steps.
 */
export function midturnRequest(item: EffortMidturnItem, language: Language, variant: string, settings: Settings): { request: DecisionRequest; part: Part } {
  const how = variantOf(variant)
  const asked = item[language]
  const stuck = how.trouble && asked.counts.failures >= TROUBLE_FAILURES
  const input: MidturnInput = stuck ? { ...asked, trouble: troubleOf(asked.counts.failures) } : asked
  const part = midturnEffortPart(how.ask, { trouble: stuck })
  return { request: mergeParts(midturnState(input, midturnLimits(settings), how.show), [part]), part }
}
