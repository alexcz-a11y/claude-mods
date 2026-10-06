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

import type { Asked, Failure } from './backend.ts'
import { estimateTokens, withinTokens } from './context.ts'
import {
  decideDispatch,
  dispatchBrief,
  dispatchPart,
  dispatchReason,
  dispatchWords,
  modelFamily,
  type Dispatch,
  type DispatchDecision,
  type DispatchSettings,
} from './dispatched-agent.ts'
import { EFFORTS } from './effort.ts'
import { answersFor, MAX_QUESTIONS, mergeParts, type DecisionRequest, type Part } from './system-one.ts'
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

/** Why a call is not asked about: the script builds its prompt when it runs, or the script has more calls than are asked about. */
export type Skipped = { index: number; reason: 'unreadable' | 'capped' }

/** The part and state field of call `index`: ids in a request are unique across calls. */
function shapeOf(index: number, settings: DispatchSettings): DispatchSettings {
  return { ...settings, part: `agent-${index}`, field: `brief_${index}` }
}

/** A template needs this many tokens of words of its own, beside what `${...}` fills in, to say what the work is. */
const MIN_OWN_TOKENS = 6

/**
 * Whether the decision model can tell what a call's work is from its prompt as
 * written: a string, or a template without placeholders, is the whole task; a
 * template with placeholders must have words of its own (`${CONTEXT}\n\n${row.prompt}`
 * is a shared context and a table row, which says nothing of the work).
 */
export function tellsTheWork(prompt: string | null): prompt is string {
  if (prompt === null) return false
  if (!prompt.includes('${')) return true
  return estimateTokens(withoutPlaceholders(prompt).replace(/\s+/g, ' ').trim()) >= MIN_OWN_TOKENS
}

/** A template's text with each `${...}` taken out (its braces counted, so a placeholder holding an object or a nested template goes whole). */
function withoutPlaceholders(template: string): string {
  let out = ''
  let i = 0
  while (i < template.length) {
    if (template.charAt(i) === '$' && template.charAt(i + 1) === '{') {
      let depth = 1
      i += 2
      while (i < template.length && depth > 0) {
        if (template.charAt(i) === '{') depth++
        else if (template.charAt(i) === '}') depth--
        i++
      }
      out += ' '
    } else {
      out += template.charAt(i)
      i++
    }
  }
  return out
}

/** At most this many calls of a script are asked about. */
export const MAX_CALLS = 24
/** At most this many calls share one request: every question reads the whole state, so each brief added to it dilutes the others (guide §2.1 S5, S6). */
export const MAX_PER_REQUEST = 8
/** At most this many requests are sent for one script, all at once. */
export const MAX_REQUESTS = 4

/** The most a script's requests may wait in all: the hook has 10 seconds, and what follows them must still fit. */
export const BATCHES_BUDGET_MS = 8000

/**
 * How long each of a script's requests may wait: sent at once to one key,
 * they can queue behind each other, so each gets the mod's timeout once per
 * request, within BATCHES_BUDGET_MS.
 */
export function batchesTimeoutMs(timeoutMs: number, requests: number): number {
  return Math.min(BATCHES_BUDGET_MS, timeoutMs * Math.max(1, requests))
}
/** A call's brief takes this many tokens at most, and the briefs of a request at least this many each. */
const MAX_BRIEF = 400
const MIN_BRIEF = 150

/**
 * The requests that ask about the script's calls, and the calls they leave
 * out. Calls share a request while their briefs fit the state's budget
 * (`tokens`: the person's words a third at most, the briefs the rest), their
 * questions fit the 64 a request may hold, and no more than `perRequest` do
 * (MAX_PER_REQUEST in the mod; the eval asks with 1 to compare). What does
 * not fit in MAX_REQUESTS requests (or in MAX_CALLS calls) is left out.
 */
