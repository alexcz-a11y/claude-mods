// Seam 1 for the Workflow fallback (#9): the agents of a Workflow run as the
// engine starts them. It builds on `workflowWorld` (the Workflow tool stub, the
// decision backend) without changing it.
//
// Each agent of a run passes `agent.spawn` before its first step, under the
// Workflow tool call that launched the run (2.1.294 on), with `e.workflow`
// `{ runId, agentIndex }`, its label as `description` (an agent() without a
// label is labelled with its prompt, whitespace collapsed, cut to 60
// characters) and its task as `prompt`; a model set there is the one it starts
// on (2.1.300 on). Measured on 2.1.302 (DEVELOPMENT.md, 已实测的引擎行为).
//
// Not a test file. Use it as `runWorld($, on, { backend: siteJev(...) })`.

import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { workflowWorld, type WorkflowWorldOptions } from './workflow.ts'
import type { StepOptions } from './world.ts'

/** Where the Workflow tool stub keeps its runs and the scripts it persists. */
const SESSION = '/home/u/.claude/projects/p/s1'

/** A run's directory (the tool result's `transcriptDir`). */
export function runDir(runId: string): string {
  return `${SESSION}/subagents/workflows/${runId}`
}

/** Where the tool persists the script of a run it was handed by name (`<name>-<runId>.js`) or inline (`workflow-<runId>.js`): the result's `scriptPath`. */
export function persisted(runId: string, name = 'workflow'): string {
  return `${SESSION}/workflows/scripts/${name}-${runId}.js`
}

/** What a test says of an agent the engine starts: its task (the label by default) and the model its call names. */
export type StartOptions = { prompt?: string; model?: string }

export function runWorld($: Engine, on: On, options: WorkflowWorldOptions = {}) {
  const disk: Record<string, string> = { ...(options.disk ?? {}) }
  // The engine at the bottom of tool.describe: the description as it computed it.
  on('tool.describe', (_$, e) => ({ description: e.description }))
  const w = workflowWorld($, on, { ...options, disk })
  /** How many agents each run has started (`agentIndex` counts from 1). */
  const counts = new Map<string, number>()
  /** The model each agent started on, as its spawn resolved it. */
  const models = new Map<string, string>()

  return {
    ...w,
    /** The files the mod reads, by absolute path: a test adds and removes them as the engine would. */
    disk,
    /**
     * The engine starts agent `agentId` of run `runId`: it raises agent.spawn under the run's Workflow call, labelled
     * `label` (the agent() call's label, or for a call without one the start of its prompt, as the engine shortens it).
     * Resolves to what started; the agent's steps then go out on its model unless a test names another.
     */
    started: async (runId: string, agentId: string, label: string, start: StartOptions = {}) => {
      const agentIndex = (counts.get(runId) ?? 0) + 1
      counts.set(runId, agentIndex)
      const result = await w.workflowSpawn(w.callOf(runId), { runId, agentIndex, agentId, label, prompt: start.prompt ?? label, ...(start.model === undefined ? {} : { model: start.model }) })
      if (result.model !== undefined) models.set(agentId, result.model)
      return result
    },
    /** One request of an agent's loop (its turn is `turn-<agentId>`), drained to its end; on the model it started on unless `model` names another. */
    agentStep: (agentId: string, step: Omit<StepOptions, 'agentId' | 'turnId'>) => {
      const model = step.model ?? models.get(agentId)
      return w.step({ ...step, ...(model === undefined ? {} : { model }), agentId, turnId: `turn-${agentId}` })
    },
    /** The engine renders the Workflow tool's schema: resolves to the description the model reads. */
    describeWorkflow: (description: string) => $.tool.describe({ tool: 'Workflow', description, provider: { plugin: 'engine', tier: 'core' } }),
  }
}
