// Which prompts are the person's own new messages: the only ones a feature
// asks the decision model about at prompt.submit. Pure.

import type { PromptOrigin } from 'claude-code'

/**
 * True for a message the person sent: typed at the terminal (`composer`),
 * through the Remote Control bridge, as the SDK host's turn (`claude -p`),
 * pinged from Slack by the session's owner, or submitted by a plugin as the
 * person's own words. False for the rest (a dispatched agent's hand-back, a
 * background task's notice, a peer session, a schedule, a plugin speaking for
 * itself) and for an empty prompt.
 *
 * A prompt command the person typed (a skill, a markdown command: `/name
 * args`) is their message too: it starts a turn (a command turn,
 * core/commands.ts). A local command (`/dp`, `/clear`) never reaches
 * prompt.submit, and a text that only starts with a slash (`/Users/...`) is
 * an ordinary message (measured on 2.1.291).
 */
export function isPersonsMessage(e: { text: string; origin?: PromptOrigin }): boolean {
  const text = e.text.trim()
  if (text === '') return false
  // `origin` is always set by the engine; tests that leave it out get false.
  const origin = e.origin
  switch (origin?.kind) {
    case 'composer':
    case 'bridge':
    case 'sdk':
    case 'slack-ping':
      return true
    case 'plugin':
      return origin.asUser === true
    default:
      return false
  }
}

/**
 * True for a report that starts a turn of the main agent without the person
 * having sent anything: a dispatched agent's hand-back (`peer`) or a
 * background task's notice (`task-notification`) that reaches the session
 * while it is idle (no `turnId`: delivered into a running turn it starts none,
 * and that turn's effort is its own). The turn it starts goes through the
 * effort routing like the person's own message, with the report read as the
 * message; nothing else is asked about it (no skills: it is no request of the
 * person's). Other origins that are not the person's (a schedule, a peer
 * session's message, a plugin speaking for itself, an observer) are left as
 * they were: nothing is asked.
 */
export function startsReportTurn(e: { text: string; origin?: PromptOrigin; turnId?: string }): boolean {
  const text = e.text.trim()
  if (text === '' || e.turnId !== undefined) return false
  return e.origin?.kind === 'task-notification' || e.origin?.kind === 'peer'
}
