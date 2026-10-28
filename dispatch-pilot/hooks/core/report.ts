// The decision report (「决定汇报」, ADR 0004): the one writer of what Dispatch
// Pilot shows people. The board, the decision log, the debug log and the toasts
// are all written here, from the same structured data in $.state
// (types/index.d.ts: `board`, `decisionLog`); the screens
// (hooks/board/) only draw that data.
//
// Two entries, and nothing else, are for others to call:
//
//   report(io, what)        记一条决定: a feature (or a screen) hands over one
//                           thing to show, tagged by its kind (`Reported`):
//                           `decision`, a decision it made or why it could not
//                           make one (which feature, about which agent, the
//                           outcome, why, the rules' working when there is one:
//                           the decision log, the agent's node, the debug log; a
//                           route that failed raises a toast); `decisions`,
//                           several of one event (the agent() calls of a
//                           Workflow script: one write each, one toast at most);
//                           `tally`, what a feature counts as a loop goes (a
//                           loop's failed calls and model step-ups, its
//                           visual checks: on the agent's node); `switched`, the
//                           person flipped the mod or a feature (`/dp`: the
//                           screens draw again); `fellBack`, the images go to another
//                           decision model for want of a TypeSafe key; `unplaced`, a pane the
//                           person asked for that the surface did not place (a
//                           toast); `unviewed`, a transcript the person asked
//                           for from the pane that the engine did not show (a
//                           toast). `io` is what that kind needs of the host
//                           (`IoOf`): a `ReportIo` for most.
//   reportStep(io, step)    记一步读数: the reading of one model request, the
//                           model and effort an agent's step went out with,
//                           whoever's loop it is. Only observes, never decides
//                           anything (ADR 0003). The core calls it from its
//                           `turn.step`, which knows what the step goes out with.
//
// The rest of a loop's life (spawned, ended) and the board's turn count the
// module hears with hooks of its own (`registerReport`, which the entry file
// registers first: `turn.start`, `agent.spawn`, `turn.complete`, changing nothing
// in them); nobody calls those. What else is exported (`decisionLine`,
// `callNodeId`, `unplacedText`, the types) only shapes or reads data.
//
// Pure but for those hooks: `$` stays in the hook owner's file (it may not cross
// an import), so the caller builds its io of closures, a `ReportIo` as:
//
//   const io: ReportIo = {
//     board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
//     decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
//     debug: (line) => $.ui.log(line, { to: 'debug' }),
//     now: () => $.clock.now(),
//     toast: (text) => $.ui.toast(text),
//   }
//
// where `BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const` and
// `DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const` are
// the file's own literal refs (DEVELOPMENT.md, 开发). Neither entry ever
// throws: a report that cannot be kept must not stop the decision or the step.

import type { EngineInterface, On } from 'claude-code'
import { errorText, failureLine, failureWords, type Failure } from '../decision/backend.ts'
import { modelFamily, type AgentModel } from '../decision/dispatched-agent.ts'
import { isEffort, type Effort } from '../decision/effort.ts'
import type { BackendName } from './setup.ts'
import type { Verdict } from '../decision/nouls.ts'
import type { UnresolvedChange, UnresolvedOption, UnresolvedThresholds } from '../decision/unresolved.ts'
import type { CheckTally, VisualCheckRecord } from '../decision/visual-check-record.ts'
import { fitsTemplate } from '../decision/workflow-labels.ts'
import { type Cell, type EffortSource, update } from './plans.ts'
import { masterOn } from './switches.ts'
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

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
  /**
   * `main`, the agentId, or for a Workflow's agent not started yet the id of its call (`callNodeId`), for a
   * Workflow not routed as a whole its tool call's id.
   */
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
  /** The failed tool calls, hook blocks and model step-ups of the agent's loop (the escalation feature counts them); absent while none. */
  counts?: { failed: number; blocked: number; raised: number }
  /** The agent's visual_check calls of the loop, counted by verdict (and the images the screenshot takeover kept from it, #62); absent while none. visual-check's. */
  visualChecks?: CheckTally
}

/** What an agent's step read: its model by family and its effort as it went out (absent: a model without effort). */
export type Reading = { model?: Model; effort?: Effort | number }

/**
 * The id of the node a Workflow call of a script stands on until its agent starts (an agent of a Workflow has no id
 * before): `<tool_use_id>#<index>`, the Workflow tool call's own id and the call's place in the script.
 */
export function callNodeId(workflow: string, index: number): string {
  return `${workflow}#${index}`
}

/** The Workflow tool call a call's node (`callNodeId`) belongs to; null for any other node. */
export function callWorkflowOf(id: string): string | null {
  const at = id.indexOf('#')
  return at < 0 ? null : id.slice(0, at)
}

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

/**
 * What a feature met beside an agent's route that is neither a decision nor the route itself, for the band's
 * event stream (types/index.d.ts, `board.notes`): a request that failed (`failed`, `why` its words), one that
 * gave nothing to use (`skipped`, `why` the Skip).
 */
export type BoardNote = {
  turn: number
  /** `main`, or the agentId it was about. */
  id: string
  feature: string
  /** Seconds from the start of `turn`. */
  at: number
  /** The `n` of the decision log's last entry when it was written. */
  after: number
  kind: 'failed' | 'skipped'
  why: string
}

export type Board = {
  turn: number
  /** When the latest turns started (`$.clock.now()`), by turn. */
  starts?: { turn: number; at: number }[]
  changes?: ReadingChange[]
  notes?: BoardNote[]
  nodes: BoardNode[]
}

/** The board keeps at most this many notes (those of the nodes' turns). */
const NOTES_KEPT = 50

