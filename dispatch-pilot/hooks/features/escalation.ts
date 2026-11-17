// Feature: a loop whose tool calls keep failing (#7, ADR 0013).
//
// Every tool call of the main agent and of the agents it dispatches is told
// apart as it ends (decision/escalation.ts `outcomeOf`; the calls a PreToolUse
// settings hook refused are known by core/outcomes.ts), and each loop's calls
// are counted here, in one record (`escalation`): a call the person refused is
// no failure, one a hook blocked counts toward escalating only with
// `hook-block-failures` on.
//
// The counts ask the decision model nothing:
//   - a dispatched agent whose counted failures reach `escalateAfter` for the
//     first time has its effort raised one level, to max at most (ADR 0020, ADR 0022;
//     Anthropic: "Raise effort before you change models", and a new model
//     costs the agent its cache): a note goes on the row of its next tool
//     result (core/notes.ts, ADR 0029), since a model takes a new level only at
//     a step with input, and its plan is written once that row is stored with
//     the note. Not when the person
//     named its effort, not for a Workflow's agent (short, and dispatched many
//     at once at one level), and not with `midrun-effort` off.
//   - after that, or where the effort cannot go up, a dispatched agent (a plain
//     one or a Workflow's) whose counted failures reach `escalateAfter` goes on
//     as the next model up (decision/escalation.ts `stepUp`: haiku to
//     `escalateHaikuTo`, then opus, fable only with `agentFable`), written into
//     its plan at once, so the core's step writer names it from the agent's
//     next step on; at most `escalateLimit` times a run, never past a model the
//     person named. The counts start over after either, and after a step-up
//     that could not be made; with no step-up left and no level left to go up
//     to, they run on and nothing more is raised.
//   - where the model cannot go up (its step-ups are used up, it is on the top
//     model, the person named it), the effort goes up another level instead,
//     as the main agent's does, to max. With `escalateLimit` 0 that is all a
//     failing agent gets: its model is never changed once it is dispatched.
//   - with `escalateAfter` 0 the failures raise nothing: they are counted and
//     shown as before, no agent's effort or model goes up, and no turn of the
//     main agent's counts as stuck.
//   - the main agent's turn keeps its facts (the effort its steps went out at,
//     its calls, failures and hook blocks, the last error lines); when a turn
//     the person's own message started ends, they go on its turn record
//     (`facts`) for the next message's decision.

import type { EngineInterface, On, TurnStepInput } from 'claude-code'
import { bridgeStart, hasExtras, type HookGiven } from '../core/bridge.ts'
import { callsEnded } from '../core/calls.ts'
import { carriedByRequest, holdsNote, withNote } from '../core/notes.ts'
import { errorText } from '../decision/backend.ts'
import { blockedByHookText, briefOf, errorLine, outcomeOf, rowsFromTranscript, stepUp, withError, type StepUpSettings, type TranscriptRow, type TurnFacts } from '../decision/escalation.ts'
import { EFFORTS, isEffort, type Effort } from '../decision/effort.ts'
import { switchNote } from '../decision/midrun.ts'
import { quoteStart } from '../decision/redact.ts'
import { wasBlocked } from '../core/outcomes.ts'
import { MAIN, planStep, replace, turnKey, update, type AgentPlan, type Cell, type TurnRecord } from '../core/plans.ts'
import { report, type Decided, type ReportIo } from '../core/report.ts'
import type { Ctx } from '../core/setup.ts'
import { defineSwitch, isOn, masterOn } from '../core/switches.ts'
import { MIDRUN_SWITCH } from './midrun-effort.ts'

