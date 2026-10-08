// The real flow over an eval v2 conversation (#45): what the mod would hold, message by message, had it lived the
// conversation with a given decision model and state budget. At each of the person's messages, in order, the mod's
// request for it (`askedRequest`: the effort question and the three-way question beside it, the problem summary and the
// count it holds then, the strong hint once the count reaches `unresolvedMaxAfter`); the three-way answer read as the
// mod reads it (`readUnresolved`, `judgeUnresolved` at the mod's two bars, `UNRESOLVED_THRESHOLDS`) moves the count:
// one more marks the summary's last try unresolved (`markLast`), a clear takes the summary with it (core/unresolved.ts).
// After each turn but the last, the cheap model continues the summary from the mod's own prompt (`summaryPrompt` over
// the person's words, the reply and its tools, secrets masked and long text cut; `readSummary` reads the reply within
// 500 tokens); a reply that is no summary leaves it as it was. The writes are done before the next message, as they
// are when the person takes longer to answer than the cheap model.
//
// eval/eval-v2-flow.ts runs it against Jev or Perplexity and `claude -p --model haiku`, one file per backend and budget
// (FlowFile); the eval-v2 suite's flow variants carry what that file says the last message's request carried, and
// eval/eval-v2-thresholds.ts scans the bars over the probabilities it keeps.
//
// Pure: no Node API.

import { toolSummary } from '../../hooks/decision/context.ts'
import { LEVEL, readEffort, type Language } from '../../hooks/decision/effort.ts'
import { markLast, readSummary, summaryPrompt, type Summary } from '../../hooks/decision/summary.ts'
import { answersFor } from '../../hooks/decision/system-one.ts'
import { countAfter, givesHint, judgeUnresolved, readUnresolved, UNRESOLVED, UNRESOLVED_THRESHOLDS, type UnresolvedChange, type UnresolvedOption, type UnresolvedThresholds } from '../../hooks/decision/unresolved.ts'
import type { Part, V2Record } from './eval-v2.ts'
import { fingerprint } from './long-conversation.ts'
import type { Complete } from './long-summaries.ts'
import type { Ask, Settings } from './suite.ts'
import { askedRequest } from './unresolved.ts'

/** One message of the person's in the flow: what its request carried, what the answer said, what it did to the count. */
export type FlowMessage = {
  /** The message's id in the conversation (`p1`, `d2`, `m3`, `f1` …) and its index in `turns`. */
  msg: string
  at: number
  part: Part
  /** The count the request carried (the count before this message). */
  before: number
  /** The request carried the strong hint (the count had reached `unresolvedMaxAfter`). */
  hint?: true
  /** The effort question's probabilities, lowest level first (rounded to three places). */
  p?: number[]
  /** The three-way question's probabilities, normalized as the mod reads them (rounded to three places). */
  triage?: Record<UnresolvedOption, number>
  /** What the answer did to the count at the run's bars; `keep` when there was no answer to read. */
  change: UnresolvedChange
  after: number
  /** Why the request gave no answer to read (an error the mod would also have met: it keeps the count). */
  failure?: string
  /** The summary of the turn this message started was not written (the cheap model never answered with one): it stayed as it was. */
  write?: 'failed'
}

/** One item's flow: the messages done so far, what the next one's request carries, and, once the last is done, what the last one's request carried. */
export type FlowItem = {
  /** The fingerprint of the conversation it was run over (`fingerprint` of the turns): a flow of another conversation is refused. */
  conversation: string
  messages: FlowMessage[]
  /** What the request of the next message carries: the count and the summary after the messages done. */
  carry: { count: number; summary: Summary | null }
  /** What the request of the last message (the one the item asks about) carried; there once it is done. */
  final?: { count: number; summary: Summary | null; hint: boolean }
}

/**
 * What eval/eval-v2-flow.ts writes for one backend and state budget (`eval/results/eval-v2-flow/<backend>-<tokens>.json`):
 * how it was run, and each item's flow.
 */
export type FlowFile = {
  suite: 'eval-v2-flow'
  about: string
  /** The decision model asked, the model it named, and the models that answered. */
  backend: { name: string; model: string; answeredBy: string[] }
  /** The language of the questions, the state's budget and message limit, the bars, the count the hint starts at. */
  settings: { language: Language; stateTokens: number; stateMessages: number; thresholds: UnresolvedThresholds; maxAfter: number }
  /** The cheap model: the name asked for, what it said it is, the models `claude -p` reported, how it was called, how many prompts, how many never got a summary, how many came from the cache. */
  summarizer: { model: string; says: string | null; answeredBy: string[]; how: string; asked: number; failed: number; cached: number }
  /** The dataset it ran over (eval-v2.jsonl's sha256, as generated.json records it). */
  dataset: { sha256: string; items: number }
  items: Record<string, FlowItem>
  /** Each run that wrote to it: when, how many items it finished, the requests it sent and the input tokens the backend counted. */
  runs?: { date: string; items: number; requests: number; inputTokens: number }[]
}

/** The fingerprint of a record's conversation (every turn, as eval-v2.jsonl holds it). */
export function conversationPrint(record: V2Record): string {
  return fingerprint(record.turns)
}

