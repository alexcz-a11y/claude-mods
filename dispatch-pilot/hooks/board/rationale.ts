// What the rationale pane shows of the board (spec #22 「依据面板」, GLOSSARY
// 依据面板 / 依据卡片 / 规则推演): the card of the agent picked, with its
// decisions and the rules' working step by step; the decision log grouped by
// turn; the lines at its top (what is switched off, the lock).
//
// Pure, like view.ts: the board's data, the switches and the pane's own view
// state come in as data. The rules' working is only worded here, never worked
// out again (ADR 0004): every step is one the rules stored with their decision
// (decision/effort.ts, decision/message-effort.ts, decision/dispatched-agent.ts),
// and whether it took effect is the step's own `applied`.
//
// The words are the pane's own (Chinese, GLOSSARY terms); a log entry's
// `reason` and a node's `why` come in the decision report's words (Chinese
// too, #32).

import { SIGNS } from '../decision/dispatched-agent.ts'
import { noBar, yesBar } from '../decision/guides.ts'
import { UNRESOLVED_OPTIONS } from '../decision/unresolved.ts'
import { OPTION_WORDS, VERDICT_WORDS } from '../core/unresolved.ts'
import type { LogEntry, RuleStep, Tone, UnresolvedRecord } from '../core/report.ts'
import { pctText } from './kit.tsx'
import { agentOf, featureOf, type AgentRow, type ScreenView } from './view.ts'

/** The pane's id: `$.ui.open`, `$.ui.close` and the `ui.render` hook's `requestId`. */
export const PANE_ID = 'dp-rationale'
/** Its tab's title, while another pane is open beside it. */
export const PANE_TITLE = '依据'
/** The body columns it asks for when docked beside a fullscreen transcript. */
export const PANE_COLUMNS = 76

/** The pane's own view state (`$.state` `paneView`): the log's turns the person folded or opened. */
export type PaneState = {
  /** A turn the person folded (`open` false) or opened; the others are as `OPEN_TURNS` says. */
  folds: { turn: number; open: boolean }[]
  /** Off the terminal: the switches and the lock are shown at the bottom of the pane (folded at first). */
  switches?: boolean
}

export const NO_PANE_STATE: PaneState = { folds: [] }

/** The keys that fold a turn of the log, newest turn first: one for each of the 20 turns it keeps, never p, n (paging) or f (it listed the skills that got no profile until ADR 0018; kept free). */
const FOLD_KEYS = ['a', 'b', 'c', 'd', 'e', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'o', 'q', 'r', 's', 't', 'u', 'v', 'w'] as const
/** The key that puts the picked agent's transcript in the main view, and the main conversation back. */
export const VIEW_KEY = 'x'
/** How many of the newest turns are open until the person folds them; older ones are folded. */
const OPEN_TURNS = 2

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
  /** Model step-ups of its loop (escalation), oldest first. */
  raises: LogEntry[]
}

/** The card of the agent picked on the band (`selected`); the main agent when none is, or the one picked is no longer on it. */
export function cardOf(view: ScreenView, log: readonly LogEntry[]): Card {
  const picked = view.rows.findIndex((row) => row.selected)
  const index = picked >= 0 ? picked : 0
  const row = view.rows[index] ?? null
  if (row === null) return { row: null, index: 0, count: 0, route: undefined, raises: [] }
  const { node } = row
  const route = node.decision === undefined ? undefined : log.find((entry) => entry.n === node.decision)
  // An agent's id is its own across turns; the main agent's entries are those of its node's turn.
  const mine = (entry: LogEntry) => agentOf(entry) === node.id && (node.id !== 'main' || entry.turn === node.turn)
  const raises = log.filter((entry) => mine(entry) && featureOf(entry.feature) === 'escalation' && entry.forced !== undefined)
  return { row, index, count: view.rows.length, route, raises }
}

const percent = (p: number) => `${Math.round(p * 100)}%`

