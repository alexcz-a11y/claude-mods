// The rationale pane on the terminal (spec #22 「依据面板」, prototype D): at
// its top, what is switched off, the lock and how the skill profiles went (in
// grey); ‹ 上一个 (p) / 下一个 › (n); the rounded card of the agent picked (its
// state and why not routed, the model it was given and why, the effort
// probabilities, the rules' working step by step, the result, the main agent's
// confidence note, its forced raises and mid-turn re-decisions with a
// confidence meter); then the decision log grouped by turn, folded with a
// letter key. Pure: drawn from `rationale.ts`'s view of the data with the
// terminal's element table; the Buttons call `act`.
//
// Nothing is cut: a long name, a reason or a subject wraps under its own
// column (a hanging indent: the label column has a fixed width, the text goes
// on beneath the content column), so the docked pane of about 75 columns
// keeps every word. Only the short rows (a rule's step, the meter) stay one
// line when they fit; the bars narrow with the pane.

import type { RenderNode } from 'claude-code'
import type { Effort } from '../decision/effort.ts'
import { EFFORTS } from '../decision/effort.ts'
import { failureWords, type LogEntry, type ProfilesState, type Tone as LogTone } from '../core/report.ts'
import { ACCENT, BAD, chip, EFFORT_COLOR, effortTag, meterCells, MODEL_BG, MUTED, OK, pct, SKILL, softColor, stackCells, stateGlyph, WARN, width, type T } from './kit.tsx'
import {
  cardOf,
  entryVerb,
  FAILURES_KEY,
  FEATURE_WORDS,
  featureOf,
  levelOf,
  logGroups,
  midVerdict,
  offLine,
  pageTo,
  profilesLine,
  stepLines,
  verdictWords,
  type Card,
  type LogGroup,
  type PaneState,
  type StepMark,
} from './rationale.ts'
import type { AgentRow, ScreenView, Tone } from './view.ts'

/** What the pane is drawn from. */
export type PaneInput = {
  view: ScreenView
  log: readonly LogEntry[]
  /** How the session's skill profiles went; null when there is no record, or the skills or skill-profiles switch is off. */
  profiles: ProfilesState | null
  /** The features switched off, by switch name. */
  off: readonly string[]
  master: boolean
  /** The person's lock on the main agent's effort. */
  lock: Effort | null
  state: PaneState
}

/** What the pane's Buttons do: pick another agent's card, fold or open a turn of the log, list the failed skills. */
export type PaneActs = {
  pick: (row: AgentRow) => void
  fold: (turn: number, open: boolean) => void
  failures: (open: boolean) => void
}

const TONE_COLOR: Record<Tone, string> = { run: ACCENT, done: MUTED, fail: BAD, warn: WARN, muted: MUTED }
const LOG_COLOR: Record<LogTone, string> = { ok: OK, warn: WARN, fail: BAD, info: MUTED }
const LOG_GLYPH: Record<LogTone, string> = { ok: '✔', warn: '⚠', fail: '✘', info: '·' }
const MARK: Record<StepMark, { glyph: string; color: string }> = {
  hit: { glyph: '●', color: ACCENT },
  pass: { glyph: '○', color: MUTED },
  lift: { glyph: '▲', color: OK },
  raise: { glyph: '↑', color: WARN },
}

/** The label column of the card's rows. */
const LABEL = 8
/** The column a mid-turn re-decision's number takes. */
const NUMBER = 6

