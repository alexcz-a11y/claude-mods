// Feature: the unresolved count (#39; GLOSSARY 未解决次数). Each of the person's
// messages is asked, in the effort request, whether it says the problem they and
// the main agent are on is still not solved, is solved, or is another one; the
// answer moves the count (core/unresolved.ts). The question and the reading of its
// answer are in features/main-effort.ts, which owns the effort part of the ballot
// they travel in (one contribution per part); this file owns the switch and the
// count's start-over.
//
// The count is per session: `/clear` and a new session start it over (`session.end`
// fires for both; `session.start` also fires on a hot reload, which must keep it),
// a compaction keeps it. Switched off, the question is not asked and the count
// stays as it is.

import type { On } from 'claude-code'
import { clearCount, type CountCell } from '../core/unresolved.ts'
import { defineSwitch } from '../core/switches.ts'

const COUNT = { plugin: 'dispatch-pilot', key: 'unresolved' } as const

/** The switch's name: `/dp unresolved on|off`. */
export const UNRESOLVED_SWITCH = 'unresolved'

export function registerUnresolved(on: On): void {
  defineSwitch({ name: UNRESOLVED_SWITCH, info: '每条消息判断同一个问题是否仍未解决，数未解决的次数' })

  on('session.end', { reason: /(?:)/ }, async ($, e, next) => {
    const cell: CountCell = { get: () => $.state.get(COUNT), set: (value, options) => $.state.set(COUNT, value, options) }
    try {
      await clearCount(cell)
    } catch (error) {
      $.ui.log(`unresolved count not cleared: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
    }
    return next(e)
  })
}
