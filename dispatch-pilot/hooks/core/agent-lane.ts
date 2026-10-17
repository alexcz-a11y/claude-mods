// The requests about agents (ADR 0009): the agents that start together share one request, and at most
// `agents.lanes` requests about agents are out at once.
//
// Each agent used to have a request of its own. With its background in it (the person's words, the problem summary, the
// conversation it was dispatched from, a Workflow's script: up to 96000 tokens with Jev), the agents of one message would
// each send the same background again: a long request each, out of the account's token rate (decision/jev-rate.ts: about
// 1.2 s of the default plan's for each). Here an agent waits in a group, one per conversation (`key`: the loop that
// dispatched it, or its Workflow run), and the group is asked about in one request: what they share once, each agent's
// brief beside it (decision/workflow.ts `agentBatches`; one dispatched agent alone is asked as one always was).
//
// A group is asked once it is complete: every member's input is in (a Workflow agent's is built from what its run's
// launching turn said, as it is spawned), and every Agent call of the message it came from has arrived, or GATHER_MS has
// passed (a call the mod does not route never arrives). Then it waits for a lane: at most `lanes` requests about agents are out at once
// (BACKEND_DEFAULTS agentLanes: Jev four, pplx five). An agent that comes while its group waits joins it, up to
// MAX_PER_REQUEST; one past that opens a group of its own. Requests made elsewhere about a Workflow's calls (its script read
// when it is submitted or launched) take a lane the same way (`askInLane`).
//
// Each agent waits for its answer until its own deadline (its hook's `within`) and starts as it was asked past it: a
// member past its deadline when its group goes out is left out of the request.
//
// Module state: a hot reload loses the groups waiting, whose hooks go with the old module.

import { describeAsked, timedOut, type Asked, type BackendIo, type Failure } from '../decision/backend.ts'
import { describeState } from '../decision/context.ts'
import type { Dispatch, DispatchDecision, DispatchSettings } from '../decision/dispatched-agent.ts'
import type { DecisionRequest } from '../decision/system-one.ts'
import { agentBatches, agentDecision, MAX_PER_REQUEST, type AgentShared } from '../decision/workflow.ts'
import { waitFor, type Ctx } from './setup.ts'

/** What the lane needs of the engine, from the hook of the agent that waits: each brings its own, and a request goes out through a waiting one's. */
export type LaneIo = {
  /** Its `sleep` is the one the lane waits on too (the host's `$.clock.sleep`). */
  backend: BackendIo
  now: () => Promise<number>
  debug: (line: string) => void
}

/** An agent's own fields (its brief, type, label, the model asked for it) and what it shares with its group. */
export type AgentInput = { dispatch: Dispatch; shared: AgentShared }

/** One agent waiting for its decision. */
export type AgentAsk = {
  /** The agents of one key share requests: those one loop dispatched (`agent:<loop>`), those of one Workflow run (`run:<runId>`). */
  key: string
  /** `agent`: a dispatched agent (alone, asked as one always was); `workflow`: a Workflow's agent. */
  kind: 'agent' | 'workflow'
  /** What it is asked about; null when there is nothing to ask (its task was not read). It may come after the agent does. */
  input: AgentInput | null | Promise<AgentInput | null>
  /** The Agent call that dispatched it and the Agent calls of the same message, its own among them: its group waits for them, GATHER_MS at most. */
  call?: { id: string; siblings: readonly string[] }
  /** When it stops waiting (`$.clock.now()` ms): past it the agent starts as it was asked. */
  deadline: number
  /** The agent as the debug log's line about the request names it: `agent "Rename getUser"（general-purpose）`. */
  about: string
  io: LaneIo
}

/** An agent's decision, or why there is none (`unasked`: it had nothing to ask about). */
export type AgentAnswer = { ok: true; decision: DispatchDecision } | { ok: false; failure: Failure; unasked?: true }

/** A group waits at most this long for the Agent calls of its message that have not arrived (a fork's, a teammate's never do). */
const GATHER_MS = 300
/** A request needs at least this long to be worth sending (the Workflow labels' per-agent ask uses it too). */
export const MIN_ASK_MS = 200
/** The Agent calls that arrived lately, so a group that waits for one knows it came (to another group, when one was full). */
const ARRIVED_KEPT = 256

type Member = { ask: AgentAsk; input: AgentInput | null | undefined; since: number | null; settle: (answer: AgentAnswer) => void }
type Group = { key: string; kind: 'agent' | 'workflow'; settings: DispatchSettings; members: Member[]; expected: Set<string>; gathering: boolean; gathered: boolean; stop: AbortController }
type Prepared = { request: DecisionRequest; deadline: number; since: number; about: string; io: LaneIo; settle: (asked: Asked) => void }
type Entry = { group: Group } | { prepared: Prepared }

