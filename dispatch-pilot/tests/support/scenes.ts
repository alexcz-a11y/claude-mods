// The board's six fixed scenes (design 5.14): complete BoardState values, with the numbers of the approved prototype
// (docs/research/board-prototype/timeline-and-pane.html, the scenes in its SC: up, start, ord, miss, idle, lock). The
// board's tests and the eyeballing plugin read them. Imports nothing: Task 15's probe copies this file as it is, so
// the shapes it needs are written out here; tests/board-model.test.ts checks every scene is a BoardState.

type Level = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type Mark = 'hold' | 'up' | 'down' | 'fail'
type Reason = 'more-open' | 'less-open' | 'mechanical' | 'unknown-cause' | 'same-failure' | 'contradicts-plan' | 'cause-found' | 'carrying-out' | 'hold'
type Failure = 'no-key' | 'timeout' | 'http' | 'network' | 'bad-answer' | 'model-mismatch'
type Answer = { type: 'noul'; noul: number } | { type: 'score'; score: number; probabilities: number[] }
type Sent = Level | 'not-sent' | 'unverified' | null

const BARS = { up: 0.7, upHigh: 0.8, down: 0.7, yes: 0.7, no: 0.3, modelDown: 0.8 }
const DREX = 'drex-max-v1.1'
/** 2026-11-18 10:00 UTC: each scene's decisions are a few seconds apart from here. */
const T0 = 1794996000000

const rep = (level: Level, n: number): Level[] => Array.from({ length: n }, () => level)

/** A timeline: one cell per work step, each sent at its level; marks by cell index. */
function track(levels: Level[], marks: Record<number, Mark>): { level: Level; sent: Level | null; mark: Mark | null }[] {
  return levels.map((level, i) => ({ level, sent: level, mark: marks[i] ?? null }))
}

/** The same mark on cells from..to. */
function marked(from: number, to: number, mark: Mark): Record<number, Mark> {
  const out: Record<number, Mark> = {}
  for (let i = from; i <= to; i++) out[i] = mark
  return out
}

function journal(workSteps: number, o: { scripts: boolean; failed?: number }) {
  return {
    steps: [],
    workSteps,
    failedSteps: o.failed ?? 0,
    scriptResults: o.scripts ? workSteps : 0,
    statedNext: '',
    open: null,
    lastError: null,
    editedSinceError: false,
    sameErrorRepeated: false,
    consecutiveFailures: o.failed ?? 0,
  }
}

function session(o: { codeMode: boolean; turnNo: number; lastSent: Level | null; lock?: Level; previous?: Level }) {
  const previous = o.previous === undefined ? null : { request: 'Fix the flaky retry in the uploader', lastReply: '三处都改好了，测试全部通过。', ended: 'answered' as const, level: o.previous }
  return { lock: o.lock ?? null, codeMode: o.codeMode, surfaces: ['terminal', 'desktop'], turnNo: o.turnNo, sessionLevel: 'medium' as const, previous, lastSent: o.lastSent, pending: null, progressBlocked: false }
}

function turn(o: {
  turnId: string
  base: Level
  wanted: Level | null
  journal: ReturnType<typeof journal>
  midrun: { notes: number; lastShiftAt: number | null }
  track: ReturnType<typeof track>
  queued?: { id: string; level: Level; note: string }
}) {
  return {
    turnId: o.turnId,
    request: 'The upload test still fails after the retry fix: find out why',
    base: o.base,
    wanted: o.wanted,
    journal: o.journal,
    midrun: { ...o.midrun, stepsSinceCheck: 0, scriptsSinceCheck: 0 },
    pendingNote: o.queued?.note ?? null,
    queuedCheck: o.queued ?? null,
    progress: null,
    unverified: null,
    stepNo: o.journal.workSteps + 1,
    track: o.track,
    pendingMark: null,
  }
}

function score(probabilities: number[]): Answer {
  return { type: 'score', score: probabilities.reduce((s, p, i) => s + p * i, 0), probabilities }
}

