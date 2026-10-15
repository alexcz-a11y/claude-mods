// One request of a message's ballot: asked of the decision model that decides, logged, and each part of it handed its
// outcome. The core sends the groups of a ballot at `prompt.submit` with it; the image-routing feature (#63) sends the main
// agent's effort group at `turn.start` with it, once the reference images have been read. One function, so that what is asked
// of the model and what is logged are the same wherever the effort question goes out (ADR 0005).
//
// Pure of `$`: the engine comes in as closures, as for `BackendIo` (a module cannot pass `$` across an import).

import { type Asked, type BackendIo, describeAsked, errorText } from '../decision/backend.ts'
import { SKILLS_PART } from '../decision/skills.ts'
import { answersFor, type State } from '../decision/system-one.ts'
import { messageRequest } from '../decision/turn-start.ts'
import type { Contribution, PartOutcome } from './ballot.ts'
import { messageLimits, type Ctx } from './setup.ts'

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
  group: readonly Contribution[]
  /** How long the request may take; the decision model's setting (`config.timeoutMs`) unless given. */
  timeoutMs?: number
}

/**
 * Sends `group` as one request and hands every part its outcome (in parallel); resolves to the context blocks the parts return,
 * in ballot order. A part's malformed questions are a `request` failure for the whole group: nothing was sent.
 */
export async function askGroup(io: AskIo, ctx: Ctx, input: AskInput): Promise<string[]> {
  const { prompt, messages, group } = input
  const startedAt = await io.now()
  const ids = group.flatMap((part) => Object.keys(part.questions).map((id) => `${part.part}.${id}`)).join(', ')
  let asked: Asked
  let state: State = {}
  try {
    // The state's budget follows the request's longest question: the skills' question leaves less than any other.
    const limits = messageLimits(ctx.config, group.some((part) => part.part === SKILLS_PART))
    const request = messageRequest({ prompt, messages, limits, parts: group })
    state = request.state
    asked = await ctx.backend.ask(io.backend, request, input.timeoutMs ?? ctx.config.timeoutMs)
  } catch (error) {
    // A part's malformed questions: nothing was sent.
    asked = { ok: false, failure: { kind: 'request', detail: errorText(error) } }
  }
  const ms = (await io.now()) - startedAt
  io.debug(`request [${ids}] to ${ctx.backend.name}: ${describeAsked(asked, ms)}`)
  return settleAll(group, asked, state)
}

/** Hands each part its outcome (in parallel) and gathers the context blocks they return, in ballot order. */
async function settleAll(ballot: readonly Contribution[], asked: Asked, state: State): Promise<string[]> {
  const settled = await Promise.all(
    ballot.map(async (contribution) => {
      const outcome: PartOutcome = asked.ok ? { ok: true, answers: answersFor(contribution, asked.answers), state } : { ok: false, failure: asked.failure }
      try {
        return (await contribution.settle(outcome)) ?? []
      } catch {
        return []
      }
    }),
  )
  return settled.flat()
}
