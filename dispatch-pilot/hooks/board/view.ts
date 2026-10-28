// What the screens show of the board, worked out once (spec #22 「Band」「脚部」):
// which turn, its agents in the order they started (each with its number for
// the digit keys, its time on the turn's ribbon and what its status cell
// says), the turn's events in order, and the one-line summary of a finished
// turn. The band, the footer and the rationale pane (#30) all draw from a
// `ScreenView`; none of them reads the board itself.
//
// Pure: the board, the log, the time and the switches come in as data and
// closures (`ScreenInput`). A feature that is off owns nothing here: its
// decisions, notes and board parts are left out (spec story 34). The log
// entries of the decision model's fallback are left off the band (#33); the
// pane shows them.
//
// The words are the screens' own (Chinese, GLOSSARY terms); `why` on a node
// comes in the decision report's words (Chinese too, #32).

import { failureWords } from '../decision/backend.ts'
import { isEffort, type Effort } from '../decision/effort.ts'
import { callWorkflowOf, ENDED_WORDS, type Board, type BoardNode, type BoardNote, type LogEntry, type Model, type Reading, type ReadingChange, type RuleStep } from '../core/report.ts'
import type { BoardPart } from '../core/switches.ts'
import { tallyText } from '../decision/visual-check-record.ts'
import { mmss, pct, pctText, SPIN } from './kit.tsx'

/** What the screens are drawn from. */
export type ScreenInput = {
  board: Board
  log: readonly LogEntry[]
  /** `$.clock.now()`, ms. */
  now: number
  /** The agent the person picked (`selected` in $.state). */
  selected: { turn: number; id: string } | null
  /** Whether Dispatch Pilot as a whole is on. */
  master: boolean
  /** Whether a feature is on (its switch name). */
  isOn: (feature: string) => boolean
  /** Whether a board part is shown (every feature that owns it is on). */
  isShown: (part: BoardPart) => boolean
  /** The engine says a model turn is running (`isWorking` of the band's props). */
  isWorking: boolean
  /** Drawn for a surface that redraws every `SLOW_TICK_MS` (all but the terminal): no spinner, ribbons that look ahead. Absent: false. */
  slow?: boolean
}

/** How an agent's status cell reads: its tone picks the colour (kit.tsx `STATUS_COLOR`). Not a log entry's `Tone`. */
export type StatusTone = 'run' | 'done' | 'fail' | 'warn' | 'muted'

/** One agent of the turn, as a row of the band. */
export type AgentRow = {
  node: BoardNode
  /** Its digit key: 0 the main agent, 1-9 the agents in the order they started; null past 9. */
  key: number | null
  /** When it started and ended on the turn's time axis, seconds from the turn's start; `to` null: queued, not begun. */
  from: number
  to: number | null
  /** What its status cell says. */
  status: { tone: StatusTone; text: string }
  /** The person picked it (`selected`). */
  selected: boolean
  /** Its visual_check count for the loop (`核对 3：1 过 · 1 不过 · 1 没把握`); empty while it made none, or the feature is off. */
  checks: string
}

/** Something that happened in the turn, at `at` seconds from its start. */
export type BandEvent = { at: number } & (
  | { kind: 'decided'; who: string; main: boolean; model?: Model; effort?: Effort; reason: string; ok: boolean }
  | { kind: 'workflow'; name: string; calls: number; models: Partial<Record<Model, number>>; sentBack: boolean; byLabel: boolean }
  | { kind: 'raise'; who: string; from: string; to: string; failed: number; blocked: number }
  | { kind: 'change'; who: string; from: Reading; to: Reading }
  | { kind: 'skills'; suggest: { name: string; relevance: number }[]; tried: { name: string; relevance: number }[] }
  | { kind: 'find'; query: string; found: { name: string; relevance: number }[] }
  | { kind: 'note'; who: string; feature: string; note: BoardNote['kind']; why: string }
)

