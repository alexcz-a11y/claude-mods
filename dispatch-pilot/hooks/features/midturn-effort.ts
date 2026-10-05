// Feature: the main agent's effort, decided again while a turn runs (#5).
//
// Every N steps of a turn, and when the main agent dispatches an agent,
// starts a Workflow or loads a skill, the decision model is asked again how
// much reasoning the rest of the work needs. The question goes out the moment
// a tool call of the main agent starts (`tool.call`), so it is answered while
// the tool runs; the next step (`turn.step`, a layer above the core) takes
// the answer, waits briefly when it is not back yet, and writes the turn's
// plan, which the core then sends. Raising needs thetaUp; lowering needs
// thetaDown, goes one level at a time and waits holdSteps after a raise (a
// forced one too: the escalation feature, #7, marks it in the turn's plan).
//
// The counts the question carries (failed calls, hook blocks) are the
// escalation feature's: one counter for the turn, since the counts last
// started over.
//
// Measured on 2.1.289: the engine runs a step's tool calls while the response
// still streams, so `tool.call` fires inside the step, before the step's
// stream ends. This layer keeps the text of the step as it streams.

import type { EngineInterface, HttpInit, On } from 'claude-code'
import { describeAsked, errorText, within, type Asked } from '../decision/backend.ts'
import { messageText } from '../decision/context.ts'
import { higherEffort, isEffort, readEffort, readingText, type Effort } from '../decision/effort.ts'
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
  type MidturnCounts,
  type MidturnInput,
  type MidturnLimits,
  type MidturnRules,
  type Outcome,
} from '../decision/midturn.ts'
import { answersFor, mergeParts } from '../decision/system-one.ts'
import { recordDecision } from '../core/decisions.ts'
import { wasBlocked } from '../core/outcomes.ts'
import { floorHeld, MAIN, redecided, turnKey, update, type Cell, type TurnRecord } from '../core/plans.ts'
import type { Ctx } from '../core/setup.ts'
import { failureText, setStatus } from '../core/status.ts'
import { defineSwitch, isOn } from '../core/switches.ts'

const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const
const MIDTURN = { plugin: 'dispatch-pilot', key: 'midturn' } as const
const MAIN_STEP = { plugin: 'dispatch-pilot', key: 'mainStep' } as const
const FAILURES = { plugin: 'dispatch-pilot', key: 'escalation', id: MAIN } as const
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
  recent: StepRecord[]
}

/** Steps kept in a turn's record. */
const MAX_RECENT = 16

/** Calls that start a new phase of the work (dispatch an agent, start a Workflow, load a skill): each re-decides. */
const PHASE_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'Workflow', 'Skill'])

/** What the feature runs with: the shared ctx and the options it reads. */
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
 * how long it took.
 */
type InFlight = { forStep: number; reason: string; answer: Promise<Asked>; settled: Asked | null; ms: number }
/** Re-decisions on their way, by turn key. Promises cannot live in $.state: a reload drops them (the step then keeps its effort). */
const inFlight = new Map<string, InFlight>()
/** The text of the main step streaming now, by turn key. */
const streamed = new Map<string, { index: number; block: number; text: string }>()

export function registerMidturnEffort(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: "re-decides the main agent's effort while a turn runs", segments: ['midturn'] })
  const settings: Settings = { ctx, ...ctx.config.midturn }

  on('tool.call', { tool: /(?:)/ }, async ($, e, next) => {
    // The main agent's own calls only: not a dispatched agent's, nor another plugin's $.tool.call.
    if (e.agentId !== undefined || next.origin.plugin !== 'engine' || !isOn(SWITCH)) return next(e)
    const detail = toolDetail(e)
    let step: MainStep | null = null
    try {
      step = (await $.state.get(MAIN_STEP)).value ?? null
      if (step !== null) await launch($, settings, step, { name: e.tool, detail })
    } catch (error) {
      $.ui.log(`midturn: ${errorText(error)}`, { to: 'debug' })
    }
    const result = await next(e)
    if (step !== null) {
      try {
        const ended: ToolEnd = { name: e.tool, detail, outcome: outcomeOf(e.tool, result, wasBlocked(e.tool_use_id)) }
        const at = step.index
        const ref = { ...MIDTURN, id: turnKey(step.turnId, undefined) }
        const cell: Cell<MidturnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
        await update(cell, (r) => withTool(r ?? newRecord(), at, ended))
      } catch (error) {
        $.ui.log(`midturn: ${errorText(error)}`, { to: 'debug' })
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
      const note = await takeAnswer($, settings, e, key)
      const engine = isEffort(e.effort) ? e.effort : null
      await $.state.set(MAIN_STEP, { turnId: e.turnId, index: e.index })
      const ref = { ...MIDTURN, id: key }
      const cell: Cell<MidturnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
      const record = await update(cell, (r) => ({ ...(r === undefined || e.index === 0 ? newRecord() : r), steps: e.index + 1, engine }))
      const { value: turn } = await $.state.get({ ...TURNS, id: key })
      setStatus('midturn', segment(record, turn, note), (line) => $.ui.status(line))
    } catch (error) {
      $.ui.log(`midturn: ${errorText(error)}`, { to: 'debug' })
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
      await update(cell, (r) => withText(r ?? newRecord(), e.index, text))
    } catch (error) {
      $.ui.log(`midturn: ${errorText(error)}`, { to: 'debug' })
    }
    return result
  })
}

