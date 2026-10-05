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
// failures force one is the decision model's call under #7. Under the
// trouble variant a stuck item is asked what #7 asks (`stuckRequest`), and the
// answer to whether its failures were expected is recorded beside it.
//
// Pure: no Node API.

import { DEFAULT_ASK, EFFORTS, isEffort, readEffort, type Effort, type EffortAsk } from '../../hooks/decision/effort.ts'
import { expectedFailurePart, readExpected, stuckRequest, troubleText } from '../../hooks/decision/escalation.ts'
import {
  contentLanguage,
  judgeMidturn,
  midturnEffortPart,
  midturnState,
  MIDTURN_LEVEL,
  outcomeOfLine,
  resultLine,
  toolDetail,
  type MidturnInput,
  type MidturnLimits,
  type MidturnRules,
  type MidturnShow,
} from '../../hooks/decision/midturn.ts'
import { answersFor, mergeParts, type DecisionRequest, type Part } from '../../hooks/decision/system-one.ts'
import type { EffortMidturnItem, Language, MidturnAsked, MidturnRowTool } from './datasets.ts'
import { gradeEffort } from './effort-submit.ts'
import type { Row } from './runner.ts'
import type { Settings, Suite } from './suite.ts'

/**
 * One way of asking (an eval variable): how the question is written, what
 * the state shows (the guide's §4.1 worries the current level anchors the
 * answer), whether a turn whose failures reach escalateAfter is asked what
 * the escalation feature (#7) asks a stuck turn, and how each call's line is
 * written: as the mod writes it (`rendered`: its outcome and what it worked
 * on) or as the dataset does (`raw`: what came of it too, which the mod never
 * sends; to measure the gap).
 */
type MidturnVariant = { ask: EffortAsk; show: MidturnShow; trouble: boolean; results: 'rendered' | 'raw' }

/** The variants by name; the first is how the mod asks today. */
export const MIDTURN_VARIANTS: Readonly<Record<string, MidturnVariant>> = {
  'en-score': { ask: DEFAULT_ASK, show: {}, trouble: false, results: 'rendered' },
  'zh-score': { ask: { language: 'zh', primitive: 'score' }, show: {}, trouble: false, results: 'rendered' },
  'no-current-effort': { ask: DEFAULT_ASK, show: { currentEffort: false }, trouble: false, results: 'rendered' },
  'no-counts': { ask: DEFAULT_ASK, show: { counts: false }, trouble: false, results: 'rendered' },
  trouble: { ask: DEFAULT_ASK, show: {}, trouble: true, results: 'rendered' },
  'raw-results': { ask: DEFAULT_ASK, show: {}, trouble: false, results: 'raw' },
}

function variantOf(variant: string): MidturnVariant {
  const how = MIDTURN_VARIANTS[variant]
  if (how === undefined) throw new RangeError(`no variant "${variant}" (${Object.keys(MIDTURN_VARIANTS).join(', ')})`)
  return how
}

/** What the re-decision reads, as the mod reads it (core/setup.ts): the latest `rejudgeSteps` steps, within `contextTokens`. */
export function midturnLimits(settings: Settings): MidturnLimits {
  return settings.midturn.limits
}

/** How an answer moves the level, as the mod reads it (core/setup.ts). */
export function midturnRules(settings: Settings): MidturnRules {
  return settings.midturn.rules
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
    const { request, part, expectedPart } = midturnRequest(item, language, variant, settings)
    const { asked } = await ask(request)
    if (!asked.ok) return { ok: false, failure: `${asked.failure.kind}: ${asked.failure.detail}` }
    const reading = readEffort(answersFor(part, asked.answers)[MIDTURN_LEVEL])
    if (reading === null) return { ok: false, failure: 'parse: no effort answer' }
    const verdict = judgeMidturn(reading, { current: item[language].current_effort, sinceRaise: null }, midturnRules(settings))
    // A stuck item's answer to whether its failures were expected, kept for calibrating thetaExpected (#17); not graded.
    const expected = expectedPart === null ? null : readExpected(answersFor(expectedPart, asked.answers))
    return {
      ok: true,
      prediction: verdict.picked,
      detail: {
        p: reading.probabilities.map((p) => Math.round(p * 1000) / 1000),
        confidence: reading.confidence,
        sent: verdict.effort,
        why: verdict.why,
        ...(expected === null ? {} : { expected: Math.round(expected * 1000) / 1000 }),
      },
    }
  },
  grade: gradeEffort,
  show: (effort) => effort,
  constants: EFFORTS,
  // Never moving the level: the answer a re-decision is worth nothing against.
  baselines: { current: (item) => item.zh.current_effort },
  // What a variant asks; the trouble variant, of a stuck item, what #7 asks.
  questions: (variant) => {
    const how = variantOf(variant)
    if (!how.trouble) return midturnEffortPart(how.ask).questions
    return { ...midturnEffortPart(how.ask, { trouble: true }).questions, ...expectedFailurePart(how.ask).questions }
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
 * asked as `variant` says. Under the trouble variant, an item whose counted
 * failures reach `escalateAfter` is asked what the escalation feature (#7)
 * asks of a stuck turn (`stuckRequest`: the trouble, the effort question with
 * its trouble flag, and whether the failures were expected; `expectedPart`
 * reads the last); the others as the mod asks every N steps. The item's
 * failures are those since the counts last started over, as the mod counts
 * them; hook blocks count toward escalating only with `hook-block-failures`
 * on, off by default, so the trouble names failures only.
 */
export function midturnRequest(item: EffortMidturnItem, language: Language, variant: string, settings: Settings): { request: DecisionRequest; part: Part; expectedPart: Part | null } {
  const how = variantOf(variant)
  const asked = midturnInput(item[language], how.results)
  if (how.trouble && asked.counts.failures >= settings.escalation.after) {
    const input: MidturnInput = { ...asked, trouble: troubleText({ failures: asked.counts.failures, hookBlocks: 0 }) }
    const { request, effortPart, expectedPart } = stuckRequest(input, { limits: midturnLimits(settings), ask: how.ask, effort: true })
    return { request, part: effortPart as Part, expectedPart }
  }
  const part = midturnEffortPart(how.ask)
  return { request: mergeParts(midturnState(asked, midturnLimits(settings), how.show), [part]), part, expectedPart: null }
}

/**
 * A row as the mod's re-decision reads its turn (MidturnInput): each call's
 * line written as the mod writes it (`resultLine` of how the call ended and
 * what `toolDetail` reads of its input, in the language of the message), or
 * under `raw`, the dataset's result as it is.
 */
export function midturnInput(asked: MidturnAsked, results: 'rendered' | 'raw' = 'rendered'): MidturnInput {
  const language = contentLanguage(asked.message)
  const line = (tool: MidturnRowTool) => {
    const outcome = outcomeOfLine(tool.result)
    return results === 'raw' || outcome === null ? tool.result : resultLine(outcome, toolDetail(tool.input), language)
  }
  return { ...asked, recent_steps: asked.recent_steps.map((step) => ({ assistant_text: step.assistant_text, tools: step.tools.map((tool) => ({ name: tool.name, result: line(tool) })) })) }
}