/** The screens' view of the board. */
export type ScreenView = {
  /** Dispatch Pilot is switched off: the band shows nothing of it, the footer says so. */
  off: boolean
  /** The turn shown (`board.turn`); 0 before the first. */
  turn: number
  /** Seconds since that turn started (0 when its start is not known). */
  elapsed: number
  /** The turn, or an agent of it, is still going: the full band; else the one-line summary. */
  live: boolean
  /** The main agent first, then the agents in the order they started (queued last). */
  rows: AgentRow[]
  /** The turn's events, oldest first. */
  events: BandEvent[]
  /** How many agents (the main agent left out) run, are done, failed, wait. A Workflow call never started is not counted. */
  counts: { running: number; done: number; failed: number; queued: number }
  /** The Workflow agents of the turn: done of all its calls and agents. */
  workflow: { done: number; total: number } | null
  /** A finished turn in one line: why the main agent's effort, the skills for the person to try. */
  summary: { reason: string; tried: string[] }
  /** A spinner frame for this moment; -1 on a surface that redraws seldom, where a spinner would stand still (`spin`). */
  frame: number
  /** Seconds until the next redraw while an agent runs, which a running ribbon grows through by itself: 0 on the terminal, which redraws every frame. */
  ahead: number
}

/** The spinner turns one frame each `TICK_MS`; the terminal's screens redraw at that pace while an agent runs. */
export const TICK_MS = 200

/**
 * How often the screens redraw on the other surfaces while an agent runs. A redraw gives every Button a new handle,
 * and Desktop sends a press with the handle of the tree it shows: one drawn over meanwhile is lost (`ui_press not
 * handled`, measured on 2.1.299). So no spinner there, and a running ribbon grows by itself up to the next redraw.
 */
export const SLOW_TICK_MS = 5000

/**
 * A Workflow call's node, standing for an agent that has not started (`callNodeId`). One written as a template
 * stays once its agents start, marked started, for the agents after them: the screens show those agents, not it.
 */
function isCallNode(node: BoardNode): boolean {
  return callWorkflowOf(node.id) !== null
}

/** A Workflow not routed as a whole (given by path, an error): one node for all its agents, neither an agent's nor a call's. */
export function isWholeWorkflow(node: BoardNode): boolean {
  return node.kind === 'wf' && node.workflow === undefined && !isCallNode(node)
}

/** A node of the turn still going: running, or waiting to start (a dispatched agent spawned, a decision for a turn about to begin). */
function active(node: BoardNode): boolean {
  return node.state === 'running' || (node.state === 'queued' && !isCallNode(node))
}

/**
 * The words a person reads for each feature (an entry's, a note's), the band's and the pane's alike: the GLOSSARY's
 * terms (失败升模型, 兜底, skill 推荐, skill 查询, skill 画像). A feature it lacks is called by its switch name.
 */
export const FEATURE_WORDS: Readonly<Record<string, string>> = {
  'main-effort': '主 agent 的 effort',
  unresolved: '未解决次数',
  summary: '问题摘要',
  'dispatched-agents': '派出 agent',
  'workflow-agents': 'Workflow 里的 agent',
  'workflow-labels': 'Workflow 兜底',
  escalation: '失败升模型',
  skills: 'skill 推荐',
  'find-skill': 'skill 查询',
  'decision-model': '决策模型',
  'visual-check': '看图核对',
  'screenshot-takeover': '截图接管',
  'image-routing': '带图路由',
}

/** The feature an entry or a note is of: its switch name (`main-effort (agent report)` is main-effort's). */
export function featureOf(feature: string): string {
  return feature.split(' ')[0] ?? feature
}

/** The agent an entry is about: the main agent when it names none. */
export function agentOf(entry: LogEntry): string {
  return entry.agent ?? 'main'
}

