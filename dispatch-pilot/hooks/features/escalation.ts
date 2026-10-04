// Feature: a loop whose tool calls keep failing goes up a level (#7).
//
// Every failed tool call of the main agent and of the agents it dispatches is
// counted (a call the person refused is not; one a hook blocked only when the
// `hook-block-failures` switch says so). When a loop has `escalateAfter`
// counted failures, the decision model is asked again at that loop's next step:
// the same effort question as mid-turn (with the `trouble` flag) and one more,
// whether the failures are what the work expects (a test written to fail
// first, a search that finds nothing) or a sign it is stuck. Expected: the
// counts start over and nothing is forced. Otherwise (also when no answer
// comes) the loop goes up: one level (at most to xhigh) or straight to max,
// never below that level again, at most `escalateLimit` times per turn.
//
// This feature owns that whole re-decision. It sits above the mid-turn feature
// (the entry registers it first), so a step's own mid-turn answer finds the
// raise already in the turn's plan and cannot undercut it.

import type { EngineInterface, HttpInit, On, TurnStepInput } from 'claude-code'
import type { Asked } from '../decision/backend.ts'
import { expectedFailurePart, forcedTarget, raisedLevel, readExpected, RAISE_MODES, troubleText, type RaiseMode } from '../decision/escalation.ts'
import { EFFORTS, higherEffort, isEffort, readEffort, type Effort, type EffortReading } from '../decision/effort.ts'
import { judgeMidturn, MIDTURN_LEVEL, midturnEffortPart, midturnState, outcomeOf, verdictReason, type MidturnInput, type MidturnLimits, type MidturnRules } from '../decision/midturn.ts'
import { answersFor, mergeParts } from '../decision/system-one.ts'
import { recordDecision, type DecisionEntry } from '../core/decisions.ts'
import { newTurn, revise, turnKey, update, type Cell, type TurnRecord } from '../core/plans.ts'
import { numberIn, type Ctx } from '../core/setup.ts'
import { failureText } from '../core/status.ts'
import { defineSwitch, isOn } from '../core/switches.ts'

const ESCALATION = { plugin: 'dispatch-pilot', key: 'escalation' } as const
const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const
const LOCK = { plugin: 'dispatch-pilot', key: 'lock' } as const
const MIDTURN = { plugin: 'dispatch-pilot', key: 'midturn' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

/** The feature's switch (`/dp escalation on|off`). */
const SWITCH = 'escalation'
/** Whether a call one of the person's hooks blocked counts as a failure (`/dp hook-block-failures on|off`); off by default. */
const BLOCKS_SWITCH = 'hook-block-failures'
/** The id of the main agent's counts in the `escalation` table. */
const MAIN_ID = 'main'

/** The feature's own record of one loop (`escalation` in types/index.d.ts). */
type Strain = {
  turnId: string
  failures: number
  hookBlocks: number
  base: { failures: number; hookBlocks: number }
  raises: number
  askedAt: number | null
}

/** What the feature runs with: the shared ctx and its own options. */
type Settings = {
  ctx: Ctx
  /** Counted failures that make a loop stuck. */
  after: number
  mode: RaiseMode
  /** Forced raises a loop gets at most. */
  limit: number
  /** The failures count as expected when the answer reaches this probability. */
  thetaExpected: number
  /** The mid-turn rules: what a raise the decision model itself suggests needs, and how an ordinary re-decision moves the level. */
  rules: MidturnRules
  limits: MidturnLimits
}

export function registerEscalation(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: 'raises the effort of an agent whose tool calls keep failing', segments: ['escalation'] })
  defineSwitch({ name: BLOCKS_SWITCH, info: 'counts a call one of your hooks blocked as a failure when deciding to escalate', default: false })
  const settings: Settings = {
    ctx,
    after: Math.round(numberIn(ctx.options.escalateAfter, 1, 20, 2)),
    mode: RAISE_MODES.find((mode) => mode === ctx.options.escalateMode) ?? 'one-level',
    limit: Math.round(numberIn(ctx.options.escalateLimit, 0, 10, 2)),
    thetaExpected: numberIn(ctx.options.thetaExpected, 0, 1, 0.6),
    rules: {
      thetaUp: numberIn(ctx.options.thetaUp, 0, 1, 0.4),
      thetaDown: numberIn(ctx.options.thetaDown, 0, 1, 0.6),
      thetaMax: ctx.config.thetaMax,
      holdSteps: Math.round(numberIn(ctx.options.holdSteps, 0, 50, 3)),
    },
    limits: { steps: Math.round(numberIn(ctx.options.rejudgeSteps, 1, 16, 4)), tokens: ctx.config.context.tokens },
  }

  // Wraps the PreToolUse settings hooks (they run beneath it): `tool.call` only sees their refusal as an error
  // carrying the hook's reason, so the call's id is noted here (it is the same in both events, in any loop).
  on('classic.PreToolUse', { tool: /(?:)/ }, async ($, e, next) => {
    const decided = await next(e)
    if (decided.deny !== undefined && e.tool_use_id) blocked(e.tool_use_id)
    return decided
  })

  on('tool.call', { tool: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    // The calls the model made, not another plugin's `$.tool.call`.
    if (next.origin.plugin !== 'engine' || !isOn(SWITCH)) return result
    try {
      const outcome = outcomeOf(e.tool, result, wasBlocked(e.tool_use_id))
      if (outcome === 'failed' || outcome === 'blocked') {
        const ref = { ...ESCALATION, id: e.agentId ?? MAIN_ID }
        const cell: Cell<Strain> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
        await update(cell, (r) => {
          const record = r ?? fresh('')
          return outcome === 'failed' ? { ...record, failures: record.failures + 1 } : { ...record, hookBlocks: record.hookBlocks + 1 }
        })
      }
    } catch (error) {
      $.ui.log(`escalation: ${describe(error)}`, { to: 'debug' })
    }
    return result
  })

  on('turn.step', { turnId: /(?:)/ }, async function* ($, e, next) {
    if (isOn(SWITCH)) {
      try {
        await consider($, settings, e)
      } catch (error) {
        $.ui.log(`escalation: ${describe(error)}`, { to: 'debug' })
      }
    }
    return yield* next(e)
  })
}

