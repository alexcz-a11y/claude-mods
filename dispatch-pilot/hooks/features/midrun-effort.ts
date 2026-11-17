// Feature: the main agent's effort while its turn runs (ADR 0020).
//
// A message's effort is decided once, as it is sent (features/main-effort.ts). A long turn goes through work the message
// did not show: a failure that will not go away, a result handed back, a skill's instructions, a rest that is only carrying
// out. This feature looks at the level again at such events of the run. By step count too, where the person switched that on
// (`/dp midrun-steps on`, every `midrunEverySteps` steps without a look): a run with no event otherwise keeps its message's
// level to its end, and Claude Code's task list tools, whose moves were an event, are off by default on the newer models.
//
// How a level changes in the middle of a turn (measured on Claude Code 2.1.326, DEVELOPMENT.md 「已实测的引擎行为」; ADR
// 0029): a model takes a new level only at a step with input, and a step whose new input is tool results has none. So when
// the level is to move, this feature puts one short note on the row of a tool's result as it is stored (core/notes.ts: a
// text block after the result, which the person sees as a line in the conversation): the next step then carries input,
// the core's step writer sends the turn's plan, and the level holds for the tool steps after it. The move is taken once
// the stored row holds the note (`pending` until then). A step that carries input anyway (a report delivered into the
// turn, the step after a Stop hook's feedback) needs no note.
//
//   tool.call      (bridged, core/bridge.ts; without dispatch-pilot-extras the same from `session.append`, before a call's result is stored)
//                  as a call of the main agent ends: the run's record (decision/midrun-track.ts), then at an event
//                    a failure that came back, a skill loaded, an agent's hand-back, the task list moving on:
//                                the decision model is asked (decision/midrun.ts), the code decides, the level moves
//                    the command a raise was for passes again: the level goes back, no question asked
//                    none of these, `midrun-steps` on and the steps since the last look up: asked as at an event; what
//                                the answer wants is taken once the look a few steps on wants the same
//   turn.step      where the run is, what the assistant wrote in the step; a step after one without tool calls carries
//                  input, so a return the code owes is taken there without a row
//   prompt.submit  a report delivered into the running turn (a background task's notice, an agent's hand-back): asked
//                  and decided before it is delivered, no row needed
//
// Nothing is decided for a turn whose level the person locked, for a model without effort, or without a decision model set
// up. A request that fails or is late leaves the level where it is (fail open). A dispatched agent's level is raised by
// the escalation feature, before its model (features/escalation.ts).
//
//   session.append (door `tool-result`) the row of a result a request carries takes the note of a move that waits
//
// The turn with a request or a move under way is kept in the module, and so are the move that waits for its row and the
// queue the calls of a step write the record through (all lost on a hot reload: the call that asked goes on without its
// answer, as a failed request would, and a move that waited is not made).

import type { EngineInterface, HttpInit, On, PromptOrigin, TurnStepInput } from 'claude-code'
import { bridgeStart, hasExtras, type HookGiven } from '../core/bridge.ts'
import { callsEnded, onlyWaits, scriptEnded } from '../core/calls.ts'
import { carriedByRequest, holdsNote, withNote } from '../core/notes.ts'
import { describeAsked, errorText, type Asked, type BackendIo } from '../decision/backend.ts'
import type { StandingConstraint } from '../decision/constraints.ts'
import { describeState } from '../decision/context.ts'
import { EFFORTS, isEffort, probsOf, readEffort, readingText, type Effort } from '../decision/effort.ts'
import { blockedByHookText, outcomeOf } from '../decision/escalation.ts'
import {
  decideMidrun,
  HOLD_STEPS,
  JUDGE_GAP_STEPS,
  MAX_JUDGMENTS,
  MAX_SWITCHES,
  MIDRUN_LEVEL,
  MIN_GAP_STEPS,
  midrunPart,
  midrunSignals,
  midrunState,
  resolvedDecision,
  rowsFor,
  switchNote,
  type MidrunDecision,
  type MidrunInput,
  type MidrunPosition,
} from '../decision/midrun.ts'
import { atStep, factsOf, newRecord, noteCall, stepsDue, withResponse, withScript, workSince, type CallEnd, type MidrunEvent, type MidrunRecord } from '../decision/midrun-track.ts'
import { quoteStart } from '../decision/redact.ts'
import { answersFor, mergeParts } from '../decision/system-one.ts'
import { wasBlocked } from '../core/outcomes.ts'
import { MAIN, replace, shifted, turnKey, update, type Cell, type TurnRecord } from '../core/plans.ts'
import { isPersonsMessage } from '../core/prompts.ts'
import { report, type ReportedDecision, type ReportIo } from '../core/report.ts'
import type { Ctx } from '../core/setup.ts'
import { defineSwitch, isOn } from '../core/switches.ts'

