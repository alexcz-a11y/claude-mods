// The effort question of a message with reference images, held back until its turn starts (#63, ADR 0008). The message's decision
// is made at `turn.start`, after its images have been read (features/image-routing.ts): the main-effort feature leaves the
// effort part out of the message's ballot (core/ballot.ts) and hands it here instead, as a function from the reading to the
// part, so that the part is built with the reading in its state and its report. The image-routing feature takes it at the turn's
// start, asks it through the core's `askGroup`, and the answer is written as a pending decision, which the core claims in the same
// `turn.start` as for any other message: the plan table keeps its one writer (ADR 0003).
//
// Pure module state, like the ballot: lost on a hot reload, which only costs the decision of a message submitted during that
// reload (its turn goes out unrouted).

import type { ReferenceReading } from '../decision/complexity.ts'
import { keepNewest } from '../decision/keep-newest.ts'
import type { Contribution } from './ballot.ts'

/** A message's effort part, to be built once its images' reading is known (null: it could not be read, or was not asked for). */
export type Deferred = (reading: ReferenceReading | null) => Contribution

const waiting = new Map<string, Deferred>()
/** Parts nobody took (a message that never started a turn) stop piling up here. */
const MOST_WAITING = 8

/** The message with this text waits for its turn to start before its effort is decided. */
export function defer(prompt: string, deferred: Deferred): void {
  waiting.delete(prompt)
  waiting.set(prompt, deferred)
  keepNewest(waiting, MOST_WAITING)
}

/** The message was refused beneath, or is not waiting for a turn after all. */
export function withdraw(prompt: string): void {
  waiting.delete(prompt)
}

/** Takes the part of the message the turn that starts is for: the first of `texts` that has one. */
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
