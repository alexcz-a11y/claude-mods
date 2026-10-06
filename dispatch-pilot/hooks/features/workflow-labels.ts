// Feature: the Workflow fallback (#9). The agents of a Workflow whose script
// the workflow-agents feature (#8) could not write into get their model and
// effort when each one starts, by its label.
//
// When the Workflow tool launches a run this feature has work in (a script
// given by path or by name, a resumed run, a script workflow-agents could not
// read, or calls of it whose prompt is data), it reads the script the run uses,
// asks the decision model about each call it can read (path, name and resume:
// workflow-agents asked about the calls of an inline script), and records the
// run. When an agent of the run takes its first step, the run's journal says
// which label it started under; the label says which call it is, and that
// call's decision goes into the plan table under the agent's id, which the core
// sends on every step of it. An agent whose call could not be decided ahead
// (its prompt is data, the script cannot be read) is decided then, from the
// task in its own transcript.
//
// Its switch is `workflow-labels` (`/dp workflow-labels off`).

import type { EngineInterface, HttpInit, On, ToolCallResult } from 'claude-code'
import { describeAsked, errorText, within, type Failure } from '../decision/backend.ts'
import { dispatchEvidence, modelFamily, termsOf, type AgentModel, type DispatchSettings, type Terms } from '../decision/dispatched-agent.ts'
import type { Effort } from '../decision/effort.ts'
import {
  agentPlan,
  inlineSites,
  isTaskStart,
  launchNote,
  sameRoute,
  sharedTerms,
  sitesFor,
  sitesOf,
  startedIn,
  taskOf,
  type Given,
  type JournalStart,
  type RunSite,
} from '../decision/workflow-labels.ts'
import { parseWorkflow, type AgentCall, type ParsedWorkflow } from '../decision/workflow-script.ts'
import { batchesTimeoutMs, outcomeOf, readOutcomes, reasonOf, workflowBatches } from '../decision/workflow.ts'
import { update, type Cell } from '../core/plans.ts'
import { reportDecision, reportDecisions, type Decided, type ReportIo } from '../core/report.ts'
import { dispatchSettings, type Ctx } from '../core/setup.ts'
import { failureText } from '../core/status.ts'
import { defineSwitch, isOn } from '../core/switches.ts'
import { callReports, workflowCallTitle, workflowLeft } from '../core/workflow-report.ts'