/**
 * At a loop's step: when its counted failures have reached the threshold,
 * asks the decision model and, unless the failures were expected, raises the
 * loop. The raise is written into the plan table; the core sends it with this
 * step.
 */
async function consider($: EngineInterface, s: Settings, e: TurnStepInput): Promise<void> {
  if (e.agentId !== undefined) return
  const ref = { ...ESCALATION, id: MAIN_ID }
  const cell: Cell<Strain> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
  const { value: record } = await $.state.get(ref)
  if (record?.turnId !== e.turnId) {
    // A new main turn: what the one before counted is over.
    await update(cell, () => fresh(e.turnId))
    return
  }
  const counted = {
    failures: record.failures - record.base.failures,
    hookBlocks: isOn(BLOCKS_SWITCH) ? record.hookBlocks - record.base.hookBlocks : 0,
  }
  const total = counted.failures + counted.hookBlocks
  if (total < s.after || record.raises >= s.limit || record.askedAt === e.index) return
  // The person's lock holds the effort whatever happens; without a decision model set up the mod does nothing at all.
  const { value: lock = null } = await $.state.get(LOCK)
  if (lock !== null || s.ctx.backend.configured === false) return

  const key = turnKey(e.turnId, undefined)
  const turnRef = { ...TURNS, id: key }
  const turnCell: Cell<TurnRecord> = { get: () => $.state.get(turnRef), set: (value, options) => $.state.set(turnRef, value, options) }
  const { value: turn } = await $.state.get(turnRef)
  const plan = turn ?? newTurn('', null)
  const engine = isEffort(e.effort) ? e.effort : null
  const current = higherEffort(plan.effort ?? engine, plan.floor)
  if (current === null) return
  const log = (line: string) => $.ui.log(line, { to: 'debug' })
  const decisions: Cell<DecisionEntry[]> = { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) }
  const about = `step ${e.index} (${total} failed tool calls)`
  const target = forcedTarget(current, s.mode)
  if (target === null) {
    // Nowhere to go: the failures are written off so this does not come up at every step.
    await update(cell, (r) => settled(r ?? fresh(e.turnId), e.index, false))
    await recordDecision(decisions, log, { feature: SWITCH, outcome: `effort ${current} (kept)`, about, reason: s.mode === 'max' ? 'already at max' : 'a one-level raise stops at xhigh' })
    return
  }

  const input: MidturnInput = {
    message: plan.prompt,
    step: e.index,
    current_effort: current,
    counts: { judgments: plan.decisions, changes: plan.changes, failures: record.failures, hook_blocks: record.hookBlocks },
    recent_steps: [],
    trouble: troubleText(counted),
  }
  const effortPart = midturnEffortPart(s.ctx.ask, { trouble: true })
  const expectedPart = expectedFailurePart(s.ctx.ask)
  const request = mergeParts(midturnState(input, s.limits), [effortPart, expectedPart])
  const io = {
    fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
    sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
  }
  const startedAt = await $.clock.now()
  const asked = await s.ctx.backend.ask(io, request, s.ctx.config.timeoutMs)
  const ms = (await $.clock.now()) - startedAt
  log(`request [${Object.keys(request.questions).join(', ')}] for ${about} to ${s.ctx.backend.name}: ${describeAsked(asked, ms)}`)

  const reading = asked.ok ? readEffort(answersFor(effortPart, asked.answers)[MIDTURN_LEVEL]) : null
  const p = asked.ok ? readExpected(answersFor(expectedPart, asked.answers)) : null
  if (p !== null && p >= s.thetaExpected) {
    // Expected: nothing is forced; the answer's effort is an ordinary re-decision.
    const { value: own } = await $.state.get({ ...MIDTURN, id: key })
    const sinceRaise = own?.raisedAt == null ? null : e.index - own.raisedAt
    const position = { current, sinceRaise, atLeast: plan.floor }
    const verdict = reading !== null && plan.effort !== null ? judgeMidturn(reading, position, s.rules) : null
    const level = verdict?.effort ?? current
    if (verdict !== null) await update(turnCell, (r) => decided(r ?? plan, current, level))
    await update(cell, (r) => settled(r ?? fresh(e.turnId), e.index, false))
    const why = `the failures are expected (p ${p.toFixed(2)}, thetaExpected ${s.thetaExpected.toFixed(2)}), so nothing is forced`
    await recordDecision(decisions, log, {
      feature: SWITCH,
      outcome: `effort ${level} ${level === current ? '(kept)' : `(was ${current})`}`,
      about,
      reason: verdict === null || reading === null ? why : `${why}; ${describeReading(reading)}; ${verdictReason(verdict, position, s.rules)}`,
    })
    return
  }

  const level = raisedLevel(reading, target, s.rules)
  await update(turnCell, (r) => lifted(r ?? plan, level, target))
  await update(cell, (r) => settled(r ?? fresh(e.turnId), e.index, true))
  const how = s.mode === 'max' ? 'forced to max' : 'forced one level up'
  const higher = level === target ? '' : `, the answer's own pick is higher`
  const known =
    p !== null
      ? `not expected (p ${p.toFixed(2)}, thetaExpected ${s.thetaExpected.toFixed(2)})`
      : `no answer (${failureText(s.ctx.backend.name, asked.ok ? { kind: 'parse', detail: 'no answer to the question' } : asked.failure)})`
  await recordDecision(decisions, log, {
    feature: SWITCH,
    outcome: `effort ${level} (was ${current})`,
    about,
    reason: `${how}${higher}; ${known}${reading === null ? '' : `; ${describeReading(reading)}`}`,
  })
}

