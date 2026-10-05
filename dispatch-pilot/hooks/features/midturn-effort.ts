// Feature: the main agent's effort, decided again while a turn runs (#5).
//
// Every N steps of a turn, and when the main agent dispatches an agent,
// starts a Workflow or loads a skill, the decision model is asked again how
// much reasoning the rest of the work needs. The question goes out the moment
// a tool call of the main agent starts (`tool.call`), so it is answered while
// the tool runs; the next step (`turn.step`, a layer above the core) takes
// the answer, waits briefly when it is not back yet, and writes the turn's
// plan, which the core then sends. Raising needs thetaUp; lowering needs
// thetaDown, goes one level at a time and waits holdSteps after a raise.
//
// Another feature can ask for a re-decision (`demand`, #7 when the turn is
// stuck): it goes out at the next chance with the demand's `trouble` in the
// state, and the turn goes at least to the demand's level, answer or not.
//
// Measured on 2.1.289: the engine runs a step's tool calls while the response
// still streams, so `tool.call` fires inside the step, before the step's
// stream ends. This layer keeps the text of the step as it streams.

import type { EngineInterface, HttpInit, On } from 'claude-code'
import type { Asked } from '../decision/backend.ts'
import { messageText } from '../decision/context.ts'
import { EFFORTS, higherEffort, isEffort, readEffort, type Effort, type EffortReading } from '../decision/effort.ts'
import {
  contentLanguage,
  judgeMidturn,
  midturnEffortPart,
  midturnState,
  MIDTURN_LEVEL,
  outcomeOf,
  resultLine,
  toolDetail,
  verdictReason,
  type MidturnInput,
  type MidturnLimits,
  type MidturnRules,
  type Outcome,
} from '../decision/midturn.ts'
import { answersFor, mergeParts } from '../decision/system-one.ts'
import { recordDecision } from '../core/decisions.ts'
import { revise, turnKey, update, type Cell, type TurnRecord } from '../core/plans.ts'
import type { Ctx } from '../core/setup.ts'
import { failureText, setStatus } from '../core/status.ts'
import { defineSwitch, isOn } from '../core/switches.ts'

const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const
const MIDTURN = { plugin: 'dispatch-pilot', key: 'midturn' } as const
const MAIN_STEP = { plugin: 'dispatch-pilot', key: 'mainStep' } as const
const DEMAND = { plugin: 'dispatch-pilot', key: 'demand' } as const
const LOCK = { plugin: 'dispatch-pilot', key: 'lock' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

/** The feature's switch (`/dp midturn-effort on|off`). */
const SWITCH = 'midturn-effort'

type ToolEnd = { name: string; detail: string; outcome: Exclude<Outcome, 'running'> }
type StepRecord = { index: number; text: string; tools: ToolEnd[] }
/** The feature's own record of a main turn (`midturn` in types/index.d.ts). */
type MidturnRecord = {
  steps: number
  engine: Effort | null
  askedFor: number | null
  raisedAt: number | null
  served: number | null
  failures: number
  hookBlocks: number
  recent: StepRecord[]
}
/** Another feature's demand for a re-decision (`demand` in types/index.d.ts). */
type Demand = { trouble: string; atLeast: Effort | null; at: number }

/** Steps kept in a turn's record. */
const MAX_RECENT = 16

/** Calls that start a new phase of the work (dispatch an agent, start a Workflow, load a skill): each re-decides. */
const PHASE_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'Workflow', 'Skill'])

/** What the feature runs with: the shared ctx and its own options. */
type Settings = {
  ctx: Ctx
  /** Re-decide at every step whose index is a multiple of this; 0 for never. */
  every: number
  rules: MidturnRules
  /** How long a step waits for a re-decision not back yet. */
  waitMs: number
  limits: MidturnLimits
}

/** A step of the main agent: its turn and its index. */
type MainStep = { turnId: string; index: number }
/** A tool call as it starts: its name and what it works on. */
type Starting = { name: string; detail: string }

/**
 * A re-decision on its way: asked for step `forStep` (`reason` says why);
 * `answer` never rejects, and once it resolves `settled` holds it and `ms`
 * how long it took. `atLeast`: the level a demand asked for, until applied;
 * `demand`: that demand's `at`.
 */
