// What the decision model is shown of the conversation: the request's state.
//
// Only the text of messages and the names of the tools they called travel,
// never a tool's input or output (file contents, command output); secrets are
// masked before anything is cut. Sizes are in tokens, estimated, so Chinese
// and English are cut to the same scale (spec #11).
//
// Pure (see system-one.ts).

import { redactSecrets } from './redact.ts'
import type { State } from './system-one.ts'

/** A transcript row as `$.session.messages()` gives it (the part read here). */
export type ContextMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: readonly { tool: string; isError?: true }[]
}

export type ContextLimits = {
  /** How many recent messages go along (consecutive rows of one speaker count as one); 0 for none. */
  messages: number
  /** How many tokens the whole state may take: the message first, the recent conversation in what is left. */
  tokens: number
}

/** Han, kana, Hangul, CJK symbols and full-width forms: about one token each. */
const WIDE = /[ᄀ-ᅟ⺀-〿぀-㏿㐀-䶿一-鿿ꥠ-꥿가-힯豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3FFFF}]/u

/** One wide character is about one token; other text about four characters a token (measured on Jev: guide §2.7). */
function cost(char: string): number {
  return WIDE.test(char) ? 1 : 0.25
}

/** About how many tokens `text` takes. */
export function estimateTokens(text: string): number {
  let wide = 0
  let other = 0
  for (const char of text) {
    if (WIDE.test(char)) wide++
    else other++
  }
  return wide + Math.ceil(other / 4)
}

/**
 * `text` within `budget` tokens: whole when it fits; else its beginning and,
 * with a `tailShare` above 0, that share of the budget for its end, joined by
 * " … ". Empty for a budget under one token.
 */
export function clipToTokens(text: string, budget: number, tailShare = 0): string {
  if (estimateTokens(text) <= budget) return text
  if (budget < 1) return ''
  const chars = [...text]
  const room = budget - 1 // the marker
  const tailRoom = Math.floor(room * Math.min(Math.max(tailShare, 0), 1))
  let used = 0
  let head = 0
  while (head < chars.length && used + cost(chars[head] as string) <= room - tailRoom) used += cost(chars[head++] as string)
  let tail = chars.length
  used = 0
  while (tail > head && used + cost(chars[tail - 1] as string) <= tailRoom) used += cost(chars[--tail] as string)
  const start = chars.slice(0, head).join('').trimEnd()
  const end = chars.slice(tail).join('').trimStart()
  return end ? `${start} … ${end}` : `${start}…`
}

/** Leaves out what the engine wraps in <system-reminder> (not something anyone said), collapses whitespace. */
function said(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The tools a reply called, in order: `Bash x3 (1 failed), Read`. */
function toolSummary(uses: readonly { tool: string; isError?: true }[]): string {
  const counts = new Map<string, { calls: number; failed: number }>()
  for (const use of uses) {
    const count = counts.get(use.tool) ?? { calls: 0, failed: 0 }
    count.calls++
    if (use.isError) count.failed++
    counts.set(use.tool, count)
  }
  return [...counts]
    .map(([tool, { calls, failed }]) => {
      const times = calls > 1 ? ` x${calls}` : ''
      const failures = failed === 0 ? '' : calls > 1 ? ` (${failed} failed)` : ' (failed)'
      return `${tool}${times}${failures}`
    })
    .join(', ')
}

/**
 * The recent conversation as lines, oldest first, at most `count`: one line
 * per message, where the rows one speaker wrote in a row are one message (the
 * transcript gives a reply one row per block, and tool results rows of their
 * own). A row with neither text nor tools is skipped; the message itself, if
 * the transcript already ends with it, is left out.
 */
export function recentLines(messages: readonly ContextMessage[], prompt: string, count: number): string[] {
  const merged: { role: 'user' | 'assistant'; texts: string[]; tools: { tool: string; isError?: true }[] }[] = []
  for (const message of messages) {
    const text = said(message.text)
    const tools = message.toolUses ?? []
    if (!text && tools.length === 0) continue
    const last = merged.at(-1)
    if (last && last.role === message.role) {
      if (text) last.texts.push(text)
      last.tools.push(...tools)
    } else {
      merged.push({ role: message.role, texts: text ? [text] : [], tools: [...tools] })
    }
  }
  const last = merged.at(-1)
  if (last && last.role === 'user' && last.tools.length === 0 && last.texts.join(' ') === said(prompt)) merged.pop()
  if (count <= 0) return []
  return merged.slice(-count).map(({ role, texts, tools }) => {
    const ran = tools.length > 0 ? `[tools: ${toolSummary(tools)}] ` : ''
    return `${role}: ${ran}${redactSecrets(texts.join(' '))}`.trimEnd()
  })
}

/** Below this many tokens left, no recent message is worth sending. */
const MIN_LINE = 12
/** A message cut to fit keeps this much of its budget for its end (a reply's question is usually there). */
const TAIL_SHARE = 0.6
/** The person's message, cut to fit, keeps this much for its end. */
const MESSAGE_TAIL = 0.3

export type TurnStartInput = {
  /** The message the person just sent. */
  prompt: string
  /** The conversation before it (`$.session.messages()`). */
  messages: readonly ContextMessage[]
  limits: ContextLimits
}

/**
 * The state of a message's decision request: `{ user_message, recent_context }`,
 * the message first (Clef may read only the start of a state). The message
 * takes what it needs of `limits.tokens`; recent messages fill what is left,
 * newest first, an older one dropped whole rather than squeezed; the newest is
 * always sent, cut to fit if it must be.
 */
export function turnStartState(input: TurnStartInput): State {
  const message = clipToTokens(redactSecrets(input.prompt), input.limits.tokens, MESSAGE_TAIL)
  let room = input.limits.tokens - estimateTokens(message)
  const kept: string[] = []
  const lines = recentLines(input.messages, input.prompt, input.limits.messages)
  for (let i = lines.length - 1; i >= 0 && room >= MIN_LINE; i--) {
    const line = lines[i] as string
    const size = estimateTokens(line) + 1
    if (size <= room) {
      kept.unshift(line)
      room -= size
    } else {
      if (kept.length === 0) kept.unshift(clipToTokens(line, room - 1, TAIL_SHARE))
      break
    }
  }
  return { user_message: message, recent_context: kept.join('\n') }
}
