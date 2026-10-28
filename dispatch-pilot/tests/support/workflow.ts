// Seam 1 for the Workflow tool (#8): the engine's Workflow tool beneath the
// mod, and a decision backend that answers each `agent()` of a script on its
// own. It builds on `world()` without changing it: the tool's stub is
// registered here, with a matcher, before `world()` registers its own, so a
// `tool.call` stub that `world()` gains later (for other tickets) sits beneath
// it and answers every other tool.
//
// What the stub answers is what the real engine answered when it was probed on
// 2.1.289: a launch comes back as `{ result: { status: 'async_launched',
// runId, scriptPath, ... }, text }`, and a script that does not parse as
// `{ isError: true, text: '<tool_use_error>Invalid workflow script: ...' }`
// before anything starts.
//
// Not a test file. Use it as `workflowWorld($, on, { backend: siteJev(...) })`.

import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { JEV_MODEL } from '../../hooks/decision/jev.ts'
import { leadsTo, world, type Reply, type Sent, type WorldOptions } from './world.ts'

/** One call that reached the Workflow tool, after every hook of the mod. */
export type Reached = {
  script?: string
  scriptPath?: string
  name?: string
  resumeFromRunId?: string
  /** False when the tool refused the script (it did not parse); nothing started. */
  launched: boolean
}

/** The Workflow tool's input, the part the tests use; `tool_use_id`, the call's id (the kit's own when absent). */
export type WorkflowInput = { script?: string; scriptPath?: string; name?: string; args?: unknown; resumeFromRunId?: string; tool_use_id?: string }

export type WorkflowWorldOptions = WorldOptions & {
  /** The engine's own parse check: the error it reports for a script it would refuse; undefined for one it launches. */
  parseError?: (script: string) => string | undefined
  /** An error of any other kind the tool reports instead of launching (its whole text); undefined for a script it launches. */
  fails?: (script: string) => string | undefined
  /**
   * What the run starts before the tool returns, given its id and the Workflow call's: the engine spawns a run's first
   * agents while the tool's `next` is still out, and returns without waiting for them (2.1.302), so a test starts them
   * here and awaits them itself.
   */
  during?: (runId: string, toolUseId: string) => Promise<unknown>
}

/** One `$.state.set` the mod made, as it reached the state beneath. */
export type StateWrite = { key: string; id: string | undefined; value: unknown }

export function workflowWorld($: Engine, on: On, options: WorkflowWorldOptions = {}) {
  const { parseError, fails, during, ...rest } = options
  const reached: Reached[] = []
  const stateWrites: StateWrite[] = []
  /** The Workflow tool call that launched each run, by the run's id: its agents' spawns come under it. */
  const callOf = new Map<string, string>()
  let runs = 0

  // What the mod writes to `$.state`, seen on its way to the state the kit keeps.
  on('state.set', async (_$, e, next) => {
    const write = e as unknown as StateWrite
    stateWrites.push({ key: write.key, id: write.id, value: write.value })
    return next(e)
  })

  // The Workflow tool itself. Registered before world()'s stubs: it is the
  // outermost stub, and the matcher keeps every other tool away from it.
  on('tool.call', { tool: 'Workflow' }, (_$, e) => {
    const input = e as WorkflowInput
    const checked = input.scriptPath === undefined && input.script !== undefined
    const parse = checked ? parseError?.(input.script as string) : undefined
    const other = checked ? fails?.(input.script as string) : undefined
    reached.push({
      ...(input.script !== undefined ? { script: input.script } : {}),
      ...(input.scriptPath !== undefined ? { scriptPath: input.scriptPath } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.resumeFromRunId !== undefined ? { resumeFromRunId: input.resumeFromRunId } : {}),
      launched: parse === undefined && other === undefined,
    })
    if (parse !== undefined) {
      return { isError: true as const, result: `Error: Invalid workflow script: ${parse}`, text: `<tool_use_error>Invalid workflow script: ${parse}</tool_use_error>` }
    }
    if (other !== undefined) return { isError: true as const, result: `Error: ${other}`, text: `<tool_use_error>${other}</tool_use_error>` }
    runs++
    const runId = `wf_test-${runs}`
    callOf.set(runId, e.tool_use_id)
    void during?.(runId, e.tool_use_id)
    const dir = '/home/u/.claude/projects/p/s1'
    // A run by `name` is persisted as `<name>-<runId>.js` (2.1.296); a script handed over inline is `workflow-<runId>.js` here.
    const path = input.scriptPath ?? `${dir}/workflows/scripts/${input.name ?? 'workflow'}-${runId}.js`
    return {
      result: { status: 'async_launched' as const, taskId: `task${runs}`, taskType: 'local_workflow' as const, runId, summary: 'a workflow', transcriptDir: `${dir}/subagents/workflows/${runId}`, scriptPath: path },
      text: `Workflow launched in background. Task ID: task${runs}\nScript file: ${path}\nRun ID: ${runId}`,
    }
  })

  const w = world($, on, rest)
  return {
    ...w,
    /** Every call that reached the Workflow tool, in order. */
    reached,
    /** Every value the mod wrote to `$.state`, in order (`key`, the family's `id`, the value). */
    stateWrites,
    /** The tool_use_id of the Workflow tool call that launched run `runId`; '' for a run no call launched here. */
    callOf: (runId: string) => callOf.get(runId) ?? '',
    /** The main agent calls the Workflow tool: resolves to what the tool, or a hook of the mod, answered. */
    workflow: (input: WorkflowInput) => $.tool.call({ tool: 'Workflow', ...input }),
  }
}