export function paneTree(t: T, input: PaneInput, cols: number, act: PaneActs) {
  const { Box, Button, Text } = t
  const { view } = input
  const card = cardOf(view, input.log)
  const prev = pageTo(card, view, -1)
  const next = pageTo(card, view, 1)
  const blank = (key: string) => (
    <Box key={key}>
      <Text> </Text>
    </Box>
  )
  return (
    <Box key="pane" flexDirection="column" width={cols}>
      <Box key="pane-head" width={cols}>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="wrap">
            <Text color={ACCENT} bold>◆ 依据</Text>
            {card.row === null ? null : <Text color={MUTED}>{' · '}</Text>}
            {card.row === null ? null : <Text bold>{card.row.node.name}</Text>}
          </Text>
        </Box>
        {card.count === 0 ? null : (
          <Box flexShrink={0}>
            <Text color={MUTED}>{`  ${card.index + 1}/${card.count}`}</Text>
          </Box>
        )}
      </Box>
      {topLines(t, input, cols, act)}
      <Box key="pane-nav" width={cols}>
        <Box flexShrink={0}>
          <Button key="pane-prev" label="‹ 上一个 (p)" hotkey="p" onPress={() => (prev === null ? undefined : act.pick(prev))} />
        </Box>
        <Box flexShrink={0}>
          <Text> </Text>
        </Box>
        <Box flexShrink={0}>
          <Button key="pane-next" label="下一个 › (n)" hotkey="n" variant="primary" onPress={() => (next === null ? undefined : act.pick(next))} />
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={MUTED} wrap="wrap">{'  band 上按 0-9 直接选'}</Text>
        </Box>
      </Box>
      <Box key="pane-card" flexDirection="column" width={cols} borderStyle="round" borderColor={MUTED} paddingX={1}>
        {cardRows(t, card, input, Math.max(10, cols - 4))}
      </Box>
      {blank('pane-gap')}
      {logRows(t, input, cols, act)}
    </Box>
  )
}

// ---- the lines at the top ------------------------------------------------------------

function topLines(t: T, input: PaneInput, cols: number, act: PaneActs): RenderNode[] {
  const { Box, Button, Text } = t
  const rows: RenderNode[] = []
  const off = offLine(input.master, input.off)
  if (off !== null) {
    rows.push(
      <Box key="pane-off" width={cols}>
        <Text color={MUTED} wrap="wrap">{off}</Text>
      </Box>,
    )
  }
  if (input.master && input.lock !== null) {
    rows.push(
      <Box key="pane-lock" width={cols}>
        <Text color={MUTED} wrap="wrap">{`主 agent 锁在 ${input.lock}：每一步都用它，决定照常记下（/dp unlock 解除）`}</Text>
      </Box>,
    )
  }
  const profiles = input.profiles
  if (profiles !== null) {
    const line = profilesLine(profiles)
    const open = input.state.failures
    rows.push(
      <Box key="pane-profiles" width={cols}>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={line.tone === 'fail' ? BAD : line.tone === 'warn' ? WARN : MUTED} wrap="wrap">{line.text}</Text>
        </Box>
        {profiles.failed === 0 ? null : (
          <Box flexShrink={0}>
            <Text> </Text>
            <Button key="pane-profile-failures" label={open ? '▾ 收起失败的 skill' : '▸ 看失败的 skill'} hotkey={FAILURES_KEY} plain dimColor onPress={() => act.failures(!open)} />
          </Box>
        )}
      </Box>,
    )
    if (open) {
      profiles.failures.forEach((failure, i) => {
        rows.push(
          <Box key={`pane-profile-failure-${i}`} width={cols}>
            <Box width={4} flexShrink={0}>
              <Text color={WARN}>{'  ✘'}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="wrap">
                <Text bold>{failure.name}</Text>
                <Text color={MUTED}>{`  ${failure.reason}`}</Text>
              </Text>
            </Box>
          </Box>,
        )
      })
      const unnamed = profiles.failed - profiles.failures.length
      if (unnamed > 0) {
        rows.push(
          <Box key="pane-profile-failure-more" width={cols}>
            <Text color={MUTED} wrap="wrap">{`    另有 ${unnamed} 个没有记下名字`}</Text>
          </Box>,
        )
      }
    }
  }
  return rows
}

// ---- the card ----------------------------------------------------------------------

