// A message's ballot: the questions every feature wants asked about the
// message the person just sent, gathered so they go out as ONE decision
// request (one round trip; questions in one request do not see each other's
// answers, guide §2.2 Q10-Q12).
//
// How it runs, all inside one prompt.submit dispatch:
//   1. A feature's prompt.submit hook (outer, registered above the core)
//      calls `contribute(e.text, { part, questions, settle })` and passes the
//      prompt on. `settle` is a closure over that hook's own `$`.
//   2. The core's prompt.submit hook (innermost) `collect`s the ballot, sends
//      one request, and calls every `settle` with that part's answers (under
//      its own ids) or the failure, before letting the prompt in. The context
//      blocks the settles return are attached after the prompt.
//
// Pure module state: lost on a hot reload, which only costs the decision of a
// prompt submitted during that reload.

import type { Failure } from '../decision/backend.ts'
import type { Answer, Part, State } from '../decision/system-one.ts'

/**
 * A part's answers, by its own question ids (a missing or malformed one is
 * left out), and the state they were asked about (a follow-up request, such
 * as the skills' second stage, asks about the same); or why there are none.
 */
export type PartOutcome = { ok: true; answers: Readonly<Record<string, Answer>>; state: State } | { ok: false; failure: Failure }

/** A feature's share of a message's decision request. */
export type Contribution = Part & {
  /**
   * Called once, before the prompt enters the session, with this part's
   * outcome. Resolves to context blocks the model reads after the prompt
   * (none by default). It runs inside the core's hook, so it may use the
   * `$` of the hook that contributed it; whatever it throws is logged and
   * skipped.
   */
  settle: (outcome: PartOutcome) => Promise<readonly string[] | void> | readonly string[] | void
}

/** Ballots waiting for the core, by prompt text (the engine gives a prompt no id); oldest first. */
const open = new Map<string, Contribution[]>()
/** Contributions nobody collected (a reload, a broken chain) stop piling up here. */
const MAX_OPEN = 32

/** Adds a feature's questions to the ballot of the prompt with this text. */
export function contribute(prompt: string, contribution: Contribution): void {
  const list = open.get(prompt) ?? []
  list.push(contribution)
  open.set(prompt, list)
  let total = 0
  for (const waiting of open.values()) total += waiting.length
  for (const [text, waiting] of open) {
    if (total <= MAX_OPEN) break
    total -= waiting.length
    open.delete(text)
  }
}

/**
 * Takes the ballot of the prompt with this text: the oldest contribution of
 * each part. Any later one of the same part (the same text submitted twice at
 * once) stays for the next collect of that text.
 */
export function collect(prompt: string): Contribution[] {
  const list = open.get(prompt) ?? []
  const taken: Contribution[] = []
  const left: Contribution[] = []
  for (const contribution of list) {
    if (taken.some((c) => c.part === contribution.part)) left.push(contribution)
    else taken.push(contribution)
  }
  if (left.length > 0) open.set(prompt, left)
  else open.delete(prompt)
  return taken
}
