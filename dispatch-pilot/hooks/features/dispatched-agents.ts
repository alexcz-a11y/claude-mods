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
// The main agent reads, after the Agent tool's result, the model and effort its
// agent started with and whose choice the model was (#34): agent.spawn runs
// inside the Agent tool call, under its id, so the spawn leaves the note for the
// call to append.
//
// Its switch is `dispatched-agents` (`/dp dispatched-agents off`).

import type { HttpInit, On } from 'claude-code'
import { describeAsked, type BackendIo, type Failure } from '../decision/backend.ts'
import { messageText } from '../decision/context.ts'
import { decideDispatch, dispatchEvidence, dispatchNote, dispatchPart, dispatchReason, dispatchState, modelFamily, termsOf, type Dispatch, type DispatchNote } from '../decision/dispatched-agent.ts'
import { quoteStart } from '../decision/redact.ts'
import { renderSummary } from '../decision/summary.ts'
import { answersFor, mergeParts } from '../decision/system-one.ts'
import { update, type Cell } from '../core/plans.ts'
import { isPersonsMessage } from '../core/prompts.ts'
import { report, type ReportIo } from '../core/report.ts'
import { dispatchSettings, type Ctx } from '../core/setup.ts'
import { defineSwitch, isOn } from '../core/switches.ts'
import { UNRESOLVED_SWITCH } from './unresolved.ts'