/** What the decision model answers about one `agent()` of a script. */
export type SiteAnswer = {
  /** The model the yes/no answers about the brief lead the model table to: the entry with the highest number (`leadsTo`), under any `nouls` given. */
  model?: Record<string, number>
  /** The effort levels' probabilities, lowest first. */
  effort?: readonly number[]
  /** Each yes/no question's answer by its id within the part (`named.haiku`); the rest get 0. */
  nouls?: Record<string, number>
  /** The named-effort question's probability for each option (`none`, `low` .. `max`); without it the answer is `none`. */
  namedEffort?: Record<string, number>
}

/**
 * Jev's answer to every question of a request, by its type: `of(id)` says what the question's part is given (`answer`) and the
 * question's id within the part (`local`, which the nouls and the named-effort question are looked up by). A noul the answer
 * leaves out gets what `model` leads to (`leadsTo`), else 0; an option left out gets 0; a score without levels gets `effort`
 * (medium by default).
 */
export function answerByType(request: Sent, of: (id: string) => { answer: SiteAnswer; local: string }, effort: readonly number[] = [0, 0, 1, 0, 0]): Reply {
  const out: Record<string, unknown> = {}
  const questions = (request.body?.questions ?? {}) as Record<string, { type: string; criteria?: unknown }>
  for (const [id, question] of Object.entries(questions)) {
    const { answer, local } = of(id)
    if (question.type === 'choice') {
      const options = Object.keys((question.criteria ?? {}) as Record<string, unknown>)
      const given = local === 'named_effort' ? (answer.namedEffort ?? { none: 1 }) : undefined
      const probabilities = Object.fromEntries(options.map((option) => [option, given?.[option] ?? 0]))
      const choice = options.reduce((best, option) => ((probabilities[option] ?? 0) > (probabilities[best] ?? 0) ? option : best), options[0] ?? '')
      out[id] = { type: 'choice', choice, probabilities, confidence: 0.5 }
    } else if (question.type === 'score') {
      const levels = answer.effort ?? effort
      out[id] = { type: 'score', score: levels.reduce((sum, p, i) => sum + p * i, 0), legend: {}, probabilities: Object.fromEntries(levels.map((p, i) => [String(i), p])), confidence: 0.7 }
    } else {
      out[id] = { type: 'noul', noul: answer.nouls?.[local] ?? leadsTo(answer.model)[local] ?? 0 }
    }
  }
  return { status: 200, body: { model: JEV_MODEL, answers: out, usage: { input_tokens: 400, output_tokens: 0 } } }
}

/**
 * Jev answering a Workflow's request: the questions of part `agent-<i>` as
 * `answers(i)` says; any other question (the message's own effort, asked when
 * the person sends a message) gets a plain `high`.
 */
export function siteJev(answers: (index: number) => SiteAnswer) {
  return (request: Sent): Reply =>
    answerByType(request, (id) => {
      const site = /^agent-(\d+)\.(.*)$/.exec(id)
      return { answer: site ? answers(Number(site[1])) : {}, local: site ? (site[2] as string) : id }
    })
}

/**
 * Jev answering the request of a dispatched agent (its questions are `agent.model`, `agent.effort`, ...) as `answers` says.
 * `effort`: the levels a score gets when `answers` names none.
 */
export function agentJev(answers: SiteAnswer, effort?: readonly number[]) {
  return (request: Sent): Reply => answerByType(request, (id) => ({ answer: answers, local: id.slice(id.indexOf('.') + 1) }), effort)
}
