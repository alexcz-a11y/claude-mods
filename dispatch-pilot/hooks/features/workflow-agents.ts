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
// The person's terms for each call (the model and effort they named, the
// models they ruled out) go to the workflow-labels feature (#9), beneath this
// one in the same call (`workflowTerms`), which puts them in the plans of the
// call's agents as they start.
//
// Its switch is `workflow-agents` (`/dp workflow-agents off`).

import type { HttpInit, On } from 'claude-code'
import { describeAsked, errorText } from '../decision/backend.ts'
import { modelFamily, termsOf } from '../decision/dispatched-agent.ts'
import { parseWorkflow, rewriteWorkflow, type ParsedWorkflow } from '../decision/workflow-script.ts'
import { callName, outcomeOf, readOutcomes, reasonOf, returnNote, rewriteNote, statusText, workflowBatches, workflowFingerprint, type CallOutcome } from '../decision/workflow.ts'
import { recordDecision } from '../core/decisions.ts'
import { update, type Cell } from '../core/plans.ts'
import { dispatchSettings, type Ctx } from '../core/setup.ts'
import { failureText, setStatus } from '../core/status.ts'
import { defineSwitch, isOn } from '../core/switches.ts'

const SAID = { plugin: 'dispatch-pilot', key: 'said' } as const
const RETURNED = { plugin: 'dispatch-pilot', key: 'returned' } as const
const TERMS = { plugin: 'dispatch-pilot', key: 'workflowTerms' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

/** The switch's name, in `/dp` and in the decision log. */
const SWITCH = 'workflow-agents'
/** At most this many sent-back Workflows are remembered. */
const MAX_RETURNED = 16

/**
 * Why a submission goes through as it is: given by `scriptPath` or `name`, or
 * resumed (inputs it does not rewrite); a script it cannot read; one without
 * agent() calls; the second submission of a Workflow it sent back.
 */
type PassReason = 'scriptPath' | 'name' | 'resume' | 'unreadable' | 'no agents' | 'second'

/** What the feature does with one submission, settled before the tool is called. */
type Route =
  /** The script goes through as it is, and the status line says `status` (null: nothing to say). */
  | { kind: 'pass'; reason: PassReason; status: string | null }
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
    if (!isOn(SWITCH)) return next(e)
    const show = (line: string | undefined) => $.ui.status(line)
    const log = (line: string) => $.ui.log(line, { to: 'debug' })

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
      const given: PassReason | null = e.scriptPath !== undefined ? 'scriptPath' : e.script === undefined || e.name !== undefined ? 'name' : e.resumeFromRunId !== undefined ? 'resume' : null
      if (given !== null || e.script === undefined) {
        const how = given === 'scriptPath' ? 'given by path' : given === 'resume' ? 'resumed from an earlier run' : 'given by name'
        return { kind: 'pass', reason: given ?? 'name', status: `workflow not routed (${how})` }
      }

      const parsed = parseWorkflow(e.script)
      if (parsed === null) return { kind: 'pass', reason: 'unreadable', status: 'workflow not routed (script not readable)' }
      if (parsed.calls.length === 0) return { kind: 'pass', reason: 'no agents', status: null }

      // A Workflow already sent back runs as it is submitted, whatever the second submission says.
      const fingerprint = workflowFingerprint(parsed)
      if (sendBack && ((await $.state.get(RETURNED)).value ?? []).includes(fingerprint)) {
        return { kind: 'pass', reason: 'second', status: 'workflow runs as written (sent back once before)' }
      }

      const { value: said = [] } = await $.state.get(SAID)
      const words = said.join('\n')
      const io = {
        fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
        sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
      }
      const plan = workflowBatches(parsed, words, settings, ctx.config.context.tokens)
      // Concurrent requests to one key can queue behind each other: each gets a share more time (a hook has 10 s).
      const timeoutMs = Math.min(BATCHES_BUDGET_MS, ctx.config.timeoutMs * plan.batches.length)
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
      log(`workflow routing failed, the script goes through as written: ${errorText(error)}`)
      setStatus('workflow', 'workflow not routed (error: see the debug log)', show)
      return next(e)
    }
    if (route.kind === 'refuse') return { deny: route.deny }
    if (route.kind === 'pass') {
      const result = await next(e)
      setStatus('workflow', route.status, show)
      log(`workflow${e.name === undefined ? '' : ` ${JSON.stringify(e.name)}`} let through as it is: ${route.reason}`)
      return result
    }

    const { parsed, outcomes, script } = route
    // The person's terms for each call, for the agents' plans as they start (the workflow-labels feature, beneath, reads them in this same call).
    const terms = outcomes.map((outcome) => (outcome.kind === 'left' ? null : termsOf(outcome.decision)))
    if (terms.some((one) => one !== null)) {
      await $.state.set({ ...TERMS, id: e.tool_use_id }, terms).catch((error: unknown) => log(`workflow ${JSON.stringify(parsed.meta.name)}: the person's terms were not kept for its agents: ${errorText(error)}`))
    }
    let result = await next(script === null ? e : { ...e, script })
    // The tool parses a script before it starts anything (measured on 2.1.289): a rewrite it cannot parse is dropped, once.
    if (script !== null && result.isError === true && /Invalid workflow script/.test(result.text ?? '')) {
      log(`workflow ${JSON.stringify(parsed.meta.name)}: the tool could not parse the rewritten script (${(result.text ?? '').slice(0, 160)}); started as written`)
      result = await next(e)
      if (result.isError !== true && result.deny === undefined) {
        setStatus('workflow', 'workflow not routed (the rewritten script did not parse)', show)
        const told = "Dispatch Pilot (the user's routing plugin) wrote a model and an effort into this Workflow's agent() calls, but the tool could not use the rewritten script, so it started it as you wrote it."
        return { ...result, context: [...(result.context ?? []), told] }
      }
    }
    if (result.isError === true || result.deny !== undefined) return result

    setStatus('workflow', statusText(outcomes, describe), show)
    await logDecisions(parsed, outcomes, '')
    const note = rewriteNote(parsed, outcomes, describe)
    return note === null ? result : { ...result, context: [...(result.context ?? []), note] }
  })
}

/** The most the requests about one script wait together: a hook has 10 s of its own. */
const BATCHES_BUDGET_MS = 8000