const ESCALATION = { plugin: 'dispatch-pilot', key: 'escalation' } as const
const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const
const AGENTS = { plugin: 'dispatch-pilot', key: 'agents' } as const
const LOCK = { plugin: 'dispatch-pilot', key: 'lock' } as const
const LAST_TURN = { plugin: 'dispatch-pilot', key: 'lastTurn' } as const
const RUNS = { plugin: 'dispatch-pilot', key: 'workflowRuns' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

/** At most this many Workflow runs' directories are kept. */
const MAX_RUNS = 8

/**
 * The agents whose effort is to go up, by agent id: each waits for the row of its next tool result, which takes the note
 * (the `session.append` hook below), and its plan is written once that row is stored with it. A module variable
 * (CLAUDE.md): a hot reload loses a raise that waited, and the agent goes on at its level until its failures reach the
 * bar again. At most MAX_WAITING are kept, the oldest dropped first (an agent that ended before another result came).
 */
const waitingRaises = new Map<string, WaitingRaise>()
const MAX_WAITING = 64

/** A raise that waits: the levels, the model the agent is on, and what its decision is about (the failures that reached the bar). */
type WaitingRaise = { from: Effort; to: Effort; model: string; about: string; reached: number; /** A row has taken the note and is being stored. */ onRow?: true }

/** The feature's switch (`/dp escalation on|off`). */
const SWITCH = 'escalation'
/** Whether a call one of the person's hooks blocked counts as a failure (`/dp hook-block-failures on|off`); off by default. */
const BLOCKS_SWITCH = 'hook-block-failures'

/** One loop's tool calls and step-ups (`escalation` in types/index.d.ts): the main agent's for one turn, an agent's for its run. */
type LoopRecord = {
  /** The main turn the counts belong to; '' for an agent. */
  turnId: string
  /** Tool calls that ended since the loop began (a plugin's refusal not counted); only the main agent's are all counted. */
  calls: number
  /** Calls that failed, and calls a hook refused, since the loop began. */
  failures: number
  hookBlocks: number
  /** The counts when they last started over: what is counted is the rest. */
  base: Counted
  /** An agent's step-ups so far (one that could not be made is not one). */
  raises: number
  /** The loop's latest step, and the model the engine named on it: where an agent's step-up starts when its plan names none. */
  step: number | null
  model: string | null
  /** The effort the loop's latest step went out at, as the core sends it; null for none. */
  effort: Effort | null
  /** An agent's: times its failures raised its effort instead of its model (the effort goes first; again where the model cannot go up), and the step it was last raised in. */
  effortRaises?: number
  effortStep?: number | null
  /** An agent's: the step its model was last stepped up in. */
  raiseStep?: number | null
  /** The main agent's: the last failed or blocked calls, at most two (decision/escalation.ts `errorLine`). */
  errors: string[]
  /** The escalation switch was off when the loop was last seen: what was counted meanwhile is written off once it is back on. */
  paused: boolean
}

type Counted = { failures: number; hookBlocks: number }

/** What the feature runs with: the step-up's settings and the bar and cap of the counts. */
type Settings = StepUpSettings & {
  /** Counted failures that make an agent step up; 0: failures raise nothing. */
  after: number
  /** Step-ups an agent gets at most in a run. */
  limit: number
}

/** Whether counted failures have reached the bar (`escalateAfter`); never with a bar of 0, which raises nothing. */
function reachedBar(counted: number, after: number): boolean {
  return after > 0 && counted >= after
}

export function registerEscalation(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: '派出的 agent 的工具调用失败够多次时，先升一档 effort，再失败就换更强的模型；主 agent 这一轮的失败记下来，留给下一条消息判断。', parts: ['counts'] })
  defineSwitch({ name: BLOCKS_SWITCH, info: '数失败次数时，把被你自己的 hook 拦下的调用也算上（你亲手拒绝的调用从不算）。', default: false })
  // Read at each use: which decision model's settings these are is settled at the session start (core/setup.ts, `Ctx`).
  const settings: Settings = {
    get after() {
      return ctx.config.escalation.after
    },
    get limit() {
      return ctx.config.escalation.limit
    },
    get haikuTo() {
      return ctx.config.escalation.haikuTo
    },
    get haikuToWritten() {
      return ctx.config.escalation.haikuToWritten
    },
    get models() {
      return ctx.config.agents.models
    },
  }

  on('dispatchPilot.start', { name: 'escalation.call' }, async ($, started) => ({ value: await bridgeStart<HookGiven<typeof on<'tool.call', { tool: RegExp }>>>(started, async (e, next) => {
    const result = await next(e)
    // The calls the model made, not another plugin's `$.tool.call`; counted while Dispatch Pilot is on, whatever this
    // feature's switch says (the main agent's turn keeps its facts all the same).
    if (next.origin.plugin !== 'engine' || !masterOn()) return result
    try {
      // A Workflow's run: its directory holds each of its agents' transcripts, which the engine keeps from the mod.
      const run = e.tool === 'Workflow' ? launchedRun(result.result) : null
      if (run !== null) {
        const runs: Cell<{ runId: string; dir: string }[]> = { get: () => $.state.get(RUNS), set: (value, options) => $.state.set(RUNS, value, options) }
        await update(runs, (list) => [...(list ?? []).filter((kept) => kept.runId !== run.runId), run].slice(-MAX_RUNS))
      }
      // A refusal by a plugin's tool.call hook (`{ deny }`) is nobody's failure and no settings hook's block: the
      // Workflow feature's hand-back of a script is one. Only what the tool reported, and what the settings hooks refused, count.
      if (typeof result.deny === 'string') return result
      const ended = outcomeOf(e.tool, result, wasBlocked(e.tool_use_id))
      const failing = ended === 'failed' || ended === 'blocked'
      if (e.agentId === undefined) await countMain($, ended, failing ? errorLine(e.tool, result.text) : null)
      else if (failing) await countAgent($, settings, e.agentId, ended)
    } catch (error) {
      $.ui.log(`escalation: ${errorText(error)}`, { to: 'debug' })
    }
    return result
  }) }))

  // The row of a tool's result, before it is stored. Without dispatch-pilot-extras (a Code Mode session) the hook above
  // does not run: every loop's calls are counted here (core/calls.ts). A Workflow's run is not noted there (its agents are
  // not routed without the other plugin). Then, either way, an agent whose effort is to go up has its note put on the row,
  // when a request carries the row (core/notes.ts), and the raise is made once the row is stored with it.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    if (!masterOn()) return next(e)
    try {
      if (!(await hasExtras(() => $.dispatchPilotExtras.present()))) {
        for (const call of callsEnded(e, await $.clock.now())) {
          const ended = outcomeOf(call.tool, { isError: call.isError, text: call.text }, call.isError && blockedByHookText(call.text))
          const failing = ended === 'failed' || ended === 'blocked'
          if (call.agentId === undefined) await countMain($, ended, failing ? errorLine(call.tool, call.text) : null)
          else if (failing) await countAgent($, settings, call.agentId, ended)
        }
      }
    } catch (error) {
      $.ui.log(`escalation: ${errorText(error)}`, { to: 'debug' })
    }
    const agentId = e.agentId
    const raise = agentId === undefined ? undefined : waitingRaises.get(agentId)
    if (agentId === undefined || raise === undefined || raise.onRow === true || !carriedByRequest(e.message.content)) return next(e)
    // One row takes it: the results of a step's calls are stored one after another.
    raise.onRow = true
    const note = switchNote(raise.from, raise.to, 'failures')
    let stored: Awaited<ReturnType<typeof next>>
    try {
      stored = await next({ ...e, message: withNote(e.message, note) })
    } catch (error) {
      if (waitingRaises.get(agentId) === raise) waitingRaises.delete(agentId)
      throw error
    }
    try {
      if (holdsNote(stored, note)) await takeRaise($, settings, agentId, raise)
      else await dropRaise($, settings, agentId, raise)
    } catch (error) {
      $.ui.log(`escalation: ${errorText(error)}`, { to: 'debug' })
    } finally {
      if (waitingRaises.get(agentId) === raise) waitingRaises.delete(agentId)
    }
    return stored
  })

  on('turn.step', { turnId: /(?:)/ }, async function* ($, e, next) {
    if (masterOn()) {
      try {
        await atStep($, e)
      } catch (error) {
        $.ui.log(`escalation: ${errorText(error)}`, { to: 'debug' })
      }
    }
    return yield* next(e)
  })

  // A main turn ends: one the person's own message started keeps its facts on its record, for the next message's decision.
  on('turn.complete', { turnId: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || !masterOn()) return result
    try {
      await keepFacts($, settings, e.turnId)
    } catch (error) {
      $.ui.log(`escalation: ${errorText(error)}`, { to: 'debug' })
    }
    return result
  })
}

