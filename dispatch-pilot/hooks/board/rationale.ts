// What the rationale pane shows of the board (spec #22 「依据面板」, GLOSSARY
// 依据面板 / 依据卡片 / 规则推演): the card of the agent picked, with its
// decisions and the rules' working step by step; the decision log grouped by
// turn; the lines at its top (what is switched off, the lock, how the skill
// profiles went).
//
// Pure, like view.ts: the board's data, the switches and the pane's own view
// state come in as data. The rules' working is only worded here, never worked
// out again (ADR 0004): every step is one that `pickEffort`, `judgeMidturn` or a
// forced raise stored with its decision, and whether it took effect is the
// step's own `applied`.
//
// The words are the pane's own (Chinese, GLOSSARY terms); a log entry's
// `reason` and a node's `why` come in the decision report's words (Chinese
// too, #32).

import { isEffort, type Effort } from '../decision/effort.ts'
import { UNRESOLVED_OPTIONS } from '../decision/unresolved.ts'
import { OPTION_WORDS } from '../core/unresolved.ts'
import type { LogEntry, ProfilesState, RuleStep, Tone, UnresolvedRecord } from '../core/report.ts'
import { pct } from './kit.tsx'
import { featureOf, type AgentRow, type ScreenView } from './view.ts'

/** The pane's id: `$.ui.open`, `$.ui.close` and the `ui.render` hook's `requestId`. */
export const PANE_ID = 'dp-rationale'
/** Its tab's title, while another pane is open beside it. */
export const PANE_TITLE = '依据'
/** The body columns it asks for when docked beside a fullscreen transcript. */
export const PANE_COLUMNS = 76

/** The pane's own view state (`$.state` `paneView`): the log's turns the person folded or opened, the failed skills shown. */
export type PaneState = {
  /** A turn the person folded (`open` false) or opened; the others are as `OPEN_TURNS` says. */
  folds: { turn: number; open: boolean }[]
  /** The skills that got no profile are listed. */
  failures: boolean
}

export const NO_PANE_STATE: PaneState = { folds: [], failures: false }

/** The keys that fold a turn of the log, newest turn first: one for each of the 20 turns it keeps, never p, n (paging) or f (the failed skills). */
export const FOLD_KEYS = ['a', 'b', 'c', 'd', 'e', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'o', 'q', 'r', 's', 't', 'u', 'v', 'w'] as const
/** The key that lists the skills that got no profile. */
export const FAILURES_KEY = 'f'
/** How many of the newest turns are open until the person folds them; older ones are folded. */
export const OPEN_TURNS = 2

// ---- the card -------------------------------------------------------------------

/** The agent the card is about, and what the log holds of it. */
export type Card = {
  /** Its row on the band (null before any agent is on the board). */
  row: AgentRow | null
  /** Where it is among the rows (for p / n), and how many there are. */
  index: number
  count: number
  /** The decision its route came from (its node's `decision`). */
  route: LogEntry | undefined
  /** Forced raises of its loop (escalation), oldest first. */
  raises: LogEntry[]
  /** The main agent's mid-turn re-decisions of its turn, oldest first. */
  mids: LogEntry[]
}

/** The card of the agent picked on the band (`selected`); the main agent when none is, or the one picked is no longer on it. */
export function cardOf(view: ScreenView, log: readonly LogEntry[]): Card {
  const picked = view.rows.findIndex((row) => row.selected)
  const index = picked >= 0 ? picked : 0
  const row = view.rows[index] ?? null
  if (row === null) return { row: null, index: 0, count: 0, route: undefined, raises: [], mids: [] }
  const { node } = row
  const route = node.decision === undefined ? undefined : log.find((entry) => entry.n === node.decision)
  // An agent's id is its own across turns; the main agent's entries are those of its node's turn.
  const mine = (entry: LogEntry) => (entry.agent ?? '') === node.id && (node.id !== 'main' || entry.turn === node.turn)
  const raises = log.filter((entry) => mine(entry) && featureOf(entry.feature) === 'escalation' && entry.forced !== undefined)
  const mids = node.id !== 'main' ? [] : log.filter((entry) => mine(entry) && entry.mid !== undefined && entry.forced === undefined && (featureOf(entry.feature) === 'midturn-effort' || featureOf(entry.feature) === 'escalation'))
  return { row, index, count: view.rows.length, route, raises, mids }
}

