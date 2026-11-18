import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, CommandRunResult, EngineInterface, HttpInit, ModelCompleteResult, PromptAttachmentResult, Register, SessionAppendInput, TurnCompleteInput, TurnStepInput } from 'claude-code'

import { settleSpawn } from './agents.ts'
import type { Spawned } from './agents.ts'
import { ask, canAsk, partOf } from './backend.ts'
import type { AskResult, Io } from './backend.ts'
import { readConfig } from './config.ts'
import type { Config } from './config.ts'
import { kindOf, rowOf } from './journal.ts'
import { isLevel, tierOfModelId } from './levels.ts'
import type { Level } from './levels.ts'
import { DP_USAGE, RECENT_KEEP, badLevelReply, decisionId, lockReply, parseDp, pushLog, readLog, renderDp, renderLog, unlockReply } from './log.ts'
import type { Decision } from './log.ts'
import { applyShift, planRow, settleCheckpoint, withNote } from './midrun.ts'
import type { Judged, RowPlan } from './midrun.ts'
import { followCall, nextFlight, progressPrompt, progressRequest, settleFlight } from './progress.ts'
import type { ProgressFlight, ProgressInput } from './progress.ts'
import { agentQuestions, midrunQuestions, submitQuestions } from './questions.ts'
import { agentSent, awaitCheck, classify, clearCheck, modelBase, notePlaced, settleReading, withSent } from './readout.ts'
import type { OpenStep, Reading } from './readout.ts'
import { emptySession, newTurn } from './state.ts'
import type { AgentState, SessionState, TurnState } from './state.ts'
import { agentState, clip, submitState } from './statebuild.ts'
import type { PreviousTurn } from './statebuild.ts'
import {
  LISTING_NOTE,
  NO_CANDIDATES_REPLY,
  SEARCH_OFF_REPLY,
  SECOND_LATE,
  SECOND_MIN_MS,
  findSkillReply,
  isFindSkill,
  mergeSkills,
  parseListing,
  pickMany,
  queryOf,
  readStageOne,
  readStageTwo,
  shortlist,
  skillDecision,
  stageOne,
  stageTwo,
  suggestionBlock,
} from './skills.ts'
import type { Skill, SkillOutcome } from './skills.ts'
import { settleSubmit } from './submit.ts'

// $.state, through the state library: a read of a key never written gives the initial, and update()
// writes with compare-and-set and tries again on a miss. So no key needs initialising: session.start,
// which fires again on every hot reload and plugin enable, only refreshes session.surfaces, and an
// existing session (its lock), turn, recent or skills stays as it was.
const SESSION = atom({ plugin: 'dispatch-pilot', key: 'session' } as const, emptySession())
const TURN = atom({ plugin: 'dispatch-pilot', key: 'turn' } as const, null)
const RECENT = atom({ plugin: 'dispatch-pilot', key: 'recent' } as const, [])
const SKILLS = atom({ plugin: 'dispatch-pilot', key: 'skills' } as const, [])

// The agents family (by agentId) is addressed with a literal reference at each read and write, which the module
// scan requires; an agent the mod did not handle at its spawn has no entry.

/** $.store key of the decision log, shared by every session on this machine. */
const LOG = 'log'

/** Where a message a person sent comes from: only these are judged when sent (design 5.3). */
const PERSON: readonly string[] = ['composer', 'sdk', 'bridge']

/** Whether the readout runs (design 5.12): verifyEffort on, and the mod enabled (controller ruling: off, it does nothing at all). */
function verifies(cfg: Config): boolean {
  return cfg.enabled && cfg.verifyEffort
}

/** How much of the last answer the next message's judgement sees of it. */
const LAST_REPLY_TOKENS = 300