/** The main agent's call as it ends: counted, and when it failed or a hook blocked it, its line (`failed`) kept. */
async function countMain($: EngineInterface, ended: string, failed: string | null): Promise<void> {
  const ref = { ...ESCALATION, id: MAIN }
  const cell: Cell<LoopRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
  const record = await update(cell, (r) => {
    const loop = r ?? newLoop('')
    return {
      ...loop,
      calls: loop.calls + 1,
      failures: loop.failures + (ended === 'failed' ? 1 : 0),
      hookBlocks: loop.hookBlocks + (ended === 'blocked' ? 1 : 0),
      errors: failed === null ? loop.errors : withError(loop.errors, failed),
    }
  })
  if (failed !== null && isOn(SWITCH)) await showCounts($, MAIN, record)
}

/**
 * An agent's failed (or blocked) call: counted, and when the counted failures reach `escalateAfter` (never, when it is 0), the agent's effort goes
 * one level up (the first time, where it can: `effortUp`), else the agent goes on as the next model up (while it has
 * step-ups left), else its effort goes up again (where the model cannot: no step-up left, `escalateLimit` 0, the top
 * model, a model the person named), or the decision says why nothing can. Either way the counts start over from there.
 * Where it would go is worked out before the count lands; the write that lands the count is the one that takes the raise,
 * and a step in which the effort or the model went up raises nothing more (`raisedIn`), so of the calls of a step that
 * fail together only one raises anything, however many times they reach the bar between them.
 */
