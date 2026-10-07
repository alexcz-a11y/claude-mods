// The long-context suite (#44): how much more of a long conversation the decision model reads, and what it makes of it.
// An item is a question with the rounds that decide its answer far back in a long conversation (`datasets.ts`
// LongContextItem, built by `long-conversation.ts`), asked as the mod asks a message's effort question (the effort
// part `turnStartPart` builds, over the state `messageRequest` builds), at the state budget and with the number of
// messages the run's settings give (`--state-tokens`, `--state-messages`; the mod's own are 24000 and 32).
//
// Variants, `<question language>-score-<version>`: the conversation as `deep` (the decisive rounds `depth` tokens back),
// `near` (control a: the same rounds a few thousand tokens back) or `none` (control b: deleted whole, scored against the
// answer without them); and `<question language>-flow`: the deep conversation as the mod would have it after living it,
// with the problem summary the cheap model wrote turn by turn (`long-context-summaries.json`, eval/long-context-summaries.ts),
// the count of the person's "unresolved" messages, and the strong hint the count makes (`unresolvedMaxAfter`). The plain
// variants carry neither summary nor count: the state is the conversation and the message. `<language>-summary` and
// `<language>-count` are the two halves of the flow asked on their own (what the summary does, what the count and the hint do).
//
// The conversation is Chinese only; English is only the language the questions are written in.
//
// Pure: no Node API.

import { estimateTokens } from '../../hooks/decision/context.ts'
import { EFFORTS, type Effort, type EffortAsk } from '../../hooks/decision/effort.ts'
import type { Summary } from '../../hooks/decision/summary.ts'
import { turnStartPart } from '../../hooks/decision/turn-start.ts'
import { CATEGORIES, DEPTHS, type LongContextItem } from './datasets.ts'
import { gradeEffort } from './effort-submit.ts'
import { conversationOf, decisiveMark, fingerprint, unresolvedCount, type Version } from './long-conversation.ts'
import { rate, type VariantSummary } from './metrics.ts'
import type { Row } from './runner.ts'
import { askUnresolved, askedRequest, type UnresolvedPrediction } from './unresolved.ts'
import { variantIn, type Grade, type Settings, type Suite } from './suite.ts'

/**
 * How a variant asks: the language of the questions, which version of the conversation, and what of the mod's flow comes with it:
 * the problem summary, the count of times the person said it is unresolved (with the strong hint it makes from `unresolvedMaxAfter`).
 */
type Variant = { ask: EffortAsk; version: Version; summary: boolean; count: boolean }

export const LONG_CONTEXT_VARIANTS: Readonly<Record<string, Variant>> = Object.fromEntries([
  ...(['zh', 'en'] as const).flatMap((language) => (['deep', 'near', 'none'] as const).map((version) => [`${language}-score-${version}`, { ask: { language, primitive: 'score' }, version, summary: false, count: false }] as const)),
  // The flow as the mod lives it, then each of its halves on its own (the deep conversation in all three).
  ...(['zh', 'en'] as const).flatMap((language) =>
    (
      [
        ['flow', true, true],
        ['summary', true, false],
        ['count', false, true],
      ] as const
    ).map(([name, summary, count]) => [`${language}-${name}`, { ask: { language, primitive: 'score' }, version: 'deep', summary, count }] as const),
  ),
])

/** What a summary file holds for an item: the summary the cheap model had written by the end of the deep conversation, and what it was written for. */
export type SummaryEntry = {
  /** The fingerprint of the deep conversation it was written over (`fingerprint`): a summary of another conversation is refused. */
  conversation: string
  /** How many times the person had said the problem was unresolved by the message (`unresolvedCount`). */
  count: number
  summary: Summary
  /** How many turns the cheap model was asked about, and how many of its answers were no summary (the mod keeps the old one then). */
  turns?: number
  failed?: number
}
export type SummaryFile = { about?: Record<string, unknown>; items: Record<string, SummaryEntry> }

/** What the suite decides: the effort and the answer to the three-way question; the version it was asked about, which says what is right. */
export type LongPrediction = UnresolvedPrediction & { version: Version }

/** The answer that is right for a version of the question: with the decisive rounds in it, or without them. */
export function answerOf(item: LongContextItem, version: Version): { gold: Effort; accept: readonly Effort[] } {
  return version === 'none' ? item.without : item
}

export const SUMMARY_FILE = 'long-context-summaries.json'

