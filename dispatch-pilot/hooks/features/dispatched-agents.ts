// Feature: each agent the main agent dispatches gets its own decision on its
// model and effort, once, when it is spawned (agent.spawn). The model is
// rewritten on the spawn; the effort goes into the plan table under the
// agent's id, and the core's turn.step writer sends it on every step of that
// agent. The main agent's own model and cache are untouched (ADR 0001).
//
// The decision reads the person's own words this turn (`said`), so a model
// they name for the work wins over the decision model, which wins over the
// main agent's pick. Agents dispatched together (one message, several Agent
// calls) each get their own request and start as soon as their own answer is
// in. A failed or late answer lets the agent start as the main agent asked.
//
// Its switch is `dispatched-agents` (`/dp dispatched-agents off`).

import type { HttpInit, On } from 'claude-code'
import type { Asked } from '../decision/backend.ts'
import { messageText } from '../decision/context.ts'
import {
  DEFAULT_AGENT_MODELS,
  decideDispatch,
  decisionNotes,
  dispatchPart,
  dispatchState,
  modelFamily,
  type Dispatch,
  type DispatchDecision,
  type DispatchSettings,
} from '../decision/dispatched-agent.ts'
import { EFFORTS } from '../decision/effort.ts'
import { redactSecrets } from '../decision/redact.ts'
import { answersFor, mergeParts } from '../decision/system-one.ts'
import { recordDecision } from '../core/decisions.ts'
import { update, type Cell } from '../core/plans.ts'
import { isPersonsMessage } from '../core/prompts.ts'
import { numberIn, type Ctx } from '../core/setup.ts'
import { failureText, setStatus } from '../core/status.ts'
import { defineSwitch, isOn } from '../core/switches.ts'

const AGENTS = { plugin: 'dispatch-pilot', key: 'agents' } as const
const SAID = { plugin: 'dispatch-pilot', key: 'said' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

/** The switch's name, in `/dp` and in the decision log. */
const SWITCH = 'dispatched-agents'
/** At most this many of the person's messages are kept for one turn. */
const MAX_SAID = 8

export function registerDispatchedAgents(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: "decides each dispatched agent's model and effort when it is spawned", segments: ['agent'] })
  const settings: DispatchSettings = {
    models: ctx.options.agentFable === true ? [...DEFAULT_AGENT_MODELS, 'fable'] : DEFAULT_AGENT_MODELS,
    ask: ctx.ask,
    thetaOverride: numberIn(ctx.options.agentOverride, 0, 1, 0.6),
    thetaMax: ctx.config.thetaMax,
  }

  // The person's words this turn: a message sent while idle starts them
  // afresh, one typed during the turn joins them. Other prompts (an agent's
  // hand-back, a task notification) leave them as they are. Kept whatever the
  // switches say (nothing is asked or changed here), so a decision made right
  // after the person switches the feature back on still reads them.
  on('prompt.submit', { text: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    if (!isPersonsMessage(e) || result.drop !== undefined) return result
    const words = messageText(e.text, ctx.config.context.tokens)
    const said: Cell<string[]> = { get: () => $.state.get(SAID), set: (value, options) => $.state.set(SAID, value, options) }
    await update(said, (list) => (e.turnId === undefined ? [words] : [...(list ?? []), words].slice(-MAX_SAID)))
    return result
  })

  on('agent.spawn', { tool_use_id: /(?:)/ }, async ($, e, next) => {
    // A fork always runs on its parent's model. A teammate lives across many
    // tasks that one decision at its spawn cannot see.
    if (e.fork || e.isTeammate || !isOn(SWITCH)) return next(e)
    const { value: said = [] } = await $.state.get(SAID)
    const dispatch: Dispatch = {
      user_message: said.join('\n'),
      agent_type: e.subagentType,
      description: e.description,
      prompt: e.prompt,
      requested_model: e.model ?? null,
    }
    const part = dispatchPart(dispatch, settings)
    const request = mergeParts(dispatchState(dispatch, ctx.config.context.tokens), [part])
    const io = {
      fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
      sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
    }
    const show = (line: string | undefined) => $.ui.status(line)
    const about = `${quote(e.description)} (${e.subagentType})`
    const startedAt = await $.clock.now()
    const asked = await ctx.backend.ask(io, request, ctx.config.timeoutMs)
    const ms = (await $.clock.now()) - startedAt
    $.ui.log(`request [${Object.keys(request.questions).join(', ')}] to ${ctx.backend.name} for agent ${about}: ${describeAsked(asked, ms)}`, { to: 'debug' })
    if (!asked.ok) {
      setStatus('agent', `agent not routed (${failureText(ctx.backend.name, asked.failure)})`, show)
      return next(e)
    }
    const decision = decideDispatch(answersFor(part, asked.answers), dispatch, settings)
    if (!decision.answered) {
      setStatus('agent', `agent not routed (${failureText(ctx.backend.name, { kind: 'parse', detail: 'no answer about the agent' })})`, show)
      return next(e)
    }
    // The main agent's pick, when it stands, goes on as the main agent wrote it.
    const spawn = decision.model !== null && decision.model !== modelFamily(e.model) ? { ...e, model: decision.model } : e
    const result = await next(spawn)
    if (result.deny !== undefined) return result
    // The agent has started: nothing after this may fail its spawn.
    try {
      // Only the effort goes into the plan: the model is set on the spawn,
      // and a planned model would also pin every step against the engine's
      // overload fallback.
      if (result.agentId !== undefined && decision.effort !== null) {
        await $.state.set({ ...AGENTS, id: result.agentId }, { effort: decision.effort, floor: null, model: null })
      }
      const model = decision.model ?? modelFamily(result.model) ?? result.model
      const outcome = decision.effort === null ? model : `${model} ${decision.effort}`
      // Whose choice it is: the model's, when the person's or the main agent's; else the effort's, when the person's.
      const whose = decision.source === 'user' ? ' (you)' : decision.source === 'requested' ? ' (kept)' : decision.effortSource === 'user' ? ' (effort: you)' : ''
      setStatus('agent', `agent ${outcome}${whose}`, show)
      await recordDecision(
        { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
        (line) => $.ui.log(line, { to: 'debug' }),
        { feature: SWITCH, outcome, about, reason: reasonOf(decision, modelFamily(e.model), settings.thetaOverride) },
      )
    } catch (error) {
      $.ui.log(`agent ${about} started (${result.agentId ?? 'no id'}), but its plan was not recorded: ${String(error)}`, { to: 'debug' })
    }
    return result
  })
}

