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
import { EFFORTS, LEVEL, probsOf, readEffort, readingText, traceEffort, type Effort, type EffortReading } from '../decision/effort.ts'
import { quoteStart } from '../decision/redact.ts'
import { turnStartPart } from '../decision/turn-start.ts'
import { givesHint, judgeUnresolved, readUnresolved, UNRESOLVED } from '../decision/unresolved.ts'
import { contribute, type PartOutcome } from '../core/ballot.ts'
import { commandOf, commandState } from '../core/commands.ts'
import { hintDecision, keptCount, keptSummary, moveCount, unresolvedDecision, type CountCell } from '../core/unresolved.ts'
import { addPending, revise, turnKey, update, type Cell, type PendingDecision, type TurnRecord } from '../core/plans.ts'
import { isPersonsMessage, startsReportTurn } from '../core/prompts.ts'
import { report, type HintRecord, type ReportIo, type UnresolvedRecord } from '../core/report.ts'
import type { Ctx } from '../core/setup.ts'
import { defineSwitch, isOn } from '../core/switches.ts'
import { UNRESOLVED_SWITCH } from './unresolved.ts'

const PENDING = { plugin: 'dispatch-pilot', key: 'pending' } as const
const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
const CATALOG = { plugin: 'dispatch-pilot', key: 'skillCatalog' } as const
const COUNT = { plugin: 'dispatch-pilot', key: 'unresolved' } as const

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

/** The unresolved count and summary in `$.state`, as a cell. */
function countCell($: EngineInterface): CountCell {
  return { get: () => $.state.get(COUNT), set: (value, options) => $.state.set(COUNT, value, options) }
}

