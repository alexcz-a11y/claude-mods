// When a loop began (#62, spec #55; GLOSSARY 循环), kept in `$.state` under `loops` (types/index.d.ts): for the main agent the
// `turn.start` of its latest turn, for a dispatched or Workflow agent its `agent.spawn`. The images work tells an image the loop
// made from one that was there before it by a file's modification time against this moment, and two features read it:
//
//   - the screenshot takeover (#62) takes over the images whose files are `isFromLoop`;
//   - the reference images of the routing (#64) are the files that are not (`startedBefore`).
//
// Recording it is not a feature and has no switch: it costs one `$.state.set` per loop. A reader asks for the loop of an agent
// with `$.state.get({ plugin: 'dispatch-pilot', key: 'loops', id: agent })` (`MAIN_LOOP` for the main agent), and gets
// `{ startedAt }`, or nothing when no beginning was seen: it is then not known which files are older, and the reader leaves the
// file as it is. (`validate` wants a state reference's plugin and key written as literals in the file that reads it, so a reader
// declares `const LOOPS = { plugin: 'dispatch-pilot', key: 'loops' } as const` itself.) The state outlives a hot reload, which
// resets the modules.

import type { On } from 'claude-code'
import { errorText } from '../decision/backend.ts'

/** The `$.state` family of the loops' beginnings, by loop: `main` or the agentId. */
const LOOPS = { plugin: 'dispatch-pilot', key: 'loops' } as const

/** The main agent's id among the loops. */
export const MAIN_LOOP = 'main'

/**
 * Whether a file modified at `mtimeMs` (`$.fs.stat`) was made in the loop that began at `startedAt`. A file saved in the very
 * millisecond the loop began counts as the loop's: only a file older than the beginning was there before it.
 */
export function isFromLoop(mtimeMs: number, startedAt: number): boolean {
  return mtimeMs >= startedAt
}

/** The converse, for the reference images of a loop (#64): the file was modified before the loop began. */
export function startedBefore(mtimeMs: number, startedAt: number): boolean {
  return !isFromLoop(mtimeMs, startedAt)
}

export function registerLoopStart(on: On): void {
  // A turn of the main agent starts its loop afresh. An agent's own run has a `turn.start` too (2.1.299 on), which only fills
  // in for a spawn that was not seen: the spawn is the loop's beginning.
  on('turn.start', { turnId: /(?:)/ }, async ($, e, next) => {
    try {
      const startedAt = await $.clock.now()
      if (e.agentId === undefined) {
        await $.state.set({ ...LOOPS, id: MAIN_LOOP }, { startedAt })
      } else if ((await $.state.get({ ...LOOPS, id: e.agentId })).value === undefined) {
        await $.state.set({ ...LOOPS, id: e.agentId }, { startedAt })
      }
    } catch (error) {
      $.ui.log(`loop start was not recorded: ${errorText(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  // The beginning is the moment the spawn is raised (the agent's id is known once it returns); a resumed run is a loop of its own.
  on('agent.spawn', { tool_use_id: /(?:)/ }, async ($, e, next) => {
    const startedAt = await $.clock.now().catch(() => undefined)
    const started = await next(e)
    if (started.deny === undefined && startedAt !== undefined && started.agentId !== undefined) {
      await $.state.set({ ...LOOPS, id: started.agentId }, { startedAt }).catch((error: unknown) => $.ui.log(`loop start was not recorded: ${errorText(error)}`, { to: 'debug' }))
    }
    return started
  })
}
