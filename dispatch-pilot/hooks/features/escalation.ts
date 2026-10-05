// Feature: a loop whose tool calls keep failing goes up a level (#7).
//
// Every tool call of the main agent and of the agents it dispatches is told
// apart as it ends (core/outcomes.ts), and each loop's failures are counted
// here, in one record (`escalation`) that the mid-turn re-decision (#5) sends
// in its counts too: a call the person refused is no failure, one a hook
// blocked counts toward escalating only with `hook-block-failures` on, and
// the counts start over whenever this feature deals with them (a forced
// raise, failures found expected, or nothing left to raise).
//
// When a loop's counted failures reach `escalateAfter`, the decision model is
// asked at once, as the call that reaches them ends (story 18): the mid-turn
// effort question with the trouble, and whether the failures are what the
// work expects (a test written to fail first, a search that finds nothing).
// The loop's next step takes the answer, waiting `rejudgeWaitMs` at most, as
// a mid-turn re-decision does; an answer later than that is taken at a later
// step. Expected: the counts start over and the answer is an ordinary
// re-decision. Otherwise (also when no answer comes) the loop goes up: one
// level (at most to xhigh) or straight to max, at most `escalateLimit` times
// per turn (per run, for an agent); a haiku agent, which takes no effort,
// goes on as another model. The person's terms for an agent's work hold
// (core/plans.ts `AgentPlan`).
//
// It sits above the mid-turn feature (the entry registers it first), so a
// step's own mid-turn answer finds the raise already in the turn's plan and
// cannot undercut it.

import type { EngineInterface, HttpInit, On, TurnStepInput } from 'claude-code'
import { describeAsked, errorText, type Failure } from '../decision/backend.ts'
import { AGENT_MODELS, modelFamily, type AgentModel, type Terms } from '../decision/dispatched-agent.ts'
import { briefOf, forcedTarget, raisedLevel, readExpected, rowsFromTranscript, stepsFromRows, stuckRequest, troubleText, type RaiseMode, type TranscriptRow } from '../decision/escalation.ts'
import { higherEffort, isEffort, readEffort, readingText, type Effort, type EffortReading } from '../decision/effort.ts'
import { contentLanguage, judgeMidturn, MIDTURN_LEVEL, outcomeOf, verdictReason, type MidturnInput, type MidturnLimits, type MidturnRules } from '../decision/midturn.ts'
import { modelId, type ResolvedModel } from '../decision/model-ids.ts'
import { quoteStart } from '../decision/redact.ts'
import { answersFor } from '../decision/system-one.ts'
import { startedIn } from '../decision/workflow-labels.ts'
import { recordDecision, type DecisionEntry } from '../core/decisions.ts'
import { endedAs, noteEnded, wasBlocked } from '../core/outcomes.ts'
import { floorHeld, forced, newTurn, redecided, turnKey, update, type AgentPlan, type Cell, type TurnRecord } from '../core/plans.ts'
import type { Ctx } from '../core/setup.ts'
import { failureText, setStatus } from '../core/status.ts'
import { defineSwitch, isOn, masterOn } from '../core/switches.ts'

