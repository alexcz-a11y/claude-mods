// The unresolved suite: the main agent's effort when the person has been round
// several times on one problem (spec #36). An item is the message and the
// conversation before it, as in effort-submit, with the answer to a second
// question about the message: is it about the same problem still unresolved,
// one that is resolved, or a new or unrelated one (`triage`).
//
// What is asked is what the mod asks when a message is sent: the effort part
// of the message's decision request (`turnStartPart`, the mod's own function:
// the effort question, the three-way question beside it, the command of a
// command turn, the problem summary when there is one), over the state the
// mod builds for it (`messageRequest`). Until #38 the mod asked the effort
// question beside the skill ranking in one request, with a budget of 6000
// tokens for the state; since #38 (ADR 0005) it has a request of its own and
// 24000. Both are variants, so the baseline taken before #38 stays comparable:
// `zh-score` is the state of the shared request (6000), `zh-score-wide` the
// state of the request of its own (24000, the mod today). The baseline asked
// the effort question alone; every variant now asks the three-way question
// too, as the mod does (#39), and scores it on its own beside the effort.
//
// The dataset has no summaries: an item is asked as the first message of a
// problem would be, with no summary in the state (a summary is what a cheap
// model wrote turn by turn, which a transcript of a thread does not hold). The
// request takes one (`unresolvedRequest`'s last argument), so that a run with
// summaries (written by hand, or by the mod's own prompt over the thread, #42)
// asks what the mod asks with one.
//
// Pure: no Node API.

import { messageLimits } from '../../hooks/core/setup.ts'
import { EFFORTS, LEVEL, pickEffort, readEffort, type Effort, type EffortAsk } from '../../hooks/decision/effort.ts'
import type { Summary } from '../../hooks/decision/summary.ts'
import { answersFor, type DecisionRequest, type Part } from '../../hooks/decision/system-one.ts'
import { messageRequest, turnStartPart } from '../../hooks/decision/turn-start.ts'
import { judgeUnresolved, readUnresolved, UNRESOLVED, UNRESOLVED_OPTIONS, type UnresolvedChange, type UnresolvedOption } from '../../hooks/decision/unresolved.ts'
import { OVER_BUDGET, TRIAGES, type Language, type Triage, type UnresolvedItem } from './datasets.ts'
import { contextMessages, gradeEffort } from './effort-submit.ts'
import { rate, type VariantSummary } from './metrics.ts'
import type { Row } from './runner.ts'
import { requestFailed, variantIn, type Grade, type Settings, type Suite } from './suite.ts'

/** How the effort question is asked, and how much of the conversation the state may hold. */
type Variant = { ask: EffortAsk; wide: boolean }

/**
 * The variants by name: `<question language>-<primitive>[-wide]`. Without
 * `wide` the state has the budget of the request that carries the skills'
 * question (`contextTokens`, 6000: the mod before #38); with it the budget of a
 * plain message (`contextByKind.messagePlain`, 24000: the effort question's
 * request of its own, the mod since #38). Jev's question is `zh-score`, Clef's
 * `en-score`.
 */
export const UNRESOLVED_VARIANTS: Readonly<Record<string, Variant>> = {
  'zh-score': { ask: { language: 'zh', primitive: 'score' }, wide: false },
  'en-score': { ask: { language: 'en', primitive: 'score' }, wide: false },
  'zh-score-wide': { ask: { language: 'zh', primitive: 'score' }, wide: true },
  'en-score-wide': { ask: { language: 'en', primitive: 'score' }, wide: true },
}

/** What the dataset calls each answer of the three-way question (the mod's option names are `UNRESOLVED_OPTIONS`). */
const TRIAGE_OF: Readonly<Record<UnresolvedOption, Triage>> = { still_unresolved: 'unresolved', resolved: 'resolved', new_or_unrelated: 'new' }

/** What a suite decides for an item: the effort, and the answer to the three-way question (the option it leaned to most; null for a constant answer, which reads no question). */
export type UnresolvedPrediction = { effort: Effort; triage: Triage | null }

