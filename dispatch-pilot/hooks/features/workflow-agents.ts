// Feature: the agents of a Workflow (#8). When the main agent submits a
// Workflow script, each `agent()` call of it gets its own decision on model
// and effort, and they are written into the script before the tool runs it.
// The agents of a Workflow never pass the Agent tool (no agent.spawn), so the
// script is the one place their model and effort can be set ahead of time.
//
// The main agent is told what was written and why, in what the tool returns.
// A script this cannot read, one given by path or by name, and one resumed
// from an earlier run (the cache matches on each call's prompt and options)
// are let through as they are, and so is every script when the decision model
// does not answer in time or this feature fails.
//
// In return mode (`workflowMode`) the first submission of a Workflow is
// refused instead, with the decisions as an instruction to the main agent to
// write them in; the same Workflow submitted again runs as it is.
//
// Every run is recorded in `$.state` (`workflows`, by run id): whether its
// script was rewritten, for whatever sets the model of the agents it did not.
//
// Its switch is `workflow-agents` (`/dp workflow-agents off`).

import type { HttpInit, On, ToolCallResult } from 'claude-code'
import type { Asked } from '../decision/backend.ts'
import { modelFamily, termsOf } from '../decision/dispatched-agent.ts'
import { parseWorkflow, rewriteWorkflow, type ParsedWorkflow } from '../decision/workflow-script.ts'
import { callName, outcomeOf, readOutcomes, reasonOf, returnNote, rewriteNote, statusText, workflowBatches, workflowFingerprint, type CallOutcome } from '../decision/workflow.ts'
import { recordDecision } from '../core/decisions.ts'
import { update, type Cell } from '../core/plans.ts'
import { dispatchSettings, type Ctx } from '../core/setup.ts'
import { failureText, setStatus } from '../core/status.ts'
import { defineSwitch, isOn } from '../core/switches.ts'