export function screenView(input: ScreenInput): ScreenView {
  const { board, now } = input
  const frame = input.slow === true ? -1 : Math.floor(now / TICK_MS) % SPIN.length
  const ahead = input.slow === true ? SLOW_TICK_MS / 1000 : 0
  const turn = board.turn
  const startOf = (of: number) => board.starts?.find((start) => start.turn === of)?.at
  const start = startOf(turn)
  const elapsed = start === undefined ? 0 : Math.max(0, (now - start) / 1000)
  const empty = { off: !input.master, turn, elapsed, live: false, rows: [], events: [], counts: { running: 0, done: 0, failed: 0, queued: 0 }, workflow: null, summary: { reason: '', tried: [] }, frame, ahead }
  if (!input.master) return empty
  // The turn's agents, and those of earlier turns that still run (a Workflow's outlive the turn that launched it; a
  // main agent's turn is over when the next starts, whatever its node says); not a call whose agents started (a
  // template's, kept for its later agents).
  const nodes = board.nodes.filter((node) => !(isCallNode(node) && node.state !== 'queued') && (node.turn === turn || (node.turn < turn && node.id !== 'main' && active(node))))
  const main = nodes.find((node) => node.turn === turn && node.id === 'main')
  const log = input.log.filter((entry) => entry.turn === turn && entry.feature !== 'decision-model')
  const mainEntries = log.filter((entry) => agentOf(entry) === 'main')
  // Where a node sits on this turn's time axis: its own turn's start may be earlier.
  const shift = (node: BoardNode) => {
    const own = startOf(node.turn)
    return own === undefined || start === undefined ? 0 : (own - start) / 1000
  }
  const placed = nodes.map((node) => {
    const began = node.t0 + shift(node)
    const from = Math.max(0, began)
    const to = node.state === 'queued' ? null : node.dur !== undefined ? Math.max(from, began + node.dur) : node.state === 'running' ? Math.max(from, elapsed) : from
    // How long a running agent has run: from its own start, which an earlier turn's agent has before this turn's axis begins.
    const ran = Math.max(0, elapsed - began)
    return { node, from, to, ran }
  })
  const others = placed
    .filter(({ node }) => node.id !== 'main')
    .sort((a, b) => Number(a.node.state === 'queued') - Number(b.node.state === 'queued') || Number(isCallNode(a.node)) - Number(isCallNode(b.node)) || a.from - b.from || (a.node.id < b.node.id ? -1 : 1))
  const ordered = [...placed.filter(({ node }) => node.id === 'main'), ...others]
  const isPicked = (node: BoardNode) => input.selected !== null && input.selected.turn === node.turn && input.selected.id === node.id
  const counts = input.isShown('counts')
  const shownChecks = input.isShown('checks')
  const rows: AgentRow[] = ordered.map(({ node, from, to, ran }, i) => ({
    node,
    key: node.id === 'main' ? 0 : main === undefined ? (i + 1 <= 9 ? i + 1 : null) : i <= 9 ? i : null,
    from,
    to,
    status: node.id === 'main' ? mainStatus(node, mainEntries, input) : agentStatus(node, ran, counts, input),
    selected: isPicked(node),
    checks: shownChecks && node.visualChecks !== undefined ? tallyText(node.visualChecks) : '',
  }))
  const agents = nodes.filter((node) => node.id !== 'main')
  const counted = agents.filter((node) => !(isCallNode(node) && node.state === 'queued'))
  const flows = agents.filter((node) => node.workflow !== undefined)
  return {
    off: false,
    turn,
    elapsed,
    live: input.isWorking || nodes.some(active),
    rows,
    events: eventsOf(board, log, nodes, input),
    counts: {
      running: counted.filter((node) => node.state === 'running').length,
      done: counted.filter((node) => node.state === 'done').length,
      failed: counted.filter((node) => node.state === 'failed').length,
      queued: counted.filter((node) => node.state === 'queued').length,
    },
    workflow: flows.length === 0 ? null : { done: flows.filter((node) => node.state === 'done' || node.state === 'failed').length, total: flows.length },
    summary: summaryOf(main, mainEntries, log, input),
    frame,
    ahead,
  }
}

// ---- status cells ---------------------------------------------------------------

/** How a loop's turn ended, in the board's words (`ENDED_WORDS`, a failed loop's `why`), as the band says it. */
const ENDED = new Set<string>(Object.values(ENDED_WORDS))

/**
 * Why an agent runs as the engine made it, in a few words: the failed request's kind (the details are the card's),
 * the board's own reason, else a feature that is off or nothing decided for it.
 */
