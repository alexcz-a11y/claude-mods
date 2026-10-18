// The rationale pane off the terminal (Desktop, VS Code, the mobile app), where the person clicks instead of
// pressing keys: a row of agent tabs (the picked one primary) with 看它的对话 and 关闭; the card of the agent picked
// (pane.tsx's `cardRows` in its `app` style: a larger name, the rules as a list, the probabilities' shares under their
// bar); the problem summary; the decision log folded by turn, each entry one line and the rest of it on hover; and at
// the bottom, folded at first, the switches as buttons and the effort lock as a picker, changed where they are shown.
// Pure: drawn from the same `PaneInput` as the terminal's pane; the Buttons and the picker call `act`.

import type { RenderNode } from 'claude-code'
import { EFFORTS, isEffort, type Effort } from '../decision/effort.ts'
import type { LogEntry } from '../core/report.ts'
import { ACCENT, BAD, chip, effortWord, fit, MUTED, pct, skillsText, WARN, type Marks, type T } from './kit.tsx'
import { blank, cardRows, LOG_COLOR, LOG_GLYPH, LOG_TONES, summaryRows, viewButton, type PaneActs, type PaneInput } from './pane.tsx'
import { cardOf, entryVerb, logGroups, profilesLine, type LogGroup } from './rationale.ts'
import { FEATURE_WORDS, featureOf, levelOf, type AgentRow } from './view.ts'

/** The elements the pane draws with off the terminal: the text parts', and the picker where the surface has one (the mobile app has none). */
export type AppT = Pick<T, 'Box' | 'Text' | 'Button'> & { Select?: T['Select'] }

/** What the pane's Buttons and picker do off the terminal: the terminal pane's, a switch flipped, the lock set (null: released), the switches shown. */
export type AppPaneActs = PaneActs & {
  toggle: (name: string, on: boolean) => void
  lock: (effort: Effort | null) => void
  switches: (open: boolean) => void
}

/** A tab's glyph for its agent's state. */
const TAB_GLYPH: Record<AgentRow['node']['state'], string> = { running: '●', done: '✔', failed: '✘', queued: '○' }
/** The longest name a tab spells. */
const TAB_NAME = 24
/** The switch that stands for the whole of Dispatch Pilot (`/dp on|off`). */
const MASTER = 'master'
/** The lock picker's value for no lock. */
const NO_LOCK = 'none'

export function appPaneTree(t: AppT, input: PaneInput, cols: number, act: AppPaneActs, marks?: Marks) {
  const { Box, Text } = t
  const card = cardOf(input.view, input.log)
  return (
    <Box key="pane" flexDirection="column" width={cols}>
      {headRows(t, input, card.row, cols, act)}
      {input.master ? null : (
        <Box key="pane-off" width={cols}>
          <Text color={MUTED} wrap="wrap">Dispatch Pilot 已关：不发决策请求，每一步照引擎原样发出（在最下面的功能开关里打开）</Text>
        </Box>
      )}
      {blank(t, 'pane-head-gap')}
      <Box key="pane-card" flexDirection="column" width={cols}>
        {cardRows(t, card, input, cols, marks, true)}
      </Box>
      {blank(t, 'pane-gap')}
      {summaryRows(t, input.summary, cols)}
      {logRows(t, input, cols, act, marks)}
      {blank(t, 'pane-log-gap')}
      {switchRows(t, input, cols, act)}
    </Box>
  )
}

// ---- the tabs ------------------------------------------------------------------------

/** The agents as tabs, the picked one primary; 看它的对话 where the engine can show it; the pane's own 关闭. */
function headRows(t: AppT, input: PaneInput, picked: AgentRow | null, cols: number, act: AppPaneActs): RenderNode[] {
  const { Box, Button } = t
  const rows = input.view.rows
  return [
    <Box key="pane-head" width={cols}>
      <Box flexGrow={1} flexShrink={1} flexWrap="wrap" gap="xs">
        {rows.map((row, i) => (
          <Box key={`pane-tab-box-${i}`} flexShrink={0}>
            <Button key={`pane-tab-${i}`} label={`${TAB_GLYPH[row.node.state]} ${fit(row.node.name, TAB_NAME)}`} variant={row === picked ? 'primary' : 'secondary'} onPress={() => act.pick(row)} />
          </Box>
        ))}
        {input.canView === false ? null : viewButton(t, picked, input.viewing, act, false)}
      </Box>
      {act.close === undefined ? null : (
        <Box key="pane-close-box" flexShrink={0} paddingLeft={2}>
          <Button key="pane-close" label="关闭" role="dismiss" plain dimColor onPress={act.close} />
        </Box>
      )}
    </Box>,
  ]
}