const percent = (p: number) => `${Math.round(p * 100)}%`

/**
 * What an answer to the unresolved question did to the count, in the card's words: the count (`次数 2 → 3`), what that
 * came to (`次数加一`), the options' probabilities, and the bar each was held to. Written from the record the decision
 * stored with its two bars, never worked out again (ADR 0004).
 */
export function unresolvedWords(record: UnresolvedRecord): { count: string; verdict: string; odds: string; bars: string } {
  const p = record.probs
  const { add, reset } = record.thresholds
  const moved = record.before !== record.count
  const verdict = record.change === 'add' ? '次数加一' : record.change === 'reset' ? (moved ? '次数清零' : '本来就是 0，不用清零') : '次数不变'
  const crossed = p.resolved >= reset ? 'resolved' : 'new_or_unrelated'
  const bars =
    record.change === 'add'
      ? `仍未解决 ${percent(p.still_unresolved)} ≥ 加一门槛 ${percent(add)}`
      : record.change === 'reset'
        ? `${OPTION_WORDS[crossed]} ${percent(p[crossed])} ≥ 清零门槛 ${percent(reset)}`
        : `都没到：仍未解决 < 加一门槛 ${percent(add)}，其余 < 清零门槛 ${percent(reset)}`
  return {
    count: moved ? `次数 ${record.before} → ${record.count}` : `次数 ${record.count}`,
    verdict,
    odds: UNRESOLVED_OPTIONS.map((option) => `${OPTION_WORDS[option]} ${percent(p[option])}`).join(' · '),
    bars,
  }
}

/** The row p (`-1`) or n (`+1`) goes to from the card's, held at either end. */
export function pageTo(card: Card, view: ScreenView, step: -1 | 1): AgentRow | null {
  if (card.row === null) return null
  return view.rows[Math.max(0, Math.min(view.rows.length - 1, card.index + step))] ?? null
}

/** How a step of the rules reads: it decided (`hit`), it passed without effect (`pass`), a floor lifted the level (`lift`), the failures forced a raise (`raise`). */
export type StepMark = 'hit' | 'pass' | 'lift' | 'raise'

/** One step of the rules' working, worded: its mark, the rule's name, what it did. */
export type StepLine = { mark: StepMark; head: string; body: string }

const num = (value: unknown) => (typeof value === 'number' ? pct(value) : '?')
const word = (value: unknown) => (value === null || value === undefined ? '—' : String(value))

/** The steps the rules walked, as the card writes them (each from the step's own fields). */
export function stepLines(trace: readonly RuleStep[]): StepLine[] {
  const top = trace.find((step) => step.rule === 'top')
  return trace.map((step) => stepLine(step, top))
}

