// The readout (design 5.12): which steps are open, and what each request the engine sends says of the level it
// carried, written beside the request.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpInit } from 'claude-code'

import { cellSent } from '../board/model.ts'
import type { Level } from '../levels.ts'
import { classify, clearCheck, modelBase, settleReading } from '../readout.ts'
import type { OpenStep, Reading } from '../readout.ts'
import { amendSent, failOpen, redraw, trace } from '../runtime.ts'
import { emptySession } from '../state.ts'

// The state atoms this file reads and writes, one line each and alike in every file that declares them: the module
// scan takes only a const of the file that reads or writes (eval/validate.ts checks the copies are the same text).
const SESSION = atom({ plugin: 'dispatch-pilot', key: 'session' } as const, emptySession())
const TURN = atom({ plugin: 'dispatch-pilot', key: 'turn' } as const, null)

// The steps open now, for the readout to tell the main loop's request from an agent's (design 5.12): the main loop's
// step, and the agent steps by model (modelBase). Module level, set around each step's next() and cleared in a finally: a hot
// reload in the middle of a step loses them, and that step's request is then recorded as unverified.
let openMain: OpenStep | null = null
const agentStepsOpen = new Map<string, number>()

/** Registers a step as open, until what it returns is called. Exported for tests (see readout). */
export function openStep(e: { turnId: string; index: number; model: string; agentId?: string }): () => void {
  const { turnId, index, model } = e
  if (e.agentId !== undefined) {
    const base = modelBase(model)
    agentStepsOpen.set(base, (agentStepsOpen.get(base) ?? 0) + 1)
    return () => {
      const left = (agentStepsOpen.get(base) ?? 1) - 1
      if (left > 0) agentStepsOpen.set(base, left)
      else agentStepsOpen.delete(base)
    }
  }
  openMain = { turnId, index, model, matched: false }
  return () => {
    if (openMain?.turnId === turnId && openMain.index === index) openMain = null
  }
}

/**
 * The readout of one request (design 5.12): read at once, its writes made beside the request, which it never sees.
 * Null: nothing to write. Exported for tests: the kit raises no http.fetch as the engine (DEVELOPMENT.md).
 */
export function readout($: EngineInterface, e: { url: string; init?: HttpInit }, origin: string): Promise<null> | null {
  const open = openMain
  let reading: Reading
  try {
    reading = classify({ originPlugin: origin, url: e.url, body: e.init?.body, open, agentStepsOpen: open === null ? 0 : (agentStepsOpen.get(modelBase(open.model)) ?? 0) })
  } catch (err) {
    trace($, 'http.fetch', err)
    return null
  }
  if (reading.kind === 'ignore') return null
  // Marked before anything is awaited, so a second request of the same step is never read as its own.
  if (reading.kind === 'main' && open !== null) openMain = { ...open, matched: true }
  return keepReading($, reading, open)
}

// What a reading writes: the session's current level (a main-loop reading only), and the check it settles, on both
// copies of the Decision. Each fails on its own: a level that could not be written keeps no Decision from its check.
// The board is drawn again once the level or the cell changed (amendSent redraws for the Decision's sent).
async function keepReading($: EngineInterface, r: Reading, open: OpenStep | null): Promise<null> {
  if (r.kind === 'main') {
    const effort = r.effort
    const level = await failOpen($, 'http.fetch', false, () => keepLevel($, effort))
    const cell = await failOpen($, 'http.fetch', false, () => keepCell($, effort, open))
    if (level || cell) await redraw($)
  }
  await failOpen($, 'http.fetch', null, () => settleCheck($, r, open))
  return null
}

// Whether it wrote: the board is drawn again only for a change.
async function keepLevel($: EngineInterface, effort: Level | null): Promise<boolean> {
  if ((await read($, SESSION)).lastSent === effort) return false
  await update($, SESSION, (s) => ({ ...s, lastSent: effort }))
  return true
}

// The timeline's cell of the work step under way (design 5.14) takes the level its first main-loop request carried;
// the requests after it in the same work step leave it as it is.
async function keepCell($: EngineInterface, effort: Level | null, open: OpenStep | null): Promise<boolean> {
  if (effort === null || open === null) return false
  const turnId = open.turnId
  const held = await read($, TURN)
  // Read first: update() writes whatever its callback returns.
  if (held === null || held.turnId !== turnId || cellSent(held, effort) === held) return false
  await update($, TURN, (cur) => (cur !== null && cur.turnId === turnId ? cellSent(cur, effort) : cur))
  return true
}

async function settleCheck($: EngineInterface, r: Reading, open: OpenStep | null): Promise<null> {
  const settled = settleReading(await read($, TURN), r, open)
  if (settled === null) return null
  // An unsure reading in the open step marks the Decision and leaves the check for the main reading.
  if (!settled.clears) {
    await amendSent($, settled.awaited.id, settled.sent)
    return null
  }
  // Cleared on what update() reads: of two main readings at once, only the one that clears the check amends.
  const box = { cleared: false }
  await update($, TURN, (cur) => {
    const next = clearCheck(cur, settled.awaited)
    box.cleared = next !== cur
    return next
  })
  if (box.cleared) await amendSent($, settled.awaited.id, settled.sent)
  return null
}
