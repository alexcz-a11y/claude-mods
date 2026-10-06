// The old status line: one row for the whole mod, built from named segments,
// joined in a fixed order and sent only when it changed. It is drawn from the
// board data and the decisions, and core/report.ts is its only caller
// (tests/report.test.ts checks that no feature touches it). The whole line goes
// when the new screens replace it (ADR 0004, #29).
//
// ASCII only: CLAUDE.md asks for single-width characters in the interface,
// and CJK characters are double-width, so the line is English.
//
// Pure module state (lost on a hot reload until the next segment is set).

/**
 * The segments, in the order they show, and what the decision report draws in
 * each (`reportStep`, `reportDecision(s)`, `reportTally`; the feature named is
 * the one whose switch owns it, `defineSwitch`'s `segments`).
 *   effort    the main turn's effort as it goes out (reportStep; no feature's switch owns it, only `/dp off` hides it)
 *   midturn   midturn-effort: the turn's steps, decisions and changes, once re-decided
 *   escalation escalation: failed tool calls, hook blocks and forced raises, once there is one
 *   decision  main-effort: why the message got no decision
 *   skills    skills: the skills suggested for the latest message, and the person-only ones to try
 *   find-skill  find-skill: what the main agent's latest find_skill returned, or why it failed
 *   agent     dispatched-agents: the latest dispatched agent's model and effort, or why it got none
 *   agentEscalation  escalation: failed tool calls, hook blocks and forced raises of the latest agent that had any
 *   workflow  workflow-agents: how the latest Workflow's agents were routed, or why they were not
 *   labels    workflow-labels: how many agents of the latest Workflow it routed as they started, and why not
 */
const ORDER = ['effort', 'midturn', 'escalation', 'decision', 'skills', 'find-skill', 'agent', 'agentEscalation', 'workflow', 'labels'] as const
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
 * their segments anew. Reached through the report's `reportSwitch`.
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