/**
 * The request the mod sends when the person sends the item's message in
 * `language`: the effort part the mod builds (`turnStartPart`: the effort
 * question, the three-way question, a command turn's command, the summary when
 * one is given) in the state the mod builds for the message (`messageRequest`,
 * the limits of the request the variant stands for). The part is returned to
 * read the answers by.
 */
export function unresolvedRequest(item: UnresolvedItem, language: Language, variant: Variant, settings: Settings, summary: Summary | null = null): { request: DecisionRequest; part: Part } {
  const asked = item[language]
  const part = turnStartPart({ ask: variant.ask, unresolved: true, command: asked.command ?? null, summary })
  // The mod's own limits: the request of its own (`wide`) or the one shared with the skills' question (messageLimits).
  const request = messageRequest({ prompt: asked.message, messages: contextMessages(asked.recent_context), limits: messageLimits(settings, !variant.wide), parts: [part] })
  return { request, part }
}

/** What each judged change to the count should be, by what the item's message says: one more for a problem still unresolved, a clear for the rest. */
const RIGHT_CHANGE: Readonly<Record<Triage, UnresolvedChange>> = { unresolved: 'add', resolved: 'reset', new: 'reset' }

/** The thresholds a run reports the top level's recall at: what `thetaMax` would have given (the rule is `pickEffort`'s). */
const THETAS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7]

/**
 * The suite: the effort question and the three-way question beside it, asked as the mod asks them, the three-way
 * question read as the mod reads it (`readUnresolved`, its answer the option it leans to most, `judgeUnresolved`'s `top`).
 */
export function unresolvedSuite(): Suite<UnresolvedItem, UnresolvedPrediction> {
  return {
    name: 'unresolved',
    variants: Object.keys(UNRESOLVED_VARIANTS),
    async decide(item, language, variant, ask, settings) {
      const sent = unresolvedRequest(item, language, variantIn(UNRESOLVED_VARIANTS, variant), settings)
      const { asked } = await ask(sent.request)
      if (!asked.ok) return requestFailed(asked.failure)
      const answers = answersFor(sent.part, asked.answers)
      const reading = readEffort(answers[LEVEL])
      if (reading === null) return { ok: false, failure: 'parse: no effort answer' }
      const said = readUnresolved(answers[UNRESOLVED])
      if (said === null) return { ok: false, failure: 'parse: no triage answer' }
      const judged = judgeUnresolved(said)
      const effort = pickEffort(reading, settings.thetaMax)
      const detail: Record<string, unknown> = {
        p: reading.probabilities.map((p) => Math.round(p * 1000) / 1000),
        confidence: reading.confidence,
        triage: TRIAGE_OF[judged.top],
        triageP: Object.fromEntries(UNRESOLVED_OPTIONS.map((option) => [TRIAGE_OF[option], Math.round(said.probabilities[option] * 1000) / 1000])),
        // What the mod's two bars make of the answer (it moves the count by this).
        triageChange: judged.change,
      }
      return { ok: true, prediction: { effort, triage: TRIAGE_OF[judged.top] }, detail }
    },
    grade(item, prediction): Grade {
      const effort = gradeEffort(item, prediction.effort)
      // The effort is the answer; the three-way question is a part of it, scored on its own.
      return prediction.triage === null ? effort : { ...effort, parts: { effort: effort.correct, triage: prediction.triage === item.triage } }
    },
    show: (prediction) => (prediction.triage === null ? prediction.effort : `${prediction.effort} / ${prediction.triage}`),
    constants: EFFORTS.map((effort) => ({ effort, triage: null })),
    questions: (variant) => turnStartPart({ ask: variantIn(UNRESOLVED_VARIANTS, variant).ask, unresolved: true }).questions,
    breakdown: (items, rows, _variant, settings) => breakdownOf(items, rows, settings),
    report: reportOf,
    scoring:
      'The answer is the effort, right when it is in the item\'s accept set (the mod\'s pickEffort over the backend\'s probabilities, thetaMax as set); a wrong one is too high or too low. ' +
      'The three-way question is asked with it, as the mod asks it (`effort.unresolved`), and its answer is the option it leaned to most, mapped to the dataset\'s names (still_unresolved is unresolved, new_or_unrelated is new); it is scored as a part of its own (`triage`), and `triage.change` says what the mod\'s two bars would have done to the count. ' +
      '`top` is the recall of the top level over the items whose gold is max; `tooHigh` and `tooLow` are shares of all items; ' +
      '`byLength` splits the items by whether the conversation overruns the state budget of a message today (the over-budget tag); `thetaMax` is what the top level\'s recall, and the share of items that did not accept max but got it, would have been at each threshold. ' +
      'No item has a problem summary: each is asked as the first message of a problem would be.',
  }
}

