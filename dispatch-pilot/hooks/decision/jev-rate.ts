// Jev's rate limits (2026-10-15). TypeSafe limits an account (an organization) in requests and in input tokens a second
// (docs.typesafe.ai, Rate limits; the console shows an account's own: the default plan's are 80 requests and 100,000 input
// tokens a second), and answers a request over either with 429; a 529 says TypeSafe is overloaded. Every Jev request of the
// mod goes through this pacing, which keeps the mod's own requests within those limits:
//
// - at most `requestsPerSecond` requests go out in any second;
// - the input tokens come out of a bucket that holds BURST_SECONDS of the rate and fills at the rate: a burst may spend a
//   few seconds of it at once (a message's long effort request and a few agents' together), then requests go as fast as it
//   fills. A request takes out what it is about to cost (`jevRequestTokens`: the mod's estimate at Jev's count), set right
//   at what Jev says it cost once answered; one larger than the bucket goes when the bucket is full (none of the mod's is);
// - the effort question of a message goes first (the person waits for it), the rest in the order they came; a request waits
//   behind the one in front even when it would fit, so a large one is not passed over for ever;
// - a 429 or a 529 holds every request back for as long as it says (`Retry-After`; else a second, or half a second for a
//   529), and the request that got it asks once more when the time it has left covers that and an answer.
//
// A request that cannot have its place within its own wait fails as if it had timed out, without being sent: the time it
// waits for its place is part of its wait, as with pplx (pplx-rate.ts). Jev answers several requests of a key at once (four
// of 115k tokens took 1.39-1.53 s, one alone 1.44 s, 2026-10-15), so the pacing costs nothing until the limits near; at its
// worst, with the bucket empty, a message's effort request goes first and waits as long as the bucket takes to fill its own
// tokens (about 1.2 s for 96000 estimated tokens).
//
// TypeSafe does not say how it counts (a bucket or a window, how large a burst): four requests of 113k (451k tokens) sent at
// once had no 429, so it takes a burst at least that large, and BURST_SECONDS is a guess above that, which the retry makes
// good when it is wrong. The state is this backend object's (the bucket, the latest sends, the time the account is told to
// wait until), which a hot reload builds anew, full. Other sessions with the same key are not seen either: their part shows
// up as 429s, met the same way.
//
// Pure (see system-one.ts): the clock is the hook's (`io.pace.now`), the timer `io.sleep`; a request without `pace` (the
// eval, which paces its own requests) goes straight through.

import { within, type Asked, type Backend, type BackendIo } from './backend.ts'
import { estimateTokens } from './context.ts'
import { imageTokens } from './images.ts'
import { handedOver, priorityOf } from './pplx-rate.ts'
import type { DecisionRequest } from './system-one.ts'

/** An account's limits: requests and input tokens a second. */
export type JevLimits = { requestsPerSecond: number; tokensPerSecond: number }

/** The default plan's, as the console shows them (2026-10-15): 80 requests and 100,000 input tokens a second. */
export const JEV_DEFAULT_LIMITS: JevLimits = { requestsPerSecond: 80, tokensPerSecond: 100_000 }

/**
 * The bucket holds this many seconds of the token rate: what a burst may spend at once. Four long requests (451k tokens)
 * went out at once without a 429 (2026-10-15), and one request alone may be 262k (the long context's most), far over a
 * second's 100,000.
 */
export const BURST_SECONDS = 5

/** Jev's tokens for each the mod estimates, to plan with: 1.15-1.30 on Chinese conversations (eval v2, ctx30); English up to 1.37. */
export const JEV_TOKENS_PER_ESTIMATED = 1.3

/** How long a 429 without a `Retry-After` holds the requests back, and a 529 (TypeSafe overloaded). */
const HOLD_429_MS = 1000
const HOLD_529_MS = 500

/** Less than this many tokens short is enough: the bucket fills in fractions. */
const TOLERANCE = 0.5

