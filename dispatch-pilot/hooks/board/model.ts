// The board's data (design 5.14): one pure function from the mod's state to everything the timeline and the pane show,
// and the timeline's cells. No $ calls. The drawings only draw what boardModel returns; flows/submit.ts opens the cells,
// runtime.ts's record leaves the mark for the next one, and flows/readout.ts writes the level a cell's request carried.
import { canAsk } from '../backend.ts'
import type { Backend, Failure } from '../backend.ts'
import type { Config } from '../config.ts'
import { START, margins, readNoul } from '../decide.ts'
import type { Reason } from '../decide.ts'
import { LEVELS, isLevel } from '../levels.ts'
import type { Level } from '../levels.ts'
import type { Decision } from '../log.ts'
import { notesLeft } from '../midrun.ts'
import type { Skill } from '../skills.ts'
import type { Mark, SessionState, TrackCell, TurnState } from '../state.ts'

export type { Mark, TrackCell } from '../state.ts'

/** The cells a turn keeps: the drawings fold several steps into a column once there are more than they have room for. */
export const TRACK_KEEP = 300

export type BoardState = { session: SessionState; turn: TurnState | null; recent: readonly Decision[]; skills: readonly Skill[] }

export type BoardModel = {
  isIdle: boolean
  where: string
  level: Level | null
  wanted: Level | null
  sent: Level | null
  status: { kind: 'sent' | 'mismatch' | 'unverified' | 'locked' | 'idle' | 'none'; text: string }
  track: readonly TrackCell[]
  shifts: { at: string; from: Level; to: Level; why: string; isSent: boolean }[]
  last: { at: string; mark: Mark; text: string; probs: number[] | null; nouls: { label: string; value: number; reading: 'yes' | 'no' | 'unsure' }[]; rules: string[]; by: string } | null
  next: { main: string; sub: string; ahead: number }
  features: { label: string; state: 'active' | 'inactive' | 'off' | 'locked'; note: string }[]
  backend: { isOk: boolean; text: string }
  agents: { type: string; text: string; isVerified: boolean }[]
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

/** What one evaluation came to, as the timeline marks it. A level that is not one of the five reads as no change. */
export function markOf(d: Decision): Mark {
  if (d.failure !== null) return 'fail'
  if (!isLevel(d.from) || !isLevel(d.to) || d.from === d.to) return 'hold'
  return rank(d.to) > rank(d.from) ? 'up' : 'down'
}

/**
 * The turn once a main-loop step goes out at `level` (design 5.14): a new cell when the step starts a work step that has
 * none yet, marked with the evaluation made before it; unchanged for a later step of the work step under way.
 */
export function openCell(turn: TurnState, level: Level): TurnState {
  const done = turn.journal.workSteps
  if (turn.stepNo > done) return turn
  const track = [...turn.track, { level, sent: null, mark: turn.pendingMark }].slice(-TRACK_KEEP)
  return { ...turn, track, pendingMark: null, stepNo: done + 1 }
}

/** The turn with the level a main-loop request carried written into the last cell, while that cell has none. */
export function cellSent(turn: TurnState, level: Level): TurnState {
  const last = turn.track.at(-1)
  if (last === undefined || last.sent !== null) return turn
  return { ...turn, track: [...turn.track.slice(0, -1), { ...last, sent: level }] }
}

const LABELS = ['发消息定档', '中途换挡', 'agent 定档', 'skill 推荐', '档位核对', '进展记录'] as const

const backendName = (b: Backend): string => (b === 'drex' ? 'Drex' : 'Jev')
const atStep = (step: number | null): string => (step === null || step === 0 ? '发消息时' : `第 ${step} 步后`)
const isJudged = (d: Decision): boolean => d.kind === 'submit' || d.kind === 'midrun'
const two = (n: number): string => n.toFixed(2)

function statusOf(locked: boolean, idle: boolean, wanted: Level | null, sent: Level | null): BoardModel['status'] {
  if (locked) return { kind: 'locked', text: '已锁定' }
  if (idle) return { kind: 'idle', text: '空闲' }
  if (wanted === null) return { kind: 'none', text: '这个模型不收 effort' }
  if (sent === null) return { kind: 'unverified', text: '未核对' }
  if (sent !== wanted) return { kind: 'mismatch', text: `要 ${wanted}，实际发出 ${sent}` }
  return { kind: 'sent', text: '已发出' }
}

function shiftsOf(thisTurn: readonly Decision[]): BoardModel['shifts'] {
  const out: BoardModel['shifts'] = []
  for (const d of thisTurn) {
    const mark = isJudged(d) ? markOf(d) : 'hold'
    if ((mark !== 'up' && mark !== 'down') || !isLevel(d.from) || !isLevel(d.to)) continue
    out.push({ at: atStep(d.step), from: d.from, to: d.to, why: d.reason === null ? '' : (REASON_ZH[d.reason] ?? d.reason), isSent: d.sent === d.to })
  }
  return out
}

// The open question's distribution over the five levels; none for a failed evaluation or one without the answer.
function probsOf(d: Decision): number[] | null {
  const open = d.failure === null ? d.raw?.open : undefined
  return open?.type === 'score' && Array.isArray(open.probabilities) ? [...open.probabilities] : null
}

function lastOf(cfg: Config, d: Decision): NonNullable<BoardModel['last']> {
  const mark = markOf(d)
  const name = backendName(d.backend ?? cfg.backend)
  const at = atStep(d.step)
  if (d.failure !== null) {
    const why = FAILURE_ZH[d.failure] ?? d.failure
    return { at, mark, text: '评估失败，档位不变', probs: null, nouls: [], rules: [`评估失败：${why}，按规则放行`], by: `${name} ${why}` }
  }
  const bars = d.bars ?? START
  const probs = probsOf(d)
  // In the order the questions were asked: the answers are kept in that order.
  const nouls: NonNullable<BoardModel['last']>['nouls'] = []
  for (const [id, a] of Object.entries(d.raw ?? {})) {
    if (a?.type === 'noul') nouls.push({ label: NOUL_ZH[id] ?? id, value: a.noul, reading: readNoul(a.noul, bars) })
  }
  const rules: string[] = []
  if (probs !== null && isLevel(d.from)) {
    const m = margins(d.from, probs, bars, d.kind === 'midrun' ? 'xhigh' : 'max')
    if (m.up !== null) rules.push(`再升一档要上方合计 ≥ ${two(m.up.bar)}，现在 ${two(m.up.sum)}`)
    if (m.down !== null) rules.push(`降一档要下方合计 ≥ ${two(m.down.bar)}，现在 ${two(m.down.sum)}`)
  }
  const text = mark === 'up' ? `升到 ${d.to}` : mark === 'down' ? `降到 ${d.to}` : '不变'
  return { at, mark, text, probs, nouls, rules, by: `${name} · ${d.ms} ms` }
}

function nextOf(cfg: Config, s: { session: SessionState; turn: TurnState | null; locked: boolean; ask: boolean }): BoardModel['next'] {
  const { session, turn } = s
  if (turn === null) {
    const level = session.previous?.level ?? null
    return { main: '发出下一条消息时', sub: level === null ? '' : `说「继续」这类话会从上一轮的 ${level} 起算`, ahead: 0 }
  }
  if (s.locked) return { main: '不评估', sub: '/dp unlock 解锁后恢复', ahead: 0 }
  // The mod off judges nothing, as with the mid-run shift off.
  if (!cfg.enabled || !cfg.midrunShift || !s.ask) return { main: '本轮不再评估', sub: cfg.enabled && cfg.midrunShift ? '没有可用的后端' : '中途换挡关着', ahead: 0 }
  const left = notesLeft(turn.midrun, cfg)
  if (left === 0) return { main: '本轮不再换挡', sub: '说明条数已用完；有新输入时仍会评估', ahead: 0 }
  if (session.codeMode) {
    const every = cfg.midrunEveryScripts
    if (every === 0) return { main: '只在有新输入时', sub: '按脚本结果的评估关着', ahead: 0 }
    const n = Math.max(1, every - turn.midrun.scriptsSinceCheck)
    return { main: n === 1 ? '下一份脚本结果到达时' : `再 ${n} 份脚本结果`, sub: `每 ${every} 份脚本结果评估一次 · 本轮还可换挡 ${left} 次`, ahead: n }
  }
  const every = cfg.midrunEverySteps
  if (every === 0) return { main: '失败成簇时', sub: '按步数的评估关着', ahead: 0 }
  const n = Math.max(1, every - turn.midrun.stepsSinceCheck)
  return { main: `再 ${n} 步`, sub: `每 ${every} 步评估一次 · 同一失败复现或连续两步失败会提前`, ahead: n }
}

function featuresOf(cfg: Config, s: BoardState & { locked: boolean; ask: boolean; agents: number }): BoardModel['features'] {
  const noBackend = s.ask ? null : '没有可用的后端'
  const judging = noBackend ?? (cfg.mode === 'shadow' ? '只记录，不改' : null)
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
    [cfg.skills, false, noBackend ?? (s.skills.length === 0 ? '还没拿到 skill 列表' : null), `${s.skills.length} 个候选`],
    [cfg.verifyEffort, false, unread, ''],
    [cfg.progressNote, false, s.session.progressBlocked ? '模型被拒绝' : null, ''],
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
  if (!canAsk(cfg)) return { isOk: false, text: '没有密钥' }
  const label = `${backendName(cfg.backend)} ${cfg.backend === 'drex' ? cfg.drexModel : cfg.jevModel}`
  // The last decision that asked a decision model: a progress note's failure is another model's.
  const asked = recent.findLast((d) => d.backend !== null)
  if (asked !== undefined && asked.failure !== null) return { isOk: false, text: `${label} · 最近一次${FAILURE_ZH[asked.failure] ?? asked.failure}` }
  return { isOk: true, text: `${label} · 可用` }
}

/** Everything the board shows, from the state alone (design 5.14). Total: any state the mod can hold gives a model. */
export function boardModel(cfg: Config, s: BoardState): BoardModel {
  const { session, turn, recent } = s
  const isIdle = turn === null
  const locked = session.lock !== null
  const ask = canAsk(cfg)
  const wanted = turn === null ? null : (session.lock ?? turn.wanted ?? turn.base)
  const sent = session.lastSent
  const thisTurn = turn === null ? [] : recent.filter((d) => d.turnId === turn.turnId)
  const agents = thisTurn.filter((d) => d.kind === 'agent')
  const judged = recent.findLast(isJudged)
  return {
    isIdle,
    where: turn === null ? '空闲' : `第 ${session.turnNo} 轮 · 第 ${turn.stepNo} 步`,
    level: turn === null ? session.sessionLevel : (sent ?? wanted),
    wanted,
    sent,
    status: statusOf(locked, isIdle, wanted, sent),
    track: turn === null ? [] : turn.track,
    shifts: shiftsOf(thisTurn),
    last: locked || judged === undefined ? null : lastOf(cfg, judged),
    next: nextOf(cfg, { session, turn, locked, ask }),
    features: featuresOf(cfg, { ...s, locked, ask, agents: agents.length }),
    backend: backendOf(cfg, recent),
    agents: agents.map((d) => ({ type: d.detail, text: d.to ?? '', isVerified: isLevel(d.sent) })),
    skill: thisTurn.findLast((d) => d.kind === 'skill' && d.to !== null)?.to ?? null,
  }
}