/** The suite; `summaries` is the file beside the dataset (undefined when there is none: the flow variants then say so). */
export function longContextSuite(summaries: SummaryFile | undefined): Suite<LongContextItem, LongPrediction> {
  return {
    name: 'long-context',
    variants: Object.keys(LONG_CONTEXT_VARIANTS),
    async decide(item, language, variantName, ask, settings) {
      if (language !== 'zh') return { ok: false, failure: 'the conversation is Chinese only: run with --languages zh' }
      const variant = variantIn(LONG_CONTEXT_VARIANTS, variantName)
      const entries = conversationOf(item, variant.version)
      let summary: Summary | null = null
      let count: { count: number; maxAfter: number } | null = null
      if (variant.summary) {
        const kept = summaries?.items[item.id]
        if (kept === undefined) return { ok: false, failure: `no summary for ${item.id} in ${SUMMARY_FILE}: write them with eval/long-context-summaries.ts` }
        if (kept.conversation !== fingerprint(entries)) return { ok: false, failure: `the summary of ${item.id} was written for another conversation (the item or the filler changed): write it again` }
        const made = unresolvedCount(item)
        if (kept.count !== made) return { ok: false, failure: `the summary file says count ${kept.count} for ${item.id}, the decisive rounds make ${made}: write it again` }
        summary = kept.summary
      }
      // The count is the decisive rounds' own; the strong hint is the mod's own function of it and of the person's `unresolvedMaxAfter`.
      if (variant.count) count = { count: unresolvedCount(item), maxAfter: settings.unresolved.maxAfter }
      const sent = askedRequest({ message: item.zh.message, recent_context: entries }, { ask: variant.ask, wide: true }, settings, summary, count)
      const decided = await askUnresolved(sent, ask, settings)
      if (!decided.ok) return decided
      const held = String(sent.request.state.recent_context ?? '')
      const detail = {
        ...decided.detail,
        // Whether the state held the decisive rounds (they are not there to hold in the none version).
        seen: variant.version === 'none' ? null : held.includes(decisiveMark(item)),
        stateTokens: estimateTokens(JSON.stringify(sent.request.state)),
        kept: held === '' ? 0 : held.split('\n').length,
        depth: item.depth,
      }
      return { ok: true, prediction: { ...decided.prediction, version: variant.version }, detail }
    },
    grade(item, prediction): Grade {
      const effort = gradeEffort({ gold: answerOf(item, prediction.version).gold, accept: answerOf(item, prediction.version).accept }, prediction.effort)
      return prediction.triage === null ? effort : { ...effort, parts: { effort: effort.correct, triage: prediction.triage === item.triage } }
    },
    show: (prediction) => (prediction.triage === null ? prediction.effort : `${prediction.effort} / ${prediction.triage}`),
    constants: EFFORTS.map((effort) => ({ effort, triage: null, version: 'deep' as const })),
    questions: (variantName) => turnStartPart({ ask: variantIn(LONG_CONTEXT_VARIANTS, variantName).ask, unresolved: true }).questions,
    digestState: true,
    about: { versions: 'deep: the decisive rounds first; near: a few thousand tokens before the message; none: deleted whole', depths: DEPTHS, categories: CATEGORIES },
    breakdown: (items, rows, variantName) => breakdownOf(items, rows, variantIn(LONG_CONTEXT_VARIANTS, variantName)),
    report: reportOf,
    scoring:
      'The answer is the effort, right when it is in the accept set of the version asked (the mod\'s pickEffort over the backend\'s probabilities, thetaMax as set): the item\'s `accept` for the deep and near versions and the flow, its `without.accept` for the none version, from which the decisive rounds are deleted; a wrong one is too high or too low. ' +
      'The three-way question is asked with it, as the mod asks it, and scored as a part of its own (`triage`). ' +
      '`seen` is whether the state held the decisive rounds (the mark of their first message is in `recent_context`), the figure that says what a state budget and a message limit did to a request: it is what the answer\'s accuracy is to be read against. ' +
      '`byDepth` and `byCategory` split the items; `top` is the recall of the top level over the items whose gold is max. ' +
      'The flow variants carry the problem summary and the count the mod would hold after the conversation (the summary written turn by turn by the cheap model over the deep conversation, the count from the decisive rounds\' `says`).',
  }
}

type Figure = number | null

/** `count` of `of`, null when there is nothing to count over. */
function share(count: number, of: number): Figure {
  return of === 0 ? null : rate(count, of)
}