const ESCALATION = { plugin: 'dispatch-pilot', key: 'escalation' } as const
const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const
const AGENTS = { plugin: 'dispatch-pilot', key: 'agents' } as const
const LOCK = { plugin: 'dispatch-pilot', key: 'lock' } as const
const RUNS = { plugin: 'dispatch-pilot', key: 'labelRuns' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

/** The feature's switch (`/dp escalation on|off`). */
const SWITCH = 'escalation'
/** Whether a call one of the person's hooks blocked counts as a failure (`/dp hook-block-failures on|off`); off by default. */
const BLOCKS_SWITCH = 'hook-block-failures'
/** The id of the main agent's record in the `escalation` table. */
const MAIN_ID = 'main'

/** One loop's failed calls and forced raises (`escalation` in types/index.d.ts): the main agent's for one turn, an agent's for its run. */
type LoopRecord = {
  /** The main turn the counts belong to; '' for an agent. */
  turnId: string
  /** Calls that failed, and calls a hook refused, since the loop began. */
  failures: number
  hookBlocks: number
  /** The counts when they last started over: what is counted is the rest. */
  base: Counted
  /** Forced raises so far (failures found expected are not one). */
  raises: number
  /** The loop's latest step, the engine's effort and model on it: what a re-decision asked as a call ends reads. */
  step: number | null
  engine: Effort | null
  model: string | null
  /** The step a stuck re-decision was last asked for; null before the first. */
  askedFor: number | null
  /** An agent's step at its latest raise (the main agent's is its turn's `raisedAt`); null before one. */
  raisedAt: number | null
  /** The escalation switch was off when the loop was last seen: what was counted meanwhile is written off once it is back on. */
  paused: boolean
}

type Counted = { failures: number; hookBlocks: number }

/** What the feature runs with: the shared ctx and the options it reads. */
type Settings = {
  ctx: Ctx
  /** Counted failures that make a loop stuck. */
  after: number
  mode: RaiseMode
  /** Forced raises a loop gets at most. */
  limit: number
  /** The failures count as expected when the answer reaches this probability. */
  thetaExpected: number
  /** The model a failing haiku agent is switched to, as a step names it (the engine takes no alias for a step); null for none. */
  haikuTo: ResolvedModel | null
  /** `escalateHaikuTo` as written, for the log when it names no model. */
  haikuToWritten: string
  /** The models agents may run on: a ruled-out escalateHaikuTo gives way to the next of them up. */
  models: readonly AgentModel[]
  /** The mid-turn rules: what a raise the decision model itself suggests needs, and how an ordinary re-decision moves the level. */
  rules: MidturnRules
  limits: MidturnLimits
  /** How long a step waits for a stuck re-decision not back yet. */
  waitMs: number
}

/** What the decision model made of a stuck loop. */
type Stuck = {
  /** The effort answer; null when it was not asked or not answered. */
  reading: EffortReading | null
  /** The probability that the failures were expected; null without an answer. */
  expected: number | null
  /** Why the question went unanswered, when it did. */
  failure: Failure | null
  /** No transcript of the loop could be read: nothing was asked. */
  unread: boolean
}

/**
 * A stuck re-decision on its way, or answered and not yet taken, by loop id:
 * asked for step `forStep` (of turn `turnId`, for the main agent), about the
 * counts in `covered` (what starts over once it is dealt with). `answer`
 * never rejects; once it resolves, `settled` holds it and `ms` how long it took.
 * Promises cannot live in $.state: a reload drops them, and the loop's next
 * step asks again.
 */
type Asking = { forStep: number; turnId: string; covered: Counted; about: string; answer: Promise<Stuck>; settled: Stuck | null; ms: number }
const asking = new Map<string, Asking>()

export function registerEscalation(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: 'raises the effort of an agent whose tool calls keep failing', segments: ['escalation', 'agentEscalation'] })
  defineSwitch({ name: BLOCKS_SWITCH, info: 'counts a call one of your hooks blocked as a failure when deciding to escalate', default: false })
  const { escalation, midturn, agents } = ctx.config
  const settings: Settings = {
    ctx,
    after: escalation.after,
    mode: escalation.mode,
    limit: escalation.limit,
    thetaExpected: escalation.thetaExpected,
    haikuTo: escalation.haikuTo,
    haikuToWritten: escalation.haikuToWritten,
    models: agents.models,
    rules: midturn.rules,
    limits: midturn.limits,
    waitMs: midturn.waitMs,
  }

  on('tool.call', { tool: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    // The calls the model made, not another plugin's `$.tool.call`; counted while Dispatch Pilot is on, whatever this
    // feature's switch says (the mid-turn re-decision sends the counts too).
    if (next.origin.plugin !== 'engine' || !masterOn()) return result
    try {
      const ended = outcomeOf(e.tool, result, wasBlocked(e.tool_use_id))
      noteEnded(e.tool_use_id, ended)
      // A refusal by a plugin's tool.call hook (`{ deny }`) is nobody's failure and no settings hook's block: the
      // Workflow feature's hand-back of a script is one. Only what the tool reported, and what the settings hooks refused, count.
      if (typeof result.deny === 'string' || (ended !== 'failed' && ended !== 'blocked')) return result
      const id = e.agentId ?? MAIN_ID
      const ref = { ...ESCALATION, id }
      const cell: Cell<LoopRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
      const record = await update(cell, (r) => {
        const loop = r ?? fresh('')
        return ended === 'failed' ? { ...loop, failures: loop.failures + 1 } : { ...loop, hookBlocks: loop.hookBlocks + 1 }
      })
      if (!isOn(SWITCH)) return result
      showCounts($, id, record, null)
      // The call that reaches the threshold asks at once: the answer is for the loop's next step (once per step).
      if (record.step !== null && record.askedFor !== record.step + 1) await launch($, settings, id, e.agentId, record, record.step + 1)
    } catch (error) {
      $.ui.log(`escalation: ${errorText(error)}`, { to: 'debug' })
    }
    return result
  })

  on('turn.step', { turnId: /(?:)/ }, async function* ($, e, next) {
    if (masterOn()) {
      try {
        await atStep($, settings, e)
      } catch (error) {
        $.ui.log(`escalation: ${errorText(error)}`, { to: 'debug' })
      }
    }
    return yield* next(e)
  })
}

