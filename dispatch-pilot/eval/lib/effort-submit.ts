// The effort-submit suite: the main agent's effort, decided when the person
// sends a message (#2's feature). An item is the message and the
// conversation before it; the request is built by the decision module the
// mod uses (hooks/decision/), so the eval measures the prompt the mod sends.
//
// Variants (spec #70, guide §6): the effort question written in English or
// in Chinese (the person's words go into the state as they are either way),
// asked as a five-level Score or as a Choice of the five level names.
//
// Pure: no Node API.

import { messageLimits, type Config } from '../../hooks/core/setup.ts'
import { turnStartState, type ContextMessage } from '../../hooks/decision/context.ts'
import { EFFORTS, LEVEL, readEffort, type Effort, type EffortAsk, type EffortReading } from '../../hooks/decision/effort.ts'
import { decideMessage, messageSignals, type MessageDecision, type MessageSignals } from '../../hooks/decision/message-effort.ts'
import { turnStartPart } from '../../hooks/decision/turn-start.ts'
import { countAfter, judgeUnresolved, readUnresolved, type UnresolvedJudgement } from '../../hooks/decision/unresolved.ts'
import { answersFor, mergeParts, type Answer, type DecisionRequest, type Part } from '../../hooks/decision/system-one.ts'
import type { ContextEntry, EffortSubmitItem, Language } from './datasets.ts'
import { requestFailed, variantIn, type Grade, type Suite } from './suite.ts'

/**
 * The variants by name: `<question language>-<primitive>`. The mod asks as
 * `en-score` (`modVariant`: the effort part beside a message is asked as the
 * decision model's table says, core/setup.ts BACKEND_DEFAULTS ask.turnStart).
 */
export const SUBMIT_VARIANTS: Readonly<Record<string, EffortAsk>> = {
  'en-score': { language: 'en', primitive: 'score' },
  'zh-score': { language: 'zh', primitive: 'score' },
  'en-choice': { language: 'en', primitive: 'choice' },
  'zh-choice': { language: 'zh', primitive: 'choice' },
}

/** The variant that asks as the mod asks with the settings' decision model. */
export function modVariant(settings: Pick<Config, 'ask'>): string {
  const { language, primitive } = settings.ask.turnStart
  return `${language}-${primitive}`
}

function variantAsk(variant: string): EffortAsk {
  return variantIn(SUBMIT_VARIANTS, variant)
}

/**
 * An effort scores against an item's levels: right when it is acceptable,
 * exact when it is gold; a wrong one is `under` (below every acceptable
 * level) or `over`. Shared with the other effort suites.
 */
export function gradeEffort(item: { gold: Effort; accept: readonly Effort[] }, effort: Effort): Grade {
  const at = EFFORTS.indexOf(effort)
  const lowest = Math.min(...item.accept.map((level) => EFFORTS.indexOf(level)))
  const correct = item.accept.includes(effort)
  return { correct, exact: effort === item.gold, ...(correct ? {} : { miss: at < lowest ? 'under' : 'over' }) }
}

export const effortSubmit: Suite<EffortSubmitItem, Effort> = {
  name: 'effort-submit',
  variants: Object.keys(SUBMIT_VARIANTS),
  async decide(item, language, variant, ask, settings) {
    const { request, part } = submitRequest(item, language, variantAsk(variant), settings)
    const { asked } = await ask(request)
    if (!asked.ok) return requestFailed(asked.failure)
    const decided = decideMessageEffort(answersFor(part, asked.answers), { text: item[language].message, count: 0, lastTurn: null, maxAfter: settings.unresolved.maxAfter })
    if (decided === null) return { ok: false, failure: 'parse: no effort answer' }
    return { ok: true, prediction: decided.decision.effort, detail: decisionDetail(decided) }
  },
  grade: gradeEffort,
  show: (effort) => effort,
  constants: EFFORTS,
  questions: (variant) => turnStartPart({ ask: variantAsk(variant) }).questions,
}

/** A message's effort decided from its effort part's answers, as the mod decides it (features/main-effort.ts). */
export type MessageEffort = { reading: EffortReading; judged: UnresolvedJudgement | null; count: number; signals: MessageSignals; decision: MessageDecision }

/**
 * The effort of a message from its part's answers (by the part's own ids): the answers move the count as the mod's do
 * (`count` is the count before the message), then decision/message-effort.ts decides. Null without an effort answer.
 */
export function decideMessageEffort(answers: Readonly<Record<string, Answer>>, input: { text: string; count: number; lastTurn: MessageSignals['lastTurn']; maxAfter: number; own?: boolean }): MessageEffort | null {
  const reading = readEffort(answers[LEVEL])
  if (reading === null) return null
  const own = input.own !== false
  const unresolved = own ? readUnresolved(answers) : null
  const judged = unresolved === null ? null : judgeUnresolved(unresolved)
  const count = judged === null ? input.count : countAfter(input.count, judged.change)
  const signals = messageSignals(answers, { own, text: input.text, lastTurn: input.lastTurn, count, maxAfter: input.maxAfter, lock: null })
  return { reading, judged, count, signals, decision: decideMessage(reading, signals) }
}

/** What a result row keeps of a message's decision: the levels' probabilities, the confidence, the Nouls' answers and the rule that lifted the level. */
export function decisionDetail(decided: MessageEffort): Record<string, unknown> {
  const round = (p: number | null) => (p === null ? null : Math.round(p * 1000) / 1000)
  const { signals, judged, decision } = decided
  return {
    p: decided.reading.probabilities.map((p) => Math.round(p * 1000) / 1000),
    confidence: decided.reading.confidence,
    base: decision.steps.find((step) => step.rule === 'two-peaked')?.level ?? null,
    stakes: { undo: round(signals.stakes.undo), live: round(signals.stakes.live), access: round(signals.stakes.access) },
    cause: round(signals.causeUnknown),
    ...(judged === null ? {} : { unresolved: { ...judged.probabilities }, change: judged.change }),
    lifted: decision.lifted,
  }
}

/**
 * The conversation as the mod reads it from `$.session.messages()`: each
 * entry's text and the names of the tools it called (the dataset never holds
 * their input or output, and the mod never sends them).
 */
export function contextMessages(context: readonly ContextEntry[]): ContextMessage[] {
  return context.map((entry) => ({ role: entry.role, text: entry.text, toolUses: (entry.tools ?? []).map((tool) => ({ tool })) }))
}

/**
 * The request the mod sends when the person sends the item's message in `language`: the effort part (ADR 0014: the effort
 * question and its Nouls), asked as `ask` says, in a request of its own (ADR 0005) whose state has the budget of a plain
 * message (`contextByKind.messagePlain`). The items have no summary, count, lasting rules or previous turn.
 */
export function submitRequest(item: EffortSubmitItem, language: Language, ask: EffortAsk, settings: Config): { request: DecisionRequest; part: Part } {
  const asked = item[language]
  const part = turnStartPart({ ask })
  const state = turnStartState({ prompt: asked.message, messages: contextMessages(asked.recent_context), limits: messageLimits(settings, false) })
  return { request: mergeParts(state, [part]), part }
}
