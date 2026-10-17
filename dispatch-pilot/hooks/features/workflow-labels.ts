// Feature: the Workflow fallback (#9). The agents of a Workflow whose script
// the workflow-agents feature (#8) could not write into get their model and
// effort as each one is spawned, by its label.
//
// When the Workflow tool launches a run this feature has work in (a script
// given by path or by name, a resumed run, a script workflow-agents could not
// read, or calls of it whose prompt is data), it reads the script the run uses,
// asks the decision model about each call it can read (path, name and resume:
// workflow-agents asked about the calls of an inline script), and records the
// run. Each agent of the run passes `agent.spawn` (`e.workflow`), whose
// `description` is its label and `prompt` its task (2.1.300 on, a model set
// there is the one it starts on): the label says which call it is, and that
// call's model is set on the spawn, its effort put into the plan table under
// the agent's id, which the core sends on every step of it. An agent whose call
// could not be decided ahead (its prompt is data, the script cannot be read) is
// decided then, from its task.
//
// Its switch is `workflow-labels` (`/dp workflow-labels off`).

import type { AgentSpawnInput, EngineInterface, HttpInit, On, ToolCallResult } from 'claude-code'
import { errorText, failureLine, failureText, timedOut, within, type Failure } from '../decision/backend.ts'
import { clipToTokens, conversationUpTo, type ContextMessage } from '../decision/context.ts'
import { dispatchEvidence, modelFamily, termsOf, type AgentModel, type DispatchSettings, type Terms } from '../decision/dispatched-agent.ts'
import type { Effort } from '../decision/effort.ts'
import { inlineSites, isTaskStart, launchNote, sameRoute, sharedTerms, sitesFor, sitesOf, submissionOf, type Given, type RunSite } from '../decision/workflow-labels.ts'
import { parseWorkflow, type AgentCall } from '../decision/workflow-script.ts'
import {
  BATCHES_BUDGET_MS,
  callDispatch,
  callOutcome,
  callResult,
  planBatches,
  problemBackground,
  problemFields,
  readingBackground,
  readOutcomes,
  reasonOf,
  SCRIPT_SHARE,
  tellsTheWork,
  type WorkflowBackground,
} from '../decision/workflow.ts'
import { askAgent, askInLane, MIN_ASK_MS, type AgentAnswer, type AgentInput, type LaneIo } from '../core/agent-lane.ts'
import { update, type Cell } from '../core/plans.ts'
import { callNodeId, report, type Decided, type ReportIo } from '../core/report.ts'
import { dispatchSettings, type Ctx } from '../core/setup.ts'
import { defineSwitch, isOn } from '../core/switches.ts'
import { callReports, workflowCallTitle, workflowLeft } from '../core/workflow-report.ts'
import { sessionReading } from './reference-hint.ts'
import { UNRESOLVED_SWITCH } from './unresolved.ts'