async function countAgent($: EngineInterface, s: Settings, agentId: string, ended: 'failed' | 'blocked'): Promise<void> {
  const ref = { ...ESCALATION, id: agentId }
  const cell: Cell<LoopRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
  const planRef = { ...AGENTS, id: agentId }
  const planCell: Cell<AgentPlan> = { get: () => $.state.get(planRef), set: (value, options) => $.state.set(planRef, value, options) }
  const [{ value: seen }, { value: planned }] = await Promise.all([cell.get(), planCell.get()])
  // The agent's model as its steps name it: its plan's, else the engine's on its latest step.
  const from = planned?.model ?? seen?.model ?? ''
  const where = stepUp(from, s, planned?.terms ?? null)
  const enabled = isOn(SWITCH)
  // The effort first, and again wherever the model cannot go up: for an agent the engine lists (a Workflow's are not in the
  // roster), on a level that can go up.
  const modelLeft = (loop: Pick<LoopRecord, 'raises'>) => loop.raises < s.limit && 'to' in where
  const mayRaise = (seen?.effortRaises ?? 0) === 0 || !modelLeft(seen ?? { raises: 0 })
  const effort = enabled && isOn(MIDRUN_SWITCH) && mayRaise ? effortUp(seen?.effort ?? null, planned) : null
  const listed = effort === null ? false : (await $.agent.list().catch(() => [])).some((agent) => agent.id === agentId)
  const { before, after } = await replace(cell, (r) => {
    const loop = r ?? newLoop('')
    const counted = { ...loop, failures: loop.failures + (ended === 'failed' ? 1 : 0), hookBlocks: loop.hookBlocks + (ended === 'blocked' ? 1 : 0) }
    if (!enabled || !reachedBar(total(countedOf(counted)), s.after)) return counted
    // This call reaches the bar: the counts start over from here, with the raise that is made.
    // The effort or the model went up in this very step and no step has run on it yet: the step's other failing calls
    // start the count over and raise nothing (the next raise would land before the new level or model was ever used; and
    // `where` was worked out from the model the step began on, so a second step-up here would be the first one again).
    const sameStep = raisedIn(counted, counted.step)
    const first = (counted.effortRaises ?? 0) === 0
    if (effort !== null && listed && !sameStep && (first || !modelLeft(counted))) return { ...counted, base: countedNow(counted), effortRaises: (counted.effortRaises ?? 0) + 1, effortStep: counted.step }
    if (sameStep) return { ...counted, base: countedNow(counted) }
    if (counted.raises >= s.limit) return counted
    return { ...counted, base: countedNow(counted), ...('to' in where ? { raises: counted.raises + 1, raiseStep: counted.step } : {}) }
  })
  if (!enabled) return
  const wasBase = before?.base ?? { failures: 0, hookBlocks: 0 }
  if (after.base.failures === wasBase.failures && after.base.hookBlocks === wasBase.hookBlocks) {
    await showCounts($, agentId, after)
    return
  }
  // The bar reached again in the step the effort or the model was raised in: counted afresh, nothing more to raise yet.
  if ((after.effortRaises ?? 0) === (before?.effortRaises ?? 0) && after.raises === (before?.raises ?? 0) && raisedIn(after, after.step)) {
    await showCounts($, agentId, after)
    return
  }
  // What reached the bar: the counts since they last started over, as they stood when this call ended.
  const reached = total(countedOf({ ...after, base: wasBase }))
  const rows = await agentRows($, agentId)
  const about = aboutOf(agentId, rows === null ? '' : briefOf(rows), after.step, reached)
  if (effort !== null && (after.effortRaises ?? 0) > (before?.effortRaises ?? 0)) {
    // The raise waits for the agent's next tool result, whose row takes the note: it is made, and reported, once that row
    // is stored with it (`takeRaise`), and where the row does not keep the note the model goes up instead (`dropRaise`).
    waitingRaises.set(agentId, { ...effort, model: from, about, reached })
    while (waitingRaises.size > MAX_WAITING) waitingRaises.delete(waitingRaises.keys().next().value as string)
    await showCounts($, agentId, after)
    return
  }
  await raiseModel($, s, agentId, after, where, from, about, reached)
}

