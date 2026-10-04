// The decisions about a Workflow script's agents (#8): the requests the
// decision model answers about its `agent()` calls, how the answers become what
// is written into each call, and what the main agent is told.
//
// One `agent()` call is one dispatched agent for the decision model: the same
// questions as a dispatched agent's (dispatched-agent.ts), so a call is judged
// the way the eval measures an agent. Several calls share one request: each in
// a part of its own (`agent-0`, `agent-1`, ...) reading a state field of its own
// (`brief_0`, `brief_1`, ...), the person's words in one `user_message`.
//
// Pure (see system-one.ts).

import { estimateTokens } from './context.ts'
import {
  decideDispatch,
  dispatchBrief,
  dispatchPart,
  modelFamily,
  type Dispatch,
  type DispatchDecision,
  type DispatchSettings,
} from './dispatched-agent.ts'
import { EFFORTS } from './effort.ts'
import { redactSecrets } from './redact.ts'
import { answersFor, mergeParts, type DecisionRequest, type Part } from './system-one.ts'
import type { AgentCall, CallWrite, ParsedWorkflow } from './workflow-script.ts'

/** The dispatched agent one `agent()` call stands for, in the eval item's shape. */
export function callDispatch(call: AgentCall, meta: ParsedWorkflow['meta'], words: string): Dispatch {
  return {
    user_message: words,
    kind: 'workflow',
    agent_type: call.agentType,
    description: null,
    prompt: call.prompt ?? '',
    requested_model: call.model.kind === 'literal' ? call.model.value : null,
    workflow_description: meta.description,
    label: call.label,
  }
}

/** One decision request, about the calls at `calls` (their indexes in the script). */
export type Batch = { request: DecisionRequest; parts: Part[]; calls: number[] }

/** The part and state field of call `index`: ids in a request are unique across calls. */
function shapeOf(index: number, settings: DispatchSettings): DispatchSettings {
  return { ...settings, part: `agent-${index}`, field: `brief_${index}` }
}

/**
 * The requests that ask about the script's calls.
 * `tokens` is the state's budget (the person's words a third at most, the briefs the rest).
 */
export function workflowBatches(parsed: ParsedWorkflow, words: string, settings: DispatchSettings, tokens: number): Batch[] {
  const calls = parsed.calls.filter((call) => call.prompt !== null)
  if (calls.length === 0) return []
  const user = redactSecrets(words)
  const room = Math.max(150, Math.floor((tokens - Math.min(estimateTokens(user), Math.floor(tokens / 3))) / calls.length))
  const state: Record<string, unknown> = {}
  const parts: Part[] = []
  for (const call of calls) {
    const dispatch = callDispatch(call, parsed.meta, words)
    state[`brief_${call.index}`] = dispatchBrief(dispatch, room)
    parts.push(dispatchPart(dispatch, shapeOf(call.index, settings)))
  }
  state.user_message = user
  return [{ request: mergeParts(state, parts), parts, calls: calls.map((call) => call.index) }]
}

/** What the decision model said about each call of a batch: its decision, in the batch's order. */
export function readBatch(batch: Batch, answers: Readonly<Record<string, unknown>>, parsed: ParsedWorkflow, words: string, settings: DispatchSettings): DispatchDecision[] {
  return batch.calls.map((index, k) => {
    const call = parsed.calls[index] as AgentCall
    return decideDispatch(answersFor(batch.parts[k] as Part, answers), callDispatch(call, parsed.meta, words), shapeOf(index, settings))
  })
}

/** What to write into a call for its decision; null when there is nothing to write. */
export function writeFor(call: AgentCall, decision: DispatchDecision): CallWrite | null {
  if (!decision.answered) return null
  const write: CallWrite = {}
  // The model the script wrote stands when the decision keeps it, or names the same model.
  const written = call.model.kind === 'literal' ? modelFamily(call.model.value) : null
  if (decision.model !== null && decision.source !== 'requested' && decision.model !== written) write.model = decision.model
  // Haiku takes no effort: one the script wrote is taken out.
  if (decision.effort !== null) write.effort = decision.effort
  else if (decision.model === 'haiku') write.effort = null
  return write.model === undefined && write.effort === undefined ? null : write
}

// --- what is said about the decisions ----------------------------------------

/** How a call is named in what the main agent and the person read: its label, else where it is. */
export function callName(call: AgentCall): string {
  return call.label !== null ? JSON.stringify(call.label) : `agent() at line ${call.line}`
}

/** The model and effort a call runs with, as a few words: what was written, else what the script had. */
export function outcomeOf(call: AgentCall, decision: DispatchDecision): string {
  const model = decision.model ?? (call.model.kind === 'literal' ? (modelFamily(call.model.value) ?? call.model.value) : 'the session model')
  return decision.effort === null ? model : `${model} ${decision.effort}`
}

/** Why a call is routed as it is: whose model it is, the decision model's pick, what was ruled out, the effort answer. */
export function reasonOf(decision: DispatchDecision, requested: string | null, thetaOverride: number): string {
  const pick = decision.pick === null ? null : `pick ${decision.pick.model}, confidence ${decision.pick.confidence.toFixed(2)}`
  const parts: string[] = []
  if (decision.source === 'user') parts.push('named in your message')
  else if (decision.source === 'requested') parts.push(`the script's ${requested} kept${decision.pick !== null && decision.pick.model !== requested ? ` (below agentOverride ${thetaOverride.toFixed(2)})` : ''}`)
  else if (decision.source === 'decided') parts.push(requested !== null && requested !== decision.model ? `decided over the script's ${requested}` : 'decided')
  else parts.push("the engine's model kept")
  if (pick !== null) parts.push(pick)
  if (decision.banned.length > 0) parts.push(`ruled out ${decision.banned.join(', ')}`)
  if (decision.reading !== null) parts.push(`effort p ${EFFORTS.map((level, i) => `${level} ${(decision.reading?.probabilities[i] ?? 0).toFixed(2)}`).join(', ')}`)
  return parts.join('; ')
}

/** What the main agent reads after the Workflow tool's result, when its script was rewritten. */
export function rewriteNote(lines: readonly string[]): string {
  return [
    "Dispatch Pilot (the user's routing plugin) chose a model and an effort for each agent() call of this Workflow and wrote them into the script before it ran:",
    ...lines.map((line) => `- ${line}`),
    'The script file named above holds these changes. To change one, edit its model or effort there and run that file with scriptPath.',
  ].join('\n')
}