const SAID = { plugin: 'dispatch-pilot', key: 'said' } as const
const COUNT = { plugin: 'dispatch-pilot', key: 'unresolved' } as const
const AGENTS = { plugin: 'dispatch-pilot', key: 'agents' } as const
const RUNS = { plugin: 'dispatch-pilot', key: 'labelRuns' } as const
const TERMS = { plugin: 'dispatch-pilot', key: 'workflowTerms' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
const PPLX_RATE = { plugin: 'dispatch-pilot', key: 'pplxRate' } as const
const READINGS = { plugin: 'dispatch-pilot', key: 'referenceReadings' } as const

/** The switch's name, in `/dp` and in the decision log. */
const SWITCH = 'workflow-labels'
/** At most this many runs are kept. */
const MAX_RUNS = 8
/**
 * How long an agent's spawn may wait in all (for its run to be set up, a
 * decision): a hook has 10 s of its own, and waits count.
 */
const SPAWN_BUDGET_MS = 9000

/** What the Workflow tool's description gains for the main agent: fixed words, nothing of the session in them. */
const LABEL_HINT =
  "Dispatch Pilot, the user's routing plugin, finds each running agent's agent() call by its label to set the model and effort it runs with. Give every agent() call a label that is fixed and unique within the script: a string such as { label: 'review-auth' }, or for a call that runs once per item, a fixed prefix and the item, such as { label: `audit:${file}` }."

/**
 * What the turn that launched a run said, kept for the run's agents decided as each one starts (`labelRuns` in
 * types/index.d.ts): the person's words (`said` then), the problem summary and count, the script (with the agents'
 * background: its text, cut to the share of an agent's budget a script takes) and the loop that launched it (`caller`,
 * absent for the main one): its conversation up to the run's call is read as an agent starts.
 */
type Launch = { said: string[]; problem_summary?: string; unresolved_count?: number; script?: string; caller?: string }

/**
 * A run this feature routes the agents of (`labelRuns` in types/index.d.ts). `callId`: the Workflow tool call that launched it (a run recorded by an earlier load has none: the run's own id stands for it).
 * `launch`: what its launching turn said, for its agents decided as they start (absent when an earlier version recorded it).
 */
type LabelRun = { runId: string; callId?: string; workflow: string | null; description: string | null; sites: RunSite[] | null; launch?: Launch }

/** A script kept for a run's agents, cut to fit, keeps this share for its end (the last calls, what it returns). */
const SCRIPT_KEPT_TAIL = 0.3

/** What one agent's steps are set to: a model family and an effort (null: the step's own). */
type AgentRoute = { model: AgentModel | null; effort: Effort | null }

/**
 * Workflow tool calls being set up, by the call's tool_use_id, each resolving
 * to the run it recorded (null: none). A run's first agent is spawned before
 * the call has recorded the run (measured on 2.1.302: the spawn comes while the
 * tool's `next` is still out, and the tool does not wait for it), so a spawn
 * under a call being set up waits for it. The run comes through here, not
 * `$.state`: every `$.state.get` of one dispatch reads the moment the dispatch
 * began. A module variable (CLAUDE.md): a hot reload while a run is set up
 * costs its first agents their call's decision, and they are decided from
 * their own task instead.
 */
const launching = new Map<string, Promise<LabelRun | null>>()

export function registerWorkflowLabels(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: 'Workflow 里脚本改写不到的 agent，派出时按 label 设定模型和 effort' })
  const settings = dispatchSettings(ctx)

  // The standing hint: the engine renders a tool's description once per session
  // and keeps it, so the words never change and the prompt cache holds.
  on('tool.describe', { tool: 'Workflow' }, async ($, e, next) => {
    const described = await next(e)
    if (!isOn(SWITCH) || ctx.backend.configured === false) return described
    return { ...described, description: `${described.description}\n\n${LABEL_HINT}` }
  })

  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    if (!isOn(SWITCH) || ctx.backend.configured === false) return next(e)
    const log = (line: string) => $.ui.log(line, { to: 'debug' })
    const reporting = reportingOf($)
    let settled: (run: LabelRun | null) => void = () => {}
    const launch = new Promise<LabelRun | null>((resolve) => (settled = resolve))
    launching.set(e.tool_use_id, launch)
    let recorded: LabelRun | null = null
    let result: ToolCallResult | undefined
    try {
      const sub = submissionOf(e)
      const given: Given = sub.given
      result = await next(e)
      const launched = launchedRun(result)
      if (launched === null || result.deny !== undefined) return result
      // The script the run uses: the one sent (as workflow-agents passed it on: what it wrote is in it,
      // the calls it left are as they were), else the copy the tool runs.
      const text = sub.given === 'script' ? sub.script : await $.fs.read(launched.scriptPath).catch(() => null)
      const parsed = text === null ? null : parseWorkflow(text)
      if (parsed !== null && parsed.calls.length === 0) return result

      // What the turn that launches the run says: the person's words, and the problem summary and count (#41). An inline
      // script's calls were asked about by workflow-agents, which read the same: here they only size its batches, and when
      // they cannot be read, that feature could not route the script either.
      const said = given === 'script' ? await $.state.get(SAID).then((read) => read.value ?? [], () => []) : ((await $.state.get(SAID)).value ?? [])
      const words = said.join('\n')
      const { value: held } = isOn(UNRESOLVED_SWITCH) ? await $.state.get(COUNT).catch(() => ({ value: undefined })) : { value: undefined }
      const problem = problemBackground(held, ctx.ask.language)
      // What the session's reference images read as (#64): in the requests, not in what the run keeps for its agents (they read the latest as each starts).
      const reference = await sessionReading({ get: () => $.state.get(READINGS) }, (line) => $.ui.log(line, { to: 'debug' }))
      const background = { ...problem, ...readingBackground(reference) }
      const budgets = { one: ctx.config.contextByKind.workflow, each: ctx.config.contextByKind.agent }
      let sites: RunSite[] | null = null
      let decided: Parameters<typeof launchNote>[2] = null
      if (parsed !== null) {
        if (given === 'script') {
          // workflow-agents asked about the rest when the script was sent, and left the person's terms for each call.
          const plan = planBatches(parsed, words, settings, budgets, { background, written: true })
          const { value: terms = [] } = await $.state.get({ ...TERMS, id: e.tool_use_id }).catch(() => ({ value: undefined }))
          sites = inlineSites(parsed.calls, plan.skipped, terms)
        } else {
          // The script and the conversation the run is launched from, up to its call (BACKEND_DEFAULTS agentBackground).
          const recent = ctx.config.agents.background ? (conversationUpTo(await conversationOf($, e.agentId), ctx.config.context.messages, e.tool_use_id) ?? []) : []
          const plan = planBatches(parsed, words, settings, budgets, { background: { ...background, ...(ctx.config.agents.background ? { script: text, recent } : {}) } })
          // Several requests go out as the lanes allow (core/agent-lane.ts, which logs each), all within the hook's budget.
          const since = await $.clock.now()
          const deadline = since + BATCHES_BUDGET_MS
          const asked = await Promise.all(plan.batches.map((batch) => askInLane(ctx, batch.request, { deadline, since, about: `workflow ${JSON.stringify(parsed.meta.name)} (by label)`, io: laneIoOf($) })))
          const outcomes = readOutcomes(parsed, plan, asked, words, settings)
          sites = sitesOf(parsed.calls, outcomes)
          decided = { calls: parsed.calls, outcomes, describe: (failure) => failureText(ctx.backend.name, failure) }
          // One report for each call: the decisions made, and why the others wait for their agents or are left as written.
          await report(reporting, { decisions: callReports(SWITCH, { id: e.tool_use_id, parsed }, outcomes, { backend: ctx.backend.name, thetaOverride: settings.thetaOverride }) })
        }
      }
      // Every launched run is recorded, even one whose calls all run as the script says: their agents' plans still
      // take the person's terms for the calls' work as they start. Each keeps what the launching turn said, for its
      // agents decided as they start (a call whose prompt is data, an agent whose label is none of the calls'): by then
      // the person may have sent another message, about something else.
      const asLaunched: Launch = {
        said,
        ...problem,
        ...(ctx.config.agents.background && text !== null ? { script: clipToTokens(text, Math.floor(ctx.config.contextByKind.agent * SCRIPT_SHARE), SCRIPT_KEPT_TAIL) } : {}),
        ...(e.agentId === undefined ? {} : { caller: e.agentId }),
      }
      const run: LabelRun = {
        runId: launched.runId,
        callId: e.tool_use_id,
        workflow: parsed?.meta.name ?? launched.workflow,
        description: parsed?.meta.description ?? null,
        sites,
        launch: asLaunched,
      }
      const runs: Cell<LabelRun[]> = { get: () => $.state.get(RUNS), set: (value, options) => $.state.set(RUNS, value, options) }
      await update(runs, (list) => [...(list ?? []).filter((kept) => kept.runId !== run.runId), run].slice(-MAX_RUNS))
      recorded = run
      const note = launchNote(given, sites, decided)
      return note === null ? result : { ...result, context: [...(result.context ?? []), note] }
    } catch (error) {
      // The tool itself failed: as it did. Otherwise the run goes on as the tool started it.
      if (result === undefined) throw error
      log(`workflow-labels: the run's agents are not routed by label: ${errorText(error)}`)
      await report(reporting, { decision: workflowLeft(SWITCH, { id: e.tool_use_id, title: workflowCallTitle(e) }, '出错了，详见 debug log', { agent: `${e.tool_use_id}:labels` }) })
      return result
    } finally {
      launching.delete(e.tool_use_id)
      settled(recorded)
    }
  })

  on('agent.spawn', { tool_use_id: /(?:)/ }, async ($, e, next) => {
    // A resumed agent goes on as it was decided: the engine keeps its model, and its plan is the one written at its spawn.
    if (e.workflow === undefined || e.resume !== undefined || !isOn(SWITCH) || ctx.backend.configured === false) return next(e)
    const reporting = reportingOf($)
    let routed: Routed | null = null
    let failed: unknown
    try {
      routed = await routeSpawn($, ctx, settings, e)
    } catch (error) {
      failed = error
    }
    const result = await next(routed?.spawn ?? e)
    if (result.deny !== undefined || result.agentId === undefined) return result
    const agentId = result.agentId
    // The agent has started: nothing after this may fail its spawn.
    try {
      if (failed !== undefined) throw failed
      await routed?.started(agentId, reporting)
    } catch (error) {
      $.ui.log(`workflow-labels: agent ${agentId} is not routed: ${errorText(error)}`, { to: 'debug' })
      await report(reporting, { decision: { feature: SWITCH, agent: agentId, why: '出错了，详见 debug log', subject: agentId, node: { kind: 'wf', name: e.description === '' ? agentId : e.description, type: 'workflow', state: 'queued' } } })
    }
    return result
  })
}

