// What the agents' decisions read of the session's reference images (#64, ADR 0008): the latest reading, as text, never an image.
// A dispatched agent's decision (`agent.spawn`), a Workflow script's batch requests and the by-label fallback (an agent decided as
// it is spawned) ask here for the reading to put in their state as `reference_complexity`. It is the latest one the session has kept
// (core/complexity.ts `latestReading`, written when the images were read: with a message, or when the main agent met them), so
// no request is made for it and nothing waits. Nothing with `image-routing` off, and nothing before any image was read: the
// requests are then what they always were.
//
// The caller hands over the readings' cell as a closure (`{ get: () => $.state.get(READINGS) }`): `$` may not cross a file.

import type { ReferenceReading } from '../decision/complexity.ts'
import { latestReading, type ReferenceReadings } from '../core/complexity.ts'
import type { Cell } from '../core/plans.ts'
import { isOn } from '../core/switches.ts'
import { IMAGE_ROUTING_SWITCH } from './image-routing.ts'

/** What the session's latest reference images read as, for a request that carries no image of its own; undefined when there is none or the feature is off. Never throws. */
export async function sessionReading(readings: Pick<Cell<ReferenceReadings>, 'get'>, debug: (line: string) => void): Promise<ReferenceReading | undefined> {
  if (!isOn(IMAGE_ROUTING_SWITCH)) return undefined
  try {
    return (await latestReading(readings)) ?? undefined
  } catch (error) {
    debug(`reference reading not read for an agent: ${String(error)}`)
    return undefined
  }
}