/** A row with a hanging indent: the label in its fixed column, the content wrapping beneath its own column. */
function hang(t: T, key: string, label: string, content: RenderNode, w: number, labelWidth = LABEL) {
  const { Box, Text } = t
  return (
    <Box key={key} width={w}>
      <Box width={labelWidth} flexShrink={0}>
        <Text color={MUTED}>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        {content}
      </Box>
    </Box>
  )
}

/** The words of a not-routed reason's kind, and where its details are. */
const FAILURE_KINDS: Record<string, string> = {
  config: '没配好，或 key 被拒绝',
  timeout: '超时',
  network: '连不上',
  busy: '繁忙',
  quota: '额度用完',
  http: 'HTTP 出错',
  parse: '回答读不懂',
  request: '请求本身出错',
}

function cardRows(t: T, card: Card, input: PaneInput, w: number): RenderNode[] {
  const { Box, Text } = t
  const row = card.row
  if (row === null) {
    return [
      <Box key="pane-card-empty" width={w}>
        <Text color={MUTED} wrap="wrap">{input.master ? '还没有 agent：发一条消息后，这里写主 agent 的依据' : 'Dispatch Pilot 已关，没有依据可看'}</Text>
      </Box>,
    ]
  }
  const { node } = row
  const main = node.id === 'main'
  const text = (value: string, color?: string) => (
    <Text color={color} wrap="wrap">
      {value}
    </Text>
  )
  const rows: RenderNode[] = [
    <Box key="pane-card-head" width={w}>
      <Box width={2} flexShrink={0}>
        {main ? <Text color={node.routed ? ACCENT : WARN}>◆</Text> : stateGlyph(t, node.state, input.view.frame, node.routed)}
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text bold wrap="wrap">{node.name}</Text>
      </Box>
      <Box width={9} flexShrink={0}>
        <Text> </Text>
        {chip(t, node.model, node.routed)}
      </Box>
      <Box width={13} flexShrink={0}>
        <Text> </Text>
        {effortTag(t, node.effort, 12)}
      </Box>
    </Box>,
    hang(t, 'pane-card-state', '状态', text(row.status.text, TONE_COLOR[row.status.tone]), w),
  ]
  if (node.failure !== undefined) {
    rows.push(hang(t, 'pane-card-failure', '原因', text(`${failureWords(node.failure)}（${FAILURE_KINDS[node.failure.kind] ?? node.failure.kind}）`, WARN), w))
    rows.push(hang(t, 'pane-card-backend', '后端', text(node.failure.backend), w))
    rows.push(hang(t, 'pane-card-detail', '细节', text(node.why ?? node.failure.detail), w))
    rows.push(hang(t, 'pane-card-where', '排查', text('debug log（claude --debug-file <路径>）里有这次请求的那一行，写着它发了什么、等了多久、怎么失败的', MUTED), w))
  } else if (!node.routed && node.why !== undefined && node.why !== '' && node.state !== 'failed') {
    rows.push(hang(t, 'pane-card-why', '原因', text(node.why, WARN), w))
  }
  if (node.locked === true) rows.push(hang(t, 'pane-card-lock', '锁定', text('照 /dp lock 发出这一档；决定照常记下，不影响发出的 effort（/dp unlock 解除）', MUTED), w))
  const route = card.route
  if (route !== undefined) rows.push(...decisionRows(t, route, main, w))
  for (const raise of card.raises) {
    rows.push(
      <Box key={`pane-raise-gap-${raise.n}`}>
        <Text> </Text>
      </Box>,
    )
    rows.push(hang(t, `pane-raise-${raise.n}`, '强制升档', text(`#${raise.n} ${raise.subject}${raise.counts === undefined ? '' : `：工具调用失败 ${raise.counts.failed}${raise.counts.blocked > 0 ? ` · 被 hook 拦下 ${raise.counts.blocked}` : ''} · 第 ${raise.counts.raised} 次升档`}`, WARN), w, 10))
    rows.push(...traceRows(t, `pane-raise-${raise.n}`, raise.trace ?? [], w))
    const level = levelOf(raise)
    if (level !== undefined) rows.push(hang(t, `pane-raise-${raise.n}-result`, '结果', effortTag(t, level, 12), w))
  }
  if (card.mids.length > 0) {
    const counted = node.midturn
    rows.push(
      <Box key="pane-mid-gap">
        <Text> </Text>
      </Box>,
    )
    rows.push(
      <Box key="pane-mid-head" width={w}>
        <Text wrap="wrap">
          <Text color={ACCENT} bold>中途重判</Text>
          {counted === undefined ? null : <Text color={MUTED}>{`  本轮重判 ${counted.judged} 次 · 改档 ${counted.changed} 次`}</Text>}
        </Text>
      </Box>,
    )
    for (const entry of card.mids) {
      const mid = midRow(t, entry, w)
      if (mid !== null) rows.push(mid)
    }
  }
  return rows
}