/**
 * At a loop's step: keeps where the loop is (a new main turn starts its counts
 * afresh), then takes the stuck re-decision meant for this step and applies
 * it. With none on its way while the counted failures call for one (nothing
 * to raise when the call ended, or a reload dropped the request), deals with
 * them here: written off when nothing can be raised, else asked now.
 */
async function atStep($: EngineInterface, s: Settings, e: TurnStepInput): Promise<void> {
  const main = e.agentId === undefined
  const id = e.agentId ?? MAIN_ID
  const ref = { ...ESCALATION, id }
  const cell: Cell<LoopRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
  const engine = isEffort(e.effort) ? e.effort : null
  const on = isOn(SWITCH)
  let turned = false
  let record = await update(cell, (r) => {
    turned = main && (r === undefined || r.turnId !== e.turnId)
    const loop = turned || r === undefined ? fresh(main ? e.turnId : '') : r
    // Back on after being off: what was counted meanwhile is written off, so it is counted from here on.
    const written = on && loop.paused ? { ...loop, base: { failures: loop.failures, hookBlocks: loop.hookBlocks }, paused: false } : loop
    return { ...written, step: e.index, engine, model: e.model, paused: !on }
  })
  if (turned) {
    // A new main turn: what the one before counted, and asked, is over.
    asking.delete(MAIN_ID)
    latestAgent = null
    showCounts($, MAIN_ID, null, null)
  }
  if (!on) return

  let pending = asking.get(id)
  if (pending === undefined || (main && pending.turnId !== e.turnId) || pending.forStep > e.index) {
    if (pending !== undefined) return
    // No re-decision on its way, though the counted failures may call for one: nothing could be raised when
    // the call ended, or a reload dropped the request. Dealt with here: written off, or asked now.
    const counted = countedOf(record)
    if (counted.failures + counted.hookBlocks < s.after || record.raises >= s.limit || record.askedFor === e.index || s.ctx.backend.configured === false) return
    record = await update(cell, (r) => ({ ...(r ?? record), askedFor: e.index }))
    const raise = await raiseOf($, s, id, e.agentId, record, e.index)
    if (raise.kind === 'none') return
    if (raise.kind === 'keep') {
      await settle($, cell, id, countedNow(record), false)
      const brief = e.agentId === undefined ? '' : briefOf((await agentRows($, e.agentId)) ?? [])
      await decide($, { outcome: raise.outcome, about: aboutOf(e.agentId, brief, e.index, counted), reason: raise.reason })
      return
    }
    await launch($, s, id, e.agentId, record, e.index)
    pending = asking.get(id)
    if (pending === undefined) return
  }
  const answer = pending.settled ?? (await within($, pending.answer, s.waitMs))
  if (answer === null) {
    // Not back yet: the step goes as it is, and the answer is taken at a later step (as a mid-turn re-decision's).
    showCounts($, id, record, 'late')
    return
  }
  asking.delete(id)
  await apply($, s, e, cell, pending.covered, pending.about, answer)
}

