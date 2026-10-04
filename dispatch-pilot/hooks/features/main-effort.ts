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
import { EFFORTS, LEVEL, pickEffort, readEffort, turnStartEffortPart, type EffortReading } from '../decision/effort.ts'
import { redactSecrets } from '../decision/redact.ts'
import { contribute } from '../core/ballot.ts'
import { addPending, revise, turnKey, update, type Cell, type PendingDecision, type TurnRecord } from '../core/plans.ts'
import { isPersonsMessage } from '../core/prompts.ts'
import type { Ctx } from '../core/setup.ts'
import { failureText, setStatus } from '../core/status.ts'

const PENDING = { plugin: 'dispatch-pilot', key: 'pending' } as const
const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const

export function registerMainEffort(on: On, ctx: Ctx): void {
  on('prompt.submit', { text: /(?:)/ }, async ($, e, next) => {
    if (!isPersonsMessage(e)) return next(e)
    const pending: Cell<PendingDecision[]> = { get: () => $.state.get(PENDING), set: (value, options) => $.state.set(PENDING, value, options) }
    let added: PendingDecision | null = null

    contribute(e.text, {
      ...turnStartEffortPart(ctx.ask),
      settle: async (outcome) => {
        const show = (line: string | undefined) => $.ui.status(line)
        if (!outcome.ok) {
          setStatus('decision', failureText(ctx.backend.name, outcome.failure), show)
          return
        }
        const reading = readEffort(outcome.answers[LEVEL])
        if (reading === null) {
          setStatus('decision', failureText(ctx.backend.name, { kind: 'parse', detail: 'no effort answer' }), show)
          return
        }
        setStatus('decision', null, show)
        const effort = pickEffort(reading, ctx.config.thetaMax)
        $.ui.log(`effort ${effort} for ${quote(e.text)}: ${describeReading(reading)}`, { to: 'debug' })
        const entry: PendingDecision = { text: e.text, effort, at: await $.clock.now() }
        await update(pending, (list) => addPending(list ?? [], entry))
        added = entry
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

/** The start of a message for the debug log, secrets masked. */
function quote(text: string): string {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim()
  return JSON.stringify(flat.length > 40 ? `${flat.slice(0, 40)}...` : flat)
}

/** Why a level was picked: every level's probability, and the backend's confidence. */
function describeReading(reading: EffortReading): string {
  const levels = EFFORTS.map((level, i) => `${level} ${(reading.probabilities[i] ?? 0).toFixed(2)}`).join(', ')
  return `p ${levels}; confidence ${reading.confidence === null ? 'n/a' : reading.confidence.toFixed(2)}`
}