const SUBMIT_IDS = ['mechanical', 'unknown_cause', 'continues']
const MIDRUN_IDS = ['same_failure', 'cause_found', 'only_carrying_out', 'contradicts_plan']
/** Answers of a mid-run check that hold: the mid band, no flag. */
const HOLDING = { probs: [0.05, 0.3, 0.3, 0.3, 0.05], nouls: [0.1, 0.2, 0.2, 0.1] }

/** A submit or mid-run Decision that the decision model answered; nouls in the order of the questions. */
function judged(o: {
  id: string
  kind: 'submit' | 'midrun'
  turnId: string
  step: number
  from: Level
  to: Level
  reason: Reason
  probs: number[]
  nouls: number[]
  ms?: number
  sent?: Sent
}) {
  const raw: Record<string, Answer> = { open: score(o.probs) }
  const ids = o.kind === 'submit' ? SUBMIT_IDS : MIDRUN_IDS
  o.nouls.forEach((p, i) => {
    raw[ids[i] ?? `q${i}`] = { type: 'noul', noul: p }
  })
  // A hold mid-run writes nothing, so nothing is checked; a submit decision and a shift are.
  const applied = o.kind === 'submit' || o.from !== o.to
  return {
    id: o.id,
    at: T0 + o.step * 30000,
    kind: o.kind,
    backend: 'drex' as const,
    model: DREX,
    ms: o.ms ?? 300,
    raw,
    from: o.from,
    to: o.to,
    reason: o.reason,
    detail: '',
    turnId: o.turnId,
    step: o.step,
    bars: BARS,
    failure: null,
    requestId: null,
    applied,
    sent: o.sent === undefined ? (applied ? o.to : null) : o.sent,
  }
}

/** Mid-run holds on steps from..to, at one level. */
function holds(turnId: string, from: number, to: number, level: Level) {
  const out: ReturnType<typeof judged>[] = []
  for (let step = from; step <= to; step++) {
    out.push(judged({ id: `${turnId}-m${step}`, kind: 'midrun', turnId, step, from: level, to: level, reason: 'hold', ...HOLDING }))
  }
  return out
}

/** A check whose request failed: nothing changed. */
function failed(o: { id: string; turnId: string; step: number; level: Level; failure: Failure; ms: number; detail: string }) {
  return {
    id: o.id,
    at: T0 + o.step * 30000,
    kind: 'midrun' as const,
    backend: 'drex' as const,
    model: null,
    ms: o.ms,
    raw: null,
    from: o.level,
    to: o.level,
    reason: null,
    detail: o.detail,
    turnId: o.turnId,
    step: o.step,
    bars: null,
    failure: o.failure,
    requestId: null,
    applied: false,
    sent: null,
  }
}

/** An agent dispatched at a step: its type, and the model and effort it was given (to), each checked (sent). */
function agent(o: { id: string; turnId: string; step: number; type: string; from: string; model: string; effort: Level; reason: Reason }) {
  return {
    id: o.id,
    at: T0 + o.step * 30000 + 5000,
    kind: 'agent' as const,
    backend: 'drex' as const,
    model: DREX,
    ms: 280,
    raw: { open: score([0.3, 0.4, 0.2, 0.1, 0]), mechanical: { type: 'noul' as const, noul: 0.8 }, unknown_cause: { type: 'noul' as const, noul: 0.1 }, read_only: { type: 'noul' as const, noul: 0.9 } },
    from: o.from,
    to: `${o.model} · ${o.effort}`,
    reason: o.reason,
    detail: o.type,
    turnId: o.turnId,
    step: o.step,
    bars: BARS,
    failure: null,
    requestId: null,
    applied: true,
    sent: o.effort,
  }
}

/** The skill suggested beside the turn's message. */
function skill(turnId: string, name: string) {
  return {
    id: `${turnId}-skill`,
    at: T0 - 1000,
    kind: 'skill' as const,
    backend: 'drex' as const,
    model: DREX,
    ms: 412,
    raw: { acts_on_user_system: { type: 'noul' as const, noul: 0.92 } },
    from: null,
    to: name,
    reason: null,
    detail: '',
    turnId,
    step: 0,
    bars: null,
    failure: null,
    requestId: null,
    applied: true,
    sent: null,
  }
}

