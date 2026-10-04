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
import type { Asked, Failure } from '../decision/backend.ts'
import { modelFamily } from '../decision/dispatched-agent.ts'
import { expectedFailurePart, forcedTarget, raisedLevel, readExpected, RAISE_MODES, stepsFromRows, troubleText, type RaiseMode } from '../decision/escalation.ts'
import { EFFORTS, higherEffort, isEffort, readEffort, type Effort, type EffortReading } from '../decision/effort.ts'
import {
  contentLanguage,
  judgeMidturn,
  MIDTURN_LEVEL,
  midturnEffortPart,
  midturnState,
  outcomeOf,
  verdictReason,
  type MidturnInput,
  type MidturnLimits,
  type MidturnRules,
  type MidturnShow,
} from '../decision/midturn.ts'
import { redactSecrets } from '../decision/redact.ts'
import { answersFor, mergeParts } from '../decision/system-one.ts'
import { recordDecision, type DecisionEntry } from '../core/decisions.ts'
import { newTurn, revise, turnKey, update, type Cell, type TurnRecord } from '../core/plans.ts'
import { numberIn, stringOf, type Ctx } from '../core/setup.ts'
import { failureText, setStatus } from '../core/status.ts'
import { defineSwitch, isOn } from '../core/switches.ts'

const ESCALATION = { plugin: 'dispatch-pilot', key: 'escalation' } as const
const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const
const AGENTS = { plugin: 'dispatch-pilot', key: 'agents' } as const
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

/** An agent's plan (`agents` in types/index.d.ts, core/plans.ts `Plan`). */
type AgentPlan = { effort: Effort | null; floor: Effort | null; model: string | null }

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
  /** The model a failing haiku agent is switched to: a full id (the engine takes no alias for a step); '' for none. */
  haikuTo: string
  /** The mid-turn rules: what a raise the decision model itself suggests needs, and how an ordinary re-decision moves the level. */
  rules: MidturnRules
  limits: MidturnLimits
}

