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

/**
 * Runs items at most concurrency at a time. reserve is called just before an item starts and must take its cost then:
 * a false stops any more from starting, so requests in flight together never pass the cap. After a result that limited
 * says is a rate limit, the rest go one at a time. A run that throws stops the pool; the throw comes out once the
 * runs in flight have ended.
 */
export function pool<T, R>(
  items: readonly T[],
  o: { concurrency: number; reserve: (item: T) => boolean; run: (item: T) => Promise<R>; limited?: (r: R) => boolean },
): Promise<{ results: R[]; stopped: boolean; serial: boolean }> {
  return new Promise((resolve, reject) => {
    const results: R[] = []
    let next = 0
    let active = 0
    let limit = Math.max(1, Math.floor(o.concurrency))
    let stopped = false
    let serial = limit === 1
    let failure: { error: unknown } | null = null
    const fill = (): void => {
      while (!stopped && failure === null && active < limit && next < items.length) {
        const item = items[next]!
        if (!o.reserve(item)) {
          stopped = true
          break
        }
        next += 1
        active += 1
        let started: Promise<R>
        try {
          started = o.run(item)
        } catch (error) {
          started = Promise.reject(error)
        }
        started
          .then(
            (r) => {
              results.push(r)
              if (o.limited?.(r) === true) {
                limit = 1
                serial = true
              }
            },
            (error: unknown) => {
              failure ??= { error }
            },
          )
          .finally(() => {
            active -= 1
            fill()
          })
      }
      if (active > 0) return
      if (failure !== null) reject(failure.error)
      else resolve({ results, stopped, serial })
    }
    fill()
  })
}