/** One decision as the log keeps it. */
export type LogEntry = {
  n: number
  turn: number
  /** Seconds from the start of `turn` to when it was reported (0 for a decision made before its turn started); absent in an entry an earlier version wrote. */
  at?: number
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
  /** The model (by family) and effort an agent was decided to run with (the main agent: its effort only); the agent's node says what its steps went out with. */
  model?: Model
  effort?: Effort
  forced?: ForcedRaise
  skills?: SkillsPicked
  counts?: { failed: number; blocked: number; raised: number }
  /** A Workflow call's decision that was sent back to the main agent to write in (return mode). */
  sentBack?: true
  /** The complexity reading of the reference images that went into this decision's request (#63). */
  reference?: ReferenceRecord
  /** An unresolved-count judgement (`unresolved`). */
  unresolved?: UnresolvedRecord
  /** A visual_check call (#58): its checks and their verdicts, whether the zoomed re-check was done, how long it took. */
  visualCheck?: VisualCheckRecord
  /** An entry of feature `decision-model`: which requests the fallback is about; `images` since 0.9.0, `text` only in an entry an earlier version wrote (the decision model no longer falls back, ADR 0014). */
  fallbackFor?: 'text' | 'images'
}

/** What the reference images a request came with read as (`decision/complexity.ts`): the level, 0 (trivial) to 4 (very complex), and how many images it came from. */
export type ReferenceRecord = { level: number; images: number }

/**
 * What one message's answers to the unresolved questions did to the count: the count before and after, the change, each
 * question's probability (null: no answer) and verdict, and the two bars they were held to. The card draws it as it is;
 * nothing is worked out again (ADR 0004).
 */
export type UnresolvedRecord = {
  before: number
  count: number
  change: UnresolvedChange
  probs: Record<UnresolvedOption, number | null>
  verdicts: Record<UnresolvedOption, Verdict>
  thresholds: UnresolvedThresholds
}

/** A model step-up the failures forced on a dispatched agent (features/escalation.ts): the model it went from and to. */
export type ForcedRaise = { kind: 'model'; from: string; to: string }

/** The skills a message (or a find_skill call) got: those suggested to the main agent, and those only the person can start (「可试 /x」), each with its relevance. */
export type SkillsPicked = { suggest: { name: string; relevance: number }[]; try: { name: string; relevance: number }[] }

/** The log keeps the entries of this many latest turns, and at most `LOG_ENTRIES` of them. */
const LOG_TURNS = 20
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
   * takes its place, and the decision made for the call (its `decision` link), when it has one.
   */
  replaces?: string
  /**
   * A decision beside the agent's route (a model step-up, a skill suggestion): in the log,
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
  /** The model (by family) and the effort it decided for an agent: in the log entry, since the node's own are what its steps read. */
  model?: Model
  effort?: Effort
  /** A Workflow call's decision that was sent back to the main agent to write in (return mode). */
  sentBack?: true
  forced?: ForcedRaise
  skills?: SkillsPicked
  counts?: LogEntry['counts']
  reference?: ReferenceRecord
  unresolved?: UnresolvedRecord
  /** A visual_check call: what was checked, the verdicts, the times (#58). */
  visualCheck?: VisualCheckRecord
}

/** A decision the feature could not make: the decision request failed. Not an entry of the log; it says why on the agent's node. */
export type NotDecided = About & { failure: NodeFailure }

/**
 * No decision was asked for, or none could be made without a failed request: why the agent (or the Workflow) runs
 * as it was written, in a few words, on its node. Not a log entry. `offBoard`: nothing to show at all, so nothing is
 * written (a script with no agent() call).
 */
export type Left = About & { why: string; offBoard?: true }

/**
 * An agent whose decision was made earlier, for its call, has started: the agent is on the board as the one the
 * decision routed. Not a log entry (the decision is, since it was made).
 */
export type Started = About & { started: true }

/**
 * Why a feature that was asked for something said nothing, when that is neither a decision nor a failed request:
 * the answer said nothing about the skills (`unanswered`), the session's skills could not be read (`unread`),
 * there was no skill to rate (`none`), an error of the mod's own (`error`; the debug log has it). Not in the log and
 * on no node: a note on the board (`board.notes`, kind `skipped`), which the band's event stream draws.
 */
export type Skip = 'unanswered' | 'unread' | 'none' | 'error'
export type Skipped = About & { skipped: Skip; aside: true }

export type ReportedDecision = Decided | NotDecided | Left | Started | Skipped

/** What a feature counts as its loop goes (`report`'s `tally`), not a decision of its own. */
export type Tallied =
  /** A loop's failed tool calls, hook blocks and model step-ups (all 0: none yet, as the main agent's at a new turn). */
  | { feature: 'escalation'; agent: string; failed: number; blocked: number; raised: number }
  /**
   * What a visual_check call found, to be added to its agent's count for the loop (#58): checks that passed, failed, got no
   * verdict to trust; `takeovers`: images the screenshot takeover kept from the agent (#62). Unlike the one above these are
   * the call's own numbers, not a running total: the board adds them to the node's.
   */
  | { feature: 'visual-check'; agent: string; passed: number; failed: number; unsure: number; takeovers?: number }