/** The calls a PreToolUse hook refused, by tool_use_id (the latest ones). */
const blockedIds = new Set<string>()
const MAX_BLOCKED = 256

function blocked(id: string): void {
  blockedIds.add(id)
  for (const old of blockedIds) {
    if (blockedIds.size <= MAX_BLOCKED) break
    blockedIds.delete(old)
  }
}

function wasBlocked(id: string): boolean {
  return blockedIds.has(id)
}

function fresh(turnId: string): Strain {
  return { turnId, failures: 0, hookBlocks: 0, base: { failures: 0, hookBlocks: 0 }, raises: 0, askedAt: null }
}

/** The record once the failures counted so far are dealt with (written off, or answered by a raise, which counts). */
function settled(record: Strain, index: number, raised: boolean): Strain {
  return { ...record, base: { failures: record.failures, hookBlocks: record.hookBlocks }, raises: record.raises + (raised ? 1 : 0), askedAt: index }
}

/** The turn's record after a forced raise: at least `target` from now on, its routed effort set to `level` when it has one. */
function lifted(record: TurnRecord, level: Effort, target: Effort): TurnRecord {
  if (record.effort === null) return { ...record, floor: higherEffort(record.floor, level) }
  return revise({ ...record, floor: higherEffort(record.floor, target) }, level)
}

/** The turn's record after an ordinary re-decision: its effort set when the level moves (counted as a change), the decision counted either way. */
function decided(record: TurnRecord, current: Effort, next: Effort): TurnRecord {
  return next === current ? { ...record, decisions: record.decisions + 1 } : revise({ ...record, effort: current }, next)
}

/** Every level's probability and the backend's confidence, for the decision log. */
function describeReading(reading: EffortReading): string {
  const levels = EFFORTS.map((level, i) => `${level} ${(reading.probabilities[i] ?? 0).toFixed(2)}`).join(', ')
  return `p ${levels}; confidence ${reading.confidence === null ? 'n/a' : reading.confidence.toFixed(2)}`
}

/** A request's outcome for the debug log, as the other features write theirs. */
function describeAsked(asked: Asked, ms: number): string {
  if (!asked.ok) return `${asked.failure.kind}: ${asked.failure.detail} (${ms} ms)`
  const by = asked.model === null ? '' : ` by ${asked.model}`
  const tokens = asked.inputTokens === null ? '' : ` (${asked.inputTokens} input tokens)`
  return `answered in ${ms} ms${by}${tokens}`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