// ---- the decision log ------------------------------------------------------------------

function logRows(t: AppT, input: PaneInput, cols: number, act: AppPaneActs, marks: Marks | undefined): RenderNode[] {
  const { Box, Text } = t
  const groups = logGroups(input.log, input.state)
  const rows: RenderNode[] = [
    <Box key="pane-log-head" width={cols}>
      <Text wrap="wrap">
        <Text color={ACCENT} weight="semibold">◆ 决策日志</Text>
        <Text color={MUTED}>{input.log.length === 0 ? '  还没有决定' : `  共 ${input.log.length} 条 · 点轮次折叠或展开，指着一条看详情`}</Text>
      </Text>
    </Box>,
  ]
  // The newest entries first take the room a surface's window leaves (the groups are newest turn first).
  let room = input.window?.entries ?? Infinity
  for (const group of groups) {
    const shown = group.open ? Math.min(room, group.entries.length) : 0
    room -= shown
    rows.push(groupRows(t, group, cols, act, marks, group.entries.length - shown))
  }
  return rows
}

/** One turn of the log, folded by its title; `left` of its oldest entries (an open turn's) are left out for want of room. */
function groupRows(t: AppT, group: LogGroup, cols: number, act: AppPaneActs, marks: Marks | undefined, left: number) {
  const { Box, Button, Text } = t
  const { counts } = group
  return (
    <Box key={`pane-turn-${group.turn}`} flexDirection="column" width={cols}>
      <Box width={cols}>
        <Box flexShrink={0}>
          <Button key={`pane-fold-${group.turn}`} label={`${group.open ? '▾' : '▸'} 第 ${group.turn} 轮`} plain onPress={() => act.fold(group.turn, !group.open)} />
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={MUTED} wrap="truncate-end">{group.prompt === '' ? '' : `  ${group.prompt}`}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text>
            <Text color={MUTED} tabular>{`  ${group.entries.length} 条`}</Text>
            {LOG_TONES.map((tone) => (counts[tone] > 0 ? <Text color={LOG_COLOR[tone]} tabular>{` ${LOG_GLYPH[tone]}${counts[tone]}`}</Text> : null))}
          </Text>
        </Box>
      </Box>
      {group.open && left > 0 ? (
        <Box key={`pane-log-more-${group.turn}`} width={cols}>
          <Text color={MUTED} wrap="wrap">{`  更早 ${left} 条没有画出：折起别的轮，或 /dp log N 看最近 N 条`}</Text>
        </Box>
      ) : null}
      {group.open ? group.entries.slice(left).map((entry) => entryRows(t, entry, cols, marks)) : null}
    </Box>
  )
}