function stepLine(step: RuleStep, top: RuleStep | undefined): StepLine {
  const on = step.applied
  switch (step.rule) {
    case 'top':
      return { mark: 'hit', head: '最可能', body: `${word(step.level)} ${num(step.p)}${step.tie === true ? '（并列，取高的一档）' : ''}` }
    case 'max-gate':
      if (on) return { mark: 'hit', head: 'max 门槛', body: `max ${num(step.p)} < ${num(step.thetaMax)}，改取其余最可能的 ${word(step.level)}` }
      return { mark: 'pass', head: 'max 门槛', body: top?.level === 'max' ? `max ${num(step.p)} ≥ ${num(step.thetaMax)}，可以取 max` : '最可能的不是 max，不用过门槛' }
    case 'round-up':
      if (on) return { mark: 'hit', head: '上取一档', body: `${word(step.above)} ${num(step.p)} ≥ ${num(step.threshold)}，取高一档 ${word(step.level)}` }
      if (step.above === null) return { mark: 'pass', head: '上取一档', body: '已是最高一档' }
      if (step.blockedByMax === true) return { mark: 'pass', head: '上取一档', body: `max ${num(step.p)} ≥ ${num(step.threshold)}，但没到 max 门槛 ${num(step.thetaMax)}，不上取` }
      return { mark: 'pass', head: '上取一档', body: `${word(step.above)} ${num(step.p)} < ${num(step.threshold)}，不上取` }
    case 'model-floor':
      if (step.floor === null) return { mark: 'pass', head: '模型下限', body: `${word(step.model)} 没有下限` }
      if (on) return { mark: 'lift', head: '模型下限', body: `${word(step.model)} 至少 ${word(step.floor)}，${word(step.from)} 抬到 ${word(step.level)}` }
      return { mark: 'pass', head: '模型下限', body: `${word(step.model)} 至少 ${word(step.floor)}，${word(step.from)} 已够` }
    case 'plan-floor': {
      const head = step.forced === true ? '强制升档' : '计划下限'
      if (step.floor === null) return { mark: 'pass', head, body: '没有下限' }
      if (on) return { mark: step.forced === true ? 'raise' : 'lift', head, body: `至少 ${word(step.floor)}，${word(step.from)} 抬到 ${word(step.level)}` }
      return { mark: 'pass', head, body: `至少 ${word(step.floor)}，${word(step.from)} 已够` }
    }
    case 'forced-raise':
      return { mark: 'raise', head: '强制升档', body: `${word(step.from)} → ${word(step.level)}（${step.mode === 'max' ? '直接升到 max' : '升一档'}）` }
    case 'theta-up':
      return { mark: on ? 'hit' : 'pass', head: '升档门槛', body: `置信 ${num(step.confidence)} ${on ? '≥' : '<'} ${num(step.threshold)}，${on ? '把握够' : '把握不够'}` }
    case 'higher-of':
      return on ? { mark: 'hit', head: '取较高', body: `判断的 ${word(step.level)} 高于强制的 ${word(step.from)}，取 ${word(step.level)}` } : { mark: 'pass', head: '取较高', body: `判断的不比强制的高，取 ${word(step.from)}` }
    case 'suggest':
      return { mark: 'hit', head: '建议', body: `${word(step.picked)}，当前 ${word(step.current)}${step.direction === 'same' ? '，不变' : ''}` }
    case 'hold':
      if (on) return { mark: 'hit', head: '防抖', body: `升档后才 ${word(step.sinceRaise)} 步（${word(step.holdSteps)} 步内不降），还差 ${word(step.remaining)} 步` }
      return { mark: 'pass', head: '防抖', body: step.sinceRaise === null ? '这一轮没有升过档，可以降' : `升档已过 ${word(step.sinceRaise)} 步（${word(step.holdSteps)} 步内不降），可以降` }
    case 'theta-down':
      return { mark: on ? 'hit' : 'pass', head: '降档门槛', body: `置信 ${num(step.confidence)} ${on ? '≥' : '<'} ${num(step.threshold)}，${on ? '把握够' : '把握不够'}` }
    case 'one-step':
      return { mark: 'hit', head: '一次一档', body: `${word(step.from)} 降到 ${word(step.level)}` }
    case 'floor':
      return on ? { mark: 'lift', head: '下限', body: `至少 ${word(step.floor)}，${word(step.from)} 抬到 ${word(step.level)}` } : { mark: 'pass', head: '下限', body: `至少 ${word(step.floor)}，${word(step.from)} 已够` }
    default: {
      const fields = Object.entries(step).filter(([key]) => key !== 'rule' && key !== 'applied').map(([key, value]) => `${key} ${word(value)}`)
      return { mark: on ? 'hit' : 'pass', head: step.rule, body: fields.join(' · ') }
    }
  }
}

/** A mid-turn re-decision as the card's row says it: what it suggested, how sure it was against the line it had to pass, where it ended. */
export type MidVerdict = {
  picked: Effort
  current: Effort
  result: Effort
  /** The confidence the answer had, and the line a move needed (absent: none was asked, the lowering held or the level the same). */
  conf?: number
  threshold?: number
  /** The answer passed that line (its step's own `applied`); null when no line was asked. */
  passed: boolean | null
  /** `up` / `down` moved; `blocked` a move short of the line; `held` a lowering waiting after a raise; `same` the level suggested is the current one. */
  kind: 'up' | 'down' | 'blocked' | 'held' | 'same'
  /** Which line: the raise's or the lowering's. */
  line: 'up' | 'down' | null
  /** The steps still to wait, while held. */
  remaining?: number
  /** A floor that lifted the result. */
  floor?: Effort
}