const SAID = { plugin: 'dispatch-pilot', key: 'said' } as const
const AGENTS = { plugin: 'dispatch-pilot', key: 'agents' } as const
const RUNS = { plugin: 'dispatch-pilot', key: 'labelRuns' } as const
const TERMS = { plugin: 'dispatch-pilot', key: 'workflowTerms' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

/** The switch's name, in `/dp` and in the decision log. */
const SWITCH = 'workflow-labels'
/** At most this many runs are kept. */
const MAX_RUNS = 8
/**
 * How long an agent's first step may wait in all (for its run to be set up,
 * its transcript, a decision): a hook has 10 s of its own, and waits count.
 */
const STEP_BUDGET_MS = 9000
/**
 * How long an agent's first step waits for its transcript, and how often it
 * looks. The engine writes it 50-110 ms after the step begins (2.1.289), also
 * while the step waits.
 */
const TASK_WAIT_MS = 400
const TASK_POLL_MS = 25
/** A decision request needs at least this long to be worth sending. */
const MIN_ASK_MS = 200

/** What the Workflow tool's description gains for the main agent: fixed words, nothing of the session in them. */
const LABEL_HINT =
  "Dispatch Pilot, the user's routing plugin, finds each running agent's agent() call by its label to set the model and effort it runs with. Give every agent() call a label that is fixed and unique within the script: a string such as { label: 'review-auth' }, or for a call that runs once per item, a fixed prefix and the item, such as { label: `audit:${file}` }."

/** A run this feature routes the agents of (`labelRuns` in types/index.d.ts). `callId`: the Workflow tool call that launched it (a run recorded by an earlier load has none: the run's own id stands for it). */
type LabelRun = { runId: string; callId?: string; dir: string; workflow: string | null; description: string | null; sites: RunSite[] | null }

/** What one agent's steps are set to: a model family and an effort (null: the step's own). */
type AgentRoute = { model: AgentModel | null; effort: Effort | null }

/**
 * Workflow tool calls being set up, each resolving to the run it recorded
 * (null: none). A run's first agent can take its first step before the call
 * has recorded the run (measured on 2.1.289: 1 ms after the tool returned), so
 * an agent found in no recorded run waits for these. The run comes through
 * here, not `$.state`: every `$.state.get` of one dispatch reads the moment
 * the dispatch began.
 */
const launching = new Set<Promise<LabelRun | null>>()

export function registerWorkflowLabels(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: 'sets the model and effort of each Workflow agent when it starts, by its label, where the script could not be written into', segments: ['labels'] })
  const settings = dispatchSettings(ctx)

  // The standing hint: the engine renders a tool's description once per session
  // and keeps it, so the words never change and the prompt cache holds.
  on('tool.describe', { tool: 'Workflow' }, async ($, e, next) => {
    const described = await next(e)
    if (!isOn(SWITCH) || !ctx.backend.configured) return described
    return { ...described, description: `${described.description}\n\n${LABEL_HINT}` }
  })

  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    if (!isOn(SWITCH) || !ctx.backend.configured) return next(e)
    const log = (line: string) => $.ui.log(line, { to: 'debug' })
    const reporting: ReportIo = {
      board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
      decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
      debug: log,
      status: (line) => $.ui.status(line),
    }
    let settled: (run: LabelRun | null) => void = () => {}
    const launch = new Promise<LabelRun | null>((resolve) => (settled = resolve))
    launching.add(launch)
    let recorded: LabelRun | null = null
    let result: ToolCallResult | undefined
    try {
      const given: Given = e.scriptPath !== undefined ? 'path' : e.script === undefined || e.name !== undefined ? 'name' : e.resumeFromRunId !== undefined ? 'resume' : 'script'
      result = await next(e)
      const launched = launchedRun(result)
      if (launched === null || result.deny !== undefined) return result
      // The script the run uses: the one sent (as workflow-agents passed it on: what it wrote is in it,
      // the calls it left are as they were), else the copy the tool runs.
      const text = given === 'script' ? (e.script ?? null) : await $.fs.read(launched.scriptPath).catch(() => null)
      const parsed = text === null ? null : parseWorkflow(text)
      if (parsed !== null && parsed.calls.length === 0) return result

      let sites: RunSite[] | null = null
      let decided: Parameters<typeof launchNote>[2] = null
      if (parsed !== null) {
        // An inline script's calls were asked about by workflow-agents: the person's words only size its batches here,
        // and when they cannot be read, that feature could not route the script either.
        const said = given === 'script' ? await $.state.get(SAID).then((read) => read.value ?? [], () => []) : ((await $.state.get(SAID)).value ?? [])
        const words = said.join('\n')
        const plan = workflowBatches(parsed, words, settings, ctx.config.contextByKind.workflow)
        if (given === 'script') {
          // workflow-agents asked about the rest when the script was sent, and left the person's terms for each call.
          const { value: terms = [] } = await $.state.get({ ...TERMS, id: e.tool_use_id }).catch(() => ({ value: undefined }))
          sites = inlineSites(parsed.calls, plan.skipped, terms)
        } else {
          const io = {
            fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
            sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
          }
          const timeoutMs = batchesTimeoutMs(ctx.config.timeoutMs, plan.batches.length)
          const asked = await Promise.all(
            plan.batches.map(async (batch) => {
              const startedAt = await $.clock.now()
              const answer = await ctx.backend.ask(io, batch.request, timeoutMs)
              log(`request [${Object.keys(batch.request.questions).join(', ')}] to ${ctx.backend.name} for workflow ${JSON.stringify(parsed.meta.name)} (by label): ${describeAsked(answer, (await $.clock.now()) - startedAt)}`)
              return answer
            }),
          )
          const outcomes = readOutcomes(parsed, plan, asked, words, settings)
          sites = sitesOf(parsed.calls, outcomes)
          decided = { calls: parsed.calls, outcomes, describe: (failure) => failureText(ctx.backend.name, failure) }
          // One report for each call: the decisions made, and why the others wait for their agents or are left as written.
          await reportDecisions(reporting, callReports(SWITCH, { id: e.tool_use_id, parsed }, outcomes, { backend: ctx.backend.name, thetaOverride: settings.thetaOverride }))
        }
      }
      // Every launched run is recorded, even one whose calls all run as the script says: their agents' plans still
      // take the person's terms for the calls' work as they start.
      const run: LabelRun = { runId: launched.runId, callId: e.tool_use_id, dir: launched.dir, workflow: parsed?.meta.name ?? launched.workflow, description: parsed?.meta.description ?? null, sites }
      const runs: Cell<LabelRun[]> = { get: () => $.state.get(RUNS), set: (value, options) => $.state.set(RUNS, value, options) }
      await update(runs, (list) => [...(list ?? []).filter((kept) => kept.runId !== run.runId), run].slice(-MAX_RUNS))
      recorded = run
      const note = launchNote(given, sites, decided)
      return note === null ? result : { ...result, context: [...(result.context ?? []), note] }
    } catch (error) {
      // The tool itself failed: as it did. Otherwise the run goes on as the tool started it.
      if (result === undefined) throw error
      log(`workflow-labels: the run's agents are not routed by label: ${errorText(error)}`)
      await reportDecisions(reporting, [workflowLeft(SWITCH, { id: e.tool_use_id, title: workflowCallTitle(e) }, 'error: see the debug log', { agent: `${e.tool_use_id}:labels` })])
      return result
    } finally {
      launching.delete(launch)
      settled(recorded)
    }
  })

  on('turn.step', { agentId: /(?:)/ }, async function* ($, e, next) {
    const agentId = e.agentId
    if (agentId === undefined || e.index !== 0 || !isOn(SWITCH)) return yield* next(e)
    try {
      await routeAgent($, ctx, settings, agentId, e.model)
    } catch (error) {
      $.ui.log(`workflow-labels: agent ${agentId} is not routed: ${errorText(error)}`, { to: 'debug' })
      await reportDecision(reportingOf($), { feature: SWITCH, agent: agentId, why: 'error: see the debug log', subject: agentId, node: { kind: 'wf', name: agentId, type: 'workflow', state: 'running' } })
    }
    return yield* next(e)
  })
}