function notRoutedWhy(node: BoardNode, input: ScreenInput): string {
  if (node.failure !== undefined) return failureWords(node.failure)
  if (node.why !== undefined && node.why !== '') return node.why
  if (node.id === 'main') return input.isOn('main-effort') ? '这一轮没有判断' : '功能已关'
  if (node.kind === 'wf') return input.isOn('workflow-agents') || input.isOn('workflow-labels') ? '照脚本运行' : '功能已关'
  return input.isOn('dispatched-agents') ? '没有判断' : '功能已关'
}

/** The main agent's cell: how its effort was come to (the latest decision about it), or why it is not routed. */
function mainStatus(node: BoardNode, entries: readonly LogEntry[], input: ScreenInput): AgentRow['status'] {
  if (node.locked === true) return { tone: 'run', text: '已锁定' }
  if (!node.routed) return { tone: 'warn', text: `未路由 · ${notRoutedWhy(node, input)}` }
  return { tone: 'muted', text: `已决定 · ${mainReason(entries, input) || '照计划'}` }
}

/** An agent's cell: failed and why, not routed and why, how long it has run (`ran`, seconds) or ran, queued; its failed calls and step-ups after. */
function agentStatus(node: BoardNode, ran: number, showCounts: boolean, input: ScreenInput): AgentRow['status'] {
  const extra = showCounts && node.counts !== undefined ? countsText(node.counts) : ''
  if (node.state === 'failed') return { tone: 'fail', text: node.why !== undefined && ENDED.has(node.why) ? `失败 · ${node.why}` : '失败' }
  if (!node.routed && node.state !== 'queued') return { tone: 'warn', text: `未路由 · ${notRoutedWhy(node, input)}${extra}` }
  if (node.state === 'queued') return { tone: 'muted', text: node.routed || (node.why === undefined && node.failure === undefined) ? '排队' : `排队 · 未路由 · ${notRoutedWhy(node, input)}` }
  if (node.state === 'running') return { tone: 'run', text: `运行 ${mmss(ran)}${extra}` }
  return { tone: 'done', text: `完成 ${mmss(node.dur ?? 0)}${extra}` }
}

/** A loop's counts in a few words: ` · 失败 2 · 拦截 1 · 升模型 1`, the zero ones left out. */
function countsText(counts: NonNullable<BoardNode['counts']>): string {
  return [counts.failed > 0 ? `失败 ${counts.failed}` : '', counts.blocked > 0 ? `拦截 ${counts.blocked}` : '', counts.raised > 0 ? `升模型 ${counts.raised}` : '']
    .filter((part) => part !== '')
    .map((part) => ` · ${part}`)
    .join('')
}

/** How the main agent's effort was come to, from the latest decision that set it this turn (a feature that is off is left out). */
function mainReason(entries: readonly LogEntry[], input: ScreenInput): string {
  for (const entry of [...entries].reverse()) {
    const feature = featureOf(entry.feature)
    if (!input.isOn(feature)) continue
    if (feature === 'main-effort') return traceReason(entry.trace)
  }
  return ''
}

/** What the board calls each floor of a message's decision (decision/message-effort.ts). */
const FLOOR_WORDS: Readonly<Record<string, string>> = {
  ultrathink: 'ultrathink',
  escalate: '要求多想',
  confirm: '确认',
  stakes: '出错代价',
  'cause-unknown': '原因未知',
  'stuck-again': '上一轮卡住',
  'unresolved-count': '未解决次数',
  unsure: '拿不准',
  'model-floor': '模型下限',
}

/** The rule that settled the level, from the rules' own working (never recomputed): the last floor that lifted it, two peaks, else the position. */
function traceReason(trace: readonly RuleStep[] | undefined): string {
  if (trace === undefined) return ''
  const lift = [...trace].reverse().find((one) => one.applied && one.rule in FLOOR_WORDS)
  if (lift !== undefined) return `${FLOOR_WORDS[lift.rule]}：至少 ${String(lift.level)}`
  const peaks = trace.find((one) => one.rule === 'two-peaked')
  if (peaks?.applied === true) return `双峰（${String(peaks.peak)} ${pctText(peaks.p)}），上取一档`
  const unsure = trace.find((one) => one.rule === 'low-confidence')
  if (unsure?.applied === true && typeof unsure.confidence === 'number') return `置信度 ${unsure.confidence.toFixed(2)}，上取一档`
  const position = trace.find((one) => one.rule === 'position')
  return position === undefined || typeof position.position !== 'number' ? '' : `位置 ${position.position.toFixed(1)} → ${String(position.level)}`
}