/** What a stuck loop's re-decision would do, from where the loop stands. */
type Raise =
  /** Leave the loop be: the person's lock holds the main agent's effort, or the step takes no effort level. */
  | { kind: 'none' }
  /** Nothing to raise: the failures are written off, and the decision recorded. */
  | { kind: 'keep'; outcome: string; reason: string }
  /** A higher effort, from `current`. */
  | { kind: 'level'; current: Effort; target: Effort }
  /** Another model (a haiku agent: it takes no effort). */
  | { kind: 'model'; from: string; to: ResolvedModel; note: string }

/**
 * What raising the loop would be at step `at`, by its plan: the main agent's
 * turn (unless the person locked its effort), or an agent's effective model
 * (the plan's, else the engine's) and the person's terms for its work.
 */
async function raiseOf($: EngineInterface, s: Settings, id: string, agentId: string | undefined, record: LoopRecord, at: number): Promise<Raise> {
  const top = (current: Effort) => ({ kind: 'keep' as const, outcome: `effort ${current} (kept)`, reason: s.mode === 'max' ? 'already at max' : 'a one-level raise stops at xhigh' })
  if (agentId === undefined) {
    const { value: lock = null } = await $.state.get(LOCK)
    if (lock !== null || record.engine === null) return { kind: 'none' }
    const { value: turn } = await $.state.get({ ...TURNS, id: turnKey(record.turnId, undefined) })
    const current = higherEffort(turn?.effort ?? record.engine, floorHeld(turn, at)) as Effort
    const target = forcedTarget(current, s.mode)
    return target === null ? top(current) : { kind: 'level', current, target }
  }
  const { value: planned } = await $.state.get({ ...AGENTS, id })
  const model = planned?.model ?? record.model ?? ''
  const family = modelFamily(model)
  // A model the mod does not know, and that takes no effort level: nothing to raise.
  if (family === null && record.engine === null) return { kind: 'none' }
  if (family === 'haiku') {
    const to = haikuSwitch(s, planned?.terms ?? null)
    return 'why' in to ? { kind: 'keep', outcome: `model ${model} (kept)`, reason: to.why } : { kind: 'model', from: model, to: to.to, note: to.note }
  }
  const named = planned?.terms?.effort ?? null
  if (named !== null) return { kind: 'keep', outcome: `effort ${named} (kept)`, reason: `${named} is the effort you named for it` }
  // Without a level of its own (moved off a model that takes none), its steps go at the engine's own for an agent: medium (measured on 2.1.289).
  const current = higherEffort(planned?.effort ?? record.engine ?? 'medium', planned?.floor ?? null) as Effort
  const target = forcedTarget(current, s.mode)
  return target === null ? top(current) : { kind: 'level', current, target }
}

/**
 * Sends the stuck re-decision for the loop's step `forStep`, when its counted
 * failures call for one and there is something to raise; the answer waits in
 * `asking` for that step. Once per step, one at a time per loop.
 */