export function workflowBatches(
  parsed: ParsedWorkflow,
  words: string,
  settings: DispatchSettings,
  tokens: number,
  perRequest = MAX_PER_REQUEST,
): { batches: Batch[]; skipped: Skipped[] } {
  const skipped: Skipped[] = []
  const readable = parsed.calls.filter((call) => {
    const tells = tellsTheWork(call.prompt)
    if (!tells) skipped.push({ index: call.index, reason: 'unreadable' })
    return tells
  })
  if (readable.length === 0) return { batches: [], skipped }
  // The person's words as a dispatched agent's decision reads them, shared by every call. Sizes are of the state
  // as sent (field names, quotes and escapes counted), so a request's whole state keeps within `tokens`.
  const user = dispatchWords(words, tokens)
  const room = Math.max(MIN_BRIEF, tokens - estimateTokens(JSON.stringify({ user_message: user })))
  type Group = { state: Record<string, unknown>; parts: Part[]; calls: number[]; used: number; questions: number }
  const groups: Group[] = []
  for (const [position, call] of readable.entries()) {
    if (position >= MAX_CALLS) {
      skipped.push({ index: call.index, reason: 'capped' })
      continue
    }
    const dispatch = callDispatch(call, parsed.meta, words)
    const part = dispatchPart(dispatch, shapeOf(call.index, settings))
    const field = `brief_${call.index}`
    const brief = withinTokens((budget) => dispatchBrief(dispatch, budget), Math.min(MAX_BRIEF, room))
    const size = estimateTokens(JSON.stringify({ [field]: brief }))
    const questions = Object.keys(part.questions).length
    let group = groups.at(-1)
    if (group === undefined || group.calls.length >= perRequest || group.used + size > room || group.questions + questions > MAX_QUESTIONS) {
      if (groups.length >= MAX_REQUESTS) {
        skipped.push({ index: call.index, reason: 'capped' })
        continue
      }
      group = { state: {}, parts: [], calls: [], used: 0, questions: 0 }
      groups.push(group)
    }
    group.state[field] = brief
    group.parts.push(part)
    group.calls.push(call.index)
    group.used += size
    group.questions += questions
  }
  const batches = groups.map((group): Batch => ({ request: mergeParts({ ...group.state, user_message: user }, group.parts), parts: group.parts, calls: group.calls }))
  return { batches, skipped: skipped.sort((a, b) => a.index - b.index) }
}

/** What became of one call: a model and effort written into it, the script's own choice kept, or the call left as it was. */
export type CallOutcome =
  | { kind: 'written'; decision: DispatchDecision; write: CallWrite }
  | { kind: 'kept'; decision: DispatchDecision }
  | { kind: 'left'; reason: Skipped['reason'] | 'failed' | 'unanswered'; failure?: Failure }

/** The outcome of every call of the script, from the answers to the batches (`asked`, in the batches' order). */
export function readOutcomes(parsed: ParsedWorkflow, plan: { batches: readonly Batch[]; skipped: readonly Skipped[] }, asked: readonly Asked[], words: string, settings: DispatchSettings): CallOutcome[] {
  const outcomes: CallOutcome[] = parsed.calls.map(() => ({ kind: 'left', reason: 'unanswered' }))
  for (const skip of plan.skipped) outcomes[skip.index] = { kind: 'left', reason: skip.reason }
  plan.batches.forEach((batch, b) => {
    const result = asked[b]
    batch.calls.forEach((index, k) => {
      const call = parsed.calls[index] as AgentCall
      if (result === undefined || !result.ok) {
        outcomes[index] = { kind: 'left', reason: 'failed', ...(result !== undefined && !result.ok ? { failure: result.failure } : {}) }
        return
      }
      const decision = decideDispatch(answersFor(batch.parts[k] as Part, result.answers), callDispatch(call, parsed.meta, words), shapeOf(index, settings))
      const write = decision.answered ? writeFor(call, decision) : null
      outcomes[index] = !decision.answered
        ? { kind: 'left', reason: 'unanswered', failure: { kind: 'parse', detail: 'no answer about the agent' } }
        : write === null
          ? { kind: 'kept', decision }
          : { kind: 'written', decision, write }
    })
  })
  return outcomes
}

