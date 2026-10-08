// The eval-v2 suite (#45): the effort the main agent is given at the last message of a long conversation assembled from
// the pool (eval-v2.jsonl, lib/eval-v2.ts), and the three-way question asked beside it, scored against the final gold
// (eval-v2/gold/<id>.json: the answers both sides agreed on, or the person's ruling).
//
// What is asked is what the mod asks when the person sends that message: the conversation's last turn is the message
// (a command turn's carries its command), every turn before it is the conversation the mod reads (`askedRequest` of
// lib/unresolved.ts: the effort part `turnStartPart` builds, the state `messageRequest` builds, at the budget and the
// number of messages the run's settings give: `--state-tokens`, `--state-messages`). The conversation is Chinese only;
// the variants are the language the questions are written in, and whether the request carries the mod's flow.
//
// Pure: no Node API.

import { estimateTokens } from '../../hooks/decision/context.ts'
import { EFFORTS, pickEffort, type Effort, type EffortAsk } from '../../hooks/decision/effort.ts'
import type { Summary } from '../../hooks/decision/summary.ts'
import { turnStartPart } from '../../hooks/decision/turn-start.ts'
import { givesHint } from '../../hooks/decision/unresolved.ts'
import { BIN_NAMES, RELATIONS, V2_CATEGORIES, type FinalGold, type V2Record } from './eval-v2.ts'
import { conversationPrint, type FlowFile } from './eval-v2-flow.ts'
import { TRIAGES, type Triage, type UnresolvedAsked } from './datasets.ts'
import { gradeEffort } from './effort-submit.ts'
import { rate, type VariantSummary } from './metrics.ts'
import type { Row } from './runner.ts'
import { variantIn, type Grade, type Settings, type Suite } from './suite.ts'
import { askedRequest, askUnresolved, TRIAGE_OF, type UnresolvedPrediction } from './unresolved.ts'

export type { FinalGold } from './eval-v2.ts'

/** An item of the suite: the assembled conversation, its final gold, and the tags a run's figures are split by. */
export type V2EvalItem = V2Record & { tags: string[]; gold: FinalGold }

/** The item a run asks: the record and its gold, tagged with its category, bin, relation and domain. */
export function v2Item(record: V2Record, gold: FinalGold): V2EvalItem {
  return { ...record, tags: [record.category, record.bin, record.relation, record.domain], gold }
}

/** How a variant asks: the language of the questions, and whether the request carries the flow's count and summary. */
type Variant = { ask: EffortAsk; flow: boolean }

export const V2_VARIANTS: Readonly<Record<string, Variant>> = {
  'zh-score': { ask: { language: 'zh', primitive: 'score' }, flow: false },
  'en-score': { ask: { language: 'en', primitive: 'score' }, flow: false },
  'zh-flow': { ask: { language: 'zh', primitive: 'score' }, flow: true },
  'en-flow': { ask: { language: 'en', primitive: 'score' }, flow: true },
}

/** The message of a record and the conversation before it, as `askedRequest` takes them. */
export function v2Asked(record: V2Record): UnresolvedAsked {
  const last = record.turns.at(-1)
  if (last === undefined || last.role !== 'user') throw new Error(`${record.id}: the conversation does not end with the person's message`)
  return {
    message: last.text,
    recent_context: record.turns.slice(0, -1).map((turn) => ({ role: turn.role, text: turn.text, ...(turn.tools === undefined ? {} : { tools: turn.tools }) })),
    ...(last.command === undefined ? {} : { command: last.command }),
  }
}

/**
 * Whether the state held the turn at `at` of the conversation before the message: the state is the newest lines, one a
 * turn (the turns alternate, so none is merged with another), so it holds a turn when the turn is among the last `kept`.
 */
function held(record: V2Record, kept: number, at: number): boolean {
  return at >= record.turns.length - 1 - kept
}

/**
 * What a flow variant's request carries for an item: the count and the summary the flow file says the last message's
 * request carried, or why there is none to carry (no file, the item not in it, a flow of another conversation, one not finished).
 */
function carried(flow: FlowFile | undefined, item: V2EvalItem): { count: number; summary: Summary | null } | string {
  if (flow === undefined) return 'a flow variant needs --flow <file> (eval/eval-v2-flow.ts writes one per backend and budget)'
  const kept = flow.items[item.id]
  if (kept === undefined) return `no flow for ${item.id} in the flow file: run eval/eval-v2-flow.ts for it`
  if (kept.conversation !== conversationPrint(item)) return `the flow of ${item.id} was run over another conversation (eval-v2.jsonl changed): run it again`
  if (kept.final === undefined) return `the flow of ${item.id} is not finished (${kept.messages.length} messages done): run eval/eval-v2-flow.ts again`
  return kept.final
}

