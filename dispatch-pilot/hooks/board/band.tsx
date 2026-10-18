// The band above the prompt on the terminal (spec #22 「Band」, prototype D):
// while a turn goes, a status strip, one row per agent (the main agent first,
// then each in the order it started: its digit key and name, model chip,
// effort tag, state glyph, time ribbon and status cell) and the turn's event
// stream under them; once the turn is over, one line. Squeezed under four
// rows, one line too. Pure: drawn from a `ScreenView` with the terminal's
// element table; the digit keys' Buttons call `act.select`.
//
// Every surface gets the same band (#31): `bandTree` is given the surface's
// marks, the time ribbons as a Raster on the terminal and as an Svg where there
// is one (Desktop, VS Code, the mobile app); without marks each row is the same
// minus its time ribbon (the name takes the room).
//
// Every row is cut to the band's width (`bodyColumns`): a long name ends in
// `…`, never wraps; the full story is the rationale pane's (#30).

import type { RenderNode } from 'claude-code'
import { EFFORTS, type Effort } from '../decision/effort.ts'
import type { BoardNode, Reading } from '../core/report.ts'
import { ACCENT, BAD, chip, EFFORT_COLOR, effortTag, fit, MODEL_BG, mmss, MUTED, OK, padLeft, pct, readout, SKILL, skillsText, softColor, SPIN, stateGlyph, STATUS_COLOR, TRACK_HEX, WARN, width, type Marks, type TT } from './kit.tsx'
import { FEATURE_WORDS, isWholeWorkflow, type AgentRow, type BandEvent, type ScreenView } from './view.ts'

/** What the band is laid out in: `bodyColumns` and `maxRows` of its props. */
type BandSize = { cols: number; rows: number }

/**
 * What the band's Buttons do: a digit picks an agent for the rationale pane; `fold`, on a surface without a fold of
 * its own (the terminal folds the band itself), folds the band to its one line (`folded`) or opens it again.
 */
type BandActs = { select: (row: AgentRow) => void; fold?: { folded: boolean; set: (folded: boolean) => void } }

/** The most rows the band takes, however tall the engine lets it be (outside fullscreen `maxRows` is the terminal's height). */
const MOST_ROWS = 16
/** Under this many rows the band is one line (an inline pane took the room). */
const SQUEEZED = 4
/** From this many columns the hint is spelled out at the end of a line. */
const WIDE = 100
/** Where to read the rest. */
const HINT = '/dp log 看依据'

/** The band's tree (`marks`: the surface's, for the time ribbons; none, none drawn), or null when there is nothing of Dispatch Pilot's to show (switched off, no turn yet). */
export function bandTree(t: TT, view: ScreenView, size: BandSize, act: BandActs, marks?: Marks): RenderNode | null {
  if (view.off || view.turn === 0 || (view.rows.length === 0 && !view.live)) return null
  if (!view.live) return idleLine(t, view, size.cols)
  if (size.rows < SQUEEZED || act.fold?.folded === true) return squeezedLine(t, view, size.cols, act.fold)
  return liveBand(t, view, size, act, marks)
}

// ---- one line ---------------------------------------------------------------------

/** An agent's `opus·xhigh`, as it went out (the effort an integer budget has no colour of its own). */
function nodeReadout(t: TT, node: BoardNode) {
  return readout(t, node.model, node.effort, typeof node.effort === 'string' ? node.effort : undefined, node.routed)
}

/** How many agents the view counts. */
function agentCount(view: ScreenView): number {
  return view.counts.running + view.counts.done + view.counts.failed + view.counts.queued
}

/** The agents in a few glyphs: ⠏3 running, ✔2 done, ✘1 failed, ○1 waiting. */
function tally(t: TT, view: ScreenView) {
  const { Text } = t
  const { running, done, failed, queued } = view.counts
  const parts = [
    running > 0 ? <Text color={ACCENT} bold>{`${SPIN[view.frame]}${running}`}</Text> : null,
    done > 0 ? <Text color={OK}>{`✔${done}`}</Text> : null,
    failed > 0 ? <Text color={BAD} bold>{`✘${failed}`}</Text> : null,
    queued > 0 ? <Text color={MUTED}>{`○${queued}`}</Text> : null,
  ].filter((part) => part !== null)
  // Glyphs and counts that change by themselves: one width each, so the line does not jitter on a proportional face.
  return <Text mono>{parts.flatMap((part, i) => (i === 0 ? [part] : [<Text> </Text>, part]))}</Text>
}

