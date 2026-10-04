// The status line: one row for the whole mod, built from named segments that
// different features own, joined in a fixed order. A feature sets its own
// segment and the line is sent only when it changed.
//
// ASCII only: CLAUDE.md asks for single-width characters in the interface,
// and CJK characters are double-width, so the line is English.
//
// Pure module state (lost on a hot reload until the next segment is set).

import type { Failure } from '../decision/backend.ts'

/**
 * The segments, in the order they show. Add yours here when a feature needs
 * one; each is set by its owner only.
 *   effort    the core's turn.step writer: the main turn's effort as it goes out
 *   midturn   the midturn-effort feature: the turn's steps, decisions and changes, once re-decided
 *   escalation the escalation feature: failed tool calls, hook blocks and forced raises, once there is one
 *   decision  the main-effort feature: why the message got no decision
 *   skills    the skills feature: the skills suggested for the latest message,
 *             and the person-only ones to try
 *   agent     the dispatched-agents feature: the latest dispatched agent's model and effort, or why it got none
 */
const ORDER = ['effort', 'midturn', 'escalation', 'decision', 'skills', 'agent'] as const
export type Segment = (typeof ORDER)[number]

const segments = new Map<Segment, string>()
let shown: string | undefined
let paused = false

/**
 * Sets (or with null clears) one segment, and hands the new line to `show`
 * (`(line) => $.ui.status(line)`) when it differs from the last one shown;
 * `undefined` clears the row.
 */
export function setStatus(segment: Segment, text: string | null, show: (line: string | undefined) => void): void {
  if (text === null) segments.delete(segment)
  else segments.set(segment, text)
  refresh(show)
}

/**
 * While Dispatch Pilot is switched off the row says only `dp off`, whatever the
 * segments hold; switched on again it starts empty, until the features set
 * their segments anew. Only the control feature calls this.
 */
export function pauseStatus(value: boolean, show: (line: string | undefined) => void): void {
  if (value === paused) return
  paused = value
  if (!value) segments.clear()
  refresh(show)
}

function refresh(show: (line: string | undefined) => void): void {
  const parts = ORDER.flatMap((name) => segments.get(name) ?? [])
  const line = paused ? 'dp off' : parts.length > 0 ? `dp ${parts.join(' | ')}` : undefined
  if (line === shown) return
  shown = line
  show(line)
}

/** A failed decision request in a few words, for the status line. */
export function failureText(backend: string, failure: Failure): string {
  switch (failure.kind) {
    case 'config':
      return failure.status === undefined ? `${backend}: ${failure.detail}` : `${backend}: key refused (HTTP ${failure.status})`
    case 'timeout':
      return `${backend}: ${failure.detail}`
    case 'network':
      return `${backend}: unreachable`
    case 'busy':
      return `${backend}: busy (HTTP ${failure.status ?? '?'})`
    case 'quota':
      return `${backend}: daily quota used up`
    case 'http':
      return `${backend}: HTTP ${failure.status ?? '?'}`
    case 'parse':
      return `${backend}: unreadable answer`
    case 'request':
      return `${backend}: bad request (see debug log)`
  }
}