/**
 * What routing one spawn comes to: the spawn to start (its model set when it changes), and what is written and reported
 * once the agent has its id.
 */
type Routed = { spawn: AgentSpawnInput; started: (agentId: string, reporting: ReportIo) => Promise<void> }

/** As a Workflow's agent is spawned: finds its run and the call it belongs to, and decides it; null when it is no run's this routes. */
async function routeSpawn($: EngineInterface, ctx: Ctx, settings: DispatchSettings, e: AgentSpawnInput): Promise<Routed | null> {
  const flow = e.workflow
  if (flow === undefined) return null
  const deadline = (await $.clock.now()) + SPAWN_BUDGET_MS
  const run = await runOf($, flow.runId, e.tool_use_id, deadline)
  if (run === null) return null
  // The label the engine gives the agent (its call's, a template's filled in, else the start of its prompt) and its task.
  const label = e.description
  const candidates = run.sites === null ? [] : sitesFor(label, run.sites)
  const route = run.sites === null ? null : routeOf(candidates)
  if (route?.kind === 'script') {
    // The script runs it as written (workflow-agents wrote into it); the person's terms for its work still go into its plan.
    const terms = sharedTerms(candidates)
    return {
      spawn: e,
      started: async (agentId) => {
        if (terms !== null) await $.state.set({ ...AGENTS, id: agentId }, { effort: null, floor: null, model: null, terms })
      },
    }
  }
  const site = candidates.length === 1 ? candidates[0] : undefined
  const settled: Settled =
    route?.kind === 'set'
      ? { ok: true, route, terms: sharedTerms(candidates), decision: null }
      : await decideAtStart($, ctx, settings, { run, label, task: e.prompt, site, deadline })
  // The model is set on the spawn (an alias resolves there); the effort and the person's terms go into the plan.
  const model = settled.ok ? (settled.route?.model ?? null) : null
  const spawn = model !== null && model !== modelFamily(e.model ?? e.parentModel) ? { ...e, model } : e
  // The agent is on the board as the agent it is: a node of the Workflow, taking the place of its call's when that is known.
  const callId = run.callId ?? run.runId
  const about = (agentId: string) => ({
    feature: SWITCH,
    agent: agentId,
    subject: JSON.stringify(label),
    node: { kind: 'wf' as const, name: label, type: site?.agentType ?? 'workflow', state: 'queued' as const, workflow: { id: callId, name: run.workflow ?? '未命名' } },
    ...(site === undefined || run.sites === null ? {} : { replaces: callNodeId(callId, run.sites.indexOf(site)) }),
  })
  return {
    spawn,
    started: async (agentId, reporting) => {
      if (!settled.ok) {
        await report(reporting, { decision: settled.failure === undefined ? { ...about(agentId), why: settled.reason } : { ...about(agentId), routed: false, failure: { backend: ctx.backend.name, ...settled.failure } } })
        return
      }
      // The decision made as the agent starts has its entry now; one made with its run is the entry that stands for its call.
      const decided = settled.decision === null ? { ...about(agentId), started: true as const } : { ...about(agentId), routed: true as const, ...settled.decision }
      await report(reporting, { decision: decided })
      const effort = settled.route?.effort ?? null
      if (effort !== null || settled.terms !== null) await $.state.set({ ...AGENTS, id: agentId }, { effort, floor: null, model: null, terms: settled.terms })
    },
  }
}

