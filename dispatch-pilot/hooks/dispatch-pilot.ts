import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, CommandRunResult, EngineInterface, Register, SessionAppendInput, TurnCompleteInput, TurnStepInput } from 'claude-code'

import { ask, noulOf, scoreOf } from './backend.ts'
import type { AskResult, Io } from './backend.ts'
import { readConfig } from './config.ts'
import type { Config } from './config.ts'
import { agentPlan, readNoul, submitLevel, thresholdsFor } from './decide.ts'
import { kindOf, rowOf } from './journal.ts'
import { isLevel, tierOfModelId } from './levels.ts'
import type { Level, Tier } from './levels.ts'
import { DP_USAGE, RECENT_KEEP, badLevelReply, decisionId, failureText, lockReply, parseDp, pushLog, readLog, renderDp, renderLog, unlockReply } from './log.ts'
import type { Decision } from './log.ts'
import { applyShift, planRow, settleCheckpoint, withNote } from './midrun.ts'
import type { Judged, RowPlan } from './midrun.ts'
import { agentQuestions, midrunQuestions, submitQuestions } from './questions.ts'
import type { Question } from './questions.ts'
import { emptySession, newTurn } from './state.ts'
import type { SessionState, TurnState } from './state.ts'
import { agentState, clip, submitState } from './statebuild.ts'
import type { PreviousTurn } from './statebuild.ts'

// $.state, through the state library: a read of a key never written gives the initial, and update()
// writes with compare-and-set and tries again on a miss. So no key needs initialising: session.start,
// which fires again on every hot reload and plugin enable, only refreshes session.surfaces, and an
// existing session (its lock), turn, recent or skills stays as it was.
const SESSION = atom({ plugin: 'dispatch-pilot', key: 'session' } as const, emptySession())
const TURN = atom({ plugin: 'dispatch-pilot', key: 'turn' } as const, null)
const RECENT = atom({ plugin: 'dispatch-pilot', key: 'recent' } as const, [])

// The agents family (by agentId) is addressed with a literal reference at each read and write, which the module
// scan requires; an agent the mod did not handle at its spawn has no entry.

/** $.store key of the decision log, shared by every session on this machine. */
const LOG = 'log'

/** Where a message a person sent comes from: only these are judged when sent (design 5.3). */
const PERSON: readonly string[] = ['composer', 'sdk', 'bridge']

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
// other. A hot reload starts a new chain; what that costs is at most an entry written in that instant.
let logWrites: Promise<void> = Promise.resolve()

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
  const mine = logWrites.then(() => appendLog($, d))
  logWrites = mine
  await mine
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

