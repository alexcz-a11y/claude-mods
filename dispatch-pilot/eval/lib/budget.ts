// The calibration's budget for real requests, the held-out set's one pass, and the pool that sends requests a few at a
// time (calibration plan, Task 6; amendment A12). Pure: no node: module, so the tests import it.

/** The whole calibration's budget (global constraints): no more requests or input tokens than these. */
export const CAP = { requests: 2000, tokens: 30_000_000 } as const
export type Spent = { requests: number; tokens: number }

/** 花得起就返回花过之后的数，花不起返回 null。 */
export function spend(spent: Spent, cost: Spent, cap: Spent = CAP): Spent | null {
  const after = { requests: spent.requests + cost.requests, tokens: spent.tokens + cost.tokens }
  return after.requests > cap.requests || after.tokens > cap.tokens ? null : after
}

/** 留出集能不能发：没有 final 不能；已经发过一次不能。 */
export function mayAskHeldout(o: { final: boolean; alreadyDone: boolean }): boolean {
  return o.final && !o.alreadyDone
}

/** The waits before a rate-limited request is sent again: three retries, each after twice the wait before. */
export const RATE_WAITS: readonly number[] = [20_000, 40_000, 80_000]

/** How the pool knows a rate limit, and how it waits one out (the pure module has no timer of its own). */
export type RateLimit<T, R> = { limited: (r: R) => boolean; sleep: (ms: number) => Promise<void>; waits?: readonly number[]; onWait?: (item: T, ms: number) => void }

/**
 * Runs items at most concurrency at a time. reserve is called just before each request goes out (a retry too) and must
 * take its cost then: a false stops any more from starting, so requests in flight together never pass the cap. keep
 * receives each result as it comes, except one rate-limited: that request is sent again after each wait of waits
 * (RATE_WAITS by default), the pool going one at a time from the first rate limit on. A request still rate-limited
 * after the last wait is dropped and no more start (rateLimited). A run or a reserve that throws stops the pool; the
 * throw comes out once the runs in flight have ended.
 */
export function pool<T, R>(
  items: readonly T[],
  o: { concurrency: number; reserve: (item: T) => boolean; run: (item: T) => Promise<R>; keep?: (item: T, r: R) => void; rateLimit?: RateLimit<T, R> },
): Promise<{ results: R[]; stopped: boolean; serial: boolean; rateLimited: boolean }> {
  return new Promise((resolve, reject) => {
    const results: R[] = []
    let next = 0
    let active = 0
    let limit = Math.max(1, Math.floor(o.concurrency))
    let stopped = false
    let serial = limit === 1
    let rateLimited = false
    let failure: { error: unknown } | null = null
    const rl = o.rateLimit
    const halted = (): boolean => stopped || rateLimited || failure !== null

    // One item from its first request to its result, the retries of a rate limit included.
    const go = async (item: T): Promise<void> => {
      let r = await o.run(item)
      for (const ms of rl?.waits ?? RATE_WAITS) {
        if (rl === undefined || !rl.limited(r)) break
        limit = 1
        serial = true
        rl.onWait?.(item, ms)
        await rl.sleep(ms)
        if (failure !== null) return
        if (!o.reserve(item)) {
          stopped = true
          return
        }
        r = await o.run(item)
      }
      if (rl !== undefined && rl.limited(r)) {
        rateLimited = true
        return
      }
      results.push(r)
      o.keep?.(item, r)
    }

    const fill = (): void => {
      try {
        while (!halted() && active < limit && next < items.length) {
          const item = items[next]!
          if (!o.reserve(item)) {
            stopped = true
            break
          }
          next += 1
          active += 1
          go(item)
            .catch((error: unknown) => {
              failure ??= { error }
            })
            .finally(() => {
              active -= 1
              fill()
            })
        }
      } catch (error) {
        // A reserve that throws: no more start, and the pool rejects once the runs in flight end.
        failure ??= { error }
      }
      if (active > 0) return
      if (failure !== null) reject(failure.error)
      else resolve({ results, stopped, serial, rateLimited })
    }
    fill()
  })
}