/** The suite as the mod asks today. */
export const unresolved = unresolvedSuite()

const LANGS: readonly Language[] = ['zh', 'en']
type ByLanguage<T> = Record<Language, T>

/** `count` of `of`, null when there is nothing to count over (a share of no items says nothing). */
function share(count: number, of: number): number | null {
  return of === 0 ? null : rate(count, of)
}

/** One figure for each language. */
function eachLanguage<T>(figure: (language: Language) => T): ByLanguage<T> {
  return { zh: figure('zh'), en: figure('en') }
}

/** The suite's own figures for one variant: the top level's recall, too high and too low, long conversations beside short, thetaMax, and the three-way question. */
function breakdownOf(items: readonly UnresolvedItem[], rows: readonly Row<UnresolvedPrediction>[], settings: Settings): Record<string, unknown> {
  const rowOf = (language: Language) => new Map(rows.filter((row) => row.language === language).map((row) => [row.id, row]))
  const byLanguage = { zh: rowOf('zh'), en: rowOf('en') }
  const effortOf = (item: UnresolvedItem, language: Language, theta?: number): Effort | null => {
    const row = byLanguage[language].get(item.id)
    if (theta === undefined || !Array.isArray(row?.detail?.p)) return row?.prediction?.effort ?? null
    return pickEffort({ probabilities: row.detail.p as number[], confidence: null }, theta)
  }
  const needsTop = (group: readonly UnresolvedItem[]) => group.filter((item) => item.gold === 'max')
  const recall = (group: readonly UnresolvedItem[], language: Language, theta?: number) => share(needsTop(group).filter((item) => effortOf(item, language, theta) === 'max').length, needsTop(group).length)
  const missed = (way: string, language: Language) => share([...byLanguage[language].values()].filter((row) => row.miss === way).length, items.length)

  const long = items.filter((item) => item.tags.includes(OVER_BUDGET))
  const groups = { [OVER_BUDGET]: long, fits: items.filter((item) => !long.includes(item)) }
  const thetas = [...new Set([...THETAS, settings.thetaMax])].sort((a, b) => a - b)
  const refused = items.filter((item) => !item.accept.includes('max'))
  const triaged = rows.some((row) => typeof row.detail?.triage === 'string')

  return {
    top: { items: needsTop(items).length, recall: eachLanguage((language) => recall(items, language)) },
    tooHigh: eachLanguage((language) => missed('over', language)),
    tooLow: eachLanguage((language) => missed('under', language)),
    byLength: Object.fromEntries(
      Object.entries(groups).map(([name, group]) => [
        name,
        {
          items: group.length,
          accuracy: eachLanguage((language) => share(group.filter((item) => byLanguage[language].get(item.id)?.correct === true).length, group.length)),
          topRecall: eachLanguage((language) => recall(group, language)),
        },
      ]),
    ),
    thetaMax: thetas.map((thetaMax) => ({
      thetaMax,
      topRecall: eachLanguage((language) => recall(items, language, thetaMax)),
      topWrong: eachLanguage((language) => share(refused.filter((item) => effortOf(item, language, thetaMax) === 'max').length, refused.length)),
    })),
    triage: triaged
      ? {
          accuracy: eachLanguage((language) => share(items.filter((item) => byLanguage[language].get(item.id)?.prediction?.triage === item.triage).length, items.length)),
          confusion: eachLanguage((language) => confusion(items, byLanguage[language])),
          change: changeFigures(items, byLanguage),
        }
      : null,
  }
}

