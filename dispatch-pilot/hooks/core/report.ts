// The decision report (「决定汇报」, ADR 0004): the one writer of what Dispatch
// Pilot shows people. The board, the decision log, the debug log and, until the
// new screens replace it, the old status line are all written here, from the
// same structured data in $.state (types/index.d.ts: `board`, `decisionLog`).
//
// Three entries, and nothing else is for a feature to call:
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
//   reportTally(io, tally)         what a feature counts as its loop goes, which is no
//                                  decision: the mid-turn re-decisions of the main
//                                  agent's turn, each loop's failed calls and forced
//                                  raises. On the agent's node.
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
  /** The main agent's mid-turn re-decisions of the turn: steps made, decisions, level changes; `late`: an answer is not back, `failure`: the latest request failed. Escalation's. */
  midturn?: { steps: number; judged: number; changed: number; late?: true; failure?: NodeFailure }
  /** The failed tool calls, hook blocks and forced raises of the agent's loop (the escalation feature counts them); absent while none. */
  counts?: { failed: number; blocked: number; raised: number; late?: true }
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
  mid?: { current: Effort; picked: Effort; result: Effort; threshold?: number; held?: string; remaining?: number }
  forced?: ForcedRaise
  skills?: SkillsPicked
  counts?: { failed: number; blocked: number; raised: number }
}

/** A raise the failures forced: the level (or, for a haiku agent, the model) it went from and to, and the level it holds the agent at least at. */
export type ForcedRaise = { kind: 'effort' | 'model'; from: string; to: string; floor?: Effort }

/** The skills a message (or a find_skill call) got: those suggested to the main agent, and those only the person can start (「可试 /x」), each with its relevance. */
export type SkillsPicked = { suggest: { name: string; relevance: number }[]; try: { name: string; relevance: number }[] }

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
  /**
   * A decision beside the agent's route (a mid-turn re-decision, a forced raise, a skill suggestion): in the log,
   * and not on the agent's node (its `decision` link, `routed` and `why` stay the route's).
   */
  aside?: true
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
  forced?: ForcedRaise
  skills?: SkillsPicked
  counts?: LogEntry['counts']
}

/** A decision the feature could not make: the decision request failed. Not an entry of the log; it says why on the agent's node. */
export type NotDecided = About & { failure: NodeFailure }

/**
 * Why a feature that was asked for something said nothing, when that is neither a decision nor a failed request:
 * the answer said nothing about the skills (`unanswered`), the session's skills could not be read (`unread`),
 * there was no skill to rate (`none`), an error of the mod's own (`error`; the debug log has it). Not in the log,
 * not on the board: the old status line says it, until it goes.
 */
export type Skip = 'unanswered' | 'unread' | 'none' | 'error'
export type Skipped = About & { skipped: Skip; aside: true }

export type ReportedDecision = Decided | NotDecided | Skipped

/** What a feature counts as its loop goes (`reportTally`), not a decision of its own. */
export type Tallied =
  /** The main agent's turn as the mid-turn re-decision sees it. `quiet`: not re-decided yet this turn (nothing to show). `late`: the answer for this step is not back; `failure`: its request failed. */
  | { feature: 'midturn-effort'; agent: 'main'; steps: number; judged: number; changed: number; quiet: boolean; late?: true; failure?: NodeFailure }
  /** A loop's failed tool calls, hook blocks and forced raises. `turnStart`: the main agent's counts start over with a new turn. */
  | { feature: 'escalation'; agent: string; failed: number; blocked: number; raised: number; late?: true; turnStart?: true; node?: About['node'] }

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
    if ('outcome' in decision) {
      io.debug(decisionLine(decision))
      try {
        const kept = await update(io.decisions, (list) => appendEntry(list ?? [], entryOf(decision, turn)))
        n = kept.at(-1)?.n
      } catch (error) {
        io.debug(`decision not kept for /dp log: ${errorText(error)}`)
      }
    }
    let after = board
    if (decision.aside !== true && !('skipped' in decision)) {
      try {
        after = await update(io.board, (current) => withNode(current ?? EMPTY, turn, decision, n))
      } catch (error) {
        io.debug(`decision not kept on the board: ${errorText(error)}`)
      }
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
  // The skills suggested for the message, and the ones to try; or why none were rated.
  skills: (decision) => [
    {
      segment: 'skills',
      text: 'outcome' in decision ? (decision.skills === undefined ? null : skillsText(decision.skills)) : 'failure' in decision ? `skills not rated (${failureText(decision.failure.backend, decision.failure)})` : null,
    },
  ],
  // What find_skill returned, or why it failed.
  'find-skill': (decision) => [
    {
      segment: 'find-skill',
      text:
        'outcome' in decision
          ? `find_skill ${decision.skills === undefined || decision.skills.suggest.length === 0 ? 'none' : decision.skills.suggest.map((skill) => skill.name).join(', ')}`
          : 'failure' in decision
            ? `find_skill failed (${failureText(decision.failure.backend, decision.failure)})`
            : decision.skipped === 'none'
              ? 'find_skill none'
              : `find_skill failed (${decision.skipped === 'unread' ? "the session's skills could not be read" : 'see the debug log'})`,
    },
  ],
}