/** One decision on one line (its tone's glyph, number, what it did, whose and about what); the probabilities, the skills and why under it, shown while the pointer is on the line. */
function entryRows(t: AppT, entry: LogEntry, cols: number, marks: Marks | undefined) {
  const { Box, Text } = t
  const level = levelOf(entry)
  const feature = featureOf(entry.feature)
  const skills = entry.skills
  const showsLevel = level !== undefined && feature !== 'skills' && feature !== 'find-skill'
  // The line and what it hides are one hover group: the hidden part keeps its own key.
  const scope = `dp-entry-${entry.n}`
  const bar = Math.max(8, Math.min(24, cols - 40))
  return (
    <Box key={`pane-entry-${entry.n}`} flexDirection="column" width={cols} hover={{ scope }}>
      <Box width={cols}>
        <Box width={2} flexShrink={0}>
          <Text color={LOG_COLOR[entry.tone]} bold mono>{LOG_GLYPH[entry.tone]}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={MUTED} tabular>{`#${entry.n} `}</Text>
            <Text color={LOG_COLOR[entry.tone]} weight="semibold">{entryVerb(entry)}</Text>
            {entry.model === undefined ? null : <Text> </Text>}
            {entry.model === undefined ? null : chip(t, entry.model, true)}
            {showsLevel ? <Text> </Text> : null}
            {showsLevel ? effortWord(t, level) : null}
            <Text color={MUTED}>{`  ${FEATURE_WORDS[feature] ?? feature}`}</Text>
            {entry.subject === '' ? null : <Text>{`  ${entry.subject}`}</Text>}
          </Text>
        </Box>
      </Box>
      <Box key={`pane-entry-${entry.n}-more`} flexDirection="column" paddingLeft={2} display="none" hover={{ scope, display: 'flex' }}>
        {entry.probs === undefined ? null : (
          <Box>
            {marks === undefined ? null : (
              <Box width={bar + 2} flexShrink={0} alignItems="center">
                {marks.stack(`pane-entry-probs-${entry.n}`, entry.probs, level, bar)}
              </Box>
            )}
            <Box flexGrow={1} flexShrink={1}>
              <Text color={MUTED} tabular wrap="wrap">{EFFORTS.map((one) => `${one} ${pct(entry.probs?.[one] ?? 0)}`).join('  ')}</Text>
            </Box>
          </Box>
        )}
        {skills === undefined || skills.suggest.length + skills.try.length === 0 ? null : (
          <Box>
            <Text wrap="wrap">{skillsText(t, skills)}</Text>
          </Box>
        )}
        {feature === 'unresolved' || feature === 'visual-check' ? (
          <Box>
            <Text color={MUTED} wrap="wrap">{entry.outcome}</Text>
          </Box>
        ) : null}
        <Box>
          <Text color={MUTED} wrap="wrap">{entry.reason}</Text>
        </Box>
      </Box>
    </Box>
  )
}

// ---- the switches and the lock ------------------------------------------------------------

/**
 * The switches and the lock, folded under one line that says how many are on and the lock; open, a button for each
 * switch (Dispatch Pilot itself first, the ones off dim) and the lock's picker (its words where the surface has no
 * picker); how the skill profiles went.
 */
function switchRows(t: AppT, input: PaneInput, cols: number, act: AppPaneActs): RenderNode[] {
  const { Box, Button, Select, Text } = t
  const open = input.state.switches === true
  const on = input.switches.filter((one) => one.on).length
  const lock = input.lock === null ? 'effort 未锁定' : `effort 锁在 ${input.lock}`
  const rows: RenderNode[] = [
    <Box key="pane-switches-head" width={cols}>
      <Button key="pane-switches-toggle" label={`${open ? '▾' : '▸'} 功能开关 · ${on}/${input.switches.length} 开 · ${lock}`} plain onPress={() => act.switches(!open)} />
    </Box>,
  ]
  if (!open) return rows
  const button = (name: string, label: string, isOn: boolean) => (
    <Box key={`pane-switch-box-${name}`} flexShrink={0}>
      <Button key={`pane-switch-${name}`} label={label} variant="secondary" {...(isOn ? {} : { dimColor: true })} onPress={() => act.toggle(name, !isOn)} />
    </Box>
  )
  rows.push(
    <Box key="pane-switches" width={cols} flexWrap="wrap" gap="xs" paddingLeft={2}>
      {button(MASTER, 'Dispatch Pilot', input.master)}
      {input.switches.map((one) => button(one.name, one.name, one.on))}
    </Box>,
    <Box key="pane-lock-row" width={cols} paddingLeft={2}>
      {Select === undefined ? (
        <Text color={MUTED} wrap="wrap">{`${lock}（/dp lock <effort> 锁定，/dp unlock 解除）`}</Text>
      ) : (
        <Select
          key="pane-lock"
          label="锁定主 agent 的 effort"
          options={[{ value: NO_LOCK, label: '不锁定' }, ...EFFORTS.map((level) => ({ value: level }))]}
          value={input.lock ?? NO_LOCK}
          onSelect={(value) => act.lock(isEffort(value) ? value : null)}
        />
      )}
    </Box>,
  )
  const profiles = input.profiles
  if (profiles !== null) {
    const line = profilesLine(profiles)
    rows.push(
      <Box key="pane-profiles" width={cols} paddingLeft={2}>
        <Text color={line.tone === 'fail' ? BAD : line.tone === 'warn' ? WARN : MUTED} wrap="wrap">{line.text}</Text>
      </Box>,
    )
  }
  return rows
}
