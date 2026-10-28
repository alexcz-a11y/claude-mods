// The rate limit on pplx requests (#51; ADR 0006). A Perplexity Tier 0 account takes 1 request a second (QPS), and one
// message sends two or three (the effort question, the skills' two stages) while a dispatched agent or find_skill ask
// beside them, so every pplx request goes through the queue (rate-queue.ts), which aims at `qps`
// requests in any second, the effort question of a message first, the rest in the order they came. Jev has pacing of its
// own (jev-rate.ts).
//
// What is kept and what is only aimed at: the count of the latest sends is kept in a `$.state` cell with optimistic writes
// (`ifVersion`), so two requests never both take the last place of a second. Priority and order are kept by the queue,
// state of this backend object, between requests that have not yet started to take their place: a request that arrives while the one
// in front is in the middle of taking its place (a few awaits) does not get ahead of it. And the whole limit fails open:
// a cell that cannot be read, or written within ATTEMPTS tries, lets the request out and says so in the debug log (`notes`
// of the answer), because Perplexity's own 429 is all that follows and the one 429 retry below deals with it.
//
// The time a request spends in the queue is part of its own wait: `timeoutMs` counts from the moment it was asked. When a
// 429 comes anyway the request asks once more if the time left covers the `Retry-After` it was given and an ordinary
// request; otherwise it fails as it is, and the person reads 「被限速」 (backend.ts FAILURE_WORDS).
//
// Pure (see system-one.ts): the clock and the `$.state` cell come in through `BackendIo.pace`, built by the hook that calls.
// The times of the latest sends live in that cell, so a hot reload (which builds the backend anew) goes on from them
// and does not let a burst out; the queue itself is not kept: the requests it holds are those of the old module, which
// the engine drops with it, so nothing is lost that was not lost anyway.

import { timedOut, type Asked, type Backend, type Failure, type StateCell } from './backend.ts'
import { handedOver, LEAST_SEND_MS, rateQueue } from './rate-queue.ts'

/** What an ordinary pplx request takes (ADR 0006: about 5 s): a retry after a 429 needs this much time on top of the wait it was told. */
const EXPECTED_REQUEST_MS = 5000

/** The window the limit counts in: `qps` requests a second. */
const WINDOW_MS = 1000

/** How often a lost write of the cell is tried again before the limit is given up for this request. */
const ATTEMPTS = 8

/**
 * `backend` behind the rate limit. A request whose `io` has no `pace` (the eval, which paces its own requests) goes
 * straight through, as does one asked without a key (it sends nothing).
 */
export function rateLimited(backend: Backend, qps: number): Backend {
  const queue = rateQueue()

  return {
    name: backend.name,
    get configured() {
      return backend.configured
    },
    async ask(io, request, timeoutMs) {
      const pace = io.pace
      if (pace === undefined || backend.configured === false) return backend.ask(io, request, timeoutMs)
      const ticket = queue.ticket(request)
      const deadline = (await pace.now()) + timeoutMs
      const notes: string[] = []
      const noAnswer: Asked = { ok: false, failure: timedOut(timeoutMs) }
      const askOnce = async (): Promise<Asked> => {
        // A limit that could not be kept is added to `notes` (the request goes out anyway).
        if ((await queue.place(ticket, deadline, { now: pace.now, sleep: io.sleep }, (now) => takeFromCell(pace.sentAt, now, qps, notes))) === null) return noAnswer
        const left = deadline - (await pace.now())
        if (left < LEAST_SEND_MS) return noAnswer
        const asked = await backend.ask(io, request, left)
        // Not answered in what was left of the wait: the wait the person set is what the failure says.
        return !asked.ok && asked.failure.kind === 'timeout' && asked.failure.status === undefined ? noAnswer : asked
      }

      const asked = await askOnce()
      const wait = retryWait(asked)
      // A 429 with a wait to read: once more if the time left allows the wait and an ordinary request; else it stays a 429.
      if (wait === null || deadline - (await pace.now()) < wait + EXPECTED_REQUEST_MS) return handedOver(asked, notes)
      // Nothing cancels a request once it is asked (`ask` takes no signal), and this sleep ends by itself within the request's own wait.
      if (wait > 0) await io.sleep(wait, new AbortController().signal).catch(() => {})
      return handedOver(await askOnce(), notes)
    },
  }
}

/** How long a failed request was told to wait before it asks again: only a 429 that gave a `Retry-After`; null for every other failure. */
function retryWait(asked: Asked): number | null {
  if (asked.ok) return null
  const failure: Failure = asked.failure
  return failure.status === 429 && failure.retryAfterMs !== undefined ? failure.retryAfterMs : null
}

/**
 * Takes a place for a send at `now`: 0 when it was free (the time is written into the cell), else the ms until the oldest
 * send of the last second leaves the window. The cell holds at most `qps` times. Fails open, with a note for the debug log:
 * a cell that cannot be read or written, or a write lost ATTEMPTS times to other writers, does not stop the request.
 */
async function takeFromCell(cell: StateCell<number[]>, now: number, qps: number, notes: string[]): Promise<number> {
  try {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const { value, version } = await cell.get()
      // Times from the future (the clock was set back) do not count; neither do those a second ago.
      const recent = (value ?? []).filter((at) => at > now - WINDOW_MS && at <= now)
      if (recent.length >= qps) return (recent[recent.length - qps] as number) + WINDOW_MS - now
      if ((await cell.set([...recent, now], { ifVersion: version })).isSet) return 0
    }
    notes.push(`rate limit not kept (the record of sends could not be written after ${ATTEMPTS} tries)`)
  } catch (error) {
    notes.push(`rate limit not kept (the record of sends failed: ${error instanceof Error ? error.message : String(error)})`)
  }
  return 0
}
