// Feature: the main agent's effort, decided each time the person sends a
// message, and when a report starts a turn of its own: a dispatched agent's
// hand-back or a background task's notice reaching the idle session (those
// turns are usually a look at a result and the next dispatch; the session's own
// effort would be a waste). It adds the effort question to the message's ballot
// (the core sends it); the answer becomes the effort of the turn the message
// starts, on every step of that turn (the core's turn.step writer). A report's
// text is read as the message; its turn is not re-decided mid-turn.
//
// A command turn (#19: `/implement #19`, a skill or markdown command the
// person typed) is decided like their message: the decision model reads the
// command as typed and what the command is for (core/commands.ts), never the
// prompt it expands to.
//
// A message typed while a turn runs (`e.turnId`) is delivered into that turn
// at its next step (a `queued_command` attachment; measured on 2.1.289), so
// its decision takes the running turn from then on. It also waits as pending,
// in case the turn ends first and the message starts a turn of its own.

import type { EngineInterface, On } from 'claude-code'
import { EFFORTS, LEVEL, readEffort, readingText, traceEffort, turnStartEffortPart, type Effort, type EffortReading } from '../decision/effort.ts'
import { quoteStart } from '../decision/redact.ts'
import { contribute } from '../core/ballot.ts'
import { commandOf, commandState } from '../core/commands.ts'
import { addPending, revise, turnKey, update, type Cell, type PendingDecision, type TurnRecord } from '../core/plans.ts'
import { isPersonsMessage, startsReportTurn } from '../core/prompts.ts'
import { reportDecision, type ReportIo } from '../core/report.ts'
import type { Ctx } from '../core/setup.ts'
import { defineSwitch, isOn } from '../core/switches.ts'

const PENDING = { plugin: 'dispatch-pilot', key: 'pending' } as const
const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
const CATALOG = { plugin: 'dispatch-pilot', key: 'skillCatalog' } as const

/**
 * What a command turn's command is for: its skill in the session's catalog as
 * the skills feature read it (by its profile while profiles are on), else the
 * command as `$.command.list()` describes it.
 */
async function describeCommand($: EngineInterface, name: string): Promise<Readonly<Record<string, string>> | null> {
  const { value: catalog } = await $.state.get(CATALOG)
  const found = catalog?.skills.find((skill) => skill.name === name)
  const skill = found && !isOn('skill-profiles') ? { ...found, profile: null } : found
  const listed = skill?.description ? undefined : (await $.command.list().catch(() => [])).find((command) => command.name === name)?.description
  return commandState(name, skill, listed)
}

export function registerMainEffort(on: On, ctx: Ctx): void {
  defineSwitch({ name: 'main-effort', info: "decides the main agent's effort when you send a message" })

  on('prompt.submit', { text: /(?:)/ }, async ($, e, next) => {
    // The person's own message, or a report that starts a turn of its own (a dispatched agent's hand-back, a task notice).
    const report = !isPersonsMessage(e) && startsReportTurn(e)
    if ((!isPersonsMessage(e) && !report) || !isOn('main-effort')) return next(e)
    const pending: Cell<PendingDecision[]> = { get: () => $.state.get(PENDING), set: (value, options) => $.state.set(PENDING, value, options) }
    let added: PendingDecision | null = null

    /** The message waits for its turn, decided or not: the turn it starts is the person's own (mid-turn re-decisions are for such turns). */
    const wait = async (effort: Effort | null) => {
      const entry: PendingDecision = { text: e.text, effort, at: await $.clock.now(), ...(report ? { report: true as const } : {}) }
      await update(pending, (list) => addPending(list ?? [], entry))
      added = entry
    }

    const ran = report ? null : commandOf(e.text)
    const command = ran === null ? null : await describeCommand($, ran.command)

    contribute(e.text, {
      // Written in the decision model's language for this question (Chinese with Jev); the other questions keep ctx.ask's.
      ...turnStartEffortPart({ ...ctx.ask, language: ctx.config.turnStartLanguage }),
      ...(command === null ? {} : { state: { command } }),
      settle: async (outcome) => {
        const io: ReportIo = {
          board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
          decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
          debug: (line) => $.ui.log(line, { to: 'debug' }),
          now: () => $.clock.now(),
          toast: (text) => $.ui.toast(text),
        }
        // About the main agent of the turn this message starts, or of the one running when it was typed into it.
        const about = { feature: report ? 'main-effort (agent report)' : 'main-effort', agent: 'main', forTurn: e.turnId === undefined ? ('next' as const) : ('current' as const), subject: quoteStart(e.text) }
        if (!outcome.ok) {
          await reportDecision(io, { ...about, routed: false, failure: { backend: ctx.backend.name, ...outcome.failure } })
          await wait(null)
          return
        }
        const reading = readEffort(outcome.answers[LEVEL])
        if (reading === null) {
          await reportDecision(io, { ...about, routed: false, failure: { backend: ctx.backend.name, kind: 'parse', detail: 'no effort answer' } })
          await wait(null)
          return
        }
        // pickEffort's rules with their working: the board shows the steps, never recomputes them (#23).
        const { effort, steps } = traceEffort(reading, ctx.config.thetaMax)
        await reportDecision(io, {
          ...about,
          routed: true,
          outcome: `effort ${effort}`,
          reason: describeReading(reading, effort, ctx.config.thetaMax),
          probs: Object.fromEntries(EFFORTS.map((level, i) => [level, reading.probabilities[i] ?? 0])) as Record<Effort, number>,
          ...(reading.confidence === null ? {} : { conf: reading.confidence }),
          trace: steps,
        })
        await wait(effort)
        const running = e.turnId
        if (running !== undefined) {
          const ref = { ...TURNS, id: turnKey(running, undefined) }
          const turn: Cell<TurnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
          await update(turn, (record) => revise(record, effort))
        }
      },
    })

    const result = await next(e)
    // Refused beneath: no turn will take this decision.
    const withdrawn = added as PendingDecision | null
    if (result.drop !== undefined && withdrawn !== null) {
      await update(pending, (list) => (list ?? []).filter((entry) => !(entry.text === withdrawn.text && entry.at === withdrawn.at)))
    }
    return result
  })
}

/** Why a level was picked: every level's probability, `max` held back below thetaMax when it was the most likely, and the backend's confidence. */
function describeReading(reading: EffortReading, picked: Effort, thetaMax: number): string {
  const p = reading.probabilities
  const max = p[EFFORTS.length - 1] ?? 0
  const held = picked !== 'max' && p.every((other) => other <= max)
  return readingText(reading, held ? `max is below thetaMax ${thetaMax.toFixed(2)}` : undefined)
}
