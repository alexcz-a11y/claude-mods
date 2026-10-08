// The decision report (「决定汇报」, ADR 0004): the one writer of what Dispatch
// Pilot shows people. The board, the decision log, the debug log and the toasts
// are all written here, from the same structured data in $.state
// (types/index.d.ts: `board`, `decisionLog`, `skillProfiles`); the screens
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
//                           `tally`, what a feature counts as a loop goes (the
//                           mid-turn re-decisions, a loop's failed calls and
//                           forced raises: on the agent's node); `switched`, the
//                           person flipped the mod or a feature (`/dp`: the
//                           screens draw again); `profiles`, how writing the
//                           session's skill profiles goes (#33); `unplaced`, a
//                           pane the person asked for that the surface did not
//                           place (a toast). `io` is what that kind needs of the
//                           host (`IoOf`): a `ReportIo` for most.
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
// `appendEntry`, `startTurn`, `profileWhy`, the types) only shapes or reads data.
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
import type { UnresolvedChange, UnresolvedOption, UnresolvedThresholds } from '../decision/unresolved.ts'
import { startedIn } from '../decision/workflow-labels.ts'
import { type Cell, type EffortSource, update } from './plans.ts'

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
  /** The main agent's mid-turn re-decisions of the turn: steps made, decisions, level changes; `late`: an answer is not back, `failure`: the latest request failed. midturn-effort's. */
  midturn?: { steps: number; judged: number; changed: number; late?: true; failure?: NodeFailure }
  /** The failed tool calls, hook blocks and forced raises of the agent's loop (the escalation feature counts them); absent while none. */
  counts?: { failed: number; blocked: number; raised: number; late?: true }
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
 * gave nothing to use (`skipped`, `why` the Skip), an answer not back in time (`late`, `why` '').
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
  kind: 'failed' | 'skipped' | 'late'
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
  mid?: { current: Effort; picked: Effort; result: Effort; threshold?: number; held?: string; remaining?: number }
  forced?: ForcedRaise
  skills?: SkillsPicked
  counts?: { failed: number; blocked: number; raised: number }
  /** A Workflow call's decision that was sent back to the main agent to write in (return mode). */
  sentBack?: true
  /** An unresolved-count judgement (`unresolved`). */
  unresolved?: UnresolvedRecord
  /** The strong hint was given with this decision's request (#41). */
  hint?: HintRecord
}

/** The strong hint given with a request: the count it was given at, the setting it had reached, and `mid` when it was a mid-turn re-decision's. */
export type HintRecord = { count: number; maxAfter: number; where?: 'mid' }

/**
 * What one message's answer to the unresolved question did to the count: the count before and after, the change, the
 * option the answer leaned to most and every option's probability, the backend's confidence (on record only), and
 * the two bars it was held to. The card draws it as it is; nothing is worked out again (ADR 0004).
 */
export type UnresolvedRecord = {
  before: number
  count: number
  change: UnresolvedChange
  top: UnresolvedOption
  probs: Record<UnresolvedOption, number>
  conf?: number
  thresholds: UnresolvedThresholds
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
  /** The model (by family) and the effort it decided for an agent: in the log entry, since the node's own are what its steps read. */
  model?: Model
  effort?: Effort
  /** A Workflow call's decision that was sent back to the main agent to write in (return mode). */
  sentBack?: true
  forced?: ForcedRaise
  skills?: SkillsPicked
  counts?: LogEntry['counts']
  unresolved?: UnresolvedRecord
  hint?: HintRecord
}

/** A decision the feature could not make: the decision request failed. Not an entry of the log; it says why on the agent's node. */
export type NotDecided = About & { failure: NodeFailure }

/**
 * No decision was asked for, or none could be made without a failed request: why the agent (or the Workflow) runs
 * as it was written, in a few words, on its node. Not a log entry. `asWritten`: by design, not a miss (the Workflow
 * was already sent back once). `offBoard`: nothing to show at all, so nothing is written (a script with no agent()
 * call).
 */
