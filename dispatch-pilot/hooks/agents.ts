// The judgement made when an agent is dispatched (design 5.5): the model to give it, the effort for its steps, and
// the Decision. Pure: no $ calls. The entry's agent.spawn hook reads state, asks, calls settleSpawn, and writes.
import type { AgentSpawnInput } from 'claude-code'

import { noulOf, scoreOf } from './backend.ts'
import type { AskResult } from './backend.ts'
import type { Config } from './config.ts'
import { agentPlan, thresholdsFor } from './decide.ts'
import type { Level, Tier } from './levels.ts'
import type { Decision } from './log.ts'
import type { TurnState } from './state.ts'

/** What a spawn's answers make of the agent: the model to give it, the effort for its steps, and the Decision. */
export type Spawned = { model: Tier | null; effort: Level | null; decision: Omit<Decision, 'id' | 'at'> }

// The agent's model and effort from the answers (design 5.5). Pure. `r` is null when nothing was asked. Only the
// model goes into the spawn, and only when the call named none: the plan's tier when it differs from the inherited
// one; without a plan (not asked, or the ask failed) only the fableAgents cap, a configuration rule that holds
// whatever the decision model did. In shadow mode nothing is given, and the Decision records what would have been.
export function settleSpawn(r: AskResult | null, c: { cfg: Config; e: AgentSpawnInput; tier: Tier | null; level: Level | null; turn: TurnState | null }): Spawned {
  const { cfg, e, tier, level } = c
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
  let chosen: Tier | null = null
  if (e.model === undefined) {
    if (plan !== null) chosen = plan.model !== null && plan.model !== tier ? plan.model : null
    else if (tier === 'fable' && !cfg.fableAgents) chosen = 'opus'
  }
  const effort = plan?.effort ?? null
  const applies = cfg.mode === 'apply'
  const failed = r !== null && !r.ok ? r : null
  const decision: Omit<Decision, 'id' | 'at'> = {
    kind: 'agent',
    backend: r?.backend ?? null,
    model: ok?.model ?? null,
    ms: r?.ms ?? 0,
    raw: a ?? null,
    from: `${tier ?? 'inherit'} · ${level ?? '—'}`,
    // The model the agent is given: the mod's alias, else the one the call named, else the parent's.
    to: `${chosen ?? e.model ?? 'inherit'} · ${effort ?? '—'}`,
    reason: plan?.reason ?? null,
    detail: e.subagentType,
    turnId: c.turn?.turnId ?? null,
    step: c.turn?.journal.workSteps ?? null,
    bars,
    failure: failed?.reason ?? null,
    requestId: failed?.requestId ?? null,
    // The model is changed, or an effort will be written on the agent's steps that carry a level.
    applied: applies && (chosen !== null || effort !== null),
    sent: null,
  }
  return { model: applies ? chosen : null, effort: applies ? effort : null, decision }
}
