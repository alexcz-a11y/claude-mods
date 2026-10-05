// The plan table: what each turn of each loop should go out with, and the
// pure operations on it. The values live in $.state (types/index.d.ts); the
// core's turn.step writer reads them on every step.

import type { TurnStepInput } from 'claude-code'
import { modelFamily, type Terms } from '../decision/dispatched-agent.ts'
import { EFFORTS, higherEffort, isEffort, type Effort } from '../decision/effort.ts'

/** What a loop's steps go out with. Each slot has its owner; the writer combines them (planStep). */
export type Plan = {
  /** The routed effort: the latest decision for the scope; null leaves the engine's. */
  effort: Effort | null
  /** No step goes below it (forced raises); null for none. */
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
  /** Decisions made for the turn: the one at its start, then re-decisions. */
  decisions: number
  /** Times the routed effort moved from one decided level to another. */
  changes: number
  /** Whether the person's own message started the turn, decided at its start or not: only such a turn is re-decided mid-turn. */
  person: boolean
  /** The step from which `floor` no longer holds (a forced raise holds for holdSteps); null: for the rest of the turn. */
  floorUntil: number | null
  /** The step the turn's effort last went up mid-turn (a re-decision's raise or a forced one); null when it has not. */
  raisedAt: number | null
}

/**
 * A prompt's decided effort, waiting for the turn the prompt starts. `effort`
 * null: the person's message whose decision failed (its turn is still theirs).
 */
export type PendingDecision = { text: string; effort: Effort | null; at: number }

/** The main agent's name wherever loops go by agent: in turn keys (`main:<turnId>`) and as its id in the `escalation` table. */
export const MAIN = 'main'

/** The turns-table id of a step's turn: `main:<turnId>` or `<agentId>:<turnId>`. */
export function turnKey(turnId: string, agentId: string | undefined): string {
  return `${agentId ?? MAIN}:${turnId}`
}

/** A main turn's record as it starts: with the effort its prompt was decided at (or none), and whether the person's message started it. */
export function newTurn(prompt: string, effort: Effort | null, person: boolean): TurnRecord {
  return { effort, floor: null, model: null, prompt, decisions: effort === null ? 0 : 1, changes: 0, person, floorUntil: null, raisedAt: null }
}

/** The record after a new decision for the turn (`record` undefined: a turn whose start was not seen). */
export function revise(record: TurnRecord | undefined, effort: Effort): TurnRecord {
  const base = record ?? newTurn('', null, false)
  const moved = base.effort !== null && base.effort !== effort
  return { ...base, effort, decisions: base.decisions + 1, changes: base.changes + (moved ? 1 : 0) }
}

/**
 * The record after an ordinary re-decision (mid-turn, #5) for step `at`,
 * the turn at `current` then: the effort set when the level moves (a change),
 * the step marked when it goes up, the decision counted either way.
 */
export function redecided(record: TurnRecord, current: Effort, next: Effort, at: number): TurnRecord {
  if (next === current) return { ...record, decisions: record.decisions + 1 }
  const moved = revise({ ...record, effort: current }, next)
  return EFFORTS.indexOf(next) > EFFORTS.indexOf(current) ? { ...moved, raisedAt: at } : moved
}

/**
 * The record after a forced raise at step `at` (#7): the effort decided as
 * `level`, at least `floor` from this step until `holdSteps` steps later
 * (then the ordinary re-decisions take over), and
 * marked raised here, so a re-decision does not lower it within those steps.
 */
export function forced(record: TurnRecord, level: Effort, floor: Effort, at: number, holdSteps: number): TurnRecord {
  return { ...revise(record, level), floor, floorUntil: at + holdSteps, raisedAt: at }
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
  turn: (Plan & { floorUntil?: number | null }) | undefined
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
 * turn's and the agent's, each while it holds: a floor with an end stops at
 * `floorUntil`), a floor lifting the engine's own effort when nothing is
 * routed. An agent whose effective model is haiku goes without an effort,
 * whatever the engine or a plan asks (spec #32). An agent planned off a model
 * without effort (the engine gave its step none, reckoning with haiku) onto
 * one that takes an effort gets its planned effort. A step with a numeric
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
    const floor = higherEffort(floorHeld(plans.turn, e.index), floorHeld(agent, e.index))
    effort = named ?? (floor === null ? routed : higherEffort(routed ?? engine, floor))
    source = effort === null ? 'engine' : 'planned'
  }
  let step = e
  if (!main && family === 'haiku') {
    if (step.effort !== undefined) {
      const { effort: _none, ...rest } = step
      step = rest
    }
  } else if (effort !== null) {
    if (engine !== null && effort !== engine) step = { ...step, effort }
    // The engine gave the step no effort because it reckoned with another family (one without effort): the plan's model takes one.
    else if (e.effort === undefined && model !== null && family !== null && modelFamily(e.model) !== family) step = { ...step, effort }
  }
  if (model !== null && model !== e.model) step = { ...step, model }
  return { step, source }
}

/** A plan's floor where it still holds at step `index`: a floor with an end (`floorUntil`) holds for the steps before it. */
export function floorHeld(plan: (Plan & { floorUntil?: number | null }) | undefined, index: number): Effort | null {
  if (plan === undefined || plan.floor === null) return null
  const until = plan.floorUntil ?? null
  return until === null || index < until ? plan.floor : null
}

/** A $.state value reached through closures (the hook that owns `$` builds them). */
export type Cell<T> = {
  get: () => Promise<{ value: T | undefined; version: number }>
  set: (value: T, options: { ifVersion: number }) => Promise<{ isSet: boolean; version: number }>
}

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