/** A decision's rows on the card: the model it gave and why (an agent's), the effort's probabilities, the rules' working, the result. */
function decisionRows(t: T, entry: LogEntry, main: boolean, w: number): RenderNode[] {
  const { Text } = t
  const rows: RenderNode[] = []
  if (!main && entry.model !== undefined) {
    rows.push(
      hang(
        t,
        'pane-card-model',
        '模型',
        <Text wrap="wrap">
          <Text color={MODEL_BG[entry.model]} bold>{entry.model}</Text>
          {entry.conf === undefined ? null : <Text color={MUTED}>{`  置信 ${pct(entry.conf)}`}</Text>}
        </Text>,
        w,
      ),
    )
  }
  if (!main) rows.push(hang(t, 'pane-card-reason', '理由', <Text color={MUTED} wrap="wrap">{entry.reason}</Text>, w))
  const level = levelOf(entry)
  if (entry.probs !== undefined) rows.push(hang(t, 'pane-card-probs', 'effort', probsLine(t, 'pane-card-probs-bar', entry.probs, level, w - LABEL), w))
  rows.push(...traceRows(t, 'pane-card-step', entry.trace ?? [], w))
  if (level !== undefined) rows.push(hang(t, 'pane-card-result', '结果', effortTag(t, level, 12), w))
  if (main && entry.conf !== undefined) rows.push(hang(t, 'pane-card-conf', '置信', <Text color={MUTED} wrap="wrap">{`${pct(entry.conf)}：发消息时只记录，不参与选档`}</Text>, w))
  return rows
}

/** The rules' working, one row a step: the rail, its mark, the rule, what it did (wrapping under its own column). */
function traceRows(t: T, key: string, trace: LogEntry['trace'] & object, w: number): RenderNode[] {
  const { Box, Text } = t
  const lines = stepLines(trace)
  return lines.map((line, i) => {
    const mark = MARK[line.mark]
    const pass = line.mark === 'pass'
    return (
      <Box key={`${key}-${i}`} width={w}>
        <Box width={4} flexShrink={0}>
          <Text color={MUTED}>{i === lines.length - 1 ? '  └ ' : '  ├ '}</Text>
        </Box>
        <Box width={2} flexShrink={0}>
          <Text color={mark.color} bold>{mark.glyph}</Text>
        </Box>
        <Box width={Math.max(10, width(line.head) + 2)} flexShrink={0}>
          <Text color={pass ? MUTED : undefined} bold={!pass}>{line.head}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={pass ? MUTED : undefined} wrap="wrap">{line.body}</Text>
        </Box>
      </Box>
    )
  })
}

/** The effort probabilities: a stacked bar (narrower in a narrow pane) and each level's share, the decided level bold in its colour. */
function probsLine(t: T, key: string, probs: Record<Effort, number>, picked: Effort | undefined, w: number) {
  const { Box, Raster, Text } = t
  const bar = Math.max(8, Math.min(20, w - 47))
  return (
    <Box width={w}>
      <Box width={bar + 2} flexShrink={0}>
        <Raster key={key} columns={bar} rows={1} cells={stackCells(probs, picked, bar)} />
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="wrap">
          {EFFORTS.map((level, i) => (
            <Text color={level === picked ? EFFORT_COLOR[level] : softColor(EFFORT_COLOR[level])} bold={level === picked}>
              {`${level} ${pct(probs[level])}${i === EFFORTS.length - 1 ? '' : ' '}`}
            </Text>
          ))}
        </Text>
      </Box>
    </Box>
  )
}

