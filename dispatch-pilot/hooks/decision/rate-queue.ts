// The queue every decision request waits in for its place under an account's rate limit (pplx-rate.ts, jev-rate.ts). What
// makes a place free differs (pplx: the sends of the last second, kept in a `$.state` cell; Jev: a count of requests and a
// bucket of tokens), so each limit tells the queue only whether a place is free now. Who is next, how long a request may wait
// and what the callers get back are the same:
//
// - the effort question of a message goes first (the person waits for it), the rest in the order they came; only the first
//   in the queue takes a place, even when a later request would fit, so a large request is not passed over for ever;
// - a request waits for its place at most until its own deadline, and is not held for a place that comes too late to be
//   answered in what is left (LEAST_SEND_MS);
// - the order is the request's, not its try's: a request that asks again keeps its place in line (`Ticket`).
//
// Pure (see system-one.ts): the clock and the timer come in as closures.

import { within, type Asked, type BackendIo } from './backend.ts'
import { EFFORT_PART } from './effort.ts'
import type { DecisionRequest } from './system-one.ts'

/** A request with less time left than this cannot be answered, so it is not sent (core/agent-lane.ts `MIN_ASK_MS` likewise). */
export const LEAST_SEND_MS = 200

/** The effort question of a message goes before everything else; the rest keep their order. */
export function priorityOf(request: DecisionRequest): number {
  return Object.keys(request.questions).some((id) => id.startsWith(`${EFFORT_PART}.`)) ? 0 : 1
}

/** Where a request stands in line: the best priority first, the earliest `order` of those. One request keeps its ticket through a retry. */
export type Ticket = { priority: number; order: number }

type Waiter = Ticket & { wake: () => void }

/** The clock and the timer of the host (`BackendIo.pace.now`, `BackendIo.sleep`). */
export type QueueClock = { now: () => Promise<number>; sleep: BackendIo['sleep'] }

export type RateQueue = {
  /** A ticket for a request that is just being asked: its priority, and the next order. */
  ticket: (request: DecisionRequest) => Ticket
  /** Lets whoever sleeps for a place look again at once: a limit has eased (tokens came back) before the time the sleeper was told. */
  nudge: () => void
  /**
   * Waits for a place and takes it: how long it waited in ms; null when `deadline` comes first or can no longer be met.
   * `take(now)` is asked only of the first in the queue: it takes the place and answers 0 when the place is free at `now`,
   * else the ms until it will be. A better request that arrives while the first sleeps goes ahead of it, since the first
   * looks at the queue again when it wakes.
   */
  place: (ticket: Ticket, deadline: number, clock: QueueClock, take: (now: number) => number | Promise<number>) => Promise<number | null>
}

export function rateQueue(): RateQueue {
  const queue: Waiter[] = []
  /** Who sleeps until a place comes free. */
  const napping = new Set<() => void>()
  let arrivals = 0

  /** The waiter whose turn it is: the best priority, the earliest of those. */
  const first = (): Waiter | undefined => queue.reduce<Waiter | undefined>((best, one) => (best === undefined || one.priority < best.priority || (one.priority === best.priority && one.order < best.order) ? one : best), undefined)

  return {
    ticket: (request) => ({ priority: priorityOf(request), order: arrivals++ }),
    nudge() {
      for (const wake of [...napping]) wake()
    },
    async place(ticket, deadline, clock, take) {
      // Before the queue is joined: a clock that fails must not leave a request at its head.
      const since = await clock.now()
      const me: Waiter = { ...ticket, wake: () => {} }
      queue.push(me)
      try {
        for (;;) {
          if (first() !== me) {
            // Not our turn: until the one in front leaves, or the time is up. (No await between the check and `wake`.)
            const woken = new Promise<true>((done) => {
              me.wake = () => done(true)
            })
            const left = deadline - LEAST_SEND_MS - (await clock.now())
            if (left <= 0 || (await within(clock.sleep, woken, left, false)) === false) return null
            continue
          }
          const now = await clock.now()
          if (deadline - now < LEAST_SEND_MS) return null
          const wait = await take(now)
          if (wait === 0) return now - since
          // The place comes free after `wait`, or sooner when `nudge` says so; a request that cannot be sent before its deadline is not held up until it.
          if (deadline - (now + wait) < LEAST_SEND_MS) return null
          let wake = () => {}
          const nudged = new Promise<true>((done) => {
            wake = () => done(true)
          })
          napping.add(wake)
          try {
            await within(clock.sleep, nudged, wait, false)
          } finally {
            napping.delete(wake)
          }
        }
      } finally {
        queue.splice(queue.indexOf(me), 1)
        for (const one of queue) one.wake()
      }
    },
  }
}

/** The answer as the callers get it: a failure without `retryAfterMs`, which only passes between the backend and the limit (the board keeps what the person reads of it, in `detail`); with the `notes` the debug log is to carry. */
export function handedOver(asked: Asked, notes: readonly string[]): Asked {
  const withNotes = notes.length === 0 ? asked : { ...asked, notes: [...(asked.notes ?? []), ...notes] }
  if (withNotes.ok || withNotes.failure.retryAfterMs === undefined) return withNotes
  const { retryAfterMs: _wait, ...failure } = withNotes.failure
  return { ok: false, failure, ...(withNotes.notes === undefined ? {} : { notes: withNotes.notes }) }
}
