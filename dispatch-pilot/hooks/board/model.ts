// The board's data (design 5.14): one pure function from the mod's state to everything the timeline and the pane show,
// and the timeline's cells. No $ calls. The drawings only draw what boardModel returns; flows/submit.ts opens the cells,
// runtime.ts's record leaves the mark for the next one, and flows/readout.ts writes the level a cell's request carried.
import { agentTypeOf } from '../agents.ts'
import { canAsk, noulOf } from '../backend.ts'
import type { Failure } from '../backend.ts'
import { MAX_NOTES } from '../config.ts'
import type { Config } from '../config.ts'
import { START, margins, midrunLevel, readNoul, submitLevel } from '../decide.ts'
import type { Reason, Thresholds, TraceStep } from '../decide.ts'
import { LEVELS, isLevel } from '../levels.ts'
import type { Level } from '../levels.ts'
import { UNCALIBRATED, answeredBy, backendName } from '../log.ts'
import type { Decision } from '../log.ts'
import { gapLeft, notesLeft } from '../midrun.ts'
import { stepLevel } from '../submit.ts'
import type { Skill } from '../skills.ts'
import type { Mark, SessionState, TrackCell, TurnState } from '../state.ts'

export type { Mark, TrackCell } from '../state.ts'

/** The cells a turn keeps: the drawings fold several steps into a column once there are more than they have room for. */
export const TRACK_KEEP = 300
/** The shifts a turn keeps: one per note at most, and the message's own (a shift on new input takes no note, so the oldest may go). */
export const SHIFTS_KEEP = MAX_NOTES + 1

export type BoardState = { session: SessionState; turn: TurnState | null; recent: readonly Decision[]; skills: readonly Skill[] }

/**
 * What the readout found of a level or a model the mod set (design 5.12): sent, read and equal; not-sent, read and
 * different; unverified, not read (the reading was unsure, the readout is off, or none has come).
 */
export type Readout = 'sent' | 'not-sent' | 'unverified'

/** A Decision's sent as a reading; `level` the one it should equal (null: any level read counts, an agent's). */
export function readoutOf(sent: Decision['sent'], level: string | null): Readout {
  if (sent === 'not-sent') return 'not-sent'
  if (isLevel(sent)) return level === null || sent === level ? 'sent' : 'not-sent'
  return 'unverified'
}

/** One line of the pane's small tables: what the decision model gave (p) against the bar, and what came of it. */
export type TableRow = { label: string; p: number; bar: number; mark: string; tone: 'ok' | 'dim' | 'accent' | 'warn' | 'medium' }
export type Basis = { at: string; dir: 'up' | 'down'; from: Level; to: Level; reading: Readout | 'queued'; rows: TableRow[]; notes: string[]; since: string | null }
export type Forecast = { rows: TableRow[]; notes: string[] }

export type BoardModel = {
  isIdle: boolean
  where: string
  /**
   * What the mod believes the session is (session.codeMode): shown on the timeline's first row and in the pane. Known from
   * the first main-loop request's tools (REPL or not) or a receipt; before either, 尚未判断.
   */
  sessionKind: 'Code Mode 会话' | '普通会话' | '尚未判断'
  level: Level | null
  wanted: Level | null
  sent: Level | null
  status: { kind: 'sent' | 'mismatch' | 'unverified' | 'locked' | 'idle' | 'starting' | 'none'; text: string }
  track: readonly TrackCell[]
  /** queued: the shift's note waits for a row that can carry it, so no request could carry the level yet. */
  shifts: { at: string; from: Level; to: Level; why: string; reading: Readout | 'queued' }[]
  /** note: a line that stands for the rules when there are none to show (a failure; a "go on" message's level). */
  last: { at: string; mark: Mark; text: string; probs: number[] | null; nouls: { label: string; value: number; reading: 'yes' | 'no' | 'unsure' }[]; note: string | null; by: string } | null
  /** This turn's last shift and how its level came out, kept until the next shift (the pane's 换挡依据 box). */
  basis: Basis | null
  /** What each way would take from the level now, by the turn's last evaluation (the pane's 下次怎样会换档 box). */
  forecast: Forecast | null
  next: { main: string; sub: string; ahead: number }
  features: { label: string; state: 'active' | 'inactive' | 'off' | 'locked'; note: string }[]
  backend: { isOk: boolean; text: string }
  /** reading: null for an agent the mod set neither a model nor an effort for (nothing to read back). */
  agents: { type: string; text: string; reading: Readout | null }[]
  skill: string | null
}

