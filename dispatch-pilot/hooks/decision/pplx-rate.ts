// The rate limit on pplx requests (#51; ADR 0006). A Perplexity Tier 0 account takes 1 request a second (QPS), and one
// message sends two or three (the effort question, the skills' two stages) while a mid-turn re-decision, a dispatched
// agent or find_skill ask beside them, so every pplx request goes through this queue: at most `qps` requests leave in any
// second, the effort question of a message first, the rest in the order they came. Jev does not pass through it.
//
// The time a request spends in the queue is part of its own wait: `timeoutMs` counts from the moment it was asked. When a
// 429 comes anyway the request asks once more if the time left covers the `Retry-After` it was given and an ordinary
// request; otherwise it fails as it is, and the person reads 「被限速」 (backend.ts FAILURE_WORDS).
//
// Pure (see system-one.ts): the clock and the `$.state` cell come in through `BackendIo.pace`, built by the hook that calls.
// The times of the latest sends live in that cell, so a hot reload (which resets this module's variables) goes on from them
// and does not let a burst out; the queue itself is module state: the requests it holds are those of the old module, which
// the engine drops with it, so nothing is lost that was not lost anyway.

import { within, type Asked, type Backend, type BackendIo, type Failure, type StateCell } from './backend.ts'
import { EFFORT_PART } from './effort.ts'
import type { DecisionRequest } from './system-one.ts'

/** What an ordinary pplx request takes (ADR 0006: about 5 s): a retry after a 429 needs this much time on top of the wait it was told. */
export const EXPECTED_REQUEST_MS = 5000

/** The window the limit counts in: `qps` requests a second. */
const WINDOW_MS = 1000

/** How often a lost write of the cell is tried again before the limit is given up for this request. */
const ATTEMPTS = 8

/** The effort question of a message goes before everything else; the rest keep their order. */
function priorityOf(request: DecisionRequest): number {
  return Object.keys(request.questions).some((id) => id.startsWith(`${EFFORT_PART}.`)) ? 0 : 1
}

type Waiter = { priority: number; order: number; wake: () => void }

/**
 * `backend` behind the rate limit. A request whose `io` has no `pace` (the eval, which paces its own requests) goes
 * straight through, as does one asked without a key (it sends nothing).
 */
export function limited(backend: Backend, qps: number): Backend {
  const queue: Waiter[] = []
  let arrivals = 0

  /** The waiter whose turn it is: the best priority, the earliest of those. */
  const first = (): Waiter | undefined => queue.reduce<Waiter | undefined>((best, one) => (best === undefined || one.priority < best.priority || (one.priority === best.priority && one.order < best.order) ? one : best), undefined)

  /**
   * Waits for a free place among the latest `qps` sends of the last second, takes it (the send time goes into the cell) and
   * resolves true; resolves false when `deadline` comes first, or can no longer be met. A place is claimed by the first in
   * the queue only, and only when it is free; a better request that arrives while the first sleeps goes ahead of it.
   */
  async function takePlace(pace: NonNullable<BackendIo['pace']>, sleep: BackendIo['sleep'], priority: number, deadline: number): Promise<boolean> {
    const me: Waiter = { priority, order: arrivals++, wake: () => {} }
    queue.push(me)
    try {
      for (;;) {
        if (first() !== me) {
          // Not our turn: until the one in front leaves, or the time is up. (No await between the check and `wake`.)
          const woken = new Promise<true>((done) => {
            me.wake = () => done(true)
          })
          const left = deadline - (await pace.now())
          if (left <= 0 || (await within(sleep, woken, left, false)) === false) return false
          continue
        }
        const now = await pace.now()
        if (now >= deadline) return false
        const wait = await claim(pace.sent, now, qps)
        if (wait === 0) return true
        // The place comes free after `wait`; a request that cannot be sent before its deadline is not held up until it.
        if (now + wait >= deadline) return false
        await sleep(wait, new AbortController().signal).catch(() => {})
      }
    } finally {
      queue.splice(queue.indexOf(me), 1)
      for (const one of queue) one.wake()
    }
  }

  return {
    name: backend.name,
    get configured() {
      return backend.configured
    },
    async ask(io, request, timeoutMs) {
      const pace = io.pace
      if (pace === undefined || backend.configured === false) return backend.ask(io, request, timeoutMs)
      const priority = priorityOf(request)
      const deadline = (await pace.now()) + timeoutMs
      const late: Asked = { ok: false, failure: { kind: 'timeout', detail: `no answer in ${timeoutMs} ms` } }
      const once = async (): Promise<Asked> => {
        if (!(await takePlace(pace, io.sleep, priority, deadline))) return late
        const left = deadline - (await pace.now())
        if (left <= 0) return late
        const asked = await backend.ask(io, request, left)
        // Not answered in what was left of the wait: the wait the person set is what the failure says.
        return !asked.ok && asked.failure.kind === 'timeout' && asked.failure.status === undefined ? late : asked
      }

      const asked = await once()
      const wait = retryWait(asked)
      // A 429 with a wait to read: once more if the time left allows the wait and an ordinary request; else it stays a 429.
      if (wait === null || deadline - (await pace.now()) < wait + EXPECTED_REQUEST_MS) return settled(asked)
      if (wait > 0) await io.sleep(wait, new AbortController().signal).catch(() => {})
      return settled(await once())
    },
  }
}

/** The answer as the callers get it: a failure without `retryAfterMs`, which only passes between the backend and this queue (the board keeps what the person reads of it, in `detail`). */
function settled(asked: Asked): Asked {
  if (asked.ok || asked.failure.retryAfterMs === undefined) return asked
  const { retryAfterMs: _wait, ...failure } = asked.failure
  return { ok: false, failure }
}

/** How long a failed request was told to wait before it asks again: only a 429 that gave a `Retry-After`; null for every other failure. */
function retryWait(asked: Asked): number | null {
  if (asked.ok) return null
  const failure: Failure = asked.failure
  return failure.status === 429 && failure.retryAfterMs !== undefined ? failure.retryAfterMs : null
}

/**
 * Takes a place for a send at `now`: 0 when it was free (the time is written into the cell), else the ms until the oldest
 * send of the last second leaves the window. The cell holds at most `qps` times. Fails open: a cell that cannot be read or
 * written does not stop the request (Perplexity's own 429 is the worst that follows).
 */
async function claim(cell: StateCell<number[]>, now: number, qps: number): Promise<number> {
  try {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const { value, version } = await cell.get()
      // Times from the future (the clock was set back) do not count; neither do those a second ago.
      const recent = (value ?? []).filter((at) => at > now - WINDOW_MS && at <= now)
      if (recent.length >= qps) return (recent[recent.length - qps] as number) + WINDOW_MS - now
      if ((await cell.set([...recent, now], { ifVersion: version })).isSet) return 0
    }
  } catch {
    // fail open
  }
  return 0
}