const MIDRUN = { plugin: 'dispatch-pilot', key: 'midrun', id: MAIN } as const
const TURNS = { plugin: 'dispatch-pilot', key: 'turns' } as const
const LOCK = { plugin: 'dispatch-pilot', key: 'lock' } as const
const CONSTRAINTS = { plugin: 'dispatch-pilot', key: 'constraints' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
const PPLX_RATE = { plugin: 'dispatch-pilot', key: 'pplxRate' } as const

/** The feature's switch (`/dp midrun-effort on|off`), and the one for lowering under a message's level (`/dp midrun-down on|off`). */
export const MIDRUN_SWITCH = 'midrun-effort'
export const MIDRUN_DOWN_SWITCH = 'midrun-down'
/** The switch for looking by step count as well (`/dp midrun-steps on|off`), off until the person turns it on. */
export const MIDRUN_STEPS_SWITCH = 'midrun-steps'
/** The switch for giving the decision model what a script returned (`/dp script-results on|off`): a Code Mode session's only. */
export const SCRIPT_RESULTS_SWITCH = 'script-results'

/** A step's text is kept this long at most as the record holds it (the state cuts it again). */
const TEXT_CHARS = 1200

/** Turns with a request on its way or a level being moved: of the calls of a step that end together, one asks and one moves the level. */
const busy = new Set<string>()
/**
 * A move decided and not yet made: its note waits for the row of a tool's result that a request carries, and the plan and
 * the record move once that row is stored with it (`take`). One at a time: nothing more is decided for the turn while
 * it waits.
 */
type PendingMove = { turnId: string; note: string; record: MidrunRecord; stood: { turn: TurnRecord; current: Effort; base: Effort }; decision: MidrunDecision; failed: string | null; told: Told; /** A row has taken the note and is being stored. */ onRow?: true }
/** What the decision log says of a move: once it is made, and when the row did not keep its note (null: nothing, the move stays owing). */
type Told = { taken: ReportedDecision; dropped: ReportedDecision | null }
let pending: PendingMove | null = null
/** The calls of a step write the record one after another: ended together, they would overwrite each other's writes. */
let writes: Promise<unknown> = Promise.resolve()

/** An event the decision model is asked at: one of the run's (decision/midrun-track.ts), or a report delivered into it. */
type JudgedEvent = Exclude<MidrunEvent, { kind: 'resolved' }> | { kind: 'report'; text: string }

function recordCell($: EngineInterface): Cell<MidrunRecord> {
  return { get: () => $.state.get(MIDRUN), set: (value, options) => $.state.set(MIDRUN, value, options) }
}

function turnCell($: EngineInterface, turnId: string): Cell<TurnRecord> {
  const ref = { ...TURNS, id: turnKey(turnId, undefined) }
  return { get: () => $.state.get(ref), set: (value, options) => $.state.set(ref, value, options) }
}

function ioOf($: EngineInterface): ReportIo {
  return {
    board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
    decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
    debug: (line) => $.ui.log(line, { to: 'debug' }),
    now: () => $.clock.now(),
    toast: (text) => $.ui.toast(text),
  }
}

function backendIo($: EngineInterface): BackendIo {
  return {
    fetch: (url: string, init: HttpInit) => $.http.fetch(url, init),
    sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }),
    pace: { now: () => $.clock.now(), sentAt: { get: () => $.state.get(PPLX_RATE), set: (value, options) => $.state.set(PPLX_RATE, value, options) } },
  }
}

/** Whether a prompt is a report (a background task's notice, a dispatched agent's or another session's message) delivered into a running turn. */
function isReportIntoTurn(e: { text: string; origin?: PromptOrigin; turnId?: string }): boolean {
  if (e.turnId === undefined || e.text.trim() === '' || isPersonsMessage(e)) return false
  return e.origin?.kind === 'task-notification' || e.origin?.kind === 'peer'
}