// The judgement when a person sends a message. The level itself is settled at the turn's first step,
// which is the first place the session's own effort can be read.
async function judgeMessage($: EngineInterface, cfg: Config, m: { text: string; origin: string | undefined; turnId: string | undefined }): Promise<null> {
  if (!cfg.enabled || !cfg.submitShift || m.origin === undefined || !PERSON.includes(m.origin)) return null
  // A prompt delivered into a running turn starts no turn of its own: the mid-run check covers it.
  if (m.turnId !== undefined) return null
  const text = m.text
  const session = await read($, SESSION)
  if (session.lock !== null) return null
  // Every question this message is asked goes into the one map and the one request; each part then
  // reads the answers it needs from the one result (the effort: open, mechanical, unknown_cause, continues).
  const questions: Record<string, Question> = { ...submitQuestions(session.previous !== null) }
  const state = submitState({ request: text, previous: session.previous })
  const result = await ask(ioOf($), cfg, { state, questions }, cfg.submitTimeoutMs)
  await update($, SESSION, (s) => ({ ...s, pending: { request: text, result } }))
  return null
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

const NO_LEVEL = 'effort 缺省或是数字，没有改'

type Settled = { base: Level | null; wanted: Level | null; decision: Decision }

// What a message's answers make of its turn: the level it starts from, the level the mod wants, and
// the Decision that records both. Pure. `writes`: the mod would write a level (apply mode, no lock).
function settle(
  r: AskResult,
  c: { effort: unknown; previousLevel: Level | null; writes: boolean; turnId: string; id: string; at: number },
): Settled {
  const own = isLevel(c.effort) ? c.effort : null
  const common = { id: c.id, at: c.at, kind: 'submit' as const, backend: r.backend, ms: r.ms, turnId: c.turnId, step: 0, sent: null }
  if (!r.ok) {
    // A failed request changes nothing: the turn runs at the session's own level.
    const decision: Decision = { ...common, model: null, raw: null, from: own, to: own, reason: null, detail: failureText(r), bars: null, failure: r.reason, requestId: r.requestId ?? null, applied: false }
    return { base: own, wanted: null, decision }
  }
  if (own === null) {
    // Answers came, but the step has no level to start from or to replace.
    const decision: Decision = { ...common, model: r.model, raw: r.answers, from: null, to: null, reason: null, detail: NO_LEVEL, bars: null, failure: null, requestId: null, applied: false }
    return { base: null, wanted: null, decision }
  }
  const bars = thresholdsFor(r.backend, r.model, 'submit')
  // "Go on" carries the last turn's level; anything else starts from the session's.
  const continues = readNoul(noulOf(r.answers.continues), bars) === 'yes'
  const base = continues && c.previousLevel !== null ? c.previousLevel : own
  const v = submitLevel(base, { open: scoreOf(r.answers.open), mechanical: noulOf(r.answers.mechanical), unknownCause: noulOf(r.answers.unknown_cause) }, bars)
  const decision: Decision = { ...common, model: r.model, raw: r.answers, from: base, to: v.level, reason: v.reason, detail: '', bars, failure: null, requestId: null, applied: c.writes }
  return { base, wanted: v.level, decision }
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
  const s = settle(pending.result, { effort: e.effort, previousLevel: session.previous?.level ?? null, writes, turnId: e.turnId, id: decisionId(at), at })
  const turn: TurnState = { ...own, base: s.base, wanted: s.wanted }
  await update($, TURN, () => turn)
  await record($, s.decision)
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

/** What a spawn's answers make of the agent: the model to give it, the effort for its steps, and the Decision. */
type Spawned = { model: Tier | null; effort: Level | null; decision: Omit<Decision, 'id' | 'at'> }

// The agent's model and effort from the answers (design 5.5). Pure. `r` is null when nothing was asked. Only the
// model goes into the spawn, and only when the call named none: the plan's tier when it differs from the inherited
// one; without a plan (not asked, or the ask failed) only the fableAgents cap, a configuration rule that holds
// whatever the decision model did. In shadow mode nothing is given, and the Decision records what would have been.
function settleSpawn(r: AskResult | null, c: { cfg: Config; e: AgentSpawnInput; tier: Tier | null; level: Level | null; turn: TurnState | null }): Spawned {
  const { cfg, e, tier, level } = c
  const ok = r !== null && r.ok ? r : null
  const bars = ok === null ? null : thresholdsFor(ok.backend, ok.model, 'agent')
  const a = ok?.answers
  const plan =
    a === undefined || bars === null
      ? null
      : agentPlan(
          { level, tier },
          { open: scoreOf(a.open), mechanical: noulOf(a.mechanical), unknownCause: noulOf(a.unknown_cause), readOnly: noulOf(a.read_only) },
          { agentModels: cfg.agentModels, fableAgents: cfg.fableAgents },
          bars,
        )
  let chosen: Tier | null = null
  if (e.model === undefined) {
    if (plan !== null) chosen = plan.model !== null && plan.model !== tier ? plan.model : null
    else if (tier === 'fable' && !cfg.fableAgents) chosen = 'opus'
  }
  const effort = plan?.effort ?? null
  const applies = cfg.mode === 'apply'
  const failed = r !== null && !r.ok ? r : null
  const decision: Omit<Decision, 'id' | 'at'> = {
    kind: 'agent',
    backend: r?.backend ?? null,
    model: ok?.model ?? null,
    ms: r?.ms ?? 0,
    raw: a ?? null,
    from: `${tier ?? 'inherit'} · ${level ?? '—'}`,
    // The model the agent is given: the mod's alias, else the one the call named, else the parent's.
    to: `${chosen ?? e.model ?? 'inherit'} · ${effort ?? '—'}`,
    reason: plan?.reason ?? null,
    detail: e.subagentType,
    turnId: c.turn?.turnId ?? null,
    step: c.turn?.journal.workSteps ?? null,
    bars,
    failure: failed?.reason ?? null,
    requestId: failed?.requestId ?? null,
    // The model is changed, or an effort will be written on the agent's steps that carry a level.
    applied: applies && (chosen !== null || effort !== null),
    sent: null,
  }
  return { model: applies ? chosen : null, effort: applies ? effort : null, decision }
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

// An agent's branch of turn.step: the effort decided at its spawn, on every step whose effort is a level, unless the
// agent's own definition or call set one. The engine starts the agent inside agent.spawn's next(e), so its first
// step can come before that next has answered with the agentId (measured: usually about 70 ms after, design 9).
// Such a step finds no entry and goes as it came; the entry is written as soon as next answers, and the steps after
// it carry the effort. Nothing is held for it: the step has no tool_use_id to tie it to the spawn waiting.
async function agentStep($: EngineInterface, cfg: Config, e: TurnStepInput, agentId: string): Promise<TurnStepInput> {
  const held = await read($, { plugin: 'dispatch-pilot', key: 'agents', id: agentId } as const)
  if (held === undefined) return e
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
  return writes && explicit !== true && effort !== null ? { ...e, effort } : e
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
// background and the board's mark on the timeline. Records the decision.
async function afterCheckpoint($: EngineInterface, judged: Judged): Promise<void> {
  await record($, judged.decision)
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
    return box.plan?.turn ?? cur
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
  await afterCheckpoint($, { decision: { ...judged.decision, applied: made.yes }, shift: made.yes ? shift : null })
  return made.yes && shift !== null && shift.note !== null ? withNote(e, shift.note) : e
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

  // The person is waiting for the message to go in: the one ask() is the only wait here. The pending
  // decision is written before next(e), inside which the engine starts the message's turn.
  on('prompt.submit', async ($, e, next) => {
    await failOpen($, 'prompt.submit', null, () => judgeMessage($, cfg, { text: e.text, origin: e.origin?.kind, turnId: e.turnId }))
    const r = await next(e)
    if (r.drop !== undefined) await failOpen($, 'prompt.submit', null, () => dropPending($))
    return r
  })

  on('turn.start', async ($, e, next) => {
    await failOpen($, 'turn.start', null, async () => {
      // A subagent's turns are its own: the main loop's turn is not touched by them.
      if (e.agentId !== undefined) return null
      // A decision that stays pending is taken by this turn's first step, once the effort is known.
      return startTurn($, e.turnId, e.text)
    })
    return next(e)
  })

  // The one turn.step hook (no matcher may be registered twice): the main loop's branch, and an agent's (e.agentId set).
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    const out = await failOpen($, 'turn.step', e, () => (agentId === undefined ? mainStep($, cfg, e) : agentStep($, cfg, e, agentId)))
    return yield* next(out)
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
    const out = await failOpen($, 'session.append', e, () => onRow($, cfg, e))
    return next(out)
  })

  on('turn.complete', async ($, e, next) => {
    await failOpen($, 'turn.complete', null, () => endTurn($, e))
    return next(e)
  })
}
