// The shape of everything the mod keeps in $.state, and the empty values every task builds them from,
// so each value is made in one place. Types and pure constructors only: no $ calls.
// journal.ts, midrun.ts and board/model.ts import the four shared types from here and re-export them.
import type { PluginState } from 'claude-code'

import type { AskResult } from './backend.ts'
import type { Level } from './levels.ts'
import type { Decision } from './log.ts'
import type { PreviousTurn, ProgressNote, StepRecord } from './statebuild.ts'

/** What a turn's rows have shown so far (Task 7 reads them in). */
export type TurnJournal = {
  steps: StepRecord[]
  workSteps: number
  failedSteps: number
  scriptResults: number
  statedNext: string
  /** The step under way; failed: a call inside its script has errored, so the step fails whatever the result says. */
  open: { did: string; tools: string[]; failed: boolean } | null
  lastError: string | null
  editedSinceError: boolean
  sameErrorRepeated: boolean
  consecutiveFailures: number
}

export function emptyJournal(): TurnJournal {
  return {
    steps: [],
    workSteps: 0,
    failedSteps: 0,
    scriptResults: 0,
    statedNext: '',
    open: null,
    lastError: null,
    editedSinceError: false,
    sameErrorRepeated: false,
    consecutiveFailures: 0,
  }
}

/** Mid-run bookkeeping for one turn (Task 8). lastShiftAt: the work step of the last shift, null before any. */
export type MidrunCounters = { notes: number; lastShiftAt: number | null; stepsSinceCheck: number; scriptsSinceCheck: number }

export function emptyCounters(): MidrunCounters {
  return { notes: 0, lastShiftAt: null, stepsSinceCheck: 0, scriptsSinceCheck: 0 }
}

/** The board's timeline (Task 13): one cell per work step, marked with the judgement made before it. */
export type Mark = 'hold' | 'up' | 'down' | 'fail'
export type TrackCell = { level: Level; sent: Level | null; mark: Mark | null }

export type SessionState = {
  /** Set by /dp lock: every main-loop step is written at this level and no effort is judged. */
  lock: Level | null
  codeMode: boolean
  /** What $.session.surfaces() reported at the last session.start. */
  surfaces: string[]
  turnNo: number
  /** The effort the engine itself gave the last main-loop step, before the mod wrote any. */
  sessionLevel: Level | null
  previous: PreviousTurn | null
  /** The effort the last main-loop request actually carried (read at http.fetch). */
  lastSent: Level | null
  /** The decision made at prompt.submit, waiting for the turn's first step. */
  pending: { request: string; result: AskResult } | null
  /** The engine refused the progress-note model: no more calls this session. */
  progressBlocked: boolean
}

export type TurnState = {
  turnId: string
  request: string
  /** The level the turn starts from; wanted: the level the mod decided on. */
  base: Level | null
  wanted: Level | null
  journal: TurnJournal
  midrun: MidrunCounters
  pendingNote: string | null
  progress: ProgressNote | null
  /** The id of the Decision whose level is waiting to be checked against the next request. */
  unverified: string | null
  stepNo: number
  track: TrackCell[]
  pendingMark: Mark | null
}

/** One per dispatched agent, by agentId. */
export type AgentState = { effort: Level | null; isEffortExplicit: boolean | null; decisionId: string | null; steps: number }

export function emptySession(): SessionState {
  return {
    lock: null,
    codeMode: false,
    surfaces: [],
    turnNo: 0,
    sessionLevel: null,
    previous: null,
    lastSent: null,
    pending: null,
    progressBlocked: false,
  }
}

export function newTurn(turnId: string, request: string): TurnState {
  return {
    turnId,
    request,
    base: null,
    wanted: null,
    journal: emptyJournal(),
    midrun: emptyCounters(),
    pendingNote: null,
    progress: null,
    unverified: null,
    stepNo: 0,
    track: [],
    pendingMark: null,
  }
}

// types/index.d.ts must be self-contained, so it writes these shapes out again. Each line below fails
// tsc (and so scripts/check.sh) once the contract and the types here differ in any field.
type Contract = PluginState['dispatch-pilot']
// Identical, not only assignable both ways: an optional field missing on one side would pass that.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Holds<T extends true> = T
export type ContractMatches = [
  Holds<Same<Contract['session'], SessionState>>,
  Holds<Same<Contract['turn'], TurnState | null>>,
  Holds<Same<Contract['agents']['byId'], AgentState>>,
  Holds<Same<Contract['skills'], { name: string; description: string }[]>>,
  Holds<Same<Contract['recent'], Decision[]>>,
]
