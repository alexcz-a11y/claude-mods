// Jev's rate limits (2026-10-15). TypeSafe limits an account (an organization) in requests and in input tokens a second
// (docs.typesafe.ai, Rate limits; the console shows an account's own: the default plan's are 80 requests and 100,000 input
// tokens a second), and answers a request over either with 429; a 529 says TypeSafe is overloaded. Every Jev request of the
// mod goes through this pacing, which keeps the mod's own requests within those limits:
//
// - at most `requestsPerSecond` requests go out in any second;
// - the input tokens come out of a bucket that holds BURST_SECONDS of the rate and fills at the rate: a burst may spend a
//   few seconds of it at once (a message's long effort request and a few agents' together), then requests go as fast as it
//   fills. A request takes out what it is about to cost (`jevRequestTokens`: the mod's estimate at Jev's count), set right
//   at what Jev says it cost once answered; one larger than the bucket goes when the bucket is full (the mod's own are not
//   larger at the default plan's rate, but are at the lowest `jevTokensPerSecond`);
// - the queue is the one of pplx (rate-queue.ts): the effort question of a message goes first (the person waits for it),
//   the rest in the order they came, and a request waits behind the one in front even when it would fit;
// - a 429 or a 529 holds every request back for as long as it says (`Retry-After` up to MAX_HOLD_MS; else a second, or half
//   a second for a 529), and the request that got it asks once more, in its old place in line, when the time it has left
//   covers that and an answer.
//
// A request that cannot have its place within its own wait fails without being sent, as a timeout (the time it waits for its
// place is part of its wait, as with pplx), or as busy when the hold of a 429 or 529 outlasts the wait: the account was told
// to wait, which is not the same as no answer. Jev answers several requests of a key at once (four of 115k tokens took
// 1.39-1.53 s, one alone 1.44 s, 2026-10-15), so the pacing costs nothing until the limits near; at its worst, with the
// bucket empty, a message's effort request goes first and waits as long as the bucket takes to fill its own tokens (about
// 1.2 s for 96000 estimated tokens).
//
// TypeSafe does not say how it counts (a bucket or a window, how large a burst): four requests of 113k (451k tokens) sent at
// once had no 429, so it takes a burst at least that large, and BURST_SECONDS is a guess above that, which the retry makes
// good when it is wrong. The state is this backend object's (the bucket, the latest sends, the time the account is told to
// wait until), which a hot reload builds anew, full. Other sessions with the same key are not seen either: their part shows
// up as 429s, met the same way.
//
// Pure (see system-one.ts): the clock is the hook's (`io.pace.now`), the timer `io.sleep`; a request without `pace` (the
// eval, which paces its own requests) goes straight through.

import { timedOut, type Asked, type Backend } from './backend.ts'
import { estimateTokens } from './context.ts'
import { imageTokens } from './images.ts'
import { handedOver, LEAST_SEND_MS, rateQueue } from './rate-queue.ts'
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

/** Jev's tokens for each the mod estimates, to plan with: 1.15-1.30 on Chinese conversations, mostly 1.2 (eval v2, ctx30); up to 1.37 on English and skill profiles. */
export const JEV_TOKENS_PER_ESTIMATED = 1.3

/** How long a 429 without a `Retry-After` holds the requests back, and a 529 (TypeSafe overloaded). */
const HOLD_429_MS = 1000
const HOLD_529_MS = 500

/**
 * The longest a `Retry-After` holds the requests back: a bucket's worth. A per-second limit asks for seconds; a longer wait
 * says something else is wrong, and the requests find that out by being sent, which holding them for an hour would not.
 */
export const MAX_HOLD_MS = BURST_SECONDS * 1000

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

/** What an answer asks the account to do: wait `ms`, told by a `status` (429 or 529). */
type Hold = { ms: number; status: number }

