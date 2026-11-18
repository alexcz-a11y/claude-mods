// The progress note (design 5.13): one call in the background after a checkpoint, read on a later main-loop row.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult } from 'claude-code'

import type { Config } from '../config.ts'
import { decisionId } from '../log.ts'
import { followCall, nextFlight, progressPrompt, progressRequest, settleFlight } from '../progress.ts'
import type { ProgressFlight, ProgressInput } from '../progress.ts'
import { record } from '../runtime.ts'
import { emptySession } from '../state.ts'
import type { TurnState } from '../state.ts'

// The state atoms this file reads and writes, one line each and alike in every file that declares them: the module
// scan takes only a const of the file that reads or writes (eval/validate.ts checks the copies are the same text).
const SESSION = atom({ plugin: 'dispatch-pilot', key: 'session' } as const, emptySession())
const TURN = atom({ plugin: 'dispatch-pilot', key: 'turn' } as const, null)

// The progress note's call (design 5.13): in the air, or come back and not yet read. Module level, because the call's
// .then writes here and nowhere else: the hook that started it has ended, so $ is not its to use. A hot reload loses
// it; that costs one note (the next checkpoint asks with the older one), or one failure left unrecorded.
let progressFlight: ProgressFlight | null = null
// The newest checkpoint's input, waiting for the call in the air. Module level: a hot reload costs one note.
let progressQueued: ProgressInput | null = null

// A main-loop turn starts or ends: no input of the last one waits for a note any more (a call still in the air is
// kept, and dropped when it comes back). A hot reload has already lost the input: progressQueued's comment above.
export function dropQueuedInput(): void {
  progressQueued = null
}

// Whether a call has come back and waits to be read. A hot reload loses the call: progressFlight's comment above.
export function noteCameBack(): boolean {
  return progressFlight !== null && progressFlight.settled
}

// The progress note's turn, after a checkpoint (fresh: its input) or on a main-loop row once the call has come back
// (fresh null): a call come back is read into the turn, then the next call starts or the input waits behind one.
export async function tickProgress($: EngineInterface, cfg: Config, fresh: ProgressInput | null): Promise<null> {
  const back = progressFlight !== null && progressFlight.settled ? progressFlight : null
  if (back !== null) {
    // Taken before anything is awaited, so two rows at once cannot both read it.
    progressFlight = null
    await settleNote($, cfg, back)
  }
  if (fresh === null && progressQueued === null) return null
  const blocked = (await read($, SESSION)).progressBlocked
  const turn = await read($, TURN)
  const at = await $.clock.now()
  // Decided and set with nothing awaited in between, so two rows at once cannot both start a call.
  const plan = nextFlight({ on: cfg.progressNote, blocked, busy: progressFlight !== null, queued: progressQueued, fresh, turnId: turn?.turnId ?? null })
  progressQueued = plan.queue
  const input = plan.start
  if (input !== null) startNote($, cfg, input, { previous: turn !== null && turn.turnId === input.turnId ? turn.progress : null, at })
  return null
}

// Starts the call and returns at once: no hook waits for it. Its outcome is only put in the slot (followCall), and
// read on a later row; a call the slot no longer holds (a reload) is left alone.
function startNote($: EngineInterface, cfg: Config, input: ProgressInput, c: { previous: TurnState['progress']; at: number }): void {
  const mine: ProgressFlight = { turnId: input.turnId, startedAt: c.at, settled: false, note: null, refused: false, failure: null, detail: '' }
  progressFlight = mine
  const prompt = progressPrompt({ request: input.request, previous: c.previous, latest: input.latest })
  let call: Promise<ModelCompleteResult> | null = null
  try {
    call = $.model.complete(progressRequest(cfg, prompt))
  } catch {
    // Threw before any call was made: followCall reads that (null) as a failed note.
  }
  followCall(call, (o) => {
    if (progressFlight === mine) progressFlight = { ...mine, ...o, settled: true }
  })
}

// A call come back: its note written on its turn, a failure recorded, a refused model blocked for the session.
async function settleNote($: EngineInterface, cfg: Config, f: ProgressFlight): Promise<void> {
  const at = await $.clock.now()
  const s = settleFlight(f, await read($, TURN), { cfg, id: decisionId(at), at })
  const progress = s.progress
  if (progress !== null) await update($, TURN, (cur) => (cur !== null && cur.turnId === f.turnId ? { ...cur, progress } : cur))
  if (s.block) await update($, SESSION, (cur) => ({ ...cur, progressBlocked: true }))
  if (s.decision !== null) await record($, s.decision)
}