/**
 * Asks again about the turn's effort, for the step after `step`, when a call
 * starting is a reason to: a phase tool, or a step index that is a multiple of
 * `every`. Once per step; the answer is left for that step to take.
 */
async function launch($: EngineInterface, s: Settings, step: MainStep, starting: Starting): Promise<void> {
  const upcoming = step.index + 1
  const key = turnKey(step.turnId, undefined)
  const [{ value: turn }, { value: record }, { value: lock = null }, { value: failures }, sentAt] = await Promise.all([
    $.state.get({ ...TURNS, id: key }),
    $.state.get({ ...MIDTURN, id: key }),
    $.state.get(LOCK),
    $.state.get(FAILURES),
    $.clock.now(),
  ])
  // Only a turn the person's own message started is re-decided, whether its start was decided or not (that request
  // may have failed: then from the session's own effort); never without a decision model set up (every request would
  // fail at once).
  if (turn === undefined || turn.person !== true || lock !== null || record === undefined || record.engine === null || s.ctx.backend.configured === false) return
  const reason = PHASE_TOOLS.has(starting.name) ? starting.name : s.every > 0 && upcoming % s.every === 0 ? `every ${s.every} steps` : null
  if (reason === null || record.askedFor === upcoming || inFlight.get(key)?.forStep === upcoming) return
  const input: MidturnInput = {
    message: turn.prompt,
    step: upcoming,
    current_effort: higherEffort(turn.effort ?? record.engine, floorHeld(turn, upcoming)) as Effort,
    counts: countsOf(turn, step.turnId, failures),
    recent_steps: summaries(record, step.index, key, starting, contentLanguage(turn.prompt)),
  }
  const request = mergeParts(midturnState(input, s.limits), [midturnEffortPart(s.ctx.ask)])
  const io = {
    fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
    sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
  }
  const asking = s.ctx.backend.ask(io, request, s.ctx.config.timeoutMs)
  const entry: InFlight = { forStep: upcoming, reason, answer: asking, settled: null, ms: 0 }
  entry.answer = asking.then(async (answered) => {
    entry.ms = (await $.clock.now()) - sentAt
    entry.settled = answered
    return answered
  })
  inFlight.set(key, entry)
  const ref = { ...MIDTURN, id: key }
  const cell: Cell<MidturnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
  await update(cell, (r) => ({ ...(r ?? newRecord()), askedFor: upcoming }))
}

/**
 * The turn's counts as the decision model reads them: its decisions and level
 * changes, and the failed calls and hook blocks the escalation feature counted
 * for it, since its counts last started over (a forced raise, or failures
 * found expected).
 */
function countsOf(turn: TurnRecord, turnId: string, failures: { turnId: string; failures: number; hookBlocks: number; base: { failures: number; hookBlocks: number } } | undefined): MidturnCounts {
  const counted = failures !== undefined && failures.turnId === turnId
  return {
    judgments: turn.decisions,
    changes: turn.changes,
    failures: counted ? failures.failures - failures.base.failures : 0,
    hook_blocks: counted ? failures.hookBlocks - failures.base.hookBlocks : 0,
  }
}

/**
 * Takes the re-decision meant for this step, if any, and writes what it
 * decides into the turn's plan. An answer not back yet gets `waitMs` more;
 * still none, the step keeps the effort it had and the answer stays for a
 * later step. Resolves to what the status line should add: `late`, or why
 * there is no answer; null otherwise.
 */
