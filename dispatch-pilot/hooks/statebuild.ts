// Builds the JSON state each decision is asked about. Pure functions: no $ calls.
// Field names are the ones the questions point at (questions.ts). Text is only clipped, never redacted.
import type { Level } from './levels.ts'

// The most a state may weigh, by estimateTokens; both decision models stay in their normal mode below it.
export const STATE_BUDGET = 4000

// Bytes of one code point in UTF-8. Counted by hand: the sandbox is not guaranteed a TextEncoder in tests.
function utf8Bytes(codePoint: number): number {
  if (codePoint < 0x80) return 1
  if (codePoint < 0x800) return 2
  // A lone surrogate is encoded as U+FFFD, three bytes.
  if (codePoint < 0x10000) return 3
  return 4
}

function byteLength(text: string): number {
  let n = 0
  for (const ch of text) n += utf8Bytes(ch.codePointAt(0) ?? 0)
  return n
}

// UTF-8 bytes over three, rounded up: close to the real count for English, safe for Chinese (3 bytes, about 1 token).
export function estimateTokens(text: string): number {
  return Math.ceil(byteLength(text) / 3)
}

const MARKER = ' … '

// Keeps the head and the tail, half each, with a marker between: the start says what is asked,
// the end often holds the part that matters (the last error line, the final request).
// The result never estimates above maxTokens.
export function clip(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  const room = Math.max(0, maxTokens * 3 - byteLength(MARKER))
  const half = Math.floor(room / 2)
  const chars = Array.from(text)
  let head = 0
  let headBytes = 0
  while (head < chars.length) {
    const b = utf8Bytes(chars[head]!.codePointAt(0) ?? 0)
    if (headBytes + b > half) break
    headBytes += b
    head++
  }
  let tail = chars.length
  let tailBytes = 0
  while (tail > head) {
    const b = utf8Bytes(chars[tail - 1]!.codePointAt(0) ?? 0)
    if (tailBytes + b > half) break
    tailBytes += b
    tail--
  }
  return chars.slice(0, head).join('') + MARKER + chars.slice(tail).join('')
}

export type PreviousTurn = { request: string; lastReply: string; ended: 'answered' | 'error' | 'interrupted'; level: Level | null }
export type StepRecord = { did: string; tools: string[]; ok: boolean; result: string }
export type ProgressNote = { done: string; remaining: string; cause_known: boolean }

export function submitState(i: { request: string; previous: PreviousTurn | null }): Record<string, unknown> {
  const state: Record<string, unknown> = {
    note: '"request" is the user\'s new message; "previous_turn" is what came just before it.',
    request: clip(i.request, 1200),
  }
  if (i.previous) {
    state.previous_turn = {
      request: clip(i.previous.request, 300),
      last_reply: clip(i.previous.lastReply, 300),
      ended: i.previous.ended,
      level: i.previous.level,
    }
  }
  return state
}

function stepEntry(step: StepRecord, resultBudget: number): Record<string, unknown> {
  return { did: clip(step.did, 60), tools: step.tools, outcome: step.ok ? 'ok' : 'error', result: clip(step.result, resultBudget) }
}

export function midrunState(i: {
  request: string
  current: Level
  stepsSoFar: number
  failedSteps: number
  recent: StepRecord[]
  latest: StepRecord
  statedNext: string
  progress: ProgressNote | null
}): Record<string, unknown> {
  const state: Record<string, unknown> = {
    note: 'Entries in "recent" are oldest first. Judge by the results, not by what the assistant says it achieved; "stated_next" and "progress" are the assistant\'s own account.',
    request: clip(i.request, 600),
    current_level: i.current,
    steps_so_far: i.stepsSoFar,
    failed_steps: i.failedSteps,
    // Callers pass steps oldest first; the last five are the most recent.
    recent: i.recent.slice(-5).map((step) => stepEntry(step, 150)),
    latest: stepEntry(i.latest, 600),
  }
  if (i.statedNext.trim()) state.stated_next = clip(i.statedNext, 200)
  // The brief gives progress no budget; 150 per text field keeps the whole state under STATE_BUDGET.
  if (i.progress) {
    state.progress = { done: clip(i.progress.done, 150), remaining: clip(i.progress.remaining, 150), cause_known: i.progress.cause_known }
  }
  return state
}

export function agentState(i: { task: string; agentType: string; description: string }): Record<string, unknown> {
  return {
    note: '"task" is the brief given to a subagent that is about to start.',
    task: clip(i.task, 2500),
    agent_type: i.agentType,
    description: clip(i.description, 100),
  }
}
