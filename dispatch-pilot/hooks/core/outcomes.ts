// How the engine's tool calls ended, as the hooks saw them end: shared by the
// features that read a loop's steps (the mid-turn re-decision #5, the forced
// raise #7), so each call is told apart once.
//
// A PreToolUse settings hook's refusal reaches `tool.call` as any error would,
// its reason the text, so the core notes the calls such a hook refused
// (`noteBlocked`, from its classic.PreToolUse hook, beneath every feature's
// tool.call). The forced raise notes how each call ended (`noteEnded`): a
// transcript read the moment a call ends does not hold its result yet.
//
// Pure module state, the latest calls only: lost on a hot reload (a call that
// ended before it then reads as the transcript has it).

import type { Outcome } from '../decision/midturn.ts'

/** At most this many calls are remembered, the oldest dropped first. */
const MAX_CALLS = 256

const blockedIds = new Set<string>()
const endings = new Map<string, Exclude<Outcome, 'running'>>()

/** Remembers that a PreToolUse settings hook refused the call `id`. */
export function noteBlocked(id: string): void {
  blockedIds.add(id)
  for (const old of blockedIds) {
    if (blockedIds.size <= MAX_CALLS) break
    blockedIds.delete(old)
  }
}

/** Whether a PreToolUse settings hook refused the call `id`. */
export function wasBlocked(id: string): boolean {
  return blockedIds.has(id)
}

/** Remembers how the call `id` ended. */
export function noteEnded(id: string, outcome: Exclude<Outcome, 'running'>): void {
  endings.delete(id)
  endings.set(id, outcome)
  for (const old of endings.keys()) {
    if (endings.size <= MAX_CALLS) break
    endings.delete(old)
  }
}

/** How the call `id` ended, when it was seen ending. */
export function endedAs(id: string): Exclude<Outcome, 'running'> | undefined {
  return endings.get(id)
}