/** The suite; `flow` is the flow file the flow variants carry the count and the summary of (none: those variants say so and ask nothing). */
export function evalV2Suite(flow?: FlowFile): Suite<V2EvalItem, UnresolvedPrediction> {
  return {
    name: 'eval-v2',
    variants: Object.keys(V2_VARIANTS),
    async decide(item, language, variantName, ask, settings) {
      if (language !== 'zh') return { ok: false, failure: 'the conversation is Chinese only: run with --languages zh' }
      const variant = variantIn(V2_VARIANTS, variantName)
      const flowed = variant.flow ? carried(flow, item) : null
      if (typeof flowed === 'string') return { ok: false, failure: flowed }
      const count = flowed === null ? null : { count: flowed.count, maxAfter: settings.unresolved.maxAfter }
      const sent = askedRequest(v2Asked(item), { ask: variant.ask, wide: true }, settings, flowed?.summary ?? null, count)
      const decided = await askUnresolved(sent, ask, settings)
      if (!decided.ok) return decided
      const context = String(sent.request.state.recent_context ?? '')
      const kept = context === '' ? 0 : context.split('\n').length
      const decisive = item.turns.flatMap((turn, i) => (turn.part === 'decisive' ? [i] : []))
      const detail = {
        ...decided.detail,
        // Whether the state held the decisive rounds: all of them (their first message), or any (their newest line).
        seen: held(item, kept, decisive[0] ?? Infinity),
        seenAny: held(item, kept, decisive.at(-1) ?? Infinity),
        stateTokens: estimateTokens(JSON.stringify(sent.request.state)),
        kept,
        // What the flow carried: the count, whether it gave the strong hint, whether there was a summary.
        ...(count === null ? {} : { count: count.count, hint: givesHint(count.count, count.maxAfter), summary: flowed?.summary !== null }),
      }
      return { ok: true, prediction: decided.prediction, detail }
    },
    grade(item, prediction): Grade {
      const effort = gradeEffort({ gold: item.gold.effort, accept: item.gold.accept }, prediction.effort)
      return prediction.triage === null ? effort : { ...effort, parts: { effort: effort.correct, triage: prediction.triage === TRIAGE_OF[item.gold.triage_final] } }
    },
    show: (prediction) => (prediction.triage === null ? prediction.effort : `${prediction.effort} / ${prediction.triage}`),
    constants: EFFORTS.map((effort) => ({ effort, triage: null })),
    questions: (variantName) => turnStartPart({ ask: variantIn(V2_VARIANTS, variantName).ask, unresolved: true }).questions,
    digestState: true,
    languages: ['zh'],
    about: {
      variants: 'zh-score, en-score: the question in Chinese or English, the state the conversation and the message; zh-flow, en-flow: the same with the count and the summary the flow file holds at the last message (and the strong hint from unresolvedMaxAfter)',
      flow: flow === undefined ? null : { backend: flow.backend, settings: flow.settings, items: Object.keys(flow.items).length },
    },
    breakdown: (items, rows, variantName, settings) => breakdownOf(items, rows, variantIn(V2_VARIANTS, variantName), settings),
    report: reportOf,
    scoring:
      "The answer is the effort, right when it is in the final gold's accept (the mod's pickEffort over the backend's probabilities, thetaMax as set), exact when it is the gold effort; a wrong one is too high or too low. " +
      'The three-way question is asked with it, as the mod asks it, its answer the option it leaned to most, scored against triage_final as a part of its own (`triage`; still_unresolved is unresolved, new_or_unrelated is new). ' +
      '`top` is the recall of max over the items whose gold is max, `falseMax` the share of the items whose accept has no max that were given it; `byBin`, `byRelation`, `byBinRelation` and `byCategory` split the items. ' +
      '`seen` is whether the state held the decisive rounds (`all`: their first message; `any`: their newest line). `withoutDecisive` is, over the items whose effort_without_decisive is outside accept, the share answered exactly that: as if the decisive rounds had not been read. ' +
      '`thetaMax` is what other max thresholds would have given, from the probabilities each answer keeps (`p`; `triageP` keeps the three-way question\'s).',
  }
}

type Figure = number | null

/** `count` of `of`, null when there is nothing to count over. */
function share(count: number, of: number): Figure {
  return of === 0 ? null : rate(count, of)
}

/** The thresholds for max the figures are given at besides the run's own. */
const THETAS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7]

/** What each judged change to the count should be, by the gold of the message: one more for a problem still unresolved, a clear for the rest. */
const RIGHT_CHANGE: Readonly<Record<Triage, string>> = { unresolved: 'add', resolved: 'reset', new: 'reset' }

