// When the main agent's loop began (#64, ADR 0008): the time of the latest main `turn.start`, kept in `$.state` (`mainLoopStart`).
// "A file older than this loop" is how image routing tells a reference image, which was there before the agent started working
// (a design the person pointed it at, a photo they pasted), from a picture the agent made itself in this loop (a screenshot, a
// rendered frame), which is not one. This is the smallest version of the loop's start: the main agent's only. #62 (the screenshot
// takeover) needs the same time for the main agent and for a dispatched agent's run (its `agent.spawn`); when it lands, the two
// are joined into one module and this file goes.
//
// The hook only records; it changes nothing in the event. The time is read by whoever asks (`isOlder`), with a `$.state` read of
// its own: a module may not pass `$` across an import.

import type { On } from 'claude-code'
import { errorText } from '../decision/backend.ts'

/** The main agent's loop: the turn it is in, and when that turn started (`$.clock.now()`, ms). */
export type LoopStart = { turnId: string; at: number }

/**
 * Whether a file last changed at `modifiedMs` is older than the loop that began at `start`: a file that was there before the
 * agent began. Without a start (a hot reload lost it, the loop began before the mod was loaded) nothing is known to be older.
 */
export function isOlder(start: LoopStart | null | undefined, modifiedMs: number): boolean {
  return start !== null && start !== undefined && modifiedMs < start.at
}

/** Records the start of each main turn, outermost: before anything beneath reads it. */
export function registerLoopStart(on: On): void {
  on('turn.start', { turnId: /(?:)/ }, async ($, e, next) => {
    // A dispatched agent's run is a turn of its loop too (2.1.299 on): not the main agent's.
    if (e.agentId === undefined) {
      try {
        await $.state.set({ plugin: 'dispatch-pilot', key: 'mainLoopStart' }, { turnId: e.turnId, at: await $.clock.now() })
      } catch (error) {
        $.ui.log(`loop start not kept: ${errorText(error)}`, { to: 'debug' })
      }
    }
    return next(e)
  })
}
