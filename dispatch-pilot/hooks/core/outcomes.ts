// Which of the engine's tool calls a PreToolUse settings hook refused, for the
// escalation feature (#7), which tells a call's ending apart once
// (decision/escalation.ts `outcomeOf`).
//
// A PreToolUse settings hook's refusal reaches `tool.call` as any error would,
// its reason the text, so the core notes the calls such a hook refused
// (`noteBlocked`, from its classic.PreToolUse hook, beneath every feature's
// tool.call).
//
// Pure module state, the latest calls only: lost on a hot reload (a call
// refused before it then reads as a failure).

/** At most this many calls are remembered, the oldest dropped first. */
const MAX_CALLS = 256

const blockedIds = new Set<string>()

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