/** At an agent's first step: finds the run and the call it belongs to, and plans its steps. */
async function routeAgent($: EngineInterface, ctx: Ctx, settings: DispatchSettings, agentId: string, stepModel: string): Promise<void> {
  const deadline = (await $.clock.now()) + STEP_BUDGET_MS
  // An agent with a plan already is someone's: dispatched (and planned at its spawn), or decided at a first step the engine sends again.
  const [{ value: planned }, { value: runs = [] }] = await Promise.all([$.state.get({ ...AGENTS, id: agentId }), $.state.get(RUNS)])
  if (planned !== undefined) return
  let found = await findAgent($, runs, agentId)
  if (found === null && launching.size > 0) found = await findAgent($, await settleLaunches($, deadline), agentId)
  if (found === null) return
  const { run, start } = found
  const candidates = run.sites === null ? [] : sitesFor(start.label, run.sites)
  const route = run.sites === null ? null : routeOf(candidates)
  if (route?.kind === 'script') {
    // The script runs it as written (workflow-agents wrote into it); the person's terms for its work still go into its plan.
    const terms = sharedTerms(candidates)
    if (terms !== null) await $.state.set({ ...AGENTS, id: agentId }, { effort: null, floor: null, model: null, terms })
    return
  }
  const settled: Settled =
    route?.kind === 'set'
      ? { ok: true, route, terms: sharedTerms(candidates), decision: null }
      : await decideAtStart($, ctx, settings, { run, agentId, label: start.label, site: candidates.length === 1 ? candidates[0] : undefined, deadline })
  // The agent is on the board as the agent it is: a node of the Workflow, taking the place of its call's when that is known.
  const callId = run.callId ?? run.runId
  const site = candidates.length === 1 ? candidates[0] : undefined
  const about = {
    feature: SWITCH,
    agent: agentId,
    subject: JSON.stringify(start.label),
    node: { kind: 'wf' as const, name: start.label, type: site?.agentType ?? 'workflow', state: 'running' as const, workflow: { id: callId, name: run.workflow ?? 'unnamed' } },
    ...(site === undefined || run.sites === null ? {} : { replaces: `${callId}#${run.sites.indexOf(site)}` }),
  }
  const reporting = reportingOf($)
  if (settled.ok) {
    const plan = settled.route === null ? null : agentPlan(settled.route, stepModel)
    // The decision made as the agent starts has its entry now; one made with its run is the entry that stands for its call.
    await reportDecision(reporting, settled.decision === null ? { ...about, started: true } : { ...about, routed: true, ...settled.decision })
    const terms = settled.terms
    if ((plan !== null && (plan.model !== null || plan.effort !== null)) || terms !== null) {
      await $.state.set({ ...AGENTS, id: agentId }, { effort: plan?.effort ?? null, floor: null, model: plan?.model ?? null, terms })
    }
  } else {
    await reportDecision(reporting, settled.failure === undefined ? { ...about, why: settled.reason } : { ...about, routed: false, failure: { backend: ctx.backend.name, ...settled.failure } })
  }
}

