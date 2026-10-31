// The effort question of a message with reference images, held back until its images are read (#63, ADR 0008, ADR 0019). The
// main-effort feature leaves the effort part out of the message's ballot (core/ballot.ts) and hands it here instead, as a function
// from the reading to the part, so that the part is built with the reading in its state and its report. The image-routing feature
// (features/image-routing.ts) takes it:
//
//   at prompt.submit   when the engine hands the images' bytes to the hook (`$.prompt.media`, Claude Code 2.1.316 on): read
//                      them, and put the part in the ballot the core sends a moment later, as any message's (ADR 0019). A message
//                      typed into a running turn is taken here either way: with no bytes it is decided on its words.
//   at turn.start      otherwise (an engine before 2.1.316): the images are read from the message's row (`session.append`), the
//                      part is asked through the core's `askGroups`, and the answer is written as a pending decision, which the
//                      core claims in the same `turn.start` as for any other message: the plan table keeps its one writer (ADR 0003).
//
// Pure module state, like the ballot: lost on a hot reload, which only costs the decision of a message submitted during that
// reload (its turn goes out unrouted).

import type { ReferenceReading } from '../decision/complexity.ts'
import { keepNewest } from '../decision/keep-newest.ts'
import type { Contribution } from './ballot.ts'

/**
 * Where a deferred part is decided: `submit`, in the message's own `prompt.submit` (it goes in the ballot, and the decision is
 * about the turn the message starts, or the running one it was typed into); `turn-start`, once the turn it starts has begun.
 */
export type DecidedAt = 'submit' | 'turn-start'

/** A message's effort part, to be built once its images' reading is known (null: it could not be read, or was not asked for). */
export type Deferred = (reading: ReferenceReading | null, at: DecidedAt) => Contribution

const waiting = new Map<string, Deferred>()
/** Parts nobody took (a message that never started a turn) stop piling up here. */
const MOST_WAITING = 8

/** The message with this text waits for its images to be read before its effort is decided. */
export function defer(prompt: string, deferred: Deferred): void {
  waiting.delete(prompt)
  waiting.set(prompt, deferred)
  keepNewest(waiting, MOST_WAITING)
}

/** Whether the message with this text waits for its images. */
export function isDeferred(prompt: string): boolean {
  return waiting.has(prompt)
}

/** The message was refused beneath, or is not waiting for a turn after all. */
export function withdraw(prompt: string): void {
  waiting.delete(prompt)
}

/** Takes the part of the message: the first of `texts` that has one. */
export function takeDeferred(texts: readonly string[]): { prompt: string; deferred: Deferred } | null {
  for (const text of texts) {
    const deferred = waiting.get(text)
    if (deferred !== undefined) {
      waiting.delete(text)
      return { prompt: text, deferred }
    }
  }
  return null
}
