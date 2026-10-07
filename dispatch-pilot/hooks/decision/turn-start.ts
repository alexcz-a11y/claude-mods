// The part of a message's decision request that is the main agent's effort: the
// effort question, the unresolved-count question beside it, and the fields they
// read beside the conversation (a command turn's command, the problem summary).
// The mod's main-effort feature puts it in the ballot and the eval builds it for
// every item it asks, so the two ask the same thing (ADR 0005).
//
// Pure (see system-one.ts).

import { estimateTokens, turnStartState, type ContextLimits, type ContextMessage } from './context.ts'
import { DEFAULT_ASK, turnStartEffortPart, type EffortAsk } from './effort.ts'
import { renderSummary, SUMMARY_FIELD, type Summary } from './summary.ts'
import { mergeParts, type DecisionRequest, type Part } from './system-one.ts'
import { COUNT_FIELD, givesHint, withHint, withUnresolved } from './unresolved.ts'

/** The state's budget is never cut below this many tokens by what the parts add to it. */
const LEAST_STATE = 100

/**
 * The decision request of a message: the state of `turnStartState` and the parts' questions and fields. What the parts
 * add to the state (a command turn's command, the problem summary) is counted in `limits.tokens`, so the whole state, as
 * it is sent, stays within it: the conversation gives way to those fields, never the message (Clef reads only the head
 * of a long state, with its keys sorted).
 */
export function messageRequest(input: { prompt: string; messages: readonly ContextMessage[]; limits: ContextLimits; parts: readonly Part[] }): DecisionRequest {
  const added = Object.assign({}, ...input.parts.map((part) => part.state ?? {})) as Record<string, unknown>
  const room = Object.keys(added).length === 0 ? input.limits.tokens : Math.max(LEAST_STATE, input.limits.tokens - estimateTokens(JSON.stringify(added)))
  return mergeParts(turnStartState({ prompt: input.prompt, messages: input.messages, limits: { ...input.limits, tokens: room } }), input.parts)
}

export type TurnStartPartInput = {
  /** How the effort question is asked; the unresolved question and the summary are written in its language. */
  ask?: Partial<EffortAsk>
  /** Whether the unresolved question is asked beside the effort question (the person's own message, the switch on). */
  unresolved?: boolean
  /** A command turn's command, as `core/commands.ts` words it: what the command is for. */
  command?: Readonly<Record<string, string>> | null
  /** The problem summary the decision model reads from this message on; none when there is none yet or the switch is off. */
  summary?: Summary | null
  /** How many times the person has said the problem is still unresolved, before this message; the state carries it from the first on. */
  count?: number
  /** The count from which the effort question has the strong hint (`unresolvedMaxAfter`; 0 or none: never). */
  maxAfter?: number
}

/**
 * The effort part, still named `effort` (so that it goes in the effort request with its own 24000-token state): its
 * questions, and the state fields beyond `user_message` and `recent_context` that they read.
 */
export function turnStartPart(input: TurnStartPartInput = {}): Part {
  const ask = { ...DEFAULT_ASK, ...input.ask }
  const part = turnStartEffortPart(ask)
  const count = input.count ?? 0
  const asked = input.unresolved === true ? withUnresolved(part, ask.language) : part
  const questions = givesHint(count, input.maxAfter ?? 0) ? withHint(asked, ask.language) : asked
  const state: Record<string, unknown> = {
    ...(input.command === undefined || input.command === null ? {} : { command: input.command }),
    ...(input.summary === undefined || input.summary === null ? {} : { [SUMMARY_FIELD]: renderSummary(input.summary, ask.language) }),
    ...(count > 0 ? { [COUNT_FIELD]: count } : {}),
  }
  return Object.keys(state).length === 0 ? questions : { ...questions, state }
}