/** What one model request went out with, as the core sends it. */
type StepReading = {
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
type RosterAgent = { id: string; name?: string; description: string; type: string }

/**
 * What the readings need beyond `ReportIo`: the roster of dispatched agents (a Workflow's agents have their nodes from
 * their spawns). `stepIo($)` builds it.
 */
export type StepIo = ReportIo & {
  /** `() => $.agent.list()`: dispatched agents only, a Workflow's are not in it. */
  agents: () => Promise<readonly RosterAgent[]>
}

/** What the module needs of the host, as closures (see the top of the file). */
export type ReportIo = {
  board: Cell<Board>
  decisions: Cell<LogEntry[]>
  /** `(line) => $.ui.log(line, { to: 'debug' })` */
  debug: (line: string) => void
  /** `() => $.clock.now()`: when a decision, a reading or a note is reported. */
  now: () => Promise<number>
  /** The host's toast, as `toast: (text) => $.ui.toast(text)`: a route that failed. */
  toast: (text: string) => void
}

// ---- entry one (记一条决定): what a feature hands over ----------------------------

/** What `report` is handed, one kind at a time (see the top of the file). */
export type Reported =
  /** A decision made, or why none was (`ReportedDecision`). */
  | { decision: ReportedDecision }
  /** The decisions of one event, in the order made: one write to the log and one to the board, at most one toast. */
  | { decisions: readonly ReportedDecision[] }
  /** What a feature counts as a loop goes (`Tallied`). */
  | { tally: Tallied }
  /** The person flipped the mod or a feature (`/dp`). */
  | { switched: true }
  /** The decision model in use is not the one asked for: no Perplexity key, so Jev (`DecisionModelEvent`). */
  | { fellBack: DecisionModelEvent }
  /** A pane the person asked for (a digit on the band) that the surface did not place, with the surface's reason; it was closed again. */
  | { unplaced: { reason: string } }
  /** A transcript the person asked for from the pane (an agent's, or the main one back: `agent` null) that the engine did not show, with its reason. */
  | { unviewed: { agent: string | null; reason: string } }

/** What a toast of its own needs of the host: the debug log, the clock and the toast. */
export type NoticeIo = Pick<ReportIo, 'debug' | 'now' | 'toast'>

/** What the decision model's fallback needs of the host: the board (for the turn), the decision log and the debug log. */
export type DecisionModelIo = Pick<ReportIo, 'board' | 'decisions' | 'debug'>

/** The host closures each kind of report needs: a switch only the redraw, a pane not placed the toast, the rest a `ReportIo`. */
type IoOf<R extends Reported> = R extends { switched: true }
  ? SwitchIo
  : R extends { fellBack: DecisionModelEvent }
    ? DecisionModelIo
    : R extends { unplaced: unknown } | { unviewed: unknown }
      ? NoticeIo
      : ReportIo

/**
 * Entry one (记一条决定): reports what a feature hands over, by its kind; `io` is what that kind needs of the host
 * (`IoOf`). Never throws.
 */
export async function report<R extends Reported>(io: IoOf<R>, what: R): Promise<void> {
  const item: Reported = what
  if ('decision' in item) return reportDecisions(io as ReportIo, [item.decision])
  if ('decisions' in item) return reportDecisions(io as ReportIo, item.decisions)
  if ('tally' in item) return reportTally(io as ReportIo, item.tally)
  if ('switched' in item) return reportSwitch(io as SwitchIo)
  if ('fellBack' in item) return reportFellBack(io as DecisionModelIo, item.fellBack)
  if ('unviewed' in item) return reportUnviewed(io as NoticeIo, item.unviewed)
  return reportUnplaced(io as NoticeIo, item.unplaced)
}

/** A transcript the pane asked for and the engine did not show: the debug line and a toast with the engine's reason. Never throws. */
async function reportUnviewed(io: NoticeIo, unviewed: { agent: string | null; reason: string }): Promise<void> {
  try {
    io.debug(`transcript of ${unviewed.agent ?? 'main'} not shown: ${unviewed.reason}`)
    toastOnce(io, await io.now(), unviewed.agent === null ? `没能回到主对话：${unviewed.reason}` : `没能打开这个 agent 的对话：${unviewed.reason}`)
  } catch {
    // a notice that cannot be given leaves the view as it is
  }
}

/** The rationale pane was not placed, in the person's words: why (the surface's own reason), and where to look instead. */
export function unplacedText(reason: string): string {
  return `依据面板没有放出来（${reason}），已经关上；/dp log 10 在对话里列出最近 10 条决定`
}

/**
 * A pane the person asked for that the surface did not place: the debug line, and a toast so they know (the `/dp`
 * command says it in its answer instead), unless a toast went up within `TOAST_GAP_MS`. Never throws.
 */
async function reportUnplaced(io: NoticeIo, unplaced: { reason: string }): Promise<void> {
  try {
    io.debug(`rationale pane not placed (${unplaced.reason}), closed again`)
    toastOnce(io, await io.now(), unplacedText(unplaced.reason))
  } catch {
    // a notice that cannot be given leaves the pane closed all the same
  }
}

/**
 * The decisions of one event (a single one, or the several agents of a Workflow): the debug log line and the
 * decision log entry of each decision made, the agents' nodes on the board, a note for the band when a request
 * beside a route came to nothing, and a toast when a route failed. One write to the log, one to the board, at
 * most one toast; each is what it would make of it alone, in the order given. Never throws.
 */
async function reportDecisions(io: ReportIo, decisions: readonly ReportedDecision[]): Promise<void> {
  if (decisions.length === 0) return
  try {
    // Which turn each is for. A board that cannot be read does not stop a decision from being logged (as turn 1).
    let unread = false
    const board = await read(io.board).catch((error: unknown) => {
      io.debug(`board not read: ${errorText(error)}`)
      unread = true
      return EMPTY
    })
    const now = await io.now()
    const turnOf = (decision: ReportedDecision) => Math.max(unread ? 1 : 0, board.turn + (decision.forTurn === 'next' ? 1 : 0))
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
            all = appendEntry(all, entryOf(decision, turnOf(decision), elapsed(board, turnOf(decision), now)))
            numbers.push(all.at(-1)?.n ?? 0)
          }
          return all
        })
      } catch (error) {
        numbers.length = 0
        io.debug(`decision not kept for /dp log: ${errorText(error)}`)
      }
    }
    // A request beside the route that came to nothing: a note for the band's event stream, after the log's last entry.
    const noted = decisions.filter((decision): decision is Skipped | (NotDecided & { aside: true }) => 'skipped' in decision || ('failure' in decision && decision.aside === true))
    const logged = noted.length === 0 ? 0 : (numbers.at(-1) ?? (await lastLogged(io)))
    const notes = noted.map((decision): BoardNote => {
      const of = { turn: turnOf(decision), id: decision.agent, feature: decision.feature, at: elapsed(board, turnOf(decision), now), after: logged }
      return 'skipped' in decision ? { ...of, kind: 'skipped', why: decision.skipped } : { ...of, kind: 'failed', why: failureLine(decision.failure.backend, decision.failure) }
    })
    let after = board
    // A decision beside the agent's route is not on its node; a Workflow with nothing to show is not on the board.
    const onBoard = (decision: ReportedDecision) => decision.aside !== true && !('skipped' in decision) && !('offBoard' in decision)
    if (decisions.some(onBoard) || notes.length > 0) {
      try {
        after = await update(io.board, (current) => {
          let next = current ?? EMPTY
          let at = 0
          for (const decision of decisions) {
            const n = isDecided(decision) ? numbers[at++] : undefined
            if (onBoard(decision)) next = withNode(next, turnOf(decision), decision as Decided | NotDecided | Left | Started, n)
          }
          return notes.length === 0 ? next : withNotes(next, notes)
        })
      } catch (error) {
        io.debug(`decision not kept on the board: ${errorText(error)}`)
      }
    }
    // The routes that failed: a toast, so the person notices; the board says the rest.
    const failed = decisions.filter((decision): decision is NotDecided => 'failure' in decision && decision.aside !== true)
    if (failed.length > 0) toastOnce(io, now, failedText(failed, after, turnOf))
  } catch (error) {
    io.debug(`decision not reported: ${errorText(error)}`)
  }
}

