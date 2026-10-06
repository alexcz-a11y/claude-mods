// The decision report (「决定汇报」, ADR 0004): the one writer of what Dispatch
// Pilot shows people. The board, the decision log, the debug log and, until the
// new screens replace it, the old status line are all written here, from the
// same structured data in $.state (types/index.d.ts: `board`, `decisionLog`).
//
// Two entries, and nothing else is for a feature to call:
//
//   reportDecision(io, decision)   a feature hands over a decision it made (or the
//                                  reason it could not make one): which feature,
//                                  about which agent, the outcome, why, and the
//                                  rules' working when there is one. Written to the
//                                  decision log, the agent's node on the board, the
//                                  debug log.
//   reportStep(io, step)           the reading of one model request: the model and
//                                  effort an agent's step went out with. Only
//                                  observes, never decides anything (ADR 0003). The
//                                  core calls it for the main agent's steps; the
//                                  readings ticket (#27) completes it for every agent.
//
// The module also keeps the board's turn count with a `turn.start` hook of its
// own (`registerReport`); a feature never touches that.
//
// Pure but for that hook: `$` stays in the hook owner's file (it may not cross
// an import), so the caller builds a `ReportIo` of closures:
//
//   const io: ReportIo = {
//     board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
//     decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
//     debug: (line) => $.ui.log(line, { to: 'debug' }),
//     status: (line) => $.ui.status(line),
//   }
//
// where `BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const` and
// `DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const` are
// the file's own literal refs (DEVELOPMENT.md, 开发). Neither entry ever
// throws: a report that cannot be kept must not stop the decision or the step.

import type { On } from 'claude-code'
import { errorText, type Failure } from '../decision/backend.ts'
import { modelFamily, type AgentModel } from '../decision/dispatched-agent.ts'
import type { Effort } from '../decision/effort.ts'
import { type Cell, type EffortSource, update } from './plans.ts'
import { failureText, setStatus, type Segment } from './status.ts'

const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const

// ---- the data (mirrors types/index.d.ts) --------------------------------------

/** A model family, as a person says it (`/model`). */
export type Model = AgentModel
/** How a log entry reads: a decision made, a thing to watch, a failure, a plain record. */
export type Tone = 'ok' | 'warn' | 'fail' | 'info'
export type AgentState = 'queued' | 'running' | 'done' | 'failed'

/** One step of the rules' working: its rule, whether it took effect, and the rule's own fields. */
export type RuleStep = { rule: string; applied: boolean; [field: string]: string | number | boolean | null }

/** A failed decision request, with the decision model that failed. */
export type NodeFailure = Failure & { backend: string }

/** One agent of one turn on the board. */
export type BoardNode = {
  turn: number
  /** `main`, or the agentId. */
  id: string
  kind: 'main' | 'agent' | 'wf'
  name: string
  type: string
  model?: Model
  effort?: Effort | number
  state: AgentState
  t0: number
  dur?: number
  routed: boolean
  locked?: true
  why?: string
  failure?: NodeFailure
  decision?: number
  /** The Workflow it belongs to (a Workflow agent, or the call of the script that stands for it before it starts). */
  workflow?: { id: string; name: string }
}

export type Board = { turn: number; nodes: BoardNode[] }

/** One decision as the log keeps it. */
export type LogEntry = {
  n: number
  turn: number
  feature: string
  agent?: string
  tone: Tone
  outcome: string
  subject: string
  reason: string
  probs?: Record<Effort, number>
  conf?: number
  trace?: RuleStep[]
  floor?: { from: Effort; to: Effort; model: Model }
  mid?: { current: Effort; picked: Effort; result: Effort; held?: string }
}

/** The log keeps the entries of this many latest turns, and at most `LOG_ENTRIES` of them. */
export const LOG_TURNS = 20
export const LOG_ENTRIES = 300

// ---- what a feature hands over ------------------------------------------------

/** What every report says of who it is about. */
type About = {
  /** The feature's switch name; a report's decision adds ` (agent report)`. */
  feature: string
  /** `main`, or the agentId of the dispatched or Workflow agent. */
  agent: string
  /**
   * `next`: made before the turn it is for has started (at `prompt.submit`, for a message that will start
   * the turn), so it belongs to the turn to come; `current` (the default): the turn running now.
   */
  forTurn?: 'current' | 'next'
  /** What it was about, for the log: the start of the message, an agent's label. */
  subject?: string
  /**
   * How to start the agent's node when the board has none yet (the main agent's is known). `state`: `running` by
   * default, `queued` for a decision made for a turn to come or for a Workflow call whose agent has not started.
   * `workflow`: the Workflow the agent (or its call) belongs to.
   */
  node?: { kind: 'agent' | 'wf'; name: string; type: string; state?: AgentState; workflow?: { id: string; name: string } }
  /** Whether it left the agent routed (a decision) or not (a failure): the node's `routed`. Left as it is when not given. */
  routed?: boolean
  /**
   * The id of the node that stood for this agent before it started (a Workflow call, queued): the agent's node
   * takes its place, and the decision made for the call, its model and its effort, when it has them.
   */
  replaces?: string
}