export function registerMidrunEffort(on: On, ctx: Ctx): void {
  defineSwitch({ name: MIDRUN_SWITCH, info: '一轮进行中，遇到这几类事件时重新判断主 agent 的 effort：改了又失败的命令、agent 交回的结果、新加载的 skill、送进来的报告。关掉后，派出的 agent 失败时也升不了 effort。' })
  defineSwitch({ name: MIDRUN_DOWN_SWITCH, info: '一轮进行中，剩下的工作只是照做时，把 effort 降到比发消息时低一档。关掉后中途只升档和回到原档。' })
  defineSwitch({ name: SCRIPT_RESULTS_SWITCH, info: 'Code Mode 会话里，一轮中途重新判断 effort 时，把主 agent 的脚本返回给它的内容（截短，不脱敏）也交给决策模型。', default: true })
  defineSwitch({ name: MIDRUN_STEPS_SWITCH, info: '一轮进行中一直没有事件时，也每隔几步重新判断一次主 agent 的 effort；隔几步由「每隔几步重看一次」定。', default: false })

  on('dispatchPilot.start', { name: 'midrun.call' }, async ($, started) => ({ value: await bridgeStart<HookGiven<typeof on<'tool.call', { tool: RegExp }>>>(started, async (e, next) => {
    // The main agent's own calls only: not a dispatched agent's, nor another plugin's `$.tool.call`.
    if (e.agentId !== undefined || next.origin.plugin !== 'engine' || !isOn(MIDRUN_SWITCH)) return next(e)
    const startedAt = await $.clock.now()
    const result = await next(e)
    try {
      const ended = outcomeOf(e.tool, result, wasBlocked(e.tool_use_id))
      await afterCall($, ctx, { tool: e.tool, input: e as unknown as Readonly<Record<string, unknown>>, outcome: ended, ...(typeof result.text === 'string' ? { text: result.text } : {}), durationMs: (await $.clock.now()) - startedAt })
    } catch (error) {
      $.ui.log(`midrun: ${errorText(error)}`, { to: 'debug' })
    }
    return result
  }) }))

  // The row of a tool's result, before it is stored. Without dispatch-pilot-extras (a Code Mode session) the hook above
  // does not run: the main agent's calls are read here (core/calls.ts), and the run's record and its events go on from there
  // as they do from a call's end. A hook's block is told by Claude Code's words for it (no `classic.PreToolUse` hook runs).
  // Then, either way, a move that waits puts its note on the row, when a request carries the row: with the other plugin
  // the call's own row comes right after its `tool.call` hooks return (measured on 2.1.326); in a Code Mode session the
  // calls of a script are rows no request carries, so the note goes on the next result of `REPL` or `Poll`.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    if (e.agentId !== undefined || !isOn(MIDRUN_SWITCH)) return next(e)
    try {
      if (!(await hasExtras(() => $.dispatchPilotExtras.present()))) {
        for (const call of callsEnded(e, await $.clock.now())) {
          const ended = outcomeOf(call.tool, { isError: call.isError, text: call.text }, call.isError && blockedByHookText(call.text))
          await afterCall($, ctx, { tool: call.tool, input: call.input, outcome: ended, ...(call.text === '' ? {} : { text: call.text }), durationMs: call.durationMs })
        }
      }
    } catch (error) {
      $.ui.log(`midrun: ${errorText(error)}`, { to: 'debug' })
    }
    const waiting = pending
    if (waiting === null || waiting.onRow === true || !carriedByRequest(e.message.content)) return next(e)
    // It waits on until the move is made: the calls of a step end together, and another would decide from the old level.
    waiting.onRow = true
    let stored: Awaited<ReturnType<typeof next>>
    try {
      stored = await next({ ...e, message: withNote(e.message, waiting.note) })
    } catch (error) {
      if (pending === waiting) pending = null
      throw error
    }
    try {
      if (holdsNote(stored, waiting.note)) {
        await take($, waiting.record, waiting.stood, waiting.decision, false, waiting.failed)
        await report(ioOf($), { decision: waiting.told.taken })
      } else {
        // The plan is left as it was: a level written without a step with input would not go out.
        $.ui.log(`midrun: the note for effort ${waiting.decision.effort} was not kept on the tool result's row; the level stays ${waiting.stood.current}`, { to: 'debug' })
        if (waiting.told.dropped !== null) await report(ioOf($), { decision: waiting.told.dropped })
      }
    } catch (error) {
      $.ui.log(`midrun: ${errorText(error)}`, { to: 'debug' })
    } finally {
      if (pending === waiting) pending = null
    }
    return stored
  })

  // A Code Mode session: what a script returned to the main agent is kept on the step its calls are read into, and goes
  // to the decision model with the run (the calls of a script that passed say nothing of what they found; the script's
  // result is the part the assistant chose to read). Its row comes before the rows of the script's calls (2.1.325), so
  // an event one of those calls makes is asked about with the result already there.
  on('session.append', { door: 'queue' }, async ($, e, next) => {
    const stored = await next(e)
    if (e.agentId !== undefined || !isOn(MIDRUN_SWITCH) || !isOn(SCRIPT_RESULTS_SWITCH)) return stored
    try {
      const script = scriptEnded(e)
      const cell = recordCell($)
      const { value: have } = await cell.get()
      // No step of the turn seen yet (a hot reload in the middle of one): no step to keep it on.
      if (script !== undefined && have !== undefined) {
        const noted = writes.then(() => update(cell, (r) => withScript(r ?? have, script)))
        writes = noted.catch(() => undefined)
        await noted
      }
    } catch (error) {
      $.ui.log(`midrun: ${errorText(error)}`, { to: 'debug' })
    }
    return stored
  })

  on('turn.step', { turnId: /(?:)/ }, async function* ($, e, next) {
    if (e.agentId !== undefined || !isOn(MIDRUN_SWITCH)) return yield* next(e)
    try {
      await atStepStart($, e)
    } catch (error) {
      $.ui.log(`midrun: ${errorText(error)}`, { to: 'debug' })
    }
    const stream = next(e)
    for await (const chunk of stream) yield chunk
    const result = await stream.result
    try {
      const text = result.answer.trim().slice(-TEXT_CHARS)
      await update(recordCell($), (r) => (r === undefined || r.turnId !== e.turnId ? (r ?? newRecord(e.turnId)) : withResponse(r, e.index, text, result.toolUses.length, onlyWaits(result.toolUses))))
    } catch (error) {
      $.ui.log(`midrun: ${errorText(error)}`, { to: 'debug' })
    }
    return result
  })

  on('prompt.submit', { text: /(?:)/ }, async ($, e, next) => {
    // A message the person types into the running turn sets the turn's level anew (features/main-effort.ts). What the run had
    // flagged until then belonged to the work before it: the stakes' floor, the ratchet, a failure read as stuck, a raise to
    // take back. Kept, they would hold a later raise above the new message's level.
    if (isOn(MIDRUN_SWITCH) && e.turnId !== undefined && e.text.trim() !== '' && isPersonsMessage(e)) {
      try {
        const cell = recordCell($)
        const { value: record } = await cell.get()
        if (record !== undefined && record.turnId === e.turnId) await update(cell, (r) => ({ ...(r ?? record), stakesFloor: null, ratchet: false, stuck: false, raisedFor: null, raisedAt: null, resolved: false, wanted: null }))
      } catch (error) {
        $.ui.log(`midrun: ${errorText(error)}`, { to: 'debug' })
      }
    }
    if (isOn(MIDRUN_SWITCH) && isReportIntoTurn(e)) {
      try {
        const { value: record } = await recordCell($).get()
        if (record !== undefined && record.turnId === e.turnId) await judge($, ctx, record, { kind: 'report', text: e.text }, true)
      } catch (error) {
        $.ui.log(`midrun: ${errorText(error)}`, { to: 'debug' })
      }
    }
    return next(e)
  })
}

