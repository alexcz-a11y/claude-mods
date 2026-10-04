// Feature: the main agent's effort, decided again while a turn runs (#5).
//
// Every N steps of a turn, the decision model is asked again how much
// reasoning the rest of the work needs. The question goes out the moment a
// tool call of the main agent starts (`tool.call`), so it is answered while
// the tool runs; the next step (`turn.step`, a layer above the core) takes
// the answer and writes the turn's plan, which the core then sends.
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
import { numberIn, type Ctx } from '../core/setup.ts'
import { failureText, setStatus } from '../core/status.ts'
import { defineSwitch, isOn } from '../core/switches.ts'

const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const
const MIDTURN = { plugin: 'dispatch-pilot', key: 'midturn' } as const
const MAIN_STEP = { plugin: 'dispatch-pilot', key: 'mainStep' } as const
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
  failures: number
  hookBlocks: number
  recent: StepRecord[]
}

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

/** A re-decision on its way: asked for step `forStep`; `answer` never rejects. */
type InFlight = { forStep: number; reason: string; sentAt: number; answer: Promise<Asked>; settled: Asked | null }
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
  const settings: Settings = {
    ctx,
    every: Math.round(numberIn(ctx.options.rejudgeEvery, 0, 50, 3)),
    waitMs: Math.round(numberIn(ctx.options.rejudgeWaitMs, 0, 2000, 300)),
    rules: {
      thetaUp: numberIn(ctx.options.thetaUp, 0, 1, 0.4),
      thetaDown: numberIn(ctx.options.thetaDown, 0, 1, 0.6),
      thetaMax: ctx.config.thetaMax,
      holdSteps: Math.round(numberIn(ctx.options.holdSteps, 0, 50, 3)),
    },
    limits: { steps: 4, tokens: ctx.config.context.tokens },
  }

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
    let step: MainStep | null = null
    try {
      step = (await $.state.get(MAIN_STEP)).value ?? null
      if (step !== null) await launch($, settings, step, e.tool, toolDetail(e))
    } catch (error) {
      $.ui.log(`midturn: ${describe(error)}`, { to: 'debug' })
    }
    const result = await next(e)
    const blocked = blockedByHook.delete(e.tool_use_id)
    if (step !== null) {
      try {
        const ended: ToolEnd = { name: e.tool, detail: toolDetail(e), outcome: outcomeOf(e.tool, result, blocked) }
        const at = step.index
        const ref = { ...MIDTURN, id: turnKey(step.turnId, undefined) }
        const cell: Cell<MidturnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
        await update(cell, (r) => withTool(r ?? fresh(), at, ended))
      } catch (error) {
        $.ui.log(`midturn: ${describe(error)}`, { to: 'debug' })
      }
    }
    return result
  })

  on('turn.step', { turnId: /(?:)/ }, async function* ($, e, next) {
    if (e.agentId !== undefined || !isOn(SWITCH)) return yield* next(e)
    const key = turnKey(e.turnId, undefined)
    try {
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

/** Asks again about the turn's effort, for the step after `step`, when this tool call is a reason to. */
async function launch($: EngineInterface, s: Settings, step: MainStep, tool: string, detail: string): Promise<void> {
  const upcoming = step.index + 1
  const reason = PHASE_TOOLS.has(tool) ? tool : s.every > 0 && upcoming % s.every === 0 ? `every ${s.every} steps` : null
  if (reason === null) return
  const key = turnKey(step.turnId, undefined)
  const [{ value: turn }, { value: record }, { value: lock = null }, sentAt] = await Promise.all([
    $.state.get({ ...TURNS, id: key }),
    $.state.get({ ...MIDTURN, id: key }),
    $.state.get(LOCK),
    $.clock.now(),
  ])
  if (turn === undefined || turn.decisions < 1 || lock !== null || record === undefined || record.engine === null) return
  if (record.askedFor === upcoming || inFlight.get(key)?.forStep === upcoming) return
  const current = higherEffort(turn.effort ?? record.engine, turn.floor) as Effort
  const input: MidturnInput = {
    message: turn.prompt,
    step: upcoming,
    current_effort: current,
    counts: { judgments: turn.decisions, changes: turn.changes, failures: record.failures, hook_blocks: record.hookBlocks },
    recent_steps: summaries(record, step.index, key, { name: tool, detail }, contentLanguage(turn.prompt)),
  }
  const request = mergeParts(midturnState(input, s.limits), [midturnEffortPart(s.ctx.ask)])
  const io = {
    fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
    sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
  }
  const entry: InFlight = { forStep: upcoming, reason, sentAt, answer: s.ctx.backend.ask(io, request, s.ctx.config.timeoutMs), settled: null }
  void entry.answer.then((asked) => {
    entry.settled = asked
  })
  inFlight.set(key, entry)
  const ref = { ...MIDTURN, id: key }
  const cell: Cell<MidturnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
  await update(cell, (r) => ({ ...(r ?? fresh()), askedFor: upcoming }))
}

/**
 * Takes the re-decision meant for this step, if any, and writes what it
 * decides into the turn's plan. An answer not back yet gets `waitMs` more;
 * still none, the step keeps the effort it had and the answer stays for a
 * later step. Resolves to what the status line should add: `late`, or why
 * there is no answer; null otherwise.
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
  if (asked === null) return 'late'
  inFlight.delete(key)
  const engine = isEffort(e.effort) ? e.effort : null
  const [{ value: turn }, { value: record }, { value: lock = null }] = await Promise.all([
    $.state.get({ ...TURNS, id: key }),
    $.state.get({ ...MIDTURN, id: key }),
    $.state.get(LOCK),
  ])
  if (turn === undefined || record === undefined || lock !== null || engine === null) return null
  if (!asked.ok) return failureText(s.ctx.backend.name, asked.failure)
  const reading = readEffort(answersFor(midturnEffortPart(s.ctx.ask), asked.answers)[MIDTURN_LEVEL])
  if (reading === null) return failureText(s.ctx.backend.name, { kind: 'parse', detail: 'no effort answer' })
  const current = higherEffort(turn.effort ?? engine, turn.floor) as Effort
  const sinceRaise = record.raisedAt === null ? null : e.index - record.raisedAt
  const position = { current, sinceRaise, atLeast: turn.floor }
  const verdict = judgeMidturn(reading, position, s.rules)
  const ref = { ...TURNS, id: key }
  const cell: Cell<TurnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
  await update(cell, (r) => decided(r ?? turn, current, verdict.effort))
  await recordDecision(
    { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
    (line) => $.ui.log(line, { to: 'debug' }),
    {
      feature: SWITCH,
      outcome: `effort ${verdict.effort} ${verdict.effort === current ? '(kept)' : `(was ${current})`}`,
      about: `step ${e.index} (${pending.reason})`,
      reason: `${describeReading(reading)}; ${verdictReason(verdict, position, s.rules)}`,
    },
  )
  if (verdict.why === 'up') {
    const own = { ...MIDTURN, id: key }
    const ownCell: Cell<MidturnRecord> = { get: () => $.state.get(own), set: (value, options) => $.state.set(own, value, options) }
    await update(ownCell, (r) => ({ ...(r ?? fresh()), raisedAt: e.index }))
  }
  return null
}

/**
 * The feature's status segment: the turn's steps, decisions and level
 * changes, once the turn has been re-decided (so a short turn stays quiet);
 * none at a turn's first step.
 */
function segment(record: MidturnRecord, turn: TurnRecord | undefined, note: string | null): string | null {
  if (record.askedFor === null || turn === undefined) return null
  return `step ${record.steps}, judged ${turn.decisions}, changed ${turn.changes}${note === null ? '' : ` (${note})`}`
}

function fresh(): MidturnRecord {
  return { steps: 0, engine: null, askedFor: null, raisedAt: null, failures: 0, hookBlocks: 0, recent: [] }
}

/**
 * The latest steps as the decision model reads them, oldest first: each
 * step's text and its tool calls with how they ended. The step running now
 * comes last, its text as streamed so far, the call just starting in it
 * marked running.
 */
function summaries(record: MidturnRecord, index: number, key: string, starting: { name: string; detail: string }, language: 'en' | 'zh'): MidturnInput['recent_steps'] {
  const live = streamed.get(key)
  const now = record.recent.find((step) => step.index === index)
  const steps = [
    ...record.recent.filter((step) => step.index < index).map((step) => ({ text: step.text, tools: step.tools.map((t) => ({ ...t })) as { name: string; detail: string; outcome: Outcome }[] })),
    {
      text: live?.index === index ? live.text : (now?.text ?? ''),
      tools: [...(now?.tools ?? []), { ...starting, outcome: 'running' as const }] as { name: string; detail: string; outcome: Outcome }[],
    },
  ]
  return steps.map((step) => ({ assistant_text: step.text, tools: step.tools.map((t) => ({ name: t.name, result: resultLine(t.outcome, t.detail, language) })) }))
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

/** Every level's probability and the backend's confidence, for the decision log. */
function describeReading(reading: EffortReading): string {
  const levels = EFFORTS.map((level, i) => `${level} ${(reading.probabilities[i] ?? 0).toFixed(2)}`).join(', ')
  return `p ${levels}; confidence ${reading.confidence === null ? 'n/a' : reading.confidence.toFixed(2)}`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