/** A decision made. */
export type Decided = About & {
  /** What was decided, in a few words: `effort high`. */
  outcome: string
  /** Why: what the decision model said, the rule that applied. */
  reason: string
  tone?: Tone
  probs?: Record<Effort, number>
  conf?: number
  trace?: RuleStep[]
  floor?: LogEntry['floor']
  mid?: LogEntry['mid']
  /** The model and effort it decided, by family and level, for an agent that has not taken a step yet (its first reading replaces them). */
  model?: Model
  effort?: Effort
  /** Whose choice the model was (the person's words, or the main agent's pick that stood) and whether the effort was the person's: the old status line says so. */
  modelBy?: 'person' | 'main-agent'
  effortBy?: 'person'
  /** A Workflow call: the decision changed what the script says (false: the script's own stood), and it was sent back to the main agent to write in (return mode). */
  written?: boolean
  sentBack?: true
}

/** A decision the feature could not make: the decision request failed. Not an entry of the log; it says why on the agent's node. */
export type NotDecided = About & { failure: NodeFailure }

/**
 * No decision was asked for, or none could be made without a failed request: why the agent (or the Workflow) runs
 * as it was written, in a few words. Not a log entry. `asWritten`: by design, not a miss (the Workflow was already
 * sent back once). `offBoard`: nothing to show on the board, only the old status line is to say it (a script
 * with no agent() call).
 */
export type Left = About & { why: string; asWritten?: true; offBoard?: true }

/**
 * An agent whose decision was made earlier, for its call, has started: the agent is on the board as the one the
 * decision routed. Not a log entry (the decision is, since it was made).
 */
export type Started = About & { started: true; model?: Model; effort?: Effort }

export type ReportedDecision = Decided | NotDecided | Left | Started

/** What one model request went out with, as the core sends it. */
export type StepReading = {
  /** Absent for the main agent. */
  agentId?: string
  /** The model id as sent. */
  model: string
  /** The effort as sent; absent for a model without effort. */
  effort?: string | number
  /** Where the effort came from: the person's lock, a plan, or the engine (not routed). */
  source: EffortSource
}

/** What the module needs of the host, as closures (see the top of the file). */
export type ReportIo = {
  board: Cell<Board>
  decisions: Cell<LogEntry[]>
  /** `(line) => $.ui.log(line, { to: 'debug' })` */
  debug: (line: string) => void
  /** `(line) => $.ui.status(line)`: the old status line, which goes when the new screens replace it. */
  status: (line: string | undefined) => void
}

// ---- entry 1: a decision ------------------------------------------------------

/**
 * Reports a decision: the debug log line and the decision log entry (a
 * decision made), the agent's node on the board, and the old status line's
 * segment the feature owns. Never throws.
 */
export async function reportDecision(io: ReportIo, decision: ReportedDecision): Promise<void> {
  return reportDecisions(io, [decision])
}

/**
 * Reports the decisions of one event together, the several agents of a Workflow
 * for one: one write to the log, one to the board, and the old line, which
 * sums them up, sent once. Each is what `reportDecision` makes of it alone, in
 * the order given. Never throws.
 */
