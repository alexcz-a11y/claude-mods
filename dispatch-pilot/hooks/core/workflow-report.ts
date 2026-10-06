// What the Workflow features hand the 「决定汇报」 module (core/report.ts): the
// decisions made about the `agent()` calls of one Workflow script, one report
// each, and the word that a whole Workflow is not routed.
//
// An agent of a Workflow has no id until it starts, so before that each call
// of the script stands for its agent on the board: a node of kind `wf`, queued,
// under the id `<tool_use_id>#<index>` (the Workflow call's own id, the call's
// place in the script) and in the Workflow `<tool_use_id>`. A Workflow that is
// not routed as a whole (a script given by path, an error) is one node under
// the Workflow call's id itself.
//
// Pure (see report.ts: `$` stays in the hook owner's file).

import { failureText } from '../decision/backend.ts'
import { dispatchEvidence, modelFamily } from '../decision/dispatched-agent.ts'
import { parseWorkflow, type ParsedWorkflow } from '../decision/workflow-script.ts'
import { callName, leftText, outcomeOf, reasonOf, type CallOutcome } from '../decision/workflow.ts'
import type { Left, ReportedDecision } from './report.ts'

/** The Workflow call a report is about: the tool call's id, and the script it ran, as far as it was read. */
export type WorkflowRun = { id: string; parsed: ParsedWorkflow }

/** The Workflow a script is, in a few words: its name. */
export function workflowTitle(parsed: ParsedWorkflow): string {
  return parsed.meta.name ?? 'unnamed'
}

/** What a Workflow tool call is called when its script is not (all) read: the name or the path it was given, else the script's own name. */
export function workflowCallTitle(input: { name?: string; scriptPath?: string; script?: string }): string {
  if (input.name !== undefined) return input.name
  if (input.scriptPath !== undefined) return /([^/\\]+?)(?:\.[^./\\]*)?$/.exec(input.scriptPath)?.[1] ?? 'Workflow'
  const parsed = input.script === undefined ? null : parseWorkflow(input.script)
  return parsed === null ? 'Workflow' : workflowTitle(parsed)
}

/**
 * One report for each call of the script that has an outcome: a decision made
 * (`outcome` adds `suffix`: ` (sent back)`; `sentBack` says so as data), or
 * why the call is left as written. `thetaOverride`: the setting the reasons
 * read; `backend`: the decision model's name, for a failed request's words.
 */
export function callReports(
  feature: string,
  run: WorkflowRun,
  outcomes: readonly CallOutcome[],
  options: { backend: string; thetaOverride: number; suffix?: string; sentBack?: true },
): ReportedDecision[] {
  const title = workflowTitle(run.parsed)
  return outcomes.flatMap((outcome, index): ReportedDecision[] => {
    const call = run.parsed.calls[index]
    if (call === undefined) return []
    const about = {
      feature,
      agent: `${run.id}#${call.index}`,
      subject: `${callName(call)} (workflow ${title})`,
      node: { kind: 'wf' as const, name: call.label ?? `agent() at line ${call.line}`, type: call.agentType ?? 'workflow', state: 'queued' as const, workflow: { id: run.id, name: title } },
    }
    if (outcome.kind === 'left') {
      return [outcome.failure !== undefined ? { ...about, routed: false, failure: { backend: options.backend, ...outcome.failure } } : { ...about, why: leftText(outcome, (failure) => failureText(options.backend, failure)) }]
    }
    const decision = outcome.decision
    const requested = call.model.kind === 'literal' ? modelFamily(call.model.value) : null
    const family = decision.model ?? requested
    return [
      {
        ...about,
        routed: true,
        outcome: `${outcomeOf(call, decision)}${options.suffix ?? ''}`,
        reason: reasonOf(decision, requested, options.thetaOverride),
        ...dispatchEvidence(decision),
        ...(family === null ? {} : { model: family }),
        ...(decision.effort === null ? {} : { effort: decision.effort }),
        written: outcome.kind === 'written',
        ...(options.sentBack === true ? { sentBack: true as const } : {}),
      },
    ]
  })
}

/**
 * A Workflow that is not routed as a whole: `why`, in a few words, null when
 * there is nothing to show of it (a script with no agent() call). `agent`:
 * the node's id, the Workflow call's own unless a feature has a second thing to say of it.
 */
export function workflowLeft(feature: string, run: { id: string; title: string }, why: string | null, extra: { asWritten?: true; agent?: string } = {}): Left {
  return {
    feature,
    agent: extra.agent ?? run.id,
    subject: run.title,
    why: why ?? '',
    node: { kind: 'wf', name: run.title, type: 'workflow', state: 'done' },
    ...(why === null ? { offBoard: true as const } : {}),
    ...(extra.asWritten === true ? { asWritten: true as const } : {}),
  }
}
