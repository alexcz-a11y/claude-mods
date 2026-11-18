// The PluginState contract of dispatch-pilot. `claude plugin validate` requires this file to be
// self-contained (no import, no reference), so the shapes are written out here again. The TypeScript
// home of each is a module under hooks/ (state.ts, log.ts and the files they import from), and
// hooks/state.ts fails `tsc` the moment a shape here and its home drift apart: change both together.
// The names carry a Dp prefix so none can resolve to one of claude-code's own inside the augmentation.

export type DpLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type DpPreviousTurn = { request: string; lastReply: string; ended: 'answered' | 'error' | 'interrupted'; level: DpLevel | null }
export type DpStepRecord = { did: string; tools: string[]; ok: boolean; result: string }
export type DpProgressNote = { done: string; remaining: string; cause_known: boolean }

export type DpAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; probabilities: number[] }
  | { type: 'choice'; choice: string; probabilities: Record<string, number> }
export type DpFailure = 'no-key' | 'timeout' | 'http' | 'network' | 'bad-answer' | 'model-mismatch'
export type DpBackend = 'drex' | 'jev'
export type DpMiss = { reason: DpFailure; backend: DpBackend; status?: number; requestId?: string }
export type DpAskResult =
  | { ok: true; answers: Record<string, DpAnswer>; model: string; backend: DpBackend; ms: number; firstFailure?: DpMiss }
  | ({ ok: false; ms: number; firstFailure?: DpMiss } & DpMiss)

export type DpReason =
  | 'more-open'
  | 'less-open'
  | 'mechanical'
  | 'unknown-cause'
  | 'same-failure'
  | 'contradicts-plan'
  | 'cause-found'
  | 'carrying-out'
  | 'hold'
export type DpThresholds = { up: number; upHigh: number; down: number; yes: number; no: number; modelDown: number }

export type DpTurnJournal = {
  steps: DpStepRecord[]
  workSteps: number
  failedSteps: number
  scriptResults: number
  statedNext: string
  /** failed: a call inside the open script has errored. */
  open: { did: string; tools: string[]; failed: boolean } | null
  lastError: string | null
  editedSinceError: boolean
  sameErrorRepeated: boolean
  consecutiveFailures: number
}
export type DpMidrunCounters = { notes: number; lastShiftAt: number | null; stepsSinceCheck: number; scriptsSinceCheck: number }
export type DpMark = 'hold' | 'up' | 'down' | 'fail'
export type DpTrackCell = { level: DpLevel; sent: DpLevel | null; mark: DpMark | null }

export type DpSessionState = {
  lock: DpLevel | null
  codeMode: boolean
  surfaces: string[]
  turnNo: number
  sessionLevel: DpLevel | null
  previous: DpPreviousTurn | null
  lastSent: DpLevel | null
  pending: { request: string; result: DpAskResult } | null
  progressBlocked: boolean
}

export type DpTurnState = {
  turnId: string
  request: string
  base: DpLevel | null
  wanted: DpLevel | null
  journal: DpTurnJournal
  midrun: DpMidrunCounters
  pendingNote: string | null
  progress: DpProgressNote | null
  unverified: string | null
  stepNo: number
  track: DpTrackCell[]
  pendingMark: DpMark | null
}

export type DpAgentState = { effort: DpLevel | null; isEffortExplicit: boolean | null; decisionId: string | null; steps: number }

export type DpDecision = {
  id: string
  at: number
  kind: 'submit' | 'midrun' | 'agent' | 'skill' | 'progress'
  backend: DpBackend | null
  model: string | null
  ms: number
  raw: Record<string, DpAnswer> | null
  from: string | null
  to: string | null
  reason: DpReason | null
  detail: string
  turnId: string | null
  step: number | null
  bars: DpThresholds | null
  failure: DpFailure | null
  requestId: string | null
  applied: boolean
  sent: DpLevel | 'not-sent' | 'unverified' | null
}

declare module 'claude-code' {
  interface PluginState {
    'dispatch-pilot': {
      session: DpSessionState
      turn: DpTurnState | null
      /** By agentId. */
      agents: StateFamily<DpAgentState>
      /** The skills in the last skill listing. */
      skills: { name: string; description: string }[]
      /** This session's last 30 decisions; the board reads them. $.store's log is the machine's. */
      recent: DpDecision[]
    }
  }
}