/** An agent goes on as the next model up, where it can (`where`); the decision says which, or why not. */
async function raiseModel($: EngineInterface, s: Settings, agentId: string, record: LoopRecord, where: ReturnType<typeof stepUp>, from: string, about: string, reached: number): Promise<void> {
  if ('to' in where) {
    const to = where.to.id
    const planRef = { ...AGENTS, id: agentId }
    const planCell: Cell<AgentPlan> = { get: () => $.state.get(planRef), set: (value, options) => $.state.set(planRef, value, options) }
    await update(planCell, (r) => ({ ...(r ?? { effort: null, floor: null, model: null, terms: null }), model: to }))
    await decide($, agentId, record, {
      outcome: `model ${to}（原 ${from}）`,
      about,
      reason: `工具调用失败 ${reached} 次（门槛 ${s.after}），从它的下一步起改用 ${to}${where.note}${(record.effortRaises ?? 0) > 0 ? '；effort 已经升过一档' : ''}`,
      tone: 'warn',
      forced: { kind: 'model', from, to },
    })
  } else {
    await decide($, agentId, record, { outcome: `model ${from === '' ? '不变' : `${from}（保持）`}`, about, reason: `工具调用失败 ${reached} 次（门槛 ${s.after}），没有升模型：${where.why}`, tone: 'info' })
  }
  await showCounts($, agentId, record)
}

/** Whether the loop's effort or model was raised in `step`: no step has run on the new level or model yet. */
function raisedIn(record: Pick<LoopRecord, 'effortStep' | 'raiseStep'>, step: number | null): boolean {
  return typeof step === 'number' && (record.effortStep === step || record.raiseStep === step)
}