/** The module's way into `$` for a report (`$` may not cross an import). */
function reportingOf($: EngineInterface): ReportIo {
  return {
    board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
    decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
    debug: (line) => $.ui.log(line, { to: 'debug' }),
    status: (line) => $.ui.status(line),
  }
}

/** The run of `runs` that `agentId` started in, newest first, and what its journal says of it; null when it is in none. */
async function findAgent($: EngineInterface, runs: readonly LabelRun[], agentId: string): Promise<{ run: LabelRun; start: JournalStart } | null> {
  for (const run of [...runs].reverse()) {
    const journal = await $.fs.read(`${run.dir}/journal.jsonl`).catch(() => null)
    const start = journal === null ? null : startedIn(journal, agentId)
    if (start !== null) return { run, start }
  }
  return null
}

/** Waits for the Workflow calls being set up now, until `deadline` at most: the runs they recorded meanwhile, in the order they did. */
async function settleLaunches($: EngineInterface, deadline: number): Promise<LabelRun[]> {
  const recorded: LabelRun[] = []
  const left = deadline - (await $.clock.now())
  if (left <= 0) return recorded
  const all = Promise.all([...launching].map((launch) => launch.then((run) => (run === null ? undefined : recorded.push(run)))))
  await within((ms, signal) => $.clock.sleep(ms, { signal }), all, left, undefined)
  return recorded
}

/**
 * What deciding one agent came to: what to set on its steps (null: what it runs with already) and the person's terms
 * for its work, with the decision to report when it was made as the agent started (null: it was made with the run);
 * or why there is no decision, with the failed request behind it when there was one.
 */
type Settled = { ok: true; route: AgentRoute | null; terms: Terms | null; decision: Omit<Decided, 'feature' | 'agent' | 'node' | 'replaces'> | null } | { ok: false; reason: string; failure?: Failure }

/**
 * Decides one agent as it starts, from the task in its transcript, as the
 * workflow-agents feature decides a call (same request, same reading).
 */