async function launch($: EngineInterface, s: Settings, id: string, agentId: string | undefined, record: LoopRecord, forStep: number): Promise<void> {
  const counted = countedOf(record)
  if (counted.failures + counted.hookBlocks < s.after || record.raises >= s.limit || s.ctx.backend.configured === false || asking.has(id)) return
  const raise = await raiseOf($, s, id, agentId, record, forStep)
  if (raise.kind !== 'level' && raise.kind !== 'model') return
  const ref = { ...ESCALATION, id }
  const cell: Cell<LoopRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
  await update(cell, (r) => ({ ...(r ?? record), askedFor: forStep }))
  // What the counts say since they last started over, and what they start over from once this is dealt with.
  const since = { failures: record.failures - record.base.failures, hookBlocks: record.hookBlocks - record.base.hookBlocks }
  const entry: Asking = { forStep, turnId: record.turnId, covered: countedNow(record), about: '', answer: Promise.resolve(UNREAD), settled: null, ms: 0 }

  let input: MidturnInput
  if (agentId === undefined) {
    const { value: turn } = await $.state.get({ ...TURNS, id: turnKey(record.turnId, undefined) })
    const plan = turn ?? newTurn('', null, false)
    const rows = (await $.session.messages().catch(() => [])) as TranscriptRow[]
    entry.about = aboutOf(undefined, '', forStep, counted)
    input = {
      message: plan.prompt,
      step: forStep,
      current_effort: raise.kind === 'level' ? raise.current : 'medium',
      counts: { judgments: plan.decisions, changes: plan.changes, failures: since.failures, hook_blocks: since.hookBlocks },
      recent_steps: stepsFromRows(rows, { language: contentLanguage(plan.prompt), ended: endedAs }),
      trouble: troubleText(counted),
    }
  } else {
    const rows = await agentRows($, agentId)
    const brief = rows === null ? '' : briefOf(rows)
    entry.about = aboutOf(agentId, brief, forStep, counted)
    if (rows === null) {
      // No transcript to read (a workflow agent whose run the mod did not record): raised without asking.
      entry.settled = UNREAD
      asking.set(id, entry)
      return
    }
    input = {
      message: brief,
      step: forStep,
      current_effort: raise.kind === 'level' ? raise.current : 'medium',
      counts: { judgments: 1 + record.raises, changes: record.raises, failures: since.failures, hook_blocks: since.hookBlocks },
      recent_steps: stepsFromRows(rows, { language: contentLanguage(brief), ended: endedAs }),
      trouble: troubleText(counted),
    }
  }
  // A haiku agent takes no effort: only whether its failures were expected is asked.
  const { request, effortPart, expectedPart } = stuckRequest(input, { limits: s.limits, ask: s.ctx.ask, effort: raise.kind === 'level' })
  const io = {
    fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
    sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
  }
  const startedAt = await $.clock.now()
  entry.answer = s.ctx.backend.ask(io, request, s.ctx.config.timeoutMs).then(async (asked): Promise<Stuck> => {
    entry.ms = (await $.clock.now()) - startedAt
    $.ui.log(`request [${Object.keys(request.questions).join(', ')}] for ${entry.about} to ${s.ctx.backend.name}: ${describeAsked(asked, entry.ms)}`, { to: 'debug' })
    let stuck: Stuck = { reading: null, expected: null, failure: null, unread: false }
    if (!asked.ok) stuck = { ...stuck, failure: asked.failure }
    else {
      const expected = readExpected(answersFor(expectedPart, asked.answers))
      stuck = {
        reading: effortPart === null ? null : readEffort(answersFor(effortPart, asked.answers)[MIDTURN_LEVEL]),
        expected,
        failure: expected === null ? { kind: 'parse', detail: 'no answer to the question' } : null,
        unread: false,
      }
    }
    entry.settled = stuck
    return stuck
  })
  asking.set(id, entry)
}

/** The answer when nothing could be asked: no transcript of the agent to read. */
const UNREAD: Stuck = { reading: null, expected: null, failure: null, unread: true }

/** Resolves to `answer` when it comes within `ms`, else to null. */
async function within<T>($: EngineInterface, answer: Promise<T>, ms: number): Promise<T | null> {
  const stop = new AbortController()
  const timer = $.clock.sleep(ms, { signal: stop.signal }).then(
    () => null,
    () => null,
  )
  const first = await Promise.race([answer, timer])
  stop.abort()
  return first
}