/**
 * A step of the main agent starts: where the run is; a new turn starts its record afresh. A step after one whose response
 * asked for no tool call carries input (a Stop hook's feedback, a message waiting): a return the code owes is taken there.
 */
async function atStepStart($: EngineInterface, e: TurnStepInput): Promise<void> {
  const engine = isEffort(e.effort) ? e.effort : null
  const { before, after } = await replace(recordCell($), (r) => atStep(r === undefined || r.turnId !== e.turnId ? newRecord(e.turnId) : r, e.index, engine))
  if (before === undefined || before.turnId !== e.turnId) {
    busy.clear()
    // A move that never met a row belonged to the turn before.
    pending = null
    return
  }
  const carriesInput = e.index > before.step && before.uses === 0
  if (carriesInput) await settleResolved($, after, true)
}

/** A call of the main agent ended: the record, then what the run's event asks for. */
async function afterCall($: EngineInterface, ctx: Ctx, ended: Omit<CallEnd, 'step'>): Promise<void> {
  const cell = recordCell($)
  const { value: have } = await cell.get()
  // No step of the turn seen yet (a hot reload in the middle of one): nothing to attach the call to.
  if (have === undefined) return
  let event: MidrunEvent | null = null
  const noted = writes.then(() =>
    update(cell, (r) => {
      const one = noteCall(r ?? have, { ...ended, step: (r ?? have).step })
      event = one.event
      return one.record
    }),
  )
  writes = noted.catch(() => undefined)
  const record = await noted
  const made = event as MidrunEvent | null
  if (made === null || made.kind === 'resolved') {
    // The command a raise was for passes again (now, or earlier and the hold has since run out).
    await settleResolved($, record, false)
    // No event, and the steps since the last look are up: a look by step count, where the person switched it on.
    const due = made === null && isOn(MIDRUN_STEPS_SWITCH) ? stepsDue(record, ctx.config.midrun.everySteps, ctx.config.midrun.confirmSteps) : null
    if (due !== null) await judge($, ctx, record, due as JudgedEvent, false)
    return
  }
  await judge($, ctx, record, made, false)
}