export function registerMainEffort(on: On, ctx: Ctx): void {
  defineSwitch({ name: 'main-effort', info: '发消息时决定主 agent 的 effort' })

  on('prompt.submit', { text: /(?:)/ }, async ($, e, next) => {
    // The person's own message, or a report that starts a turn of its own (a dispatched agent's hand-back, a task notice).
    const handBack = !isPersonsMessage(e) && startsReportTurn(e)
    if ((!isPersonsMessage(e) && !handBack) || !isOn('main-effort')) return next(e)
    const pending: Cell<PendingDecision[]> = { get: () => $.state.get(PENDING), set: (value, options) => $.state.set(PENDING, value, options) }
    let added: PendingDecision | null = null

    /** The message waits for its turn, decided or not: the turn it starts is the person's own (mid-turn re-decisions are for such turns). */
    const wait = async (effort: Effort | null) => {
      const entry: PendingDecision = { text: e.text, effort, at: await $.clock.now(), ...(handBack ? { report: true as const } : {}) }
      await update(pending, (list) => addPending(list ?? [], entry))
      added = entry
    }

    const ran = handBack ? null : commandOf(e.text)
    const command = ran === null ? null : await describeCommand($, ran.command)

    // The person's own message also asks whether it says the problem they are on is still not solved (the unresolved
    // count); a report that starts a turn is no word of theirs, and the switch can leave the question out. It travels
    // in this part, so it is in the effort request with the 24000-token state it reads (ADR 0005).
    const counting = !handBack && isOn(UNRESOLVED_SWITCH)
    // The summary there is: a write that is not done yet is no reason to wait, the decision uses the one before it.
    const summary = counting ? await keptSummary(countCell($)).catch(() => null) : null
    // The count before this message (its own answer comes in the same request), and with it the strong hint once it has
    // reached the setting: a sentence in the effort question about the kind of work, the level still the decision model's (ADR 0005).
    const count = counting ? await keptCount(countCell($)).catch(() => 0) : 0
    const maxAfter = ctx.config.unresolved.maxAfter
    const hint: HintRecord | undefined = givesHint(count, maxAfter) ? { count, maxAfter } : undefined
    // About the main agent of the turn this message starts, or of the one running when it was typed into it.
    const forTurn = e.turnId === undefined ? ('next' as const) : ('current' as const)

    /** The effort this message's turn goes out at, and the board's word for it. */
    const decideEffort = async (outcome: PartOutcome, io: ReportIo, unresolved?: UnresolvedRecord): Promise<Effort | null> => {
      const about = { feature: handBack ? 'main-effort (agent report)' : 'main-effort', agent: 'main', forTurn, subject: quoteStart(e.text) }
      if (!outcome.ok) {
        await report(io, { decision: { ...about, routed: false, failure: { backend: ctx.backend.name, ...outcome.failure } } })
        await wait(null)
        return null
      }
      const reading = readEffort(outcome.answers[LEVEL])
      if (reading === null) {
        await report(io, { decision: { ...about, routed: false, failure: { backend: ctx.backend.name, kind: 'parse', detail: 'no effort answer' } } })
        await wait(null)
        return null
      }
      // pickEffort's rules with their working: the board shows the steps, never recomputes them (#23).
      const { effort, steps } = traceEffort(reading, ctx.config.thetaMax)
      await report(io, {
        decision: {
          ...about,
          routed: true,
          outcome: `effort ${effort}`,
          // The level as data: what reads the log (the band, the pane) never reads it out of the words.
          effort,
          reason: describeReading(reading, effort, ctx.config.thetaMax),
          probs: probsOf(reading),
          ...(reading.confidence === null ? {} : { conf: reading.confidence }),
          trace: steps,
          // What this message did to the unresolved count: the card draws it with the effort's.
          ...(unresolved === undefined ? {} : { unresolved }),
          // The card says the hint was given.
          ...(hint === undefined ? {} : { hint }),
        },
      })
      await wait(effort)
      const running = e.turnId
      if (running !== undefined) {
        const ref = { ...TURNS, id: turnKey(running, undefined) }
        const turn: Cell<TurnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
        await update(turn, (record) => revise(record, effort))
      }
      return effort
    }

    /**
     * What the answer to the unresolved question does to the count, which is moved here: what the log and the card say
     * of it; null when there is no answer or the count cannot be kept (the debug log says so, the count stays).
     */
    const countUnresolved = async (answered: Extract<PartOutcome, { ok: true }>) => {
      const reading = readUnresolved(answered.answers[UNRESOLVED])
      if (reading === null) {
        $.ui.log(`unresolved for ${quoteStart(e.text)}: no answer, the count stays`, { to: 'debug' })
        return null
      }
      const judged = judgeUnresolved(reading)
      try {
        return unresolvedDecision(judged, await moveCount(countCell($), judged.change))
      } catch (error) {
        $.ui.log(`unresolved count not kept: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
        return null
      }
    }

    contribute(e.text, {
      // Written in the decision model's language for these questions (Chinese with Jev); the other questions keep ctx.ask's.
      ...turnStartPart({ ask: { ...ctx.ask, language: ctx.config.turnStartLanguage }, unresolved: counting, command, summary, count, maxAfter }),
      settle: async (outcome) => {
        const io: ReportIo = {
          board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
          decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
          debug: (line) => $.ui.log(line, { to: 'debug' }),
          now: () => $.clock.now(),
          toast: (text) => $.ui.toast(text),
        }
        // The count first, so the effort's decision can say what this message did to it; neither depends on the other
        // (either answer can be missing, and the effort is decided and kept whatever becomes of the count).
        const counted = counting && outcome.ok ? await countUnresolved(outcome) : null
        const effort = await decideEffort(outcome, io, counted?.unresolved)
        // A count that moved is a decision of its own in the log (an answer that left it as it was is on the effort's card only).
        if (counted?.unresolved !== undefined && counted.unresolved.before !== counted.unresolved.count) {
          await report(io, { decision: { feature: UNRESOLVED_SWITCH, agent: 'main', aside: true, forTurn, subject: quoteStart(e.text), ...counted } })
        }
        // Each hint given is a decision of its own in the log: the count, that it was given, the level that came of it.
        if (hint !== undefined) await report(io, { decision: { feature: UNRESOLVED_SWITCH, agent: 'main', aside: true, forTurn, subject: quoteStart(e.text), ...hintDecision(hint, effort) } })
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
  return readingText(reading, held ? `max 的概率没到 max 门槛 ${thetaMax.toFixed(2)}` : undefined)
}
