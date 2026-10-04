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

import type { HttpInit, On } from 'claude-code'
import { messageText } from '../decision/context.ts'
import {
  DEFAULT_AGENT_MODELS,
  decideDispatch,
  dispatchPart,
  dispatchState,
  modelFamily,
  type Dispatch,
  type DispatchDecision,
  type DispatchSettings,
} from '../decision/dispatched-agent.ts'
import { redactSecrets } from '../decision/redact.ts'
import { answersFor, mergeParts } from '../decision/system-one.ts'
import { update, type Cell } from '../core/plans.ts'
import { isPersonsMessage } from '../core/prompts.ts'
import { numberIn, type Ctx } from '../core/setup.ts'
import { failureText, setStatus } from '../core/status.ts'

const AGENTS = { plugin: 'dispatch-pilot', key: 'agents' } as const
const SAID = { plugin: 'dispatch-pilot', key: 'said' } as const

/** At most this many of the person's messages are kept for one turn. */
const MAX_SAID = 8

export function registerDispatchedAgents(on: On, ctx: Ctx): void {
  const settings: DispatchSettings = {
    models: ctx.options.agentFable === true ? [...DEFAULT_AGENT_MODELS, 'fable'] : DEFAULT_AGENT_MODELS,
    ask: ctx.ask,
    thetaOverride: numberIn(ctx.options.agentOverride, 0, 1, 0.6),
    thetaMax: ctx.config.thetaMax,
  }

  // The person's words this turn: a message sent while idle starts them
  // afresh, one typed during the turn joins them. Other prompts (an agent's
  // hand-back, a task notification) leave them as they are.
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
    if (e.fork || e.isTeammate) return next(e)
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
    const who = `agent ${quote(e.description)} (${e.subagentType})`
    const startedAt = await $.clock.now()
    const asked = await ctx.backend.ask(io, request, ctx.config.timeoutMs)
    const ms = (await $.clock.now()) - startedAt
    if (!asked.ok) {
      $.ui.log(`${who}: not routed, ${asked.failure.kind}: ${asked.failure.detail} (${ms} ms)`, { to: 'debug' })
      setStatus('agent', `agent not routed (${failureText(ctx.backend.name, asked.failure)})`, show)
      return next(e)
    }
    const decision = decideDispatch(answersFor(part, asked.answers), dispatch, settings)
    if (!decision.answered) {
      $.ui.log(`${who}: not routed, no answer about the agent in ${JSON.stringify(asked.answers).slice(0, 200)} (${ms} ms)`, { to: 'debug' })
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
      setStatus('agent', statusText(decision, result.model), show)
      const by = asked.model === null ? '' : ` by ${asked.model}`
      $.ui.log(`${who}: ${describeDecision(decision)} [${result.agentId ?? 'no id'}] (${ms} ms${by})`, { to: 'debug' })
    } catch (error) {
      $.ui.log(`${who}: started, but its plan was not recorded: ${String(error)}`, { to: 'debug' })
    }
    return result
  })
}

/** The status line's segment: the model (and effort) the agent went out with, and whose choice the model was. */
function statusText(decision: DispatchDecision, started: string): string {
  const model = decision.model ?? modelFamily(started) ?? started
  const effort = decision.effort === null ? '' : ` ${decision.effort}`
  const note = decision.source === 'user' ? ' (you)' : decision.source === 'requested' ? ' (kept)' : ''
  return `agent ${model}${effort}${note}`
}

/** Why the agent goes out as it does, for the debug log. */
function describeDecision(decision: DispatchDecision): string {
  const why = {
    user: 'named by the person',
    decided: 'decided',
    requested: "the main agent's pick kept",
    none: "the engine's model kept",
  }[decision.source]
  const pick = decision.pick === null ? 'no pick' : `pick ${decision.pick.model}, confidence ${decision.pick.confidence.toFixed(2)}`
  const banned = decision.banned.length > 0 ? `; ruled out ${decision.banned.join(', ')}` : ''
  const effort = decision.effort === null ? '' : ` ${decision.effort}`
  return `${decision.model ?? 'model unchanged'}${effort}, ${why} (${pick}${banned})`
}

/** The start of a text for the debug log, secrets masked. */
function quote(text: string): string {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim()
  return JSON.stringify(flat.length > 40 ? `${flat.slice(0, 40)}...` : flat)
}