/** A decision that was made (the others say why there is none, or that an agent started). */
function isDecided(decision: ReportedDecision): decision is Decided {
  return 'outcome' in decision
}

/** The `n` of the decision log's last entry (0: none, or the log cannot be read). */
async function lastLogged(io: ReportIo): Promise<number> {
  try {
    return ((await io.decisions.get()).value ?? []).at(-1)?.n ?? 0
  } catch {
    return 0
  }
}

/** The engine drops a plugin's second toast within this many milliseconds of its last one (measured on 2.1.289). */
const TOAST_GAP_MS = 2000

/** When the last toast was raised (module state: a hot reload forgets it, and the next toast may then be one the engine drops). */
let toastedAt = Number.NEGATIVE_INFINITY

/**
 * Raises the toast unless one was raised within `TOAST_GAP_MS`, which the engine would drop: the failures that
 * follow one closely are on the board all the same.
 */
function toastOnce(io: Pick<ReportIo, 'toast'>, now: number, text: string): void {
  if (now - toastedAt < TOAST_GAP_MS) return
  toastedAt = now
  try {
    io.toast(text)
  } catch {
    // a toast that cannot be shown is skipped: the board has it
  }
}

/** The toast for the routes of one event that failed: who is not routed, and why (the first failure's words, then its details). */
function failedText(failed: readonly NotDecided[], board: Board, turnOf: (decision: ReportedDecision) => number): string {
  const first = failed[0] as NotDecided
  const why = `${failureWords(first.failure)}（${failureLine(first.failure.backend, first.failure)}）`
  if (failed.length > 1) return `${failed.length} 个 agent 未路由：${why}`
  if (first.agent === 'main') return `主 agent 未路由：${why}`
  const name = board.nodes.find((node) => node.turn === turnOf(first) && node.id === first.agent)?.name ?? first.node?.name ?? first.agent
  return `「${name.length > 24 ? `${name.slice(0, 23)}…` : name}」未路由：${why}`
}

/** The board with the notes added: those of turns older than the nodes' dropped, and the oldest past `NOTES_KEPT`. */
function withNotes(board: Board, notes: readonly BoardNote[]): Board {
  return { ...board, notes: [...(board.notes ?? []), ...notes].filter((note) => note.turn >= board.turn - 1).slice(-NOTES_KEPT) }
}

// ---- entry two (记一步读数): a step's reading ----------------------------------------

/** How many writes may be lost to other writers in a row: a Workflow's agents step within milliseconds of each other. */
const READING_ATTEMPTS = 32

/**
 * Entry two (记一步读数): reports the reading of one step, the model (by family) and the effort it
 * went out with, whether the effort was routed, and that the agent is running.
 * Reading never changes what is sent. The agent's node is made at its first
 * step when the board has none (named from the roster of dispatched agents; a
 * Workflow's agent has its node from its spawn, and a loop neither knows is not
 * an agent of the board), carries its start, and a reading that differs from
 * the node's previous one adds a change event. Writes the board only when
 * something is new. Never throws.
 */
export async function reportStep(io: StepIo, step: StepReading): Promise<void> {
  const id = step.agentId ?? 'main'
  const main = step.agentId === undefined
  const family = modelFamily(step.model)
  const effort = typeof step.effort === 'number' || isEffort(step.effort) ? step.effort : undefined
  const reading: Reading = { ...(family === null ? {} : { model: family }), ...(effort === undefined ? {} : { effort }) }
  // `source`: the engine's own effort goes out unless a plan sets it. An agent that was decided to run as it does has no plan
  // to say so (a Workflow script was written into): its reading is checked against its decision below.
  let routed = step.source !== 'engine'
  const locked = step.source === 'locked'
  try {
    const now = await io.now()
    const seen = main ? now : seenAt(id, now)
    const peek = await read(io.board)
    const before = main ? mainNode(peek) : continuing(peek, id)
    // A node that has not begun is named now (the roster may know it only from here on); one that has keeps its name, and
    // a Workflow's agent has its name from its spawn.
    const identity = main || (before !== undefined && (begun(before) || before.kind === 'wf')) ? null : await lookUp(io, id)
    if (!main && before === undefined && identity === null) return
    const prior = main ? undefined : (before ?? callNodeOf(peek, identity))
    if (!routed && prior?.routed === true && prior.decision !== undefined) routed = await wentOutAsDecided(io, prior.decision, reading)
    const logged = before !== undefined && differs(before, reading) ? (((await io.decisions.get()).value ?? []).at(-1)?.n ?? 0) : 0
    await modify(
      io.board,
      (current) => {
        const board = current ?? EMPTY
        const old = main ? mainNode(board) : continuing(board, id)
        if (old === undefined && identity === null && !main) return undefined
        const turn = old?.turn ?? board.turn
        const started = old !== undefined && begun(old)
        // A Workflow's agent that starts takes the place of the node its call stood for, and what was decided for it.
        const stood = old === undefined && !main ? callNodeOf(board, identity) : undefined
        // A node made before its first step (a spawn, a decision) that now goes out routed has nothing left to say of why it would not be.
        const made = old !== undefined && !started && routed ? without(old, 'why', 'failure') : old
        const base = made ?? { ...newNode(turn, id, identity ?? undefined, 'running'), ...carriedFrom(stood, routed) }
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
          nodes: takenOver(board.nodes, old, stood, next),
        }
      },
      READING_ATTEMPTS,
    )
    if (!main) firstSeen.delete(id)
  } catch (error) {
    io.debug(`reading not kept on the board: ${errorText(error)}`)
  }
}

