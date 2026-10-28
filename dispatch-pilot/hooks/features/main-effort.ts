// Feature: the main agent's effort, decided each time the person sends a message, and when a report starts a turn of its own:
// a dispatched agent's hand-back or a background task's notice reaching the idle session (those turns are usually a look at a
// result and the next dispatch; the session's own effort would be a waste). It adds the effort part to the message's ballot
// (the core sends it); the code turns the answers into the effort of the turn the message starts (decision/message-effort.ts,
// ADR 0014), on every step of that turn (the core's turn.step writer). The effort is decided here only: a level changed in the
// middle of a turn does not go out (ADR 0013).
//
// What the part asks and reads (decision/turn-start.ts): the effort question, the stakes and the unknown cause; for the
// person's own words also whether the earlier attempt failed, the problem is solved, another task begins, whether they
// set a lasting rule, and whether they only go on with what was offered or ask for more thought (ADR 0016). The answers are
// read as the decision model's guide says (decision/guides.ts: TypeSafe's for Jev and pplx, Liquid's for d1-ultra). Beside
// the conversation the state carries what the session kept: the problem summary (its switch on), the unresolved count, the
// person's lasting rules, and the failures of their previous turn. A report's turn asks only what is not about the person's
// words.
//
// A command turn (#19: `/implement #19`, a skill or markdown command the person typed) is decided like their message: the
// decision model reads the command as typed and what the command is for (core/commands.ts), never the prompt it expands to.
//
// A message typed while a turn runs (`e.turnId`) is delivered into that turn at its next step (a `queued_command` attachment;
// measured on 2.1.289), and the hook decides it before that: its decision takes the running turn from then on, that step
// carrying input (a model keeps its level from one message with input to the next). It also waits as pending, in case the
// turn ends first and the message starts a turn of its own. It is decided once, on its words: images it came with are not
// read for it, since a second decision made once they are read could land on a step of tool results, where it would not go
// out (ADR 0013).

import type { EngineInterface, On } from 'claude-code'
import { errorText } from '../decision/backend.ts'
import { CONSTRAINT, constraintOf, withConstraint, type StandingConstraint } from '../decision/constraints.ts'
import { LEVEL, probsOf, readEffort, readingText, type Effort } from '../decision/effort.ts'
import type { TurnFacts } from '../decision/escalation.ts'
import { decideMessage, messageSignals, type MessageDecision } from '../decision/message-effort.ts'
import { yesBar } from '../decision/guides.ts'
import { readNoul, verdictOf } from '../decision/nouls.ts'
import { quoteStart } from '../decision/redact.ts'
import { turnStartPart } from '../decision/turn-start.ts'
import { judgeUnresolved, readUnresolved } from '../decision/unresolved.ts'
import type { Answer } from '../decision/system-one.ts'
import { contribute, type Contribution, type PartOutcome } from '../core/ballot.ts'
import { commandOf, commandState } from '../core/commands.ts'
import { keptCount, keptSummary, moveCount, unresolvedDecision, type CountCell } from '../core/unresolved.ts'
import { defer, withdraw } from '../core/deferred.ts'
import { addPending, revise, turnKey, update, type Cell, type PendingDecision, type TurnRecord } from '../core/plans.ts'
import { isPersonsMessage, startsReportTurn } from '../core/prompts.ts'
import { report, type ReferenceRecord, type ReportIo, type UnresolvedRecord } from '../core/report.ts'
import type { Ctx } from '../core/setup.ts'
import { defineSwitch, isOn } from '../core/switches.ts'
import type { ReferenceReading } from '../decision/complexity.ts'
import { hasImage, IMAGE_ROUTING_SWITCH } from './image-routing.ts'
import { SUMMARY_SWITCH, UNRESOLVED_FEATURE } from './unresolved.ts'

const PENDING = { plugin: 'dispatch-pilot', key: 'pending' } as const
const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
const CATALOG = { plugin: 'dispatch-pilot', key: 'skillCatalog' } as const
const COUNT = { plugin: 'dispatch-pilot', key: 'unresolved' } as const
const CONSTRAINTS = { plugin: 'dispatch-pilot', key: 'constraints' } as const
const LAST_TURN = { plugin: 'dispatch-pilot', key: 'lastTurn' } as const
const LOCK = { plugin: 'dispatch-pilot', key: 'lock' } as const

/**
 * What a command turn's command is for: its skill in the session's catalog as
 * the skills feature read it, else the command as `$.command.list()`
 * describes it.
 */
async function describeCommand($: EngineInterface, name: string): Promise<Readonly<Record<string, string>> | null> {
  const { value: catalog } = await $.state.get(CATALOG)
  const skill = catalog?.skills.find((one) => one.name === name)
  const listed = skill?.description ? undefined : (await $.command.list().catch(() => [])).find((command) => command.name === name)?.description
  return commandState(name, skill, listed)
}