export const REASON_ZH: Record<Reason, string> = {
  'more-open': '问题比原先估计的更开放',
  'less-open': '问题比当前档位估计的简单',
  mechanical: '照已知做法重复的机械改动',
  'unknown-cause': '要先查明一个原因未知的问题',
  'same-failure': '同一失败在修改后又出现',
  'contradicts-plan': '最新结果和原计划矛盾',
  'cause-found': '原因已查明，剩下的是常规工作',
  'carrying-out': '剩下的只是把已定的做法做完',
  continues: '消息只是让接着做，沿用上一轮的档位',
  hold: '不变',
}

/** By question id; a question not here is shown by its id. */
export const NOUL_ZH: Record<string, string> = {
  mechanical: '机械重复',
  unknown_cause: '原因未知',
  continues: '只是续做',
  same_failure: '同一失败又出现',
  cause_found: '原因已查明',
  only_carrying_out: '只剩照做',
  contradicts_plan: '与计划矛盾',
  read_only: '只读',
}

export const FAILURE_ZH: Record<Failure, string> = {
  'no-key': '没有密钥',
  timeout: '超时',
  http: '请求失败',
  network: '连不上',
  'bad-answer': '回答读不懂',
  'model-mismatch': '应答的模型不对',
}

const rank = (l: Level): number => LEVELS.indexOf(l)

/**
 * What one evaluation did to the level, as the timeline marks it (controller ruling): a Decision not applied (shadow, or
 * a shift refused at the write) changed nothing, whatever its to says. A level not one of the five reads as no change.
 */
export function markOf(d: Decision): Mark {
  if (d.failure !== null) return 'fail'
  if (!d.applied || !isLevel(d.from) || !isLevel(d.to) || d.from === d.to) return 'hold'
  return rank(d.to) > rank(d.from) ? 'up' : 'down'
}

/**
 * The turn once a main-loop step goes out at `level` (design 5.14), when the step starts a work step not counted yet:
 * stepNo moves on, and a step with a level gets a new cell, marked with the evaluation made before it (a step with none,
 * on a model that takes no effort, gets no cell and its mark is dropped). Unchanged for a later step of the work step
 * under way.
 */
export function takeStep(turn: TurnState, level: Level | null): TurnState {
  const done = turn.journal.workSteps
  if (turn.stepNo > done) return turn
  const track = level === null ? turn.track : [...turn.track, { level, sent: null, mark: turn.pendingMark }].slice(-TRACK_KEEP)
  return { ...turn, track, pendingMark: null, stepNo: done + 1 }
}

/**
 * The turn once one of its own submit or mid-run Decisions is recorded (design 5.14): the mark it leaves for the next
 * cell, the last evaluation, and the shift when it made one. Kept on the turn, so the board never depends on recent,
 * which keeps the last RECENT_KEEP Decisions of every kind.
 */
export function keepJudged(turn: TurnState, d: Decision): TurnState {
  const mark = markOf(d)
  const shifts = mark === 'up' || mark === 'down' ? [...turn.shifts, d].slice(-SHIFTS_KEEP) : turn.shifts
  // Two evaluations before the same cell: it shows the weightier (design 5.14), a later one of the same weight.
  const held = turn.pendingMark
  const pendingMark = held !== null && MARK_WEIGHT[held] > MARK_WEIGHT[mark] ? held : mark
  return { ...turn, pendingMark, lastJudged: d, shifts }
}

/** A cell's mark by how much it matters: a failure, then a shift (either way), then no change. */
const MARK_WEIGHT: Record<Mark, number> = { fail: 2, up: 1, down: 1, hold: 0 }

/**
 * The level read for now: inside a turn the one the current step's own request carried (its cell's; none read yet:
 * null, 未核对), never an older step's; between turns the last one read, the level the last turn ended at. /dp's too.
 */
export function currentSent(session: SessionState, turn: TurnState | null): Level | null {
  return turn === null ? session.lastSent : (turn.track.at(-1)?.sent ?? null)
}