/** Why a failing agent's model does not go up, in the person's words: its step-ups are switched off or used up, or the step-up says why. */
function noModelWhy(record: Pick<LoopRecord, 'raises'>, s: Settings, where: ReturnType<typeof stepUp>): string {
  if (s.limit === 0) return 'escalateLimit 是 0'
  if (record.raises >= s.limit) return `已经换过 ${record.raises} 次，escalateLimit 是 ${s.limit}`
  return 'to' in where ? '' : where.why
}

/**
 * Where a failing agent's effort goes, one level up: from the level its latest step went out at, to max at most (ADR 0022: no
 * cap in the middle of a run). Null when it cannot: the person named the agent's effort, the level is not known (a model
 * without effort, no step seen), or it is on max already.
 */
function effortUp(sent: Effort | null, planned: AgentPlan | undefined): { from: Effort; to: Effort } | null {
  if (sent === null || planned?.terms?.effort != null) return null
  const at = EFFORTS.indexOf(sent)
  return at >= EFFORTS.length - 1 ? null : { from: sent, to: EFFORTS[at + 1] as Effort }
}

/** An agent's plan and its loop's record, as cells, with what they hold now. */
async function loopOf($: EngineInterface, agentId: string): Promise<{ cell: Cell<LoopRecord>; planCell: Cell<AgentPlan>; record: LoopRecord; planned: AgentPlan | undefined }> {
  const ref = { ...ESCALATION, id: agentId }
  const cell: Cell<LoopRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
  const planRef = { ...AGENTS, id: agentId }
  const planCell: Cell<AgentPlan> = { get: () => $.state.get(planRef), set: (value, options) => $.state.set(planRef, value, options) }
  const [{ value: record }, { value: planned }] = await Promise.all([cell.get(), planCell.get()])
  return { cell, planCell, record: record ?? newLoop(''), planned }
}

/**
 * Makes a raise of a running agent's effort, once the row of its tool result is stored with the note: its plan, and the
 * decision (the level went with a step that carries input, so it goes out).
 */
async function takeRaise($: EngineInterface, s: Settings, agentId: string, raise: WaitingRaise): Promise<void> {
  const { planCell, record, planned } = await loopOf($, agentId)
  await update(planCell, (r) => ({ ...(r ?? { effort: null, floor: null, model: null, terms: null }), effort: raise.to }))
  const where = stepUp(raise.model, s, planned?.terms ?? null)
  const modelLeft = record.raises < s.limit && 'to' in where
  await decide($, agentId, record, {
    outcome: `effort ${raise.to}（原 ${raise.from}）`,
    about: raise.about,
    reason: modelLeft
      ? `工具调用失败 ${raise.reached} 次（门槛 ${s.after}），先把 effort 升一档：在它的工具结果后面加了一行提示，从下一步起生效，不动它的缓存；再失败到门槛才换模型`
      : `工具调用失败 ${raise.reached} 次（门槛 ${s.after}），把 effort 升一档：在它的工具结果后面加了一行提示，从下一步起生效，不动它的缓存；不换模型（${noModelWhy(record, s, where)}），${raise.to === 'max' ? '已经到 max，之后不再升' : '再失败到门槛就再升一档，直到 max'}`,
    tone: 'warn',
    forced: { kind: 'effort', from: raise.from, to: raise.to },
  })
  await showCounts($, agentId, record)
}

/**
 * A raise whose note the row did not keep: the level would not go out, so the plan is left as it was and the raise is not
 * counted as made. The model goes up as it would have, where it can, and where it cannot the decision says so.
 */