/** Why an agent's turn did not end in an answer, in the board's words (a node's `why` when it failed and nothing else said). */
export const ENDED_WORDS = { error: '出错', refusal: '拒绝回答', aborted: '被中断' } as const

/** How a loop's turn ended (`turn.complete`). */
type LoopEnd = { agentId?: string; reason: 'answer' | 'aborted' | 'refusal' | 'error'; durationMs: number }

/**
 * Reports the end of a loop's turn: done after an answer, else failed (and
 * why, when nothing else said), for as long as it ran. The main agent's turn
 * ends its own node; an agent's, its own, wherever its turn's node is. Never throws.
 */
async function reportEnd(io: StepIo, end: LoopEnd): Promise<void> {
  const id = end.agentId ?? 'main'
  const main = end.agentId === undefined
  try {
    const now = await io.now()
    const peek = await read(io.board)
    const known = main ? mainNode(peek) : continuing(peek, id)
    // The loop is over: whatever its steps missed, it is looked up once more in full.
    missed.delete(id)
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
        const stood = old === undefined && !main ? callNodeOf(board, identity) : undefined
        const base = old ?? { ...newNode(turn, id, identity ?? undefined, 'running'), ...carriedFrom(stood, true) }
        const { reason } = end
        const next: BoardNode = {
          ...base,
          ...(old === undefined && !main ? { t0: elapsed(board, turn, seen) } : {}),
          state: reason === 'answer' ? 'done' : 'failed',
          dur: Math.round(end.durationMs) / 1000,
          ...(reason !== 'answer' && base.why === undefined ? { why: ENDED_WORDS[reason] } : {}),
        }
        return { ...board, nodes: takenOver(board.nodes, old, stood, next) }
      },
      READING_ATTEMPTS,
    )
    if (!main) firstSeen.delete(id)
  } catch (error) {
    io.debug(`end of loop not kept on the board: ${errorText(error)}`)
  }
}

/**
 * Reports an agent started: queued until its first step. Its node is made (or,
 * when a decision about it made one, marked queued from now); the agent's own
 * first step starts it. A Workflow's agent (`workflow`: the Workflow tool
 * call's id) is called by its label, and takes the place of the node its call
 * stood for. Never throws.
 */
async function reportSpawn(io: StepIo, spawn: { agentId: string; name?: string; description: string; type: string; workflow?: string }): Promise<void> {
  try {
    const now = await io.now()
    const identity: Identity =
      spawn.workflow === undefined
        ? { kind: 'agent', name: nameOf(spawn.name, spawn.description, spawn.agentId), type: spawn.type }
        : { kind: 'wf', name: nameOf(undefined, spawn.description, spawn.agentId), type: 'workflow' }
    await modify(
      io.board,
      (current) => {
        const board = current ?? EMPTY
        const old = continuing(board, spawn.agentId)
        if (old !== undefined && begun(old)) return undefined
        const turn = old?.turn ?? board.turn
        const stood = old === undefined ? callNodeOf(board, identity, spawn.workflow) : undefined
        // Routed as its call was: its first step is checked against the call's decision.
        const base = old ?? { ...newNode(turn, spawn.agentId, identity, 'queued'), ...carriedFrom(stood, false), routed: stood?.routed ?? false }
        const next: BoardNode = { ...base, state: 'queued', t0: elapsed(board, turn, now) }
        return { ...board, nodes: takenOver(board.nodes, old, stood, next) }
      },
      READING_ATTEMPTS,
    )
  } catch (error) {
    io.debug(`agent not kept on the board: ${errorText(error)}`)
  }
}

// ---- what `report` does with a tally --------------------------------------------

/**
 * Reports what a feature counts as its loop goes, which is no decision: each
 * loop's failed tool calls and model step-ups, an agent's visual checks. On
 * the agent's node of the current turn (`counts`, `visualChecks`). Writes the
 * board only when the node changed. Never throws.
 */
async function reportTally(io: ReportIo, tally: Tallied): Promise<void> {
  try {
    await modify(io.board, (current) => withTally(current ?? EMPTY, tally))
  } catch (error) {
    io.debug(`tally not kept on the board: ${errorText(error)}`)
  }
}

// ---- what `report` does with a switch -------------------------------------------

/** What a switch needs of the host: `() => $.ui.invalidate('ui.render')`, the screens drawn again. */
export type SwitchIo = { redraw: () => void }

/**
 * Reports a switch the person flipped (the control feature's `/dp`). The board
 * and the decision log keep what they hold: the screens read the switches as
 * they draw, and leave out what a feature that is off owns (its decisions, the
 * parts of the nodes it writes, `defineSwitch`'s `parts`), so they are drawn
 * again now. Never throws.
 */
function reportSwitch(io: SwitchIo): void {
  try {
    io.redraw()
  } catch {
    // a redraw that cannot be asked for waits for the next change of the board
  }
}

/**
 * The board with the tally on its agent's node (the main agent's of the turn running, an agent's where its steps
 * go on: `continuing`); undefined when the node already says it, or there is nothing to say. A loop with no node is
 * no agent of the board (the readings make nodes), the main agent's is made.
 */