/** A finished turn: the main agent's model and effort, how it came to them, the agents, the skills for the person to try. */
function idleLine(t: TT, view: ScreenView, cols: number) {
  const { Box, Text } = t
  const main = view.rows.find((row) => row.node.id === 'main')?.node
  const agents = agentCount(view)
  const routed = main?.routed !== false
  return (
    <Box key="band-idle" width={cols}>
      <Text wrap="truncate-end">
        <Text color={routed ? ACCENT : WARN} bold>◆ </Text>
        <Text bold>{`第 ${view.turn} 轮`}</Text>
        {main?.dur === undefined ? null : <Text color={MUTED} tabular>{` ${mmss(main.dur)}`}</Text>}
        {main === undefined ? null : (
          <Text>
            <Text color={MUTED}>{' · 主 agent '}</Text>
            {nodeReadout(t, main)}
          </Text>
        )}
        {view.summary.reason === '' ? null : <Text color={routed ? MUTED : WARN}>{` · ${view.summary.reason}`}</Text>}
        {view.summary.tried.length === 0 ? null : <Text color={SKILL} bold>{` · 可试 ${view.summary.tried.map((name) => `/${name}`).join(' ')}`}</Text>}
        {agents === 0 ? null : (
          <Text>
            <Text color={MUTED}>{` · ${agents} 个 agent `}</Text>
            {tally(t, view)}
          </Text>
        )}
        {cols >= WIDE ? <Text color={MUTED}>{` · ${HINT}`}</Text> : null}
      </Text>
    </Box>
  )
}

/** The fold's button: 收起 on the full band, 展开 on its one line. */
function foldButton(t: TT, fold: NonNullable<BandActs['fold']>) {
  const { Box, Button } = t
  return (
    <Box key="band-fold" flexShrink={0}>
      <Button key="band-fold-button" label={fold.folded ? '▸ 展开' : '▾ 收起'} plain dimColor onPress={() => fold.set(!fold.folded)} />
    </Box>
  )
}

/** A turn going, with no room or folded: the strip and the main agent's readout on one line (and 展开, when the person folded it). */
function squeezedLine(t: TT, view: ScreenView, cols: number, fold?: BandActs['fold']) {
  const { Box, Text } = t
  const main = view.rows.find((row) => row.node.id === 'main')
  return (
    <Box key="band-squeezed" width={cols}>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">
          <Text color={ACCENT} bold>◆ </Text>
          <Text bold>{`第 ${view.turn} 轮`}</Text>
          <Text color={MUTED} tabular>{` ${mmss(view.elapsed)}`}</Text>
          {main === undefined ? null : (
            <Text>
              <Text color={MUTED}>{' · 主 agent '}</Text>
              {nodeReadout(t, main.node)}
              <Text color={STATUS_COLOR[main.status.tone]}>{` ${main.status.text}`}</Text>
            </Text>
          )}
          <Text color={MUTED}>{' · agent '}</Text>
          {tally(t, view)}
          <Text color={MUTED}>{` · ${HINT}`}</Text>
        </Text>
      </Box>
      {fold?.folded === true ? foldButton(t, fold) : null}
    </Box>
  )
}

/**
 * The band in one line of words, for the status line under the prompt where the band is not drawn (status-line.ts):
 * the turn, the main agent's model·effort, how it came to them and the skills to try once the turn is over, the agents
 * by state. Undefined when the band would show nothing (no turn yet); `dp 已关` while switched off.
 */
