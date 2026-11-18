// An agent dispatched (design 5.5): the judgement at agent.spawn, its entry, the effort on its steps, and its check.
import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, EngineInterface, TurnStepInput } from 'claude-code'

import { settleSpawn } from '../agents.ts'
import type { Spawned } from '../agents.ts'
import { ask } from '../backend.ts'
import type { Config } from '../config.ts'
import { isLevel, tierOfModelId } from '../levels.ts'
import { decisionId } from '../log.ts'
import { agentQuestions } from '../questions.ts'
import { agentSent } from '../readout.ts'
import { amendSent, ioOf, record, verifies } from '../runtime.ts'
import { emptySession } from '../state.ts'
import type { AgentState } from '../state.ts'
import { agentState } from '../statebuild.ts'

// The state atoms this file reads and writes, one line each and alike in every file that declares them: the module
// scan takes only a const of the file that reads or writes (eval/validate.ts checks the copies are the same text).
const SESSION = atom({ plugin: 'dispatch-pilot', key: 'session' } as const, emptySession())
const TURN = atom({ plugin: 'dispatch-pilot', key: 'turn' } as const, null)

// The agents family (by agentId) is addressed with a literal reference at each read and write, which the module
// scan requires; an agent the mod did not handle at its spawn has no entry.

// The judgement when an agent is dispatched (design 5.5): the hook waits here for the answer, up to agentTimeoutMs.
// Null: an agent this mod leaves alone. A resumed run keeps what it had, a fork shares the parent's prompt cache
// (another model would lose it), and a workflow's script decides its own agents.
export async function planSpawn($: EngineInterface, cfg: Config, e: AgentSpawnInput): Promise<Spawned | null> {
  if (!cfg.enabled || e.resume !== undefined || e.fork || e.workflow !== undefined) return null
  const session = await read($, SESSION)
  const turn = await read($, TURN)
  // What the agent inherits: the main turn's level and the parent's tier (null for an id that names no family,
  // such as opusplan: then the model is never changed).
  const level = turn?.wanted ?? turn?.base ?? null
  const tier = tierOfModelId(e.parentModel)
  const asking = cfg.agentShift && session.lock === null
  const state = agentState({ task: e.prompt, agentType: e.subagentType, description: e.description })
  const r = asking ? await ask(ioOf($), cfg, { state, questions: agentQuestions() }, cfg.agentTimeoutMs) : null
  return settleSpawn(r, { cfg, e, tier, level, turn })
}

// The spawn started an agent: its entry (an effort of null: not handled, its steps are left alone) and the Decision.
// Every spawn keeps its own values here and writes its own key; record() serialises the shared log, so spawns in
// flight at once do not mix.
export async function keepAgent($: EngineInterface, s: Spawned, agentId: string): Promise<null> {
  const at = await $.clock.now()
  const id = decisionId(at)
  await update($, { plugin: 'dispatch-pilot', key: 'agents', id: agentId } as const, () => ({ effort: s.effort, isEffortExplicit: null, decisionId: id, steps: 0 }))
  await record($, { ...s.decision, id, at })
  return null
}

/** A step as it goes on, and the agent whose check is due beside it (null: none). */
export type Stepped = { step: TurnStepInput; check: AgentState | null }

// An agent's branch of turn.step: the effort decided at its spawn, on every step whose effort is a level, unless the
// agent's own definition or call set one. The engine starts the agent inside agent.spawn's next(e), so its first
// step can come before that next has answered with the agentId (measured: usually about 70 ms after, design 9).
// Such a step finds no entry and goes as it came; the entry is written as soon as next answers, and the steps after
// it carry the effort. Nothing is held for it: the step has no tool_use_id to tie it to the spawn waiting.
export async function agentStep($: EngineInterface, cfg: Config, e: TurnStepInput, agentId: string): Promise<Stepped> {
  const held = await read($, { plugin: 'dispatch-pilot', key: 'agents', id: agentId } as const)
  if (held === undefined) return { step: e, check: null }
  // At the second step the mod saw, the first one's request is the agent's last: the check is due, beside this step.
  const check = verifies(cfg) && held.steps === 1 ? held : null
  const effort = held.effort
  const writes = cfg.enabled && cfg.mode === 'apply' && effort !== null && isLevel(e.effort)
  let explicit = held.isEffortExplicit
  if (writes && explicit === null) {
    // Once per agent: what the list says does not change for it. An agent the list does not show counts as not explicit.
    const listed = (await $.agent.list()).find((a) => a.id === agentId)
    explicit = listed?.effort !== undefined
  }
  await update($, { plugin: 'dispatch-pilot', key: 'agents', id: agentId } as const, (cur) => {
    const was = cur ?? held
    return { ...was, steps: was.steps + 1, isEffortExplicit: was.isEffortExplicit ?? explicit }
  })
  return { step: writes && explicit !== true && effort !== null ? { ...e, effort } : e, check }
}

// An agent's check (design 5.12): $.agent.list()'s lastRequest, the documented reading, read once after the first step
// the mod saw, against the effort decided at its spawn. A spawn that decided no effort (shadow, a failed ask) is not checked.
export async function checkAgent($: EngineInterface, agentId: string, held: AgentState): Promise<null> {
  const { effort, decisionId: id } = held
  if (effort === null || id === null) return null
  const listed = (await $.agent.list()).find((a) => a.id === agentId)
  await amendSent($, id, agentSent(effort, listed?.lastRequest))
  return null
}

// An agent that ends after the one step the mod saw is checked at its turn.complete: no second step comes to do it.
export async function endAgent($: EngineInterface, agentId: string): Promise<null> {
  const held = await read($, { plugin: 'dispatch-pilot', key: 'agents', id: agentId } as const)
  return held !== undefined && held.steps === 1 ? checkAgent($, agentId, held) : null
}