export function midVerdict(entry: LogEntry): MidVerdict | null {
  const mid = entry.mid
  if (mid === undefined) return null
  const steps = entry.trace ?? []
  const suggest = steps.find((step) => step.rule === 'suggest')
  const theta = steps.find((step) => step.rule === 'theta-up' || step.rule === 'theta-down')
  const hold = steps.find((step) => step.rule === 'hold' && step.applied)
  const floor = steps.find((step) => step.rule === 'floor' && step.applied)
  const conf = typeof theta?.confidence === 'number' ? theta.confidence : entry.conf
  const threshold = typeof theta?.threshold === 'number' ? theta.threshold : mid.threshold
  const direction = suggest?.direction ?? (mid.picked === mid.current ? 'same' : null)
  const line = theta === undefined ? (direction === 'up' ? 'up' : direction === 'down' ? 'down' : null) : theta.rule === 'theta-up' ? 'up' : 'down'
  const passed = theta === undefined ? null : theta.applied
  const kind: MidVerdict['kind'] =
    hold !== undefined || mid.held !== undefined
      ? 'held'
      : direction === 'same'
        ? 'same'
        : passed === false
          ? 'blocked'
          : mid.result === mid.current
            ? 'same'
            : line === 'down'
              ? 'down'
              : 'up'
  const remaining = typeof hold?.remaining === 'number' ? hold.remaining : mid.remaining
  return {
    picked: mid.picked,
    current: mid.current,
    result: mid.result,
    ...(conf === undefined ? {} : { conf }),
    ...(threshold === undefined || kind === 'held' ? {} : { threshold }),
    passed: kind === 'held' ? null : passed,
    kind,
    line: kind === 'held' ? 'down' : line,
    ...(kind === 'held' && remaining !== undefined ? { remaining } : {}),
    ...(floor !== undefined && isEffort(floor.floor) ? { floor: floor.floor } : {}),
  }
}

/** A verdict's conclusion in words: `升到 high`, `降档被拦，保持 xhigh`, `防抖中，还差 3 步，保持 xhigh`. */
export function verdictWords(verdict: MidVerdict): string {
  const lifted = verdict.floor === undefined ? '' : `（下限 ${verdict.floor}）`
  switch (verdict.kind) {
    case 'up':
      return `升到 ${verdict.result}${lifted}`
    case 'down':
      return `降一档到 ${verdict.result}${lifted}`
    case 'blocked':
      return `${verdict.line === 'down' ? '降档' : '升档'}被拦，保持 ${verdict.result}${lifted}`
    case 'held':
      return `防抖中${verdict.remaining === undefined ? '' : `，还差 ${verdict.remaining} 步`}，保持 ${verdict.result}${lifted}`
    case 'same':
      return `建议就是当前档，保持 ${verdict.result}${lifted}`
  }
}

// ---- the log ----------------------------------------------------------------------

/** What an entry did, in a word or two: the log's verb, coloured by its tone. */
export function entryVerb(entry: LogEntry): string {
  const feature = featureOf(entry.feature)
  switch (feature) {
    case 'main-effort':
    case 'dispatched-agents':
      return '已决定'
    case 'workflow-agents':
    case 'workflow-labels':
      return entry.sentBack === true ? '退回改写' : '已决定'
    case 'midturn-effort': {
      const verdict = midVerdict(entry)
      if (verdict === null) return '已重判'
      return verdict.kind === 'up' ? '升档' : verdict.kind === 'down' ? '降档' : verdict.kind === 'held' ? '防抖中' : '保持'
    }
    case 'escalation':
      return entry.forced !== undefined ? '强制升档' : entry.mid !== undefined && entry.mid.result !== entry.mid.current ? '重判改档' : '未升档'
    case 'unresolved':
      return entry.hint !== undefined ? '给了强提示' : entry.unresolved === undefined ? '记录' : unresolvedWords(entry.unresolved).verdict
    case 'skills':
      return entry.skills !== undefined && entry.skills.suggest.length + entry.skills.try.length > 0 ? '已建议' : '没有建议'
    case 'find-skill':
      return entry.skills !== undefined && entry.skills.suggest.length > 0 ? '查到' : '没查到'
    case 'skill-profiles':
      return entry.tone === 'ok' ? '画像就绪' : entry.tone === 'warn' ? '画像有失败' : entry.tone === 'fail' ? '画像停写' : '画像暂停'
    case 'decision-model':
      return '改用别的决策模型'
    default:
      return entry.tone === 'fail' ? '失败' : entry.tone === 'warn' ? '注意' : '记录'
  }
}