function withTally(board: Board, tally: Tallied): Board | undefined {
  const main = tally.agent === 'main'
  const old = main ? mainNode(board) : continuing(board, tally.agent)
  if (old === undefined && !main) return undefined
  let next: BoardNode
  if (tally.feature === 'visual-check') {
    const added = tally.passed + tally.failed + tally.unsure + (tally.takeovers ?? 0)
    if (added === 0) return undefined
    const was = old?.visualChecks
    const takeovers = (was?.takeovers ?? 0) + (tally.takeovers ?? 0)
    const visualChecks = { passed: (was?.passed ?? 0) + tally.passed, failed: (was?.failed ?? 0) + tally.failed, unsure: (was?.unsure ?? 0) + tally.unsure, ...(takeovers > 0 ? { takeovers } : {}) }
    next = { ...(old ?? newNode(board.turn, tally.agent, undefined, 'running')), visualChecks }
  } else {
    const any = tally.failed + tally.blocked + tally.raised > 0
    if (old === undefined && !any) return undefined
    const base = old ?? newNode(board.turn, tally.agent, undefined, 'running')
    next = any ? { ...base, counts: { failed: tally.failed, blocked: tally.blocked, raised: tally.raised } } : without(base, 'counts')
  }
  if (old !== undefined && JSON.stringify(old) === JSON.stringify(next)) return undefined
  return { ...board, nodes: [...board.nodes.filter((node) => node !== old), next] }
}

/** What a dispatched agent is called on the board: its name, else its description, else its id. */
function nameOf(name: string | undefined, description: string, id: string): string {
  return name !== undefined && name !== '' ? name : description !== '' ? description : id
}

/** Who a loop with no node is, from what the engine says; null: not an agent the board shows. */
type Identity = { kind: 'agent' | 'wf'; name: string; type: string }

/** Who a loop is, by the roster; null when it is not there, or the roster cannot be read. */
async function identify(io: StepIo, id: string): Promise<Identity | null> {
  try {
    const info = (await io.agents()).find((agent) => agent.id === id)
    return info === undefined ? null : { kind: 'agent', name: nameOf(info.name, info.description, id), type: info.type }
  } catch (error) {
    io.debug(`agent roster not read: ${errorText(error)}`)
    return null
  }
}

/**
 * The loops a step found no one to be, by id: how many of their steps have looked. Module state: a hot reload forgets
 * it, and costs each such loop one look-up more.
 */
const missed = new Map<string, number>()
const MISSED_KEPT = 64

/**
 * `identify` for a step, at most as often as the answer can change: the first step of a loop no one knows (an engine
 * fork) reads the roster, and its later steps would read it again. After a miss, the roster is read again at the
 * loop's 2nd, 4th, 8th... step (an agent it lists late).
 */
async function lookUp(io: StepIo, id: string): Promise<Identity | null> {
  const sightings = (missed.get(id) ?? 0) + 1
  const found = missed.get(id) === undefined || (sightings & (sightings - 1)) === 0 ? await identify(io, id) : null
  // The newest miss goes last, so the oldest go first past `MISSED_KEPT`.
  missed.delete(id)
  if (found !== null) return found
  missed.set(id, sightings)
  for (const key of missed.keys()) if (missed.size > MISSED_KEPT) missed.delete(key)
  return null
}

/**
 * When a loop no node was made for was first seen (module state: a hot reload forgets it, and an agent only
 * found later then starts at that step). An agent the roster lists late has its name from a later step, or from
 * the end of its loop, and starts when it first stepped.
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

/**
 * The node a Workflow call of a script stands for before its agent starts (a decision was made for the call, or it
 * was left as written): one of the Workflow's calls (of the Workflow `workflow`, when it is given), queued and called
 * what the agent's label is; else one whose label is a template the agent's label fits (`verify:${b.id}` for
 * `verify:st4`), queued or already started by another of its agents. Null when there is none, or the agent is not a
 * Workflow's.
 */
function callNodeOf(board: Board, identity: Identity | null | undefined, workflow?: string): BoardNode | undefined {
  if (identity === null || identity === undefined || identity.kind !== 'wf') return undefined
  const calls = board.nodes.filter(
    (node) => node.kind === 'wf' && node.workflow !== undefined && callWorkflowOf(node.id) === node.workflow.id && (workflow === undefined || node.workflow.id === workflow),
  )
  return (
    calls.find((node) => node.state === 'queued' && node.name === identity.name) ??
    calls.find((node) => (node.state === 'queued' || node.state === 'running') && fitsTemplate(node.name, identity.name))
  )
}

/**
 * The board's nodes once `next` takes the place of `old` (its own node before, if any) and of the call node it
 * `stood` for. A call written as a template stands for every agent it starts: it stays, marked started (`running`),
 * for the agents after this one, and the screens leave it out (`isCallNode`).
 */
function takenOver(nodes: readonly BoardNode[], old: BoardNode | undefined, stood: BoardNode | undefined, next: BoardNode): BoardNode[] {
  const kept = stood !== undefined && stood.name.includes('${') ? { ...stood, state: 'running' as const } : undefined
  return [...nodes.filter((node) => node !== old && node !== stood), ...(kept === undefined ? [] : [kept]), next]
}

/** What a Workflow's agent takes over from the node its call stood for: the Workflow, the decision made for it, and why it was left as written (when its steps go out unrouted). */
function carriedFrom(stood: BoardNode | undefined, routed: boolean): Partial<BoardNode> {
  if (stood === undefined) return {}
  return {
    ...(stood.workflow === undefined ? {} : { workflow: stood.workflow }),
    ...(stood.decision === undefined ? {} : { decision: stood.decision }),
    ...(routed || stood.why === undefined ? {} : { why: stood.why }),
    ...(routed || stood.failure === undefined ? {} : { failure: stood.failure }),
  }
}