/** The input tokens a request is about to cost, as Jev counts them: its text at the planning factor, its images by their pixels. */
export function jevRequestTokens(request: DecisionRequest): number {
  const text = estimateTokens(JSON.stringify(request.state)) + estimateTokens(JSON.stringify(request.questions))
  return Math.ceil(text * JEV_TOKENS_PER_ESTIMATED) + imageTokens('jev', request.images ?? [], Object.keys(request.questions).length)
}

/** About how long Jev takes over a request of `tokens`: 15 ms a thousand, 300 ms at least (1.14: p50 1.34 s at 100-120k, 2026-10-15). */
export function expectedMs(tokens: number): number {
  return Math.max(300, Math.round((tokens / 1000) * 15))
}

/** What a request took out of the bucket: set right once Jev says what it cost. */
type Taken = { tokens: number }
type Waiter = { priority: number; order: number; wake: () => void }

/** `backend` behind the account's limits, read at each request (`limits`: the person may set them). */
export function jevRateLimited(backend: Backend, limits: () => JevLimits): Backend {
  const queue: Waiter[] = []
  let arrivals = 0
  /** The tokens in the bucket at `filledAt` (null: full, as it starts); below 0 after a request larger than the bucket. */
  let level: number | null = null
  let filledAt = 0
  /** When the requests of the last second went out. */
  let recent: number[] = []
  /** Until when a 429 or a 529 holds every request back. */
  let heldUntil = 0
  /** Who waits for the bucket to fill: woken early when a request gives tokens back. */
  const filling = new Set<() => void>()

  const capacityOf = (tokensPerSecond: number) => Math.max(1, tokensPerSecond) * BURST_SECONDS

  /** The tokens in the bucket at `now`: what it held, and what the rate has put in since, up to what it holds. */
  function fill(now: number, tokensPerSecond: number): number {
    const capacity = capacityOf(tokensPerSecond)
    level = Math.min(capacity, (level ?? capacity) + (Math.max(0, now - filledAt) * Math.max(1, tokensPerSecond)) / 1000)
    // A clock set back puts nothing in until it is past the last fill again.
    filledAt = Math.max(filledAt, now)
    return level
  }

  /** A request cost `cost`: what it took and did not cost goes back (what it cost on top comes out), and who waits looks again. */
  function settle(taken: Taken, cost: number): void {
    const capacity = capacityOf(limits().tokensPerSecond)
    level = Math.min(capacity, (level ?? capacity) + taken.tokens - cost)
    const gave = taken.tokens > cost
    taken.tokens = cost
    if (gave) for (const wake of [...filling]) wake()
  }

  /** How long until a request of `tokens` may go at `now`: 0 when it may go now. */
  function waitAt(now: number, tokens: number): number {
    const { requestsPerSecond, tokensPerSecond } = limits()
    let wait = Math.max(0, heldUntil - now)
    // Sends from the future (the clock was set back) do not count; neither do those over a second old.
    recent = recent.filter((at) => at > now - 1000 && at <= now)
    const perSecond = Math.max(1, Math.floor(requestsPerSecond))
    if (recent.length >= perSecond) wait = Math.max(wait, (recent[recent.length - perSecond] as number) + 1000 - now)
    const lack = Math.min(tokens, capacityOf(tokensPerSecond)) - fill(now, tokensPerSecond)
    if (lack > TOLERANCE) wait = Math.max(wait, Math.ceil((lack * 1000) / Math.max(1, tokensPerSecond)))
    return wait
  }

  /**
   * Waits for a place for a request of `tokens` and takes it: what it took out of the bucket; null when `deadline` comes
   * first or can no longer be met. Only the first in the queue takes a place; a better request that arrives while the
   * first sleeps goes ahead of it, since the first looks at the queue again when it wakes. How long it waited goes to `notes`.
   */
  async function place(pace: NonNullable<BackendIo['pace']>, sleep: BackendIo['sleep'], priority: number, tokens: number, deadline: number, notes: string[]): Promise<Taken | null> {
    const me: Waiter = { priority, order: arrivals++, wake: () => {} }
    queue.push(me)
    const since = await pace.now()
    try {
      for (;;) {
        if (first() !== me) {
          // Not our turn: until the one in front leaves, or the time is up. (No await between the check and `wake`.)
          const woken = new Promise<true>((done) => {
            me.wake = () => done(true)
          })
          const left = deadline - (await pace.now())
          if (left <= 0 || (await within(sleep, woken, left, false)) === false) return null
          continue
        }
        const now = await pace.now()
        if (now >= deadline) return null
        const wait = waitAt(now, tokens)
        if (wait === 0) {
          level = (level as number) - tokens
          recent.push(now)
          if (now > since) notes.push(`waited ${now - since} ms for its place within the account's rate limit`)
          return { tokens }
        }
        // The place comes free after `wait`, or sooner when a request gives tokens back; a request that cannot be sent
        // before its deadline is not held up until it.
        if (now + wait >= deadline) return null
        let wake = () => {}
        const freed = new Promise<true>((done) => {
          wake = () => done(true)
        })
        filling.add(wake)
        try {
          await within(sleep, freed, wait, false)
        } finally {
          filling.delete(wake)
        }
      }
    } finally {
      queue.splice(queue.indexOf(me), 1)
      for (const one of queue) one.wake()
    }
  }

  /** The waiter whose turn it is: the best priority, the earliest of those. */
  function first(): Waiter | undefined {
    return queue.reduce<Waiter | undefined>((best, one) => (best === undefined || one.priority < best.priority || (one.priority === best.priority && one.order < best.order) ? one : best), undefined)
  }

  return {
    name: backend.name,
    get configured() {
      return backend.configured
    },
    ...(backend.longContext === undefined ? {} : { longContext: backend.longContext }),
    async ask(io, request, timeoutMs) {
      const pace = io.pace
      if (pace === undefined || backend.configured === false) return backend.ask(io, request, timeoutMs)
      const priority = priorityOf(request)
      const tokens = jevRequestTokens(request)
      const deadline = (await pace.now()) + timeoutMs
      const notes: string[] = []
      const noAnswer: Asked = { ok: false, failure: { kind: 'timeout', detail: `no answer in ${timeoutMs} ms` } }
      const askOnce = async (): Promise<Asked> => {
        const taken = await place(pace, io.sleep, priority, tokens, deadline, notes)
        if (taken === null) return noAnswer
        const left = deadline - (await pace.now())
        if (left <= 0) return noAnswer
        const asked = await backend.ask(io, request, left)
        // Set right at what Jev says it cost; a refused one cost nothing. Any other failure keeps what it took: it may have been counted.
        if (asked.ok && asked.inputTokens !== null) settle(taken, asked.inputTokens)
        if (holdFor(asked) !== null) settle(taken, 0)
        // Not answered in what was left of the wait: the wait the person set is what the failure says.
        return !asked.ok && asked.failure.kind === 'timeout' && asked.failure.status === undefined ? noAnswer : asked
      }

      const asked = await askOnce()
      const hold = holdFor(asked)
      if (hold === null) return handedOver(asked, notes)
      // Every request waits as long as it was told; this one asks again if its time covers that and an answer.
      const now = await pace.now()
      heldUntil = Math.max(heldUntil, now + hold)
      if (deadline - now < hold + expectedMs(tokens)) return handedOver(asked, notes)
      notes.push(`HTTP ${asked.ok ? '' : String(asked.failure.status)}, asked again after ${hold} ms`)
      return handedOver(await askOnce(), notes)
    },
  }
}

/** How long a refused request holds every request back: a 429's or a 529's `Retry-After`, else HOLD_429_MS or HOLD_529_MS; null for any other answer. */
function holdFor(asked: Asked): number | null {
  if (asked.ok || asked.failure.kind !== 'busy') return null
  const { status, retryAfterMs } = asked.failure
  if (status === 429) return retryAfterMs ?? HOLD_429_MS
  if (status === 529) return retryAfterMs ?? HOLD_529_MS
  return null
}