type InFlight = {
  forStep: number
  reason: string
  answer: Promise<Asked>
  settled: Asked | null
  ms: number
  atLeast: Effort | null
  demand: number | null
}
/** Re-decisions on their way, by turn key. Promises cannot live in $.state: a reload drops them (the step then keeps its effort). */
const inFlight = new Map<string, InFlight>()
/** The text of the main step streaming now, by turn key. */
const streamed = new Map<string, { index: number; block: number; text: string }>()
/**
 * Calls a PreToolUse settings hook refused, by tool_use_id: `tool.call` then
 * only sees an error, the hook's reason as its text (seam notes §1 item 8).
 * Each id is taken back when its call ends.
 */
const blockedByHook = new Set<string>()

export function registerMidturnEffort(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: "re-decides the main agent's effort while a turn runs", segments: ['midturn'] })
  const settings: Settings = { ctx, ...ctx.config.midturn }

  // Wraps the PreToolUse settings hooks (they run beneath, as this event's core) to see which calls they refuse.
  on('classic.PreToolUse', { tool: /(?:)/ }, async ($, e, next) => {
    const decided = await next(e)
    if (decided.deny !== undefined && e.tool_use_id) blockedByHook.add(e.tool_use_id)
    return decided
  })

  on('tool.call', { tool: /(?:)/ }, async ($, e, next) => {
    // The main agent's own calls only: not a dispatched agent's, nor another plugin's $.tool.call.
    if (e.agentId !== undefined || next.origin.plugin !== 'engine' || !isOn(SWITCH)) {
      const result = await next(e)
      blockedByHook.delete(e.tool_use_id)
      return result
    }
    const detail = toolDetail(e)
    let step: MainStep | null = null
    try {
      step = (await $.state.get(MAIN_STEP)).value ?? null
      if (step !== null) await launch($, settings, step, { name: e.tool, detail })
    } catch (error) {
      $.ui.log(`midturn: ${describe(error)}`, { to: 'debug' })
    }
    const result = await next(e)
    const blocked = blockedByHook.delete(e.tool_use_id)
    if (step !== null) {
      try {
        const ended: ToolEnd = { name: e.tool, detail, outcome: outcomeOf(e.tool, result, blocked) }
        const at = step.index
        const ref = { ...MIDTURN, id: turnKey(step.turnId, undefined) }
        const cell: Cell<MidturnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
        await update(cell, (r) => withTool(r ?? fresh(), at, ended))
        // A demand written while the call ran (by a hook beneath this one) goes out now, with the call's ending.
        await launch($, settings, step, null)
      } catch (error) {
        $.ui.log(`midturn: ${describe(error)}`, { to: 'debug' })
      }
    }
    return result
  })

  on('turn.step', { turnId: /(?:)/ }, async function* ($, e, next) {
    if (e.agentId !== undefined || !isOn(SWITCH)) return yield* next(e)
    const key = turnKey(e.turnId, undefined)
    if (e.index === 0) {
      // A new turn: what is left of earlier turns (a text, an answer never taken) is dropped.
      for (const old of [...streamed.keys()]) if (old !== key) streamed.delete(old)
      for (const old of [...inFlight.keys()]) if (old !== key) inFlight.delete(old)
    }
    try {
      // A demand written after the last call ended goes out now; this step waits for it like any other.
      if (e.index > 0) await launch($, settings, { turnId: e.turnId, index: e.index - 1 }, null)
      const note = await settle($, settings, e, key)
      const engine = isEffort(e.effort) ? e.effort : null
      await $.state.set(MAIN_STEP, { turnId: e.turnId, index: e.index })
      const ref = { ...MIDTURN, id: key }
      const cell: Cell<MidturnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
      const record = await update(cell, (r) => ({ ...(r === undefined || e.index === 0 ? fresh() : r), steps: e.index + 1, engine }))
      const { value: turn } = await $.state.get({ ...TURNS, id: key })
      setStatus('midturn', segment(record, turn, note), (line) => $.ui.status(line))
    } catch (error) {
      $.ui.log(`midturn: ${describe(error)}`, { to: 'debug' })
    }
    streamed.set(key, { index: e.index, block: -1, text: '' })
    const stream = next(e)
    for await (const chunk of stream) {
      if (chunk.kind === 'text') {
        const live = streamed.get(key)
        if (live !== undefined && live.index === e.index) {
          live.text += live.block !== -1 && live.block !== chunk.index ? `\n${chunk.text}` : chunk.text
          live.block = chunk.index
        }
      }
      yield chunk
    }
    const result = await stream.result
    try {
      const text = messageText(result.answer, settings.limits.tokens)
      const ref = { ...MIDTURN, id: key }
      const cell: Cell<MidturnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
      await update(cell, (r) => withText(r ?? fresh(), e.index, text))
    } catch (error) {
      $.ui.log(`midturn: ${describe(error)}`, { to: 'debug' })
    }
    return result
  })
}

