// This session's mid-run decisions, from the mod's $.store log (calibration plan, Task 15 Step 3). Pure: run.ts reads
// the store file; the tests import this.
//
// The log (key 'log' of the store file, hooks/runtime.ts) is shared by every session that loads the mod with
// --plugin-dir, and a Decision carries its turn's id but no session id; the session record does not carry that turn id.
// So the run's turn is found by time: the decisions not in the log before the session started, inside the turn's span,
// and among them the one turn whose submit decision falls there. Two sessions whose prompts land in the same span cannot
// be told apart: then there is no count (null), never a guess.
import { readLog } from '../../../hooks/log.ts'
import type { Decision } from '../../../hooks/log.ts'

/** Decisions this close to the turn's span still count (the submit is recorded at the first step, after the prompt's record). */
const SLACK_MS = 5000

export type Own = { turnId: string | null; midrun: Decision[] | null }

export function ownMidrun(log: unknown, o: { seen: ReadonlySet<string>; startedAt: number; endedAt: number }): Own {
  const fresh = readLog(log).filter((d) => !o.seen.has(d.id) && d.at >= o.startedAt - SLACK_MS && d.at <= o.endedAt + SLACK_MS)
  const turns = (kind: Decision['kind']): string[] => [...new Set(fresh.filter((d) => d.kind === kind && d.turnId !== null).map((d) => d.turnId as string))]
  const submits = turns('submit')
  const candidates = submits.length > 0 ? submits : turns('midrun')
  if (candidates.length === 0) return { turnId: null, midrun: [] }
  if (candidates.length > 1) return { turnId: null, midrun: null }
  const turnId = candidates[0]!
  return { turnId, midrun: fresh.filter((d) => d.kind === 'midrun' && d.turnId === turnId) }
}

/** The shifts the mod made, and the level the next request really carried (null: not read back). */
export function levelsSent(midrun: readonly Decision[]): { from: string | null; to: string | null; sent: Decision['sent'] }[] {
  return midrun.filter((d) => d.applied).map((d) => ({ from: d.from, to: d.to, sent: d.sent }))
}
