// Which prompts are the person's own new messages: the only ones a feature
// asks the decision model about at prompt.submit. Pure.

import type { PromptOrigin } from 'claude-code'

/**
 * True for a message the person sent: typed at the terminal (`composer`),
 * through the Remote Control bridge, as the SDK host's turn (`claude -p`),
 * pinged from Slack by the session's owner, or submitted by a plugin as the
 * person's own words. False for the rest (a subagent's hand-back, a
 * background task's notice, a peer session, a schedule, a plugin speaking for
 * itself), for a typed slash command and for an empty prompt.
 */
export function isPersonsMessage(e: { text: string; origin?: PromptOrigin }): boolean {
  const text = e.text.trim()
  if (text === '' || text.startsWith('/')) return false
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