/**
 * Asks again about the turn's effort, for the step after `step`, when there
 * is a reason to: a demand not asked about yet; else, for a call `starting`,
 * a phase tool or a step index that is a multiple of `every`. Once per step
 * (a demand once per `at`); the answer is left for that step to take.
 */
async function launch($: EngineInterface, s: Settings, step: MainStep, starting: Starting | null): Promise<void> {
  const upcoming = step.index + 1
  const key = turnKey(step.turnId, undefined)
  const [{ value: turn }, { value: record }, { value: lock = null }, { value: asked }, sentAt] = await Promise.all([
    $.state.get({ ...TURNS, id: key }),
    $.state.get({ ...MIDTURN, id: key }),
    $.state.get(LOCK),
    $.state.get({ ...DEMAND, id: key }),
    $.clock.now(),
  ])
  if (turn === undefined || turn.decisions < 1 || lock !== null || record === undefined || record.engine === null) return
  const flying = inFlight.get(key)
  const demand: Demand | null = asked !== undefined && asked.at !== record.served && flying?.demand !== asked.at ? asked : null
  const reason =
    demand !== null ? 'trouble' : starting === null ? null : PHASE_TOOLS.has(starting.name) ? starting.name : s.every > 0 && upcoming % s.every === 0 ? `every ${s.every} steps` : null
  if (reason === null) return
  if (demand === null && (record.askedFor === upcoming || flying?.forStep === upcoming)) return
  const current = higherEffort(turn.effort ?? record.engine, turn.floor) as Effort
  const input: MidturnInput = {
    message: turn.prompt,
    step: upcoming,
    current_effort: current,
    counts: { judgments: turn.decisions, changes: turn.changes, failures: record.failures, hook_blocks: record.hookBlocks },
    recent_steps: summaries(record, step.index, key, starting, contentLanguage(turn.prompt)),
    ...(demand !== null ? { trouble: demand.trouble } : {}),
  }
  const request = mergeParts(midturnState(input, s.limits), [midturnEffortPart(s.ctx.ask, { trouble: demand !== null })])
  const io = {
    fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
    sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
  }
  const asking = s.ctx.backend.ask(io, request, s.ctx.config.timeoutMs)
  const entry: InFlight = {
    forStep: upcoming,
    reason,
    answer: asking,
    settled: null,
    ms: 0,
    atLeast: higherEffort(demand?.atLeast ?? null, flying?.forStep === upcoming ? flying.atLeast : null),
    demand: demand?.at ?? flying?.demand ?? null,
  }
  entry.answer = asking.then(async (answered) => {
    entry.ms = (await $.clock.now()) - sentAt
    entry.settled = answered
    return answered
  })
  inFlight.set(key, entry)
  const ref = { ...MIDTURN, id: key }
  const cell: Cell<MidturnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
  await update(cell, (r) => ({ ...(r ?? fresh()), askedFor: upcoming, served: demand?.at ?? r?.served ?? null }))
}

/**
 * Takes the re-decision meant for this step, if any, and writes what it
 * decides into the turn's plan. An answer not back yet gets `waitMs` more;
 * still none, the step keeps the effort it had (lifted to a demand's level)
 * and the answer stays for a later step. Resolves to what the status line
 * should add: `late`, or why there is no answer; null otherwise.
 */