const SAID = { plugin: 'dispatch-pilot', key: 'said' } as const
const WORKFLOWS = { plugin: 'dispatch-pilot', key: 'workflows' } as const
const RETURNED = { plugin: 'dispatch-pilot', key: 'returned' } as const
const TERMS = { plugin: 'dispatch-pilot', key: 'workflowTerms' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

/** The switch's name, in `/dp` and in the decision log. */
const SWITCH = 'workflow-agents'
/** At most this many sent-back Workflows are remembered. */
const MAX_RETURNED = 16

/** What a run is recorded as in `$.state`. */
type RunRecord = { rewritten: boolean; reason: string; agents: { label: string | null; model: string | null; effort: string | null }[]; left: number }

/** What the feature does with one submission, settled before the tool is called. */
type Route =
  /** The script goes through as it is; the run is recorded as not rewritten, and the status line says `status` (null: nothing to say). */
  | { kind: 'pass'; record: Omit<RunRecord, 'rewritten'>; status: string | null }
  /** The Workflow is sent back (return mode). */
  | { kind: 'refuse'; deny: string }
  /** The tool is called with `script` (null: as submitted), the decisions in `outcomes`. */
  | { kind: 'start'; parsed: ParsedWorkflow; outcomes: CallOutcome[]; script: string | null }

export function registerWorkflowAgents(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: 'decides the model and effort of each agent() of a Workflow script when the main agent submits it', segments: ['workflow'] })
  const settings = dispatchSettings(ctx)
  const describe = (failure: Parameters<typeof failureText>[1]) => failureText(ctx.backend.name, failure)
  // `rewrite` (the default) writes the decisions into the script; `return` sends the Workflow back with them, once.
  const sendBack = ctx.config.agents.workflowMode === 'return'

  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    if (e.tool !== 'Workflow' || !isOn(SWITCH)) return next(e)
    const input = e
    const show = (line: string | undefined) => $.ui.status(line)
    const log = (line: string) => $.ui.log(line, { to: 'debug' })

    /** The run the tool launched is recorded at once: its first agent steps a few ms later. */
    const record = async (launched: ToolCallResult, entry: RunRecord): Promise<void> => {
      const runId = runIdOf(launched)
      if (runId === null) return
      try {
        await $.state.set({ ...WORKFLOWS, id: runId }, entry)
      } catch (error) {
        log(`workflow ${runId} launched, but not recorded: ${String(error)}`)
      }
    }

    /** One decision-log entry for each call that was decided. */
    const logDecisions = async (parsed: ParsedWorkflow, outcomes: readonly CallOutcome[], suffix: string): Promise<void> => {
      for (const [index, outcome] of outcomes.entries()) {
        const call = parsed.calls[index]
        if (outcome.kind === 'left' || call === undefined) continue
        await recordDecision(
          { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
          log,
          {
            feature: SWITCH,
            outcome: `${outcomeOf(call, outcome.decision)}${suffix}`,
            about: `${callName(call)} (workflow ${parsed.meta.name ?? 'unnamed'})`,
            reason: reasonOf(outcome.decision, call.model.kind === 'literal' ? modelFamily(call.model.value) : null, settings.thetaOverride),
          },
        )
      }
    }

    /** Settles what to do with this submission: asks the decision model, and reads its answers. */
    const decide = async (): Promise<Route> => {
      // What this does not rewrite: a script given by path or name, or resumed (its cache matches on each call's prompt and options).
      const given = input.scriptPath !== undefined ? 'scriptPath' : input.script === undefined || input.name !== undefined ? 'name' : input.resumeFromRunId !== undefined ? 'resume' : null
      if (given !== null || input.script === undefined) {
        const how = given === 'scriptPath' ? 'given by path' : given === 'resume' ? 'resumed from an earlier run' : 'given by name'
        return { kind: 'pass', record: { reason: given ?? 'name', agents: [], left: 0 }, status: `workflow not routed (${how})` }
      }

      const parsed = parseWorkflow(input.script)
      if (parsed === null) return { kind: 'pass', record: { reason: 'unreadable', agents: [], left: 0 }, status: 'workflow not routed (script not readable)' }
      if (parsed.calls.length === 0) return { kind: 'pass', record: { reason: 'no agents', agents: [], left: 0 }, status: null }

      // A Workflow already sent back runs as it is submitted, whatever the second submission says.
      const fingerprint = workflowFingerprint(parsed)
      if (sendBack && ((await $.state.get(RETURNED)).value ?? []).includes(fingerprint)) {
        return { kind: 'pass', record: { reason: 'second', agents: [], left: 0 }, status: 'workflow runs as written (sent back once before)' }
      }

      const { value: said = [] } = await $.state.get(SAID)
      const words = said.join('\n')
      const io = {
        fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
        sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
      }
      const plan = workflowBatches(parsed, words, settings, ctx.config.context.tokens)
      // Concurrent requests to one key can queue behind each other: each gets a share more time.
      const timeoutMs = Math.min(8000, ctx.config.timeoutMs * plan.batches.length)
      const asked = await Promise.all(
        plan.batches.map(async (batch) => {
          const startedAt = await $.clock.now()
          const answer = await ctx.backend.ask(io, batch.request, timeoutMs)
          const ids = Object.keys(batch.request.questions).join(', ')
          log(`request [${ids}] to ${ctx.backend.name} for workflow ${JSON.stringify(parsed.meta.name)}: ${describeAsked(answer, (await $.clock.now()) - startedAt)}`)
          return answer
        }),
      )
      const outcomes = readOutcomes(parsed, plan, asked, words, settings)
      const writes = outcomes.map((outcome) => (outcome.kind === 'written' ? outcome.write : null))
      const written = writes.filter((write) => write !== null).length

      // Return mode: what the decisions would write is for the main agent to write.
      if (sendBack && written > 0) {
        const returned: Cell<string[]> = { get: () => $.state.get(RETURNED), set: (value, options) => $.state.set(RETURNED, value, options) }
        await update(returned, (list) => [...(list ?? []), fingerprint].slice(-MAX_RETURNED))
        setStatus('workflow', `workflow sent back (${written} agent${written === 1 ? '' : 's'})`, show)
        await logDecisions(parsed, outcomes, ' (sent back)')
        return { kind: 'refuse', deny: returnNote(parsed, outcomes) }
      }
      return { kind: 'start', parsed, outcomes, script: written > 0 ? rewriteWorkflow(parsed, writes) : null }
    }

    let route: Route
    try {
      route = await decide()
    } catch (error) {
      log(`workflow routing failed, the script goes through as written: ${String(error instanceof Error ? error.message : error)}`)
      setStatus('workflow', 'workflow not routed (error: see the debug log)', show)
      return next(e)
    }
    if (route.kind === 'refuse') return { deny: route.deny }
    if (route.kind === 'pass') {
      const result = await next(e)
      await record(result, { rewritten: false, ...route.record })
      setStatus('workflow', route.status, show)
      log(`workflow${input.name === undefined ? '' : ` ${JSON.stringify(input.name)}`} let through as it is: ${route.record.reason}`)
      return result
    }

    const { parsed, outcomes, script } = route
    // The person's terms for each call, for the agents' plans as they start (the workflow-labels feature, beneath, reads them in this same call).
    const terms = outcomes.map((outcome) => (outcome.kind === 'left' ? null : termsOf(outcome.decision)))
    if (terms.some((one) => one !== null)) {
      await $.state.set({ ...TERMS, id: e.tool_use_id }, terms).catch((error: unknown) => log(`workflow ${JSON.stringify(parsed.meta.name)}: the person's terms were not kept for its agents: ${String(error)}`))
    }
    let result = await next(script === null ? e : { ...e, script })
    let rewritten = script !== null
    // The tool parses a script before it starts anything (measured on 2.1.289): a rewrite it cannot parse is dropped, once.
    if (script !== null && result.isError === true && /Invalid workflow script/.test(result.text ?? '')) {
      log(`workflow ${JSON.stringify(parsed.meta.name)}: the tool could not parse the rewritten script (${(result.text ?? '').slice(0, 160)}); started as written`)
      result = await next(e)
      rewritten = false
      if (result.isError !== true && result.deny === undefined) {
        await record(result, { rewritten: false, reason: 'rewrite failed', agents: [], left: outcomes.length })
        setStatus('workflow', 'workflow not routed (the rewritten script did not parse)', show)
        const told = "Dispatch Pilot (the user's routing plugin) wrote a model and an effort into this Workflow's agent() calls, but the tool could not use the rewritten script, so it started it as you wrote it."
        return { ...result, context: [...(result.context ?? []), told] }
      }
    }
    if (result.isError === true || result.deny !== undefined) return result

    const decided = outcomes.filter((outcome) => outcome.kind !== 'left').length
    // With no call decided, why: the decision model did not answer, or no call had a prompt to read.
    const reason = decided > 0 ? '' : outcomes.some((outcome) => outcome.kind === 'left' && outcome.failure !== undefined) ? 'failed' : 'unreadable'
    await record(result, {
      rewritten,
      reason,
      agents: outcomes.flatMap((outcome, index) => (outcome.kind === 'left' ? [] : [{ label: parsed.calls[index]?.label ?? null, model: outcome.decision.model, effort: outcome.decision.effort }])),
      left: outcomes.length - decided,
    })
    setStatus('workflow', statusText(outcomes, describe), show)
    await logDecisions(parsed, outcomes, '')
    const note = rewriteNote(parsed, outcomes, describe)
    return note === null ? result : { ...result, context: [...(result.context ?? []), note] }
  })
}

/** A request's outcome for the debug log. */
function describeAsked(asked: Asked, ms: number): string {
  if (!asked.ok) return `${asked.failure.kind}: ${asked.failure.detail} (${ms} ms)`
  const by = asked.model === null ? '' : ` by ${asked.model}`
  const tokens = asked.inputTokens === null ? '' : ` (${asked.inputTokens} input tokens)`
  return `answered in ${ms} ms${by}${tokens}`
}

/** The run id the Workflow tool's result names, when it launched a run. */
function runIdOf(result: ToolCallResult): string | null {
  const launched = result.result as { runId?: unknown } | undefined
  return typeof launched === 'object' && launched !== null && typeof launched.runId === 'string' ? launched.runId : null
}
