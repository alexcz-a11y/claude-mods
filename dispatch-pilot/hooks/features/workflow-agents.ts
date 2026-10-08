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
import { describeAsked, errorText, failureText, type BackendIo } from '../decision/backend.ts'
import { termsOf } from '../decision/dispatched-agent.ts'
import { parseWorkflow, rewriteWorkflow, type ParsedWorkflow } from '../decision/workflow-script.ts'
import { batchesTimeoutMs, readOutcomes, returnNote, rewriteNote, workflowBatches, workflowFingerprint, type CallOutcome } from '../decision/workflow.ts'
import { update, type Cell } from '../core/plans.ts'
import { report, type ReportIo } from '../core/report.ts'
import { dispatchSettings, type Ctx } from '../core/setup.ts'
import { defineSwitch, isOn } from '../core/switches.ts'
import { callReports, workflowCallTitle, workflowLeft } from '../core/workflow-report.ts'

const SAID = { plugin: 'dispatch-pilot', key: 'said' } as const
const RETURNED = { plugin: 'dispatch-pilot', key: 'returned' } as const
const TERMS = { plugin: 'dispatch-pilot', key: 'workflowTerms' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
const PPLX_RATE = { plugin: 'dispatch-pilot', key: 'pplxRate' } as const

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
  /** The script goes through as it is, and the board says `why` (null: nothing to say), `asWritten`: by design, not a miss. */
  | { kind: 'pass'; reason: PassReason; why: string | null; asWritten?: true }
  /** The Workflow is sent back (return mode). */
  | { kind: 'refuse'; deny: string }
  /** The tool is called with `script` (null: as submitted), the decisions in `outcomes`. */
  | { kind: 'start'; parsed: ParsedWorkflow; outcomes: CallOutcome[]; script: string | null }

export function registerWorkflowAgents(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: '主 agent 提交 Workflow 时，决定脚本里每个 agent() 的模型和 effort' })
  const settings = dispatchSettings(ctx)
  const describe = (failure: Parameters<typeof failureText>[1]) => failureText(ctx.backend.name, failure)
  // `rewrite` (the default) writes the decisions into the script; `return` sends the Workflow back with them, once.
  const sendBack = ctx.config.agents.workflowMode === 'return'

  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    if (!isOn(SWITCH)) return next(e)
    const log = (line: string) => $.ui.log(line, { to: 'debug' })
    const reporting: ReportIo = {
      board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
      decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
      debug: log,
      now: () => $.clock.now(),
      toast: (text) => $.ui.toast(text),
    }
    /** The Workflow as a whole is not routed: say why on the board (null: nothing to say of it). */
    const notRouted = (why: string | null, extra: { asWritten?: true } = {}) => report(reporting, { decision: workflowLeft(SWITCH, { id: e.tool_use_id, title: workflowCallTitle(e) }, why, extra) })
    /** One report for each call of the script: the decisions made, and why the others are left as written. */
    const reportCalls = (parsed: ParsedWorkflow, outcomes: readonly CallOutcome[], options: { suffix?: string; sentBack?: true } = {}) =>
      report(reporting, { decisions: callReports(SWITCH, { id: e.tool_use_id, parsed }, outcomes, { backend: ctx.backend.name, thetaOverride: settings.thetaOverride, ...options }) })

    /** Settles what to do with this submission: asks the decision model, and reads its answers. */
    const decide = async (): Promise<Route> => {
      // What this does not rewrite: a script given by path or name, or resumed (its cache matches on each call's prompt and options).
      const given: PassReason | null = e.scriptPath !== undefined ? 'scriptPath' : e.script === undefined || e.name !== undefined ? 'name' : e.resumeFromRunId !== undefined ? 'resume' : null
      if (given !== null || e.script === undefined) {
        const how = given === 'scriptPath' ? '按路径提交，没有改写' : given === 'resume' ? '接着早先的运行，没有改写' : '按名字提交，没有改写'
        return { kind: 'pass', reason: given ?? 'name', why: how }
      }

      const parsed = parseWorkflow(e.script)
      if (parsed === null) return { kind: 'pass', reason: 'unreadable', why: '读不懂这个脚本' }
      if (parsed.calls.length === 0) return { kind: 'pass', reason: 'no agents', why: null }

      // A Workflow already sent back runs as it is submitted, whatever the second submission says.
      const fingerprint = workflowFingerprint(parsed)
      if (sendBack && ((await $.state.get(RETURNED)).value ?? []).includes(fingerprint)) {
        return { kind: 'pass', reason: 'second', why: '早先退回过一次，这次照原样运行', asWritten: true }
      }

      const { value: said = [] } = await $.state.get(SAID)
      const words = said.join('\n')
      const io: BackendIo = {
        fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
        sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
        pace: { now: () => $.clock.now(), sent: { get: () => $.state.get(PPLX_RATE), set: (value, options) => $.state.set(PPLX_RATE, value, options) } },
      }
      const plan = workflowBatches(parsed, words, settings, ctx.config.contextByKind.workflow)
      const timeoutMs = batchesTimeoutMs(ctx.config.timeoutMs, plan.batches.length)
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
        await reportCalls(parsed, outcomes, { suffix: '（已退回）', sentBack: true })
        return { kind: 'refuse', deny: returnNote(parsed, outcomes) }
      }
      return { kind: 'start', parsed, outcomes, script: written > 0 ? rewriteWorkflow(parsed, writes) : null }
    }

    let route: Route
    try {
      route = await decide()
    } catch (error) {
      log(`workflow routing failed, the script goes through as written: ${errorText(error)}`)
      await notRouted('出错了，详见 debug log')
      return next(e)
    }
    if (route.kind === 'refuse') return { deny: route.deny }
    if (route.kind === 'pass') {
      const result = await next(e)
      await notRouted(route.why, route.asWritten === true ? { asWritten: true } : {})
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
        await notRouted('改写后的脚本解析不了')
        const told = "Dispatch Pilot (the user's routing plugin) wrote a model and an effort into this Workflow's agent() calls, but the tool could not use the rewritten script, so it started it as you wrote it."
        return { ...result, context: [...(result.context ?? []), told] }
      }
    }
    if (result.isError === true || result.deny !== undefined) return result

    await reportCalls(parsed, outcomes)
    const note = rewriteNote(parsed, outcomes, describe)
    return note === null ? result : { ...result, context: [...(result.context ?? []), note] }
  })
}