async function takeAnswer($: EngineInterface, s: Settings, e: { index: number; effort?: unknown }, key: string): Promise<string | null> {
  const pending = inFlight.get(key)
  if (pending === undefined || pending.forStep > e.index) return null
  let asked = pending.settled
  if (asked === null) {
    asked = await within((ms, signal) => $.clock.sleep(ms, { signal }), pending.answer, s.waitMs, null)
  }
  if (asked === null) return 'late'
  inFlight.delete(key)
  $.ui.log(`request [midturn.${MIDTURN_LEVEL}] for step ${pending.forStep} (${pending.reason}) to ${s.ctx.backend.name}: ${describeAsked(asked, pending.ms)}`, { to: 'debug' })
  const engine = isEffort(e.effort) ? e.effort : null
  const [{ value: turn }, { value: lock = null }] = await Promise.all([$.state.get({ ...TURNS, id: key }), $.state.get(LOCK)])
  if (turn === undefined || lock !== null || engine === null) return null
  const floor = floorHeld(turn, e.index)
  const current = higherEffort(turn.effort ?? engine, floor) as Effort
  const reading = asked.ok ? readEffort(answersFor(midturnEffortPart(s.ctx.ask), asked.answers)[MIDTURN_LEVEL]) : null
  if (reading === null) return asked.ok ? failureText(s.ctx.backend.name, { kind: 'parse', detail: 'no effort answer' }) : failureText(s.ctx.backend.name, asked.failure)

  const ref = { ...TURNS, id: key }
  const turnCell: Cell<TurnRecord> = { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
  const sinceRaise = turn.raisedAt == null ? null : e.index - turn.raisedAt
  const position = { current, sinceRaise, atLeast: floor }
  const verdict = judgeMidturn(reading, position, s.rules)
  await update(turnCell, (r) => redecided(r ?? turn, current, verdict.effort, e.index))
  await recordDecision({ get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) }, (line) => $.ui.log(line, { to: 'debug' }), {
    feature: SWITCH,
    outcome: `effort ${verdict.effort} ${verdict.effort === current ? '(kept)' : `(was ${current})`}`,
    about: `step ${e.index} (${pending.reason})`,
    reason: `${readingText(reading)}; ${verdictReason(verdict, position, s.rules)}`,
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

function newRecord(): MidturnRecord {
  return { steps: 0, engine: null, askedFor: null, recent: [] }
}

/**
 * The latest steps as the decision model reads them, oldest first: each
 * step's text and its tool calls with how they ended. Step `index` comes
 * last, its text as streamed so far, the call `starting` in it marked running.
 */
function summaries(record: MidturnRecord, index: number, key: string, starting: Starting, language: 'en' | 'zh'): MidturnInput['recent_steps'] {
  const live = streamed.get(key)
  const now = record.recent.find((step) => step.index === index)
  const line = (t: { name: string; detail: string; outcome: Outcome }) => ({ name: t.name, result: resultLine(t.outcome, t.detail, language) })
  return [
    ...record.recent.filter((step) => step.index < index).map((step) => ({ assistant_text: step.text, tools: step.tools.map(line) })),
    {
      assistant_text: live?.index === index ? live.text : (now?.text ?? ''),
      tools: [...(now?.tools ?? []).map(line), line({ ...starting, outcome: 'running' })],
    },
  ]
}

/** The record with a tool call's ending added to its step. */
function withTool(record: MidturnRecord, index: number, ended: ToolEnd): MidturnRecord {
  const at = record.recent.findIndex((step) => step.index === index)
  const step = at >= 0 ? (record.recent[at] as StepRecord) : { index, text: '', tools: [] }
  const recent = [...record.recent]
  if (at >= 0) recent[at] = { ...step, tools: [...step.tools, ended] }
  else recent.push({ ...step, tools: [ended] })
  return { ...record, recent: recent.sort((a, b) => a.index - b.index).slice(-MAX_RECENT) }
}

/** The record with a step's text, once the step has streamed whole. */
function withText(record: MidturnRecord, index: number, text: string): MidturnRecord {
  const at = record.recent.findIndex((step) => step.index === index)
  const recent = [...record.recent]
  if (at >= 0) recent[at] = { ...(recent[at] as StepRecord), text }
  else recent.push({ index, text, tools: [] })
  return { ...record, recent: recent.sort((a, b) => a.index - b.index).slice(-MAX_RECENT) }
}