export async function reportDecisions(io: ReportIo, decisions: readonly ReportedDecision[]): Promise<void> {
  const last = decisions.at(-1)
  if (last === undefined) return
  try {
    // Which turn each is for. A board that cannot be read does not stop a decision from being logged (as turn 1).
    const board = await read(io.board).catch((error: unknown) => {
      io.debug(`board not read: ${errorText(error)}`)
      return EMPTY
    })
    const turnOf = (decision: ReportedDecision) => board.turn + (decision.forTurn === 'next' ? 1 : 0)
    const made = decisions.filter(isDecided)
    for (const decision of made) io.debug(decisionLine(decision))
    // The number of each decision in the log, in the order made.
    const numbers: number[] = []
    if (made.length > 0) {
      try {
        await update(io.decisions, (list) => {
          numbers.length = 0
          let all = list ?? []
          for (const decision of made) {
            all = appendEntry(all, entryOf(decision, turnOf(decision)))
            numbers.push(all.at(-1)?.n ?? 0)
          }
          return all
        })
      } catch (error) {
        numbers.length = 0
        io.debug(`decision not kept for /dp log: ${errorText(error)}`)
      }
    }
    let after = board
    try {
      after = await update(io.board, (current) => {
        let next = current ?? EMPTY
        let at = 0
        for (const decision of decisions) {
          const n = isDecided(decision) ? numbers[at++] : undefined
          if (!('offBoard' in decision)) next = withNode(next, turnOf(decision), decision, n)
        }
        return next
      })
    } catch (error) {
      io.debug(`decision not kept on the board: ${errorText(error)}`)
    }
    for (const old of LEGACY[last.feature.split(' ')[0] as string]?.(last, after, decisions) ?? []) setStatus(old.segment, old.text, io.status)
  } catch (error) {
    io.debug(`decision not reported: ${errorText(error)}`)
  }
}

/** A decision that was made (the others say why there is none, or that an agent started). */
function isDecided(decision: ReportedDecision): decision is Decided {
  return 'outcome' in decision
}

/**
 * The old status line's segments that the board renders, by the feature that
 * decides what they say (its switch name): each is handed the decision (the
 * last of an event's), the board with it on (every agent's node of the latest
 * turns, so a segment that sums up several agents reads them there) and all
 * the decisions of the event, and says what its segments now read (`null`:
 * nothing). A feature's migration adds its line here and drops its own
 * `setStatus`; the whole line goes with step 2.
 */
const LEGACY: Record<string, (decision: ReportedDecision, board: Board, event: readonly ReportedDecision[]) => { segment: Segment; text: string | null }[]> = {
  // Why the person's message got no decision: the failed request, until a decision comes back.
  'main-effort': (decision) => [{ segment: 'decision', text: 'failure' in decision ? failureText(decision.failure.backend, decision.failure) : null }],
  // The latest dispatched agent: its model and effort and whose choice they were, or why it is not routed.
  'dispatched-agents': (decision) => {
    if ('failure' in decision) return [{ segment: 'agent', text: `agent not routed (${failureText(decision.failure.backend, decision.failure)})` }]
    if (!isDecided(decision)) return []
    const whose = decision.modelBy === 'person' ? ' (you)' : decision.modelBy === 'main-agent' ? ' (kept)' : decision.effortBy === 'person' ? ' (effort: you)' : ''
    return [{ segment: 'agent', text: `agent ${decision.outcome}${whose}` }]
  },
  // A Workflow script's calls: how many were routed, left as written, and why.
  'workflow-agents': (_decision, _board, event) => {
    const first = event[0]
    if (first === undefined) return []
    // Said of the Workflow as a whole (not of one of its calls).
    if (event.length === 1 && 'why' in first && first.node?.workflow === undefined) {
      return [{ segment: 'workflow', text: 'offBoard' in first ? null : `workflow ${'asWritten' in first ? 'runs as written' : 'not routed'} (${first.why})` }]
    }
    const decided = event.filter(isDecided)
    const sentBack = decided.filter((decision) => decision.written === true)
    if (decided.some((decision) => decision.sentBack === true)) return [{ segment: 'workflow', text: `workflow sent back (${sentBack.length} agent${sentBack.length === 1 ? '' : 's'})` }]
    const left = event.filter((decision) => !isDecided(decision))
    const failure = left.find((decision) => 'failure' in decision)
    const failed = failure !== undefined && 'failure' in failure ? failureText(failure.failure.backend, failure.failure) : null
    if (decided.length === 0) {
      const one = left[0]
      return [{ segment: 'workflow', text: `workflow not routed (${one === undefined ? 'no agent() calls' : (failed ?? whyOf(one))})` }]
    }
    const rest = left.length === 0 ? '' : ` (${left.length} as written${failed === null ? '' : `: ${failed}`})`
    return [{ segment: 'workflow', text: `workflow routed ${decided.length} agent${decided.length === 1 ? '' : 's'}${rest}` }]
  },
  // A Workflow run's agents routed by their labels: what was decided for its calls when it started, then how its agents fared as each one started.
  'workflow-labels': (decision, board, event) => {
    const first = event[0]
    if (first === undefined) return []
    const run = decision.node?.workflow
    // An agent has started: the run's tally.
    if (run !== undefined && decision.node?.state !== 'queued') {
      const started = board.nodes.filter((node) => node.workflow?.id === run.id && node.state !== 'queued')
      const routed = started.filter((node) => node.routed).length
      const failed = started.filter((node) => !node.routed)
      const reason = failed.at(-1)?.why ?? ''
      const got = `routed ${routed} agent${routed === 1 ? '' : 's'}`
      return [{ segment: 'labels', text: failed.length === 0 ? `by label: ${got}` : routed === 0 ? `by label: not routed (${reason})` : `by label: ${got} (${failed.length} not: ${reason})` }]
    }
    // The run's own set-up failed.
    if (event.length === 1 && 'why' in first && first.node?.workflow === undefined) return [{ segment: 'labels', text: `by label: not routed (${first.why})` }]
    // The calls decided as the run started: said only when a request failed.
    const undecided = event.filter((one) => 'failure' in one)
    const failure = undecided[0]
    if (failure === undefined || !('failure' in failure)) return []
    const why = failureText(failure.failure.backend, failure.failure)
    if (event.some(isDecided)) return [{ segment: 'labels', text: `by label: ${undecided.length} call${undecided.length === 1 ? '' : 's'} not decided (${why})` }]
    return [{ segment: 'labels', text: `by label: not routed (${why})` }]
  },
}