export function registerEscalation(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: 'raises the effort of an agent whose tool calls keep failing', segments: ['escalation', 'agentEscalation'] })
  defineSwitch({ name: BLOCKS_SWITCH, info: 'counts a call one of your hooks blocked as a failure when deciding to escalate', default: false })
  const settings: Settings = {
    ctx,
    after: Math.round(numberIn(ctx.options.escalateAfter, 1, 20, 2)),
    mode: RAISE_MODES.find((mode) => mode === ctx.options.escalateMode) ?? 'one-level',
    limit: Math.round(numberIn(ctx.options.escalateLimit, 0, 10, 2)),
    thetaExpected: numberIn(ctx.options.thetaExpected, 0, 1, 0.6),
    haikuTo: stringOf(ctx.options.escalateHaikuTo, 'claude-sonnet-5-5').trim(),
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
        const counted = await update(cell, (r) => {
          const record = r ?? fresh('')
          return outcome === 'failed' ? { ...record, failures: record.failures + 1 } : { ...record, hookBlocks: record.hookBlocks + 1 }
        })
        if (e.agentId === undefined) showCounts($, counted, undefined)
        else showCounts($, null, counted)
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

/** What `consider` hands the loop-specific parts: the step, the loop's record and what the failures add up to. */
type Loop = {
  s: Settings
  e: TurnStepInput
  /** The loop's counts. */
  cell: Cell<Strain>
  record: Strain
  /** The failures (and, when the switch says so, hook blocks) counted since the counts last started over. */
  counted: { failures: number; hookBlocks: number }
  total: number
}

/**
 * At a loop's step: when its counted failures have reached the threshold,
 * asks the decision model and, unless the failures were expected, raises the
 * loop. The raise is written into the plan table; the core sends it with this
 * step.
 */
async function consider($: EngineInterface, s: Settings, e: TurnStepInput): Promise<void> {
  const main = e.agentId === undefined
  const ref = { ...ESCALATION, id: e.agentId ?? MAIN_ID }
  const cell: Cell<Strain> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
  const { value: record } = await $.state.get(ref)
  if (main && record?.turnId !== e.turnId) {
    // A new main turn: what the one before counted is over.
    await update(cell, () => fresh(e.turnId))
    latestAgent = null
    showCounts($, null, undefined)
    return
  }
  if (record === undefined) return
  const counted = {
    failures: record.failures - record.base.failures,
    hookBlocks: isOn(BLOCKS_SWITCH) ? record.hookBlocks - record.base.hookBlocks : 0,
  }
  const total = counted.failures + counted.hookBlocks
  if (total < s.after || record.raises >= s.limit || record.askedAt === e.index) return
  // Without a decision model set up the mod does nothing at all.
  if (s.ctx.backend.configured === false) return
  const loop: Loop = { s, e, cell, record, counted, total }
  await (main ? forMain($, loop) : forAgent($, loop))
}

/** The main agent: the turn goes up (its plan's floor too), unless the person's lock holds the effort. */
async function forMain($: EngineInterface, loop: Loop): Promise<void> {
  const { s, e, cell, record, counted, total } = loop
  const { value: lock = null } = await $.state.get(LOCK)
  if (lock !== null) return

  const key = turnKey(e.turnId, undefined)
  const turnRef = { ...TURNS, id: key }
  const turnCell: Cell<TurnRecord> = { get: () => $.state.get(turnRef), set: (value, options) => $.state.set(turnRef, value, options) }
  const { value: turn } = await $.state.get(turnRef)
  const plan = turn ?? newTurn('', null)
  // A step that takes no effort level (a model without one, or a numeric setting) cannot be raised.
  const engine = isEffort(e.effort) ? e.effort : null
  if (engine === null) return
  const current = higherEffort(plan.effort ?? engine, plan.floor) as Effort
  const about = `step ${e.index} (${total} failed tool calls)`
  const target = forcedTarget(current, s.mode)
  if (target === null) {
    // Nowhere to go: the failures are written off so this does not come up at every step.
    await settle($, loop, false)
    await decide($, { outcome: `effort ${current} (kept)`, about, reason: s.mode === 'max' ? 'already at max' : 'a one-level raise stops at xhigh' })
    return
  }

  const rows = await $.session.messages().catch(() => [])
  const input: MidturnInput = {
    message: plan.prompt,
    step: e.index,
    current_effort: current,
    counts: { judgments: plan.decisions, changes: plan.changes, failures: record.failures, hook_blocks: record.hookBlocks },
    recent_steps: stepsFromRows(rows, { language: contentLanguage(plan.prompt), blocked: wasBlocked }),
    trouble: troubleText(counted),
  }
  const answer = await askStuck($, loop, input, {}, true, about)
  const p = answer.expected
  if (p !== null && p >= s.thetaExpected) {
    // Expected: nothing is forced; the answer's effort is an ordinary re-decision.
    const { value: own } = await $.state.get({ ...MIDTURN, id: key })
    const sinceRaise = own?.raisedAt == null ? null : e.index - own.raisedAt
    const position = { current, sinceRaise, atLeast: plan.floor }
    const reading = answer.reading
    const verdict = reading !== null && plan.effort !== null ? judgeMidturn(reading, position, s.rules) : null
    const level = verdict?.effort ?? current
    if (verdict !== null) await update(turnCell, (r) => decided(r ?? plan, current, level))
    await settle($, loop, false)
    const why = `the failures are expected (p ${p.toFixed(2)}, thetaExpected ${s.thetaExpected.toFixed(2)}), so nothing is forced`
    await decide($, {
      outcome: `effort ${level} ${level === current ? '(kept)' : `(was ${current})`}`,
      about,
      reason: verdict === null || reading === null ? why : `${why}; ${describeReading(reading)}; ${verdictReason(verdict, position, s.rules)}`,
    })
    return
  }

  const level = raisedLevel(answer.reading, target, s.rules)
  await update(turnCell, (r) => lifted(r ?? plan, level, target))
  await settle($, loop, true)
  await decide($, { outcome: `effort ${level} (was ${current})`, about, reason: raiseReason(s, answer, level, target) })
}

/**
 * A dispatched (or workflow) agent: its effort goes up for the rest of its
 * run; a haiku agent, which has no effort to raise, is switched to the model
 * `escalateHaikuTo` names instead. Its task and steps are read from its own
 * transcript, which a workflow's agent does not have: that one is raised
 * without asking whether its failures were expected.
 */
async function forAgent($: EngineInterface, loop: Loop): Promise<void> {
  const { s, e, cell, record, counted, total } = loop
  const id = e.agentId as string
  const planRef = { ...AGENTS, id }
  const planCell: Cell<AgentPlan> = { get: () => $.state.get(planRef), set: (value, options) => $.state.set(planRef, value, options) }
  const { value: planned } = await $.state.get(planRef)
  const plan: AgentPlan = planned ?? { effort: null, floor: null, model: null }
  const engine = isEffort(e.effort) ? e.effort : null
  const found = await $.session.messages({ agentId: id }).catch(() => null)
  const rows = Array.isArray(found) ? found : null
  const brief = rows?.find((row) => row.role === 'user' && row.text.trim() !== '')?.text ?? ''
  const label = brief === '' ? `agent ${id}` : `agent ${quote(brief)}`
  const about = `${label}, step ${e.index} (${total} failed tool calls)`

  // What the raise is: a level (the step takes an effort), or another model (haiku takes none).
  let current: Effort | null = null
  let target: Effort | null = null
  let switchTo: string | null = null
  if (engine !== null) {
    current = higherEffort(plan.effort ?? engine, plan.floor) as Effort
    target = forcedTarget(current, s.mode)
    if (target === null) {
      await settle($, loop, false)
      await decide($, { outcome: `effort ${current} (kept)`, about, reason: s.mode === 'max' ? 'already at max' : 'a one-level raise stops at xhigh' })
      return
    }
  } else if (modelFamily(e.model) === 'haiku') {
    if (plan.model !== null || s.haikuTo === '') {
      // Already switched (the engine still names haiku for its steps, with no level to set), or nowhere to switch to.
      await settle($, loop, false)
      await decide($, { outcome: `model ${plan.model ?? e.model} (kept)`, about, reason: plan.model !== null ? `already switched to ${plan.model}` : 'escalateHaikuTo names no model' })
      return
    }
    switchTo = s.haikuTo
  } else {
    return
  }

  let answer: Stuck = { reading: null, expected: null, failure: null }
  if (rows !== null) {
    const input: MidturnInput = {
      message: brief,
      step: e.index,
      current_effort: current ?? 'medium',
      counts: { judgments: 1 + record.raises, changes: record.raises, failures: record.failures, hook_blocks: record.hookBlocks },
      recent_steps: stepsFromRows(rows, { language: contentLanguage(brief), blocked: wasBlocked }),
      trouble: troubleText(counted),
    }
    answer = await askStuck($, loop, input, current === null ? { currentEffort: false } : {}, current !== null, about)
  }
  const p = answer.expected
  if (p !== null && p >= s.thetaExpected) {
    await settle($, loop, false)
    await decide($, {
      outcome: current === null ? `model ${e.model} (kept)` : `effort ${current} (kept)`,
      about,
      reason: `the failures are expected (p ${p.toFixed(2)}, thetaExpected ${s.thetaExpected.toFixed(2)}), so nothing is forced`,
    })
    return
  }

  if (switchTo !== null) {
    await update(planCell, (r) => ({ ...(r ?? plan), model: switchTo }))
    await settle($, loop, true)
    await decide($, { outcome: `model ${switchTo} (was ${e.model})`, about, reason: `a haiku agent has no effort to raise, so it is switched to ${switchTo}; ${knownReason(s, answer, rows === null)}` })
    return
  }
  const level = raisedLevel(answer.reading, target as Effort, s.rules)
  await update(planCell, (r) => ({ ...(r ?? plan), floor: higherEffort((r ?? plan).floor, level) }))
  await settle($, loop, true)
  await decide($, { outcome: `effort ${level} (was ${current})`, about, reason: raiseReason(s, answer, level, target as Effort, rows === null) })
}

/** What the decision model made of a stuck loop. */
type Stuck = {
  /** The effort answer; null when it was not asked or not answered. */
  reading: EffortReading | null
  /** The probability that the failures were expected; null without an answer. */
  expected: number | null
  /** Why the question went unanswered, when it did. */
  failure: Failure | null
}

/** Asks the stuck re-decision's request (the mid-turn effort question with the trouble flag, if `withEffort`, and whether the failures were expected); never throws. */
async function askStuck($: EngineInterface, loop: Loop, input: MidturnInput, show: MidturnShow, withEffort: boolean, about: string): Promise<Stuck> {
  const { s } = loop
  const effortPart = midturnEffortPart(s.ctx.ask, { trouble: true })
  const expectedPart = expectedFailurePart(s.ctx.ask)
  const request = mergeParts(midturnState(input, s.limits, show), withEffort ? [effortPart, expectedPart] : [expectedPart])
  const io = {
    fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
    sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
  }
  const startedAt = await $.clock.now()
  const asked = await s.ctx.backend.ask(io, request, s.ctx.config.timeoutMs)
  const ms = (await $.clock.now()) - startedAt
  $.ui.log(`request [${Object.keys(request.questions).join(', ')}] for ${about} to ${s.ctx.backend.name}: ${describeAsked(asked, ms)}`, { to: 'debug' })
  if (!asked.ok) return { reading: null, expected: null, failure: asked.failure }
  const reading = withEffort ? readEffort(answersFor(effortPart, asked.answers)[MIDTURN_LEVEL]) : null
  const expected = readExpected(answersFor(expectedPart, asked.answers))
  return { reading, expected, failure: expected === null ? { kind: 'parse', detail: 'no answer to the question' } : null }
}

/** Records a decision of this feature (debug log and `/dp log`). */
async function decide($: EngineInterface, decision: { outcome: string; about: string; reason: string }): Promise<void> {
  const decisions: Cell<DecisionEntry[]> = { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) }
  await recordDecision(decisions, (line) => $.ui.log(line, { to: 'debug' }), { feature: SWITCH, ...decision })
}

