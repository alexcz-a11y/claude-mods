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

import type { Config } from '../../hooks/core/setup.ts'
import { turnStartState, type ContextMessage } from '../../hooks/decision/context.ts'
import { EFFORTS, LEVEL, pickEffort, readEffort, turnStartEffortPart, type Effort, type EffortAsk } from '../../hooks/decision/effort.ts'
import { answersFor, mergeParts, type DecisionRequest, type Part } from '../../hooks/decision/system-one.ts'
import type { ContextEntry, EffortSubmitItem, Language } from './datasets.ts'
import { requestFailed, variantIn, type Grade, type Suite } from './suite.ts'

/**
 * The variants by name: `<question language>-<primitive>`. The mod asks as
 * `zh-score` with Jev and as `en-score` with Clef (`modVariant`: the effort
 * question beside a message is written in the decision model's language,
 * core/setup.ts BACKEND_DEFAULTS turnStartLanguage).
 */
export const SUBMIT_VARIANTS: Readonly<Record<string, EffortAsk>> = {
  'en-score': { language: 'en', primitive: 'score' },
  'zh-score': { language: 'zh', primitive: 'score' },
  'en-choice': { language: 'en', primitive: 'choice' },
  'zh-choice': { language: 'zh', primitive: 'choice' },
}

/** The variant that asks as the mod asks with the settings' decision model. */
export function modVariant(settings: Pick<Config, 'turnStartLanguage'>): string {
  return `${settings.turnStartLanguage}-score`
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
    const reading = readEffort(answersFor(part, asked.answers)[LEVEL])
    if (reading === null) return { ok: false, failure: 'parse: no effort answer' }
    return {
      ok: true,
      prediction: pickEffort(reading, settings.thetaMax),
      detail: { p: reading.probabilities.map((p) => Math.round(p * 1000) / 1000), confidence: reading.confidence },
    }
  },
  grade: gradeEffort,
  show: (effort) => effort,
  constants: EFFORTS,
  questions: (variant) => turnStartEffortPart(variantAsk(variant)).questions,
}

/**
 * The conversation as the mod reads it from `$.session.messages()`: each
 * entry's text and the names of the tools it called (the dataset never holds
 * their input or output, and the mod never sends them).
 */
export function contextMessages(context: readonly ContextEntry[]): ContextMessage[] {
  return context.map((entry) => ({ role: entry.role, text: entry.text, toolUses: (entry.tools ?? []).map((tool) => ({ tool })) }))
}

/** The request the mod sends when the person sends the item's message in `language`: one effort question, asked as `ask` says. */
export function submitRequest(item: EffortSubmitItem, language: Language, ask: EffortAsk, settings: Config): { request: DecisionRequest; part: Part } {
  const asked = item[language]
  const part = turnStartEffortPart(ask)
  const state = turnStartState({ prompt: asked.message, messages: contextMessages(asked.recent_context), limits: settings.context })
  return { request: mergeParts(state, [part]), part }
}