/** Where the turn's level stands; null when nothing may move it (locked, a model without effort, a turn not seen). */
async function standing($: EngineInterface, record: MidrunRecord): Promise<{ turn: TurnRecord; current: Effort; base: Effort; ruleFloor: Effort | null } | null> {
  const [{ value: lock = null }, { value: turn }] = await Promise.all([$.state.get(LOCK), turnCell($, record.turnId).get()])
  if (lock !== null || turn === undefined || record.engine === null) return null
  const current = turn.effort ?? record.engine
  return { turn, current, base: turn.base ?? current, ruleFloor: turn.ruleFloor ?? null }
}

const at = (level: Effort): number => EFFORTS.indexOf(level)
const higherOf = (a: Effort | null, b: Effort | null): Effort | null => (a === null ? b : b === null ? a : at(b) > at(a) ? b : a)

/** What an event was, in the log's words. */
function eventWords(event: JudgedEvent | { kind: 'resolved'; command: string }): string {
  switch (event.kind) {
    case 'failure':
      return event.why === 'refail' ? `改过之后又失败：${event.command}` : event.why === 'regression' ? `原先通过的命令现在失败：${event.command}` : `同一条报错又出现：${event.command}`
    case 'resolved':
      return `失败的命令重新通过：${event.command}`
    case 'skill':
      return `加载 skill ${event.name}`
    case 'handback':
      return `${event.tool} 交回结果`
    case 'todo':
      return event.item === '' ? '任务清单换到下一项' : `任务清单换到下一项：${quoteStart(event.item)}`
    case 'steps':
      return `按步数再看：离上一次看已过 ${event.since} 步`
    case 'report':
      return `送进这一轮的报告：${quoteStart(event.text)}`
  }
}