/** The unresolved count and summary in `$.state`, as a cell. */
function countCell($: EngineInterface): CountCell {
  return { get: () => $.state.get(COUNT), set: (value, options) => $.state.set(COUNT, value, options) }
}

/** The text of the latest assistant message of the conversation (what the person's message answers): '' when there is none. */
async function lastAssistantText($: EngineInterface): Promise<string> {
  const messages = await $.session.messages().catch(() => [])
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i] as { role?: string; text?: string }
    if (row.role === 'assistant' && typeof row.text === 'string' && row.text.trim() !== '') return row.text
  }
  return ''
}

/** Why the level is what it is, beside the levels' probabilities: the floor that lifted it last, else nothing. */
function liftNote(decision: MessageDecision): string | undefined {
  const words: Record<string, string> = { ultrathink: 'ultrathink', escalate: '要求多想', confirm: '确认，沿用上一轮', stakes: '出错代价', 'cause-unknown': '原因未知', 'stuck-again': '上一轮卡住', 'unresolved-count': '未解决次数' }
  return decision.lifted === null ? undefined : `${words[decision.lifted] ?? decision.lifted} 定下限，抬到 ${decision.effort}`
}

export function registerMainEffort(on: On, ctx: Ctx): void {
  defineSwitch({ name: 'main-effort', info: '发消息时决定主 agent 的 effort' })

  on('prompt.submit', { text: /(?:)/ }, async ($, e, next) => {
    // The person's own message, or a report that starts a turn of its own (a dispatched agent's hand-back, a task notice).
    const handBack = !isPersonsMessage(e) && startsReportTurn(e)
    if ((!isPersonsMessage(e) && !handBack) || !isOn('main-effort')) return next(e)
    const pending: Cell<PendingDecision[]> = { get: () => $.state.get(PENDING), set: (value, options) => $.state.set(PENDING, value, options) }
    let added: PendingDecision | null = null

    /** The message waits for its turn, decided or not: the turn it starts is the person's own (such a turn keeps its facts as it ends). */
    const wait = async (effort: Effort | null) => {
      const entry: PendingDecision = { text: e.text, effort, at: await $.clock.now(), ...(handBack ? { report: true as const } : {}) }
      await update(pending, (list) => addPending(list ?? [], entry))
      added = entry
    }

    const ran = handBack ? null : commandOf(e.text)
    const command = ran === null ? null : await describeCommand($, ran.command)
    const own = !handBack
    // What the session kept: the count (always), the summary (its switch on), the person's rules, their previous turn's facts.
    // A write that is not done yet is no reason to wait: the decision uses what is there.
    const count = own ? await keptCount(countCell($)).catch(() => 0) : 0
    const summary = own && isOn(SUMMARY_SWITCH) ? await keptSummary(countCell($)).catch(() => null) : null
    const constraints: StandingConstraint[] = own ? ((await $.state.get(CONSTRAINTS).catch(() => ({ value: undefined }))).value ?? []) : []
    const lastTurn: TurnFacts | null = (await $.state.get(LAST_TURN).catch(() => ({ value: undefined }))).value?.facts ?? null
    const maxAfter = ctx.config.unresolved.maxAfter
    // A message with reference images (#63) that starts a turn is decided when its turn starts, once its images have been
    // read: its effort part does not go in the ballot, and the image-routing feature asks it at `turn.start`
    // (core/deferred.ts). One typed into a running turn is decided now, on its words alone (above).
    const imaged = own && ran === null && e.turnId === undefined && ctx.images !== null && isOn(IMAGE_ROUTING_SWITCH) && hasImage(e.attachments)
    // About the main agent of the turn this message starts, or of the one running when it was typed into it.
    const forTurn = e.turnId === undefined && !imaged ? ('next' as const) : ('current' as const)

    /** What the person's answers do to the count, which is moved here: the record the log and the card keep; null without answers (the count stays). */
    const countUnresolved = async (answers: Readonly<Record<string, Answer>>): Promise<(Awaited<ReturnType<typeof unresolvedDecision>> & { after: number }) | null> => {
      const reading = readUnresolved(answers)
      if (reading === null) {
        $.ui.log(`unresolved for ${quoteStart(e.text)}: no answer, the count stays`, { to: 'debug' })
        return null
      }
      const judged = judgeUnresolved(reading, ctx.config.guide.noul)
      try {
        const moved = await moveCount(countCell($), judged.change)
        return { ...unresolvedDecision(judged, moved), after: moved.count }
      } catch (error) {
        $.ui.log(`unresolved count not kept: ${errorText(error)}`, { to: 'debug' })
        return null
      }
    }

    /** The person's rule, kept when the constraint question said yes (verbatim, with the assistant's paragraph before it). */
    const keepConstraint = async (answers: Readonly<Record<string, Answer>>, io: ReportIo) => {
      const bars = ctx.config.guide.noul
      const p = readNoul(answers[CONSTRAINT])
      if (p === null || verdictOf(p, bars) !== 'yes') return
      try {
        const kept = constraintOf(e.text, await lastAssistantText($))
        const cell: Cell<StandingConstraint[]> = { get: () => $.state.get(CONSTRAINTS), set: (value, options) => $.state.set(CONSTRAINTS, value, options) }
        await update(cell, (list) => withConstraint(list ?? [], kept))
        await report(io, { decision: { feature: 'main-effort', agent: 'main', aside: true, forTurn, subject: quoteStart(e.text), outcome: '记下长期约束', reason: `constraint ${Math.round(p * 100)}% ${yesBar(bars, (x) => `${Math.round(x * 100)}%`)}：之后每次判断都带上这句原话（standing_constraints）`, tone: 'info' } })
      } catch (error) {
        $.ui.log(`lasting rule not kept: ${errorText(error)}`, { to: 'debug' })
      }
    }

    /** The effort of this message's turn from the part's answers, reported with its working; null when it could not be decided. */
    const decideEffort = async (outcome: PartOutcome, io: ReportIo, unresolved: UnresolvedRecord | undefined, countAfterThis: number, reference?: ReferenceRecord): Promise<Effort | null> => {
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
      const { value: lock = null } = await $.state.get(LOCK).catch(() => ({ value: null }))
      const signals = messageSignals(outcome.answers, { own, text: e.text, lastTurn: lastTurn === null ? null : { effort: lastTurn.effort, stuck: lastTurn.stuck }, count: countAfterThis, maxAfter, lock })
      const decision = decideMessage(reading, signals, ctx.config.guide)
      const effort = decision.effort
      await report(io, {
        decision: {
          ...about,
          routed: true,
          outcome: `effort ${effort}`,
          // The level as data: what reads the log (the band, the pane) never reads it out of the words.
          effort,
          reason: readingText(reading, liftNote(decision), ctx.config.guide.scoreUnsure.rule === 'low-confidence'),
          probs: probsOf(reading),
          ...(reading.confidence === null ? {} : { conf: reading.confidence }),
          // The rules' working: the board shows the steps, never recomputes them (ADR 0004).
          trace: decision.steps,
          ...(reference === undefined ? {} : { reference }),
          // What this message did to the unresolved count: the card draws it with the effort's.
          ...(unresolved === undefined ? {} : { unresolved }),
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

    /** The message's effort part; `reading`: what its reference images read as, when they have been (the state carries it, the decision reports it). */
    const effortPart = (reading: ReferenceReading | null): Contribution => ({
      ...turnStartPart({ ask: ctx.config.ask.turnStart, kind: own ? 'own' : 'report', command, summary, count, reference: reading, lastTurn, constraints }),
      settle: async (outcome) => {
        const io: ReportIo = {
          board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
          decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
          debug: (line) => $.ui.log(line, { to: 'debug' }),
          now: () => $.clock.now(),
          toast: (text) => $.ui.toast(text),
        }
        // The count first, so the effort's decision can read it (R5) and say what this message did to it.
        const counted = own && outcome.ok ? await countUnresolved(outcome.answers) : null
        const countAfterThis = counted?.after ?? count
        await decideEffort(outcome, io, counted?.unresolved, countAfterThis, reading ?? undefined)
        // A count that moved is a decision of its own in the log (one left as it was is on the effort's card only).
        if (counted?.unresolved !== undefined && counted.unresolved.before !== counted.unresolved.count) {
          await report(io, { decision: { feature: UNRESOLVED_FEATURE, agent: 'main', aside: true, forTurn, subject: quoteStart(e.text), outcome: counted.outcome, reason: counted.reason, tone: counted.tone, unresolved: counted.unresolved } })
        }
        if (own && outcome.ok) await keepConstraint(outcome.answers, io)
      },
    })
    if (imaged) defer(e.text, effortPart)
    else contribute(e.text, effortPart(null))

    const result = await next(e)
    // Refused beneath: no turn will take this decision.
    if (imaged && result.drop !== undefined) withdraw(e.text)
    const withdrawn = added as PendingDecision | null
    if (result.drop !== undefined && withdrawn !== null) {
      await update(pending, (list) => (list ?? []).filter((entry) => !(entry.text === withdrawn.text && entry.at === withdrawn.at)))
    }
    return result
  })
}