/**
 * Applies a stuck re-decision's answer at step `e`, to the loop as it stands
 * now (a re-decision may have moved it since the question went out): expected
 * failures leave an ordinary re-decision; otherwise the loop goes up (or, when
 * it can no longer, its failures are written off). Either way the counts the
 * question covered start over.
 */
async function apply($: EngineInterface, s: Settings, e: TurnStepInput, cell: Cell<LoopRecord>, covered: Counted, about: string, answer: Stuck): Promise<void> {
  const id = e.agentId ?? MAIN_ID
  const { value: record } = await cell.get()
  if (record === undefined) return
  const raise = await raiseOf($, s, id, e.agentId, record, e.index)
  if (raise.kind === 'none') return
  if (raise.kind === 'keep') {
    await settle($, cell, id, covered, false)
    await decide($, { outcome: raise.outcome, about, reason: raise.reason })
    return
  }
  const p = answer.expected
  if (p !== null && p >= s.thetaExpected) {
    const why = `the failures are expected (p ${p.toFixed(2)}, thetaExpected ${s.thetaExpected.toFixed(2)}), so nothing is forced`
    if (raise.kind === 'model') {
      await settle($, cell, id, covered, false)
      await decide($, { outcome: `model ${raise.from} (kept)`, about, reason: why })
      return
    }
    // Expected: nothing is forced; the answer's effort is an ordinary re-decision, as mid-turn.
    const level = await redecide($, s, e, record, raise.current, answer.reading)
    await settle($, cell, id, covered, false)
    await decide($, {
      outcome: `effort ${level.effort} ${level.effort === raise.current ? '(kept)' : `(was ${raise.current})`}`,
      about,
      reason: level.why === null ? why : `${why}; ${level.why}`,
    })
    return
  }

  if (raise.kind === 'model') {
    const ref = { ...AGENTS, id }
    const planCell: Cell<AgentPlan> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
    await update(planCell, (r) => ({ ...(r ?? { effort: null, floor: null, model: null, terms: null }), model: raise.to.id }))
    await settle($, cell, id, covered, true, e.index)
    await decide($, { outcome: `model ${raise.to.id} (was ${raise.from})`, about, reason: `a haiku agent has no effort to raise, so it is switched to ${raise.to.id}${raise.note}; ${knownReason(s, answer)}` })
    return
  }
  const level = raisedLevel(answer.reading, raise.target, s.rules)
  if (e.agentId === undefined) {
    // Raised from this step on; for holdSteps steps nothing lowers it below the forced level (decision 4 of review 1).
    const ref = { ...TURNS, id: turnKey(e.turnId, undefined) }
    const turnCell: Cell<TurnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
    await update(turnCell, (r) => forced(r ?? newTurn('', null, false), level, raise.target, e.index, s.rules.holdSteps))
  } else {
    // The raise holds for the rest of the agent's run: nothing re-decides an agent mid-run, so it goes into its effort.
    const ref = { ...AGENTS, id }
    const planCell: Cell<AgentPlan> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
    await update(planCell, (r) => ({ ...(r ?? { effort: null, floor: null, model: null, terms: null }), effort: level }))
  }
  await settle($, cell, id, covered, true, e.index)
  await decide($, { outcome: `effort ${level} (was ${raise.current})`, about, reason: raiseReason(s, answer, level, raise.target) })
}

/**
 * An ordinary re-decision from a stuck loop's effort answer, its failures
 * found expected: the main agent's turn by the mid-turn rules (a turn the
 * person started, as mid-turn), an agent's plan the same way. The level it
 * goes on at, and why (null when there was nothing to decide from).
 */