/** A step's subject as the card says it: `第 3 步（every 3 steps）`. */
function stepOf(subject: string): string {
  const step = /^step (\d+)(?: \((.*)\))?$/.exec(subject)
  if (step === null) return subject
  return `第 ${step[1]} 步${step[2] === undefined ? '' : `（${step[2]}）`}`
}

/** One mid-turn re-decision: its number and step, the level suggested and the current one; the confidence meter with its line's tick, and the conclusion. */
function midRow(t: T, entry: LogEntry, w: number) {
  const { Box, Raster, Text } = t
  const verdict = midVerdict(entry)
  const level = (value: Effort) => <Text color={EFFORT_COLOR[value]} bold>{value}</Text>
  if (verdict === null) return null
  const meter = Math.max(8, Math.min(20, w - NUMBER - 36))
  const moved = verdict.kind === 'up' || verdict.kind === 'down'
  const sign = verdict.passed === null ? '' : verdict.passed ? '≥' : '<'
  const against = verdict.threshold === undefined || verdict.line === null ? '' : ` ${sign} ${pct(verdict.threshold)} ${verdict.line === 'up' ? '升档线' : '降档线'}`
  return (
    <Box key={`pane-mid-${entry.n}`} flexDirection="column" width={w}>
      <Box width={w}>
        <Box width={NUMBER} flexShrink={0}>
          <Text bold>{`#${entry.n}`}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="wrap">
            <Text color={MUTED}>{`${stepOf(entry.subject)} · 建议 `}</Text>
            {level(verdict.picked)}
            <Text color={MUTED}>{' · 当前 '}</Text>
            {level(verdict.current)}
          </Text>
        </Box>
      </Box>
      <Box width={w}>
        <Box width={NUMBER} flexShrink={0}>
          <Text> </Text>
        </Box>
        {verdict.conf === undefined ? null : (
          <Box width={meter + 1} flexShrink={0}>
            <Raster key={`pane-mid-meter-${entry.n}`} columns={meter} rows={1} cells={meterCells(verdict.conf, verdict.threshold, verdict.passed, meter)} />
          </Box>
        )}
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="wrap">
            {verdict.conf === undefined ? null : <Text bold>{pct(verdict.conf)}</Text>}
            <Text color={MUTED}>{`${against}  → `}</Text>
            <Text color={moved ? EFFORT_COLOR[verdict.result] : verdict.kind === 'blocked' || verdict.kind === 'held' ? WARN : MUTED} bold={moved}>{verdictWords(verdict)}</Text>
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

// ---- the decision log ------------------------------------------------------------------

function logRows(t: T, input: PaneInput, cols: number, act: PaneActs): RenderNode[] {
  const { Box, Text } = t
  const groups = logGroups(input.log, input.state)
  const rows: RenderNode[] = [
    <Box key="pane-log-head" width={cols}>
      <Text wrap="wrap">
        <Text color={ACCENT} bold>◆ 决策日志</Text>
        <Text color={MUTED}>{input.log.length === 0 ? '  还没有决定' : `  共 ${input.log.length} 条 · 按轮分组，按字母键折叠或展开`}</Text>
      </Text>
    </Box>,
  ]
  for (const group of groups) rows.push(groupRows(t, group, cols, act))
  return rows
}

function groupRows(t: T, group: LogGroup, cols: number, act: PaneActs) {
  const { Box, Button, Text } = t
  const { counts } = group
  const label = `${group.open ? '▾' : '▸'} 第 ${group.turn} 轮`
  return (
    <Box key={`pane-turn-${group.turn}`} flexDirection="column" width={cols}>
      <Box width={cols}>
        <Box flexShrink={0}>
          {group.key === null ? (
            <Button key={`pane-fold-${group.turn}`} label={label} plain onPress={() => act.fold(group.turn, !group.open)} />
          ) : (
            <Button key={`pane-fold-${group.turn}`} label={label} hotkey={group.key} plain onPress={() => act.fold(group.turn, !group.open)} />
          )}
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={MUTED} wrap="wrap">{group.prompt === '' ? '' : `  ${group.prompt}`}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text>
            <Text color={MUTED}>{`  ${group.entries.length} 条`}</Text>
            {counts.ok + counts.info > 0 ? <Text color={OK}>{` ✔${counts.ok + counts.info}`}</Text> : null}
            {counts.warn > 0 ? <Text color={WARN}>{` ⚠${counts.warn}`}</Text> : null}
            {counts.fail > 0 ? <Text color={BAD}>{` ✘${counts.fail}`}</Text> : null}
          </Text>
        </Box>
      </Box>
      {group.open ? group.entries.map((entry) => entryRows(t, entry, cols)) : null}
    </Box>
  )
}

/** One decision: its tone's glyph, then its number, what it did and to what level; whose and about what; the probabilities; the skills; why. */
function entryRows(t: T, entry: LogEntry, cols: number) {
  const { Box, Raster, Text } = t
  const level = levelOf(entry)
  const feature = featureOf(entry.feature)
  const inner = Math.max(10, cols - 2)
  const bar = Math.max(8, Math.min(20, inner - 47))
  const skills = entry.skills
  return (
    <Box key={`pane-entry-${entry.n}`} width={cols}>
      <Box width={2} flexShrink={0}>
        <Text color={LOG_COLOR[entry.tone]} bold>{LOG_GLYPH[entry.tone]}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        <Box>
          <Text wrap="wrap">
            <Text bold>{`#${entry.n} `}</Text>
            <Text color={LOG_COLOR[entry.tone]} bold>{entryVerb(entry)}</Text>
            {entry.model === undefined ? null : <Text> </Text>}
            {entry.model === undefined ? null : chip(t, entry.model, true)}
            {level === undefined || feature === 'skills' || feature === 'find-skill' ? null : <Text> </Text>}
            {level === undefined || feature === 'skills' || feature === 'find-skill' ? null : effortTag(t, level, 12)}
          </Text>
        </Box>
        <Box>
          <Text wrap="wrap">
            <Text color={MUTED}>{FEATURE_WORDS[feature] ?? feature}</Text>
            {entry.subject === '' ? (feature === 'skill-profiles' ? <Text>{'  会话开始'}</Text> : null) : <Text>{`  ${entry.subject}`}</Text>}
          </Text>
        </Box>
        {entry.probs === undefined ? null : (
          <Box>
            <Box width={bar + 2} flexShrink={0}>
              <Raster key={`pane-entry-probs-${entry.n}`} columns={bar} rows={1} cells={stackCells(entry.probs, level, bar)} />
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text color={MUTED} wrap="wrap">{EFFORTS.map((one) => `${one} ${pct(entry.probs?.[one] ?? 0)}`).join(' ')}</Text>
            </Box>
          </Box>
        )}
        {skills === undefined || skills.suggest.length + skills.try.length === 0 ? null : (
          <Box>
            <Text wrap="wrap">
              {skills.suggest.map((skill, i) => (
                <Text>
                  {i > 0 ? <Text color={MUTED}>{' · '}</Text> : null}
                  {skill.name}
                  <Text color={OK}>{` ${pct(skill.relevance)}`}</Text>
                </Text>
              ))}
              {skills.try.length === 0 ? null : <Text color={SKILL} bold>{`${skills.suggest.length > 0 ? '  ' : ''}可试 ${skills.try.map((skill) => `/${skill.name}`).join(' ')}`}</Text>}
            </Text>
          </Box>
        )}
        <Box>
          <Text color={MUTED} wrap="wrap">{entry.reason}</Text>
        </Box>
      </Box>
    </Box>
  )
}