/** What waits for a lane, oldest first. */
const queue: Entry[] = []
/** The requests about agents out now. */
let out = 0
const arrived = new Set<string>()

/**
 * Asks about one agent with the agents that start beside it; resolves to its decision, or to why there is none. Never
 * rejects. The caller waits for it until the agent's deadline (`within`): the answer may come too late to use.
 */
export function askAgent(ctx: Ctx, settings: DispatchSettings, ask: AgentAsk): Promise<AgentAnswer> {
  return new Promise((resolve) => {
    let settled = false
    const member: Member = {
      ask,
      input: undefined,
      since: null,
      settle: (answer) => {
        if (settled) return
        settled = true
        resolve(answer)
      },
    }
    const group = joinable(ask) ?? open(ask, settings)
    group.members.push(member)
    if (ask.call !== undefined) {
      arrived.add(ask.call.id)
      while (arrived.size > ARRIVED_KEPT) arrived.delete(arrived.values().next().value as string)
      for (const id of ask.call.siblings) group.expected.add(id)
      // The calls of its message that have not arrived: the group waits for them, GATHER_MS at most (once).
      if (!group.gathering && missing(group)) {
        group.gathering = true
        ask.io.backend.sleep(GATHER_MS, group.stop.signal).then(
          () => {
            group.gathered = true
            pump(ctx)
          },
          () => undefined,
        )
      }
    }
    // When the request was made, for the failure of an agent whose lane never came (its wait in ms).
    void ask.io.now().then((now) => (member.since = now), () => undefined)
    Promise.resolve(ask.input)
      .catch(() => null)
      .then((input) => {
        member.input = input
        if (input === null) {
          group.members.splice(group.members.indexOf(member), 1)
          member.settle({ ok: false, failure: { kind: 'request', detail: 'nothing to ask about the agent' }, unasked: true })
        }
        pump(ctx)
      })
    pump(ctx)
  })
}

/**
 * Asks `request` (made elsewhere: a Workflow's calls) once a lane is free, waiting for its answer until `deadline` at
 * most and for as long as the decision model takes for it (`waitFor`). Never rejects.
 */
export function askInLane(ctx: Ctx, request: DecisionRequest, options: { deadline: number; since: number; about: string; io: LaneIo }): Promise<Asked> {
  return new Promise((resolve) => {
    queue.push({ prepared: { request, ...options, settle: resolve } })
    pump(ctx)
  })
}

/** The group `ask` joins: one of its key waiting for a lane, with room; none when there is no such group. */
function joinable(ask: AgentAsk): Group | undefined {
  for (const entry of queue) {
    if ('group' in entry && entry.group.key === ask.key && entry.group.kind === ask.kind && entry.group.members.length < MAX_PER_REQUEST) return entry.group
  }
  return undefined
}

function open(ask: AgentAsk, settings: DispatchSettings): Group {
  const group: Group = { key: ask.key, kind: ask.kind, settings, members: [], expected: new Set(), gathering: false, gathered: false, stop: new AbortController() }
  queue.push({ group })
  return group
}

/** Whether an Agent call of the group's message has not arrived yet. */
function missing(group: Group): boolean {
  for (const id of group.expected) if (!arrived.has(id)) return true
  return false
}

/** Whether a group can go out: every member's input is in, and its message's Agent calls have arrived or it has waited for them long enough. */
function complete(group: Group): boolean {
  return group.members.every((member) => member.input !== undefined) && (group.gathered || !missing(group))
}

/** Sends what waits, oldest first, while a lane is free: a group once it is complete, a request made elsewhere at once. */
function pump(ctx: Ctx): void {
  const lanes = Math.max(1, ctx.config.agents.lanes)
  let at = 0
  while (at < queue.length && out < lanes) {
    const entry = queue[at] as Entry
    if ('group' in entry) {
      if (entry.group.members.length === 0) {
        entry.group.stop.abort()
        queue.splice(at, 1)
        continue
      }
      if (!complete(entry.group)) {
        at++
        continue
      }
    }
    queue.splice(at, 1)
    out++
    const asking = 'group' in entry ? askGroup(ctx, entry.group) : askPrepared(ctx, entry.prepared)
    void asking
      .catch(() => undefined)
      .then(() => {
        out--
        pump(ctx)
      })
  }
}

/** The failure of a request that never went out in time. */
function late(waitedMs: number): Failure {
  return timedOut(Math.max(0, Math.round(waitedMs)))
}