export function statusText(view: ScreenView): string | undefined {
  if (view.off) return 'dp 已关'
  if (view.turn === 0) return undefined
  const main = view.rows.find((row) => row.node.id === 'main')?.node
  const reading = main === undefined ? '' : [main.model, main.effort === undefined ? undefined : String(main.effort)].filter((part) => part !== undefined).join('·')
  const { running, done, failed, queued } = view.counts
  const agents = [running > 0 ? `运行 ${running}` : '', done > 0 ? `完成 ${done}` : '', failed > 0 ? `失败 ${failed}` : '', queued > 0 ? `排队 ${queued}` : ''].filter((part) => part !== '')
  return [
    `第 ${view.turn} 轮${view.live ? '' : '结束'}`,
    reading === '' ? '' : `主 agent ${reading}${main?.routed === false ? '（未路由）' : ''}`,
    view.live ? '' : view.summary.reason,
    view.live || view.summary.tried.length === 0 ? '' : `可试 ${view.summary.tried.map((name) => `/${name}`).join(' ')}`,
    agents.length === 0 ? '' : `agent ${agents.join(' ')}`,
  ]
    .filter((part) => part !== '')
    .join(' · ')
}

// ---- the full band -------------------------------------------------------------------

/**
 * The columns of an agent row for the band's width: the status cell and the effort narrow first, then the ribbon
 * goes (under six cells it says nothing), so a row never wraps.
 */
function columnsOf(cols: number, ribbons: boolean, checks = 0) {
  const status = cols >= 140 ? 30 : cols >= 110 ? 26 : cols >= 80 ? 22 : cols >= 70 ? 16 : 10
  // The effort's pips and word (12), or under 70 columns its pips alone.
  const effort = cols >= 70 ? 12 : 5
  // marker 1, glyph 2, chip 8+1, effort and a space, a space before the status cell
  const fixed = 1 + 2 + 9 + effort + 1 + 1
  // The count of a row's checks (a cell after the status, its widest) takes what the name can spare; the name keeps its ten.
  const counted = checks === 0 ? 0 : Math.min(checks + 1, Math.max(0, cols - fixed - status - 10))
  const left = Math.max(0, cols - fixed - status - counted)
  // Narrow, the name keeps half of what is left: it says who the row is.
  const name = Math.max(10, Math.min(32, Math.round(left * (cols >= 110 ? 0.4 : 0.5))))
  const ribbon = ribbons && left - name >= 6 ? Math.min(48, left - name) : 0
  return { status, effort, name: ribbon === 0 ? Math.max(8, left) : name, ribbon, checks: counted }
}

function liveBand(t: TT, view: ScreenView, size: BandSize, act: BandActs, marks: Marks | undefined) {
  const { Box, Text } = t
  const budget = Math.min(size.rows, MOST_ROWS)
  const wanted = Math.min(view.events.length, 2)
  // Rows for the agents (the strip takes one), leaving the latest events two; a fold line says what is left out.
  let shownRows = view.rows
  let hiddenRows: AgentRow[] = []
  const room = Math.max(1, budget - 1 - wanted)
  if (view.rows.length > room) {
    const keep = new Set(pickRows(view.rows, Math.max(1, room - 1)))
    shownRows = view.rows.filter((row) => keep.has(row))
    hiddenRows = view.rows.filter((row) => !keep.has(row))
  }
  const used = 1 + shownRows.length + (hiddenRows.length > 0 ? 1 : 0)
  const eventRoom = Math.max(0, budget - used)
  const hiddenEvents = view.events.length > eventRoom ? view.events.length - Math.max(0, eventRoom - 1) : 0
  const shownEvents = hiddenEvents > 0 ? view.events.slice(view.events.length - Math.max(0, eventRoom - 1)) : view.events
  const cols = columnsOf(size.cols, marks !== undefined, Math.max(0, ...shownRows.map((row) => width(row.checks))))
  // Every agent's ribbon has the same span, so bars that overlap ran side by side.
  const span = Math.max(view.elapsed, ...view.rows.map((one) => one.to ?? one.from), 1)
  return (
    <Box key="band" flexDirection="column" width={size.cols}>
      {strip(t, view, size.cols, act.fold)}
      {shownRows.map((row, i) => agentRow(t, view, row, i, cols, span, act, marks))}
      {hiddenRows.length > 0 ? (
        <Box key="band-more-agents">
          <Text color={MUTED} wrap="truncate-end">{`   ┊ 另有 ${hiddenRows.length} 个 agent：${foldTally(hiddenRows)} · ${HINT}`}</Text>
        </Box>
      ) : null}
      {hiddenEvents > 0 && eventRoom > 0 ? (
        <Box key="band-more-events">
          <Text color={MUTED} wrap="truncate-end">{`      ┊ 更早 ${hiddenEvents} 个事件 · ${HINT}`}</Text>
        </Box>
      ) : null}
      {eventRoom > 0 ? shownEvents.map((event, i) => eventRow(t, event, i, shownEvents.length, hiddenEvents > 0, size.cols)) : null}
    </Box>
  )
}