// ---- events -------------------------------------------------------------------

/** The name a person reads for the agent an entry or a note is about. */
function whoOf(id: string | undefined, nodes: readonly BoardNode[], fallback: string): string {
  if (id === undefined || id === 'main') return '主 agent'
  return nodes.find((node) => node.id === id)?.name ?? fallback
}

/** The Workflow an entry belongs to: its call's tool call id, or its agent's Workflow. */
function workflowOf(entry: LogEntry, nodes: readonly BoardNode[]): { id: string; name: string } | null {
  const agent = agentOf(entry)
  const node = nodes.find((one) => one.id === agent)
  if (node?.workflow !== undefined) return node.workflow
  const id = callWorkflowOf(agent)
  if (id === null) return null
  const name = /（Workflow ([^）]*)）$/.exec(entry.subject)?.[1] ?? 'Workflow'
  return { id, name }
}

/** Whether an entry moved what it is about without being its route: a model step-up. */
function moved(entry: LogEntry): boolean {
  return entry.forced !== undefined
}

function eventsOf(board: Board, log: readonly LogEntry[], nodes: readonly BoardNode[], input: ScreenInput): BandEvent[] {
  const turn = board.turn
  const on = (feature: string) => input.isOn(featureOf(feature))
  const shown = log.filter((entry) => on(entry.feature))
  // Each event with its place: when it happened, then the log's order (a change or a note goes after the entry it followed).
  const placed: { event: BandEvent; order: number }[] = []
  const add = (event: BandEvent, order: number) => placed.push({ event, order })
  let group: { key: string; first: LogEntry; entries: LogEntry[] } | null = null
  const flush = () => {
    if (group === null) return
    const { first, entries } = group
    const flow = workflowOf(first, nodes)
    if (entries.length === 1) add(decidedOf(first, nodes), first.n)
    else {
      const models: Partial<Record<Model, number>> = {}
      for (const entry of entries) if (entry.model !== undefined) models[entry.model] = (models[entry.model] ?? 0) + 1
      add({ at: first.at ?? 0, kind: 'workflow', name: flow?.name ?? 'Workflow', calls: entries.length, models, sentBack: entries.some((entry) => entry.sentBack === true), byLabel: featureOf(first.feature) === 'workflow-labels' }, first.n)
    }
    group = null
  }
  for (const entry of shown) {
    const feature = featureOf(entry.feature)
    const at = entry.at ?? 0
    // The decisions of one Workflow's calls, one after another: one event.
    if (feature === 'workflow-agents' || feature === 'workflow-labels') {
      const flow = workflowOf(entry, nodes)
      const key = `${feature}:${flow?.id ?? entry.n}`
      if (group !== null && group.key === key) group.entries.push(entry)
      else {
        flush()
        group = { key, first: entry, entries: [entry] }
      }
      continue
    }
    flush()
    if (feature === 'main-effort' || feature === 'dispatched-agents') add(decidedOf(entry, nodes), entry.n)
    else if (feature === 'escalation' && entry.forced !== undefined) {
      add({ at, kind: 'raise', who: whoOf(entry.agent, nodes, entry.subject), from: entry.forced.from, to: entry.forced.to, failed: entry.counts?.failed ?? 0, blocked: entry.counts?.blocked ?? 0 }, entry.n)
    } else if (feature === 'skills' && entry.skills !== undefined && (entry.skills.suggest.length > 0 || entry.skills.try.length > 0)) {
      add({ at, kind: 'skills', suggest: entry.skills.suggest, tried: entry.skills.try }, entry.n)
    } else if (feature === 'find-skill') {
      add({ at, kind: 'find', query: entry.subject, found: entry.skills?.suggest ?? [] }, entry.n)
    }
  }
  flush()
  // A reading that changed, unless the decision just before it says so already (a model step-up).
  const changes = (board.changes ?? []).filter((change) => change.turn === turn)
  for (const change of changes) {
    if (explained(change, changes, log)) continue
    add({ at: change.at, kind: 'change', who: whoOf(change.id, nodes, change.id), from: change.from, to: change.to }, change.after + 0.5)
  }
  for (const note of board.notes ?? []) {
    if (note.turn !== turn || !on(note.feature)) continue
    add({ at: note.at, kind: 'note', who: whoOf(note.id, nodes, note.id), feature: featureOf(note.feature), note: note.kind, why: note.why }, note.after + 0.5)
  }
  return placed.sort((a, b) => a.event.at - b.event.at || a.order - b.order).map(({ event }) => event)
}

