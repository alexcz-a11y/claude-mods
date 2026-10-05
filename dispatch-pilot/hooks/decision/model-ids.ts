// The model id a step names for each model family a decision picks.
//
// A plan's `model` goes out as `turn.step`'s `model`, which the engine sends to
// the API exactly as written: an alias is not resolved there (measured on
// 2.1.289: `model: 'haiku'` on a workflow agent's step is a 404, `model:
// haiku`, and the agent fails; `claude-haiku-4-5` runs, answered by
// `claude-haiku-4-5-20251001`). So whatever writes a model into the plan table
// writes the id below, never the alias. `agent.spawn` resolves aliases itself:
// the dispatched-agents feature (#6) keeps writing aliases there.
//
// The ids are the current models of each family, as Claude Code 2.1.289 names
// them. Update them here when a family gets a new model.
//
// Pure (see system-one.ts).

import { AGENT_MODELS, modelFamily, type AgentModel } from './dispatched-agent.ts'

export const MODEL_IDS: Readonly<Record<AgentModel, string>> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  // Seen as the advisor model's id in 2.1.289's debug log; no workflow agent ran on it yet.
  fable: 'claude-fable-5-1',
}

/** The id a step names to run on `family`. */
export function modelId(family: AgentModel): string {
  return MODEL_IDS[family]
}

/** A model a person or an option names, as a step names it: its family and the full id. */
export type ResolvedModel = { family: AgentModel; id: string }

/**
 * A model as written in an option: a family's alias (`sonnet`) is resolved to
 * its id (MODEL_IDS), an id that names a family (`claude-sonnet-5-5`) is kept as
 * it is; null for anything else (no family to tell, so no step may name it).
 */
export function resolveModel(written: string): ResolvedModel | null {
  const name = written.trim()
  const alias = AGENT_MODELS.find((family) => family === name.toLowerCase())
  if (alias !== undefined) return { family: alias, id: modelId(alias) }
  const family = modelFamily(name)
  return family === null ? null : { family, id: name }
}