async function redecide($: EngineInterface, s: Settings, e: TurnStepInput, record: LoopRecord, current: Effort, reading: EffortReading | null): Promise<{ effort: Effort; why: string | null }> {
  if (reading === null) return { effort: current, why: null }
  if (e.agentId === undefined) {
    const ref = { ...TURNS, id: turnKey(e.turnId, undefined) }
    const turnCell: Cell<TurnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
    const { value: turn } = await turnCell.get()
    if (turn?.person !== true) return { effort: current, why: null }
    const position = { current, sinceRaise: turn.raisedAt == null ? null : e.index - turn.raisedAt, atLeast: floorHeld(turn, e.index) }
    const verdict = judgeMidturn(reading, position, s.rules)
    await update(turnCell, (r) => redecided(r ?? turn, current, verdict.effort, e.index))
    return { effort: verdict.effort, why: `${readingText(reading)}; ${verdictReason(verdict, position, s.rules)}` }
  }
  const ref = { ...AGENTS, id: e.agentId }
  const planCell: Cell<AgentPlan> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
  const { value: plan } = await planCell.get()
  const position = { current, sinceRaise: record.raisedAt === null ? null : e.index - record.raisedAt, atLeast: plan?.floor ?? null }
  const verdict = judgeMidturn(reading, position, s.rules)
  if (verdict.effort !== current) await update(planCell, (r) => ({ ...(r ?? { effort: null, floor: null, model: null, terms: null }), effort: verdict.effort }))
  return { effort: verdict.effort, why: `${readingText(reading)}; ${verdictReason(verdict, position, s.rules)}` }
}

/**
 * The model a failing haiku agent goes on as: `escalateHaikuTo`, unless the
 * person ruled it out for the agent's work, then the next model up that agents
 * may run on and the person did not rule out. None (with why) when the person
 * named haiku, when escalateHaikuTo names no model, or when every model up is
 * ruled out.
 */
function haikuSwitch(s: Settings, terms: Terms | null): { to: ResolvedModel; note: string } | { why: string } {
  if (terms?.model === 'haiku') return { why: 'haiku is the model you named for it' }
  const to = s.haikuTo
  if (to === null) return { why: s.haikuToWritten === '' ? 'escalateHaikuTo names no model' : `escalateHaikuTo names no model this mod knows (${JSON.stringify(s.haikuToWritten)})` }
  const banned = terms?.banned ?? []
  if (!banned.includes(to.family)) return { to, note: '' }
  const up = AGENT_MODELS.slice(AGENT_MODELS.indexOf(to.family) + 1).find((family) => s.models.includes(family) && !banned.includes(family))
  if (up !== undefined) return { to: { family: up, id: modelId(up) }, note: ` (${to.family} is ruled out for it)` }
  const above = AGENT_MODELS.filter((family) => family !== 'haiku' && banned.includes(family))
  return { why: `every model above haiku is ruled out for it (${above.join(', ')})` }
}

/**
 * An agent's transcript: as the session gives it, or for a workflow's agent
 * (the engine keeps it from the mod) from the run's directory on disk, found by
 * the runs the workflow-labels feature records; null when neither can be read.
 */
async function agentRows($: EngineInterface, agentId: string): Promise<TranscriptRow[] | null> {
  const found: unknown = await $.session.messages({ agentId }).catch(() => null)
  if (Array.isArray(found)) return found as TranscriptRow[]
  const { value: runs = [] } = await $.state.get(RUNS)
  for (const run of [...runs].reverse()) {
    const journal = await $.fs.read(`${run.dir}/journal.jsonl`).catch(() => null)
    if (journal === null || startedIn(journal, agentId) === null) continue
    const text = await $.fs.read(`${run.dir}/agent-${agentId}.jsonl`).catch(() => null)
    return text === null ? null : rowsFromTranscript(text)
  }
  return null
}

/** What a decision about the loop is about: its step and the failures, and for an agent its task (`brief`, '' when unknown). */
function aboutOf(agentId: string | undefined, brief: string, at: number, counted: Counted): string {
  const failed = `${counted.failures + counted.hookBlocks} failed tool calls`
  if (agentId === undefined) return `step ${at} (${failed})`
  return `${brief === '' ? `agent ${agentId}` : `agent ${quoteStart(brief)}`}, step ${at} (${failed})`
}

/** Records a decision of this feature (debug log and `/dp log`). */
async function decide($: EngineInterface, decision: { outcome: string; about: string; reason: string }): Promise<void> {
  const decisions: Cell<DecisionEntry[]> = { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) }
  await recordDecision(decisions, (line) => $.ui.log(line, { to: 'debug' }), { feature: SWITCH, ...decision })
}