/** Whether a reading is the model and effort the decision numbered `n` in the log decided for the agent (a decision that names none: no). */
async function wentOutAsDecided(io: ReportIo, n: number, reading: Reading): Promise<boolean> {
  try {
    const entry = ((await io.decisions.get()).value ?? []).find((kept) => kept.n === n)
    return entry?.model !== undefined && entry.model === reading.model && entry.effort === reading.effort
  } catch {
    return false
  }
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

/**
 * The board when a main turn starts at `now`: the count up by one, the nodes of older turns gone (the turn before it
 * stays: it is folded into one line). A node still running or queued stays in its turn, with that turn's start, for as
 * long as the log keeps its decisions (`LOG_TURNS`): a Workflow's agents, and its calls whose agents have not started,
 * outlive the turn that launched it while the person goes on talking. A stopped Workflow's agents end (`turn.complete`,
 * `aborted`); the calls of agents it never started stay queued until then, and the screens leave them out.
 */
function startTurn(board: Board | undefined, now: number): Board {
  const turn = (board?.turn ?? 0) + 1
  const kept = (of: number) => of >= turn - 1
  // The main agent's turn is over when the next one starts, whatever its node says.
  const live = (node: BoardNode) => node.id !== 'main' && (node.state === 'running' || node.state === 'queued') && node.turn > turn - LOG_TURNS
  const nodes = (board?.nodes ?? []).filter((node) => kept(node.turn) || live(node))
  return {
    turn,
    starts: [...(board?.starts ?? []).filter((start) => kept(start.turn) || nodes.some((node) => node.turn === start.turn)), { turn, at: now }],
    ...(board?.changes === undefined ? {} : { changes: board.changes.filter((change) => kept(change.turn)) }),
    ...(board?.notes === undefined ? {} : { notes: board.notes.filter((note) => kept(note.turn)) }),
    nodes,
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
    now: () => $.clock.now(),
    toast: (text) => $.ui.toast(text),
    agents: () => $.agent.list(),
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
    // The board counts the main loop's turns; an agent's run is a turn of its own loop (2.1.299 on).
    if (e.agentId !== undefined) return next(e)
    try {
      const now = await $.clock.now()
      await update(stepIo($).board, (board) => startTurn(board, now))
    } catch {
      // the count is the board's own: a turn starts without it
    }
    return next(e)
  })

  on('agent.spawn', { tool_use_id: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined || result.agentId === undefined) return result
    // A Workflow's agent is on the board, in its call's place, while Dispatch Pilot is on.
    if (e.workflow !== undefined && !masterOn()) return result
    await reportSpawn(stepIo($), {
      agentId: result.agentId,
      ...(e.name === undefined ? {} : { name: e.name }),
      description: e.description,
      type: e.subagentType,
      ...(e.workflow === undefined ? {} : { workflow: e.tool_use_id }),
    })
    return result
  })

  on('turn.complete', { turnId: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    await reportEnd(stepIo($), { ...(e.agentId === undefined ? {} : { agentId: e.agentId }), reason: e.reason, durationMs: e.durationMs })
    return result
  })
}

// ---- the log ------------------------------------------------------------------

/** A decision as one line: `effort high · "the message"：why`. The debug log's line, and `/dp log N`'s after `#n feature：`. */
export function decisionLine(decision: { outcome: string; subject?: string; reason: string }): string {
  return `${decision.outcome}${decision.subject ? ` · ${decision.subject}` : ''}：${decision.reason}`
}

/** The list with `entry` added last, numbered, the entries of turns older than the latest `LOG_TURNS` dropped, and then the oldest past `LOG_ENTRIES`. */
function appendEntry(list: readonly LogEntry[], entry: Omit<LogEntry, 'n'>): LogEntry[] {
  const all = [...list, { n: (list.at(-1)?.n ?? 0) + 1, ...entry }]
  const latest = Math.max(...all.map((kept) => kept.turn))
  return all.filter((kept) => kept.turn > latest - LOG_TURNS).slice(-LOG_ENTRIES)
}

function entryOf(decision: Decided, turn: number, at: number): Omit<LogEntry, 'n'> {
  return {
    turn,
    at,
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
    ...(decision.model === undefined ? {} : { model: decision.model }),
    ...(decision.effort === undefined ? {} : { effort: decision.effort }),
    ...(decision.forced === undefined ? {} : { forced: decision.forced }),
    ...(decision.skills === undefined ? {} : { skills: decision.skills }),
    ...(decision.counts === undefined ? {} : { counts: decision.counts }),
    ...(decision.reference === undefined ? {} : { reference: decision.reference }),
    ...(decision.unresolved === undefined ? {} : { unresolved: decision.unresolved }),
    ...(decision.visualCheck === undefined ? {} : { visualCheck: decision.visualCheck }),
    ...(decision.sentBack === true ? { sentBack: true as const } : {}),
  }
}

// ---- the board ----------------------------------------------------------------

const EMPTY: Board = { turn: 0, nodes: [] }

function newNode(turn: number, id: string, node: About['node'], state: AgentState): BoardNode {
  if (id === 'main') return { turn, id, kind: 'main', name: '主 agent', type: 'main', state, t0: 0, routed: false }
  return { turn, id, kind: node?.kind ?? 'agent', name: node?.name ?? id, type: node?.type ?? 'agent', state: node?.state ?? state, t0: 0, routed: false, ...(node?.workflow === undefined ? {} : { workflow: node.workflow }) }
}

/** The board with the decision on its agent's node of `turn` (the node made when there is none), `n` the decision's number in the log when it has one. */
function withNode(board: Board, turn: number, decision: Decided | NotDecided | Left | Started, n: number | undefined): Board {
  const old = board.nodes.find((node) => node.turn === turn && node.id === decision.agent)
  const late = old === undefined ? lateCall(board, turn, decision, n) : undefined
  if (late !== undefined) return late
  // The node that stood for the agent before it started gives it what was decided for it, and goes (a template's stays, started).
  const stood = old === undefined && decision.replaces !== undefined ? board.nodes.find((node) => node.id === decision.replaces) : undefined
  const inherited = stood?.decision === undefined ? {} : { decision: stood.decision }
  const base = old ?? { ...newNode(turn, decision.agent, decision.node, decision.forTurn === 'next' ? 'queued' : 'running'), ...inherited }
  return { ...board, nodes: takenOver(board.nodes, old, stood, decided(base, decision, n)) }
}

