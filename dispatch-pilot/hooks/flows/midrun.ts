// The mid-run check (design 5.4): a row read, a checkpoint asked, the shift written, and what follows a checkpoint.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, SessionAppendInput } from 'claude-code'

import { ask } from '../backend.ts'
import type { Config } from '../config.ts'
import { kindOf, rowOf } from '../journal.ts'
import { decisionId } from '../log.ts'
import { applyShift, planRow, settleCheckpoint, withNote } from '../midrun.ts'
import type { Judged, RowPlan } from '../midrun.ts'
import type { ProgressInput } from '../progress.ts'
import { midrunQuestions } from '../questions.ts'
import { awaitCheck, notePlaced } from '../readout.ts'
import { failOpen, ioOf, record, verifies } from '../runtime.ts'
import { emptySession } from '../state.ts'
import { tickProgress } from './progress.ts'

// The state atoms this file reads and writes, one line each and alike in every file that declares them: the module
// scan takes only a const of the file that reads or writes (eval/validate.ts checks the copies are the same text).
const SESSION = atom({ plugin: 'dispatch-pilot', key: 'session' } as const, emptySession())
const TURN = atom({ plugin: 'dispatch-pilot', key: 'turn' } as const, null)

// After a checkpoint was evaluated, whatever came of it (a shift made, a hold, a shift not made, a failed request;
// judged.shift is the shift only when it was made): the one place later parts attach to, the progress note in the
// background and the board's mark on the timeline. Records the decision; a shift made then waits on the check of the
// request that carries it, set once recorded, so a reading cannot amend a Decision not yet in the log. `input`: what
// the progress note is written from (the turn's request and the step the checkpoint judged).
async function afterCheckpoint($: EngineInterface, cfg: Config, judged: Judged, input: ProgressInput): Promise<void> {
  const { decision, shift } = judged
  await record($, decision)
  const turnId = decision.turnId
  if (verifies(cfg) && shift !== null && turnId !== null) {
    await update($, TURN, (cur) => awaitCheck(cur, { turnId, id: decision.id, level: shift.to, queuedNote: shift.queued }))
  }
  if (cfg.progressNote) await failOpen($, 'progress', null, () => tickProgress($, cfg, input))
}

// The mid-run check (design 5.4) on one row, which comes back as it goes on: with a note, or as it came. Main-loop
// rows only, and only while a turn is held, so the turn's own prompt row (which comes before turn.start) is never
// taken for input. What happens is planned in midrun.ts; this reads state, asks, and writes.
export async function onRow($: EngineInterface, cfg: Config, e: SessionAppendInput): Promise<SessionAppendInput> {
  if (e.agentId !== undefined) return e
  const row = rowOf(e)
  const kind = kindOf(row)
  // Most rows (reminders, queue records, notices, a subagent's) change nothing: no state is read for them.
  if (kind === 'other') return e
  const held = await read($, TURN)
  if (held === null) return e
  const session = await read($, SESSION)
  const codeMode = session.codeMode || kind === 'receipt'
  const judging = cfg.enabled && cfg.midrunShift && session.lock === null
  // Planned on what update() reads, so a write in between is built on rather than lost.
  const box: { plan: RowPlan | null } = { plan: null }
  await update($, TURN, (cur) => {
    box.plan = cur !== null && cur.turnId === held.turnId ? planRow(cur, row, kind, { cfg, codeMode, judging }) : null
    // A queued note placed on this row: from the next request on, its level is sent, so its check is due.
    return box.plan === null ? cur : box.plan.note === null ? box.plan.turn : notePlaced(box.plan.turn, box.plan.note)
  })
  const plan = box.plan
  if (plan === null) return e
  if (codeMode && !session.codeMode) await update($, SESSION, (s) => ({ ...s, codeMode: true }))
  if (plan.note !== null) return withNote(e, plan.note)
  if (plan.ask === null) return e
  // The row is held while the question is out: this ask is the only wait here.
  const result = await ask(ioOf($), cfg, { state: plan.ask.state, questions: midrunQuestions() }, cfg.midrunTimeoutMs)
  const at = await $.clock.now()
  const asked = plan.ask.current
  const judged = settleCheckpoint(result, { turn: plan.turn, kind, current: asked, cfg, id: decisionId(at), at })
  const shift = judged.shift
  // Checked again on the turn as it is now (applyShift), and written before the row goes on: the next step reads
  // the level from the turn. Only a shift that was really made gets its note.
  const made = { yes: false }
  if (shift !== null) {
    const locked = (await read($, SESSION)).lock !== null
    await update($, TURN, (cur) => {
      const next = cur !== null && cur.turnId === plan.turn.turnId ? applyShift(cur, shift, { asked, cfg, locked }) : null
      made.yes = next !== null
      return next ?? cur
    })
  }
  const input = { turnId: plan.turn.turnId, request: plan.turn.request, latest: plan.ask.latest }
  await afterCheckpoint($, cfg, { decision: { ...judged.decision, applied: made.yes }, shift: made.yes ? shift : null }, input)
  return made.yes && shift !== null && shift.note !== null ? withNote(e, shift.note) : e
}
