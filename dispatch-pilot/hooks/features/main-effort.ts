// Feature: the main agent's effort, decided each time the person sends a
// message. It adds the effort question to the message's ballot (the core
// sends it); the answer becomes the effort of the turn the message starts,
// on every step of that turn (the core's turn.step writer).
//
// A message typed while a turn runs (`e.turnId`) is delivered into that turn
// at its next step (a `queued_command` attachment; measured on 2.1.289), so
// its decision takes the running turn from then on. It also waits as pending,
// in case the turn ends first and the message starts a turn of its own.

import type { On } from 'claude-code'
import { EFFORTS, LEVEL, pickEffort, readEffort, turnStartEffortPart, type Effort, type EffortReading } from '../decision/effort.ts'
import { quoteStart } from '../decision/redact.ts'
import { contribute } from '../core/ballot.ts'
import { recordDecision } from '../core/decisions.ts'
import { addPending, revise, turnKey, update, type Cell, type PendingDecision, type TurnRecord } from '../core/plans.ts'
import { isPersonsMessage } from '../core/prompts.ts'
import type { Ctx } from '../core/setup.ts'
import { failureText, setStatus } from '../core/status.ts'
import { defineSwitch, isOn } from '../core/switches.ts'

const PENDING = { plugin: 'dispatch-pilot', key: 'pending' } as const
const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

export function registerMainEffort(on: On, ctx: Ctx): void {
  defineSwitch({ name: 'main-effort', info: "decides the main agent's effort when you send a message", segments: ['decision'] })

  on('prompt.submit', { text: /(?:)/ }, async ($, e, next) => {
    if (!isPersonsMessage(e) || !isOn('main-effort')) return next(e)
    const pending: Cell<PendingDecision[]> = { get: () => $.state.get(PENDING), set: (value, options) => $.state.set(PENDING, value, options) }
    let added: PendingDecision | null = null

    /** The message waits for its turn, decided or not: the turn it starts is the person's own (mid-turn re-decisions are for such turns). */
    const wait = async (effort: Effort | null) => {
      const entry: PendingDecision = { text: e.text, effort, at: await $.clock.now() }
      await update(pending, (list) => addPending(list ?? [], entry))
      added = entry
    }

    contribute(e.text, {
      ...turnStartEffortPart(ctx.ask),
      settle: async (outcome) => {
        const show = (line: string | undefined) => $.ui.status(line)
        if (!outcome.ok) {
          setStatus('decision', failureText(ctx.backend.name, outcome.failure), show)
          await wait(null)
          return
        }
        const reading = readEffort(outcome.answers[LEVEL])
        if (reading === null) {
          setStatus('decision', failureText(ctx.backend.name, { kind: 'parse', detail: 'no effort answer' }), show)
          await wait(null)
          return
        }
        setStatus('decision', null, show)
        const effort = pickEffort(reading, ctx.config.thetaMax)
        await recordDecision(
          { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
          (line) => $.ui.log(line, { to: 'debug' }),
          { feature: 'main-effort', outcome: `effort ${effort}`, about: quoteStart(e.text), reason: describeReading(reading, effort, ctx.config.thetaMax) },
        )
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
  const levels = EFFORTS.map((level, i) => `${level} ${(p[i] ?? 0).toFixed(2)}`).join(', ')
  const max = p[EFFORTS.length - 1] ?? 0
  const held = picked !== 'max' && p.every((other) => other <= max) ? `; max is below thetaMax ${thetaMax.toFixed(2)}` : ''
  return `p ${levels}${held}; confidence ${reading.confidence === null ? 'n/a' : reading.confidence.toFixed(2)}`
}