/** The suite's own figures for one variant. */
function breakdownOf(items: readonly V2EvalItem[], rows: readonly Row<UnresolvedPrediction>[], variant: Variant, settings: Settings): Record<string, unknown> {
  const rowOf = new Map(rows.filter((row) => row.language === 'zh').map((row) => [row.id, row]))
  const effortOf = (item: V2EvalItem, theta?: number): Effort | null => {
    const row = rowOf.get(item.id)
    if (theta === undefined || !Array.isArray(row?.detail?.p)) return row?.prediction?.effort ?? null
    return pickEffort({ probabilities: row.detail.p as number[], confidence: null }, { thetaMax: theta, roundUp: settings.roundUp })
  }
  const triageOf = (item: V2EvalItem) => rowOf.get(item.id)?.prediction?.triage ?? null
  const gold = (item: V2EvalItem) => TRIAGE_OF[item.gold.triage_final]
  const needsTop = (group: readonly V2EvalItem[]) => group.filter((item) => item.gold.effort === 'max')
  const noTop = (group: readonly V2EvalItem[]) => group.filter((item) => !item.gold.accept.includes('max'))
  const right = (item: V2EvalItem, theta?: number) => {
    const effort = effortOf(item, theta)
    return effort !== null && item.gold.accept.includes(effort)
  }
  const missed = (item: V2EvalItem, way: string) => rowOf.get(item.id)?.miss === way
  const group = (members: readonly V2EvalItem[]) => ({
    items: members.length,
    accuracy: share(members.filter((item) => right(item)).length, members.length),
    exact: share(members.filter((item) => effortOf(item) === item.gold.effort).length, members.length),
    tooHigh: share(members.filter((item) => missed(item, 'over')).length, members.length),
    tooLow: share(members.filter((item) => missed(item, 'under')).length, members.length),
    top: needsTop(members).length,
    topRecall: share(needsTop(members).filter((item) => effortOf(item) === 'max').length, needsTop(members).length),
    triage: share(members.filter((item) => triageOf(item) === gold(item)).length, members.length),
  })
  const detailOf = (item: V2EvalItem) => rowOf.get(item.id)?.detail
  const changed = items.filter((item) => !item.gold.accept.includes(item.gold.effort_without_decisive))
  const answeredSeen = items.filter((item) => typeof detailOf(item)?.seen === 'boolean')
  const sizes = rows.flatMap((row) => (typeof row.detail?.stateTokens === 'number' ? [row.detail.stateTokens] : []))
  const triaged = rows.some((row) => typeof row.prediction?.triage === 'string')
  const open = items.filter((item) => gold(item) === 'unresolved')
  const rest = items.filter((item) => gold(item) !== 'unresolved')
  const changeOf = (item: V2EvalItem) => detailOf(item)?.triageChange
  return {
    flow: variant.flow,
    question: variant.ask.language,
    top: {
      items: needsTop(items).length,
      recall: share(needsTop(items).filter((item) => effortOf(item) === 'max').length, needsTop(items).length),
      falseMax: share(noTop(items).filter((item) => effortOf(item) === 'max').length, noTop(items).length),
    },
    tooHigh: share(items.filter((item) => missed(item, 'over')).length, items.length),
    tooLow: share(items.filter((item) => missed(item, 'under')).length, items.length),
    byBin: Object.fromEntries(BIN_NAMES.map((bin) => [bin, group(items.filter((item) => item.bin === bin))])),
    byRelation: Object.fromEntries(RELATIONS.map((relation) => [relation, group(items.filter((item) => item.relation === relation))])),
    byBinRelation: Object.fromEntries(BIN_NAMES.flatMap((bin) => RELATIONS.map((relation) => [`${bin} ${relation}`, group(items.filter((item) => item.bin === bin && item.relation === relation))]))),
    byCategory: Object.fromEntries(V2_CATEGORIES.flatMap((category) => {
      const members = items.filter((item) => item.category === category)
      return members.length === 0 ? [] : [[category, group(members)]]
    })),
    triage: triaged
      ? {
          accuracy: share(items.filter((item) => triageOf(item) === gold(item)).length, items.length),
          confusion: confusion(items, triageOf, gold),
          change: {
            right: share(items.filter((item) => changeOf(item) === RIGHT_CHANGE[gold(item)]).length, items.length),
            falseAdd: share(rest.filter((item) => changeOf(item) === 'add').length, rest.length),
            lostRecord: share(open.filter((item) => changeOf(item) === 'reset').length, open.length),
          },
        }
      : null,
    seen: {
      all: share(answeredSeen.filter((item) => detailOf(item)?.seen === true).length, answeredSeen.length),
      any: share(answeredSeen.filter((item) => detailOf(item)?.seenAny === true).length, answeredSeen.length),
    },
    withoutDecisive: { items: changed.length, share: share(changed.filter((item) => effortOf(item) === item.gold.effort_without_decisive).length, changed.length) },
    thetaMax: [...new Set([...THETAS, settings.thetaMax])]
      .sort((a, b) => a - b)
      .map((thetaMax) => ({
        thetaMax,
        accuracy: share(items.filter((item) => right(item, thetaMax)).length, items.length),
        topRecall: share(needsTop(items).filter((item) => effortOf(item, thetaMax) === 'max').length, needsTop(items).length),
        falseMax: share(noTop(items).filter((item) => effortOf(item, thetaMax) === 'max').length, noTop(items).length),
      })),
    stateTokens: { mean: sizes.length === 0 ? null : Math.round(sizes.reduce((sum, size) => sum + size, 0) / sizes.length), max: sizes.length === 0 ? null : Math.max(...sizes) },
    // What the flow carried into the answered requests: a count above 0, the strong hint, a summary.
    carried: variant.flow
      ? {
          items: items.filter((item) => typeof detailOf(item)?.count === 'number').length,
          counted: items.filter((item) => Number(detailOf(item)?.count ?? 0) > 0).length,
          hinted: items.filter((item) => detailOf(item)?.hint === true).length,
          summarized: items.filter((item) => detailOf(item)?.summary === true).length,
        }
      : null,
  }
}