/** The suite's own figures for one variant. */
function breakdownOf(items: readonly LongContextItem[], rows: readonly Row<LongPrediction>[], variant: Variant): Record<string, unknown> {
  const rowOf = new Map(rows.filter((row) => row.language === 'zh').map((row) => [row.id, row]))
  const right = (item: LongContextItem) => rowOf.get(item.id)?.correct === true
  const seenOf = (item: LongContextItem) => rowOf.get(item.id)?.detail?.seen
  const accuracy = (group: readonly LongContextItem[]) => share(group.filter(right).length, group.length)
  const needsTop = items.filter((item) => answerOf(item, variant.version).gold === 'max')
  const missed = (way: string) => share(items.filter((item) => rowOf.get(item.id)?.miss === way).length, items.length)
  const countable = items.filter((item) => typeof seenOf(item) === 'boolean')
  const seen = countable.filter((item) => seenOf(item) === true)
  const byDepth = Object.fromEntries(
    DEPTHS.map((depth) => {
      const group = items.filter((item) => item.depth === depth)
      const groupSeen = group.filter((item) => typeof seenOf(item) === 'boolean')
      return [String(depth), { items: group.length, accuracy: accuracy(group), seen: share(groupSeen.filter((item) => seenOf(item) === true).length, groupSeen.length), topRecall: share(group.filter((item) => answerOf(item, variant.version).gold === 'max' && rowOf.get(item.id)?.prediction?.effort === 'max').length, group.filter((item) => answerOf(item, variant.version).gold === 'max').length) }]
    }),
  )
  const byCategory = Object.fromEntries(
    CATEGORIES.map((category) => {
      const group = items.filter((item) => item.tags.includes(category))
      return [category, { items: group.length, accuracy: accuracy(group) }]
    }).filter(([, figures]) => (figures as { items: number }).items > 0),
  )
  const sizes = rows.flatMap((row) => (typeof row.detail?.stateTokens === 'number' ? [row.detail.stateTokens] : []))
  const triaged = rows.some((row) => typeof row.detail?.triage === 'string')
  return {
    version: variant.version,
    summary: variant.summary,
    count: variant.count,
    top: { items: needsTop.length, recall: share(needsTop.filter((item) => rowOf.get(item.id)?.prediction?.effort === 'max').length, needsTop.length) },
    tooHigh: missed('over'),
    tooLow: missed('under'),
    seen: { items: countable.length, share: share(seen.length, countable.length) },
    accuracyBySeen: { seen: accuracy(seen), notSeen: accuracy(countable.filter((item) => seenOf(item) === false)) },
    byDepth,
    byCategory,
    stateTokens: { mean: sizes.length === 0 ? null : Math.round(sizes.reduce((sum, size) => sum + size, 0) / sizes.length), max: sizes.length === 0 ? null : Math.max(...sizes) },
    triage: triaged ? { accuracy: share(items.filter((item) => rowOf.get(item.id)?.prediction?.triage === item.triage).length, items.length) } : null,
  }
}

/** Lines about one variant, after the figures every suite gets. */
function reportOf(summary: VariantSummary): string[] {
  const b = summary.breakdown as { top: { items: number; recall: Figure }; tooHigh: Figure; tooLow: Figure; seen: { items: number; share: Figure }; accuracyBySeen: { seen: Figure; notSeen: Figure }; byDepth: Record<string, { items: number; accuracy: Figure; seen: Figure; topRecall: Figure }>; stateTokens: { mean: number | null; max: number | null }; triage: { accuracy: Figure } | null } | undefined
  if (b === undefined) return []
  const pct = (figure: Figure) => (figure === null ? '-' : `${(figure * 100).toFixed(1)}%`)
  return [
    `${summary.variant}: state held the decisive rounds in ${pct(b.seen.share)} of ${b.seen.items} answers; right when held ${pct(b.accuracyBySeen.seen)}, when not ${pct(b.accuracyBySeen.notSeen)}; state ${b.stateTokens.mean ?? '-'} tokens on average, ${b.stateTokens.max ?? '-'} at most`,
    `${summary.variant}: top level recall ${pct(b.top.recall)} over ${b.top.items} items whose gold is max; too high ${pct(b.tooHigh)}, too low ${pct(b.tooLow)}${b.triage === null ? '' : `; three-way question right ${pct(b.triage.accuracy)}`}`,
    ...Object.entries(b.byDepth).map(([depth, group]) => `${summary.variant}: ${depth} deep, ${group.items} items: accuracy ${pct(group.accuracy)}, state held the rounds ${pct(group.seen)}, top level recall ${pct(group.topRecall)}`),
  ]
}
