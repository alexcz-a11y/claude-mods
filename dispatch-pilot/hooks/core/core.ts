// The core: the innermost hooks of every event it shares with the features.
// The entry registers it last, so on each event every feature's hook has run
// (on the way down) before the core finishes the event:
//
//   prompt.submit  sends the message's ballot as up to two decision requests
//                  (the effort question alone, the rest together; ADR 0005),
//                  in parallel, hands each part its answers, then lets the
//                  prompt in
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
import { messageText } from '../decision/context.ts'
import { EFFORT_PART } from '../decision/effort.ts'
import { SKILLS_PART } from '../decision/skills.ts'
import { answersFor, type State } from '../decision/system-one.ts'
import { messageRequest } from '../decision/turn-start.ts'
import { type Asked, type BackendIo, describeAsked, errorText } from '../decision/backend.ts'
import { collect, type Contribution, type PartOutcome } from './ballot.ts'
import { forgetCommand, noteCommand, typedCommand } from './commands.ts'
import { noteBlocked } from './outcomes.ts'
import { newTurn, planStep, replace, takePending, turnKey, type Cell, type PendingDecision } from './plans.ts'
import { messageLimits, type Ctx } from './setup.ts'
import { reportStep, type StepIo } from './report.ts'
import { masterOn } from './switches.ts'

const PENDING = { plugin: 'dispatch-pilot', key: 'pending' } as const
const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const
const AGENTS = { plugin: 'dispatch-pilot', key: 'agents' } as const
const LOCK = { plugin: 'dispatch-pilot', key: 'lock' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
const WORKFLOW_RUNS = { plugin: 'dispatch-pilot', key: 'workflowRuns' } as const
const LABEL_RUNS = { plugin: 'dispatch-pilot', key: 'labelRuns' } as const
const PPLX_RATE = { plugin: 'dispatch-pilot', key: 'pplxRate' } as const

/** Prompts whose prompt.submit is letting them in right now: a turn that starts meanwhile is theirs. */
const entering: string[] = []

export function registerCore(on: On, ctx: Ctx): void {
  on('prompt.submit', async ($, e, next) => {
    // Every feature above has seen whether this is a command turn.
    forgetCommand(e.text)
    const ballot = collect(e.text)
    // Switched off (/dp off): whatever was put in the ballot is not asked.
    if (ballot.length === 0 || !masterOn()) return next(e)
    const messages = ctx.config.context.messages > 0 ? await $.session.messages().catch(() => []) : []
    const io: BackendIo = {
      fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
      sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
      pace: { now: () => $.clock.now(), sent: { get: () => $.state.get(PPLX_RATE), set: (value, options) => $.state.set(PPLX_RATE, value, options) } },
    }
    // The main agent's effort goes in a request of its own (ADR 0005), the rest of the ballot in one. Both go out at once,
    // each is answered or fails on its own, and each part reads the outcome of the request it was in.
    const blocks = (
      await Promise.all(
        requestGroups(ballot).map(async (group) => {
          const startedAt = await $.clock.now()
          const ids = group.flatMap((part) => Object.keys(part.questions).map((id) => `${part.part}.${id}`)).join(', ')
          let asked: Asked
          let state: State = {}
          try {
            // The state's budget follows the request's longest question: the skills' question leaves less than any other.
            const limits = messageLimits(ctx.config, group.some((part) => part.part === SKILLS_PART))
            const request = messageRequest({ prompt: e.text, messages, limits, parts: group })
            state = request.state
            asked = await ctx.backend.ask(io, request, ctx.config.timeoutMs)
          } catch (error) {
            // A part's malformed questions: nothing was sent.
            asked = { ok: false, failure: { kind: 'request', detail: errorText(error) } }
          }
          const ms = (await $.clock.now()) - startedAt
          $.ui.log(`request [${ids}] to ${ctx.backend.name}: ${describeAsked(asked, ms)}`, { to: 'debug' })
          return settleAll(group, asked, state)
        }),
      )
    ).flat()
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
    // What the step goes out with, for the board: every loop's, the main agent's included.
    const io: StepIo = {
      board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
      decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
      debug: (line) => $.ui.log(line, { to: 'debug' }),
      now: () => $.clock.now(),
      toast: (text) => $.ui.toast(text),
      agents: () => $.agent.list(),
      runDirs: async () => {
        const [noted, labelled] = await Promise.all([$.state.get(WORKFLOW_RUNS), $.state.get(LABEL_RUNS)])
        return [...new Set([...(noted.value ?? []), ...(labelled.value ?? [])].map((run) => run.dir))]
      },
      journal: async (dir) => {
        const path = `${dir}/journal.jsonl`
        return (await $.fs.exists(path)) ? await $.fs.read(path).catch(() => null) : null
      },
    }
    await reportStep(io, { ...(agentId === undefined ? {} : { agentId }), model: step.model, effort: step.effort, source })
    return yield* next(step)
  })
}

/**
 * The requests a ballot goes out in: the main agent's effort question alone, every other part's together (the skills'
 * question is the longest and sets a smaller state budget, so it cannot share a request with the effort question without
 * cutting the conversation the effort question reads). A group no part is in is not made: no empty request.
 */
function requestGroups(ballot: readonly Contribution[]): Contribution[][] {
  return [ballot.filter((part) => part.part === EFFORT_PART), ballot.filter((part) => part.part !== EFFORT_PART)].filter((group) => group.length > 0)
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