/** Why a decision that was not made says the agent is not routed: the failure in the old status words, else its own. */
function whyOf(decision: ReportedDecision): string {
  return 'failure' in decision ? failureText(decision.failure.backend, decision.failure) : 'why' in decision ? decision.why : ''
}

// ---- entry 2: a reading -------------------------------------------------------

/**
 * Reports the reading of one step: the model (by family) and the effort it
 * went out with, whether the effort was routed, and that the agent is running.
 * Reading never changes what is sent. Writes the board only when the reading
 * differs from the node's. Never throws.
 *
 * (The readings ticket, #27, turns this into the per-agent collector: names,
 * start and duration, the change events. The signature is the contract.)
 */
export async function reportStep(io: ReportIo, step: StepReading): Promise<void> {
  const main = step.agentId === undefined
  const family = modelFamily(step.model)
  const effort = step.effort === undefined ? undefined : typeof step.effort === 'number' ? step.effort : isLevel(step.effort) ? step.effort : undefined
  const reading = { routed: step.source !== 'engine', locked: step.source === 'locked' }
  try {
    await modify(io.board, (current) => {
      const board = current ?? EMPTY
      const id = step.agentId ?? 'main'
      const old = board.nodes.find((node) => node.turn === board.turn && node.id === id)
      const base = old ?? newNode(board.turn, id, main ? undefined : { kind: 'agent', name: id, type: 'agent' }, 'running')
      const next: BoardNode = {
        ...without(base, 'model', 'effort', 'locked'),
        state: 'running',
        routed: reading.routed,
        ...(family === null ? {} : { model: family }),
        ...(effort === undefined ? {} : { effort }),
        ...(reading.locked ? { locked: true as const } : {}),
      }
      if (old !== undefined && JSON.stringify(old) === JSON.stringify(next)) return undefined
      return { ...board, nodes: [...board.nodes.filter((node) => node !== old), next] }
    })
  } catch (error) {
    io.debug(`reading not kept on the board: ${errorText(error)}`)
  }
  // The old status line's `effort` segment: the main agent's effort as it goes out. Set at every step
  // (the line itself is sent only when it changes), for a switch or /dp off may have taken it away.
  if (main && step.effort !== undefined) setStatus('effort', `effort ${String(step.effort)}${reading.locked ? ' (locked)' : reading.routed ? '' : ' (not routed)'}`, io.status)
}

function isLevel(value: string): value is Effort {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max'
}

// ---- the turn count -----------------------------------------------------------

/** The board when a main turn starts: the count up by one, the nodes of older turns gone (the turn before it stays: it is folded into one line). */
export function startTurn(board: Board | undefined): Board {
  const turn = (board?.turn ?? 0) + 1
  return { turn, nodes: (board?.nodes ?? []).filter((node) => node.turn >= turn - 1) }
}

/** The module's own hook: counts the main agent's turns. A board that cannot be kept never stops a turn. */
export function registerReport(on: On): void {
  on('turn.start', { turnId: /(?:)/ }, async ($, e, next) => {
    try {
      await update<Board>({ get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) }, (board) => startTurn(board))
    } catch {
      // the count is the board's own: a turn starts without it
    }
    return next(e)
  })
}

// ---- the log ------------------------------------------------------------------

/** A decision as one line: `effort high for "the message": why`. The debug log's line, and `/dp log`'s after `#n feature: `. */
export function decisionLine(decision: { outcome: string; subject?: string; reason: string }): string {
  return `${decision.outcome}${decision.subject ? ` for ${decision.subject}` : ''}: ${decision.reason}`
}