/** Why a forced raise went where it did, for the decision log. */
function raiseReason(s: Settings, answer: Stuck, level: Effort, target: Effort): string {
  const how = s.mode === 'max' ? 'forced to max' : 'forced one level up'
  const higher = level === target ? '' : `, the answer's own pick is higher`
  return `${how}${higher}; ${knownReason(s, answer)}${answer.reading === null ? '' : `; ${readingText(answer.reading)}`}`
}

/** Whether the failures were known to be expected, for the decision log: why they were not. */
function knownReason(s: Settings, answer: Stuck): string {
  if (answer.unread) return 'no transcript of this agent to read, so not asked whether the failures were expected'
  if (answer.expected !== null) return `not expected (p ${answer.expected.toFixed(2)}, thetaExpected ${s.thetaExpected.toFixed(2)})`
  return `no answer (${failureText(s.ctx.backend.name, answer.failure ?? { kind: 'parse', detail: 'no answer to the question' })})`
}

function fresh(turnId: string): LoopRecord {
  return { turnId, failures: 0, hookBlocks: 0, base: { failures: 0, hookBlocks: 0 }, raises: 0, step: null, engine: null, model: null, askedFor: null, raisedAt: null, paused: false }
}

/** The failures counted toward escalating: since the counts last started over, hook blocks only when they count. */
function countedOf(record: LoopRecord): Counted {
  return {
    failures: record.failures - record.base.failures,
    hookBlocks: isOn(BLOCKS_SWITCH) ? record.hookBlocks - record.base.hookBlocks : 0,
  }
}

/** The counts as they stand: where they start over from once the failures are dealt with. */
function countedNow(record: LoopRecord): Counted {
  return { failures: record.failures, hookBlocks: record.hookBlocks }
}

/** The loop's counts start over from `covered` (a raise counts as one), and are shown. */
async function settle($: EngineInterface, cell: Cell<LoopRecord>, id: string, covered: Counted, raised: boolean, at?: number): Promise<void> {
  const record = await update(cell, (r) => ({
    ...(r ?? fresh('')),
    base: { failures: Math.max(covered.failures, r?.base.failures ?? 0), hookBlocks: Math.max(covered.hookBlocks, r?.base.hookBlocks ?? 0) },
    raises: (r?.raises ?? 0) + (raised ? 1 : 0),
    ...(raised && at !== undefined ? { raisedAt: at } : {}),
  }))
  showCounts($, id, record, null)
}

/** The latest agent whose calls failed, for the status line (lost on a reload, until its next failure). */
let latestAgent: { record: LoopRecord; note: 'late' | null } | null = null

/** Shows a loop's counts: the main agent's segment, or the latest agent's (null record: none to show for main). `note`: `late`. */
function showCounts($: EngineInterface, id: string, record: LoopRecord | null, note: 'late' | null): void {
  const show = (line: string | undefined) => $.ui.status(line)
  if (id === MAIN_ID) setStatus('escalation', countsText(record, '', note), show)
  else if (record !== null) latestAgent = { record, note }
  setStatus('agentEscalation', latestAgent === null ? null : countsText(latestAgent.record, 'agent ', latestAgent.note), show)
}

/** `failed 2, blocked 1, raised 1`: the counts that are not zero (null when all are), and `(late)` while a stuck answer is not back. */
function countsText(record: LoopRecord | null, prefix: string, note: 'late' | null): string | null {
  if (record === null) return null
  const parts = [
    record.failures > 0 ? `failed ${record.failures}` : '',
    record.hookBlocks > 0 ? `blocked ${record.hookBlocks}` : '',
    record.raises > 0 ? `raised ${record.raises}` : '',
  ].filter((part) => part !== '')
  return parts.length === 0 ? null : `${prefix}${parts.join(', ')}${note === null ? '' : ` (${note})`}`
}