/**
 * The rows to keep when not all fit: the main agent, then the running, the failed, the waiting, the done (the
 * latest first); the running in the order they started, so their digit keys stay in view. Shown in their order.
 */
function pickRows(rows: readonly AgentRow[], count: number): AgentRow[] {
  const rank = (row: AgentRow) => (row.node.id === 'main' ? 0 : row.node.state === 'running' ? 1 : row.node.state === 'failed' ? 2 : row.node.state === 'queued' ? 3 : 4)
  return [...rows].sort((a, b) => rank(a) - rank(b) || (rank(a) === 1 ? a.from - b.from : b.from - a.from)).slice(0, count)
}

function foldTally(rows: readonly AgentRow[]): string {
  const of = (state: string) => rows.filter((row) => row.node.state === state).length
  return [of('running') > 0 ? `运行 ${of('running')}` : '', of('done') > 0 ? `完成 ${of('done')}` : '', of('failed') > 0 ? `失败 ${of('failed')}` : '', of('queued') > 0 ? `排队 ${of('queued')}` : '']
    .filter((part) => part !== '')
    .join(' ')
}

/** The strip: the turn and its time, the agents' tally, the Workflow's progress, the mid-turn re-decisions; the hint at the right, and the fold's button where the band has one. */
function strip(t: TT, view: ScreenView, cols: number, fold?: BandActs['fold']) {
  const { Box, Text } = t
  const sep = <Text color={MUTED}>{'  ▏ '}</Text>
  const agents = agentCount(view)
  return (
    <Box key="band-strip" width={cols} justifyContent="space-between">
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text color={ACCENT} bold>◆ </Text>
          <Text bold>{`第 ${view.turn} 轮`}</Text>
          <Text color={MUTED} tabular>{` ${mmss(view.elapsed)}`}</Text>
          {agents === 0 ? null : (
            <Text>
              {sep}
              <Text color={MUTED}>{'agent '}</Text>
              {tally(t, view)}
            </Text>
          )}
          {view.workflow === null ? null : (
            <Text>
              {sep}
              <Text color={MUTED}>{'Workflow '}</Text>
              <Text bold tabular>{String(view.workflow.done)}</Text>
              <Text color={MUTED} tabular>{`/${view.workflow.total}`}</Text>
            </Text>
          )}
          {view.midturn === null ? null : (
            <Text>
              {sep}
              <Text color={MUTED}>{`中途重判 ${view.midturn.judged} 次 · 改档 ${view.midturn.changed}`}</Text>
            </Text>
          )}
        </Text>
      </Box>
      {cols >= WIDE ? (
        <Box flexShrink={0}>
          <Text color={MUTED}>{`  0-9 选中 · ${HINT}${fold === undefined ? '' : '  '}`}</Text>
        </Box>
      ) : null}
      {fold === undefined ? null : foldButton(t, fold)}
    </Box>
  )
}

/** The bar's colour on the ribbon: the effort's (a finished agent's softened), a softened red for a failed one, the model's tint for one without effort. */
function barColor(row: AgentRow): string {
  const { node } = row
  if (node.state === 'failed') return softColor(EFFORT_COLOR.max)
  const base = typeof node.effort === 'string' ? EFFORT_COLOR[node.effort] : node.model !== undefined ? MODEL_BG[node.model] : TRACK_HEX
  return node.state === 'done' ? softColor(base) : base
}