/** The turn with the level a main-loop request carried written into the last cell, while that cell has none. */
export function cellSent(turn: TurnState, level: Level): TurnState {
  const last = turn.track.at(-1)
  if (last === undefined || last.sent !== null) return turn
  return { ...turn, track: [...turn.track.slice(0, -1), { ...last, sent: level }] }
}

const LABELS = ['发消息定档', '中途换挡', 'agent 定档', 'skill 推荐', '档位核对', '进展记录'] as const

/** Why a turn's steps have no level: a session on numeric effort, or a model that takes none. */
const noLevel = (numeric: boolean): string => (numeric ? '数字 effort，不判断' : '这个模型不收 effort')

const atStep = (step: number | null): string => (step === null || step === 0 ? '发消息时' : `第 ${step} 步后`)
const isJudged = (d: Decision): boolean => d.kind === 'submit' || d.kind === 'midrun'
const two = (n: number): string => n.toFixed(2)

// starting: the turn's first step has not come (its level is not known yet, which is not a model without effort). Its
// message was judged inside prompt.submit, before turn.start, so nothing is being judged meanwhile.
function statusOf(s: { locked: boolean; idle: boolean; starting: boolean; numeric: boolean }, wanted: Level | null, sent: Level | null): BoardModel['status'] {
  if (s.locked) return { kind: 'locked', text: '已锁定' }
  if (s.idle) return { kind: 'idle', text: '空闲' }
  if (s.starting) return { kind: 'starting', text: '这一轮刚开始' }
  if (wanted === null) return { kind: 'none', text: noLevel(s.numeric) }
  if (sent === null) return { kind: 'unverified', text: '未核对' }
  if (sent !== wanted) return { kind: 'mismatch', text: `要 ${wanted}，实际发出 ${sent}` }
  return { kind: 'sent', text: '已发出' }
}

function shiftsOf(turn: TurnState): BoardModel['shifts'] {
  const out: BoardModel['shifts'] = []
  // The shift whose note is still queued (not on a row yet): until it is placed no request can carry its level.
  const q = turn.queuedCheck
  const queued = q !== null && turn.pendingNote === q.note ? q.id : null
  for (const d of turn.shifts) {
    const mark = isJudged(d) ? markOf(d) : 'hold'
    // Only a level that changed is a shift: a Decision not applied is never one (markOf reads it as hold).
    if ((mark !== 'up' && mark !== 'down') || !isLevel(d.from) || !isLevel(d.to)) continue
    const reading = d.id === queued ? 'queued' : readoutOf(d.sent, d.to)
    out.push({ at: atStep(d.step), from: d.from, to: d.to, why: d.reason === null ? '' : (REASON_ZH[d.reason] ?? d.reason), reading })
  }
  return out
}

// The open question's distribution over the five levels; none for a failed evaluation or one without the answer.
function probsOf(d: Decision): number[] | null {
  const open = d.failure === null ? d.raw?.open : undefined
  return open?.type === 'score' && Array.isArray(open.probabilities) ? [...open.probabilities] : null
}

function lastOf(cfg: Config, d: Decision, prefix: string): NonNullable<BoardModel['last']> {
  const mark = markOf(d)
  const name = answeredBy(d.backend ?? cfg.backend)
  const at = prefix + atStep(d.step)
  if (d.failure !== null) {
    const why = FAILURE_ZH[d.failure] ?? d.failure
    return { at, mark, text: '评估失败，档位不变', probs: null, nouls: [], note: `评估失败：${why}，按规则放行`, by: `${name} ${why}` }
  }
  const bars = d.bars ?? START
  const probs = probsOf(d)
  // In the order the questions were asked: the answers are kept in that order.
  const nouls: NonNullable<BoardModel['last']>['nouls'] = []
  for (const [id, a] of Object.entries(d.raw ?? {})) {
    if (a?.type === 'noul') nouls.push({ label: NOUL_ZH[id] ?? id, value: a.noul, reading: readNoul(a.noul, bars) })
  }
  const note = d.reason === 'continues' ? `${mark === 'up' ? '升到这一档' : mark === 'down' ? '降到这一档' : '档位不变'}：${REASON_ZH.continues}` : null
  return { at, mark, text: changeText(d, mark), probs, nouls, note, by: `${name} · ${d.ms} ms` }
}