/** The list with `entry` added last, numbered, the entries of turns older than the latest `LOG_TURNS` dropped, and then the oldest past `LOG_ENTRIES`. */
export function appendEntry(list: readonly LogEntry[], entry: Omit<LogEntry, 'n'>): LogEntry[] {
  const all = [...list, { n: (list.at(-1)?.n ?? 0) + 1, ...entry }]
  const latest = Math.max(...all.map((kept) => kept.turn))
  return all.filter((kept) => kept.turn > latest - LOG_TURNS).slice(-LOG_ENTRIES)
}

function entryOf(decision: Decided, turn: number): Omit<LogEntry, 'n'> {
  return {
    turn,
    feature: decision.feature,
    agent: decision.agent,
    tone: decision.tone ?? 'ok',
    outcome: decision.outcome,
    subject: decision.subject ?? '',
    reason: decision.reason,
    ...(decision.probs === undefined ? {} : { probs: decision.probs }),
    ...(decision.conf === undefined ? {} : { conf: decision.conf }),
    ...(decision.trace === undefined ? {} : { trace: decision.trace }),
    ...(decision.floor === undefined ? {} : { floor: decision.floor }),
    ...(decision.mid === undefined ? {} : { mid: decision.mid }),
  }
}

// ---- the board ----------------------------------------------------------------

const EMPTY: Board = { turn: 0, nodes: [] }

function newNode(turn: number, id: string, node: About['node'], state: AgentState): BoardNode {
  if (id === 'main') return { turn, id, kind: 'main', name: '主 agent', type: 'main', state, t0: 0, routed: false }
  return { turn, id, kind: node?.kind ?? 'agent', name: node?.name ?? id, type: node?.type ?? 'agent', state: node?.state ?? state, t0: 0, routed: false, ...(node?.workflow === undefined ? {} : { workflow: node.workflow }) }
}

/** The board with the decision on its agent's node of `turn` (the node made when there is none), `n` the decision's number in the log when it has one. */
function withNode(board: Board, turn: number, decision: ReportedDecision, n: number | undefined): Board {
  const old = board.nodes.find((node) => node.turn === turn && node.id === decision.agent)
  // The node that stood for the agent before it started gives it what was decided for it, and goes.
  const stood = old === undefined && decision.replaces !== undefined ? board.nodes.find((node) => node.id === decision.replaces) : undefined
  const inherited = stood === undefined ? {} : { ...(stood.decision === undefined ? {} : { decision: stood.decision }), ...(stood.model === undefined ? {} : { model: stood.model }), ...(stood.effort === undefined ? {} : { effort: stood.effort }) }
  const base = old ?? { ...newNode(turn, decision.agent, decision.node, decision.forTurn === 'next' ? 'queued' : 'running'), ...inherited }
  const routed = decision.routed === undefined ? {} : { routed: decision.routed }
  let next: BoardNode
  if ('failure' in decision) {
    next = { ...base, ...routed, why: failureText(decision.failure.backend, decision.failure), failure: decision.failure }
  } else if ('why' in decision) {
    next = { ...without(base, 'failure'), routed: false, why: decision.why }
  } else if ('started' in decision) {
    next = { ...without(base, 'why', 'failure'), routed: true, state: 'running', ...(decision.model === undefined ? {} : { model: decision.model }), ...(decision.effort === undefined ? {} : { effort: decision.effort }) }
  } else {
    next = {
      ...(decision.routed === true ? without(base, 'why', 'failure') : base),
      ...routed,
      ...(decision.model === undefined ? {} : { model: decision.model }),
      ...(decision.effort === undefined ? {} : { effort: decision.effort }),
      ...(n === undefined ? {} : { decision: n }),
    }
  }
  return { ...board, nodes: [...board.nodes.filter((node) => node !== old && node !== stood), next] }
}

/** The value of a cell, or the empty board. */
async function read(cell: Cell<Board>): Promise<Board> {
  return (await cell.get()).value ?? EMPTY
}

/** `update` that writes only when `change` has something to write (it returns undefined when the value stands). */
async function modify<T>(cell: Cell<T>, change: (current: T | undefined) => T | undefined, attempts = 8): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { value, version } = await cell.get()
    const next = change(value)
    if (next === undefined) return
    if ((await cell.set(next, { ifVersion: version })).isSet) return
  }
  throw new Error(`$.state write lost to other writers ${attempts} times in a row`)
}

/** The object without these keys (a $.state value holds no `undefined`). */
function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const rest = { ...value }
  for (const key of keys) delete rest[key]
  return rest
}