/** The module's way into `$` for a request about agents (core/agent-lane.ts). */
function laneIoOf($: EngineInterface): LaneIo {
  return {
    backend: {
      fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
      sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
      pace: { now: () => $.clock.now(), sentAt: { get: () => $.state.get(PPLX_RATE), set: (value, options) => $.state.set(PPLX_RATE, value, options) } },
    },
    now: () => $.clock.now(),
    debug: (line) => $.ui.log(line, { to: 'debug' }),
  }
}

/** The module's way into `$` for a report (`$` may not cross an import). */
function reportingOf($: EngineInterface): ReportIo {
  return {
    board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
    decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
    debug: (line) => $.ui.log(line, { to: 'debug' }),
    now: () => $.clock.now(),
    toast: (text) => $.ui.toast(text),
  }
}

/**
 * The run `runId` this feature recorded: the one the Workflow call `callId` is setting up, waited for until `deadline` at
 * most, else the one recorded already; null when it is in neither.
 */
async function runOf($: EngineInterface, runId: string, callId: string, deadline: number): Promise<LabelRun | null> {
  const pending = launching.get(callId)
  if (pending !== undefined) {
    const left = deadline - (await $.clock.now())
    const run = left > 0 ? await within((ms, signal) => $.clock.sleep(ms, { signal }), pending, left, null) : null
    if (run?.runId === runId) return run
  }
  const { value: runs = [] } = await $.state.get(RUNS)
  return runs.find((kept) => kept.runId === runId) ?? null
}

