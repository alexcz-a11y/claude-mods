// The plan table: what each turn of each loop should go out with, and the
// pure operations on it. The values live in $.state (types/index.d.ts); the
// core's turn.step writer reads them on every step.

import type { TurnStepInput } from 'claude-code'
import type { StateCell } from '../decision/backend.ts'
import { modelFamily, type Terms } from '../decision/dispatched-agent.ts'
import { higherEffort, isEffort, type Effort } from '../decision/effort.ts'
import type { TurnFacts } from '../decision/escalation.ts'

/** What a loop's steps go out with. Each slot has its owner; the writer combines them (planStep). */
export type Plan = {
  /** The routed effort: the latest decision for the scope; null leaves the engine's. */
  effort: Effort | null
  /** No step goes below it (an agent's model floor); null for none. */
  floor: Effort | null
  /** The model a dispatched or workflow agent's steps name (a full id); null leaves the engine's. Never applied to main (ADR 0001). */
  model: string | null
}

/**
 * A dispatched or workflow agent's plan for all its turns: a Plan, and the
 * person's own terms for its work (the model and the effort they named, the
 * models they ruled out), which everything that writes the plan keeps to.
 */
export type AgentPlan = Plan & { terms: Terms | null }

/** One turn of one loop: its plan, plus what the decisions about it need to know. */
export type TurnRecord = Plan & {
  /** The text the main turn started with, redacted and clipped; '' when unknown. */
  prompt: string
  /** Decisions made for the turn: the one at its start, then those of messages typed into it. */
  decisions: number
  /** Times the routed effort moved from one decided level to another. */
  changes: number
  /** Whether the person's own message started the turn, decided at its start or not: only such a turn keeps its facts. */
  person: boolean
  /** What the turn did (features/escalation.ts), written as a turn the person's own message started ends; absent until then. */
  facts?: TurnFacts
}

/**
 * A prompt's decided effort, waiting for the turn the prompt starts. `effort`
 * null: the person's message whose decision failed (its turn is still theirs).
 */
export type PendingDecision = { text: string; effort: Effort | null; at: number; /** A report (a dispatched agent's hand-back, a task notice) started this turn, not the person's own message. */ report?: true }

/** The main agent's name wherever loops go by agent: in turn keys (`main:<turnId>`) and as its id in the `escalation` table. */
export const MAIN = 'main'

/** The turns-table id of a step's turn: `main:<turnId>` or `<agentId>:<turnId>`. */
export function turnKey(turnId: string, agentId: string | undefined): string {
  return `${agentId ?? MAIN}:${turnId}`
}

/** A main turn's record as it starts: with the effort its prompt was decided at (or none), and whether the person's message started it. */
export function newTurn(prompt: string, effort: Effort | null, person: boolean): TurnRecord {
  return { effort, floor: null, model: null, prompt, decisions: effort === null ? 0 : 1, changes: 0, person }
}

/** The record after a new decision for the turn (`record` undefined: a turn whose start was not seen). */
export function revise(record: TurnRecord | undefined, effort: Effort): TurnRecord {
  const base = record ?? newTurn('', null, false)
  const moved = base.effort !== null && base.effort !== effort
  return { ...base, effort, decisions: base.decisions + 1, changes: base.changes + (moved ? 1 : 0) }
}

/** At most this many decisions wait for their turns. */
export const MAX_PENDING = 16

/** The waiting list with `entry` added last (the oldest dropped past MAX_PENDING). */
export function addPending(list: readonly PendingDecision[], entry: PendingDecision): PendingDecision[] {
  return [...list, entry].slice(-MAX_PENDING)
}

/**
 * Takes the decision of the prompt that started a turn: the newest entry
 * whose text is the first of `texts` that has one. The rest wait on.
 */
export function takePending(list: readonly PendingDecision[], texts: readonly string[]): { taken: PendingDecision | null; rest: PendingDecision[] } {
  for (const text of texts) {
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i] as PendingDecision
      if (entry.text === text) return { taken: entry, rest: [...list.slice(0, i), ...list.slice(i + 1)] }
    }
  }
  return { taken: null, rest: [...list] }
}

