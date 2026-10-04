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
import { turnStartEffortPart, type EffortAsk } from '../../hooks/decision/effort.ts'
import { mergeParts, type DecisionRequest, type Part } from '../../hooks/decision/system-one.ts'
import type { ContextEntry, EffortSubmitItem, Language } from './datasets.ts'

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