async function dropRaise($: EngineInterface, s: Settings, agentId: string, raise: WaitingRaise): Promise<void> {
  $.ui.log(`escalation: the note for agent ${agentId}'s effort ${raise.to} was not kept on its tool result's row; it stays on ${raise.from}`, { to: 'debug' })
  const { cell, record: seen, planned } = await loopOf($, agentId)
  let record = await update(cell, (r) => {
    const loop = r ?? seen
    return { ...loop, effortRaises: Math.max(0, (loop.effortRaises ?? 1) - 1), effortStep: null }
  })
  const where = stepUp(raise.model, s, planned?.terms ?? null)
  if (!(record.raises < s.limit && 'to' in where)) {
    await decide($, agentId, record, {
      outcome: `effort ${raise.from}（保持）`,
      about: raise.about,
      reason: `工具调用失败 ${raise.reached} 次（门槛 ${s.after}），本想把 effort 升到 ${raise.to}，但提示行加不到它的工具结果上，这一档发不出去；不换模型（${noModelWhy(record, s, where)}）`,
      tone: 'info',
    })
    await showCounts($, agentId, record)
    return
  }
  record = await update(cell, (r) => {
    const loop = r ?? record
    return { ...loop, raises: loop.raises + 1, raiseStep: loop.step }
  })
  await raiseModel($, s, agentId, record, where, raise.model, raise.about, raise.reached)
}

/**
 * At a loop's step: keeps where the loop is, the model the engine names on it and the effort the step goes out at
 * (core/plans.ts `planStep`, the core's own rules); a new main turn starts its counts afresh. Back on
 * after being off, what was counted meanwhile is written off.
 */
async function atStep($: EngineInterface, e: TurnStepInput): Promise<void> {
  const main = e.agentId === undefined
  const id = e.agentId ?? MAIN
  const ref = { ...ESCALATION, id }
  const cell: Cell<LoopRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
  const [{ value: lock = null }, { value: turn }, { value: agent }] = await Promise.all([
    main ? $.state.get(LOCK) : Promise.resolve({ value: null }),
    $.state.get({ ...TURNS, id: turnKey(e.turnId, e.agentId) }),
    main ? Promise.resolve({ value: undefined }) : $.state.get({ ...AGENTS, id: id }),
  ])
  const sent = planStep(e, { lock, turn, agent }).step.effort
  const effort: Effort | null = isEffort(sent) ? sent : null
  const enabled = isOn(SWITCH)
  /** Whether a record belongs to an earlier main turn (or there is none): this step starts the turn's counts afresh. */
  const startsTurn = (r: LoopRecord | undefined) => main && (r === undefined || r.turnId !== e.turnId)
  const { before } = await replace(cell, (r) => {
    const loop = startsTurn(r) || r === undefined ? newLoop(main ? e.turnId : '') : r
    const written = enabled && loop.paused ? { ...loop, base: countedNow(loop), paused: false } : loop
    return { ...written, step: e.index, model: e.model, effort, paused: !enabled }
  })
  // A new main turn: what the one before counted is over (its facts went on its record as it ended).
  if (startsTurn(before)) await showCounts($, MAIN, null)
}

/** The facts of the main turn `turnId` on its record, when the person's own message started it (a report's turn keeps none). */
async function keepFacts($: EngineInterface, s: Settings, turnId: string): Promise<void> {
  const ref = { ...TURNS, id: turnKey(turnId, undefined) }
  const cell: Cell<TurnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
  const [{ value: loop }, { value: turn }] = await Promise.all([$.state.get({ ...ESCALATION, id: MAIN }), cell.get()])
  if (loop === undefined || loop.turnId !== turnId || turn === undefined || !turn.person) return
  const facts: TurnFacts = {
    effort: loop.effort,
    calls: loop.calls,
    failed: loop.failures,
    blocked: loop.hookBlocks,
    stuck: reachedBar(total(countedOf(loop)), s.after),
    errors: loop.errors,
  }
  await update(cell, (r) => ({ ...(r ?? turn), facts }))
  // Where the next message finds them: the person's latest turn (a report's turn keeps none, so it does not move this).
  await $.state.set(LAST_TURN, { turnId, facts })
}

/** The run a Workflow tool's result says it launched: its id and its directory; null for none (refused, failed). */
function launchedRun(result: unknown): { runId: string; dir: string } | null {
  if (typeof result !== 'object' || result === null) return null
  const { runId, transcriptDir } = result as { runId?: unknown; transcriptDir?: unknown }
  return typeof runId === 'string' && typeof transcriptDir === 'string' ? { runId, dir: transcriptDir } : null
}