/** `backend` behind the account's limits, read at each request (`limits`: the person may set them). */
export function jevRateLimited(backend: Backend, limits: () => JevLimits): Backend {
  const queue = rateQueue()
  /** The tokens in the bucket at `filledAt` (null: full, as it starts); below 0 after a request larger than the bucket. */
  let level: number | null = null
  let filledAt = 0
  /** When the requests of the last second went out. */
  let recent: number[] = []
  /** Until when, and by which status, a 429 or a 529 holds every request back. */
  let held: { until: number; status: number } | null = null

  const capacityOf = (tokensPerSecond: number) => Math.max(1, tokensPerSecond) * BURST_SECONDS

  /** The tokens in the bucket at `now`: what it held, and what the rate has put in since, up to what it holds. */
  function fill(now: number, tokensPerSecond: number): number {
    const capacity = capacityOf(tokensPerSecond)
    level = Math.min(capacity, (level ?? capacity) + (Math.max(0, now - filledAt) * Math.max(1, tokensPerSecond)) / 1000)
    // A clock set back puts nothing in until it is past the last fill again.
    filledAt = Math.max(filledAt, now)
    return level
  }

  /** A request that took `taken` tokens cost `cost`: what it took and did not cost goes back (what it cost on top comes out), and who waits looks again. */
  function settle(taken: number, cost: number): void {
    const capacity = capacityOf(limits().tokensPerSecond)
    level = Math.min(capacity, (level ?? capacity) + taken - cost)
    if (taken > cost) queue.nudge()
  }

  /** How long until a request of `tokens` may go at `now`: 0 when it may go now, and then its place is taken. */
  function take(now: number, tokens: number): number {
    const { requestsPerSecond, tokensPerSecond } = limits()
    let wait = held === null ? 0 : Math.max(0, held.until - now)
    // Sends from the future (the clock was set back) do not count; neither do those over a second old.
    recent = recent.filter((at) => at > now - 1000 && at <= now)
    const perSecond = Math.max(1, Math.floor(requestsPerSecond))
    if (recent.length >= perSecond) wait = Math.max(wait, (recent[recent.length - perSecond] as number) + 1000 - now)
    const lack = Math.min(tokens, capacityOf(tokensPerSecond)) - fill(now, tokensPerSecond)
    if (lack > TOLERANCE) wait = Math.max(wait, Math.ceil((lack * 1000) / Math.max(1, tokensPerSecond)))
    if (wait === 0) {
      level = (level as number) - tokens
      recent.push(now)
    }
    return wait
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
      // The place in line is taken at once and kept through a retry.
      const ticket = queue.ticket(request)
      const tokens = jevRequestTokens(request)
      const deadline = (await pace.now()) + timeoutMs
      const notes: string[] = []
      const noAnswer: Asked = { ok: false, failure: timedOut(timeoutMs) }

      /** Why a request got no place within its wait: busy when a hold outlasts it, else the time ran out. */
      const unplaced = async (): Promise<Asked> => {
        const hold = held
        const now = await pace.now()
        if (hold === null || hold.until <= now || hold.until + LEAST_SEND_MS <= deadline) return noAnswer
        return { ok: false, failure: { kind: 'busy', status: hold.status, detail: `HTTP ${hold.status} earlier: not sent, the account was told to wait ${hold.until - now} ms more and this request waits ${timeoutMs} ms` } }
      }

      /** One go: a place, the request, and what its answer says to the bucket and to the hold. */
      const askOnce = async (): Promise<{ asked: Asked; hold: Hold | null }> => {
        const waited = await queue.place(ticket, deadline, { now: pace.now, sleep: io.sleep }, (now) => take(now, tokens))
        if (waited === null) return { asked: await unplaced(), hold: null }
        if (waited > 0) notes.push(`waited ${waited} ms for its place within the account's rate limit`)
        const left = deadline - (await pace.now())
        if (left < LEAST_SEND_MS) {
          settle(tokens, 0)
          return { asked: noAnswer, hold: null }
        }
        const asked = await backend.ask(io, request, left)
        const hold = holdFor(asked)
        if (hold !== null) {
          // A refused one cost nothing. The hold is in place before the tokens go back: that wakes whoever waits for them,
          // and they must find the hold there.
          const now = await pace.now()
          if (held === null || now + hold.ms > held.until) held = { until: now + hold.ms, status: hold.status }
          settle(tokens, 0)
        } else if (asked.ok && asked.inputTokens !== null) {
          // Set right at what Jev says it cost. Any other failure keeps what it took: it may have been counted.
          settle(tokens, asked.inputTokens)
        }
        // Not answered in what was left of the wait: the wait the person set is what the failure says.
        return { asked: !asked.ok && asked.failure.kind === 'timeout' && asked.failure.status === undefined ? noAnswer : asked, hold }
      }

      const first = await askOnce()
      if (first.hold === null) return handedOver(first.asked, notes)
      // Every request waits as long as it was told; this one asks again if its time covers that and an answer.
      if (deadline - (await pace.now()) < first.hold.ms + expectedMs(tokens)) return handedOver(first.asked, notes)
      notes.push(`HTTP ${first.hold.status}, asked again after ${first.hold.ms} ms`)
      return handedOver((await askOnce()).asked, notes)
    },
  }
}

/** How long a refused request holds every request back: a 429's or a 529's `Retry-After` (at most MAX_HOLD_MS), else HOLD_429_MS or HOLD_529_MS; null for any other answer. */
function holdFor(asked: Asked): Hold | null {
  if (asked.ok || asked.failure.kind !== 'busy') return null
  const { status, retryAfterMs } = asked.failure
  if (status !== 429 && status !== 529) return null
  return { ms: Math.min(retryAfterMs ?? (status === 429 ? HOLD_429_MS : HOLD_529_MS), MAX_HOLD_MS), status }
}