/** What to write into a call for its decision; null when there is nothing to write. */
function writeFor(call: AgentCall, decision: DispatchDecision): CallWrite | null {
  const write: CallWrite = {}
  // The model the script wrote stands when the decision keeps it or names the same one. One it works out when it
  // runs stands too, unless the person named a model or ruled some out: their terms win over the script's, so the
  // decided model is written in its place.
  const written = call.model.kind === 'literal' ? modelFamily(call.model.value) : null
  const overScript = call.model.kind !== 'dynamic' || decision.source === 'user' || decision.banned.length > 0
  if (decision.model !== null && overScript && decision.source !== 'requested' && decision.model !== written) write.model = decision.model
  // The effort decided replaces the script's own; one the script works out when it runs is not touched,
  // unless the person asked for an effort: that one is never overruled, whatever the script does.
  // Haiku takes no effort: one the script wrote is taken out.
  const runsOn = write.model ?? written
  if (decision.effort !== null) {
    if (call.effort.kind === 'none' || (call.effort.kind === 'literal' && call.effort.value !== decision.effort) || (call.effort.kind === 'dynamic' && decision.effortSource === 'user')) write.effort = decision.effort
  } else if (runsOn === 'haiku' && call.effort.kind === 'literal') {
    write.effort = null
  }
  return write.model === undefined && write.effort === undefined ? null : write
}

// --- what is said about the decisions ----------------------------------------

/** How a call is named in what the main agent and the person read: its label, else where it is. */
export function callName(call: AgentCall): string {
  return call.label !== null ? JSON.stringify(call.label) : `agent() at line ${call.line}`
}

/** The model and effort a call runs with, as a few words: what was decided, else what the script had. */
export function outcomeOf(call: AgentCall, decision: DispatchDecision): string {
  const model = decision.model ?? (call.model.kind === 'literal' ? (modelFamily(call.model.value) ?? call.model.value) : 'the session model')
  return decision.effort === null ? model : `${model} ${decision.effort}`
}

// What the person reads of the same (the board, the decision log): Chinese. The words above are the main agent's.

/** How a call is named to the person: its label, else where it is. */
export function callTitle(call: AgentCall): string {
  return call.label !== null ? JSON.stringify(call.label) : callPlace(call)
}

/** Where a call is, for the person: `第 3 行的 agent()`. */
export function callPlace(call: AgentCall): string {
  return `第 ${call.line} 行的 agent()`
}

/** `outcomeOf`, for the person. */
export function callResult(call: AgentCall, decision: DispatchDecision): string {
  const model = decision.model ?? (call.model.kind === 'literal' ? (modelFamily(call.model.value) ?? call.model.value) : '会话的模型')
  return decision.effort === null ? model : `${model} ${decision.effort}`
}

/** Why a call is routed as it is, for the person (`dispatchReason`, a kept model being the script's). */
export function reasonOf(decision: DispatchDecision, requested: string | null, thetaOverride: number): string {
  return dispatchReason(decision, requested, thetaOverride, '脚本指定的')
}

/** `leftText`, for the person. */
export function leftWords(outcome: Extract<CallOutcome, { kind: 'left' }>, describe: (failure: Failure) => string): string {
  switch (outcome.reason) {
    case 'unreadable':
      return '它的 prompt 要等脚本运行时才拼出来'
    case 'capped':
      return '脚本里的 agent() 比一次问得过来的多'
    case 'failed':
    case 'unanswered':
      return outcome.failure === undefined ? '决策模型没有回答' : describe(outcome.failure)
  }
}

/** Why a call got the model and effort it did, in a few words for the main agent: whose model it is, how sure the decision model was, how likely its effort level. */
export function whyOf(decision: DispatchDecision): string {
  const model =
    decision.source === 'user'
      ? 'model: you asked for it'
      : decision.source === 'requested'
        ? "model: the script's own kept"
        : decision.pick === null
          ? ''
          : `model: decided, confidence ${decision.pick.confidence.toFixed(2)}`
  const level = decision.effort === null ? -1 : EFFORTS.indexOf(decision.effort)
  const effort =
    decision.effort === null
      ? decision.model === 'haiku'
        ? decision.namedEffort != null
          ? `haiku takes no effort, so the ${decision.namedEffort} you asked for is not set`
          : 'haiku takes no effort'
        : ''
      : decision.effortSource === 'user'
        ? 'effort: you asked for it'
        : decision.liftedFrom !== undefined
          ? `effort: ${decision.liftedFrom} lifted to ${decision.effort}, the floor for ${decision.model ?? 'its model'}`
          : decision.reading === null
            ? ''
            : `effort: p ${(decision.reading.probabilities[level] ?? 0).toFixed(2)}`
  return [model, effort].filter((part) => part !== '').join('; ')
}