const AGENTS = { plugin: 'dispatch-pilot', key: 'agents' } as const
const SAID = { plugin: 'dispatch-pilot', key: 'said' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
const COUNT = { plugin: 'dispatch-pilot', key: 'unresolved' } as const
const PPLX_RATE = { plugin: 'dispatch-pilot', key: 'pplxRate' } as const

/** The switch's name, in `/dp` and in the decision log. */
const SWITCH = 'dispatched-agents'
/**
 * The notes spawns left for their Agent tool calls, by the call's tool_use_id: written by the agent.spawn inside the
 * call, taken as the call returns. A module variable (CLAUDE.md): the kit's `$.state` does not show the outer hook
 * what the nested spawn wrote (DEVELOPMENT.md 已实测, not yet measured on the engine), and a hot reload while an
 * agent runs loses only that agent's note. At most MAX_NOTES are kept: past that (calls whose result never came
 * back, or more agents running at once) the oldest go.
 */
const pendingNotes = new Map<string, string>()
const MAX_NOTES = 32
/** At most this many of the person's messages are kept for one turn. */
const MAX_SAID = 8

export function registerDispatchedAgents(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: '主 agent 派出 agent 时决定它的模型和 effort' })
  const settings = dispatchSettings(ctx)

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

  // The note the spawn left for its Agent tool call goes beside the tool's result; a call whose spawn left none (a fork,
  // a teammate, a refused spawn) is answered as it is.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const result = await next(e)
    const note = pendingNotes.get(e.tool_use_id)
    pendingNotes.delete(e.tool_use_id)
    if (note === undefined || result.deny !== undefined) return result
    return { ...result, context: [...(result.context ?? []), note] }
  })

  on('agent.spawn', { tool_use_id: /(?:)/ }, async ($, e, next) => {
    // A fork always runs on its parent's model. A teammate lives across many
    // tasks that one decision at its spawn cannot see.
    if (e.fork || e.isTeammate) return next(e)
    /** Leaves the note for the Agent tool call this spawn belongs to. */
    const leaveNote = (note: DispatchNote) => {
      pendingNotes.set(e.tool_use_id, dispatchNote(note))
      while (pendingNotes.size > MAX_NOTES) pendingNotes.delete(pendingNotes.keys().next().value as string)
    }
    if (!isOn(SWITCH)) {
      const started = await next(e)
      if (started.deny === undefined) leaveNote({ routed: false, started: started.model, why: 'off' })
      return started
    }
    const { value: said = [] } = await $.state.get(SAID)
    // The problem the main agent is on goes along as background, with no hint (#41): the summary and the count, while the
    // unresolved switch is on and there are any.
    const { value: held } = isOn(UNRESOLVED_SWITCH) ? await $.state.get(COUNT) : { value: undefined }
    const dispatch: Dispatch = {
      user_message: said.join('\n'),
      agent_type: e.subagentType,
      description: e.description,
      prompt: e.prompt,
      requested_model: e.model ?? null,
      ...(held?.summary === undefined ? {} : { problem_summary: renderSummary(held.summary, ctx.ask.language) }),
      ...(held === undefined || held.count === 0 ? {} : { unresolved_count: held.count }),
    }
    const part = dispatchPart(dispatch, settings)
    const request = mergeParts(dispatchState(dispatch, ctx.config.contextByKind.agent), [part])
    const io: BackendIo = {
      fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
      sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
      pace: { now: () => $.clock.now(), sentAt: { get: () => $.state.get(PPLX_RATE), set: (value, options) => $.state.set(PPLX_RATE, value, options) } },
    }
    const reporting: ReportIo = {
      board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
      decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
      debug: (line) => $.ui.log(line, { to: 'debug' }),
      now: () => $.clock.now(),
      toast: (text) => $.ui.toast(text),
    }
    const about = `${quoteStart(e.description)}（${e.subagentType}）`
    /** What every report of this agent says of it; its id is known once it has started (a spawn is not yet an agent). */
    const reportOf = (agent: string) => ({ feature: SWITCH, agent, subject: about, node: { kind: 'agent' as const, name: e.name ?? (e.description === '' ? e.subagentType : e.description), type: e.subagentType } })
    const startedAt = await $.clock.now()
    const asked = await ctx.backend.ask(io, request, ctx.config.timeoutMs)
    const ms = (await $.clock.now()) - startedAt
    $.ui.log(`request [${Object.keys(request.questions).join(', ')}] to ${ctx.backend.name} for agent ${about}: ${describeAsked(asked, ms)}`, { to: 'debug' })
    // The agent starts as the main agent asked; the board says why it was not routed, once it has an id to say it of.
    // A spawn refused beneath started no agent: there is nothing to say of it.
    const notRouted = async (failure: Failure) => {
      const started = await next(e)
      if (started.deny !== undefined) return started
      await report(reporting, { decision: { ...reportOf(started.agentId ?? e.tool_use_id), routed: false, failure: { backend: ctx.backend.name, ...failure } } })
      leaveNote({ routed: false, started: started.model, why: { failure, backend: ctx.backend.name } })
      return started
    }
    if (!asked.ok) return notRouted(asked.failure)
    const decision = decideDispatch(answersFor(part, asked.answers), dispatch, settings)
    if (!decision.answered) return notRouted({ kind: 'parse', detail: 'no answer about the agent' })
    // The main agent's pick, when it stands, goes on as the main agent wrote it.
    const spawn = decision.model !== null && decision.model !== modelFamily(e.model) ? { ...e, model: decision.model } : e
    const result = await next(spawn)
    if (result.deny !== undefined) return result
    leaveNote({ routed: true, decision, started: result.model, requested: modelFamily(e.model), thetaOverride: settings.thetaOverride })
    // The agent has started: nothing after this may fail its spawn.
    try {
      // The effort and the person's terms go into the plan (what changes the agent later keeps to the
      // terms); the model is set on the spawn, and a planned model would also pin every step against the
      // engine's overload fallback.
      const terms = termsOf(decision)
      if (result.agentId !== undefined && (decision.effort !== null || terms !== null)) {
        await $.state.set({ ...AGENTS, id: result.agentId }, { effort: decision.effort, floor: null, model: null, terms })
      }
      const family = decision.model ?? modelFamily(result.model)
      const model = family ?? result.model
      const outcome = decision.effort === null ? model : `${model} ${decision.effort}`
      await report(reporting, {
        decision: {
          ...reportOf(result.agentId ?? e.tool_use_id),
          routed: true,
          outcome,
          reason: dispatchReason(decision, modelFamily(e.model), settings.thetaOverride, '主 agent 指定的'),
          ...dispatchEvidence(decision),
          ...(family === null ? {} : { model: family }),
          ...(decision.effort === null ? {} : { effort: decision.effort }),
        },
      })
    } catch (error) {
      $.ui.log(`agent ${about} started (${result.agentId ?? 'no id'}), but its plan was not recorded: ${String(error)}`, { to: 'debug' })
    }
    return result
  })
}
