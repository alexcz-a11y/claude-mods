// A message a person sends (design 5.3): its judgement at prompt.submit, its turn, the level its first step takes,
// the main loop's steps, and the turn's end.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, TurnCompleteInput, TurnStepInput } from 'claude-code'

import { ask, canAsk, partOf } from '../backend.ts'
import { takeStep } from '../board/model.ts'
import type { Config } from '../config.ts'
import { isLevel } from '../levels.ts'
import type { Level } from '../levels.ts'
import { decisionId } from '../log.ts'
import { submitQuestions } from '../questions.ts'
import { awaitCheck } from '../readout.ts'
import { failOpen, ioOf, record, redraw, verifies } from '../runtime.ts'
import { stageOne } from '../skills.ts'
import type { SkillOutcome } from '../skills.ts'
import { emptySession, newTurn } from '../state.ts'
import type { SessionState, TurnState } from '../state.ts'
import { clip, submitState } from '../statebuild.ts'
import type { PreviousTurn } from '../statebuild.ts'
import { ownLevel, settleSubmit } from '../submit.ts'
import { holdUnjudged, suggestSkill, takeUnjudged } from './skills.ts'

// The state atoms this file reads and writes, one line each and alike in every file that declares them: the module
// scan takes only a const of the file that reads or writes (eval/validate.ts checks the copies are the same text).
const SESSION = atom({ plugin: 'dispatch-pilot', key: 'session' } as const, emptySession())
const TURN = atom({ plugin: 'dispatch-pilot', key: 'turn' } as const, null)
const SKILLS = atom({ plugin: 'dispatch-pilot', key: 'skills' } as const, [])

/** Where a message a person sent comes from: only these are judged when sent (design 5.3). */
const PERSON: readonly string[] = ['composer', 'sdk', 'bridge']

/** How much of the last answer the next message's judgement sees of it. */
const LAST_REPLY_TOKENS = 300

// The judgement when a person sends a message: the effort questions and the skill questions in one request. The
// effort's level is settled at the turn's first step, the first place the session's own effort can be read; the
// skill is settled here, since its suggestion goes down with the message. Null: nothing was asked.
export async function judgeMessage($: EngineInterface, cfg: Config, m: { text: string; origin: string | undefined; turnId: string | undefined }): Promise<SkillOutcome | null> {
  if (!cfg.enabled || m.origin === undefined || !PERSON.includes(m.origin)) return null
  // A prompt delivered into a running turn starts no turn of its own: the mid-run check covers it.
  if (m.turnId !== undefined) return null
  const text = m.text
  const session = await read($, SESSION)
  // No backend to ask (the chosen one has no key): as with the switch off, nothing is asked and nothing recorded.
  const effortAsked = cfg.submitShift && session.lock === null && canAsk(cfg)
  const skills = cfg.skills && canAsk(cfg) ? await read($, SKILLS) : []
  // No candidate yet (a session's first listing comes after its first message): judged at that listing (final review
  // I4a). Shadow suggests nothing, so it waits for no listing.
  if (cfg.skills && canAsk(cfg) && skills.length === 0 && cfg.mode === 'apply') holdUnjudged(text)
  if (!effortAsked && skills.length === 0) return null
  // Every question this message is asked goes into the one map and the one request; each part then reads the
  // answers it needs (the effort: open, mechanical, unknown_cause, continues; the skill: skill_<n> and the gate).
  const effortQuestions = effortAsked ? submitQuestions(session.previous !== null) : {}
  const skillQuestions = skills.length > 0 ? stageOne(skills, cfg.backend, true) : {}
  const state = submitState({ request: text, previous: session.previous })
  const t0 = await $.clock.now()
  // Read part by part, so an unusable effort part leaves the skill part standing, and the other way round.
  const result = await ask(ioOf($), cfg, { state, questions: { ...effortQuestions, ...skillQuestions }, partial: skills.length > 0 }, cfg.submitTimeoutMs)
  if (effortAsked) {
    const own = partOf(result, Object.keys(effortQuestions))
    await update($, SESSION, (s) => ({ ...s, pending: { request: text, result: own } }))
  }
  if (skills.length === 0) return null
  return suggestSkill($, cfg, { skills, state, first: result, asked: Object.keys(skillQuestions), t0 })
}

// A message that did not go in starts no turn, so its decision goes with it.
export async function dropPending($: EngineInterface): Promise<null> {
  await update($, SESSION, (s) => ({ ...s, pending: null }))
  return null
}

// A main-loop turn begins. The engine starts the turn.start hook inside prompt.submit's next(e), with the text
// prompt.submit passed down (measured on 2.1.327); the hook may finish after next(e) returns, and step 0 waits for it
// (measured on 2.1.328). The pending decision is kept only for the turn its own message starts, and dropped for any
// other.
export async function startTurn($: EngineInterface, turnId: string, text: string): Promise<null> {
  // The board's turn count, on its own: a write that fails must not keep the turn from starting.
  await failOpen($, 'turn.start', null, async () => {
    await update($, SESSION, (s) => ({ ...s, turnNo: s.turnNo + 1 }))
    return null
  })
  const { pending } = await read($, SESSION)
  if (pending !== null && pending.request !== text) {
    // Compared again on what update() reads: a decision for this very text written meanwhile is kept.
    await update($, SESSION, (s) => (s.pending !== null && s.pending.request !== text ? { ...s, pending: null } : s))
  }
  const skillsDue = takeUnjudged(text)
  await update($, TURN, () => ({ ...newTurn(turnId, text), skillsDue }))
  return null
}

