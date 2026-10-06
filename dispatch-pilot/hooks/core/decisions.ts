// The old way to record a decision, for the features that have not moved to
// the decision report yet (core/report.ts: `reportDecision`, which also puts the
// decision on the board). Same call, same debug-log line, same entry in the
// decision log (`/dp log`): only the entry is the report's `LogEntry` now, filed
// under the turn of the entry before it (the report's own decisions say their
// turn; this call does not know it). Each migration drops its calls to this
// file, and the last one deletes it.
//
//   await recordDecision(
//     { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
//     (line) => $.ui.log(line, { to: 'debug' }),
//     { feature: 'main-effort', outcome: 'effort high', about: '"the message"', reason: 'p low 0.05, ...' },
//   )
//
// where `DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const` is
// the file's own literal ref. Pure: no `$`.

import { errorText } from '../decision/backend.ts'
import { update, type Cell } from './plans.ts'
import { appendEntry, decisionLine, type LogEntry } from './report.ts'

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
export type DecisionEntry = LogEntry

/**
 * Records a decision: its line in the debug log (`log` is
 * `(line) => $.ui.log(line, { to: 'debug' })`) and its entry in the decision
 * log. Never throws: a log that cannot be kept must not stop the decision.
 */
export async function recordDecision(cell: Cell<DecisionEntry[]>, log: (line: string) => void, decision: Decision): Promise<void> {
  const line = { outcome: decision.outcome, subject: decision.about ?? '', reason: decision.reason }
  log(decisionLine(line))
  try {
    await update(cell, (list) => appendEntry(list ?? [], { turn: Math.max(0, ...(list ?? []).map((kept) => kept.turn)), feature: decision.feature, tone: 'info', ...line }))
  } catch (error) {
    log(`decision not kept for /dp log: ${errorText(error)}`)
  }
}
