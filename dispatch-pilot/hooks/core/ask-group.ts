// The requests of a message's ballot: asked of the decision model that decides, logged, and each part of each handed its
// outcome. The core sends a ballot's groups at `prompt.submit`; the image-routing feature (#63) sends the main agent's
// effort group at `turn.start`, once the reference images have been read. One function, so that what is asked of the model
// and what is logged are the same wherever the effort question goes out (ADR 0005).
//
// The requests of one message go out at once and share one wait (`waitFor`): when one of them is past the decision
// model's regular limits (the effort question's, with a long conversation), the others may wait behind it for their place
// within the account's token rate (Jev's pacing, decision/jev-rate.ts: the effort question goes first), so they all wait as
// long as it may.
//
// Pure of `$`: the engine comes in as closures, as for `BackendIo` (a module cannot pass `$` across an import).

import { type Asked, type BackendIo, describeAsked, errorText } from '../decision/backend.ts'
import { SKILLS_PART } from '../decision/skills.ts'
import { answersFor, type DecisionRequest, type State } from '../decision/system-one.ts'
import { messageRequest } from '../decision/turn-start.ts'
import type { Contribution, PartOutcome } from './ballot.ts'
import { messageLimits, waitFor, type Ctx } from './setup.ts'

/** What a request needs of the engine. */
export type AskIo = {
  backend: BackendIo
  now: () => Promise<number>
  /** A line for the debug log. */
  debug: (line: string) => void
}

export type AskInput = {
  /** The message the ballot belongs to. */
  prompt: string
  /** The conversation the decision model reads beside it (`$.session.messages()`; none when the setting reads none). */
  messages: Parameters<typeof messageRequest>[0]['messages']
  /** The groups of parts, each one request. */
  groups: readonly (readonly Contribution[])[]
  /** The most the requests may wait (what the hook has left); otherwise the decision model's wait for them (`waitFor`). */
  maxWaitMs?: number
}

/**
 * Sends each group of `groups` as one request, all at once, and hands every part its outcome (in parallel); resolves to
 * the context blocks the parts return, in ballot order. A part's malformed questions are a `request` failure for its whole
 * group: nothing of it was sent.
 */
export async function askGroups(io: AskIo, ctx: Ctx, input: AskInput): Promise<string[]> {
  const { prompt, messages, groups } = input
  const built = groups.map((group): { group: readonly Contribution[]; request: DecisionRequest } | { group: readonly Contribution[]; error: unknown } => {
    try {
      // The state's budget follows the request's longest question: the skills' question leaves less than any other.
      const limits = messageLimits(ctx.config, group.some((part) => part.part === SKILLS_PART))
      return { group, request: messageRequest({ prompt, messages, limits, parts: group }) }
    } catch (error) {
      return { group, error }
    }
  })
  const requests = built.flatMap((one) => ('request' in one ? [one.request] : []))
  const waitMs = Math.min(input.maxWaitMs ?? Number.POSITIVE_INFINITY, waitFor(ctx, requests))
  const blocks = await Promise.all(
    built.map(async (one) => {
      const startedAt = await io.now()
      const ids = one.group.flatMap((part) => Object.keys(part.questions).map((id) => `${part.part}.${id}`)).join(', ')
      // A part's malformed questions: nothing was sent.
      const asked: Asked = 'request' in one ? await ctx.backend.ask(io.backend, one.request, waitMs) : { ok: false, failure: { kind: 'request', detail: errorText(one.error) } }
      const ms = (await io.now()) - startedAt
      io.debug(`request [${ids}] to ${ctx.backend.name}: ${describeAsked(asked, ms)}`)
      return settleAll(io, one.group, asked, 'request' in one ? one.request.state : {}, waitMs)
    }),
  )
  return blocks.flat()
}

/** Hands each part its outcome (in parallel) and gathers the context blocks they return, in ballot order. A part whose `settle` throws is logged and gives none. */
async function settleAll(io: AskIo, ballot: readonly Contribution[], asked: Asked, state: State, waitMs: number): Promise<string[]> {
  const settled = await Promise.all(
    ballot.map(async (contribution) => {
      const outcome: PartOutcome = asked.ok ? { ok: true, answers: answersFor(contribution, asked.answers), state, waitMs } : { ok: false, failure: asked.failure }
      try {
        return (await contribution.settle(outcome)) ?? []
      } catch (error) {
        io.debug(`${contribution.part} could not settle its outcome: ${errorText(error)}`)
        return []
      }
    }),
  )
  return settled.flat()
}