// One line in the debug log for an error the mod swallowed: the hook and the error's message, never
// state or message content. A log call that throws itself is swallowed too.
function trace($: EngineInterface, hook: string, err: unknown): void {
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
async function failOpen<T>($: EngineInterface, hook: string, unchanged: T, decide: () => Promise<T>): Promise<T> {
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

/** Appends a decision to $.store's log and to this session's recent. Never throws. */
export async function record($: EngineInterface, d: Decision): Promise<void> {
  // Each write fails on its own: losing one copy must not lose the other.
  try {
    await update($, RECENT, (list) => pushLog(list, d, RECENT_KEEP))
  } catch (err) {
    trace($, 'record', err)
  }
  await inOrder(() => appendLog($, d))
}

async function storeSent($: EngineInterface, id: string, sent: Decision['sent']): Promise<void> {
  try {
    const next = withSent(readLog(await $.store.get(LOG)), id, sent)
    if (next !== null) await $.store.set(LOG, next)
  } catch (err) {
    trace($, 'amend', err)
  }
}

/** Writes a recorded Decision's sent, in recent and in $.store's log (after every record queued before it); withSent says when. Never throws. */
async function amendSent($: EngineInterface, id: string, sent: Decision['sent']): Promise<void> {
  try {
    // Read first: update() writes whatever its callback returns, and a repeated unsure reading changes nothing.
    if (withSent(await read($, RECENT), id, sent) !== null) await update($, RECENT, (list) => withSent(list, id, sent) ?? list)
  } catch (err) {
    trace($, 'amend', err)
  }
  await inOrder(() => storeSent($, id, sent))
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

// The judgement when a person sends a message: the effort questions and the skill questions in one request. The
// effort's level is settled at the turn's first step, the first place the session's own effort can be read; the
// skill is settled here, since its suggestion goes down with the message. Null: nothing was asked.
async function judgeMessage($: EngineInterface, cfg: Config, m: { text: string; origin: string | undefined; turnId: string | undefined }): Promise<SkillOutcome | null> {
  if (!cfg.enabled || m.origin === undefined || !PERSON.includes(m.origin)) return null
  // A prompt delivered into a running turn starts no turn of its own: the mid-run check covers it.
  if (m.turnId !== undefined) return null
  const text = m.text
  const session = await read($, SESSION)
  const effortAsked = cfg.submitShift && session.lock === null
  const skills = cfg.skills && canAsk(cfg) ? await read($, SKILLS) : []
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

// The second request, on the shortlist, with what is left of submitTimeoutMs.
async function suggestSkill($: EngineInterface, cfg: Config, c: { skills: Skill[]; state: unknown; first: AskResult; asked: string[]; t0: number }): Promise<SkillOutcome> {
  const none = { first: c.first, asked: c.asked, second: null, skill: null }
  const one = readStageOne(c.skills, c.first, true)
  if ('detail' in one) return { ...none, detail: one.detail }
  const left = cfg.submitTimeoutMs - ((await $.clock.now()) - c.t0)
  if (left < SECOND_MIN_MS) return { ...none, detail: SECOND_LATE }
  const second = await ask(ioOf($), cfg, { state: c.state, questions: stageTwo(one.short, cfg.backend) }, left)
  return { ...none, second, ...readStageTwo(one.short, second) }
}

// A message's skill judgement, from its prompt.submit to the turn.start its next(e) raises with the same text, where
// the turn's id is known (prompt.submit's own reads cannot see that turn: one dispatch reads one moment). The Decision
// is recorded there, or after next(e) with no turn when none started. Module level: a hot reload in between loses
// that one Decision.
let skillOut: { text: string; outcome: SkillOutcome; applied: boolean } | null = null

async function recordSkill($: EngineInterface, o: SkillOutcome, c: { turnId: string | null; applied: boolean }): Promise<null> {
  const at = await $.clock.now()
  await record($, skillDecision(o, { id: decisionId(at), at, turnId: c.turnId, applied: c.applied }))
  return null
}

// The main loop's skill listing: its skills are kept as the candidates, and the main agent reads LISTING_NOTE instead.
// Null: the listing is left as it came.
async function foldListing($: EngineInterface, text: string): Promise<PromptAttachmentResult | null> {
  const listed = parseListing(text)
  if (listed.length === 0) return null
  // A later listing is a delta (a skill added mid-session): merged into the candidates, never replacing them.
  await update($, SKILLS, (held) => mergeSkills(held, listed))
  return { text: LISTING_NOTE }
}

// find-skill: the same two requests on a few words of the agent's, without the gate (the agent is already asking for
// a skill), answering with every skill that fits, at most three.
async function findSkill($: EngineInterface, cfg: Config, text: string): Promise<string> {
  const query = queryOf(text)
  if (query === '') return findSkillReply('', [], null)
  const skills = await read($, SKILLS)
  if (skills.length === 0) return NO_CANDIDATES_REPLY
  const state = submitState({ request: query, previous: null })
  const t0 = await $.clock.now()
  // A single candidate on Jev has no choice to ask: it is the shortlist without a first request.
  const questions = stageOne(skills, cfg.backend, false)
  const first: AskResult | null = Object.keys(questions).length === 0 ? null : await ask(ioOf($), cfg, { state, questions }, cfg.submitTimeoutMs)
  if (first !== null && !first.ok) return findSkillReply(query, [], first.reason)
  const short = shortlist(skills, first?.answers ?? {})
  if (short.length === 0) return findSkillReply(query, [], null)
  const left = cfg.submitTimeoutMs - ((await $.clock.now()) - t0)
  if (left < SECOND_MIN_MS) return findSkillReply(query, [], 'timeout')
  const second = await ask(ioOf($), cfg, { state, questions: stageTwo(short, cfg.backend) }, left)
  return second.ok ? findSkillReply(query, pickMany(short, second.answers), null) : findSkillReply(query, [], second.reason)
}

// A message that did not go in starts no turn, so its decision goes with it.
async function dropPending($: EngineInterface): Promise<null> {
  await update($, SESSION, (s) => ({ ...s, pending: null }))
  return null
}

// A main-loop turn begins. The engine raises turn.start inside prompt.submit's next(e), with the text
// prompt.submit passed down (measured on 2.1.327): the pending decision is kept only for the turn its own
// message starts, and dropped for any other.
async function startTurn($: EngineInterface, turnId: string, text: string): Promise<null> {
  const { pending } = await read($, SESSION)
  if (pending !== null && pending.request !== text) {
    // Compared again on what update() reads: a decision for this very text written meanwhile is kept.
    await update($, SESSION, (s) => (s.pending !== null && s.pending.request !== text ? { ...s, pending: null } : s))
  }
  await update($, TURN, () => newTurn(turnId, text))
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
  const s = settleSubmit(pending.result, { effort: e.effort, previousLevel: session.previous?.level ?? null, writes, turnId: e.turnId, id: decisionId(at), at })
  // Recorded before the turn names it for a check, so a reading cannot amend a Decision not yet in the log.
  await record($, s.decision)
  const settled: TurnState = { ...own, base: s.base, wanted: s.wanted }
  const check = verifies(cfg) && s.decision.applied && s.wanted !== null ? { turnId: e.turnId, id: s.decision.id, level: s.wanted, queuedNote: null } : null
  const turn = check === null ? settled : awaitCheck(settled, check)
  await update($, TURN, () => turn)
  return turn
}

// A turn no message decision set (a task notification's, a peer's, submitShift off) starts from the engine's own
// level at step 0, so the mid-run check has a level to judge. Nothing is decided here: wanted stays null, no Decision.
async function takeBase($: EngineInterface, turn: TurnState, level: Level): Promise<TurnState> {
  await update($, TURN, (cur) => (cur !== null && cur.turnId === turn.turnId && cur.base === null ? { ...cur, base: level } : cur))
  return { ...turn, base: level }
}

// The main loop's branch of turn.step. Returns the step as it goes on.
async function mainStep($: EngineInterface, cfg: Config, e: TurnStepInput): Promise<TurnStepInput> {
  const session = await read($, SESSION)
  const held = await read($, TURN)
  let turn = held !== null && held.turnId === e.turnId ? held : null
  // takePending hands back the turn it wrote, so nothing is read back.
  if (e.index === 0) turn = await takePending($, cfg, e, session, turn)
  if (e.index === 0 && turn !== null && turn.base === null && isLevel(e.effort)) turn = await takeBase($, turn, e.effort)
  // A step whose effort is absent (the model takes none) or a number (the session uses numeric
  // effort) passes as it came; so does every step while the mod is off or only watching.
  if (!isLevel(e.effort) || !cfg.enabled || cfg.mode === 'shadow') return e
  // Only effort is written: the main loop's model is never changed (it would break the prompt cache).
  const level = session.lock ?? turn?.wanted ?? null
  return level === null ? e : { ...e, effort: level }
}

function endedOf(e: { reason: string; isAborted: boolean }): PreviousTurn['ended'] {
  if (e.isAborted || e.reason === 'aborted') return 'interrupted'
  return e.reason === 'answer' ? 'answered' : 'error'
}

// The judgement when an agent is dispatched (design 5.5): the hook waits here for the answer, up to agentTimeoutMs.
// Null: an agent this mod leaves alone. A resumed run keeps what it had, a fork shares the parent's prompt cache
// (another model would lose it), and a workflow's script decides its own agents.
async function planSpawn($: EngineInterface, cfg: Config, e: AgentSpawnInput): Promise<Spawned | null> {
  if (!cfg.enabled || e.resume !== undefined || e.fork || e.workflow !== undefined) return null
  const session = await read($, SESSION)
  const turn = await read($, TURN)
  // What the agent inherits: the main turn's level and the parent's tier (null for an id that names no family,
  // such as opusplan: then the model is never changed).
  const level = turn?.wanted ?? turn?.base ?? null
  const tier = tierOfModelId(e.parentModel)
  const asking = cfg.agentShift && session.lock === null
  const state = agentState({ task: e.prompt, agentType: e.subagentType, description: e.description })
  const r = asking ? await ask(ioOf($), cfg, { state, questions: agentQuestions() }, cfg.agentTimeoutMs) : null
  return settleSpawn(r, { cfg, e, tier, level, turn })
}

// The spawn started an agent: its entry (an effort of null: not handled, its steps are left alone) and the Decision.
// Every spawn keeps its own values here and writes its own key; record() serialises the shared log, so spawns in
// flight at once do not mix.
async function keepAgent($: EngineInterface, s: Spawned, agentId: string): Promise<null> {
  const at = await $.clock.now()
  const id = decisionId(at)
  await update($, { plugin: 'dispatch-pilot', key: 'agents', id: agentId } as const, () => ({ effort: s.effort, isEffortExplicit: null, decisionId: id, steps: 0 }))
  await record($, { ...s.decision, id, at })
  return null
}

/** A step as it goes on, and the agent whose check is due beside it (null: none). */
type Stepped = { step: TurnStepInput; check: AgentState | null }

// An agent's branch of turn.step: the effort decided at its spawn, on every step whose effort is a level, unless the
// agent's own definition or call set one. The engine starts the agent inside agent.spawn's next(e), so its first
// step can come before that next has answered with the agentId (measured: usually about 70 ms after, design 9).
// Such a step finds no entry and goes as it came; the entry is written as soon as next answers, and the steps after
// it carry the effort. Nothing is held for it: the step has no tool_use_id to tie it to the spawn waiting.
async function agentStep($: EngineInterface, cfg: Config, e: TurnStepInput, agentId: string): Promise<Stepped> {
  const held = await read($, { plugin: 'dispatch-pilot', key: 'agents', id: agentId } as const)
  if (held === undefined) return { step: e, check: null }
  // At the second step the mod saw, the first one's request is the agent's last: the check is due, beside this step.
  const check = verifies(cfg) && held.steps === 1 ? held : null
  const effort = held.effort
  const writes = cfg.enabled && cfg.mode === 'apply' && effort !== null && isLevel(e.effort)
  let explicit = held.isEffortExplicit
  if (writes && explicit === null) {
    // Once per agent: what the list says does not change for it. An agent the list does not show counts as not explicit.
    const listed = (await $.agent.list()).find((a) => a.id === agentId)
    explicit = listed?.effort !== undefined
  }
  await update($, { plugin: 'dispatch-pilot', key: 'agents', id: agentId } as const, (cur) => {
    const was = cur ?? held
    return { ...was, steps: was.steps + 1, isEffortExplicit: was.isEffortExplicit ?? explicit }
  })
  return { step: writes && explicit !== true && effort !== null ? { ...e, effort } : e, check }
}

// An agent's check (design 5.12): $.agent.list()'s lastRequest, the documented reading, read once after the first step
// the mod saw, against the effort decided at its spawn. A spawn that decided no effort (shadow, a failed ask) is not checked.
async function checkAgent($: EngineInterface, agentId: string, held: AgentState): Promise<null> {
  const { effort, decisionId: id } = held
  if (effort === null || id === null) return null
  const listed = (await $.agent.list()).find((a) => a.id === agentId)
  await amendSent($, id, agentSent(effort, listed?.lastRequest))
  return null
}

// An agent that ends after the one step the mod saw is checked at its turn.complete: no second step comes to do it.
async function endAgent($: EngineInterface, agentId: string): Promise<null> {
  const held = await read($, { plugin: 'dispatch-pilot', key: 'agents', id: agentId } as const)
  return held !== undefined && held.steps === 1 ? checkAgent($, agentId, held) : null
}

// A main-loop turn ends. Only the turn held here ends here: the end of one never seen starting (or with none held)
// writes no previous and keeps the held turn.
async function endTurn($: EngineInterface, e: TurnCompleteInput): Promise<null> {
  if (e.agentId !== undefined) return null
  const held = await read($, TURN)
  if (held === null || held.turnId !== e.turnId) return null
  const previous: PreviousTurn = {
    request: held.request,
    lastReply: clip(e.answer, LAST_REPLY_TOKENS),
    ended: endedOf(e),
    level: held.wanted ?? held.base,
  }
  await update($, SESSION, (s) => ({ ...s, previous }))
  await update($, TURN, (cur) => (cur !== null && cur.turnId === e.turnId ? null : cur))
  return null
}

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

// The progress note's call (design 5.13): in the air, or come back and not yet read. Module level, because the call's
// .then writes here and nowhere else: the hook that started it has ended, so $ is not its to use. A hot reload loses
// it; that costs one note (the next checkpoint asks with the older one), or one failure left unrecorded.
let progressFlight: ProgressFlight | null = null
// The newest checkpoint's input, waiting for the call in the air. Module level: a hot reload costs one note.
let progressQueued: ProgressInput | null = null

// The progress note's turn, after a checkpoint (fresh: its input) or on a main-loop row once the call has come back
// (fresh null): a call come back is read into the turn, then the next call starts or the input waits behind one.
async function tickProgress($: EngineInterface, cfg: Config, fresh: ProgressInput | null): Promise<null> {
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

// The mid-run check (design 5.4) on one row, which comes back as it goes on: with a note, or as it came. Main-loop
// rows only, and only while a turn is held, so the turn's own prompt row (which comes before turn.start) is never
// taken for input. What happens is planned in midrun.ts; this reads state, asks, and writes.
async function onRow($: EngineInterface, cfg: Config, e: SessionAppendInput): Promise<SessionAppendInput> {
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
async function keepReading($: EngineInterface, r: Reading, open: OpenStep | null): Promise<null> {
  if (r.kind === 'main') {
    const effort = r.effort
    await failOpen($, 'http.fetch', null, () => keepLevel($, effort))
  }
  await failOpen($, 'http.fetch', null, () => settleCheck($, r, open))
  return null
}

async function keepLevel($: EngineInterface, effort: Level | null): Promise<null> {
  if ((await read($, SESSION)).lastSent !== effort) await update($, SESSION, (s) => ({ ...s, lastSent: effort }))
  return null
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

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    await failOpen($, 'session.start', null, async () => {
      await $.command.register({
        name: 'dp',
        description: 'dispatch-pilot：档位、锁定、后端和最近的决策（lock <档位>、unlock、log [n]）',
        argumentHint: '[lock <档位> | unlock | log [n]]',
      })
      return null
    })
    await failOpen($, 'session.start', null, async () => {
      const surfaces = [...(await $.session.surfaces())]
      // Only the surfaces are refreshed: a reload keeps the lock and everything else.
      await update($, SESSION, (s) => ({ ...s, surfaces }))
      return null
    })
    return next(e)
  })

  on('command.run', { command: 'dp' }, async ($, e, next) => {
    const answer = await failOpen($, 'command.run', null, () => answerDp($, cfg, e.args))
    return answer ?? next(e)
  })

  // The person is waiting for the message to go in: the asks are the only wait here. The pending decision is
  // written before next(e), inside which the engine starts the message's turn; a suggestion goes down as context.
  on('prompt.submit', async ($, e, next) => {
    const skill = await failOpen($, 'prompt.submit', null, () => judgeMessage($, cfg, { text: e.text, origin: e.origin?.kind, turnId: e.turnId }))
    const block = skill?.skill && cfg.mode === 'apply' ? suggestionBlock(skill.skill) : null
    if (skill !== null) skillOut = { text: e.text, outcome: skill, applied: block !== null }
    const r = await next(block === null ? e : { ...e, context: [...(e.context ?? []), block] })
    if (r.drop !== undefined) await failOpen($, 'prompt.submit', null, () => dropPending($))
    // Still here: no turn started with it (a drop, or the engine started none inside next).
    if (skill !== null && skillOut?.outcome === skill) {
      skillOut = null
      await failOpen($, 'prompt.submit', null, () => recordSkill($, skill, { turnId: null, applied: false }))
    }
    return r
  })

  // Answered on the way back: what the engine rendered is what is parsed. A subagent keeps its listing whole.
  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const r = await next(e)
    const text = r.text
    if (e.agentId !== undefined || !cfg.enabled || !cfg.skills || cfg.mode === 'shadow' || !canAsk(cfg) || text === null) return r
    return (await failOpen($, 'prompt.attachment', null, () => foldListing($, text))) ?? r
  })

  on('skill.prompt', { skill: /(^|:)find-skill$/ }, async ($, e, next) => {
    if (!isFindSkill(e)) return next(e)
    // The listing was left whole in these cases: the body ("Query: …") would tell the agent nothing.
    if (!cfg.enabled || !cfg.skills || cfg.mode === 'shadow') return { text: SEARCH_OFF_REPLY }
    const text = await failOpen($, 'skill.prompt', null, () => findSkill($, cfg, e.text))
    return text === null ? next(e) : { text }
  })

  on('turn.start', async ($, e, next) => {
    // A new main-loop turn: no input of the last one waits for a progress note (a call still in the air is kept, and
    // dropped when it comes back).
    if (e.agentId === undefined) progressQueued = null
    await failOpen($, 'turn.start', null, async () => {
      // A subagent's turns are its own: the main loop's turn is not touched by them.
      if (e.agentId !== undefined) return null
      // A decision that stays pending is taken by this turn's first step, once the effort is known.
      return startTurn($, e.turnId, e.text)
    })
    const mine = e.agentId === undefined && skillOut !== null && skillOut.text === e.text ? skillOut : null
    if (mine !== null) {
      skillOut = null
      await failOpen($, 'turn.start', null, () => recordSkill($, mine.outcome, { turnId: e.turnId, applied: mine.applied }))
    }
    return next(e)
  })

  // The one turn.step hook (no matcher may be registered twice): the main loop's branch, and an agent's (e.agentId set).
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    const plan = await failOpen<Stepped>($, 'turn.step', { step: e, check: null }, async () => (agentId === undefined ? { step: await mainStep($, cfg, e), check: null } : agentStep($, cfg, e, agentId)))
    // An agent's check runs beside its step, which does not wait for it; the hook returns once both are done.
    const held = plan.check
    const checking = held !== null && agentId !== undefined ? failOpen($, 'turn.step', null, () => checkAgent($, agentId, held)) : null
    // Open for the readout while the step's request may go.
    const close = verifies(cfg) ? openStep(plan.step) : null
    try {
      return yield* next(plan.step)
    } finally {
      close?.()
      if (checking !== null) await checking
    }
  })

  // The judgement waits before next(e); the agent's entry and the Decision are written once next has answered with
  // the started agent's id. A refused spawn, or one that started no local agent, keeps nothing.
  on('agent.spawn', async ($, e, next) => {
    const plan = await failOpen($, 'agent.spawn', null, () => planSpawn($, cfg, e))
    const r = await next(plan === null || plan.model === null ? e : { ...e, model: plan.model })
    const agentId = r.deny === undefined ? r.agentId : undefined
    if (plan !== null && agentId !== undefined) await failOpen($, 'agent.spawn', null, () => keepAgent($, plan, agentId))
    return r
  })

  // Each row is held here until the hook passes it on; at a checkpoint, for as long as the question is out.
  on('session.append', async ($, e, next) => {
    // A progress note come back is read before the row, so a checkpoint on this very row asks with the newest one.
    if (e.agentId === undefined && progressFlight !== null && progressFlight.settled) await failOpen($, 'progress', null, () => tickProgress($, cfg, null))
    const out = await failOpen($, 'session.append', e, () => onRow($, cfg, e))
    return next(out)
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    // The main loop's turn ends: no input of it waits for a progress note any more.
    if (agentId === undefined) progressQueued = null
    await failOpen($, 'turn.complete', null, () => (agentId !== undefined && verifies(cfg) ? endAgent($, agentId) : endTurn($, e)))
    return next(e)
  })

  // Every request the engine and the plugins send passes here. Each goes on as it came; the readout is written beside
  // it (design 5.12). Not registered at all while the readout is off (verifyEffort, or the mod, off).
  if (verifies(cfg)) {
    on('http.fetch', async ($, e, next) => {
      const keeping = readout($, e, next.origin.plugin)
      try {
        return await next(e)
      } finally {
        if (keeping !== null) await keeping
      }
    })
  }
}