// The turn's first step takes the decision its message left, once: it is cleared whatever comes of it.
async function takePending($: EngineInterface, cfg: Config, e: TurnStepInput, session: SessionState, own: TurnState | null): Promise<TurnState | null> {
  const pending = session.pending
  if (pending === null) return own
  await update($, SESSION, (s) => ({ ...s, pending: null }))
  // Only the turn the message started takes its decision; one that cannot be bound to it is dropped.
  if (own === null || own.request !== pending.request) return own
  const at = await $.clock.now()
  const writes = cfg.enabled && cfg.mode === 'apply' && session.lock === null
  const s = settleSubmit(pending.result, { effort: e.effort, previousLevel: session.previous?.level ?? null, writes, turnId: e.turnId, id: decisionId(at), at, bars: cfg.bars.submit })
  // Recorded before the turn names it for a check, so a reading cannot amend a Decision not yet in the log.
  await record($, s.decision)
  const check = verifies(cfg) && s.decision.applied && s.wanted !== null ? { turnId: e.turnId, id: s.decision.id, level: s.wanted, queuedNote: null } : null
  // Built on the turn as it is now: record() has just left the decision's mark on it for the step's cell.
  const written = await update($, TURN, (cur) => {
    if (cur === null || cur.turnId !== own.turnId) return cur
    const settled: TurnState = { ...cur, base: s.base, wanted: s.wanted }
    return check === null ? settled : awaitCheck(settled, check)
  })
  return written !== null && written.turnId === own.turnId ? written : own
}

// A turn no message decision set (a task notification's, a peer's, submitShift off) starts from the engine's own
// level at step 0, so the mid-run check has a level to judge. Nothing is decided here: wanted stays null, no Decision.
async function takeBase($: EngineInterface, turn: TurnState, level: Level): Promise<TurnState> {
  await update($, TURN, (cur) => (cur !== null && cur.turnId === turn.turnId && cur.base === null ? { ...cur, base: level } : cur))
  return { ...turn, base: level }
}

// The main loop's branch of turn.step. Returns the step as it goes on.
export async function mainStep($: EngineInterface, cfg: Config, e: TurnStepInput): Promise<TurnStepInput> {
  const session = await read($, SESSION)
  const engineLevel = e.effort
  // The engine's own level, before the mod writes any: the board shows it between turns; and whether the session is
  // on numeric effort, which the board names (it judges no level then). Failing alone, as the cell does.
  const numeric = typeof engineLevel === 'number'
  const level = isLevel(engineLevel) ? engineLevel : session.sessionLevel
  if (session.sessionLevel !== level || session.effortIsNumber !== numeric) {
    await failOpen($, 'turn.step', null, async () => {
      await update($, SESSION, (s) => ({ ...s, sessionLevel: level, effortIsNumber: numeric }))
      return null
    })
  }
  const held = await read($, TURN)
  let turn = held !== null && held.turnId === e.turnId ? held : null
  // takePending hands back the turn it wrote, so nothing is read back.
  if (e.index === 0) turn = await takePending($, cfg, e, session, turn)
  if (e.index === 0 && turn !== null && turn.base === null && isLevel(e.effort)) turn = await takeBase($, turn, e.effort)
  const out = stepOut(cfg, session, turn, e)
  if (turn !== null) {
    const stepped = turn
    const level = isLevel(out.effort) ? out.effort : null
    // The board's count of work steps and its cell: a write that fails costs the board, never the step.
    await failOpen($, 'turn.step', null, async () => {
      if (takeStep(stepped, level) === stepped) return null
      await update($, TURN, (cur) => (cur !== null && cur.turnId === stepped.turnId ? takeStep(cur, level) : cur))
      await redraw($)
      return null
    })
  }
  return out
}

// The step as it goes on, at ownLevel's level. A step whose effort is absent (the model takes none) or a number (the
// session uses numeric effort) passes as it came; so does every step the mod writes nothing on (off, only watching, or
// nothing decided).
function stepOut(cfg: Config, session: SessionState, turn: TurnState | null, e: TurnStepInput): TurnStepInput {
  // Only effort is written: the main loop's model is never changed (it would break the prompt cache).
  const level = ownLevel(cfg, session, turn)
  return !isLevel(e.effort) || level === null ? e : { ...e, effort: level }
}

function endedOf(e: { reason: string; isAborted: boolean }): PreviousTurn['ended'] {
  if (e.isAborted || e.reason === 'aborted') return 'interrupted'
  return e.reason === 'answer' ? 'answered' : 'error'
}

// A main-loop turn ends. Only the turn held here ends here: the end of one never seen starting (or with none held)
// writes no previous and keeps the held turn.
export async function endTurn($: EngineInterface, e: TurnCompleteInput): Promise<null> {
  if (e.agentId !== undefined) return null
  const held = await read($, TURN)
  if (held === null || held.turnId !== e.turnId) return null
  const previous: PreviousTurn = {
    request: held.request,
    lastReply: clip(e.answer, LAST_REPLY_TOKENS),
    ended: endedOf(e),
    level: held.wanted ?? held.base,
  }
  // The board's 此前 between turns: this turn's last evaluation, or an older one when this turn had none.
  const judged = held.lastJudged
  await update($, SESSION, (s) => ({ ...s, previous, lastJudged: judged ?? s.lastJudged }))
  await update($, TURN, (cur) => (cur !== null && cur.turnId === e.turnId ? null : cur))
  // The board folds to its one row between turns.
  await redraw($)
  return null
}
