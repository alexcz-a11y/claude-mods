// Feature: the unresolved count and the problem summary (#39, #40; GLOSSARY 未解决次数,
// 问题摘要). Each of the person's messages is asked, in the effort request, whether it
// says the problem they and the main agent are on is still not solved, is solved, or is
// another one; the answer moves the count (core/unresolved.ts). The question and the
// reading of its answer are in features/main-effort.ts, which owns the effort part of
// the ballot they travel in (one contribution per part); this file owns the switch,
// the count's start-over and the summary.
//
// The summary is a record of the problem for the decision model to read beside the
// conversation. When a turn that the person's own message started ends, a cheap model
// continues it, in the background: the hook does not wait, and a message that comes
// before it is written is decided with the summary as it was (main-effort.ts reads it).
// Writes go one after the other, each continuing what the one before wrote. A write
// that fails (the model errs, times out, answers something that is no summary) or that
// a reload of the mod lost leaves the summary as it was and is told to the decision
// report; one the count's start-over overtook is dropped when it lands.
//
// The count is per session: `/clear` and a new session start it over (`session.end`
// fires for both; `session.start` also fires on a hot reload, which must keep it),
// a compaction keeps it. Switched off, the question is not asked, the count stays as it
// is and no summary is written.

import type { EngineInterface, ModelCompleteResult, On } from 'claude-code'
import { errorText } from '../decision/backend.ts'
import { clipToTokens } from '../decision/context.ts'
import { quoteStart, redactSecrets } from '../decision/redact.ts'
import { readSummary, SUMMARY_MAX_REPLY, SUMMARY_SYSTEM, SUMMARY_TIMEOUT_MS, summaryPrompt, turnTools, type TurnInput } from '../decision/summary.ts'
import { turnKey } from '../core/plans.ts'
import { report, type ReportIo } from '../core/report.ts'
import type { Ctx } from '../core/setup.ts'
import { defineSwitch, isOn } from '../core/switches.ts'
import { clearCount, dropSummary, landSummary, lostSummaries, queueSummary, summaryFailure, summaryFor, type CountCell, type SummaryFailure } from '../core/unresolved.ts'

const COUNT = { plugin: 'dispatch-pilot', key: 'unresolved' } as const
const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

/** The switch's name: `/dp unresolved on|off`. */
export const UNRESOLVED_SWITCH = 'unresolved'

/** The writes of this load of the mod: after the one before it (they are chained), and the turns they are for. A hot reload empties both. */
let chain: Promise<void> = Promise.resolve()
const running = new Set<string>()
/** The engine refused the summary's model: no more is asked of it until the conversation ends (a reload asks again). */
let refused = false

/** What a write is given when the turn ends: the turn, and what the cheap model is shown of it. */
type Write = { turn: string; subject: string; shown: Omit<TurnInput, 'previous'> }