/** The 62 skills of the session's listing. */
const SKILLS = [
  { name: 'superpowers:systematic-debugging', description: 'Use when encountering any bug, test failure, or unexpected behavior' },
  ...Array.from({ length: 61 }, (_, i) => ({ name: `skill-${i + 2}`, description: `Skill number ${i + 2} of the listing` })),
]

export const SCENES = {
  // Code Mode, step 10: the same failure came back after step 6, which went up to high; the checks since hold.
  up: {
    session: session({ codeMode: true, turnNo: 7, lastSent: 'high', previous: 'medium' }),
    turn: turn({
      turnId: 't7',
      base: 'medium',
      wanted: 'high',
      journal: journal(9, { scripts: true }),
      midrun: { notes: 1, lastShiftAt: 6 },
      track: track([...rep('medium', 6), ...rep('high', 4)], { ...marked(0, 5, 'hold'), 6: 'up', ...marked(7, 9, 'hold') }),
    }),
    recent: [
      judged({ id: 't7-s', kind: 'submit', turnId: 't7', step: 0, from: 'medium', to: 'medium', reason: 'hold', probs: [0.05, 0.3, 0.35, 0.25, 0.05], nouls: [0.1, 0.2, 0.1] }),
      ...holds('t7', 1, 2, 'medium'),
      agent({ id: 't7-a1', turnId: 't7', step: 2, type: 'Explore', from: 'opus · medium', model: 'haiku', effort: 'low', reason: 'mechanical' }),
      ...holds('t7', 3, 5, 'medium'),
      judged({ id: 't7-m6', kind: 'midrun', turnId: 't7', step: 6, from: 'medium', to: 'high', reason: 'same-failure', probs: [0.03, 0.12, 0.4, 0.35, 0.1], nouls: [0.91, 0.1, 0.05, 0.2] }),
      agent({ id: 't7-a2', turnId: 't7', step: 7, type: 'general-purpose', from: 'opus · high', model: 'sonnet', effort: 'medium', reason: 'less-open' }),
      ...holds('t7', 7, 8, 'high'),
      judged({ id: 't7-m9', kind: 'midrun', turnId: 't7', step: 9, from: 'high', to: 'high', reason: 'hold', probs: [0.03, 0.1, 0.46, 0.33, 0.08], nouls: [0.12, 0.22, 0.18, 0.09], ms: 312 }),
    ],
    skills: SKILLS,
  },
  // Code Mode, the message just sent: the open question took it up to high (the reason submitLevel gives these
  // numbers, and the one the prototype's rules describe); a skill came with it.
  start: {
    session: session({ codeMode: true, turnNo: 7, lastSent: 'high', previous: 'medium' }),
    turn: turn({ turnId: 't7', base: 'medium', wanted: 'high', journal: journal(0, { scripts: true }), midrun: { notes: 0, lastShiftAt: null }, track: track(['high'], { 0: 'up' }) }),
    recent: [
      skill('t7', 'superpowers:systematic-debugging'),
      judged({ id: 't7-s', kind: 'submit', turnId: 't7', step: 0, from: 'medium', to: 'high', reason: 'more-open', probs: [0.02, 0.08, 0.25, 0.55, 0.1], nouls: [0.04, 0.81, 0.06], ms: 412 }),
    ],
    skills: SKILLS,
  },
  // An ordinary session, step 14: the check at step 8 held, the one after two failed steps timed out.
  ordinary: {
    session: session({ codeMode: false, turnNo: 3, lastSent: 'high', previous: 'medium' }),
    turn: turn({
      turnId: 't3',
      base: 'medium',
      wanted: 'high',
      journal: journal(13, { scripts: false, failed: 2 }),
      midrun: { notes: 0, lastShiftAt: null },
      track: track(rep('high', 14), { 0: 'up', 8: 'hold', 13: 'fail' }),
    }),
    recent: [
      judged({ id: 't3-s', kind: 'submit', turnId: 't3', step: 0, from: 'medium', to: 'high', reason: 'more-open', probs: [0.02, 0.1, 0.5, 0.3, 0.08], nouls: [0.1, 0.25, 0.05] }),
      ...holds('t3', 8, 8, 'high'),
      failed({ id: 't3-m13', turnId: 't3', step: 13, level: 'high', failure: 'timeout', ms: 2000, detail: 'Drex 没有在时限内回答' }),
    ],
    skills: SKILLS,
  },
  // Code Mode, step 8: the result after step 7 came by delivery, so the shift to xhigh waits for the next result row.
  notsent: {
    session: session({ codeMode: true, turnNo: 5, lastSent: 'high', previous: 'medium' }),
    turn: turn({
      turnId: 't5',
      base: 'medium',
      wanted: 'xhigh',
      journal: journal(7, { scripts: true }),
      midrun: { notes: 2, lastShiftAt: 7 },
      track: track([...rep('medium', 3), ...rep('high', 5)], { ...marked(0, 2, 'hold'), 3: 'up', ...marked(4, 6, 'hold'), 7: 'up' }),
      queued: { id: 't5-m7', level: 'xhigh', note: '[dispatch-pilot] effort is now xhigh: a result contradicts the plan.' },
    }),
    recent: [
      judged({ id: 't5-s', kind: 'submit', turnId: 't5', step: 0, from: 'medium', to: 'medium', reason: 'hold', probs: [0.05, 0.3, 0.35, 0.25, 0.05], nouls: [0.1, 0.2, 0.1] }),
      ...holds('t5', 1, 2, 'medium'),
      judged({ id: 't5-m3', kind: 'midrun', turnId: 't5', step: 3, from: 'medium', to: 'high', reason: 'same-failure', probs: [0.03, 0.12, 0.4, 0.35, 0.1], nouls: [0.9, 0.1, 0.05, 0.2] }),
      ...holds('t5', 4, 6, 'high'),
      judged({ id: 't5-m7', kind: 'midrun', turnId: 't5', step: 7, from: 'high', to: 'xhigh', reason: 'contradicts-plan', probs: [0.01, 0.04, 0.15, 0.52, 0.28], nouls: [0.31, 0.08, 0.03, 0.88], ms: 287, sent: null }),
    ],
    skills: SKILLS,
  },
  // Between turns: the session's own level is medium; the last turn ended at high.
  idle: {
    session: session({ codeMode: true, turnNo: 4, lastSent: 'high', previous: 'high' }),
    turn: null,
    recent: [
      judged({ id: 't4-s', kind: 'submit', turnId: 't4', step: 0, from: 'medium', to: 'medium', reason: 'hold', probs: [0.05, 0.3, 0.35, 0.25, 0.05], nouls: [0.1, 0.2, 0.1] }),
      judged({ id: 't4-m6', kind: 'midrun', turnId: 't4', step: 6, from: 'medium', to: 'high', reason: 'same-failure', probs: [0.03, 0.12, 0.4, 0.35, 0.1], nouls: [0.9, 0.1, 0.05, 0.2] }),
      judged({ id: 't4-m13', kind: 'midrun', turnId: 't4', step: 13, from: 'high', to: 'high', reason: 'hold', probs: [0.05, 0.22, 0.48, 0.2, 0.05], nouls: [0.05, 0.74, 0.41, 0.04], ms: 301 }),
    ],
    skills: SKILLS,
  },
  // An ordinary session locked at high (/dp lock high) before the turn: nothing is judged, every step goes at high.
  locked: {
    session: session({ codeMode: false, turnNo: 2, lastSent: 'high', lock: 'high', previous: 'medium' }),
    turn: turn({ turnId: 't2', base: 'medium', wanted: null, journal: journal(4, { scripts: false }), midrun: { notes: 0, lastShiftAt: null }, track: track(rep('high', 5), {}) }),
    recent: [],
    skills: SKILLS,
  },
}