async function decideAtStart(
  $: EngineInterface,
  ctx: Ctx,
  settings: DispatchSettings,
  agent: { run: LabelRun; agentId: string; label: string; site: RunSite | undefined; deadline: number },
): Promise<Settled> {
  const task = await readTask($, agent.run.dir, agent.agentId, agent.deadline)
  if (task === null) return { ok: false, reason: 'task not on disk in time' }
  const { value: said = [] } = await $.state.get(SAID)
  const words = said.join('\n')
  const site = agent.site
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
  const parsed: ParsedWorkflow = { script: '', meta: { name: agent.run.workflow, description: agent.run.description }, calls: [call] }
  const plan = workflowBatches(parsed, words, settings, ctx.config.contextByKind.workflow)
  const batch = plan.batches[0]
  if (batch === undefined) return { ok: false, reason: 'its task says nothing of the work' }
  const timeoutMs = Math.min(ctx.config.timeoutMs, agent.deadline - (await $.clock.now()))
  if (timeoutMs < MIN_ASK_MS) return { ok: false, reason: 'no time left to ask' }
  const io = {
    fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
    sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
  }
  const startedAt = await $.clock.now()
  const asked = await ctx.backend.ask(io, batch.request, timeoutMs)
  const about = `${JSON.stringify(agent.label)} (agent ${agent.agentId}, workflow ${agent.run.workflow ?? 'unnamed'})`
  const log = (line: string) => $.ui.log(line, { to: 'debug' })
  log(`request [${Object.keys(batch.request.questions).join(', ')}] to ${ctx.backend.name} for ${about}: ${describeAsked(asked, (await $.clock.now()) - startedAt)}`)
  const outcome = readOutcomes(parsed, plan, [asked], words, settings)[0]
  if (outcome === undefined || outcome.kind === 'left') {
    const failure = outcome?.kind === 'left' ? outcome.failure : undefined
    return { ok: false, reason: failure === undefined ? 'no answer from the decision model' : failureText(ctx.backend.name, failure), ...(failure === undefined ? {} : { failure }) }
  }
  const requested = call.model.kind === 'literal' ? modelFamily(call.model.value) : null
  const family = outcome.decision.model ?? requested
  const decision = {
    // The entry's subject is the agent as it is told here, not the call.
    subject: about,
    outcome: outcomeOf(call, outcome.decision),
    reason: `from its task as it started; ${reasonOf(outcome.decision, requested, settings.thetaOverride)}`,
    ...dispatchEvidence(outcome.decision),
    ...(family === null ? {} : { model: family }),
    ...(outcome.decision.effort === null ? {} : { effort: outcome.decision.effort }),
  }
  const terms = termsOf(outcome.decision)
  if (outcome.kind === 'kept') return { ok: true, route: null, terms, decision }
  return { ok: true, route: { model: outcome.write.model === undefined ? null : (outcome.write.model as AgentModel), effort: typeof outcome.write.effort === 'string' ? (outcome.write.effort as Effort) : null }, terms, decision }
}

/** The task in an agent's transcript, waiting briefly for the engine to write it; null when it is not there in time. */
async function readTask($: EngineInterface, dir: string, agentId: string, deadline: number): Promise<string | null> {
  const path = `${dir}/agent-${agentId}.jsonl`
  for (let waited = 0; ; waited += TASK_POLL_MS) {
    if (await $.fs.exists(path)) {
      const text = await $.fs.read(path).catch(() => null)
      const task = text === null ? null : taskOf(text)
      if (task !== null) return task
    }
    if (waited >= TASK_WAIT_MS || (await $.clock.now()) + TASK_POLL_MS > deadline) return null
    await $.clock.sleep(TASK_POLL_MS)
  }
}

/** The one route all of `sites` share; null when there is none, or they differ. */
function routeOf(sites: readonly RunSite[]): RunSite['route'] | null {
  const first = sites[0]
  return first !== undefined && sites.every((site) => sameRoute(site.route, first.route)) ? first.route : null
}

/** The run the Workflow tool's result says it launched: its id, its directory, the script it runs and the workflow's name. */
function launchedRun(result: ToolCallResult): { runId: string; dir: string; scriptPath: string; workflow: string | null } | null {
  const launched = result.result as { runId?: unknown; transcriptDir?: unknown; scriptPath?: unknown; workflowName?: unknown } | undefined
  if (typeof launched !== 'object' || launched === null) return null
  const { runId, transcriptDir, scriptPath, workflowName } = launched
  if (typeof runId !== 'string' || typeof transcriptDir !== 'string' || typeof scriptPath !== 'string') return null
  return { runId, dir: transcriptDir, scriptPath, workflow: typeof workflowName === 'string' ? workflowName : null }
}