/** Why a decision came out as it did, in the log's words. */
function moveWords(decision: MidrunDecision, from: Effort): string {
  const why: Record<MidrunDecision['reason'], string> = {
    stakes: '出错代价为是',
    cause: '失败的原因还没找到',
    reading: '剩下的工作读出来的档位',
    resolved: '失败的命令重新通过',
    mechanical: '剩下的只是照做',
    held: '',
    none: '',
  }
  if (decision.reason === 'held') {
    const hold = decision.steps.find((step) => step.rule === 'mid-hold')
    if (hold !== undefined && 'why' in hold && hold.why === 'confirm') return `读数想${hold.lowering === true ? '往下' : '往上'}换到 ${String(hold.wanted)}，按步数看的要 ${String(hold.again)} 步后再看一次、两次一致才换，保持 ${from}`
    if (hold === undefined || !('why' in hold) || hold.why !== 'cap') return `离上一次换档不到 ${MIN_GAP_STEPS} 步，保持 ${from}`
    return hold.lowering === true ? `这一轮只剩一次追加换档，留给升档，保持 ${from}` : `这一轮追加换档已满 ${MAX_SWITCHES} 次，保持 ${from}`
  }
  if (decision.move === 'raise') return `${why[decision.reason]}，升到 ${decision.effort}`
  if (decision.move === 'return') {
    // A take-back that stops at the level the stakes asked for says so (the step has the message's level and that floor).
    const back = decision.steps.find((step) => step.rule === 'mid-resolved') as { base?: unknown; floor?: unknown } | undefined
    const atStakes = back !== undefined && back.floor != null && back.base !== decision.effort
    return atStakes ? `${why[decision.reason]}，回到出错代价要的 ${decision.effort}（发消息时是 ${String(back.base)}）` : `${why[decision.reason]}，回到发消息时的 ${decision.effort}`
  }
  if (decision.move === 'down') return `${why[decision.reason]}，降一档到 ${decision.effort}`
  return '档位不变'
}

/**
 * Asks the decision model about the run at `event` and moves the level as the code decides. `free`: the step that takes the
 * level carries input already, so no note goes with it. One request a turn at a time; a failure that came back is asked
 * whenever it comes, anything else no sooner than `JUDGE_GAP_STEPS` after the last question: a command that passed and
 * fails after an edit among them (the red of writing a test first comes every few steps). Nothing is asked once the turn
 * has had its rows and this one would need another.
 */
