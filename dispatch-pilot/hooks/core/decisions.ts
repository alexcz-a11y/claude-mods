// The decision log: what each feature decided and why. A feature records
// every decision it makes with `recordDecision`; the line goes to the debug log
// (never into the conversation) and the decision is kept in $.state for
// `/dp log` (features/control.ts), so a hot reload keeps it.
//
//   await recordDecision(
//     { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
//     (line) => $.ui.log(line, { to: 'debug' }),
//     { feature: 'main-effort', outcome: 'effort high', about: '"the message"', reason: 'p low 0.05, ...' },
//   )
//
// where `DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const` is
// the file's own literal ref (DEVELOPMENT.md, 开发). Pure: no `$`.

import { update, type Cell } from './plans.ts'

/** What a feature records. */
export type Decision = {
  /** Who decided: the feature's switch name. */
  feature: string
  /** What was decided, in a few words: `effort high`. */
  outcome: string
  /** What it was about, when that helps to tell decisions apart: the start of the message. */
  about?: string
  /** Why: what the decision model said, the rule that applied. */
  reason: string
}

/** A decision as kept in $.state: numbered, in order. */
export type DecisionEntry = { n: number; feature: string; outcome: string; about: string; reason: string }

/** The log keeps this many decisions; the oldest go first. */
export const MAX_DECISIONS = 50

/** A decision as one line: `effort high for "the message": why`. */
export function decisionLine(decision: { outcome: string; about?: string; reason: string }): string {
  return `${decision.outcome}${decision.about ? ` for ${decision.about}` : ''}: ${decision.reason}`
}

/**
 * Records a decision: its line in the debug log (`log` is
 * `(line) => $.ui.log(line, { to: 'debug' })`) and its entry in the decision
 * log. Never throws: a log that cannot be kept must not stop the decision.
 */
export async function recordDecision(cell: Cell<DecisionEntry[]>, log: (line: string) => void, decision: Decision): Promise<void> {
  log(decisionLine(decision))
  try {
    await update(cell, (list) => append(list ?? [], decision))
  } catch (error) {
    log(`decision not kept for /dp log: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function append(list: readonly DecisionEntry[], decision: Decision): DecisionEntry[] {
  const n = (list.at(-1)?.n ?? 0) + 1
  const entry: DecisionEntry = { n, feature: decision.feature, outcome: decision.outcome, about: decision.about ?? '', reason: decision.reason }
  return [...list, entry].slice(-MAX_DECISIONS)
}