// The pane's two boxes (design 5.14, after the person's asks on 2026-11-19): why the turn's last shift came out at its
// level, and what the next evaluation would need either way. The rules run again on what the Decision kept (its
// answers and bars) with a trace (decide.ts TraceStep), so the table is the path the level took, written as the
// decision model's own estimates: 「该用 medium 或更低」 is the probability it gave the levels from medium down.

/** The yes/no questions as the tables name them. */
const FLAG_PLAIN: Record<string, string> = {
  same_failure: '同一失败又出现',
  contradicts_plan: '结果和计划矛盾',
  cause_found: '原因已查明',
  only_carrying_out: '剩下只是照做',
  mechanical: '照已知做法重复',
  unknown_cause: '原因未知',
}
const FLAG_DOES: Record<Extract<TraceStep, { k: 'flag' }>['effect'], string> = {
  'up-one': '直接升一档',
  'allow-down': '允许降',
  'at-most-medium': '最高 medium',
  'at-least-high': '最低 high',
}

/** 「该用 medium 或更低」, 「该用 xhigh 或更高」; the end levels need no 或更…. */
function rungLabel(level: Level, dir: 'up' | 'down'): string {
  if (dir === 'down') return level === 'low' ? '该用 low' : `该用 ${level} 或更低`
  return level === 'max' ? '该用 max' : `该用 ${level} 或更高`
}

const near = (l: Level, by: number): Level | null => LEVELS[rank(l) + by] ?? null

function traceOf(d: Decision, probs: number[], from: Level, bars: Thresholds): { level: Level; trace: TraceStep[] } | null {
  const a = d.raw ?? {}
  const trace: TraceStep[] = []
  if (d.kind === 'midrun') {
    const v = midrunLevel(from, { open: probs, sameFailure: noulOf(a.same_failure), causeFound: noulOf(a.cause_found), onlyCarryingOut: noulOf(a.only_carrying_out), contradictsPlan: noulOf(a.contradicts_plan) }, bars, trace)
    return { level: v.level, trace }
  }
  if (d.kind === 'submit') {
    const v = submitLevel(from, { open: probs, mechanical: noulOf(a.mechanical), unknownCause: noulOf(a.unknown_cause) }, bars, trace)
    return { level: v.level, trace }
  }
  return null
}

/** The table of one shift: the checks the way it moved, and every answer read as yes; the rest is said in notes. */
function basisRows(d: Decision, dir: 'up' | 'down', trace: readonly TraceStep[], bars: Thresholds): { rows: TableRow[]; notes: string[] } {
  const rows: TableRow[] = []
  const notes: string[] = []
  const hopped = trace.some((s) => s.k === 'hop' && s.dir === dir)
  for (const s of trace) {
    if (s.k === 'hop' && s.dir === dir) rows.push({ label: rungLabel(s.to, dir), p: s.sum, bar: s.bar, mark: s.to === d.to ? '✓ 到这里' : '✓', tone: 'ok' })
    else if (s.k === 'stop' && s.dir === dir) {
      const past = near(s.at, dir === 'up' ? 1 : -1)
      if (past !== null) rows.push({ label: rungLabel(past, dir), p: s.sum, bar: s.bar, mark: hopped ? '✗ 停' : dir === 'up' ? '✗ 不够升' : '✗ 不够降', tone: 'dim' })
    } else if (s.k === 'flag') rows.push({ label: FLAG_PLAIN[s.id] ?? s.id, p: s.value, bar: bars.yes, mark: `✓ ${FLAG_DOES[s.effect]}`, tone: 'accent' })
    else if (s.k === 'cap') notes.push(`${s.at} 是${d.kind === 'midrun' ? '一轮中途' : '这次'}能到的最高档`)
  }
  return { rows, notes }
}