/**
 * What the answers to the unresolved questions did to the count, in the card's words: the count (`次数 2 → 3`), what that
 * came to (`次数加一`), each question's probability and verdict, and the bars they were held to. Written from the record the
 * decision stored, never worked out again (ADR 0004).
 */
export function unresolvedWords(record: UnresolvedRecord): { count: string; verdict: string; odds: string; bars: string } {
  const p = record.probs
  const held = { yes: record.thresholds.yes, no: record.thresholds.no, inclusive: record.thresholds.inclusive !== false }
  const yes = yesBar(held, percent)
  const no = noBar(held, percent)
  const moved = record.before !== record.count
  const verdict = record.change === 'add' ? '次数加一' : record.change === 'reset' ? (moved ? '次数清零' : '本来就是 0，不用清零') : '次数不变'
  const bars =
    record.change === 'add'
      ? `仍未解决 ${yes}`
      : record.change === 'reset'
        ? record.verdicts.solved === 'yes'
          ? `已经解决 ${yes}`
          : `新任务 ${yes}，仍未解决 ${no}`
        : `是 ${yes}，否 ${no}，都没成立`
  return {
    count: moved ? `次数 ${record.before} → ${record.count}` : `次数 ${record.count}`,
    verdict,
    odds: UNRESOLVED_OPTIONS.map((option) => `${OPTION_WORDS[option]} ${p[option] === null ? '没回答' : percent(p[option] as number)}（${VERDICT_WORDS[record.verdicts[option]]}）`).join(' · '),
    bars,
  }
}

/** The row p (`-1`) or n (`+1`) goes to from the card's, held at either end. */
export function pageTo(card: Card, view: ScreenView, step: -1 | 1): AgentRow | null {
  if (card.row === null) return null
  return view.rows[Math.max(0, Math.min(view.rows.length - 1, card.index + step))] ?? null
}

/** How a step of the rules reads: it decided (`hit`), it passed without effect (`pass`), a floor lifted the level (`lift`). */
export type StepMark = 'hit' | 'pass' | 'lift'

/** One step of the rules' working, worded: its mark, the rule's name, what it did. */
type StepLine = { mark: StepMark; head: string; body: string }

const word =(value: unknown) => (value === null || value === undefined ? '—' : String(value))

/** The steps the rules walked, as the card writes them (each from the step's own fields). */
export function stepLines(trace: readonly RuleStep[]): StepLine[] {
  return trace.map((step) => stepLine(step))
}

const VERDICTS: Readonly<Record<string, string>> = { yes: '是', band: '拿不准', no: '否' }
/** A Noul's probability and verdict as the card writes them: `62%（拿不准）`, or 没回答. */
const said = (p: unknown, verdict: unknown) => (typeof p === 'number' ? `${pctText(p)}（${VERDICTS[String(verdict)] ?? word(verdict)}）` : '没回答')
/** A floor step: lifted (`lift`), a floor that did not need to lift (`pass`), or no floor at all (`pass`). */
const floorLine = (step: RuleStep, head: string, body: string): StepLine => {
  const floor = step.floor === null || step.floor === undefined ? '没有下限' : step.applied ? `下限 ${word(step.floor)}，抬到 ${word(step.level)}` : `下限 ${word(step.floor)}，已够`
  return { mark: step.applied ? 'lift' : 'pass', head, body: `${body} → ${floor}` }
}

/** A Noul about an agent's brief by its field in the steps (decision/dispatched-agent.ts SIGNS): `cause` is 原因未知. */
const SIGN_WORDS: Readonly<Record<string, string>> = Object.fromEntries(Object.values(SIGNS).map(({ key, words }) => [key, words]))
/** The Nouls a step about an agent's brief holds, as the card writes them: `写入 5%（否） · 一两步 91%（是）`. */
const signsBody = (step: RuleStep) =>
  Object.entries(SIGN_WORDS)
    .filter(([key]) => `${key}Verdict` in step)
    .map(([key, words]) => `${words} ${said(step[key], step[`${key}Verdict`])}`)
    .join(' · ')