/**
 * What the mod's two bars made of the answers, in the count's terms: `right` the share of all items whose message moved
 * the count the right way (one more for a problem still unresolved, a clear for the rest; "keep" is neither),
 * `falseAdd` the share of the items that are not about an unresolved problem which added one (a count too high, made up
 * at the next message), `lostRecord` the share of the unresolved ones which cleared the count (the record of several
 * tries lost: the costly one).
 */
function changeFigures(items: readonly UnresolvedItem[], byLanguage: ByLanguage<ReadonlyMap<string, Row<UnresolvedPrediction>>>): Record<'right' | 'falseAdd' | 'lostRecord', ByLanguage<number | null>> {
  const changeOf = (item: UnresolvedItem, language: Language) => byLanguage[language].get(item.id)?.detail?.triageChange
  const open = items.filter((item) => item.triage === 'unresolved')
  const rest = items.filter((item) => item.triage !== 'unresolved')
  return {
    right: eachLanguage((language) => share(items.filter((item) => changeOf(item, language) === RIGHT_CHANGE[item.triage]).length, items.length)),
    falseAdd: eachLanguage((language) => share(rest.filter((item) => changeOf(item, language) === 'add').length, rest.length)),
    lostRecord: eachLanguage((language) => share(open.filter((item) => changeOf(item, language) === 'reset').length, open.length)),
  }
}

/** How often each answer of the three-way question was given for each kind of item: `{ resolved: { unresolved: 1 } }`; only what happened. */
function confusion(items: readonly UnresolvedItem[], rows: ReadonlyMap<string, Row<UnresolvedPrediction>>): Record<string, Record<string, number>> {
  const table: Record<string, Record<string, number>> = {}
  for (const answer of TRIAGES) {
    for (const item of items.filter((item) => item.triage === answer)) {
      const said = rows.get(item.id)?.prediction?.triage
      if (said === null || said === undefined) continue
      const row = (table[answer] ??= {})
      row[said] = (row[said] ?? 0) + 1
    }
  }
  return table
}

/** Lines about one variant, after the figures every suite gets. */
function reportOf(summary: VariantSummary): string[] {
  const b = summary.breakdown as { top: { items: number; recall: ByLanguage<number | null> }; tooHigh: ByLanguage<number | null>; tooLow: ByLanguage<number | null>; byLength: Record<string, { items: number; accuracy: ByLanguage<number | null>; topRecall: ByLanguage<number | null> }>; thetaMax: { thetaMax: number; topRecall: ByLanguage<number | null>; topWrong: ByLanguage<number | null> }[]; triage: { accuracy: ByLanguage<number | null>; confusion: ByLanguage<Record<string, Record<string, number>>> } | null } | undefined
  if (b === undefined) return []
  const pct = (rate: number | null) => (rate === null ? '-' : `${(rate * 100).toFixed(1)}%`)
  const both = (figure: ByLanguage<number | null>) => `${pct(figure.zh)}/${pct(figure.en)}`
  const lines = [
    `${summary.variant}: top level recall (zh/en) ${both(b.top.recall)} over ${b.top.items} items whose gold is max; too high ${both(b.tooHigh)}, too low ${both(b.tooLow)} (shares of all items)`,
    ...Object.entries(b.byLength).map(([name, group]) => `${summary.variant}: ${name}, ${group.items} items: accuracy ${both(group.accuracy)}, top level recall ${both(group.topRecall)}`),
    `${summary.variant}: at each thetaMax, top level recall / given max though not accepted (zh/en): ${b.thetaMax.map((row) => `${row.thetaMax} ${both(row.topRecall)} / ${both(row.topWrong)}`).join('; ')}`,
  ]
  if (b.triage !== null) lines.push(`${summary.variant}: three-way question right (zh/en) ${both(b.triage.accuracy)}; by item (zh): ${JSON.stringify(b.triage.confusion.zh)}`)
  return lines
}
