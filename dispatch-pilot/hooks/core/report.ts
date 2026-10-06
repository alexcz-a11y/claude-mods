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
//                                  effort an agent's step went out with, whoever's
//                                  loop it is. Only observes, never decides anything
//                                  (ADR 0003). The core calls it from its `turn.step`,
//                                  which knows what the step goes out with.
//
// The module also keeps the board's turn count and the agents' lifecycle with
// hooks of its own (`registerReport`, which sees `turn.start`, `agent.spawn` and
// `turn.complete` and changes nothing in them); a feature never touches that.
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

import type { EngineInterface, On } from 'claude-code'
import { errorText, type Failure } from '../decision/backend.ts'
import { modelFamily, type AgentModel } from '../decision/dispatched-agent.ts'
import type { Effort } from '../decision/effort.ts'
import { startedIn } from '../decision/workflow-labels.ts'
import { type Cell, type EffortSource, update } from './plans.ts'
import { failureText, setStatus, type Segment } from './status.ts'

const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
const WORKFLOW_RUNS = { plugin: 'dispatch-pilot', key: 'workflowRuns' } as const
const LABEL_RUNS = { plugin: 'dispatch-pilot', key: 'labelRuns' } as const

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

/** What an agent's step read: its model by family and its effort as it went out (absent: a model without effort). */
export type Reading = { model?: Model; effort?: Effort | number }

/** One reading that differed from the agent's previous one in the same turn (types/index.d.ts, `board.changes`). */
export type ReadingChange = {
  turn: number
  id: string
  /** Seconds from the start of `turn`. */
  at: number
  /** The `n` of the decision log's last entry when it was read. */
  after: number
  from: Reading
  to: Reading
}

export type Board = {
  turn: number
  /** When the latest turns started (`$.clock.now()`), by turn. */
  starts?: { turn: number; at: number }[]
  changes?: ReadingChange[]
  nodes: BoardNode[]
}

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

/** An agent of the roster `$.agent.list()` answers, as far as a node needs it. */
export type RosterAgent = { id: string; name?: string; description: string; type: string }

/**
 * What the readings need beyond `ReportIo`: the clock, the roster of dispatched agents, and the directories of
 * the session's Workflow runs (to tell a Workflow's agent, and its label, from the journal). `stepIo($)` builds it.
 */
