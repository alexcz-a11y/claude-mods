// The plan table: what each turn of each loop should go out with, and the
// pure operations on it. The values live in $.state (types/index.d.ts); the
// core's turn.step writer reads them on every step.

import type { TurnStepInput } from 'claude-code'
import { higherEffort, isEffort, type Effort } from '../decision/effort.ts'

/** What a loop's steps go out with. Each slot has its owner; the writer combines them (planStep). */
export type Plan = {
  /** The routed effort: the latest decision for the scope; null leaves the engine's. */
  effort: Effort | null
  /** No step goes below it (forced raises); null for none. */
  floor: Effort | null
  /** The model a dispatched or workflow agent's steps name; null leaves the engine's. Never applied to main (ADR 0001). */
  model: string | null
}

/** One turn of one loop: its plan, plus what the decisions about it need to know. */
export type TurnRecord = Plan & {
  /** The text the main turn started with, redacted and clipped; '' when unknown. */
  prompt: string
  /** Decisions made for the turn: the one at its start, then re-decisions. */
  decisions: number
  /** Times the routed effort moved from one decided level to another. */
  changes: number
}

/** A prompt's decided effort, waiting for the turn the prompt starts. */
export type PendingDecision = { text: string; effort: Effort; at: number }

/** The loop name of the main agent in turn keys. */
export const MAIN = 'main'

/** The turns-table id of a step's turn: `main:<turnId>` or `<agentId>:<turnId>`. */
export function turnKey(turnId: string, agentId: string | undefined): string {
  return `${agentId ?? MAIN}:${turnId}`
}

/** A main turn's record as it starts, with the effort its prompt was decided at (or none). */
export function newTurn(prompt: string, effort: Effort | null): TurnRecord {
  return { effort, floor: null, model: null, prompt, decisions: effort === null ? 0 : 1, changes: 0 }
}

/** The record after a new decision for the turn (`record` undefined: a turn whose start was not seen). */
export function revise(record: TurnRecord | undefined, effort: Effort): TurnRecord {
  const base = record ?? newTurn('', null)
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
  agent: Plan | undefined
}

/** Where a step's effort came from: the person's lock, a plan, or the engine (nothing planned). */
export type EffortSource = 'locked' | 'planned' | 'engine'

/**
 * The step as the plans say to send it. Effort: on main, a lock wins;
 * otherwise the routed effort (the turn's, else on another loop its agent's),
 * lifted to the floor (the higher of the turn's and the agent's), a floor
 * lifting the engine's own effort when nothing is routed. Model: never on the
 * main agent (ADR 0001); on another loop the turn's, else its agent's. A step
 * without effort (a model that takes none) or with a numeric one keeps it.
 */
export function planStep(e: TurnStepInput, plans: StepPlans): { step: TurnStepInput; source: EffortSource } {
  const main = e.agentId === undefined
  const agent = main ? undefined : plans.agent
  const engine = isEffort(e.effort) ? e.effort : null
  let effort: Effort | null
  let source: EffortSource
  if (main && plans.lock !== null) {
    effort = plans.lock
    source = 'locked'
  } else {
    const routed = plans.turn?.effort ?? agent?.effort ?? null
    const floor = higherEffort(plans.turn?.floor ?? null, agent?.floor ?? null)
    effort = floor === null ? routed : higherEffort(routed ?? engine, floor)
    source = effort === null ? 'engine' : 'planned'
  }
  const model = main ? null : (plans.turn?.model ?? agent?.model ?? null)
  let step = e
  if (effort !== null && engine !== null && effort !== engine) step = { ...step, effort }
  if (model !== null && model !== e.model) step = { ...step, model }
  return { step, source }
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
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { value, version } = await cell.get()
    const next = change(value)
    if ((await cell.set(next, { ifVersion: version })).isSet) return next
  }
  throw new Error(`$.state write lost to other writers ${attempts} times in a row`)
}