async function judge($: EngineInterface, ctx: Ctx, record: MidrunRecord, event: JudgedEvent, free: boolean): Promise<void> {
  // A move that waits for its row was decided from the level that stands: nothing more is decided until it is made.
  if (ctx.backend.configured === false || busy.has(record.turnId) || pending !== null) return
  // A look by step count is counted apart: it takes none of the events' questions, an event is not held off by one, and
  // a turn has as many as its steps bring (the person sets how often, `midrunEverySteps`).
  const tick = event.kind === 'steps'
  if (!tick && record.judged >= MAX_JUDGMENTS) return
  const cameBack = event.kind === 'failure' && event.why !== 'regression'
  if (!tick && !cameBack && record.judgedAt !== null && workSince(record, record.judgedAt) < JUDGE_GAP_STEPS) return
  if (!free && record.switches >= MAX_SWITCHES) return
  // Taken before anything is awaited: the calls of a step end together.
  busy.add(record.turnId)
  try {
    const stood = await standing($, record)
    if (stood === null || stood.turn.prompt === '') return
    const constraints: StandingConstraint[] = (await $.state.get(CONSTRAINTS).catch(() => ({ value: undefined }))).value ?? []
    const failures = event.kind === 'failure' && event.earlier !== null ? { latest: event.latest, earlier: event.earlier } : undefined
    const input: MidrunInput = {
      task: stood.turn.prompt,
      recent_steps: record.recent,
      facts: factsOf(record, event),
      ...(constraints.length === 0 ? {} : { constraints }),
      ...(event.kind === 'report' ? { report: event.text } : {}),
      ...(event.kind === 'todo' && event.item !== '' ? { next_item: event.item } : {}),
    }
    const part = midrunPart(ctx.config.ask.turnStart, failures === undefined ? {} : { failures })
    const request = mergeParts(midrunState(input), [part])
    const cell = recordCell($)
    await update(cell, (r) => {
      const kept = r ?? record
      // A look starts the count of steps anew, and with it the steps that only waited.
      const looked = kept.idle === undefined ? kept : { ...kept, idle: 0 }
      return tick ? { ...looked, tickedAt: kept.step } : { ...looked, judged: kept.judged + 1, judgedAt: kept.step }
    })
    const sentAt = await $.clock.now()
    const asked: Asked = await ctx.backend.ask(backendIo($), request, ctx.config.timeoutMs)
    $.ui.log(`request [midrun.${MIDRUN_LEVEL} +${Object.keys(part.questions).length - 1}] at step ${record.step} (${event.kind}) to ${ctx.backend.name}: ${describeAsked(asked, (await $.clock.now()) - sentAt)}; ${describeState(request.state)}`, { to: 'debug' })
    const about = { feature: MIDRUN_SWITCH, agent: MAIN, aside: true as const, subject: `第 ${record.step} 步（${eventWords(event)}）` }
    if (!asked.ok) {
      await report(ioOf($), { decision: { ...about, failure: { backend: ctx.backend.name, ...asked.failure } } })
      return
    }
    const answers = answersFor(part, asked.answers)
    const reading = readEffort(answers[MIDRUN_LEVEL])
    if (reading === null) {
      await report(ioOf($), { decision: { ...about, failure: { backend: ctx.backend.name, kind: 'parse', detail: 'no effort answer' } } })
      return
    }
    // The level may have moved while the request was out (a message typed into the turn): decide from where it stands now.
    const [{ value: now = record }, standsNow] = await Promise.all([cell.get(), standing($, record)])
    if (standsNow === null || now.turnId !== record.turnId) return
    const position: MidrunPosition = {
      current: standsNow.current,
      base: standsNow.base,
      ruleFloor: standsNow.ruleFloor,
      event: event.kind,
      ratchet: now.ratchet,
      stuckBefore: now.stuck,
      downAllowed: isOn(MIDRUN_DOWN_SWITCH),
      free,
      sinceSwitch: now.switchedAt === null ? null : workSince(now, now.switchedAt),
      switches: now.switches,
      // What the look before this one wanted counts only for a look by step count, and only while no other look came between.
      awaited: event.kind === 'steps' && now.wanted != null && now.wanted.step !== record.step ? now.wanted.way : null,
      confirmSteps: ctx.config.midrun.confirmSteps,
    }
    const decision = decideMidrun(reading, midrunSignals(answers), position, ctx.config.guide)
    const moves = decision.effort !== standsNow.current
    /** The decision as the log has it: `made` false for a move whose note the row did not keep. */
    const told = (made: boolean): ReportedDecision => {
      const sent = made ? decision.effort : standsNow.current
      return {
        ...about,
        outcome: `effort ${sent}${sent === standsNow.current ? '（保持）' : `（原 ${standsNow.current}）`}`,
        effort: sent,
        reason: readingText(reading, moves && !made ? `${moveWords(decision, standsNow.current)}，但提示行加不到工具结果上，没有换` : moveWords(decision, standsNow.current), true),
        tone: sent === standsNow.current ? 'info' : 'ok',
        probs: probsOf(reading),
        ...(reading.confidence === null ? {} : { conf: reading.confidence }),
        trace: decision.steps,
        midrun: { from: standsNow.current, to: sent, base: standsNow.base, move: sent === standsNow.current ? 'keep' : decision.move, event: event.kind, free },
      }
    }
    // What a look by step count wanted and did not take waits for the next one; any other look, or a move, ends the wait.
    const wanted = decision.awaits === undefined ? null : { way: decision.awaits, step: record.step }
    if (wanted !== null || now.wanted != null) await update(cell, (r) => ({ ...(r ?? now), wanted }))
    // A flag that lifted nothing still closes the way down for the rest of the turn; a failure read as stuck is remembered for
    // the next; and the level the stakes ask for stays the floor of a raise taken back when its command passes.
    if ((decision.flagged && !now.ratchet) || (decision.stuck && !now.stuck) || higherOf(now.stakesFloor ?? null, decision.stakes) !== (now.stakesFloor ?? null)) {
      await update(cell, (r) => {
        const kept = r ?? now
        return { ...kept, ratchet: kept.ratchet || decision.flagged, stuck: kept.stuck || decision.stuck, stakesFloor: higherOf(kept.stakesFloor ?? null, decision.stakes) }
      })
    }
    // A move is reported once it is made (with its note, when the row that takes it is stored); a look that moves nothing, now.
    if (moves) await move($, now, standsNow, decision, free, event.kind === 'failure' ? event.command : null, { taken: told(true), dropped: told(false) })
    else await report(ioOf($), { decision: told(true) })
  } finally {
    busy.delete(record.turnId)
  }
}

/**
 * Takes back a raise whose failing command passes again: at once on a step that carries input (`free`), else with a note, once
 * the raise has stood long enough and the turn has a note left. Kept owing otherwise (a later call or step takes it).
 */
