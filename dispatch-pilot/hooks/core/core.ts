// The core: the innermost hooks of every event it shares with the features.
// The entry registers it last, so on each event every feature's hook has run
// (on the way down) before the core finishes the event:
//
//   prompt.submit  sends the message's ballot as one decision request, hands
//                  each part its answers, then lets the prompt in
//   turn.start     opens the main turn's record, with the effort its prompt
//                  was decided at
//   turn.step      the one writer of effort (and of a non-main loop's model):
//                  sends every step as the plan table says
//   classic.PreToolUse  notes the calls a settings hook refused (core/outcomes.ts)
//   command.run    notes the command the person runs: the prompt that follows
//                  may be its command turn (core/commands.ts)
//
// The core owns the unmatched registration of these events; a feature always
// registers them with a matcher (DEVELOPMENT.md, 开发).
//
// Switched off (`/dp off`, core/switches.ts) the core stands down: prompt.submit
// asks nothing and turn.step sends every step as the engine made it.

import type { HttpInit, On } from 'claude-code'
import { messageText, turnStartState } from '../decision/context.ts'
import { SKILLS_PART } from '../decision/skills.ts'
import { answersFor, mergeParts, type State } from '../decision/system-one.ts'
import { type Asked, describeAsked, errorText } from '../decision/backend.ts'
import { collect, type Contribution, type PartOutcome } from './ballot.ts'
import { forgetCommand, noteCommand, typedCommand } from './commands.ts'
import { noteBlocked } from './outcomes.ts'
import { newTurn, planStep, replace, takePending, turnKey, type Cell, type PendingDecision } from './plans.ts'
import type { Ctx } from './setup.ts'
import { reportStep, type ReportIo } from './report.ts'
import { masterOn } from './switches.ts'

const PENDING = { plugin: 'dispatch-pilot', key: 'pending' } as const
const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const
const AGENTS = { plugin: 'dispatch-pilot', key: 'agents' } as const
const LOCK = { plugin: 'dispatch-pilot', key: 'lock' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

/** Prompts whose prompt.submit is letting them in right now: a turn that starts meanwhile is theirs. */
const entering: string[] = []

export function registerCore(on: On, ctx: Ctx): void {
  on('prompt.submit', async ($, e, next) => {
    // Every feature above has seen whether this is a command turn.
    forgetCommand(e.text)
    const ballot = collect(e.text)
    // Switched off (/dp off): whatever was put in the ballot is not asked.
    if (ballot.length === 0 || !masterOn()) return next(e)
    const ids = ballot.flatMap((part) => Object.keys(part.questions).map((id) => `${part.part}.${id}`)).join(', ')
    const startedAt = await $.clock.now()
    const messages = ctx.config.context.messages > 0 ? await $.session.messages().catch(() => []) : []
    let asked: Asked
    let state: State = {}
    try {
      // The state's budget follows the request's longest question: the skills' question leaves less than any other.
      const tokens = ballot.some((part) => part.part === SKILLS_PART) ? ctx.config.context.tokens : ctx.config.contextByKind.messagePlain
      const request = mergeParts(turnStartState({ prompt: e.text, messages, limits: { ...ctx.config.context, tokens } }), ballot)
      state = request.state
      const io = {
        fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
        sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
      }
      asked = await ctx.backend.ask(io, request, ctx.config.timeoutMs)
    } catch (error) {
      // A part's malformed questions: nothing was sent.
      asked = { ok: false, failure: { kind: 'request', detail: errorText(error) } }
    }
    const ms = (await $.clock.now()) - startedAt
    $.ui.log(`request [${ids}] to ${ctx.backend.name}: ${describeAsked(asked, ms)}`, { to: 'debug' })
    const blocks = await settleAll(ballot, asked, state)
    entering.push(e.text)
    try {
      return await next(blocks.length > 0 ? { ...e, context: [...(e.context ?? []), ...blocks] } : e)
    } finally {
      const at = entering.indexOf(e.text)
      if (at >= 0) entering.splice(at, 1)
    }
  })

  on('command.run', async ($, e, next) => {
    noteCommand(e)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const pending: Cell<PendingDecision[]> = { get: () => $.state.get(PENDING), set: (value, options) => $.state.set(PENDING, value, options) }
    // A command turn starts with the engine's command message: the prompt was the command as typed.
    const started = typedCommand(e.text) ?? e.text
    // Its own prompt's decision: the prompt now entering (whatever an inner
    // hook made of its text), else a queued prompt with the turn's text.
    const texts = entering.length === 1 ? [entering[0] as string, started] : [started]
    const { before } = await replace(pending, (list) => takePending(list ?? [], texts).rest)
    // What the landed write took out of the list it found.
    const own = takePending(before ?? [], texts).taken
    // The turn's message as the decision model read it (later decisions about the turn reuse it). A pending
    // entry, decided or not, says the person's own message started the turn (only such a turn is re-decided);
    // one marked `report` says a report did (decided at its start, not re-decided).
    const prompt = messageText(started, ctx.config.contextByKind.rejudge)
    await $.state.set({ ...TURNS, id: turnKey(e.turnId, undefined) }, newTurn(prompt, own?.effort ?? null, own !== null && own.report !== true))
    return next(e)
  })

  // Beneath every feature's tool.call: which calls a PreToolUse settings hook refused (the call itself then only
  // sees an error), for the features that count failures and read a loop's steps (core/outcomes.ts).
  on('classic.PreToolUse', async ($, e, next) => {
    const decided = await next(e)
    if (decided.deny !== undefined && e.tool_use_id) noteBlocked(e.tool_use_id)
    return decided
  })

  on('turn.step', async function* ($, e, next) {
    // Switched off (/dp off): every step goes out as the engine made it, lock or no lock.
    if (!masterOn()) return yield* next(e)
    const agentId = e.agentId
    const { value: turn } = await $.state.get({ ...TURNS, id: turnKey(e.turnId, agentId) })
    const { value: agent } = agentId === undefined ? { value: undefined } : await $.state.get({ ...AGENTS, id: agentId })
    const { value: lock = null } = agentId === undefined ? await $.state.get(LOCK) : { value: null }
    const { step, source } = planStep(e, { lock, turn, agent })
    // What the step goes out with, for the board (and the status line it draws): the main agent's, for now.
    if (agentId === undefined) {
      const io: ReportIo = {
        board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
        decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
        debug: (line) => $.ui.log(line, { to: 'debug' }),
        status: (line) => $.ui.status(line),
      }
      await reportStep(io, { model: step.model, effort: step.effort, source })
    }
    return yield* next(step)
  })
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
