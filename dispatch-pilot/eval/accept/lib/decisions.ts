// This session's mid-run decisions as the mod's $.store log has them (calibration plan, Task 15 Step 3), best effort:
// the levels really sent and the shifts come from the session's own record (records.ts levelsOf). Pure: run.ts reads
// the store file; the tests import this.
//
// The log (key 'log' of the store file, hooks/runtime.ts) is shared by every session that loads the mod with
// --plugin-dir, and a Decision carries its turn's id but no session id; the session record does not carry that turn id.
// So the run's turn is found by time: among the decisions not in the log before the session started and inside the
// turn's span, the turn whose submit decision was made as this turn started. Two sessions that started within that
// slack of each other cannot be told apart: then there is no count (null), never a guess.
import { readLog } from '../../../hooks/log.ts'
import type { Decision } from '../../../hooks/log.ts'

/** How far from the turn's start its submit decision may fall (it is recorded at the first step, after the prompt's record). */
const SLACK_MS = 5000

export type Own = { turnId: string | null; midrun: Decision[] | null }

export function ownMidrun(log: unknown, o: { seen: ReadonlySet<string>; startedAt: number; endedAt: number }): Own {
  const fresh = readLog(log).filter((d) => !o.seen.has(d.id) && d.at >= o.startedAt - SLACK_MS && d.at <= o.endedAt + SLACK_MS)
  const turns = (ds: readonly Decision[]): string[] => [...new Set(ds.filter((d) => d.turnId !== null).map((d) => d.turnId as string))]
  // Another session's submit later in this turn's span is its own turn's start, not this one's.
  const submits = turns(fresh.filter((d) => d.kind === 'submit' && Math.abs(d.at - o.startedAt) <= SLACK_MS))
  const candidates = submits.length > 0 ? submits : turns(fresh.filter((d) => d.kind === 'midrun'))
  if (candidates.length === 0) return { turnId: null, midrun: [] }
  if (candidates.length > 1) return { turnId: null, midrun: null }
  const turnId = candidates[0]!
  return { turnId, midrun: fresh.filter((d) => d.kind === 'midrun' && d.turnId === turnId) }
}