/** One agent: marker, glyph, its digit and name, model chip, effort tag, time ribbon over `span` seconds, status cell. */
function agentRow(t: TT, view: ScreenView, row: AgentRow, i: number, cols: ReturnType<typeof columnsOf>, span: number, act: BandActs, marks: Marks | undefined) {
  const { Box, Button, Text } = t
  const { node } = row
  const whole = isWholeWorkflow(node)
  const done = node.state === 'done' && !row.selected
  return (
    <Box key={`band-agent-${i}`}>
      <Box width={1} flexShrink={0}>
        <Text color={ACCENT} bold>{row.selected ? '▌' : ' '}</Text>
      </Box>
      <Box width={2} flexShrink={0}>{whole ? <Text color={WARN}>◈</Text> : stateGlyph(t, node.state, view.frame, node.routed)}</Box>
      <Box width={cols.name} flexShrink={0}>
        {row.key === null ? (
          <Text bold={node.state === 'running'} dimColor={done} wrap="truncate-end">{`   ${fit(node.name, cols.name - 4)}`}</Text>
        ) : (
          <Button key={`band-pick-${row.key}`} label={fit(node.name, cols.name - 4)} hotkey={String(row.key)} plain dimColor={done} onPress={() => act.select(row)} />
        )}
      </Box>
      <Box width={9} flexShrink={0}>{chip(t, node.model, node.routed)}</Box>
      <Box width={cols.effort + 1} flexShrink={0}>{effortTag(t, node.effort, cols.effort)}</Box>
      {cols.ribbon === 0 || marks === undefined ? null : (
        <Box width={cols.ribbon + 1} flexShrink={0} alignItems="center">
          {whole ? <Text> </Text> : marks.ribbon(`band-ribbon-${i}`, { from: row.from, to: row.to, span, color: barColor(row) }, cols.ribbon)}
        </Box>
      )}
      <Box width={cols.status} flexShrink={0}>
        <Text color={STATUS_COLOR[row.status.tone]} tabular wrap="truncate-end">{row.status.text}</Text>
      </Box>
      {cols.checks === 0 ? null : (
        <Box width={cols.checks} flexShrink={0}>
          <Text color={MUTED} tabular wrap="truncate-end">{row.checks === '' ? '' : ` ${row.checks}`}</Text>
        </Box>
      )}
    </Box>
  )
}

// ---- events ------------------------------------------------------------------

const SKIPPED: Record<string, string> = {
  unanswered: '回答里没有这一题',
  unread: '读不到会话的 skill',
  none: '没有可评分的 skill',
  error: '出错了，见 debug log',
}

function effortWord(t: TT, effort: Effort) {
  const { Text } = t
  return <Text color={EFFORT_COLOR[effort]} bold>{effort}</Text>
}

function readingText(reading: Reading): string {
  return [reading.model, reading.effort === undefined ? undefined : String(reading.effort)].filter((part) => part !== undefined).join('·')
}

