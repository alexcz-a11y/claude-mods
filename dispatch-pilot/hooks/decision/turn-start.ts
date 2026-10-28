// The main agent's effort part of a message's decision request (ADR 0014): its questions, and the fields they read beside
// the conversation. The mod's main-effort feature puts it in the ballot and the eval builds it for every item it asks, so
// the two ask the same thing (ADR 0005).
//
//   effort.level                        how much step-by-step reasoning the work needs (a Score)
//   effort.stakes.undo / live / access  the stakes of a mistake (Nouls)
//   effort.cause_unknown                a failure whose cause is still to be found (a Noul)
//   effort.still_failing / solved / new_task   what the person says of the problem they are on (Nouls; their own message only)
//   effort.constraint                   whether the person sets a lasting rule (a Noul; their own message only)
//   effort.confirm / escalate           whether the person only goes on with what was offered, or asks for more thought
//                                       (Nouls; their own message only; ADR 0016)
//
// A field goes in the state only when it has something in it (TypeSafe: an empty list reads as a signal).
//
// Pure (see system-one.ts).

import { askQuestions } from './asks.ts'
import { referenceField, type ReferenceReading } from './complexity.ts'
import { CONSTRAINT, CONSTRAINTS_FIELD, constraintQuestion, type StandingConstraint } from './constraints.ts'
import { estimateTokens, turnStartState, type ContextLimits, type ContextMessage } from './context.ts'
import { DEFAULT_ASK, turnStartEffortPart, type Effort, type EffortAsk } from './effort.ts'
import type { TurnFacts } from './escalation.ts'
import { summaryState, SUMMARY_FIELD, type Summary } from './summary.ts'
import { mergeParts, type DecisionRequest, type Part } from './system-one.ts'
import { COUNT_FIELD, withUnresolved } from './unresolved.ts'

/** The state's budget is never cut below this many tokens by what the parts add to it. */
const LEAST_STATE = 100

/** The field the facts of the person's previous turn take, when it had failures. */
export const LAST_TURN_FIELD = 'last_turn'

/** The person's previous turn as a request's state carries it: named fields, facts the code counted (TypeSafe: state the facts your code already knows). */
export type LastTurnState = {
  effort: Effort | null
  tool_calls: number
  failed_calls: number
  hook_blocked_calls: number
  reached_escalate_after: boolean
  last_errors: string[]
}

/** What the state says of the previous turn: null when it had no failed or blocked call (nothing to say, so the field is left out). */
export function lastTurnState(facts: TurnFacts | null | undefined): LastTurnState | null {
  if (facts === null || facts === undefined || facts.failed + facts.blocked === 0) return null
  return { effort: facts.effort, tool_calls: facts.calls, failed_calls: facts.failed, hook_blocked_calls: facts.blocked, reached_escalate_after: facts.stuck, last_errors: [...facts.errors] }
}

/**
 * The decision request of a message: the state of `turnStartState` and the parts' questions and fields. What the parts
 * add to the state is counted in `limits.tokens`, so the whole state, as it is sent, stays within it: the conversation gives
 * way to those fields, never the message.
 */
export function messageRequest(input: { prompt: string; messages: readonly ContextMessage[]; limits: ContextLimits; parts: readonly Part[] }): DecisionRequest {
  const added = Object.assign({}, ...input.parts.map((part) => part.state ?? {})) as Record<string, unknown>
  const room = Object.keys(added).length === 0 ? input.limits.tokens : Math.max(LEAST_STATE, input.limits.tokens - estimateTokens(JSON.stringify(added)))
  return mergeParts(turnStartState({ prompt: input.prompt, messages: input.messages, limits: { ...input.limits, tokens: room } }), input.parts)
}

export type TurnStartPartInput = {
  /** How the questions are asked (all in the same language). */
  ask?: Partial<EffortAsk>
  /**
   * `own` (the default): the person's own message, a command they typed, or one typed into a running turn: every question.
   * `report`: a turn a report started (an agent's hand-back, a task's notice): no word of the person's, so only the effort
   * question, the stakes and the unknown cause (no unresolved questions, no lasting rule, no confirm or escalate).
   */
  kind?: 'own' | 'report'
  /** A command turn's command, as `core/commands.ts` words it: what the command is for. */
  command?: Readonly<Record<string, string>> | null
  /** The problem summary, when there is one and its switch is on. */
  summary?: Summary | null
  /** The unresolved count before this message; the state carries it from the first on. */
  count?: number
  /** What the reference images the message came with read as (#63): a field of the state, a hint for the effort question. */
  reference?: ReferenceReading | null
  /** What the turn of the person's previous message did (features/escalation.ts): in the state when it had failures. */
  lastTurn?: TurnFacts | null
  /** The person's lasting rules kept so far: in the state when there is any. */
  constraints?: readonly StandingConstraint[]
}

/**
 * The effort part, named `effort` (so that it goes in the effort request, which has a state budget of its own,
 * `contextByKind.messagePlain`): its questions, and the state fields beyond `user_message` and `recent_context` they read.
 */
export function turnStartPart(input: TurnStartPartInput = {}): Part {
  const ask = { ...DEFAULT_ASK, ...input.ask }
  const own = input.kind !== 'report'
  const lastTurn = lastTurnState(input.lastTurn)
  const constraints = own ? (input.constraints ?? []) : []
  const count = own ? (input.count ?? 0) : 0
  const effort = turnStartEffortPart(ask, { has: { constraints: constraints.length > 0, lastTurn: lastTurn !== null } })
  const questions = own ? { ...withUnresolved(effort, ask.language).questions, [CONSTRAINT]: constraintQuestion(ask.language), ...askQuestions(ask.language) } : effort.questions
  const state: Record<string, unknown> = {
    ...(input.command === undefined || input.command === null ? {} : { command: input.command }),
    ...(input.summary === undefined || input.summary === null || !own ? {} : { [SUMMARY_FIELD]: summaryState(input.summary) }),
    ...(count > 0 ? { [COUNT_FIELD]: count } : {}),
    ...(lastTurn === null ? {} : { [LAST_TURN_FIELD]: lastTurn }),
    ...(constraints.length === 0 ? {} : { [CONSTRAINTS_FIELD]: constraints.map((one) => ({ ...one })) }),
    ...referenceField(input.reference),
  }
  return Object.keys(state).length === 0 ? { part: effort.part, questions } : { part: effort.part, questions, state }
}