export type Left = About & { why: string; asWritten?: true; offBoard?: true }

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
  /** The main agent's turn as the mid-turn re-decision sees it. `quiet`: not re-decided yet this turn (nothing to show). `late`: the answer for this step is not back; `failure`: its request failed. */
  | { feature: 'midturn-effort'; agent: 'main'; steps: number; judged: number; changed: number; quiet: boolean; late?: true; failure?: NodeFailure }
  /** A loop's failed tool calls, hook blocks and forced raises. `turnStart`: the main agent's counts start over with a new turn. */
  | { feature: 'escalation'; agent: string; failed: number; blocked: number; raised: number; late?: true; turnStart?: true }

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
 * What the readings need beyond `ReportIo`: the roster of dispatched agents, and the directories of the session's
 * Workflow runs (to tell a Workflow's agent, and its label, from the journal). `stepIo($)` builds it.
 */
export type StepIo = ReportIo & {
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
  | { switched: Switched }
  /** How writing the session's skill profiles goes (`ProfileEvent`). */
  | { profiles: ProfileEvent }
  /** The decision model in use is not the one asked for: no Perplexity key, so Jev (`DecisionModelEvent`). */
  | { fellBack: DecisionModelEvent }
  /** A pane the person asked for (a digit on the band) that the surface did not place, with the surface's reason; it was closed again. */
  | { unplaced: { reason: string } }

/** What a toast of its own needs of the host: the debug log, the clock and the toast. */
export type NoticeIo = Pick<ReportIo, 'debug' | 'now' | 'toast'>

/** What the decision model's fallback needs of the host: the board (for the turn), the decision log and the debug log. */
export type DecisionModelIo = Pick<ReportIo, 'board' | 'decisions' | 'debug'>

/** The host closures each kind of report needs: a switch only the redraw, the skill profiles their own state, a pane not placed the toast, the rest a `ReportIo`. */
export type IoOf<R extends Reported> = R extends { switched: Switched }
  ? SwitchIo
  : R extends { profiles: ProfileEvent }
    ? ProfilesIo
    : R extends { fellBack: DecisionModelEvent }
      ? DecisionModelIo
      : R extends { unplaced: unknown }
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
  if ('switched' in item) return reportSwitch(io as SwitchIo, item.switched)
  if ('profiles' in item) return reportProfiles(io as ProfilesIo, item.profiles)
  if ('fellBack' in item) return reportFellBack(io as DecisionModelIo, item.fellBack)
  return reportUnplaced(io as NoticeIo, item.unplaced)
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
    const board = await read(io.board).catch((error: unknown) => {
      io.debug(`board not read: ${errorText(error)}`)
      return EMPTY
    })
    const now = await io.now()
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
    const noted = decisions.filter((decision) => 'skipped' in decision || ('failure' in decision && decision.aside === true))
    const logged = noted.length === 0 ? 0 : (numbers.at(-1) ?? (await lastLogged(io)))
    const notes = noted.map((decision): BoardNote => {
      const of = { turn: turnOf(decision), id: decision.agent, feature: decision.feature, at: elapsed(board, turnOf(decision), now), after: logged }
      return 'skipped' in decision ? { ...of, kind: 'skipped', why: decision.skipped } : { ...of, kind: 'failed', why: 'failure' in decision ? failureLine(decision.failure.backend, decision.failure) : '' }
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
  const effort = typeof step.effort === 'number' || isEffort(step.effort) ? step.effort : undefined
  const reading: Reading = { ...(family === null ? {} : { model: family }), ...(effort === undefined ? {} : { effort }) }
  // `source`: the engine's own effort goes out unless a plan sets it. An agent that was decided to run as it does has no plan
  // to say so (haiku takes no effort, a Workflow script was written into): its reading is checked against its decision below.
  let routed = step.source !== 'engine'
  const locked = step.source === 'locked'
  try {
    const now = await io.now()
    const seen = main ? now : seenAt(id, now)
    const peek = await read(io.board)
    const before = main ? mainNode(peek) : continuing(peek, id)
    // A node that has not begun is named now (the roster may know it only from here on); one that has keeps its name.
    const identity = main || (before !== undefined && begun(before)) ? null : await lookUp(io, id)
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
        const base = old ?? { ...newNode(turn, id, identity ?? undefined, 'running'), ...carriedFrom(stood, routed) }
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
          nodes: [...board.nodes.filter((node) => node !== old && node !== stood), next],
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
export type LoopEnd = { agentId?: string; reason: 'answer' | 'aborted' | 'refusal' | 'error'; durationMs: number }

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
    const identity = main || known !== undefined ? null : (await identify(io, id, { roster: true, dirs: await runDirsOf(io) })).identity
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
        const failed = end.reason !== 'answer'
        const next: BoardNode = {
          ...base,
          ...(old === undefined && !main ? { t0: elapsed(board, turn, seen) } : {}),
          state: failed ? 'failed' : 'done',
          dur: Math.round(end.durationMs) / 1000,
          ...(failed && base.why === undefined ? { why: end.reason === 'aborted' ? ENDED_WORDS.aborted : end.reason === 'refusal' ? ENDED_WORDS.refusal : ENDED_WORDS.error } : {}),
        }
        return { ...board, nodes: [...board.nodes.filter((node) => node !== old && node !== stood), next] }
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
async function reportSpawn(io: StepIo, spawn: { agentId: string; name?: string; description: string; type: string }): Promise<void> {
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

// ---- what `report` does with a tally --------------------------------------------

/**
 * Reports what a feature counts as its loop goes, which is no decision: the
 * mid-turn re-decision's steps, decisions and changes of the main agent's
 * turn, and each loop's failed tool calls and forced raises. On the agent's
 * node of the current turn (`midturn`, `counts`); an answer that is late, or a
 * re-decision's request that failed, is also a note for the band's event
 * stream. Writes the board only when the node changed. Never throws.
 */
async function reportTally(io: ReportIo, tally: Tallied): Promise<void> {
  try {
    const noteworthy = tally.late === true || ('failure' in tally && tally.failure !== undefined)
    const now = await io.now()
    const logged = noteworthy ? await lastLogged(io) : 0
    await modify(io.board, (current) => withTally(current ?? EMPTY, tally, { now, logged }))
  } catch (error) {
    io.debug(`tally not kept on the board: ${errorText(error)}`)
  }
}

// ---- what `report` does with a switch -------------------------------------------

/** What the person flipped with `/dp`: the whole mod, or one feature. */
export type Switched = { master: boolean } | { feature: string; on: boolean }

/** What a switch needs of the host: `() => $.ui.invalidate('ui.render')`, the screens drawn again. */
export type SwitchIo = { redraw: () => void }

/**
 * Reports a switch the person flipped (the control feature's `/dp`). The board
 * and the decision log keep what they hold: the screens read the switches as
 * they draw, and leave out what a feature that is off owns (its decisions, the
 * parts of the nodes it writes, `defineSwitch`'s `parts`), so they are drawn
 * again now. Never throws.
 */
function reportSwitch(io: SwitchIo, _change: Switched): void {
  try {
    io.redraw()
  } catch {
    // a redraw that cannot be asked for waits for the next change of the board
  }
}

/**
 * The board with the tally on its agent's node (the main agent's of the turn running, an agent's where its steps
 * go on: `continuing`), and a note when an answer just went late or a request just failed; undefined when the
 * node already says it, or there is nothing to say. A loop with no node is no agent of the board (the readings
 * make nodes), the main agent's is made.
 */
function withTally(board: Board, tally: Tallied, when: { now: number; logged: number }): Board | undefined {
  const main = tally.agent === 'main'
  const old = main ? mainNode(board) : continuing(board, tally.agent)
  if (old === undefined && !main) return undefined
  let next: BoardNode
  const notes: BoardNote[] = []
  const note = (turn: number, kind: BoardNote['kind'], why: string) =>
    notes.push({ turn, id: tally.agent, feature: tally.feature, at: elapsed(board, turn, when.now), after: when.logged, kind, why })
  if (tally.feature === 'midturn-effort') {
    if (tally.quiet) return undefined
    const midturn = { steps: tally.steps, judged: tally.judged, changed: tally.changed, ...(tally.late === true ? { late: true as const } : {}), ...(tally.failure === undefined ? {} : { failure: tally.failure }) }
    next = { ...(old ?? newNode(board.turn, tally.agent, undefined, 'running')), midturn }
    if (tally.late === true && old?.midturn?.late !== true) note(next.turn, 'late', '')
    if (tally.failure !== undefined && JSON.stringify(old?.midturn?.failure) !== JSON.stringify(tally.failure)) note(next.turn, 'failed', failureLine(tally.failure.backend, tally.failure))
  } else {
    const any = tally.failed + tally.blocked + tally.raised > 0
    if (old === undefined && !any) return undefined
    const base = old ?? newNode(board.turn, tally.agent, undefined, 'running')
    next = any
      ? { ...base, counts: { failed: tally.failed, blocked: tally.blocked, raised: tally.raised, ...(tally.late === true ? { late: true as const } : {}) } }
      : without(base, 'counts')
    if (tally.late === true && old?.counts?.late !== true) note(next.turn, 'late', '')
  }
  if (old !== undefined && JSON.stringify(old) === JSON.stringify(next)) return undefined
  const changed = { ...board, nodes: [...board.nodes.filter((node) => node !== old), next] }
  return notes.length === 0 ? changed : withNotes(changed, notes)
}

/** Who a loop with no node is, from what the engine and the Workflow journals say; null: not an agent the board shows. */
type Identity = { kind: 'agent' | 'wf'; name: string; type: string }

/**
 * Who a loop is, by the roster (`roster`) and the journals of the run directories `dirs` (null: none read). `read`
 * is false when the directories or a journal could not be read, so a miss may not be one.
 */
async function identify(io: StepIo, id: string, look: { roster: boolean; dirs: readonly string[] | null }): Promise<{ identity: Identity | null; read: boolean }> {
  if (look.roster) {
    try {
      const info = (await io.agents()).find((agent) => agent.id === id)
      if (info !== undefined) return { identity: { kind: 'agent', name: info.name !== undefined && info.name !== '' ? info.name : info.description !== '' ? info.description : id, type: info.type }, read: true }
    } catch (error) {
      io.debug(`agent roster not read: ${errorText(error)}`)
    }
  }
  if (look.dirs === null) return { identity: null, read: false }
  try {
    // A Workflow's agents are in no roster: the journal of the run it started in has the label it started under.
    for (const dir of [...look.dirs].reverse()) {
      const journal = await io.journal(dir)
      const start = journal === null ? null : startedIn(journal, id)
      if (start !== null) return { identity: { kind: 'wf', name: start.label, type: 'workflow' }, read: true }
    }
  } catch (error) {
    io.debug(`workflow journals not read: ${errorText(error)}`)
    return { identity: null, read: false }
  }
  return { identity: null, read: true }
}

/** The session's Workflow run directories, oldest first; null when they cannot be read. */
async function runDirsOf(io: StepIo): Promise<readonly string[] | null> {
  try {
    return await io.runDirs()
  } catch (error) {
    io.debug(`workflow journals not read: ${errorText(error)}`)
    return null
  }
}

/**
 * The loops a step found no one to be, by id: how many of its steps have looked, and the run directories whose
 * journals it was looked for in (null: they could not be read). Module state: a hot reload forgets it, and costs each
 * such loop one full look-up more.
 */
const missed = new Map<string, { sightings: number; dirs: string | null }>()
const MISSED_KEPT = 64

/**
 * `identify` for a step, at most as often as the answer can change: the first step of a loop no one knows (an engine
 * fork) reads the roster and every run's journal, and its later steps would read them all again. After a miss, the
 * journals are read again only once the session has another run directory (a Workflow's agent can step before its run
 * is recorded), or after they could not be read; the roster at the loop's 2nd, 4th, 8th... step (an agent it lists late).
 */
async function lookUp(io: StepIo, id: string): Promise<Identity | null> {
  const miss = missed.get(id)
  const sightings = (miss?.sightings ?? 0) + 1
  const roster = miss === undefined || (sightings & (sightings - 1)) === 0
  const dirs = await runDirsOf(io)
  const seen = dirs === null ? null : dirs.join('\n')
  const journals = miss === undefined || seen === null || miss.dirs === null ? roster : seen !== miss.dirs
  const found = roster || journals ? await identify(io, id, { roster, dirs: journals ? dirs : null }) : { identity: null, read: true }
  // The newest miss goes last, so the oldest go first past `MISSED_KEPT`.
  missed.delete(id)
  if (found.identity !== null) return found.identity
  missed.set(id, { sightings, dirs: !journals ? (miss?.dirs ?? null) : found.read ? seen : null })
  for (const key of missed.keys()) if (missed.size > MISSED_KEPT) missed.delete(key)
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

/**
 * The node a Workflow call of a script stands for before its agent starts (a decision was made for the call, or it
 * was left as written): queued, one of the Workflow's calls, called what the agent's label is. Null when there is
 * none, or the agent is not a Workflow's.
 */
function callNodeOf(board: Board, identity: Identity | null | undefined): BoardNode | undefined {
  if (identity === null || identity === undefined || identity.kind !== 'wf') return undefined
  return board.nodes.find((node) => node.kind === 'wf' && node.state === 'queued' && node.workflow !== undefined && callWorkflowOf(node.id) === node.workflow.id && node.name === identity.name)
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

/** The board when a main turn starts at `now`: the count up by one, the nodes of older turns gone (the turn before it stays: it is folded into one line). */
export function startTurn(board: Board | undefined, now: number): Board {
  const turn = (board?.turn ?? 0) + 1
  const kept = (of: number) => of >= turn - 1
  return {
    turn,
    starts: [...(board?.starts ?? []).filter((start) => kept(start.turn)), { turn, at: now }],
    ...(board?.changes === undefined ? {} : { changes: board.changes.filter((change) => kept(change.turn)) }),
    ...(board?.notes === undefined ? {} : { notes: board.notes.filter((note) => kept(note.turn)) }),
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
    now: () => $.clock.now(),
    toast: (text) => $.ui.toast(text),
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

/** A decision as one line: `effort high · "the message"：why`. The debug log's line, and `/dp log N`'s after `#n feature：`. */
export function decisionLine(decision: { outcome: string; subject?: string; reason: string }): string {
  return `${decision.outcome}${decision.subject ? ` · ${decision.subject}` : ''}：${decision.reason}`
}

/** The list with `entry` added last, numbered, the entries of turns older than the latest `LOG_TURNS` dropped, and then the oldest past `LOG_ENTRIES`. */
export function appendEntry(list: readonly LogEntry[], entry: Omit<LogEntry, 'n'>): LogEntry[] {
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
    ...(decision.mid === undefined ? {} : { mid: decision.mid }),
    ...(decision.forced === undefined ? {} : { forced: decision.forced }),
    ...(decision.skills === undefined ? {} : { skills: decision.skills }),
    ...(decision.counts === undefined ? {} : { counts: decision.counts }),
    ...(decision.unresolved === undefined ? {} : { unresolved: decision.unresolved }),
    ...(decision.hint === undefined ? {} : { hint: decision.hint }),
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
  // The node that stood for the agent before it started gives it what was decided for it, and goes.
  const stood = old === undefined && decision.replaces !== undefined ? board.nodes.find((node) => node.id === decision.replaces) : undefined
  const inherited = stood?.decision === undefined ? {} : { decision: stood.decision }
  const base = old ?? { ...newNode(turn, decision.agent, decision.node, decision.forTurn === 'next' ? 'queued' : 'running'), ...inherited }
  const routed = decision.routed === undefined ? {} : { routed: decision.routed }
  let next: BoardNode
  if ('failure' in decision) {
    next = { ...base, ...routed, why: failureLine(decision.failure.backend, decision.failure), failure: decision.failure }
  } else if ('why' in decision) {
    next = { ...without(base, 'failure'), routed: false, why: decision.why }
  } else if ('started' in decision) {
    next = { ...without(base, 'why', 'failure'), routed: true, state: 'running' }
  } else {
    next = {
      ...(decision.routed === true ? without(base, 'why', 'failure') : base),
      ...routed,
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

// ---- what `report` does with the decision model's fallback ------------------------------

/** The decision model that decides is not the one asked for (ADR 0006): e.g. `asked` is pplx, `using` is Jev, since there is no Perplexity key and there is a TypeSafe one. */
export type DecisionModelEvent = { asked: BackendName; using: BackendName }

/** What a person reads of each decision model: its name, and the settings that hold its key (the options' names and the environment variable they type). The one place both are written. */
const DECISION_MODELS: Readonly<Record<BackendName, { name: string; keys: string }>> = {
  pplx: { name: 'pplx', keys: 'perplexityApiKey 或环境变量 PERPLEXITY_API_KEY' },
  jev: { name: 'Jev', keys: 'typesafeApiKey' },
}

/** The feature name of the entry the fallback leaves in the decision log. */
export const DECISION_MODEL_FEATURE = 'decision-model'

/**
 * The session's one entry in the decision log saying why Jev decides although pplx is the default: at the turn the session
 * start belongs to, with the debug line. A session start again at the same turn (a hot reload) takes the place of the entry
 * before. Not on the board's nodes, in no band or footer, and no toast. Never throws.
 */
async function reportFellBack(io: DecisionModelIo, fell: DecisionModelEvent): Promise<void> {
  try {
    const asked = DECISION_MODELS[fell.asked]
    const using = DECISION_MODELS[fell.using]
    // A board that cannot be read puts the session start at turn 1, where the first message will be.
    const turn = Math.max(1, (await read(io.board).catch(() => EMPTY)).turn)
    const entry: Omit<LogEntry, 'n'> = {
      turn,
      feature: DECISION_MODEL_FEATURE,
      tone: 'info',
      outcome: `改用 ${using.name}`,
      subject: '',
      reason: `没有 ${asked.name} 的密钥（${asked.keys}），改用 ${using.name}；补上密钥就用 ${asked.name}，decisionModel 设成 ${using.name} 则不再提示`,
    }
    io.debug(`decision model: ${decisionLine(entry)}`)
    await update(io.decisions, (list) => {
      const kept = list ?? []
      const at = kept.findIndex((old) => old.feature === DECISION_MODEL_FEATURE && old.turn === turn)
      return at < 0 ? appendEntry(kept, entry) : kept.map((old, i) => (i === at ? { n: old.n, ...entry } : old))
    })
  } catch (error) {
    try {
      io.debug(`decision model fallback not reported: ${errorText(error)}`)
    } catch {
      // nowhere left to say it
    }
  }
}

// ---- what `report` does with the skill profiles' events ----------------------------

/** Why writing the profiles stopped for the session (types/index.d.ts, `skillProfiles.stop`). */
export type ProfilesStopReason = 'store-read' | 'model-refused' | 'api-error' | 'store-write' | 'off' | 'error'

/** How writing the session's skill profiles went (#33; types/index.d.ts, `skillProfiles`). */
export type ProfilesState = {
  phase: 'writing' | 'done' | 'stopped'
  /** The turn the session start belongs to: the turn of its decision log entry. */
  turn: number
  model: string
  kept: number
  planned: number
  written: number
  failed: number
  deferred: number
  stop?: { reason: ProfilesStopReason; detail: string }
  failures: { name: string; reason: string }[]
}

/** The failed skills the state names; `failed` still counts every one. */
export const PROFILES_FAILURES_KEPT = 50

/** What the skill profiles' report needs of the host: the board (for the turn), the decision log, the debug log, and the state it keeps. */
export type ProfilesIo = Pick<ReportIo, 'board' | 'decisions' | 'debug'> & { profiles: Cell<ProfilesState> }

/** Why the writing stopped, with what the debug line and the state say of it. */
export type ProfilesStop =
  | { reason: 'model-refused'; model: string; detail: string }
  | { reason: 'api-error'; skill: string; why: string; ms: number }
  | { reason: 'store-write'; skill: string; detail: string }
  | { reason: 'off' }
  | { reason: 'error'; detail: string }

/**
 * What happens as the skill profiles are written (features/skill-profiles.ts), in the order it happens. `left`:
 * the skills lacking a profile that this session did not get to.
 */
export type ProfileEvent =
  /** The session start has read the catalog: `offered` skills can have one, `due` of them lack one; at most `perSession` are written. */
  | { event: 'start'; model: string; perSession: number; offered: number; due: number }
  /** The store cannot be read: nothing is kept or written. */
  | { event: 'unreadable'; model: string; offered: number }
  /** Another session wrote the profile meanwhile: it is kept. */
  | { event: 'found' }
  | { event: 'written'; skill: string; model: string; ms: number; input: number; output: number }
  /** The model gave no profile for the skill (`why`: the reply's reason); the writing goes on. */
  | { event: 'failed'; skill: string; why: string; ms: number }
  /** The reply for the skill is no profile; the writing goes on. */
  | { event: 'unfit'; skill: string; ms: number; text: string }
  /** The session's most is written; `left` is what no longer fits (the debug line counts what is not written, failed included). */
  | { event: 'quota'; perSession: number; left: number }
  /** The loop is over, as it should be. */
  | { event: 'finish'; left: number }
  | { event: 'stop'; cause: ProfilesStop; left: number }
  /** The store's oldest profiles were dropped (`total` kept before, `kb` of them). */
  | { event: 'tidied'; dropped: number; total: number; kb: number }
  | { event: 'tidy-failed'; detail: string }

/**
 * Reports one thing that happened while the skill profiles were being written: the debug log line (the words
 * the feature used to log itself), the state `skillProfiles`, kept up to date as the profiles are written, and,
 * when the writing ends (`finish`, `stop`, or a session start with nothing to write), the session's one entry in the
 * decision log: tone `ok`, `warn` when a skill failed, `fail` when the writing stopped (`info` when the person
 * switched it off meanwhile). Not on the board's nodes, in no band or footer, and no toast. Never throws.
 */
async function reportProfiles(io: ProfilesIo, event: ProfileEvent): Promise<void> {
  try {
    const line = profilesLine(event)
    if (line !== null) io.debug(line)
    if (event.event === 'tidied' || event.event === 'tidy-failed') return
    let after: ProfilesState | undefined
    if (event.event === 'start' || event.event === 'unreadable') {
      // A board that cannot be read puts the session start at turn 1, where the first message will be.
      const turn = Math.max(1, (await read(io.board).catch(() => EMPTY)).turn)
      const first = profilesBegin(event, turn)
      await modify(io.profiles, () => (after = first))
    } else {
      await modify(io.profiles, (current) => {
        after = current !== undefined && current.phase === 'writing' ? profilesAdvance(current, event) : undefined
        return after
      })
    }
    if (after !== undefined && after.phase !== 'writing') await update(io.decisions, (list) => profilesLogged(list ?? [], after as ProfilesState))
  } catch (error) {
    try {
      io.debug(`skill profiles not reported: ${errorText(error)}`)
    } catch {
      // nowhere left to say it
    }
  }
}

/** The debug log's line for an event; null when it has none. */
function profilesLine(event: ProfileEvent): string | null {
  switch (event.event) {
    case 'start':
      return `skill profiles: ${event.offered - event.due} kept, ${event.due} to write with ${event.model} (at most ${event.perSession} this session)`
    case 'unreadable':
      return 'skill profiles: the store cannot be read, so no profile is kept or written; skills are rated by their descriptions'
    case 'found':
      return null
    case 'written':
      return `skill profile written for ${event.skill} by ${event.model} in ${event.ms} ms (${event.input} input, ${event.output} output tokens)`
    case 'failed':
      return `skill profiles: no profile for ${event.skill} (${event.why}, ${event.ms} ms)`
    case 'unfit':
      return `skill profiles: the reply for ${event.skill} is not a profile (${event.ms} ms): ${JSON.stringify(event.text.slice(0, 80))}`
    case 'quota':
      return `skill profiles: ${event.left} left to write at a later session start (at most ${event.perSession} each)`
    case 'finish':
      return null
    case 'stop': {
      const cause = event.cause
      const more = 'no more profiles are written this session'
      if (cause.reason === 'model-refused') return `skill profiles: ${cause.model} was refused (${cause.detail}); ${more}`
      if (cause.reason === 'api-error') return `skill profiles: no profile for ${cause.skill} (${cause.why}, ${cause.ms} ms); ${more}`
      if (cause.reason === 'store-write') return `skill profiles: the store did not keep the profile of ${cause.skill} (${cause.detail}); ${more}`
      if (cause.reason === 'error') return `skill profiles: stopped writing (${cause.detail})`
      return null
    }
    case 'tidied':
      return `skill profiles: dropped the ${event.dropped} oldest of ${event.total} kept (${event.kb} KB)`
    case 'tidy-failed':
      return `skill profiles: could not tidy the store (${event.detail})`
  }
}

/** The state a session start begins with. Nothing to write (or no store to keep it): it is over at once. */
function profilesBegin(event: Extract<ProfileEvent, { event: 'start' | 'unreadable' }>, turn: number): ProfilesState {
  if (event.event === 'unreadable') {
    return { phase: 'stopped', turn, model: event.model, kept: 0, planned: 0, written: 0, failed: 0, deferred: event.offered, stop: { reason: 'store-read', detail: '' }, failures: [] }
  }
  const planned = event.due > 0 ? Math.max(0, Math.min(event.due, event.perSession)) : 0
  return { phase: planned > 0 ? 'writing' : 'done', turn, model: event.model, kept: event.offered - event.due, planned, written: 0, failed: 0, deferred: event.due - planned, failures: [] }
}

/**
 * What the model's reply for a skill said it failed with (the engine's reason, as the feature words it), in the
 * person's words: `empty-reply`, `an API error, HTTP 529 overloaded`. What the server said of itself stays as it
 * said it; anything this does not know is left as it is.
 */
export function profileWhy(why: string): string {
  if (why === 'empty-reply') return '模型回了空内容'
  if (why === 'aborted') return '请求被中断'
  const api = /^an API error, HTTP (\S+)(?: (.*))?$/.exec(why)
  if (api !== null) return `接口出错（状态码 ${api[1]}${api[2] === undefined || api[2] === '' ? '' : ` ${api[2]}`}）`
  return why
}

/** The state after an event that comes while the profiles are being written. */
function profilesAdvance(state: ProfilesState, event: ProfileEvent): ProfilesState {
  switch (event.event) {
    case 'found':
      return { ...state, kept: state.kept + 1 }
    case 'written':
      return { ...state, written: state.written + 1 }
    case 'failed':
    case 'unfit': {
      const reason = event.event === 'failed' ? profileWhy(event.why) : '回复不是画像'
      const failures = state.failures.length < PROFILES_FAILURES_KEPT ? [...state.failures, { name: event.skill, reason }] : state.failures
      return { ...state, failed: state.failed + 1, failures }
    }
    case 'finish':
      return { ...state, phase: 'done', deferred: event.left }
    case 'stop': {
      const cause = event.cause
      const detail = cause.reason === 'api-error' ? profileWhy(cause.why) : cause.reason === 'store-write' ? `${cause.skill}：${cause.detail}` : cause.reason === 'off' ? '' : cause.detail
      return { ...state, phase: 'stopped', deferred: event.left, stop: { reason: cause.reason, detail } }
    }
    default:
      return state
  }
}

/** The log with the session's profiles entry: a start again at the same turn (a hot reload) takes the place of the one before. */
function profilesLogged(list: readonly LogEntry[], state: ProfilesState): LogEntry[] {
  const entry = profilesEntry(state)
  const at = list.findIndex((kept) => kept.feature === 'skill-profiles' && kept.turn === state.turn)
  if (at < 0) return appendEntry(list, entry)
  return list.map((kept, i) => (i === at ? { n: kept.n, ...entry } : kept))
}

/** How many failed skills the entry's reason names. */
const PROFILES_NAMED = 3

function profilesEntry(state: ProfilesState): Omit<LogEntry, 'n'> {
  const stopped = state.phase === 'stopped'
  const counts = [`保留 ${state.kept}`, `新写 ${state.written}`, ...(state.failed > 0 ? [`失败 ${state.failed}`] : []), ...(state.deferred > 0 ? [`延后 ${state.deferred}`] : [])].join(' · ')
  const named = state.failures.slice(0, PROFILES_NAMED).map((failure) => `${failure.name}：${failure.reason}`)
  const failed = state.failed > 0 ? `（${named.join('；')}${state.failed > named.length ? `；另有 ${state.failed - named.length} 个` : ''}）` : ''
  const stop = state.stop
  const why =
    stop === undefined
      ? ''
      : stop.reason === 'store-read'
        ? '读不到本地存储，不保留也不写'
        : stop.reason === 'model-refused'
          ? `引擎拒绝了 ${state.model}（${stop.detail}）`
          : stop.reason === 'api-error'
            ? `${state.model} 返回了接口错误：${stop.detail}`
            : stop.reason === 'store-write'
              ? `本地存储存不下画像（${stop.detail}）`
              : stop.reason === 'off'
                ? '写的过程中被关掉了'
                : `出错了（${stop.detail}）`
  return {
    turn: state.turn,
    feature: 'skill-profiles',
    tone: stopped ? (stop?.reason === 'off' ? 'info' : 'fail') : state.failed > 0 ? 'warn' : 'ok',
    outcome: stopped ? '画像停写' : state.failed > 0 ? `画像：${state.failed} 个失败` : '画像就绪',
    subject: '',
    reason: `${stopped ? `${why}；` : ''}${counts}${failed}`,
  }
}