/** An event's glyph, tag and body. */
function eventParts(t: TT, event: BandEvent): { glyph: RenderNode; tag: string; tagColor: string; body: RenderNode } {
  const { Text } = t
  const muted = (text: string) => <Text color={MUTED}>{text}</Text>
  switch (event.kind) {
    case 'decided':
      return {
        glyph: <Text color={event.ok ? ACCENT : WARN}>◆</Text>,
        tag: '决定',
        tagColor: MUTED,
        body: (
          <Text wrap="truncate-end">
            <Text bold={event.main}>{event.who}</Text>
            {muted(' → ')}
            {readout(t, event.model, event.effort, event.effort, true)}
            {event.reason === '' ? null : muted(`  ${event.reason}`)}
          </Text>
        ),
      }
    case 'workflow': {
      const models = Object.entries(event.models).map(([model, n]) => `${model}×${n}`).join(' ')
      return {
        glyph: <Text color={ACCENT}>◈</Text>,
        tag: '决定',
        tagColor: MUTED,
        body: (
          <Text wrap="truncate-end">
            <Text bold>{`Workflow ${event.name}`}</Text>
            {muted(` · ${event.byLabel ? '按 label ' : ''}${event.calls} 个 agent()${models === '' ? '' : `：${models}`}${event.sentBack ? ' · 退回主 agent 写入' : ''}`)}
          </Text>
        ),
      }
    }
    case 'midturn': {
      const up = EFFORTS.indexOf(event.to) > EFFORTS.indexOf(event.from)
      return {
        glyph: <Text color={EFFORT_COLOR[event.to]} bold>{up ? '↑' : '↓'}</Text>,
        tag: '重判',
        tagColor: MUTED,
        body: (
          <Text wrap="truncate-end">
            {event.who}
            {muted(' ')}
            {effortWord(t, event.from)}
            {muted(' → ')}
            {effortWord(t, event.to)}
            {event.conf === undefined ? null : <Text color={MUTED} tabular>{`  置信 ${pct(event.conf)}${event.threshold === undefined ? '' : ` ≥ ${pct(event.threshold)}`}`}</Text>}
          </Text>
        ),
      }
    }
    case 'raise':
      return {
        glyph: <Text color={WARN} bold>↑</Text>,
        tag: '升档',
        tagColor: WARN,
        body: (
          <Text color={WARN} wrap="truncate-end">
            {`${event.who}  ${event.from} → ${event.to}`}
            <Text color={MUTED}>{`  工具调用失败 ${event.failed}${event.blocked > 0 ? ` · 拦截 ${event.blocked}` : ''}`}</Text>
          </Text>
        ),
      }
    case 'change':
      return {
        glyph: <Text color={MUTED}>⇄</Text>,
        tag: '改档',
        tagColor: MUTED,
        body: (
          <Text wrap="truncate-end">
            {event.who}
            {muted(`  ${readingText(event.from)} → `)}
            <Text bold>{readingText(event.to)}</Text>
          </Text>
        ),
      }
    case 'skills':
      return {
        glyph: <Text color={SKILL}>⚑</Text>,
        tag: '推荐',
        tagColor: MUTED,
        body: (
          <Text wrap="truncate-end">{skillsText(t, { suggest: event.suggest, try: event.tried })}</Text>
        ),
      }
    case 'find':
      return {
        glyph: <Text color={SKILL}>⌕</Text>,
        tag: '查询',
        tagColor: MUTED,
        body: (
          <Text wrap="truncate-end">
            {muted(`find_skill ${event.query} → `)}
            {event.found.length === 0 ? muted('没有合适的 skill') : event.found.map((skill) => `${skill.name} ${pct(skill.relevance)}`).join(' · ')}
          </Text>
        ),
      }
    case 'note': {
      const what = FEATURE_WORDS[event.feature] ?? event.feature
      if (event.note === 'late') {
        return { glyph: <Text color={WARN}>◷</Text>, tag: '迟到', tagColor: WARN, body: <Text color={WARN} wrap="truncate-end">{`${event.who} · ${what}的回答没赶上这一步，沿用原来的档`}</Text> }
      }
      if (event.note === 'skipped') {
        return { glyph: <Text color={MUTED}>·</Text>, tag: '跳过', tagColor: MUTED, body: <Text color={MUTED} wrap="truncate-end">{`${what} · ${SKIPPED[event.why] ?? event.why}`}</Text> }
      }
      return { glyph: <Text color={BAD} bold>✘</Text>, tag: '失败', tagColor: BAD, body: <Text color={BAD} wrap="truncate-end">{`${what}失败 · ${event.why}`}</Text> }
    }
  }
}

/** One event: when (m:ss from the turn's start), the rail, its glyph and tag, what happened. */
function eventRow(t: TT, event: BandEvent, i: number, count: number, folded: boolean, cols: number) {
  const { Box, Text } = t
  const rail = i === count - 1 ? '└' : i === 0 && !folded ? '┬' : '├'
  const parts = eventParts(t, event)
  return (
    <Box key={`band-event-${i}`} width={cols}>
      <Box width={6} flexShrink={0}>
        <Text color={MUTED} mono>{padLeft(mmss(event.at), 5)}</Text>
      </Box>
      <Box width={2} flexShrink={0}>
        <Text color={MUTED} mono>{rail}</Text>
      </Box>
      <Box width={2} flexShrink={0}>{parts.glyph}</Box>
      <Box width={5} flexShrink={0}>
        <Text color={parts.tagColor}>{parts.tag}</Text>
      </Box>
      <Box flexShrink={1}>{parts.body}</Box>
    </Box>
  )
}