/**
 * What deciding one agent came to: what to set on its steps (null: what it runs with already) and the person's terms
 * for its work, with the decision to report when it was made as the agent started (null: it was made with the run);
 * or why there is no decision, with the failed request behind it when there was one.
 */
type Settled = { ok: true; route: AgentRoute | null; terms: Terms | null; decision: Omit<Decided, 'feature' | 'agent' | 'node' | 'replaces'> | null } | { ok: false; reason: string; failure?: Failure }

/**
 * Decides one agent as it is spawned, from its task, as the workflow-agents
 * feature decides a call (the same questions, the same reading), with the
 * agents of its run spawned beside it: a fan-out's agents are spawned together,
 * and share requests (core/agent-lane.ts).
 */
async function decideAtStart(
  $: EngineInterface,
  ctx: Ctx,
  settings: DispatchSettings,
  agent: { run: LabelRun; label: string; task: string; site: RunSite | undefined; deadline: number },
): Promise<Settled> {
  const now = await $.clock.now()
  const deadline = Math.min(agent.deadline, now + ctx.config.agents.waitMs)
  if (deadline - now < MIN_ASK_MS) return { ok: false, reason: '没有时间再问决策模型了' }
  // What the turn that launched the run said, not the turn the agent starts in: the person may have sent another message
  // since, about something else. A run an earlier load recorded kept none, and reads the words of now.
  const launch = agent.run.launch
  const site = agent.site
  const meta = { name: agent.run.workflow, description: agent.run.description }
  const task = agent.task
  /** The call the agent's task stands for. */
  const call: AgentCall = {
    index: 0,
    line: site?.line ?? 0,
    prompt: task,
    // A label the engine made up from the task says nothing more.
    label: isTaskStart(agent.label, task) ? null : agent.label,
    labelKind: 'string',
    agentType: site?.agentType ?? null,
    model: site?.model ?? { kind: 'none' },
    effort: site?.effort ?? { kind: 'none' },
    edit: null,
  }
  if (!tellsTheWork(task)) return { ok: false, reason: '它的任务里没说要做什么' }
  const input = (async (): Promise<AgentInput> => {
    const said = launch?.said ?? ((await $.state.get(SAID)).value ?? [])
    const words = said.join('\n')
    const reference = await sessionReading({ get: () => $.state.get(READINGS) }, (line) => $.ui.log(line, { to: 'debug' }))
    const background: WorkflowBackground = {
      ...problemFields(launch),
      // The latest reading as this agent starts, not the one at the launch: the images read since are the work's too.
      ...readingBackground(reference),
      ...(ctx.config.agents.background && launch !== undefined ? { script: launch.script ?? null, recent: await launchConversation($, agent.run, ctx.config.context.messages) } : {}),
    }
    return { dispatch: callDispatch(call, meta, words), shared: { words, background } }
  })()
  const about = `${JSON.stringify(agent.label)}（Workflow ${agent.run.workflow ?? '未命名'}）`
  const late: AgentAnswer = { ok: false, failure: timedOut(Math.round(deadline - now)) }
  const io = laneIoOf($)
  const answer = await within(io.backend.sleep, askAgent(ctx, settings, { key: `run:${agent.run.runId}`, kind: 'workflow', input, deadline, about, io }), deadline - now, late)
  if (!answer.ok) return { ok: false, reason: failureLine(ctx.backend.name, answer.failure), failure: answer.failure }
  const outcome = callOutcome(call, answer.decision)
  const requested = call.model.kind === 'literal' ? modelFamily(call.model.value) : null
  const family = outcome.decision.model ?? requested
  const decision = {
    // The entry's subject is the agent as it is told here, not the call.
    subject: about,
    outcome: callResult(call, outcome.decision),
    reason: `按它启动时的任务；${reasonOf(outcome.decision, requested, settings.thetaOverride)}`,
    ...dispatchEvidence(outcome.decision),
    ...(family === null ? {} : { model: family }),
    ...(outcome.decision.effort === null ? {} : { effort: outcome.decision.effort }),
  }
  const terms = termsOf(outcome.decision)
  if (outcome.kind === 'kept') return { ok: true, route: null, terms, decision }
  return { ok: true, route: { model: outcome.write.model === undefined ? null : (outcome.write.model as AgentModel), effort: typeof outcome.write.effort === 'string' ? (outcome.write.effort as Effort) : null }, terms, decision }
}