async function settle($: EngineInterface, s: Settings, e: { index: number; effort?: unknown }, key: string): Promise<string | null> {
  const pending = inFlight.get(key)
  if (pending === undefined || pending.forStep > e.index) return null
  let asked = pending.settled
  if (asked === null) {
    const stop = new AbortController()
    const timer = $.clock.sleep(s.waitMs, { signal: stop.signal }).then(
      () => null,
      () => null,
    )
    asked = await Promise.race([pending.answer, timer])
    stop.abort()
  }
  if (asked !== null) {
    inFlight.delete(key)
    $.ui.log(`request [midturn.${MIDTURN_LEVEL}] for step ${pending.forStep} (${pending.reason}) to ${s.ctx.backend.name}: ${describeAsked(asked, pending.ms)}`, { to: 'debug' })
  }
  const engine = isEffort(e.effort) ? e.effort : null
  const [{ value: turn }, { value: record }, { value: lock = null }] = await Promise.all([
    $.state.get({ ...TURNS, id: key }),
    $.state.get({ ...MIDTURN, id: key }),
    $.state.get(LOCK),
  ])
  if (turn === undefined || record === undefined || lock !== null || engine === null) return null
  const current = higherEffort(turn.effort ?? engine, turn.floor) as Effort
  const ref = { ...TURNS, id: key }
  const turnCell: Cell<TurnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
  const own = { ...MIDTURN, id: key }
  const ownCell: Cell<MidturnRecord> = { get: () => $.state.get(own), set: (value, options) => $.state.set(own, value, options) }
  const log: Cell<{ n: number; feature: string; outcome: string; about: string; reason: string }[]> = {
    get: () => $.state.get(DECISIONS),
    set: (value, options) => $.state.set(DECISIONS, value, options),
  }
  const about = `step ${e.index} (${pending.reason})`

  const reading = asked !== null && asked.ok ? readEffort(answersFor(midturnEffortPart(s.ctx.ask), asked.answers)[MIDTURN_LEVEL]) : null
  const note =
    asked === null
      ? 'late'
      : !asked.ok
        ? failureText(s.ctx.backend.name, asked.failure)
        : reading === null
          ? failureText(s.ctx.backend.name, { kind: 'parse', detail: 'no effort answer' })
          : null
  if (reading === null) {
    // No answer (yet): a demand's level still holds from this step on.
    const lifted = pending.atLeast === null ? current : (higherEffort(current, pending.atLeast) as Effort)
    pending.atLeast = null
    if (lifted !== current) {
      await update(turnCell, (r) => moved(r ?? turn, current, lifted))
      await update(ownCell, (r) => ({ ...(r ?? fresh()), raisedAt: e.index }))
      await recordDecision(log, (line) => $.ui.log(line, { to: 'debug' }), {
        feature: SWITCH,
        outcome: `effort ${lifted} (was ${current})`,
        about,
        reason: `no answer (${note ?? 'none'}); lifted to ${lifted}, the least asked for`,
      })
    }
    return note
  }

  const sinceRaise = record.raisedAt === null ? null : e.index - record.raisedAt
  const position = { current, sinceRaise, atLeast: higherEffort(turn.floor, pending.atLeast) }
  const verdict = judgeMidturn(reading, position, s.rules)
  await update(turnCell, (r) => decided(r ?? turn, current, verdict.effort))
  if (EFFORTS.indexOf(verdict.effort) > EFFORTS.indexOf(current)) await update(ownCell, (r) => ({ ...(r ?? fresh()), raisedAt: e.index }))
  await recordDecision(log, (line) => $.ui.log(line, { to: 'debug' }), {
    feature: SWITCH,
    outcome: `effort ${verdict.effort} ${verdict.effort === current ? '(kept)' : `(was ${current})`}`,
    about,
    reason: `${describeReading(reading)}; ${verdictReason(verdict, position, s.rules)}`,
  })
  return null
}

/**
 * The feature's status segment: how many steps the turn has made, how many
 * decisions and level changes it had, once it has been re-decided (so a
 * short turn stays quiet); none at a turn's first step.
 */