/** The model table's row as the card writes it: `第 3b 行（原因未知拿不准）→ sonnet，effort 至少 max`, and what stood in for a model ruled out. */
function tableBody(step: RuleStep): string {
  if (step.row === '1') return `第 1 行：你点名了 ${word(step.model)}`
  const why = typeof step.why === 'string' ? `（${step.why.split(',').map((key) => SIGN_WORDS[key] ?? key).join('、')}${step.row === '3b' ? '拿不准' : ''}）` : ''
  const effort = step.row === '3b' ? '，effort 至少 max' : ''
  const skipped = step.model === step.wanted ? '' : step.model === null ? `；${word(step.wanted)} 被你排除，没有别的可用` : `；${word(step.wanted)} 被你排除，取最近的 ${word(step.model)}`
  return `第 ${word(step.row)} 行${why} → ${word(step.wanted)}${effort}${skipped}`
}

/** The route's step as the card writes it (d1-ultra): `powerful 62%（置信度 0.71）→ opus`, or the fall back, and what stood in for a model ruled out. */
function routeBody(step: RuleStep): string {
  const confidence = typeof step.confidence === 'number' ? step.confidence.toFixed(2) : '没有'
  const skipped = step.model === step.wanted ? '' : step.model === null ? `；${word(step.wanted)} 被你排除，没有别的可用` : `；${word(step.wanted)} 被你排除，取 ${word(step.model)}`
  if (step.fellBack === true) return `拿不准（置信度 ${confidence} < ${word(step.below)}）→ 最强的 ${word(step.wanted)}${skipped}`
  return `${word(step.tier)} ${typeof step.p === 'number' ? pctText(step.p) : '—'}（置信度 ${confidence}）→ ${word(step.wanted)}${skipped}`
}

