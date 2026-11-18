// What every flow shares: the fail-open wrapper and its debug line, the I/O backend.ts asks through, the decision
// log's writes (recent, and $.store's log in one chain), and session.start's refresh of the surfaces.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Io } from './backend.ts'
import { markOf } from './board/model.ts'
import type { Config } from './config.ts'
import { RECENT_KEEP, pushLog, readLog } from './log.ts'
import type { Decision } from './log.ts'
import { withSent } from './readout.ts'
import { emptySession } from './state.ts'

// $.state, through the state library: a read of a key never written gives the initial, and update()
// writes with compare-and-set and tries again on a miss. So no key needs initialising: session.start,
// which fires again on every hot reload and plugin enable, only refreshes session.surfaces, and an
// existing session (its lock), turn, recent or skills stays as it was.
// The state atoms this file reads and writes, one line each and alike in every file that declares them: the module
// scan takes only a const of the file that reads or writes (eval/validate.ts checks the copies are the same text).
const SESSION = atom({ plugin: 'dispatch-pilot', key: 'session' } as const, emptySession())
const RECENT = atom({ plugin: 'dispatch-pilot', key: 'recent' } as const, [])
const TURN = atom({ plugin: 'dispatch-pilot', key: 'turn' } as const, null)

/** $.store key of the decision log, shared by every session on this machine. */
export const LOG = 'log'

/**
 * Asks the engine to draw the board again (design 5.14). Never throws: a redraw that fails costs the board a moment,
 * never the hook that asked for it.
 */
export function redraw($: EngineInterface): void {
  try {
    $.ui.invalidate('ui.render')
  } catch (err) {
    trace($, 'redraw', err)
  }
}

/** Whether the readout runs (design 5.12): verifyEffort on, and the mod enabled (controller ruling: off, it does nothing at all). */
export function verifies(cfg: Config): boolean {
  return cfg.enabled && cfg.verifyEffort
}

// One line in the debug log for an error the mod swallowed: the hook and the error's message, never
// state or message content. A log call that throws itself is swallowed too.
export function trace($: EngineInterface, hook: string, err: unknown): void {
  try {
    const message = err instanceof Error ? err.message : String(err)
    $.ui.log(`${hook} failed open: ${message.slice(0, 200)}`, { to: 'debug' })
  } catch {
    // fail open
  }
}

// The catch-all every hook decides inside: a throw anywhere in `decide` hands back `unchanged`, and
// the hook passes that on with next(...) outside the try, so it always reaches next and never calls it
// twice. Every failure fails open, and leaves a line in the debug log.
export async function failOpen<T>($: EngineInterface, hook: string, unchanged: T, decide: () => Promise<T>): Promise<T> {
  try {
    return await decide()
  } catch (err) {
    trace($, hook, err)
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

// $.store has no compare-and-set, so this process's writes to the log go through one chain: two
// decisions recorded at once would otherwise read the same log and the later write would drop the
// other, and an amendment queued after the record it amends cannot overtake it. A hot reload starts a
// new chain; what that costs is at most an entry written in that instant.
let logWrites: Promise<void> = Promise.resolve()

function inOrder(write: () => Promise<void>): Promise<void> {
  const mine = logWrites.then(write)
  logWrites = mine
  return mine
}

async function appendLog($: EngineInterface, d: Decision): Promise<void> {
  try {
    // Other sessions on the machine write here too: nothing is awaited between the read and the
    // write, so another session's write can only be lost in that one gap.
    const held = await $.store.get(LOG)
    await $.store.set(LOG, pushLog(readLog(held), d))
  } catch (err) {
    trace($, 'record', err)
  }
}

/**
 * Appends a decision to $.store's log and to this session's recent; an evaluation of the main loop's level (submit,
 * midrun) also leaves its mark on its turn, for the timeline's next cell (design 5.14). Then the board is drawn
 * again. Never throws.
 */
export async function record($: EngineInterface, d: Decision): Promise<void> {
  // Each write fails on its own: losing one copy must not lose the other.
  try {
    await update($, RECENT, (list) => pushLog(list, d, RECENT_KEEP))
  } catch (err) {
    trace($, 'record', err)
  }
  if (d.kind === 'submit' || d.kind === 'midrun') await keepMark($, d)
  await inOrder(() => appendLog($, d))
  redraw($)
}

async function keepMark($: EngineInterface, d: Decision): Promise<void> {
  try {
    const mark = markOf(d)
    const held = await read($, TURN)
    // Read first: update() writes whatever its callback returns.
    if (held === null || held.turnId !== d.turnId || held.pendingMark === mark) return
    await update($, TURN, (cur) => (cur !== null && cur.turnId === d.turnId ? { ...cur, pendingMark: mark } : cur))
  } catch (err) {
    trace($, 'record', err)
  }
}

async function storeSent($: EngineInterface, id: string, sent: Decision['sent']): Promise<void> {
  try {
    const next = withSent(readLog(await $.store.get(LOG)), id, sent)
    if (next !== null) await $.store.set(LOG, next)
  } catch (err) {
    trace($, 'amend', err)
  }
}

/**
 * Writes a recorded Decision's sent, in recent and in $.store's log (after every record queued before it); withSent
 * says when. Then the board is drawn again. Never throws.
 */
export async function amendSent($: EngineInterface, id: string, sent: Decision['sent']): Promise<void> {
  try {
    // Read first: update() writes whatever its callback returns, and a repeated unsure reading changes nothing.
    if (withSent(await read($, RECENT), id, sent) !== null) await update($, RECENT, (list) => withSent(list, id, sent) ?? list)
  } catch (err) {
    trace($, 'amend', err)
  }
  await inOrder(() => storeSent($, id, sent))
  redraw($)
}

// session.start's refresh: only the surfaces (the session state belongs to no one feature).
export async function keepSurfaces($: EngineInterface): Promise<null> {
  const surfaces = [...(await $.session.surfaces())]
  // Only the surfaces are refreshed: a reload keeps the lock and everything else.
  await update($, SESSION, (s) => ({ ...s, surfaces }))
  return null
}