/** What the writer reads for one step. */
export type StepPlans = {
  /** The person's lock on the main agent's effort; ignored on other loops. */
  lock: Effort | null
  /** The plan of the step's turn (`turns`, by turnKey). */
  turn: Plan | undefined
  /** The plan of the step's agent for all its turns (`agents`, by agentId); ignored on main. */
  agent: (Plan & { terms?: Terms | null }) | undefined
}

/** Where a step's effort came from: the person's lock, a plan, or the engine (nothing planned). */
export type EffortSource = 'locked' | 'planned' | 'engine'

/**
 * The step as the plans say to send it.
 *
 * Model: never on the main agent (ADR 0001); on another loop the turn's, else
 * its agent's, else the engine's: the step's effective model.
 *
 * Effort: on main, a lock wins. Otherwise an effort the person named for the
 * agent's work wins (no floor lifts it); else the routed effort (the turn's,
 * else on another loop its agent's), lifted to the floor (the higher of the
 * turn's and the agent's), a floor lifting the engine's own effort when
 * nothing is routed. Every family takes an effort, haiku too since Haiku 5.5 (spec #32
 * held haiku without one, as Haiku 4.5 took none). A step the engine gave no
 * effort (a model that takes none) keeps none, unless a plan moves it onto
 * another family: that one gets its planned effort. A step with a numeric
 * effort keeps it.
 */
export function planStep(e: TurnStepInput, plans: StepPlans): { step: TurnStepInput; source: EffortSource } {
  const main = e.agentId === undefined
  const agent = main ? undefined : plans.agent
  const engine = isEffort(e.effort) ? e.effort : null
  const model = main ? null : (plans.turn?.model ?? agent?.model ?? null)
  const family = modelFamily(model ?? e.model)
  let effort: Effort | null
  let source: EffortSource
  if (main && plans.lock !== null) {
    effort = plans.lock
    source = 'locked'
  } else {
    const named = agent?.terms?.effort ?? null
    const routed = plans.turn?.effort ?? agent?.effort ?? null
    const floor = higherEffort(plans.turn?.floor ?? null, agent?.floor ?? null)
    effort = named ?? (floor === null ? routed : higherEffort(routed ?? engine, floor))
    source = effort === null ? 'engine' : 'planned'
  }
  let step = e
  if (effort !== null) {
    if (engine !== null && effort !== engine) step = { ...step, effort }
    // The engine gave the step no effort because it reckoned with another family (one without effort): the plan's model takes one.
    else if (e.effort === undefined && model !== null && family !== null && modelFamily(e.model) !== family) step = { ...step, effort }
  }
  if (model !== null && model !== e.model) step = { ...step, model }
  return { step, source }
}

/** A $.state value reached through closures (the hook that owns `$` builds them). */
export type Cell<T> = StateCell<T>

/**
 * Read-modify-write that retries when another write landed in between
 * (compare-and-set on the version); resolves to what was written. `change`
 * may run more than once: keep it pure.
 */
export async function update<T>(cell: Cell<T>, change: (current: T | undefined) => T, attempts = 8): Promise<T> {
  return (await replace(cell, change, attempts)).after
}

/**
 * `update`, resolving to both the value the landed write replaced (`before`)
 * and the one it wrote (`after`): a caller that needs to know what the write
 * found reads it from `before`, so `change` stays pure (it may run more than
 * once, and only its last run counts).
 */
export async function replace<T>(cell: Cell<T>, change: (current: T | undefined) => T, attempts = 8): Promise<{ before: T | undefined; after: T }> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { value, version } = await cell.get()
    const next = change(value)
    if ((await cell.set(next, { ifVersion: version })).isSet) return { before: value, after: next }
  }
  throw new Error(`$.state write lost to other writers ${attempts} times in a row`)
}