/** The failures after which the flow of an item stops (to go on later from where it stopped): asking again may answer, or nothing will until someone acts. */
const STOPS = ['busy', 'network', 'timeout', 'config', 'quota']

export type FlowOptions = {
  /** Sends a request to the backend under evaluation (retrying as the runner does). */
  ask: Ask
  /** The cheap model's reply to a summary prompt, or null when it gave none. */
  complete: Complete
  settings: Settings
  /** The language the questions are asked in (the mod's `turnStartLanguage`: Chinese for Jev). */
  language: Language
  /** The bars a three-way answer moves the count at (the mod's by default). */
  thresholds?: UnresolvedThresholds
  /** How many times a turn's summary is asked for when the reply is no summary (the mod asks once; a `claude -p` call also fails for reasons of its own). */
  tries?: number
  /** Hears of each message done, with the item as it stands (to save progress). */
  onMessage?: (item: FlowItem) => void | Promise<void>
}

const round = (p: number) => Math.round(p * 1000) / 1000

/**
 * The flow of one item, from the start or from where `from` stopped. `stopped` says why it stopped before the last message
 * (a request that failed in a way the eval should not record as an answer: the backend busy or unreachable, the key
 * refused, the quota spent); the item holds what was done.
 */
export async function flowItem(record: V2Record, options: FlowOptions, from?: FlowItem): Promise<{ item: FlowItem; stopped: string | null }> {
  const conversation = conversationPrint(record)
  if (from !== undefined && from.conversation !== conversation) throw new Error(`${record.id}: the flow so far was run over another conversation`)
  const item: FlowItem = from === undefined ? { conversation, messages: [], carry: { count: 0, summary: null } } : (JSON.parse(JSON.stringify(from)) as FlowItem)
  const thresholds = options.thresholds ?? UNRESOLVED_THRESHOLDS
  const maxAfter = options.settings.unresolved.maxAfter
  const people = record.turns.flatMap((turn, at) => (turn.role === 'user' ? [at] : []))
  const lastAt = record.turns.length - 1
  for (const at of people.slice(item.messages.length)) {
    const turn = record.turns[at] as V2Record['turns'][number]
    let { count, summary } = item.carry
    const hint = givesHint(count, maxAfter)
    const asked = {
      message: turn.text,
      recent_context: record.turns.slice(0, at).map((before) => ({ role: before.role, text: before.text, ...(before.tools === undefined ? {} : { tools: before.tools }) })),
      ...(turn.command === undefined ? {} : { command: turn.command }),
    }
    const sent = askedRequest(asked, { ask: { language: options.language, primitive: 'score' }, wide: true }, options.settings, summary, { count, maxAfter })
    const { asked: answer } = await options.ask(sent.request)
    if (!answer.ok && STOPS.includes(answer.failure.kind)) return { item, stopped: `${turn.msg ?? at}: ${answer.failure.kind}: ${answer.failure.detail}` }
    // HTTP 402 (TypeSafe: "no available API credits") is a spent account, not an answer: stop the run as for a spent quota.
    if (!answer.ok && answer.failure.status === 402) return { item, stopped: `${turn.msg ?? at}: quota: ${answer.failure.detail}` }
    const message: FlowMessage = { msg: turn.msg ?? String(at), at, part: turn.part, before: count, ...(hint ? { hint: true as const } : {}), change: 'keep', after: count }
    if (!answer.ok) message.failure = `${answer.failure.kind}: ${answer.failure.detail}`
    else {
      const answers = answersFor(sent.part, answer.answers)
      const effort = readEffort(answers[LEVEL])
      if (effort !== null) message.p = effort.probabilities.map(round)
      const reading = readUnresolved(answers[UNRESOLVED])
      if (reading === null) message.failure = 'parse: no triage answer'
      else {
        message.triage = { still_unresolved: round(reading.probabilities.still_unresolved), resolved: round(reading.probabilities.resolved), new_or_unrelated: round(reading.probabilities.new_or_unrelated) }
        message.change = judgeUnresolved(reading, thresholds).change
      }
    }
    // The mod's own moves (core/unresolved.ts): one more marks the last try, a clear takes the summary.
    if (message.change === 'add' && summary !== null) summary = markLast(summary)
    if (message.change === 'reset') summary = null
    count = countAfter(count, message.change)
    message.after = count
    if (at === lastAt) {
      item.final = { count: item.carry.count, summary: item.carry.summary, hint }
    } else {
      const reply = record.turns[at + 1]
      if (reply !== undefined && reply.role === 'assistant') {
        const prompt = summaryPrompt({ previous: summary, person: turn.text, reply: reply.text, tools: toolSummary((reply.tools ?? []).map((tool) => ({ tool }))) })
        let next: Summary | null = null
        for (let tries = 0; tries < (options.tries ?? 1) && next === null; tries++) {
          const text = await options.complete(prompt)
          next = text === null ? null : readSummary(text)
        }
        if (next === null) message.write = 'failed'
        else summary = next
      }
    }
    item.messages.push(message)
    item.carry = { count, summary }
    await options.onMessage?.(item)
  }
  return { item, stopped: null }
}