function basisOf(turn: TurnState, recent: readonly Decision[], shifts: BoardModel['shifts']): Basis | null {
  const d = [...turn.shifts].reverse().find((x) => isJudged(x) && (markOf(x) === 'up' || markOf(x) === 'down'))
  const shown = shifts.at(-1)
  if (d === undefined || shown === undefined || !isLevel(d.from) || !isLevel(d.to)) return null
  const dir = markOf(d) === 'up' ? 'up' : 'down'
  const later = recent.filter((x) => x.turnId === turn.turnId && (x.kind === 'midrun' || x.kind === 'submit') && x.at > d.at).length
  const since = later === 0 ? null : `之后又评估了 ${later} 次，都没换档`
  const base = { at: shown.at, dir, from: d.from, to: d.to, reading: shown.reading, since } as const
  const why = d.reason === null ? '' : (REASON_ZH[d.reason] ?? d.reason)
  const probs = probsOf(d)
  const bars = d.bars ?? START
  const run = d.reason === 'continues' || probs === null ? null : traceOf(d, probs, d.from, bars)
  // A "go on" message, a record with no answers, or one its answers no longer give again: the reason alone.
  if (run === null || run.level !== d.to) return { ...base, rows: [], notes: why === '' ? [] : [why] }
  return { ...base, ...basisRows(d, dir, run.trace, bars) }
}

/** From the level now, by the last evaluation's estimates: what a mid-run check would need to move either way. */
function forecastOf(cfg: Config, from: Level | null, judged: Decision | null): Forecast | null {
  const probs = judged === null ? null : probsOf(judged)
  if (from === null || probs === null) return null
  const bars = cfg.bars.midrun
  const m = margins(from, probs, bars, 'xhigh')
  const rows: TableRow[] = []
  const notes: string[] = []
  const up = near(from, 1)
  if (m.up !== null && up !== null) rows.push({ label: rungLabel(up, 'up'), p: m.up.sum, bar: m.up.bar, mark: `→ 升到 ${up}`, tone: 'warn' })
  const down = near(from, -1)
  if (m.down !== null && down !== null) rows.push({ label: rungLabel(down, 'down'), p: m.down.sum, bar: m.down.bar, mark: `→ 降到 ${down}`, tone: 'medium' })
  if (m.down !== null) notes.push('降还要：原因已查明，或剩下只是照做')
  if (m.up !== null) notes.push('直接升一档：同一失败又出现，或结果和计划矛盾')
  else notes.push(`一轮中途最高到 xhigh，${from === 'max' ? '不会再升' : '不会升到 max'}`)
  return { rows, notes }
}

// What the evaluation did to the level; one that wanted another level but was not applied says so.
function changeText(d: Decision, mark: Mark): string {
  if (mark === 'up') return `升到 ${d.to}`
  if (mark === 'down') return `降到 ${d.to}`
  if (!d.applied && isLevel(d.from) && isLevel(d.to) && d.from !== d.to) return `${rank(d.to) > rank(d.from) ? '想升到' : '想降到'} ${d.to}，未执行`
  return '不变'
}