async function settleResolved($: EngineInterface, seen: MidrunRecord, free: boolean): Promise<void> {
  if (seen.raisedFor === null || !seen.resolved || busy.has(seen.turnId) || pending !== null) return
  // Taken before anything is awaited: of the calls of a step that end together, one takes the level back.
  busy.add(seen.turnId)
  try {
    const cell = recordCell($)
    const { value: record = seen } = await cell.get()
    if (record.turnId !== seen.turnId || record.raisedFor === null || !record.resolved) return
    const stood = await standing($, record)
    if (stood === null) return
    // Back to the message's level, or to the one the stakes asked for this turn when that is higher.
    const floor = record.stakesFloor ?? null
    if (at(stood.current) <= at(higherOf(stood.base, floor) ?? stood.base)) {
      // Nothing of the raise is left to take back: something else did already (a message typed into the turn), or the stakes hold all of it.
      await update(cell, (r) => ({ ...(r ?? record), raisedFor: null, raisedAt: null, resolved: false }))
      return
    }
    const since = record.raisedAt === null ? HOLD_STEPS : workSince(record, record.raisedAt)
    // With a row: not before the gap, and not with the turn's last row, which is a raise's (on max there is none to keep it for).
    if (since < (free ? HOLD_STEPS : MIN_GAP_STEPS) || (!free && record.switches >= rowsFor('return', stood.current))) return
    const decision = resolvedDecision(stood, record.raisedFor, since, floor)
    if (decision.move !== 'return') return
    const taken: ReportedDecision = {
      feature: MIDRUN_SWITCH,
      agent: MAIN,
      aside: true,
      subject: `第 ${record.step} 步（${eventWords({ kind: 'resolved', command: record.raisedFor })}）`,
      outcome: `effort ${decision.effort}（原 ${stood.current}）`,
      effort: decision.effort,
      reason: moveWords(decision, stood.current),
      tone: 'ok',
      trace: decision.steps,
      midrun: { from: stood.current, to: decision.effort, base: stood.base, move: 'return', event: 'resolved', free },
    }
    // Without the note the raise stays owing: a later call or step takes it back.
    await move($, record, stood, decision, free, null, { taken, dropped: null })
  } finally {
    busy.delete(seen.turnId)
  }
}

/**
 * Moves the turn's level. On a step that carries input anyway (`free`) the plan and the record move at once. Otherwise the
 * move waits (`pending`) for the row of a tool's result, which takes its note (the `session.append` hook above), and is
 * made once that row is stored with it: a level written without a step with input would not go out, and the board would
 * name a level the model is not on. The decision is reported as the move is made (`told`).
 */
async function move($: EngineInterface, record: MidrunRecord, stood: { turn: TurnRecord; current: Effort; base: Effort }, decision: MidrunDecision, free: boolean, failed: string | null, told: Told): Promise<void> {
  if (free) {
    await take($, record, stood, decision, true, failed)
    await report(ioOf($), { decision: told.taken })
    return
  }
  pending = { turnId: record.turnId, note: switchNote(stood.current, decision.effort, decision.reason), record, stood, decision, failed, told }
}

/** Makes a move: the turn's plan, then the run's record (`free`: no note went with it, so none is counted). */
async function take($: EngineInterface, record: MidrunRecord, stood: { turn: TurnRecord; current: Effort; base: Effort }, decision: MidrunDecision, free: boolean, failed: string | null): Promise<void> {
  await update(turnCell($, record.turnId), (r) => shifted(r ?? stood.turn, decision.effort, stood.current))
  const raisedForFailure = decision.move === 'raise' && failed !== null
  await update(recordCell($), (r) => {
    const now = r ?? record
    return {
      ...now,
      switches: now.switches + (free ? 0 : 1),
      switchedAt: free ? now.switchedAt : now.step,
      // A raise for a failure is the code's to take back when its command passes. Any other move ends that: a raise for the
      // stakes or for what the work reads as stands until a later look takes it back.
      raisedFor: raisedForFailure ? failed : null,
      raisedAt: decision.move === 'raise' ? now.step : null,
      resolved: false,
      ratchet: now.ratchet || decision.flagged,
    }
  })
}
