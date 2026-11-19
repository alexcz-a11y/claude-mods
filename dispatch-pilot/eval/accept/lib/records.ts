// Where an acceptance session's record is, and what it says about the turn (calibration plan, Task 15 Step 3). Pure:
// run.ts reads the files; the tests import this.
import { isMain, isMainResponse, isObj, isTurnDuration, isTurnStart } from './usage.ts'

/**
 * The folder the engine keeps a session's records in: ~/.claude/projects/ and the session's directory with every
 * character other than a letter or a digit made a dash (as the folders there are named; the directory is short, so no
 * hash is added).
 */
export function recordDir(home: string, cwd: string): string {
  return `${home.replace(/\/+$/, '')}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}`
}

const ENDED = ['end_turn', 'stop_sequence', 'max_tokens', 'refusal']

/**
 * Whether the main loop's turn has ended: the engine wrote its turn_duration, or the last main-loop response stopped
 * for good and no tool result came after it. A subagent's records say nothing about it.
 */
export function turnEnded(records: readonly unknown[]): boolean {
  const main = records.filter(isObj).filter(isMain)
  const start = main.findIndex(isTurnStart)
  if (start === -1) return false
  const turn = main.slice(start + 1)
  if (turn.some(isTurnDuration)) return true
  const at = turn.findLastIndex(isMainResponse)
  if (at === -1 || !ENDED.includes(turn[at]!.message.stop_reason)) return false
  const after = turn.slice(at + 1)
  return !after.some((r) => r.type === 'user' && Array.isArray(r.message?.content) && r.message.content.some((b: unknown) => isObj(b) && b.type === 'tool_result'))
}

const timeOf = (r: Record<string, any>): number | null => {
  const t = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN
  return Number.isNaN(t) ? null : t
}

/** When the turn started (its prompt's record) and ended (turn_duration, else the last response); null before it starts. */
export function turnSpan(records: readonly unknown[]): { startedAt: number; endedAt: number } | null {
  const main = records.filter(isObj).filter(isMain)
  const start = main.find(isTurnStart)
  const startedAt = start === undefined ? null : timeOf(start)
  if (startedAt === null) return null
  const end = main.findLast(isTurnDuration) ?? main.findLast(isMainResponse)
  return { startedAt, endedAt: (end === undefined ? null : timeOf(end)) ?? startedAt }
}
