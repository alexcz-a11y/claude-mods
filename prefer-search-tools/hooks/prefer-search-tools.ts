// The auto-mode reminder (type `auto_mode`, also sent in bypass mode) steers the model to Bash for reading, searching
// and editing. Only its search clause is taken out and replaced by a sentence naming the Grep and Glob tools; the rest
// of the reminder stays as the engine wrote it. A reminder without the clause (another build) goes on unchanged.
//
// Subagents get no auto-mode reminder (seen on 2.1.309), so the same sentence goes at the end of the task each one
// starts with. A fork already carries the main loop's rewritten reminder, a resume cannot be rewritten (the types say
// it can only be refused), and a teammate is left as its lead asked.

import type { On } from 'claude-code'

/** The clause as 2.1.296 writes it, in both its strict and relaxed variants. */
export const SEARCH_CLAUSE = 'search with grep and find, '

export const SEARCH_STEER = 'For searches, use the Grep tool for file contents and the Glob tool for file names, not grep or find through Bash, '
  + 'and not chained after another command with ; or && either. Piping another command\'s output into grep is fine.'

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

  on('agent.spawn', async ($, e, next) => {
    if (e.fork || e.resume !== undefined || e.isTeammate || e.prompt.includes(SEARCH_STEER)) return next(e)
    return next({ ...e, prompt: `${e.prompt}\n\n${SEARCH_STEER}` })
  })
}
