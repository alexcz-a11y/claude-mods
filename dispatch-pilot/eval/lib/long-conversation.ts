// The conversations of the long-context dataset (#44): what an item holds is the decisive rounds (hand-written) and the
// words of the work around them (`vocab`); the long stretch of ordinary work between those rounds and the message is
// written by `long-filler.ts`, the same every time (a seeded generator over templates), so the dataset stays a few
// hundred kilobytes instead of tens of megabytes and the conversation of every version is reproducible from the item.
//
// One question has three versions of one conversation (the filler is the same text in each, in the same order):
//   deep  the decisive rounds first, then the filler: they are `depth` estimated tokens before the message;
//   near  the filler, then the decisive rounds, then a few thousand tokens of filler before the message (control a);
//   none  the filler alone (control b: the decisive rounds deleted whole).
//
// Pure: no Node API.

import { estimateTokens, recentLines, said, type ContextMessage } from '../../hooks/decision/context.ts'
import type { ContextEntry, LongContextItem } from './datasets.ts'
import { fillerTurns } from './long-filler.ts'

export type { LongContextItem as LongItem }

export type Version = 'deep' | 'near' | 'none'
export const VERSIONS: readonly Version[] = ['deep', 'near', 'none']

/** How much filler follows the decisive rounds in the near version: at least this many estimated tokens, and less than a turn more. */
export const NEAR_TAIL = { least: 2500, most: 5800 }

/** What a conversation costs the state: each message as a line of `recent_context`, in estimated tokens (the line and its newline). */
export function conversationTokens(entries: readonly ContextEntry[]): number {
  const messages: ContextMessage[] = entries.map((entry) => ({ role: entry.role, text: entry.text, toolUses: (entry.tools ?? []).map((tool) => ({ tool })) }))
  return recentLines(messages, '\u0000', Number.MAX_SAFE_INTEGER).reduce((sum, line) => sum + estimateTokens(line) + 1, 0)
}

/** The decisive rounds as the mod would read them from the transcript (the `says` marks are the dataset's, not the conversation's). */
export function decisiveEntries(item: LongContextItem): ContextEntry[] {
  return item.zh.decisive.map(({ says: _says, ...entry }) => entry)
}

/** A short fingerprint of a conversation (two FNV-1a passes over its JSON, 16 hex digits): a summary written for it names it, so one written for another is known. */
export function fingerprint(entries: readonly ContextEntry[]): string {
  const text = JSON.stringify(entries)
  let a = 2166136261
  let b = 84696351
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    a = Math.imul(a ^ code, 16777619)
    b = Math.imul(b ^ (code + i), 40503)
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * What a state holds of the decisive rounds when it holds all of them: the start of the first message of the person, as the
 * state words it (whitespace collapsed). A state that has it has them all: the mod keeps the newest messages whole, the
 * oldest dropped.
 */
export function decisiveMark(item: LongContextItem): string {
  return said(item.zh.decisive[0]?.text ?? '').slice(0, 30)
}

const built = new WeakMap<LongContextItem, Map<Version, ContextEntry[]>>()

/** The conversation before the item's message, in a version: what the mod would read from the transcript, oldest first. */
export function conversationOf(item: LongContextItem, version: Version): ContextEntry[] {
  const cached = built.get(item)?.get(version)
  if (cached !== undefined) return cached
  const decisive = decisiveEntries(item)
  const filler = fillerTurns(item.zh.vocab, item.id, item.depth - conversationTokens(decisive))
  let entries: ContextEntry[]
  if (version === 'deep') entries = [...decisive, ...filler]
  else if (version === 'none') entries = filler
  else {
    // The last turns that hold at least the tail's least tokens stay after the decisive rounds.
    let at = filler.length
    let tail = 0
    while (at >= 2 && tail < NEAR_TAIL.least) {
      at -= 2
      tail = conversationTokens(filler.slice(at))
    }
    entries = [...filler.slice(0, at), ...decisive, ...filler.slice(at)]
  }
  const versions = built.get(item) ?? new Map<Version, ContextEntry[]>()
  versions.set(version, entries)
  built.set(item, versions)
  return entries
}

/**
 * How many times the person had said the problem was still unresolved by the item's message: each message of the
 * decisive rounds says (`says`) what it is of the problem before it, one more for "unresolved", back to none for "resolved"
 * or "new"; the filler's messages say nothing of the kind, so they leave the count as it is.
 */
export function unresolvedCount(item: LongContextItem): number {
  let count = 0
  for (const entry of item.zh.decisive) {
    if (entry.says === 'unresolved') count++
    else if (entry.says === 'resolved' || entry.says === 'new') count = 0
  }
  return count
}
