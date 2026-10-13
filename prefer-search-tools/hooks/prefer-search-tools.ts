// The auto-mode reminder (type `auto_mode`, also sent in bypass mode) steers the model to Bash for reading, searching
// and editing. Only its search clause is taken out and replaced by a sentence naming the Grep and Glob tools; the rest
// of the reminder stays as the engine wrote it. A reminder without the clause (another build) goes on unchanged.

import type { On } from 'claude-code'

/** The clause as 2.1.296 writes it, in both its strict and relaxed variants. */
export const SEARCH_CLAUSE = 'search with grep and find, '

export const SEARCH_STEER = 'For searches, use the Grep tool for file contents and the Glob tool for file names, not grep or find through Bash.'

/** The reminder with its search clause replaced, or undefined when it has none. */
export function steered(text: string): string | undefined {
  if (!text.includes(SEARCH_CLAUSE)) return undefined
  return `${text.replace(SEARCH_CLAUSE, '')}\n\n${SEARCH_STEER}`
}

export function register(on: On): void {
  on('prompt.attachment', { type: 'auto_mode' }, async ($, e, next) => {
    const text = steered(e.text)
    return next(text === undefined ? e : { ...e, text })
  })
}
