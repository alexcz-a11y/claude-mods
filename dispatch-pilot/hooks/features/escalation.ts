// Feature: a loop whose tool calls keep failing (#7, ADR 0013).
//
// Every tool call of the main agent and of the agents it dispatches is told
// apart as it ends (decision/escalation.ts `outcomeOf`; the calls a PreToolUse
// settings hook refused are known by core/outcomes.ts), and each loop's calls
// are counted here, in one record (`escalation`): a call the person refused is
// no failure, one a hook blocked counts toward escalating only with
// `hook-block-failures` on.
//
// Since Claude Code 2.1.312 an effort raised in the middle of a turn does not
// go out (a model keeps its level from one message with input to the next), so
// the counts raise no effort and ask the decision model nothing:
//   - a dispatched agent (a plain one or a Workflow's) whose counted failures
//     reach `escalateAfter` goes on as the next model up (decision/escalation.ts
//     `stepUp`: haiku to `escalateHaikuTo`, then opus, fable only with
//     `agentFable`), written into its plan at once, so the core's step writer
//     names it from the agent's next step on; at most `escalateLimit` times a
//     run, never past a model the person named. The counts start over after a
//     step-up, and after one that could not be made.
//   - the main agent's turn keeps its facts (the effort its steps went out at,
//     its calls, failures and hook blocks, the last error lines); when a turn
//     the person's own message started ends, they go on its turn record
//     (`facts`) for the next message's decision.

import type { EngineInterface, On, TurnStepInput } from 'claude-code'
import { errorText } from '../decision/backend.ts'
import { briefOf, errorLine, outcomeOf, rowsFromTranscript, stepUp, withError, type StepUpSettings, type TranscriptRow, type TurnFacts } from '../decision/escalation.ts'
import { isEffort, type Effort } from '../decision/effort.ts'
import { quoteStart } from '../decision/redact.ts'
import { wasBlocked } from '../core/outcomes.ts'
import { MAIN, planStep, replace, turnKey, update, type AgentPlan, type Cell, type TurnRecord } from '../core/plans.ts'
import { report, type Decided, type ReportIo } from '../core/report.ts'
import type { Ctx } from '../core/setup.ts'
import { defineSwitch, isOn, masterOn } from '../core/switches.ts'

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
  /** The main agent's: the effort its latest step went out at, as the core sends it; null for none. */
  effort: Effort | null
  /** The main agent's: the last failed or blocked calls, at most two (decision/escalation.ts `errorLine`). */
  errors: string[]
  /** The escalation switch was off when the loop was last seen: what was counted meanwhile is written off once it is back on. */
  paused: boolean
}

type Counted = { failures: number; hookBlocks: number }

/** What the feature runs with: the step-up's settings and the bar and cap of the counts. */
type Settings = StepUpSettings & {
  /** Counted failures that make an agent step up. */
  after: number
  /** Step-ups an agent gets at most in a run. */
  limit: number
}

export function registerEscalation(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: '派出的 agent 工具调用接连失败时，改用更强的模型；主 agent 这一轮的失败记下来，留给下一条消息', parts: ['counts'] })
  defineSwitch({ name: BLOCKS_SWITCH, info: '数工具调用的失败时，把被你的 hook 拦下的调用也算上', default: false })
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

  on('tool.call', { tool: /(?:)/ }, async ($, e, next) => {
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
 * An agent's failed (or blocked) call: counted, and when the counted failures reach `escalateAfter` (and the agent has
 * step-ups left), the agent goes on as the next model up, or the decision says why it cannot. Either way the counts start
 * over from there. Where it would go is worked out before the count lands; the write that lands the count is the one that
 * takes the step-up, so of the calls of a step that fail together only one does.
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
  const { before, after } = await replace(cell, (r) => {
    const loop = r ?? newLoop('')
    const counted = { ...loop, failures: loop.failures + (ended === 'failed' ? 1 : 0), hookBlocks: loop.hookBlocks + (ended === 'blocked' ? 1 : 0) }
    if (!enabled || total(countedOf(counted)) < s.after || counted.raises >= s.limit) return counted
    // This call reaches the bar: the counts start over from here, a step-up counted when there is one to make.
    return { ...counted, base: countedNow(counted), raises: counted.raises + ('to' in where ? 1 : 0) }
  })
  if (!enabled) return
  const wasBase = before?.base ?? { failures: 0, hookBlocks: 0 }
  if (after.base.failures === wasBase.failures && after.base.hookBlocks === wasBase.hookBlocks) {
    await showCounts($, agentId, after)
    return
  }
  // What reached the bar: the counts since they last started over, as they stood when this call ended.
  const reached = total(countedOf({ ...after, base: wasBase }))
  const rows = await agentRows($, agentId)
  const about = aboutOf(agentId, rows === null ? '' : briefOf(rows), after.step, reached)
  if ('to' in where) {
    const to = where.to.id
    await update(planCell, (r) => ({ ...(r ?? { effort: null, floor: null, model: null, terms: null }), model: to }))
    await decide($, agentId, after, {
      outcome: `model ${to}（原 ${from}）`,
      about,
      reason: `工具调用失败 ${reached} 次（门槛 ${s.after}），从它的下一步起改用 ${to}${where.note}；effort 在一轮中途改了也不生效，所以只换模型`,
      tone: 'warn',
      forced: { kind: 'model', from, to },
    })
  } else {
    await decide($, agentId, after, { outcome: `model ${from === '' ? '不变' : `${from}（保持）`}`, about, reason: `工具调用失败 ${reached} 次（门槛 ${s.after}），没有升模型：${where.why}`, tone: 'info' })
  }
  await showCounts($, agentId, after)
}

/**
 * At a loop's step: keeps where the loop is, the model the engine names on it and, for the main agent, the effort the
 * step goes out at (core/plans.ts `planStep`, the core's own rules); a new main turn starts its counts afresh. Back on
 * after being off, what was counted meanwhile is written off.
 */
async function atStep($: EngineInterface, e: TurnStepInput): Promise<void> {
  const main = e.agentId === undefined
  const id = e.agentId ?? MAIN
  const ref = { ...ESCALATION, id }
  const cell: Cell<LoopRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
  let effort: Effort | null = null
  if (main) {
    const [{ value: lock = null }, { value: turn }] = await Promise.all([$.state.get(LOCK), $.state.get({ ...TURNS, id: turnKey(e.turnId, undefined) })])
    const sent = planStep(e, { lock, turn, agent: undefined }).step.effort
    effort = isEffort(sent) ? sent : null
  }
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
    stuck: total(countedOf(loop)) >= s.after,
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