/** `base` with the decision on it: what was decided and whether it routed, or why not. */
function decided(base: BoardNode, decision: Decided | NotDecided | Left | Started, n: number | undefined): BoardNode {
  const routed = decision.routed === undefined ? {} : { routed: decision.routed }
  if ('failure' in decision) return { ...base, ...routed, why: failureLine(decision.failure.backend, decision.failure), failure: decision.failure }
  if ('why' in decision) return { ...without(base, 'failure'), routed: false, why: decision.why }
  if ('started' in decision) return { ...without(base, 'why', 'failure'), routed: true, state: 'running' }
  return {
    ...(decision.routed === true ? without(base, 'why', 'failure') : base),
    ...routed,
    ...(n === undefined ? {} : { decision: n }),
  }
}

/**
 * The board once a Workflow call's decision reaches it after the call's agents have started, undefined when none has:
 * the engine spawns a run's first agents before the Workflow tool returns (2.1.302), and workflow-agents reports its
 * calls after it does, so an agent can be on the board, named by its label, before its call. Each such agent of this
 * turn (one not yet of any Workflow, nor decided, called what the call is or fitting its template) takes the decision
 * and the Workflow; the call waits on the board no more (a template's stays, started, for its agents to come).
 */
function lateCall(board: Board, turn: number, decision: Decided | NotDecided | Left | Started, n: number | undefined): Board | undefined {
  const node = decision.node
  if (callWorkflowOf(decision.agent) === null || node?.kind !== 'wf' || node.workflow === undefined) return undefined
  const started = board.nodes.filter(
    (one) =>
      one.turn === turn &&
      one.kind === 'wf' &&
      callWorkflowOf(one.id) === null &&
      one.workflow === undefined &&
      one.decision === undefined &&
      (one.state === 'queued' || one.state === 'running') &&
      (one.name === node.name || fitsTemplate(node.name, one.name)),
  )
  if (started.length === 0) return undefined
  const taken = new Map(started.map((one) => [one, { ...decided({ ...one, workflow: node.workflow }, decision, n), state: one.state }] as const))
  const nodes = board.nodes.map((one) => taken.get(one) ?? one)
  // A template's call stands for its agents still to come: started, so the screens leave it out (`isCallNode`).
  const template = node.name.includes('${') ? [decided({ ...newNode(turn, decision.agent, node, 'running'), state: 'running' }, decision, n)] : []
  return { ...board, nodes: [...nodes, ...template] }
}

/** The value of a cell, or the empty board. */
async function read(cell: Cell<Board>): Promise<Board> {
  return (await cell.get()).value ?? EMPTY
}

/** The turn a session start belongs to: the board's, and at least 1, where the first message will be (a board that cannot be read puts it there). */
async function sessionTurn(cell: Cell<Board>): Promise<number> {
  return Math.max(1, (await read(cell).catch(() => EMPTY)).turn)
}

/** The list with `entry` in the place of the entry `same` finds, keeping its number; else added last. */
function replacingOrAppending(list: readonly LogEntry[], same: (kept: LogEntry) => boolean, entry: Omit<LogEntry, 'n'>): LogEntry[] {
  const at = list.findIndex(same)
  return at < 0 ? appendEntry(list, entry) : list.map((kept, i) => (i === at ? { n: kept.n, ...entry } : kept))
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

// ---- what `report` does with the decision model's fallback ------------------------------

/**
 * The model that takes requests with images is not the one it should be (#56, ADR 0008): `asked` is Jev, `using` pplx, since
 * there is no TypeSafe key, so it cannot zoom. The decision model itself never falls back (ADR 0014).
 */
export type DecisionModelEvent = {
  asked: BackendName
  using: BackendName
  for: 'images'
}

/** What a person reads of each decision model: its name, and the settings that hold its key (the options' names and the environment variable they type). The one place both are written. */
const DECISION_MODELS: Readonly<Record<BackendName, { name: string; keys: string }>> = {
  pplx: { name: 'pplx', keys: 'perplexityApiKey 或环境变量 PERPLEXITY_API_KEY' },
  jev: { name: 'Jev', keys: 'typesafeApiKey 或环境变量 TYPESAFE_API_KEY' },
  'd1-ultra': { name: 'd1-ultra', keys: 'liquidApiKey 或环境变量 LIQUID_API_KEY' },
}

/** The feature name of the entry the fallback leaves in the decision log. */
const DECISION_MODEL_FEATURE = 'decision-model'

/**
 * The session's one entry in the decision log saying why another model takes the images: at the turn the session start
 * belongs to, with the debug line. A session start again at the same turn (a hot reload) takes the place of the entry
 * before. Not on the board's nodes, in no band or footer, and no toast. Never throws.
 */
async function reportFellBack(io: DecisionModelIo, fell: DecisionModelEvent): Promise<void> {
  try {
    const asked = DECISION_MODELS[fell.asked]
    const using = DECISION_MODELS[fell.using]
    const turn = await sessionTurn(io.board)
    const entry: Omit<LogEntry, 'n'> = {
      turn,
      feature: DECISION_MODEL_FEATURE,
      tone: 'info',
      fallbackFor: fell.for,
      outcome: `看图改用 ${using.name}`,
      subject: '',
      reason: `没有 ${asked.name} 的密钥（${asked.keys}），看图改用 ${using.name}，放大复核不可用；补上密钥就用 ${asked.name}`,
    }
    io.debug(`decision model: ${decisionLine(entry)}`)
    // The entry of the same kind at this turn (a hot reload's session start again); the one for images stands beside the decision model's.
    await update(io.decisions, (list) => replacingOrAppending(list ?? [], (old) => old.feature === DECISION_MODEL_FEATURE && old.turn === turn && old.fallbackFor === entry.fallbackFor, entry))
  } catch (error) {
    try {
      io.debug(`decision model fallback not reported: ${errorText(error)}`)
    } catch {
      // nowhere left to say it
    }
  }
}