function segment(record: MidturnRecord, turn: TurnRecord | undefined, note: string | null): string | null {
  if (record.askedFor === null || turn === undefined) return null
  return `steps ${record.steps}, judged ${turn.decisions}, changed ${turn.changes}${note === null ? '' : ` (${note})`}`
}

function fresh(): MidturnRecord {
  return { steps: 0, engine: null, askedFor: null, raisedAt: null, served: null, failures: 0, hookBlocks: 0, recent: [] }
}

/**
 * The latest steps as the decision model reads them, oldest first: each
 * step's text and its tool calls with how they ended. Step `index` comes
 * last, its text as streamed so far, the call `starting` in it (if any)
 * marked running.
 */
function summaries(record: MidturnRecord, index: number, key: string, starting: Starting | null, language: 'en' | 'zh'): MidturnInput['recent_steps'] {
  const live = streamed.get(key)
  const now = record.recent.find((step) => step.index === index)
  const line = (t: { name: string; detail: string; outcome: Outcome }) => ({ name: t.name, result: resultLine(t.outcome, t.detail, language) })
  return [
    ...record.recent.filter((step) => step.index < index).map((step) => ({ assistant_text: step.text, tools: step.tools.map(line) })),
    {
      assistant_text: live?.index === index ? live.text : (now?.text ?? ''),
      tools: [...(now?.tools ?? []).map(line), ...(starting === null ? [] : [line({ ...starting, outcome: 'running' })])],
    },
  ]
}

/** The record with a tool call's ending added to its step (and counted when it failed or a hook blocked it). */
function withTool(record: MidturnRecord, index: number, ended: ToolEnd): MidturnRecord {
  const at = record.recent.findIndex((step) => step.index === index)
  const step = at >= 0 ? (record.recent[at] as StepRecord) : { index, text: '', tools: [] }
  const recent = [...record.recent]
  if (at >= 0) recent[at] = { ...step, tools: [...step.tools, ended] }
  else recent.push({ ...step, tools: [ended] })
  return {
    ...record,
    failures: record.failures + (ended.outcome === 'failed' ? 1 : 0),
    hookBlocks: record.hookBlocks + (ended.outcome === 'blocked' ? 1 : 0),
    recent: recent.sort((a, b) => a.index - b.index).slice(-MAX_RECENT),
  }
}

/** The record with a step's text, once the step has streamed whole. */
function withText(record: MidturnRecord, index: number, text: string): MidturnRecord {
  const at = record.recent.findIndex((step) => step.index === index)
  const recent = [...record.recent]
  if (at >= 0) recent[at] = { ...(recent[at] as StepRecord), text }
  else recent.push({ index, text, tools: [] })
  return { ...record, recent: recent.sort((a, b) => a.index - b.index).slice(-MAX_RECENT) }
}

/** The turn's record after a re-decision: its effort set when the level moves (counted as a change), the decision counted either way. */
function decided(record: TurnRecord, current: Effort, next: Effort): TurnRecord {
  return next === current ? { ...record, decisions: record.decisions + 1 } : revise({ ...record, effort: current }, next)
}

/** The turn's record lifted to `next` with no decision behind it (a demand's level, its answer missing): a change, not a decision. */
function moved(record: TurnRecord, current: Effort, next: Effort): TurnRecord {
  return { ...revise({ ...record, effort: current }, next), decisions: record.decisions }
}

/** A request's outcome for the debug log, as the core writes its own. */
function describeAsked(asked: Asked, ms: number): string {
  if (!asked.ok) return `${asked.failure.kind}: ${asked.failure.detail} (${ms} ms)`
  const by = asked.model === null ? '' : ` by ${asked.model}`
  const tokens = asked.inputTokens === null ? '' : ` (${asked.inputTokens} input tokens)`
  return `answered in ${ms} ms${by}${tokens}`
}

/** Every level's probability and the backend's confidence, for the decision log. */
function describeReading(reading: EffortReading): string {
  const levels = EFFORTS.map((level, i) => `${level} ${(reading.probabilities[i] ?? 0).toFixed(2)}`).join(', ')
  return `p ${levels}; confidence ${reading.confidence === null ? 'n/a' : reading.confidence.toFixed(2)}`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
