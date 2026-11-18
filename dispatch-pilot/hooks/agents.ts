// The judgement made when an agent is dispatched (design 5.5): the model to give it, the effort for its steps, and
// the Decision. Pure: no $ calls. The entry's agent.spawn hook reads state, asks, calls settleSpawn, and writes.
import type { AgentSpawnInput } from 'claude-code'

import { noulOf, scoreOf } from './backend.ts'
import type { AskResult } from './backend.ts'
import type { Config } from './config.ts'
import { agentPlan, thresholdsFor } from './decide.ts'
import type { Level, Tier } from './levels.ts'
import type { Decision } from './log.ts'
import type { AgentType, TurnState } from './state.ts'

/** The agent types a session keeps what it learned of; past this many the oldest learned goes. */
export const AGENT_TYPES_KEEP = 32

/** What is known of a type under this parent: its entry when learned under the same parent tier, else null. */
export function knownType(held: readonly AgentType[], type: string, parentTier: Tier | null): AgentType | null {
  const t = held.find((x) => x.type === type)
  return t !== undefined && t.parentTier === parentTier ? t : null
}

/** The types once one is learned (again): its old entry dropped, the new one last, the oldest gone past the bound. */
export function learnType(held: readonly AgentType[], t: AgentType): AgentType[] {
  return [...held.filter((x) => x.type !== t.type), t].slice(-AGENT_TYPES_KEEP)
}

/** The detail after a spawn's type when its model was left alone for want of knowing whether the type follows the parent's. */
export const UNKNOWN_TYPE = '模型没动：还不知道这个类型是否沿用主 agent 的模型'

/** An agent Decision's type: its detail without the note a spawn may add after it (UNKNOWN_TYPE). */
export function agentTypeOf(d: { detail: string }): string {
  const at = d.detail.indexOf(' · ')
  return at === -1 ? d.detail : d.detail.slice(0, at)
}

/**
 * What a spawn's answers make of the agent: the model to give it, the effort for its steps, and the Decision (null: a
 * spawn nothing was asked of and nothing changed, which records nothing); learn: the type to learn from what the
 * engine answers (the mod gave no model and the call named none), else null.
 */
export type Spawned = { model: Tier | null; effort: Level | null; decision: Omit<Decision, 'id' | 'at'> | null; learn: { type: string; parentTier: Tier | null } | null }

// The agent's model and effort from the answers (design 5.5). Pure. `r` is null when nothing was asked; `known` is what
// a spawn of this type under the same parent tier taught (knownType). A call that names no model runs on its type's own
// model when the definition has one, else on the parent's (types, AgentSpawnInput.model; measured on 2.1.327), so a
// model is given only to a type known to follow the parent's, and never above it: the plan's tier when it differs from
// the parent's, or without a plan (not asked, or the ask failed) the fableAgents cap, a configuration rule that holds
// whatever the decision model did. Any other spawn's model is left as it is: the first of each type under a parent is
// neither capped nor shifted. In shadow mode nothing is given, and the Decision records what would have been.
export function settleSpawn(r: AskResult | null, c: { cfg: Config; e: AgentSpawnInput; tier: Tier | null; level: Level | null; turn: TurnState | null; known: AgentType | null }): Spawned {
  const { cfg, e, tier, level, known } = c
  const ok = r !== null && r.ok ? r : null
  const bars = ok === null ? null : thresholdsFor(ok.backend, ok.model, 'agent')
  const a = ok?.answers
  const plan =
    a === undefined || bars === null
      ? null
      : agentPlan(
          { level, tier },
          { open: scoreOf(a.open), mechanical: noulOf(a.mechanical), unknownCause: noulOf(a.unknown_cause), readOnly: noulOf(a.read_only) },
          { agentModels: cfg.agentModels, fableAgents: cfg.fableAgents },
          bars,
        )
  const inherits = known !== null && tier !== null && known.tier === tier
  let chosen: Tier | null = null
  if (e.model === undefined && inherits) {
    if (plan !== null) chosen = plan.model !== null && plan.model !== tier ? plan.model : null
    else if (tier === 'fable' && !cfg.fableAgents) chosen = 'opus'
  }
  // Left alone for want of knowledge: the type not seen under this parent yet (a parent with no tier changes nothing).
  const unknown = e.model === undefined && tier !== null && known === null
  const effort = plan?.effort ?? null
  const applies = cfg.mode === 'apply'
  const failed = r !== null && !r.ok ? r : null
  const decision: Omit<Decision, 'id' | 'at'> | null = r === null && chosen === null ? null : {
    kind: 'agent',
    backend: r?.backend ?? null,
    model: ok?.model ?? null,
    ms: r?.ms ?? 0,
    raw: a ?? null,
    // The type's own tier as learned (the parent's when it follows it); ? when not known.
    from: `${known?.tier ?? '?'} · ${level ?? '—'}`,
    // The model the agent is given: the mod's alias, else the one the call named, else the parent's.
    to: `${chosen ?? e.model ?? 'inherit'} · ${effort ?? '—'}`,
    reason: plan?.reason ?? null,
    detail: unknown ? `${e.subagentType} · ${UNKNOWN_TYPE}` : e.subagentType,
    turnId: c.turn?.turnId ?? null,
    step: c.turn?.journal.workSteps ?? null,
    bars,
    failure: failed?.reason ?? null,
    requestId: failed?.requestId ?? null,
    // The model is changed, or an effort will be written on the agent's steps that carry a level.
    applied: applies && (chosen !== null || effort !== null),
    sent: null,
  }
  const model = applies ? chosen : null
  return { model, effort: applies ? effort : null, decision, learn: e.model === undefined && model === null ? { type: e.subagentType, parentTier: tier } : null }
}