/** Why a call was left as the script wrote it, in a few words. */
export function leftText(outcome: Extract<CallOutcome, { kind: 'left' }>, describe: (failure: Failure) => string): string {
  switch (outcome.reason) {
    case 'unreadable':
      return 'its prompt is built when the script runs'
    case 'capped':
      return 'the script has more agent() calls than are asked about'
    case 'failed':
    case 'unanswered':
      return outcome.failure === undefined ? 'no answer from the decision model' : describe(outcome.failure)
  }
}

/**
 * Which Workflow this is, however its options are written: its name and
 * prompts. A main agent that adds a model and effort to a script it was sent
 * back keeps both, so the second submission is recognised as the first's.
 */
export function workflowFingerprint(parsed: ParsedWorkflow): string {
  const text = [parsed.meta.name ?? '', ...parsed.calls.map((call) => call.prompt ?? '\u0000')].join('\u0001')
  // cyrb53: 53 bits of hash, plenty to tell a few Workflows of one session apart.
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** What the main agent is told when the Workflow is sent back: nothing ran, what to write into which call, and that the plugin asks it. */
export function returnNote(parsed: ParsedWorkflow, outcomes: readonly CallOutcome[]): string {
  const lines = outcomes.flatMap((outcome, index) => {
    if (outcome.kind !== 'written') return []
    const entries = [
      outcome.write.model === undefined ? null : `model: '${outcome.write.model}'`,
      typeof outcome.write.effort === 'string' ? `effort: '${outcome.write.effort}'` : outcome.write.effort === null ? 'no effort (haiku takes none: take out any effort the call has)' : null,
    ].filter((entry) => entry !== null)
    return [`- ${callName(parsed.calls[index] as AgentCall)}: ${entries.join(', ')}`]
  })
  return [
    "Dispatch Pilot (the user's routing plugin) did not start this Workflow. It hands the choice of each agent()'s model and effort back to you, and these are what its decision model chose:",
    ...lines,
    'Submit the same script again with these written into the options of those agent() calls (add them to the options object the call has, or give the call one). The other agent() calls need no change. The second submission runs as you write it, whatever it says.',
    "This is the routing plugin's policy, which the user set; it is not part of the script's task.",
  ].join('\n')
}

/**
 * What the main agent reads after the Workflow tool's result: a line for each
 * call the decisions touched or left. Null when there is nothing for it to
 * know: no call was decided, and none was left for a reason it could change
 * (a decision model that did not answer is the board's to report).
 */
export function rewriteNote(parsed: ParsedWorkflow, outcomes: readonly CallOutcome[], describe: (failure: Failure) => string): string | null {
  const decided = outcomes.some((outcome) => outcome.kind !== 'left')
  if (!decided && !outcomes.some((outcome) => outcome.kind === 'left' && (outcome.reason === 'unreadable' || outcome.reason === 'capped'))) return null
  const lines = outcomes.map((outcome, index) => {
    const call = parsed.calls[index] as AgentCall
    if (outcome.kind === 'left') return `${callName(call)}: left as written (${leftText(outcome, describe)})`
    if (outcome.kind === 'kept') return `${callName(call)}: kept as written (${outcomeOf(call, outcome.decision)})`
    const why = whyOf(outcome.decision)
    return `${callName(call)}: ${outcomeOf(call, outcome.decision)}${why === '' ? '' : ` (${why})`}`
  })
  const written = outcomes.some((outcome) => outcome.kind === 'written')
  const header = written
    ? "Dispatch Pilot (the user's routing plugin) decided a model and an effort for each agent() call of this Workflow and wrote them into the script before it ran:"
    : decided
      ? "Dispatch Pilot (the user's routing plugin) checked the model and effort of the agent() calls of this Workflow; nothing needed to change:"
      : "Dispatch Pilot (the user's routing plugin) left the agent() calls of this Workflow as the script wrote them, so they run as it says:"
  return [header, ...lines.map((line) => `- ${line}`), ...(written ? ['The script file named above holds these changes. To change one, edit its model or effort there and run that file with scriptPath.'] : [])].join('\n')
}