/**
 * The conversation a run was launched from: the launching loop's (`launch.caller`, else the main one) up to and with the
 * message that holds the run's Workflow call. None when that message is gone (compacted) or the run kept no call.
 */
async function launchConversation($: EngineInterface, run: LabelRun, count: number): Promise<string[]> {
  if (run.callId === undefined) return []
  return conversationUpTo(await conversationOf($, run.launch?.caller), count, run.callId) ?? []
}

/** The conversation of the loop `agentId` (absent: the main one), as the transcript rows; none when it cannot be read. */
async function conversationOf($: EngineInterface, agentId: string | undefined): Promise<readonly ContextMessage[]> {
  const read: unknown = await (agentId === undefined ? $.session.messages() : $.session.messages({ agentId })).catch(() => [])
  return Array.isArray(read) ? (read as ContextMessage[]) : []
}

/** The one route all of `sites` share; null when there is none, or they differ. */
function routeOf(sites: readonly RunSite[]): RunSite['route'] | null {
  const first = sites[0]
  return first !== undefined && sites.every((site) => sameRoute(site.route, first.route)) ? first.route : null
}

/** The run the Workflow tool's result says it launched: its id, the script it runs and the workflow's name. */
function launchedRun(result: ToolCallResult): { runId: string; scriptPath: string; workflow: string | null } | null {
  const launched = result.result as { runId?: unknown; scriptPath?: unknown; workflowName?: unknown } | undefined
  if (typeof launched !== 'object' || launched === null) return null
  const { runId, scriptPath, workflowName } = launched
  if (typeof runId !== 'string' || typeof scriptPath !== 'string') return null
  return { runId, scriptPath, workflow: typeof workflowName === 'string' ? workflowName : null }
}