function stepLine(step: RuleStep): StepLine {
  const on = step.applied
  switch (step.rule) {
    case 'lookup-signs':
      return { mark: on ? 'hit' : 'pass', head: '只读查找', body: signsBody(step) }
    case 'careful-signs':
      return { mark: on ? 'hit' : 'pass', head: '审慎', body: signsBody(step) }
    case 'model-table':
      return { mark: 'hit', head: '模型表', body: tableBody(step) }
    case 'route':
      return { mark: 'hit', head: '路由', body: routeBody(step) }
    case 'named-model':
      return { mark: 'hit', head: '点名', body: `你点名了 ${word(step.model)}` }
    case 'main-pick': {
      const who = step.asker === 'script' ? '脚本' : '主 agent'
      // `by`: the rules' model came from the route (d1-ultra) or the table (an entry without it: the table).
      const theirs = step.by === 'route' ? '路由给的' : '表里的'
      if (step.outcome === 'upgraded') return { mark: 'lift', head: who, body: `指定 ${word(step.requested)}；${theirs} ${word(step.table)} 更强，升级到 ${word(step.model)}` }
      return { mark: 'hit', head: who, body: `指定 ${word(step.requested)}；${step.table === null ? '决策模型没回答关于任务的题' : `${theirs} ${word(step.table)} 不比它强`}，保留（只升不降）` }
    }
    case 'unsure':
      return floorLine(step, '拿不准', step.row === '3b' ? '模型表第 3b 行：要不要 opus 拿不准' : step.row === null ? '没有模型表' : `模型表第 ${word(step.row)} 行`)
    case 'named-effort':
      return { mark: 'hit', head: '点名', body: `你点名了 effort ${word(step.level)}（规则定的是 ${word(step.decided)}），下限不动它` }
    case 'position':
      return { mark: 'hit', head: '位置', body: `${typeof step.position === 'number' ? step.position.toFixed(2) : word(step.position)}，四舍五入到 ${word(step.level)}` }
    case 'two-peaked':
      if (on) return { mark: 'hit', head: '双峰', body: `${word(step.peak)} ${pctText(step.p)} ≥ ${pctText(step.threshold)}，上取一档到 ${word(step.level)}` }
      return { mark: 'pass', head: '双峰', body: `高两档以上没有一档 ≥ ${pctText(step.threshold)}` }
    case 'low-confidence': {
      const confidence = typeof step.confidence === 'number' ? step.confidence.toFixed(2) : '没有'
      if (on) return { mark: 'hit', head: '置信度', body: `${confidence} < ${word(step.threshold)}，拿不准，上取一档到 ${word(step.level)}` }
      return { mark: 'pass', head: '置信度', body: typeof step.confidence === 'number' ? `${confidence}，不低于 ${word(step.threshold)}` : '没有给出置信度，不动' }
    }
    case 'model-floor':
      if (step.floor === null) return { mark: 'pass', head: '模型下限', body: `${word(step.model)} 没有下限` }
      if (on) return { mark: 'lift', head: '模型下限', body: `${word(step.model)} 至少 ${word(step.floor)}，${word(step.from)} 抬到 ${word(step.level)}` }
      return { mark: 'pass', head: '模型下限', body: `${word(step.model)} 至少 ${word(step.floor)}，${word(step.from)} 已够` }
    case 'ultrathink':
      return floorLine(step, 'ultrathink', step.named === true ? '消息里写了 ultrathink' : '消息里没有 ultrathink')
    case 'escalate':
      return floorLine(step, '要求多想', said(step.p, step.verdict))
    case 'confirm':
      return floorLine(step, '确认', `${said(step.p, step.verdict)} · 上一轮 ${step.lastEffort === null || step.lastEffort === undefined ? '没有记录' : word(step.lastEffort)}`)
    case 'stakes':
      return floorLine(step, '出错代价', `难以挽回 ${said(step.undo, step.undoVerdict)} · 线上或真钱 ${said(step.live, step.liveVerdict)} · 权限 ${said(step.access, step.accessVerdict)}`)
    case 'cause-unknown':
      return floorLine(step, '原因未知', said(step.p, step.verdict))
    case 'stuck-again':
      return floorLine(step, '上一轮卡住', `仍未解决 ${said(step.p, step.verdict)} · 上一轮${step.stuck === true ? `失败到了门槛（${word(step.lastEffort)}）` : '没卡住'}`)
    case 'unresolved-count':
      return floorLine(step, '未解决次数', `仍未解决 ${said(step.p, step.verdict)} · 次数 ${word(step.count)}，门槛 ${step.maxAfter === 0 ? '不用' : word(step.maxAfter)}`)
    case 'lock':
      return { mark: 'hit', head: '锁定', body: `锁在 ${word(step.level)}（规则定的是 ${word(step.decided)}）` }
    default: {
      const fields = Object.entries(step).filter(([key]) => key !== 'rule' && key !== 'applied').map(([key, value]) => `${key} ${word(value)}`)
      return { mark: on ? 'hit' : 'pass', head: step.rule, body: fields.join(' · ') }
    }
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
    case 'escalation':
      return entry.forced !== undefined ? '升模型' : '没升模型'
    case 'unresolved':
      return entry.unresolved === undefined ? '记录' : unresolvedWords(entry.unresolved).verdict
    case 'skills':
      return entry.skills !== undefined && entry.skills.suggest.length + entry.skills.try.length > 0 ? '已建议' : '没有建议'
    case 'find-skill':
      return entry.skills !== undefined && entry.skills.suggest.length > 0 ? '查到' : '没查到'
    case 'decision-model':
      return '改用别的决策模型'
    case 'visual-check':
      return entry.tone === 'fail' ? '核对失败' : '已核对'
    case 'screenshot-takeover':
      return '已接管'
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
