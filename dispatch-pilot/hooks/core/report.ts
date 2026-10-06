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
  /** How to start the agent's node when the board has none yet (the main agent's is known). */
  node?: { kind: 'agent' | 'wf'; name: string; type: string }
  /** Whether it left the agent routed (a decision) or not (a failure): the node's `routed`. Left as it is when not given. */
  routed?: boolean
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
}

/** A decision the feature could not make: the decision request failed. Not an entry of the log; it says why on the agent's node. */
export type NotDecided = About & { failure: NodeFailure }

export type ReportedDecision = Decided | NotDecided

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
  try {
    // Which turn it is for. A board that cannot be read does not stop the decision from being logged (as turn 1).
    const board = await read(io.board).catch((error: unknown) => {
      io.debug(`board not read: ${errorText(error)}`)
      return EMPTY
    })
    const turn = board.turn + (decision.forTurn === 'next' ? 1 : 0)
    let n: number | undefined
    if (!('failure' in decision)) {
      io.debug(decisionLine(decision))
      try {
        const kept = await update(io.decisions, (list) => appendEntry(list ?? [], entryOf(decision, turn)))
        n = kept.at(-1)?.n
      } catch (error) {
        io.debug(`decision not kept for /dp log: ${errorText(error)}`)
      }
    }
    let after = board
    try {
      after = await update(io.board, (current) => withNode(current ?? EMPTY, turn, decision, n))
    } catch (error) {
      io.debug(`decision not kept on the board: ${errorText(error)}`)
    }
    for (const old of LEGACY[decision.feature.split(' ')[0] as string]?.(decision, after) ?? []) setStatus(old.segment, old.text, io.status)
  } catch (error) {
    io.debug(`decision not reported: ${errorText(error)}`)
  }
}

/**
 * The old status line's segments that the board renders, by the feature that
 * decides what they say (its switch name): each is handed the decision and the
 * board with it on (every agent's node of the latest turns, so a segment that
 * sums up several agents reads them there), and says what its segments now
 * read (`null`: nothing). A feature's migration adds its line here and drops
 * its own `setStatus`; the whole line goes with step 2.
 */
const LEGACY: Record<string, (decision: ReportedDecision, board: Board) => { segment: Segment; text: string | null }[]> = {
  // Why the person's message got no decision: the failed request, until a decision comes back.
  'main-effort': (decision) => [{ segment: 'decision', text: 'failure' in decision ? failureText(decision.failure.backend, decision.failure) : null }],
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
  return { turn, id, kind: node?.kind ?? 'agent', name: node?.name ?? id, type: node?.type ?? 'agent', state, t0: 0, routed: false }
}

/** The board with the decision on its agent's node of `turn` (the node made when there is none), `n` the decision's number in the log when it has one. */
function withNode(board: Board, turn: number, decision: ReportedDecision, n: number | undefined): Board {
  const old = board.nodes.find((node) => node.turn === turn && node.id === decision.agent)
  const base = old ?? newNode(turn, decision.agent, decision.node, decision.forTurn === 'next' ? 'queued' : 'running')
  const routed = decision.routed === undefined ? {} : { routed: decision.routed }
  const next: BoardNode =
    'failure' in decision
      ? { ...base, ...routed, why: failureText(decision.failure.backend, decision.failure), failure: decision.failure }
      : { ...(decision.routed === true ? without(base, 'why', 'failure') : base), ...routed, ...(n === undefined ? {} : { decision: n }) }
  return { ...board, nodes: [...board.nodes.filter((node) => node !== old), next] }
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