/** A request's outcome for the debug log. */
function describeAsked(asked: Asked, ms: number): string {
  if (!asked.ok) return `${asked.failure.kind}: ${asked.failure.detail} (${ms} ms)`
  const by = asked.model === null ? '' : ` by ${asked.model}`
  const tokens = asked.inputTokens === null ? '' : ` (${asked.inputTokens} input tokens)`
  return `answered in ${ms} ms${by}${tokens}`
}

/** Why the agent goes out as it does: whose model it is, the decision model's pick, what was ruled out, the effort answer. */
function reasonOf(decision: DispatchDecision, requested: string | null, thetaOverride: number): string {
  const pick = decision.pick === null ? null : `pick ${decision.pick.model}, confidence ${decision.pick.confidence.toFixed(2)}`
  const parts: string[] = []
  if (decision.source === 'user') parts.push('named in your message')
  else if (decision.source === 'requested') parts.push(`the main agent's ${requested} kept${decision.pick !== null && decision.pick.model !== requested ? ` (below agentOverride ${thetaOverride.toFixed(2)})` : ''}`)
  else if (decision.source === 'decided') parts.push(requested !== null && requested !== decision.model ? `decided over the main agent's ${requested}` : 'decided')
  else parts.push("the engine's model kept")
  if (pick !== null) parts.push(pick)
  parts.push(...decisionNotes(decision))
  if (decision.reading !== null) parts.push(`effort p ${EFFORTS.map((level, i) => `${level} ${(decision.reading?.probabilities[i] ?? 0).toFixed(2)}`).join(', ')}`)
  return parts.join('; ')
}

/** The start of a text for the debug log, secrets masked. */
function quote(text: string): string {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim()
  return JSON.stringify(flat.length > 40 ? `${flat.slice(0, 40)}...` : flat)
}
