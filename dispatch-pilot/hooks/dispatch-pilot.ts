import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, Register } from 'claude-code'

import type { Io } from './backend.ts'
import { readConfig } from './config.ts'
import type { Config } from './config.ts'
import { isLevel } from './levels.ts'
import { DP_USAGE, RECENT_KEEP, badLevelReply, lockReply, parseDp, pushLog, readLog, renderDp, renderLog, unlockReply } from './log.ts'
import type { Decision } from './log.ts'
import { emptySession } from './state.ts'

// $.state, through the state library: a read of a key never written gives the initial, and update()
// writes with compare-and-set and tries again on a miss. So no key needs initialising: session.start,
// which fires again on every hot reload and plugin enable, only refreshes session.surfaces, and an
// existing session (its lock), turn, recent or skills stays as it was.
const SESSION = atom({ plugin: 'dispatch-pilot', key: 'session' } as const, emptySession())
const TURN = atom({ plugin: 'dispatch-pilot', key: 'turn' } as const, null)
const RECENT = atom({ plugin: 'dispatch-pilot', key: 'recent' } as const, [])

/** $.store key of the decision log, shared by every session on this machine. */
const LOG = 'log'

// The catch-all every hook decides inside: a throw anywhere in `decide` hands back `unchanged`, and
// the hook passes that on with next(...) outside the try, so it always reaches next and never calls it
// twice. Every failure fails open.
async function failOpen<T>(unchanged: T, decide: () => Promise<T>): Promise<T> {
  try {
    return await decide()
  } catch {
    return unchanged
  }
}

/** The I/O backend.ts asks through; it never touches $ itself. */
export function ioOf($: EngineInterface): Io {
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
    now: () => $.clock.now(),
  }
}

/** Appends a decision to $.store's log and to this session's recent. Never throws. */
export async function record($: EngineInterface, d: Decision): Promise<void> {
  // Each write fails on its own: losing one copy must not lose the other.
  try {
    await update($, RECENT, (list) => pushLog(list, d, RECENT_KEEP))
  } catch {
    // fail open
  }
  try {
    // $.store has no compare-and-set and every session on the machine writes here: nothing is awaited
    // between the read and the write, so another session's write can only be lost in that one gap.
    const held = await $.store.get(LOG)
    await $.store.set(LOG, pushLog(readLog(held), d))
  } catch {
    // fail open
  }
}

const shown = (text: string): CommandRunResult => ({ text, isTextDisplayOnly: true })

async function answerDp($: EngineInterface, cfg: Config, args: string): Promise<CommandRunResult> {
  const c = parseDp(args)
  if (c.kind === 'show') {
    const session = await read($, SESSION)
    const turn = await read($, TURN)
    const wanted = turn?.wanted ?? turn?.base ?? null
    return shown(renderDp({ cfg, wanted, lastSent: session.lastSent, lock: session.lock, log: await read($, RECENT) }))
  }
  if (c.kind === 'lock') {
    await update($, SESSION, (s) => ({ ...s, lock: c.level }))
    return shown(lockReply(c.level, cfg))
  }
  if (c.kind === 'unlock') {
    const was = (await read($, SESSION)).lock
    if (was !== null) await update($, SESSION, (s) => ({ ...s, lock: null }))
    return shown(unlockReply(was))
  }
  if (c.kind === 'log') {
    const held = await $.store.get(LOG).then(
      (v) => readLog(v),
      () => null,
    )
    return shown(held === null ? '读不到决策记录（$.store 出错了）。' : renderLog(held, c.n))
  }
  if (c.kind === 'bad-level') return shown(badLevelReply(c.word))
  return shown(DP_USAGE)
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    await failOpen(null, async () => {
      await $.command.register({
        name: 'dp',
        description: 'dispatch-pilot：档位、锁定、后端和最近的决策（lock <档位>、unlock、log [n]）',
        argumentHint: '[lock <档位> | unlock | log [n]]',
      })
      return null
    })
    await failOpen(null, async () => {
      const surfaces = [...(await $.session.surfaces())]
      // Only the surfaces are refreshed: a reload keeps the lock and everything else.
      await update($, SESSION, (s) => ({ ...s, surfaces }))
      return null
    })
    return next(e)
  })

  on('command.run', { command: 'dp' }, async ($, e, next) => {
    const answer = await failOpen(null, () => answerDp($, cfg, e.args))
    return answer ?? next(e)
  })

  // The one turn.step hook (no matcher may be registered twice): the main loop's branch here, agents'
  // (e.agentId set) in a later task. For now it writes the lock.
  on('turn.step', async function* ($, e, next) {
    const out = await failOpen(e, async () => {
      // A step whose effort is absent (the model takes none) or a number (the session uses numeric
      // effort) passes as it came; so does every step while the mod is off or only watching.
      if (e.agentId !== undefined || !isLevel(e.effort)) return e
      if (!cfg.enabled || cfg.mode === 'shadow') return e
      const { lock } = await read($, SESSION)
      // Only effort is written: the main loop's model is never changed (it would break the prompt cache).
      return lock === null ? e : { ...e, effort: lock }
    })
    return yield* next(out)
  })
}
