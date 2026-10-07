// The problem summary a real flow would hold at the end of an item's deep conversation (#44): what the mod keeps in `$.state`
// after living the conversation. After each of the person's turns the mod asks a cheap model to continue the record
// (`summaryPrompt`, read with `readSummary`); a message that says the problem is still unresolved marks the record's last try
// (`markLast`), and one that says it is resolved, or that starts another problem, clears the record (`core/unresolved.ts`
// `moveCount`). Here the same, turn by turn over the conversation, with the cheap model's completion handed in: the answers of the
// three-way question are the dataset's own (`says` of the decisive rounds; the filler's messages say nothing, so the record goes on).
//
// Pure: no Node API. eval/long-context-summaries.ts runs it with `claude -p --model haiku`.

import { toolSummary } from '../../hooks/decision/context.ts'
import { markLast, readSummary, summaryPrompt, type Summary } from '../../hooks/decision/summary.ts'
import type { LongContextItem } from './datasets.ts'
import { conversationOf } from './long-conversation.ts'

/** The cheap model's reply to a prompt, or null when it gave none (an error, a timeout). */
export type Complete = (prompt: string) => Promise<string | null>

export type Written = {
  /** The record after the last turn; null when no reply ever was a record. */
  summary: Summary | null
  /** The turns of the deep conversation, each asked once (and again, up to `tries` times in all, when the reply was no record). */
  turns: number
  /** How many turns the model never answered with a record: the mod keeps the old record for those. */
  failed: number
}

/** The record by the end of the item's deep conversation, written turn by turn. */
export async function writeSummary(item: LongContextItem, complete: Complete, tries = 3): Promise<Written> {
  const entries = conversationOf(item, 'deep')
  let summary: Summary | null = null
  let turns = 0
  let failed = 0
  for (let at = 0; at + 1 < entries.length; at += 2) {
    const person = entries[at]
    const reply = entries[at + 1]
    if (person === undefined || reply === undefined) break
    turns++
    // What the person's message says of the problem moves the record before the turn is written about (the mod decides it when the message is sent).
    const says = item.zh.decisive[at]?.says
    if (says === 'unresolved' && summary !== null) summary = markLast(summary)
    else if (says === 'resolved' || says === 'new') summary = null
    const prompt = summaryPrompt({ previous: summary, person: person.text, reply: reply.text, tools: toolSummary((reply.tools ?? []).map((tool) => ({ tool }))) })
    let next: Summary | null = null
    for (let attempt = 1; attempt <= tries && next === null; attempt++) {
      const text = await complete(prompt)
      next = text === null ? null : readSummary(text)
    }
    if (next === null) failed++
    else summary = next
  }
  return { summary, turns, failed }
}