function nextOf(cfg: Config, s: { session: SessionState; turn: TurnState | null; locked: boolean; ask: boolean; wanted: Level | null; starting: boolean }): BoardModel['next'] {
  const { session, turn } = s
  if (!cfg.enabled) return { main: '不评估', sub: 'dispatch-pilot 已关闭', ahead: 0 }
  if (s.locked) return { main: '不评估', sub: '/dp unlock 解锁后恢复', ahead: 0 }
  // Between turns: what the next message will really meet.
  if (turn === null) {
    if (!s.ask) return { main: '不评估', sub: '没有可用的后端', ahead: 0 }
    if (cfg.submitShift) {
      const level = session.previous?.level ?? null
      // A message that only says to go on keeps the previous turn's level (Ruling C38): the level question does not move it.
      return { main: '发出下一条消息时', sub: level === null ? '' : `说「继续」这类话会沿用上一轮的 ${level}`, ahead: 0 }
    }
    if (cfg.midrunShift) return { main: '下一轮中途', sub: '发消息定档关着', ahead: 0 }
    return { main: '不评估', sub: '发消息定档和中途换挡都关着', ahead: 0 }
  }
  // No level to judge: the mid-run check asks nothing. Not before the first step, whose level is not known yet.
  if (s.wanted === null && !s.starting) return { main: '不评估', sub: noLevel(session.effortIsNumber), ahead: 0 }
  if (!cfg.midrunShift || !s.ask) return { main: '本轮不再评估', sub: cfg.midrunShift ? '没有可用的后端' : '中途换挡关着', ahead: 0 }
  const left = notesLeft(turn.midrun, cfg)
  if (left === 0) return { main: '本轮不再换挡', sub: '说明条数已用完；有新输入时仍会评估', ahead: 0 }
  // Within the gap since the last shift no result row is asked (midrun.ts isCheckpoint): the count waits for it.
  const gap = gapLeft(turn.midrun, turn.journal, cfg)
  if (session.codeMode) {
    const every = cfg.midrunEveryScripts
    if (every === 0) return { main: '只在有新输入时', sub: '按脚本结果的评估关着', ahead: 0 }
    const byCount = Math.max(1, every - turn.midrun.scriptsSinceCheck)
    const n = Math.max(byCount, gap)
    const why = n > byCount ? `换挡后隔 ${cfg.midrunShiftGap} 份脚本结果才再评估` : `每 ${every} 份脚本结果评估一次`
    return { main: n === 1 ? '下一份脚本结果到达时' : `再 ${n} 份脚本结果`, sub: `${why} · 本轮还可换挡 ${left} 次`, ahead: n }
  }
  const every = cfg.midrunEverySteps
  if (every === 0) return { main: gap > 0 ? `再 ${gap} 步之后，失败成簇时` : '失败成簇时', sub: '按步数的评估关着', ahead: 0 }
  const byCount = Math.max(1, every - turn.midrun.stepsSinceCheck)
  const n = Math.max(byCount, gap)
  if (n > byCount) return { main: `再 ${n} 步`, sub: `换挡后隔 ${cfg.midrunShiftGap} 步才再评估 · 有新输入时照常评估`, ahead: n }
  return { main: `再 ${n} 步`, sub: `每 ${every} 步评估一次 · 同一失败复现或连续两步失败会提前`, ahead: n }
}

/** What shadow mode does: judge and record, change nothing (design 5.10). */
const SHADOW_NOTE = '只记录，不改'

// This turn's skill: its name, and in shadow (recorded, not suggested) the words that say so.
function skillOf(thisTurn: readonly Decision[]): string | null {
  const d = thisTurn.findLast((x) => x.kind === 'skill' && x.to !== null)
  if (d === undefined || d.to === null) return null
  return d.applied ? d.to : `${d.to}（${SHADOW_NOTE}）`
}

function featuresOf(cfg: Config, s: BoardState & { locked: boolean; ask: boolean; agents: number }): BoardModel['features'] {
  const noBackend = s.ask ? null : '没有可用的后端'
  const judging = noBackend ?? (cfg.mode === 'shadow' ? SHADOW_NOTE : null)
  const every = s.session.codeMode
    ? cfg.midrunEveryScripts === 0
      ? '按脚本结果的评估关着'
      : `每 ${cfg.midrunEveryScripts} 份脚本结果`
    : cfg.midrunEverySteps === 0
      ? '按步数的评估关着'
      : `每 ${cfg.midrunEverySteps} 步`
  const unread = s.turn !== null && s.turn.track.length > 0 && s.session.lastSent === null ? '读不到请求' : null
  // [switch, held by a lock, why on but not taking effect (null: it is), the note while it is]
  const rows: [boolean, boolean, string | null, string][] = [
    [cfg.submitShift, true, judging, ''],
    [cfg.midrunShift, true, judging, every],
    [cfg.agentShift, true, judging, s.agents > 0 ? `本轮 ${s.agents} 个` : ''],
    [cfg.skills, false, noBackend ?? (s.skills.length === 0 ? '还没拿到 skill 列表' : cfg.mode === 'shadow' ? SHADOW_NOTE : null), `${s.skills.length} 个候选`],
    [cfg.verifyEffort, false, unread, ''],
    // A note is written only after a mid-run checkpoint, so it needs what the mid-run row needs, and lock holds it too.
    [cfg.progressNote, true, !cfg.midrunShift ? '中途换挡关着' : (noBackend ?? (s.session.progressBlocked ? '模型被拒绝' : null)), ''],
  ]
  return rows.map(([on, lockable, inactive, note], i) => {
    const label = LABELS[i] ?? ''
    if (!cfg.enabled || !on) return { label, state: 'off', note: '' }
    if (lockable && s.locked) return { label, state: 'locked', note: '' }
    if (inactive !== null) return { label, state: 'inactive', note: inactive }
    return { label, state: 'active', note }
  })
}