export type StepIo = ReportIo & {
  /** `() => $.clock.now()` */
  now: () => Promise<number>
  /** `() => $.agent.list()`: dispatched agents only, a Workflow's are not in it. */
  agents: () => Promise<readonly RosterAgent[]>
  /** The run directories the mod noted (`workflowRuns`, `labelRuns`), oldest first. */
  runDirs: () => Promise<readonly string[]>
  /** A run's journal text; null when it is not there. */
  journal: (dir: string) => Promise<string | null>
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

/** How many writes may be lost to other writers in a row: a Workflow's agents step within milliseconds of each other. */
const READING_ATTEMPTS = 32

/**
 * Reports the reading of one step: the model (by family) and the effort it
 * went out with, whether the effort was routed, and that the agent is running.
 * Reading never changes what is sent. The agent's node is made at its first
 * step when the board has none (named from the roster of dispatched agents, or
 * from the label its Workflow journal gives it; a loop neither knows is not an
 * agent of the board), carries its start, and a reading that differs from the
 * node's previous one adds a change event. Writes the board only when
 * something is new. Never throws.
 */
export async function reportStep(io: StepIo, step: StepReading): Promise<void> {
  const id = step.agentId ?? 'main'
  const main = step.agentId === undefined
  const family = modelFamily(step.model)
  const effort = step.effort === undefined ? undefined : typeof step.effort === 'number' ? step.effort : isLevel(step.effort) ? step.effort : undefined
  const reading: Reading = { ...(family === null ? {} : { model: family }), ...(effort === undefined ? {} : { effort }) }
  const routed = step.source !== 'engine'
  const locked = step.source === 'locked'
  try {
    const now = await io.now()
    const seen = main ? now : seenAt(id, now)
    const peek = await read(io.board)
    const before = main ? mainNode(peek) : continuing(peek, id)
    // A node that has not begun is named now (the roster may know it only from here on); one that has keeps its name.
    const identity = main || (before !== undefined && begun(before)) ? null : await identify(io, id)
    if (!main && before === undefined && identity === null) return
    const logged = before !== undefined && differs(before, reading) ? (((await io.decisions.get()).value ?? []).at(-1)?.n ?? 0) : 0
    await modify(
      io.board,
      (current) => {
        const board = current ?? EMPTY
        const old = main ? mainNode(board) : continuing(board, id)
        if (old === undefined && identity === null && !main) return undefined
        const turn = old?.turn ?? board.turn
        const started = old !== undefined && begun(old)
        const base = old ?? newNode(turn, id, identity ?? undefined, 'running')
        const named = identity !== null && !started ? { kind: identity.kind, name: identity.name, type: identity.type } : {}
        const next: BoardNode = {
          ...without(base, 'model', 'effort', 'locked', 'dur'),
          ...named,
          state: 'running',
          t0: main ? 0 : started ? base.t0 : elapsed(board, turn, seen),
          routed,
          ...reading,
          ...(locked ? { locked: true as const } : {}),
        }
        const changes = old !== undefined && differs(old, reading) ? [{ turn, id, at: elapsed(board, turn, now), after: logged, from: readingOf(old), to: reading }] : []
        if (old !== undefined && changes.length === 0 && JSON.stringify(old) === JSON.stringify(next)) return undefined
        return {
          ...board,
          ...(changes.length === 0 ? {} : { changes: [...(board.changes ?? []), ...changes].filter((change) => change.turn >= board.turn - 1) }),
          nodes: [...board.nodes.filter((node) => node !== old), next],
        }
      },
      READING_ATTEMPTS,
    )
    if (!main) firstSeen.delete(id)
  } catch (error) {
    io.debug(`reading not kept on the board: ${errorText(error)}`)
  }
  // The old status line's `effort` segment: the main agent's effort as it goes out. Set at every step
  // (the line itself is sent only when it changes), for a switch or /dp off may have taken it away.
  if (main && step.effort !== undefined) setStatus('effort', `effort ${String(step.effort)}${locked ? ' (locked)' : routed ? '' : ' (not routed)'}`, io.status)
}

/** How a loop's turn ended (`turn.complete`). */
export type LoopEnd = { agentId?: string; reason: 'answer' | 'aborted' | 'refusal' | 'error'; durationMs: number }

/**
 * Reports the end of a loop's turn: done after an answer, else failed (and
 * why, when nothing else said), for as long as it ran. The main agent's turn
 * ends its own node; an agent's, its own, wherever its turn's node is. Never throws.
 */
export async function reportEnd(io: StepIo, end: LoopEnd): Promise<void> {
  const id = end.agentId ?? 'main'
  const main = end.agentId === undefined
  try {
    const now = await io.now()
    const peek = await read(io.board)
    const known = main ? mainNode(peek) : continuing(peek, id)
    const identity = main || known !== undefined ? null : await identify(io, id)
    if (!main && known === undefined && identity === null) return
    const seen = main || known !== undefined ? now : (firstSeen.get(id) ?? now - end.durationMs)
    await modify(
      io.board,
      (current) => {
        const board = current ?? EMPTY
        const old = main ? mainNode(board) : continuing(board, id)
        if (old === undefined && identity === null && !main) return undefined
        const turn = old?.turn ?? board.turn
        const base = old ?? newNode(turn, id, identity ?? undefined, 'running')
        const failed = end.reason !== 'answer'
        const next: BoardNode = {
          ...base,
          ...(old === undefined && !main ? { t0: elapsed(board, turn, seen) } : {}),
          state: failed ? 'failed' : 'done',
          dur: Math.round(end.durationMs) / 1000,
          ...(failed && base.why === undefined ? { why: end.reason === 'aborted' ? 'aborted' : end.reason === 'refusal' ? 'refused' : 'error' } : {}),
        }
        return { ...board, nodes: [...board.nodes.filter((node) => node !== old), next] }
      },
      READING_ATTEMPTS,
    )
    if (!main) firstSeen.delete(id)
  } catch (error) {
    io.debug(`end of loop not kept on the board: ${errorText(error)}`)
  }
}

/**
 * Reports a dispatched agent started: queued until its first step. Its node is
 * made (or, when a decision about it made one, marked queued from now); the
 * agent's own first step starts it. Never throws.
 */
export async function reportSpawn(io: StepIo, spawn: { agentId: string; name?: string; description: string; type: string }): Promise<void> {
  try {
    const now = await io.now()
    await modify(
      io.board,
      (current) => {
        const board = current ?? EMPTY
        const old = continuing(board, spawn.agentId)
        if (old !== undefined && begun(old)) return undefined
        const turn = old?.turn ?? board.turn
        const name = spawn.name !== undefined && spawn.name !== '' ? spawn.name : spawn.description !== '' ? spawn.description : spawn.agentId
        const base = old ?? newNode(turn, spawn.agentId, { kind: 'agent', name, type: spawn.type }, 'queued')
        const next: BoardNode = { ...base, state: 'queued', t0: elapsed(board, turn, now) }
        return { ...board, nodes: [...board.nodes.filter((node) => node !== old), next] }
      },
      READING_ATTEMPTS,
    )
  } catch (error) {
    io.debug(`agent not kept on the board: ${errorText(error)}`)
  }
}

function isLevel(value: string): value is Effort {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max'
}

/** Who a loop with no node is, from what the engine and the Workflow journals say; null: not an agent the board shows. */
type Identity = { kind: 'agent' | 'wf'; name: string; type: string }

async function identify(io: StepIo, id: string): Promise<Identity | null> {
  try {
    const info = (await io.agents()).find((agent) => agent.id === id)
    if (info !== undefined) return { kind: 'agent', name: info.name !== undefined && info.name !== '' ? info.name : info.description !== '' ? info.description : id, type: info.type }
  } catch (error) {
    io.debug(`agent roster not read: ${errorText(error)}`)
  }
  try {
    // A Workflow's agents are in no roster: the journal of the run it started in has the label it started under.
    for (const dir of [...(await io.runDirs())].reverse()) {
      const journal = await io.journal(dir)
      const start = journal === null ? null : startedIn(journal, id)
      if (start !== null) return { kind: 'wf', name: start.label, type: 'workflow' }
    }
  } catch (error) {
    io.debug(`workflow journals not read: ${errorText(error)}`)
  }
  return null
}

/**
 * When a loop no node was made for was first seen (module state: a hot reload forgets it, and an agent only
 * found later then starts at that step). A Workflow's first agent can step before its run is recorded, so its
 * name comes with a later step, or with the end of its loop, and starts when it first stepped.
 */
const firstSeen = new Map<string, number>()
const FIRST_SEEN_KEPT = 64

function seenAt(id: string, now: number): number {
  const seen = firstSeen.get(id)
  if (seen !== undefined) return seen
  firstSeen.set(id, now)
  for (const key of firstSeen.keys()) if (firstSeen.size > FIRST_SEEN_KEPT) firstSeen.delete(key)
  return now
}

/** The main agent's node of the turn running. */
function mainNode(board: Board): BoardNode | undefined {
  return board.nodes.find((node) => node.turn === board.turn && node.id === 'main')
}

/**
 * An agent's node that its steps go on in: its latest one, if it is of the turn
 * running or has not ended (an agent still running when the next turn starts
 * stays in the turn it began in); else it is a new row in this turn.
 */
function continuing(board: Board, id: string): BoardNode | undefined {
  const latest = board.nodes.filter((node) => node.id === id).reduce<BoardNode | undefined>((best, node) => (best === undefined || node.turn >= best.turn ? node : best), undefined)
  return latest !== undefined && (latest.turn === board.turn || latest.state === 'queued' || latest.state === 'running') ? latest : undefined
}

/** Whether the node has had a reading: its start is the first step's, and its name is settled. */
function begun(node: BoardNode): boolean {
  return node.state !== 'queued' && (node.id === 'main' || node.t0 > 0 || node.model !== undefined || node.effort !== undefined)
}

function readingOf(node: BoardNode): Reading {
  return { ...(node.model === undefined ? {} : { model: node.model }), ...(node.effort === undefined ? {} : { effort: node.effort }) }
}

/** Whether the node has a previous reading, and it is not this one. */
function differs(node: BoardNode, reading: Reading): boolean {
  if (node.model === undefined && node.effort === undefined) return false
  return node.model !== reading.model || node.effort !== reading.effort
}

/** Seconds from the start of `turn` to `ms` (0 when the turn's start is not known). */
function elapsed(board: Board, turn: number, ms: number): number {
  const start = board.starts?.find((kept) => kept.turn === turn)?.at
  return start === undefined ? 0 : Math.max(0, Math.round(ms - start)) / 1000
}

// ---- the turn count and the loops' lifecycle ------------------------------------

/** The board when a main turn starts at `now`: the count up by one, the nodes of older turns gone (the turn before it stays: it is folded into one line). */
export function startTurn(board: Board | undefined, now: number): Board {
  const turn = (board?.turn ?? 0) + 1
  const kept = (of: number) => of >= turn - 1
  return {
    turn,
    starts: [...(board?.starts ?? []).filter((start) => kept(start.turn)), { turn, at: now }],
    ...(board?.changes === undefined ? {} : { changes: board.changes.filter((change) => kept(change.turn)) }),
    nodes: (board?.nodes ?? []).filter((node) => kept(node.turn)),
  }
}

/**
 * What the module's own hooks need of the host, as closures over `$`. `$` is followed only into a function of
 * the same file, so the core builds its `StepIo` itself (core.ts, `turn.step`): keep the two alike.
 */
function stepIo($: EngineInterface): StepIo {
  return {
    board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
    decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
    debug: (line) => $.ui.log(line, { to: 'debug' }),
    status: (line) => $.ui.status(line),
    now: () => $.clock.now(),
    agents: () => $.agent.list(),
    runDirs: async () => {
      const [noted, labelled] = await Promise.all([$.state.get(WORKFLOW_RUNS), $.state.get(LABEL_RUNS)])
      return [...new Set([...(noted.value ?? []), ...(labelled.value ?? [])].map((run) => run.dir))]
    },
    journal: async (dir) => {
      const path = `${dir}/journal.jsonl`
      return (await $.fs.exists(path)) ? await $.fs.read(path).catch(() => null) : null
    },
  }
}

/**
 * The module's own hooks, which only watch (every event goes on as it is):
 * a main turn starting (the board's turn count and its start time), a
 * dispatched agent spawned (queued until its first step), a loop's turn ending
 * (its node done or failed). A board that cannot be kept never stops anything.
 */
export function registerReport(on: On): void {
  on('turn.start', { turnId: /(?:)/ }, async ($, e, next) => {
    try {
      const now = await $.clock.now()
      await update<Board>({ get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) }, (board) => startTurn(board, now))
    } catch {
      // the count is the board's own: a turn starts without it
    }
    return next(e)
  })

  on('agent.spawn', { tool_use_id: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined || result.agentId === undefined) return result
    await reportSpawn(stepIo($), { agentId: result.agentId, ...(e.name === undefined ? {} : { name: e.name }), description: e.description, type: e.subagentType })
    return result
  })

  on('turn.complete', { turnId: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    await reportEnd(stepIo($), { ...(e.agentId === undefined ? {} : { agentId: e.agentId }), reason: e.reason, durationMs: e.durationMs })
    return result
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