/** Why a forced raise went where it did, for the decision log. */
function raiseReason(s: Settings, answer: Stuck, level: Effort, target: Effort, unread = false): string {
  const how = s.mode === 'max' ? 'forced to max' : 'forced one level up'
  const higher = level === target ? '' : `, the answer's own pick is higher`
  return `${how}${higher}; ${knownReason(s, answer, unread)}${answer.reading === null ? '' : `; ${describeReading(answer.reading)}`}`
}

/** Whether the failures were known to be expected, for the decision log: why they were not. */
function knownReason(s: Settings, answer: Stuck, unread: boolean): string {
  if (unread) return 'no transcript of this agent to read, so not asked whether the failures were expected'
  if (answer.expected !== null) return `not expected (p ${answer.expected.toFixed(2)}, thetaExpected ${s.thetaExpected.toFixed(2)})`
  return `no answer (${failureText(s.ctx.backend.name, answer.failure ?? { kind: 'parse', detail: 'no answer to the question' })})`
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

/** Settles the loop's counts (see `settled`) and shows them. */
async function settle($: EngineInterface, loop: Loop, raised: boolean): Promise<void> {
  const { cell, e } = loop
  const main = e.agentId === undefined
  const record = await update(cell, (r) => settled(r ?? fresh(main ? e.turnId : ''), e.index, raised))
  showCounts($, main ? record : null, main ? undefined : record)
}

/** The latest agent whose calls failed, for the status line (lost on a reload, until its next failure). */
let latestAgent: Strain | null = null

/**
 * Shows the counts: `main` is the main agent's record (null: none to show),
 * `agent` an agent's, which then is the latest one shown; `undefined` leaves
 * what is shown for it.
 */
function showCounts($: EngineInterface, main: Strain | null, agent: Strain | undefined): void {
  const show = (line: string | undefined) => $.ui.status(line)
  if (agent === undefined && main === null) latestAgent = null
  if (agent !== undefined) latestAgent = agent
  else setStatus('escalation', countsText(main), show)
  setStatus('agentEscalation', countsText(latestAgent, 'agent '), show)
}

/** `failed 2, blocked 1, raised 1`: the counts that are not zero; null when all are. */
function countsText(record: Strain | null, prefix = ''): string | null {
  if (record === null) return null
  const parts = [
    record.failures > 0 ? `failed ${record.failures}` : '',
    record.hookBlocks > 0 ? `blocked ${record.hookBlocks}` : '',
    record.raises > 0 ? `raised ${record.raises}` : '',
  ].filter((part) => part !== '')
  return parts.length === 0 ? null : `${prefix}${parts.join(', ')}`
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

/** The start of a text for the debug log, secrets masked. */
function quote(text: string): string {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim()
  return JSON.stringify(flat.length > 40 ? `${flat.slice(0, 40)}...` : flat)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