function backendOf(cfg: Config, recent: readonly Decision[]): BoardModel['backend'] {
  if (!canAsk(cfg)) {
    // Only the other backend has a key: the setting to change, as /dp's text says it.
    const other = cfg.backend === 'drex' ? 'jev' : 'drex'
    const key = other === 'jev' ? cfg.jevApiKey : cfg.drexApiKey
    return { isOk: false, text: key ? `${backendName(cfg.backend)} 没有密钥 · 要用 ${backendName(other)} 就把「决策模型的后端」改成 ${other}` : '没有密钥' }
  }
  // Jev's mark follows its model's name, before what is said of it.
  const label = cfg.backend === 'drex' ? `${backendName('drex')} ${cfg.drexModel} ·` : `${backendName('jev')} ${cfg.jevModel}${UNCALIBRATED}·`
  // The last decision that asked a decision model: a progress note's failure is another model's.
  const asked = recent.findLast((d) => d.backend !== null)
  if (asked !== undefined && asked.failure !== null) return { isOk: false, text: `${label} 最近一次${FAILURE_ZH[asked.failure] ?? asked.failure}` }
  return { isOk: true, text: `${label} 可用` }
}

/** Everything the board shows, from the state alone (design 5.14). Total: any state the mod can hold gives a model. */
export function boardModel(cfg: Config, s: BoardState): BoardModel {
  const { session, turn, recent } = s
  const isIdle = turn === null
  const locked = session.lock !== null
  const ask = canAsk(cfg)
  // The level the steps go at, built on what the mod writes (stepLevel on ownLevel), so the two cannot disagree.
  const wanted = stepLevel(cfg, session, turn)
  const sent = currentSent(session, turn)
  const thisTurn = turn === null ? [] : recent.filter((d) => d.turnId === turn.turnId)
  const agents = thisTurn.filter((d) => d.kind === 'agent')
  // Inside a turn its own last evaluation (none yet: null), kept on the turn; between turns the one the last turns
  // left on the session, which may be older than the last turn (one with no evaluation), hence 此前.
  const judged = turn === null ? session.lastJudged : turn.lastJudged
  // The turn's first step has not come: its level is not known yet.
  const starting = turn !== null && turn.stepNo === 0
  const shifts = turn === null ? [] : shiftsOf(turn)
  const next = nextOf(cfg, { session, turn, locked, ask, wanted, starting })
  return {
    isIdle,
    where: turn === null ? '空闲' : starting ? `第 ${session.turnNo} 轮 · 刚开始` : `第 ${session.turnNo} 轮 · 第 ${turn.stepNo} 步`,
    sessionKind: session.codeMode ? 'Code Mode 会话' : session.codeModeKnown ? '普通会话' : '尚未判断',
    // Before the first step: the level last seen (the lock, else the session's own).
    level: turn === null ? (wanted ?? session.sessionLevel) : starting ? (session.lock ?? session.sessionLevel) : (sent ?? wanted),
    wanted,
    sent,
    status: statusOf({ locked, idle: isIdle, starting, numeric: session.effortIsNumber }, wanted, sent),
    track: turn === null ? [] : turn.track,
    shifts,
    last: locked || judged === null ? null : lastOf(cfg, judged, turn === null ? '此前 · ' : ''),
    basis: turn === null ? null : basisOf(turn, recent, shifts),
    forecast: turn === null || locked || !cfg.enabled || !cfg.midrunShift || next.ahead === 0 ? null : forecastOf(cfg, wanted ?? sent, turn.lastJudged),
    next,
    features: featuresOf(cfg, { ...s, locked, ask, agents: agents.length }),
    backend: backendOf(cfg, recent),
    // Read back only what the mod set (a model, an effort): an agent it left alone has nothing to check.
    agents: agents.map((d) => ({ type: agentTypeOf(d), text: d.to ?? '', reading: d.applied ? readoutOf(d.sent, null) : null })),
    skill: skillOf(thisTurn),
  }
}