export function registerUnresolved(on: On, ctx: Ctx): void {
  // Off until the person turns it on (#48, ADR 0006); what they set by hand is in $.store and wins.
  defineSwitch({ name: UNRESOLVED_SWITCH, info: '每条消息判断同一个问题是否仍未解决，数未解决的次数；每轮结束后在后台写问题摘要（默认关）', default: false })

  on('session.end', { reason: /(?:)/ }, async ($, e, next) => {
    refused = false
    try {
      await clearCount(countCell($))
    } catch (error) {
      $.ui.log(`unresolved count not cleared: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  // A reload of the mod loses the writes in flight (the engine drops their calls with the old module): the state still lists them.
  on('session.start', { cwd: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    try {
      for (const turn of await lostSummaries(countCell($), running)) await tell($, turn, 'lost', ctx.config.unresolved.summaryModel)
    } catch (error) {
      $.ui.log(`summaries lost to a reload not told: ${errorText(error)}`, { to: 'debug' })
    }
    return result
  })

  // A turn the person's own message started ends: its summary is written, in the background.
  on('turn.complete', { turnId: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    // The summary is a paraphrase of the conversation: none is written when the person sends the decision model none (`contextMessages` 0).
    if (e.agentId !== undefined || refused || !isOn(UNRESOLVED_SWITCH) || ctx.backend.configured === false || ctx.config.context.messages <= 0) return result
    try {
      const { value: turn } = await $.state.get({ ...TURNS, id: turnKey(e.turnId, undefined) })
      // Only the person's own message: a hand-back or a task notice that started the turn is no word of theirs.
      if (turn === undefined || !turn.person) return result
      const messages = await $.session.messages().catch(() => [])
      const write: Write = { turn: e.turnId, subject: quoteStart(turn.prompt), shown: { person: turn.prompt, reply: e.answer, tools: turnTools(messages) } }
      await queueSummary(countCell($), e.turnId)
      running.add(e.turnId)
      chain = chain.then(() => writeSummary($, ctx, write)).catch(() => undefined)
    } catch (error) {
      $.ui.log(`summary not queued: ${errorText(error)}`, { to: 'debug' })
    }
    return result
  })
}

function countCell($: EngineInterface): CountCell {
  return { get: () => $.state.get(COUNT), set: (value, options) => $.state.set(COUNT, value, options) }
}

/** The decision report's closures over this hook's `$`. */
function reportIo($: EngineInterface): ReportIo {
  return {
    board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
    decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
    debug: (line) => $.ui.log(line, { to: 'debug' }),
    now: () => $.clock.now(),
    toast: (text) => $.ui.toast(text),
  }
}

/** A write that did not make a summary, told to the decision report (the one that was there stays). `turn` only names the write in the debug log. */
async function tell($: EngineInterface, turn: string, failure: SummaryFailure, model: string, subject = ''): Promise<void> {
  $.ui.log(`summary for turn ${turn}: ${failure === 'lost' ? 'lost to a reload' : failure}`, { to: 'debug' })
  await report(reportIo($), { decision: { feature: UNRESOLVED_SWITCH, agent: 'main', aside: true, subject, ...summaryFailure(failure, model) } })
}

/**
 * Continues the summary with one turn, with the cheap model, once the writes before it are done. The summary it
 * continues is read when it starts, so it holds what those wrote. Never throws.
 */
async function writeSummary($: EngineInterface, ctx: Ctx, write: Write): Promise<void> {
  const cell = countCell($)
  const model = ctx.config.unresolved.summaryModel
  try {
    const { wanted, previous } = await summaryFor(cell, write.turn)
    // Cleared since the turn ended (solved, another problem, /clear), or switched off meanwhile: nothing to write.
    if (!wanted || !isOn(UNRESOLVED_SWITCH) || refused) {
      await dropSummary(cell, write.turn)
      return
    }
    let reply: ModelCompleteResult
    try {
      reply = await $.model.complete({ model, system: SUMMARY_SYSTEM, prompt: summaryPrompt({ ...write.shown, previous }), maxTokens: SUMMARY_MAX_REPLY, timeoutMs: SUMMARY_TIMEOUT_MS })
    } catch (error) {
      refused = true
      await dropSummary(cell, write.turn)
      await tell($, write.turn, { reason: 'refused', detail: errorText(error) }, model, write.subject)
      return
    }
    if (!reply.isAnswered) {
      await dropSummary(cell, write.turn)
      await tell($, write.turn, reply.reason === 'api-error' ? { reason: 'api-error', status: reply.status, error: reply.error } : { reason: reply.reason }, model, write.subject)
      return
    }
    const summary = readSummary(reply.text)
    if (summary === null) {
      await dropSummary(cell, write.turn)
      await tell($, write.turn, { reason: 'unfit', text: clipToTokens(redactSecrets(reply.text).replace(/\s+/g, ' ').trim(), 60) }, model, write.subject)
      return
    }
    const kept = await landSummary(cell, write.turn, summary)
    $.ui.log(`summary for turn ${write.turn}: ${kept ? 'written' : 'dropped, it was cleared meanwhile'} (${reply.usage.output_tokens} tokens from ${model})`, { to: 'debug' })
  } catch (error) {
    // The session went away under it, or a bug: either way the session is not held up.
    $.ui.log(`summary for turn ${write.turn} not written: ${errorText(error)}`, { to: 'debug' })
  } finally {
    running.delete(write.turn)
  }
}
