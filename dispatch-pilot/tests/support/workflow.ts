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
import { world, type Reply, type Sent, type WorldOptions } from './world.ts'

/** One call that reached the Workflow tool, after every hook of the mod. */
export type Reached = {
  script?: string
  scriptPath?: string
  name?: string
  resumeFromRunId?: string
  /** False when the tool refused the script (it did not parse); nothing started. */
  launched: boolean
}

/** The Workflow tool's input, the part the tests use. */
export type WorkflowInput = { script?: string; scriptPath?: string; name?: string; args?: unknown; resumeFromRunId?: string }

export type WorkflowWorldOptions = WorldOptions & {
  /** The engine's own parse check: the error it reports for a script it would refuse; undefined for one it launches. */
  parseError?: (script: string) => string | undefined
  /** An error of any other kind the tool reports instead of launching (its whole text); undefined for a script it launches. */
  fails?: (script: string) => string | undefined
}

/** One `$.state.set` the mod made, as it reached the state beneath. */
export type StateWrite = { key: string; id: string | undefined; value: unknown }

export function workflowWorld($: Engine, on: On, options: WorkflowWorldOptions = {}) {
  const { parseError, fails, ...rest } = options
  const reached: Reached[] = []
  const stateWrites: StateWrite[] = []
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
    const dir = '/home/u/.claude/projects/p/s1'
    const path = input.scriptPath ?? `${dir}/workflows/scripts/workflow-${runId}.js`
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
    /** The main agent calls the Workflow tool: resolves to what the tool, or a hook of the mod, answered. */
    workflow: (input: WorkflowInput) => $.tool.call({ tool: 'Workflow', ...input }),
  }
}

/** What the decision model answers about one `agent()` of a script. */
export type SiteAnswer = {
  /** The model question's probability for each option (an option left out gets 0). */
  model?: Record<string, number>
  /** The effort levels' probabilities, lowest first. */
  effort?: readonly number[]
  /** Each yes/no question's answer by its id within the part (`named.haiku`); the rest get 0. */
  nouls?: Record<string, number>
  /** The named-effort question's probability for each option (`none`, `low` .. `max`); without it the answer is `none`. */
  namedEffort?: Record<string, number>
}

/**
 * Jev answering a Workflow's request: the questions of part `agent-<i>` as
 * `answers(i)` says; any other question (the message's own effort, asked when
 * the person sends a message) gets a plain `high`.
 */
export function siteJev(answers: (index: number) => SiteAnswer) {
  return (request: Sent): Reply => {
    const out: Record<string, unknown> = {}
    const questions = (request.body?.questions ?? {}) as Record<string, { type: string; criteria?: unknown }>
    for (const [id, question] of Object.entries(questions)) {
      const site = /^agent-(\d+)\.(.*)$/.exec(id)
      const answer: SiteAnswer = site ? answers(Number(site[1])) : {}
      const local = site ? (site[2] as string) : id
      if (question.type === 'choice') {
        const options = Object.keys((question.criteria ?? {}) as Record<string, unknown>)
        const given = local === 'named_effort' ? (answer.namedEffort ?? { none: 1 }) : answer.model
        const probabilities = Object.fromEntries(options.map((option) => [option, given?.[option] ?? 0]))
        const choice = options.reduce((best, option) => ((probabilities[option] ?? 0) > (probabilities[best] ?? 0) ? option : best), options[0] ?? '')
        out[id] = { type: 'choice', choice, probabilities, confidence: 0.5 }
      } else if (question.type === 'score') {
        const levels = answer.effort ?? [0, 0, 1, 0, 0]
        out[id] = { type: 'score', score: levels.reduce((sum, p, i) => sum + p * i, 0), legend: {}, probabilities: Object.fromEntries(levels.map((p, i) => [String(i), p])), confidence: 0.7 }
      } else {
        out[id] = { type: 'noul', noul: answer.nouls?.[local] ?? 0 }
      }
    }
    return { status: 200, body: { model: 'jev-1.13.0', answers: out, usage: { input_tokens: 400, output_tokens: 0 } } }
  }
}