/** How often each answer of the three-way question was given for each gold: `{ resolved: { unresolved: 1 } }`; only what happened. */
function confusion(items: readonly V2EvalItem[], said: (item: V2EvalItem) => Triage | null, gold: (item: V2EvalItem) => Triage): Record<string, Record<string, number>> {
  const table: Record<string, Record<string, number>> = {}
  for (const answer of TRIAGES) {
    for (const item of items.filter((one) => gold(one) === answer)) {
      const given = said(item)
      if (given === null) continue
      const row = (table[answer] ??= {})
      row[given] = (row[given] ?? 0) + 1
    }
  }
  return table
}

type GroupFigures = { items: number; accuracy: Figure; exact: Figure; tooHigh: Figure; tooLow: Figure; top: number; topRecall: Figure; triage: Figure }

/** Lines about one variant, after the figures every suite gets. */
function reportOf(summary: VariantSummary): string[] {
  const b = summary.breakdown as
    | { top: { items: number; recall: Figure; falseMax: Figure }; tooHigh: Figure; tooLow: Figure; byBin: Record<string, GroupFigures>; byRelation: Record<string, GroupFigures>; byBinRelation: Record<string, GroupFigures>; triage: { accuracy: Figure; change: { lostRecord: Figure; falseAdd: Figure } } | null; seen: { all: Figure; any: Figure }; withoutDecisive: { items: number; share: Figure }; stateTokens: { mean: number | null; max: number | null }; carried: { items: number; counted: number; hinted: number; summarized: number } | null }
    | undefined
  if (b === undefined) return []
  const pct = (figure: Figure) => (figure === null ? '-' : `${(figure * 100).toFixed(1)}%`)
  const line = (name: string, g: GroupFigures) => `${summary.variant}: ${name}, ${g.items} items: accuracy ${pct(g.accuracy)}, exact ${pct(g.exact)}, too high ${pct(g.tooHigh)}, too low ${pct(g.tooLow)}, max recall ${pct(g.topRecall)} of ${g.top}, triage ${pct(g.triage)}`
  return [
    `${summary.variant}: max recall ${pct(b.top.recall)} over ${b.top.items} items whose gold is max, max where it is not accepted ${pct(b.top.falseMax)}; too high ${pct(b.tooHigh)}, too low ${pct(b.tooLow)}${b.triage === null ? '' : `; three-way question right ${pct(b.triage.accuracy)}, count lost ${pct(b.triage.change.lostRecord)}, added wrongly ${pct(b.triage.change.falseAdd)}`}`,
    `${summary.variant}: the state held all the decisive rounds in ${pct(b.seen.all)}, some of them in ${pct(b.seen.any)}; answered as if they had not been read in ${pct(b.withoutDecisive.share)} of ${b.withoutDecisive.items}; state ${b.stateTokens.mean ?? '-'} tokens on average, ${b.stateTokens.max ?? '-'} at most`,
    ...(b.carried === null ? [] : [`${summary.variant}: the flow carried a count into ${b.carried.counted} of ${b.carried.items} requests, the strong hint into ${b.carried.hinted}, a summary into ${b.carried.summarized}`]),
    // The groups that have items (the result file keeps them all).
    ...[b.byBin, b.byRelation, b.byBinRelation].flatMap((groups) => Object.entries(groups).flatMap(([name, g]) => (g.items === 0 ? [] : [line(name, g)]))),
  ]
}