/** A change a decision logged just before it accounts for: one about the same agent that moved its level, since that agent's previous change. */
function explained(change: ReadingChange, changes: readonly ReadingChange[], log: readonly LogEntry[]): boolean {
  const before = changes.filter((other) => other.id === change.id && other.after < change.after).reduce((latest, other) => Math.max(latest, other.after), 0)
  return log.some((entry) => agentOf(entry) === change.id && entry.n <= change.after && entry.n > before && moved(entry))
}

/** A decision about one agent's route: who, what it got, why in a few words. */
/** How an agent's model was come to, from its rules' own working (decision/dispatched-agent.ts): the table's row, and the main agent's pick kept or raised. */
function agentReason(trace: readonly RuleStep[] | undefined): string {
  const table = trace?.find((one) => one.rule === 'model-table')
  const route = trace?.find((one) => one.rule === 'route')
  const named = trace?.some((one) => one.rule === 'named-model') === true
  if (table === undefined && route === undefined && !named) return ''
  const pick = trace?.find((one) => one.rule === 'main-pick')
  const rules =
    named || table?.row === '1'
      ? '你点名'
      : route !== undefined
        ? route.fellBack === true
          ? `路由拿不准 → ${String(route.wanted)}`
          : `路由 ${String(route.tier)} ${typeof route.p === 'number' ? pctText(route.p) : ''}`.trim()
        : `模型表 ${String(table?.row)}`
  return pick === undefined ? rules : `${rules} · ${pick.outcome === 'upgraded' ? '升级' : '保留'} ${String(pick.requested)}`
}

function decidedOf(entry: LogEntry, nodes: readonly BoardNode[]): BandEvent {
  const main = agentOf(entry) === 'main'
  const level = main ? levelOf(entry) : entry.effort
  return {
    at: entry.at ?? 0,
    kind: 'decided',
    who: main ? '主 agent' : whoOf(entry.agent, nodes, entry.subject),
    main,
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(level === undefined ? {} : { effort: level }),
    reason: main ? traceReason(entry.trace) : agentReason(entry.trace),
    ok: entry.tone !== 'fail' && entry.tone !== 'warn',
  }
}

/**
 * The level a decision ended at, from its own fields (never its words): the effort it decided, else the rules' last
 * step's level (an entry an earlier version wrote).
 */
export function levelOf(entry: LogEntry): Effort | undefined {
  if (entry.effort !== undefined) return entry.effort
  const last = entry.trace?.at(-1)?.level
  return isEffort(last) ? last : undefined
}

// ---- the summary --------------------------------------------------------------

/** A finished turn in a few words: how the main agent's effort was come to (or why not routed), and the skills for the person to try. */
function summaryOf(main: BoardNode | undefined, mainEntries: readonly LogEntry[], log: readonly LogEntry[], input: ScreenInput): ScreenView['summary'] {
  const reason = main === undefined ? '' : main.locked === true ? '已锁定' : !main.routed ? `未路由 · ${notRoutedWhy(main, input)}` : mainReason(mainEntries, input) || '已决定'
  const skills = input.isOn('skills') ? log.filter((entry) => featureOf(entry.feature) === 'skills' && entry.skills !== undefined).at(-1)?.skills : undefined
  return { reason, tried: (skills?.try ?? []).map((skill) => skill.name) }
}