/**
 * An agent's transcript: as the session gives it, or for a workflow's agent
 * (the engine keeps it from the mod) from the run's directory on disk, found
 * among the runs this feature noted; null when neither can be read. The
 * agent's own file says which run it is of: the run's journal holds every
 * agent's result and past 4 MiB `$.fs.read` refuses it.
 */
async function agentRows($: EngineInterface, agentId: string): Promise<TranscriptRow[] | null> {
  const found: unknown = await $.session.messages({ agentId }).catch(() => null)
  if (Array.isArray(found)) return found as TranscriptRow[]
  const { value: runs = [] } = await $.state.get(RUNS)
  for (const run of [...runs].reverse()) {
    const text = await $.fs.read(`${run.dir}/agent-${agentId}.jsonl`).catch(() => null)
    if (text !== null) return rowsFromTranscript(text)
  }
  return null
}

/** What a decision about an agent is about: its task (`brief`, '' when unknown), its step, the failures that reached the bar. */
function aboutOf(agentId: string, brief: string, at: number | null, failed: number): string {
  const who = brief === '' ? `agent ${agentId}` : `agent ${quoteStart(brief)}`
  return `${who}，${at === null ? '' : `第 ${at} 步，`}工具调用失败 ${failed} 次`
}

/** What the decision report needs of the host: its two cells, the debug log, the clock and the toast. */
function ioOf($: EngineInterface): ReportIo {
  return {
    board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
    decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
    debug: (line) => $.ui.log(line, { to: 'debug' }),
    now: () => $.clock.now(),
    toast: (text) => $.ui.toast(text),
  }
}

/** What a decision of this feature says, besides who it is about and the loop's counts (`decide` adds them). */
type Said = Pick<Decided, 'outcome' | 'reason' | 'tone' | 'forced'> & { about: string }

/**
 * Reports a decision of this feature (debug log, `/dp log`, the board data), about agent `id`, with its counts as they
 * stand. Beside the agent's own route: not on its node.
 */
async function decide($: EngineInterface, id: string, record: LoopRecord, said: Said): Promise<void> {
  const { about, ...rest } = said
  await report(ioOf($), {
    decision: {
      ...rest,
      feature: SWITCH,
      agent: id,
      aside: true,
      subject: about,
      counts: { failed: record.failures, blocked: record.hookBlocks, raised: record.raises },
    },
  })
}

function newLoop(turnId: string): LoopRecord {
  return { turnId, calls: 0, failures: 0, hookBlocks: 0, base: { failures: 0, hookBlocks: 0 }, raises: 0, step: null, model: null, effort: null, errors: [], paused: false }
}

/** The failures counted toward escalating: since the counts last started over, hook blocks only when they count. */
function countedOf(record: Pick<LoopRecord, 'failures' | 'hookBlocks' | 'base'>): Counted {
  return {
    failures: record.failures - record.base.failures,
    hookBlocks: isOn(BLOCKS_SWITCH) ? record.hookBlocks - record.base.hookBlocks : 0,
  }
}

/** The counts as they stand: where they start over from once the failures are dealt with. */
function countedNow(record: Pick<LoopRecord, 'failures' | 'hookBlocks'>): Counted {
  return { failures: record.failures, hookBlocks: record.hookBlocks }
}

function total(counted: Counted): number {
  return counted.failures + counted.hookBlocks
}

/** Reports a loop's counts (on the board's node of it): the main agent's, or an agent's (null record: none yet, as at a new turn, whose node is a new one). */
async function showCounts($: EngineInterface, id: string, record: LoopRecord | null): Promise<void> {
  await report(ioOf($), { tally: { feature: 'escalation', agent: id, failed: record?.failures ?? 0, blocked: record?.hookBlocks ?? 0, raised: record?.raises ?? 0 } })
}