/**
 * Asks about a group's agents: those still waiting, in as many requests as their briefs take (one after the other, in
 * its lane), each through the hook of the member that waits the longest; and settles each with its decision.
 */
async function askGroup(ctx: Ctx, group: Group): Promise<void> {
  group.stop.abort()
  // Every input is in by now (`complete`), and an agent with none to ask about left the group.
  const members = group.members
  const first = members.reduce<Member | undefined>((best, member) => (best === undefined || member.ask.deadline > best.ask.deadline ? member : best), undefined)
  if (first === undefined) return
  const io = first.ask.io
  const now = await io.now()
  const waiting = members.filter((member) => member.ask.deadline - now >= MIN_ASK_MS)
  for (const member of members) if (!waiting.includes(member)) member.settle({ ok: false, failure: late(member.ask.deadline - (member.since ?? now)) })
  const last = waiting.at(-1)
  if (last === undefined) return
  // The member that came last read the shared background last: its conversation holds the others' calls.
  const shared = (last.input as AgentInput).shared
  const dispatches = waiting.map((member) => (member.input as AgentInput).dispatch)
  const batches = agentBatches(group.kind, dispatches, shared, group.settings, ctx.config.contextByKind.agent)
  for (const batch of batches) {
    const asked = batch.calls.map((index) => waiting[index] as Member)
    const startedAt = await io.now()
    const timeoutMs = Math.max(...asked.map((member) => member.ask.deadline)) - startedAt
    if (timeoutMs < MIN_ASK_MS) {
      for (const member of asked) member.settle({ ok: false, failure: late(member.ask.deadline - (member.since ?? startedAt)) })
      continue
    }
    const answer = await ctx.backend.ask(io.backend, batch.request, timeoutMs)
    const ms = (await io.now()) - startedAt
    io.debug(`request [${Object.keys(batch.request.questions).join(', ')}] to ${ctx.backend.name} for ${asked.map((member) => member.ask.about).join(', ')}: ${describeAsked(answer, ms)}; ${describeState(batch.request.state)}`)
    batch.calls.forEach((index, at) => {
      const member = waiting[index] as Member
      if (!answer.ok) return member.settle({ ok: false, failure: answer.failure })
      const decision = agentDecision(batch, at, answer.answers, { ...(dispatches[index] as Dispatch), user_message: shared.words }, group.settings)
      member.settle(decision === null || !decision.answered ? { ok: false, failure: { kind: 'parse', detail: 'no answer about the agent' } } : { ok: true, decision })
    })
  }
}

/** Asks a request made elsewhere, within its deadline and the wait the decision model needs for it. */
async function askPrepared(ctx: Ctx, prepared: Prepared): Promise<void> {
  const startedAt = await prepared.io.now()
  const timeoutMs = Math.min(prepared.deadline - startedAt, waitFor(ctx, [prepared.request]))
  if (timeoutMs < MIN_ASK_MS) {
    prepared.settle({ ok: false, failure: late(prepared.deadline - prepared.since) })
    return
  }
  const asked = await ctx.backend.ask(prepared.io.backend, prepared.request, timeoutMs)
  prepared.io.debug(`request [${Object.keys(prepared.request.questions).join(', ')}] to ${ctx.backend.name} for ${prepared.about}: ${describeAsked(asked, (await prepared.io.now()) - startedAt)}; ${describeState(prepared.request.state)}`)
  prepared.settle(asked)
}

/**
 * The Agent calls of the message that holds the call `callId`, its own among them: the tool_use ids of `Agent` (or `Task`)
 * calls in the rows of that message (the transcript gives a reply one row per block). Just `callId` when no row holds it
 * yet: nothing to wait for.
 */
export function agentCallsBeside(messages: readonly { role: string; toolUses?: readonly { tool: string; tool_use_id?: string }[] }[], callId: string): string[] {
  const at = messages.findIndex((message) => (message.toolUses ?? []).some((use) => use.tool_use_id === callId))
  if (at < 0 || messages[at]?.role !== 'assistant') return [callId]
  let start = at
  while (start > 0 && messages[start - 1]?.role === 'assistant') start--
  let end = at
  while (end + 1 < messages.length && messages[end + 1]?.role === 'assistant') end++
  const ids = messages.slice(start, end + 1).flatMap((message) => (message.toolUses ?? []).flatMap((use) => ((use.tool === 'Agent' || use.tool === 'Task') && use.tool_use_id !== undefined ? [use.tool_use_id] : [])))
  return ids.includes(callId) ? ids : [callId]
}