/** The skills segment: the skills suggested, then those for the person to start (`try /x`); null for neither. */
function skillsText(picked: SkillsPicked): string | null {
  const parts = [
    ...(picked.suggest.length > 0 ? [`skills ${picked.suggest.map((skill) => skill.name).join(', ')}`] : []),
    ...(picked.try.length > 0 ? [`try ${picked.try.map((skill) => `/${skill.name}`).join(' ')}`] : []),
  ]
  return parts.length > 0 ? parts.join(' | ') : null
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

// ---- entry 3: a tally ---------------------------------------------------------

/**
 * Reports what a feature counts as its loop goes, which is no decision: the
 * mid-turn re-decision's steps, decisions and changes of the main agent's
 * turn, and each loop's failed tool calls and forced raises. On the agent's
 * node of the current turn (`midturn`, `counts`), and on the old status
 * line's segments of those features. Writes the board only when the node
 * changed. Never throws.
 */
export async function reportTally(io: ReportIo, tally: Tallied): Promise<void> {
  try {
    await modify(io.board, (current) => withTally(current ?? EMPTY, tally))
  } catch (error) {
    io.debug(`tally not kept on the board: ${errorText(error)}`)
  }
  if (tally.feature === 'midturn-effort') {
    const note = tally.late === true ? ' (late)' : tally.failure === undefined ? '' : ` (${failureText(tally.failure.backend, tally.failure)})`
    setStatus('midturn', tally.quiet ? null : `steps ${tally.steps}, judged ${tally.judged}, changed ${tally.changed}${note}`, io.status)
    return
  }
  // The old line shows the main agent's counts, and the latest agent's that had any (lost with the turn, and with a reload).
  const counts = { failed: tally.failed, blocked: tally.blocked, raised: tally.raised }
  if (tally.turnStart === true) latestAgent = null
  if (tally.agent === 'main') setStatus('escalation', countsText(counts, '', tally.late === true), io.status)
  else latestAgent = { counts, late: tally.late === true }
  setStatus('agentEscalation', latestAgent === null ? null : countsText(latestAgent.counts, 'agent ', latestAgent.late), io.status)
}

/** The latest agent whose calls failed, for the old status line. */
let latestAgent: { counts: { failed: number; blocked: number; raised: number }; late: boolean } | null = null

/** `failed 2, blocked 1, raised 1`: the counts that are not zero (null when all are), and `(late)` while a stuck answer is not back. */
function countsText(counts: { failed: number; blocked: number; raised: number }, prefix: string, late: boolean): string | null {
  const parts = [counts.failed > 0 ? `failed ${counts.failed}` : '', counts.blocked > 0 ? `blocked ${counts.blocked}` : '', counts.raised > 0 ? `raised ${counts.raised}` : ''].filter((part) => part !== '')
  return parts.length === 0 ? null : `${prefix}${parts.join(', ')}${late ? ' (late)' : ''}`
}

/** The board with the tally on its agent's node of the current turn; undefined when the node already says it (or there is nothing to say). */
function withTally(board: Board, tally: Tallied): Board | undefined {
  const old = board.nodes.find((node) => node.turn === board.turn && node.id === tally.agent)
  let next: BoardNode
  if (tally.feature === 'midturn-effort') {
    if (tally.quiet) return undefined
    const midturn = { steps: tally.steps, judged: tally.judged, changed: tally.changed, ...(tally.late === true ? { late: true as const } : {}), ...(tally.failure === undefined ? {} : { failure: tally.failure }) }
    next = { ...(old ?? newNode(board.turn, tally.agent, undefined, 'running')), midturn }
  } else {
    const any = tally.failed + tally.blocked + tally.raised > 0
    if (old === undefined && !any) return undefined
    const base = old ?? newNode(board.turn, tally.agent, tally.node, 'running')
    next = any
      ? { ...base, counts: { failed: tally.failed, blocked: tally.blocked, raised: tally.raised, ...(tally.late === true ? { late: true as const } : {}) } }
      : without(base, 'counts')
  }
  if (old !== undefined && JSON.stringify(old) === JSON.stringify(next)) return undefined
  return { ...board, nodes: [...board.nodes.filter((node) => node !== old), next] }
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
    ...(decision.forced === undefined ? {} : { forced: decision.forced }),
    ...(decision.skills === undefined ? {} : { skills: decision.skills }),
    ...(decision.counts === undefined ? {} : { counts: decision.counts }),
  }
}

// ---- the board ----------------------------------------------------------------

const EMPTY: Board = { turn: 0, nodes: [] }

function newNode(turn: number, id: string, node: About['node'], state: AgentState): BoardNode {
  if (id === 'main') return { turn, id, kind: 'main', name: '主 agent', type: 'main', state, t0: 0, routed: false }
  return { turn, id, kind: node?.kind ?? 'agent', name: node?.name ?? id, type: node?.type ?? 'agent', state, t0: 0, routed: false }
}

/** The board with the decision on its agent's node of `turn` (the node made when there is none), `n` the decision's number in the log when it has one. */
function withNode(board: Board, turn: number, decision: Decided | NotDecided, n: number | undefined): Board {
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
