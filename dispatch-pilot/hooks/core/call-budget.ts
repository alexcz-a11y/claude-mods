// The time one tool call may spend waiting on the decision model (ADR 0007). A hook has 10 seconds, and a `$.clock.sleep` counts toward
// them (`$.http.fetch` and `$.process.run` do not), but a request waits for its answer on a sleep (decision/backend.ts `within`). So a call
// that sends one request after another (the whole images, then the crops of the zoomed re-check, a series' waves) could add up to more
// than the hook has, and be dropped with nothing answered. The requests of one call share a budget instead: each waits at most its own
// limit, and no longer than what is left; with too little left the request is not sent.
//
// Time is counted as the time at least one request has been waiting, because that is what the sleeps add up to: requests that wait
// together (the pairs of a series' wave) cost it once, and the sips and ffmpeg runs between them cost nothing. That the engine counts
// overlapping sleeps this way is the same assumption features/image-routing.ts makes of its two requests; it was not measured.
//
// Pure (see system-one.ts): the clock is a closure.

/** What the requests of one call may wait in all: the hook's 10 seconds, less one for the rest of its work (image-routing's `HOOK_ROOM_MS`). */
export const CALL_ROOM_MS = 9000

/** A request with less time than this is not sent: Jev's own wait beside a message is 1.5 seconds, and a request with images takes longer. */
export const LEAST_REQUEST_MS = 1500

export type CallBudget = {
  /**
   * Runs `request` with the time it may wait: `limitMs`, or what is left of the call's room when that is less. With less than
   * `LEAST_REQUEST_MS` left it is not run and `unsent` is the result.
   */
  run: <T>(limitMs: number, request: (waitMs: number) => Promise<T>, unsent: T) => Promise<T>
}

/** A budget of `roomMs` for one call; `now` is the clock (`$.clock.now()`). */
export function callBudget(now: () => Promise<number>, roomMs: number = CALL_ROOM_MS): CallBudget {
  let waiting = 0
  let since = 0
  let used = 0
  return {
    async run(limitMs, request, unsent) {
      const at = await now()
      const left = roomMs - used - (waiting > 0 ? at - since : 0)
      if (left < LEAST_REQUEST_MS) return unsent
      if (waiting++ === 0) since = at
      try {
        return await request(Math.min(limitMs, left))
      } finally {
        const end = await now()
        if (--waiting === 0) used += end - since
      }
    },
  }
}