/** One turn of the log: its fold key (null past the 20 keys), whether it is open, the message it started with, its entries oldest first, its tones counted. */
export type LogGroup = {
  turn: number
  key: string | null
  open: boolean
  prompt: string
  entries: LogEntry[]
  counts: Record<Tone, number>
}

/** The log by turn, newest turn first; each open as the person left it, else the `OPEN_TURNS` newest. */
export function logGroups(log: readonly LogEntry[], state: PaneState): LogGroup[] {
  const turns = [...new Set(log.map((entry) => entry.turn))].sort((a, b) => b - a)
  return turns.map((turn, i) => {
    const entries = log.filter((entry) => entry.turn === turn)
    const chosen = state.folds.find((fold) => fold.turn === turn)
    const counts: Record<Tone, number> = { ok: 0, warn: 0, fail: 0, info: 0 }
    for (const entry of entries) counts[entry.tone] += 1
    return {
      turn,
      key: FOLD_KEYS[i] ?? null,
      open: chosen?.open ?? i < OPEN_TURNS,
      prompt: entries.find((entry) => featureOf(entry.feature) === 'main-effort')?.subject ?? '',
      entries,
      counts,
    }
  })
}

/** The pane's view state with one turn folded or opened (the choice kept for the turns the log still has). */
export function withFold(state: PaneState, turn: number, open: boolean, log: readonly LogEntry[]): PaneState {
  const kept = new Set(log.map((entry) => entry.turn))
  return { ...state, folds: [...state.folds.filter((fold) => fold.turn !== turn && kept.has(fold.turn)), { turn, open }] }
}

// ---- the top lines ------------------------------------------------------------------

/** Why writing the profiles stopped, in a few words (the stop's `detail` follows in its own words). */
const STOPPED: Record<NonNullable<ProfilesState['stop']>['reason'], (model: string) => string> = {
  'store-read': () => '读不到本地存储，不保留也不写',
  'model-refused': (model) => `引擎拒绝了 ${model}`,
  'api-error': (model) => `${model} 返回了接口错误`,
  'store-write': () => '本地存储存不下画像',
  off: () => '写的过程中被关掉了',
  error: () => '出错了',
}

/** How the session's skill profiles went, in one line: `skill 画像：保留 52 · 新写 3 · 失败 1`, `生成中 2/5`, or why it stopped. */
export function profilesLine(profiles: ProfilesState): { text: string; tone: 'muted' | 'warn' | 'fail' } {
  const counts = [`保留 ${profiles.kept}`, ...(profiles.phase === 'writing' ? [] : [`新写 ${profiles.written}`]), ...(profiles.failed > 0 ? [`失败 ${profiles.failed}`] : []), ...(profiles.deferred > 0 && profiles.phase !== 'writing' ? [`延后 ${profiles.deferred}`] : [])].join(' · ')
  if (profiles.phase === 'writing') return { text: `skill 画像：生成中 ${profiles.written}/${profiles.planned} · ${counts}`, tone: profiles.failed > 0 ? 'warn' : 'muted' }
  if (profiles.phase === 'stopped') {
    const stop = profiles.stop
    const why = stop === undefined ? '' : `${STOPPED[stop.reason](profiles.model)}${stop.detail === '' ? '' : `：${stop.detail}`}`
    return { text: `skill 画像：已停写（${why}） · ${counts}`, tone: stop?.reason === 'off' ? 'muted' : 'fail' }
  }
  return { text: `skill 画像：${counts}`, tone: profiles.failed > 0 ? 'warn' : 'muted' }
}

/** The pane's top line when the whole mod is switched off; null while it is on. */
export function offLine(master: boolean): string | null {
  return master ? null : 'Dispatch Pilot 已关：不发决策请求，每一步照引擎原样发出（/dp on 打开）'
}

/** A switch's state in the word the pane lists it with (every switch is listed, the ones that are off in grey). */
export function switchWord(on: boolean): string {
  return on ? '开' : '关'
}
