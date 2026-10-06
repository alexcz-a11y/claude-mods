// PROTOTYPE variant A, "Cockpit": instruments side by side.
//   band   gauge (main agent) | agent table | Workflow + skills
//   pane   flat numbered log, a colour rail per entry, probability histograms
//   footer dp <pips> <effort> . <running>/<total>

import { allNodes, counts, EFFORTS, LOG } from './data'
import type { LogEntry, Node } from './data'
import {
  ACCENT, BAD, EFFORT_COLOR, MODEL_BG, MODEL_INK, MUTED, OK, STATE_COLOR, WARN,
  chip, dw, effortTag, fit, fitBars, gaugeCells, hbar, histogram, mmss, padL, padR, pct, pips, ribbonCells, stateGlyph,
} from './kit'
import { elapsed } from './view'
import type { View } from './view'

/** Rows that fit: failed, escalated and running first; the rest fold into one "+N" row. */
export function prioritize(nodes: Node[], cap: number): { shown: Node[]; hidden: Node[] } {
  if (nodes.length <= cap) return { shown: nodes, hidden: [] }
  const rank = (n: Node) => (n.state === 'failed' ? 0 : n.esc ? 1 : !n.routed && n.model ? 1 : n.state === 'running' ? 2 : n.state === 'queued' ? 4 : 3)
  const sorted = [...nodes].sort((a, b) => rank(a) - rank(b) || nodes.indexOf(a) - nodes.indexOf(b))
  const keep = new Set(sorted.slice(0, Math.max(1, cap - 1)))
  return { shown: nodes.filter((n) => keep.has(n)), hidden: nodes.filter((n) => !keep.has(n)) }
}

export function hiddenSummary(hidden: Node[]): string {
  const c = counts(hidden)
  const parts: string[] = []
  if (c.running) parts.push(`运行 ${c.running}`)
  if (c.failed) parts.push(`失败 ${c.failed}`)
  if (c.done) parts.push(`完成 ${c.done}`)
  if (c.queued) parts.push(`排队 ${c.queued}`)
  return `⋯ 另有 ${hidden.length} 个：${parts.join(' · ')}`
}

export function outcomeColor(outcome: string): string | undefined {
  if (outcome === '已决定') return OK
  if (outcome === '保持') return MUTED
  if (outcome === '已建议') return 'suggestion'
  if (outcome === '已提升' || outcome === '未路由') return WARN
  if (outcome === '路由失败') return BAD
  return undefined
}

type Tier = 'wide' | 'mid' | 'narrow'

function note(v: View, n: Node, tier: Tier) {
  const { Text } = v.t
  if (n.state === 'failed') return <Text color={BAD} wrap="truncate-end">{tier === 'narrow' ? '✘ 失败' : (n.why ?? '失败')}</Text>
  if (!n.routed && n.model) return <Text color={WARN} wrap="truncate-end">{tier === 'wide' ? `未路由 · ${n.why ?? ''}` : '未路由'}</Text>
  if (n.esc) {
    const e = n.esc
    return (
      <Text color={WARN} wrap="truncate-end">
        {`↑ ${e.from}→${e.to}`}
        {tier === 'wide' ? `  失败${e.failed} 阻塞${e.blocked} 提升${e.raised}` : ''}
      </Text>
    )
  }
  return <Text color={MUTED}>{n.state === 'queued' ? '排队' : mmss(elapsed(n, v))}</Text>
}

function agentRow(v: View, n: Node, nameW: number, noteW: number, tier: Tier) {
  const { Box, Text } = v.t
  const numW = tier === 'narrow' ? 0 : 5
  const failed = n.state === 'failed'
  return (
    <Box>
      <Box width={2}>{stateGlyph(v.t, n.state, v.frame, n.routed)}</Box>
      {numW > 0 ? (
        <Box width={numW}>
          <Text color={MUTED}>{n.n !== undefined ? `#${n.n}` : ' ·'}</Text>
        </Box>
      ) : null}
      <Box width={nameW}>
        <Text bold={n.state === 'running'} dimColor={n.state === 'done'} color={failed ? BAD : undefined} wrap="truncate-end">
          {n.name}
        </Text>
      </Box>
      <Box width={9}>{chip(v.t, n.model, n.routed)}</Box>
      <Box width={13}>{effortTag(v.t, n.effort, 12)}</Box>
      <Box width={noteW}>{note(v, n, tier)}</Box>
    </Box>
  )
}

function header(v: View) {
  const { Box, Text } = v.t
  const s = v.scene
  const compact = v.cols < 100
  const left = compact ? `  第 ${s.turn} 轮 · ` : `  第 ${s.turn} 轮 · ${mmss(s.now + v.live)} · `
  const right = compact ? `  ${v.variantName} · ${v.sceneName}` : `  原型 ${v.variantName} · 场景 ${v.sceneName}`
  const room = v.cols - dw('◆ dispatch-pilot') - dw(left) - dw(right) - 1
  return (
    <Box width={v.cols} justifyContent="space-between">
      <Box>
        <Text color={ACCENT} bold>◆ dispatch-pilot</Text>
        <Text color={MUTED}>{left + fit(s.prompt, Math.max(6, room))}</Text>
      </Box>
      <Text color={MUTED}>
        {compact ? '  ' : '  原型 '}
        <Text color={ACCENT} bold>{v.variantName}</Text>
        {compact ? ` · ${v.sceneName}` : ` · 场景 ${v.sceneName}`}
      </Text>
    </Box>
  )
}

function modelMix(v: View, nodes: Node[]) {
  const { Text } = v.t
  const order = ['haiku', 'sonnet', 'opus', 'fable'] as const
  return (
    <Text>
      {order.map((m) => {
        const k = nodes.filter((n) => n.model === m).length
        return k > 0 ? (
          <Text>
            <Text backgroundColor={MODEL_BG[m]} color={MODEL_INK} bold>{` ${m} `}</Text>
            <Text bold>{`×${k} `}</Text>
          </Text>
        ) : null
      })}
    </Text>
  )
}

export function cockpitBand(v: View) {
  const { t, scene, cols } = v
  const { Box, Text, Raster } = t
  const m = scene.main
  const tier: Tier = cols >= 132 ? 'wide' : cols >= 100 ? 'mid' : 'narrow'

  if (scene.done) {
    const c = counts(scene.agents)
    return (
      <Box flexDirection="column" width={cols}>
        {header(v)}
        <Text wrap="truncate-end">
          <Text color={MUTED}>{'空闲 · 上一轮 '}</Text>
          {pips(t, m.effort)}
          <Text color={EFFORT_COLOR[m.effort]} bold>{` ${m.effort}`}</Text>
          <Text color={MUTED}>{` · ${c.total} 个 agent 全部完成`}</Text>
          {c.esc > 0 ? <Text color={WARN}>{`（${c.esc} 次升级）`}</Text> : null}
          <Text color={MUTED}>{scene.skills.length > 0 ? ' · 技能 ' + scene.skills.map((s) => `${s.name} ${pct(s.fit)}`).join('  ') : ''}</Text>
        </Text>
      </Box>
    )
  }

  const leftW = 26
  const rightW = 38
  const gap = 2
  const maxTableW = tier === 'wide' ? Math.min(92, cols - leftW - rightW - 2 * gap) : tier === 'mid' ? Math.min(98, cols - leftW - gap) : Math.min(100, cols)
  const noteMax = tier === 'wide' ? 34 : tier === 'mid' ? 14 : 12
  const needs = scene.agents.map((n) => {
    if (n.state === 'failed') return tier === 'narrow' ? 6 : dw(n.why ?? '失败')
    if (!n.routed && n.model) return tier === 'wide' ? dw(`未路由 · ${n.why ?? ''}`) : 6
    if (n.esc) return tier === 'wide' ? 32 : 12
    return 5
  })
  const noteW = Math.max(8, Math.min(noteMax, Math.max(0, ...needs) + 1))
  const numCol = tier === 'narrow' ? 0 : 5
  const longest = Math.max(12, ...scene.agents.map((n) => dw(n.name))) + 2
  const nameW = Math.max(12, Math.min(longest, maxTableW - (2 + numCol + 9 + 13 + noteW)))
  const tableW = 2 + numCol + nameW + 9 + 13 + noteW

  const srcWord = m.src === 'decided' ? '已决定' : m.src === 'locked' ? '已锁定' : '未路由'
  const srcColor = m.src === 'decided' ? OK : m.src === 'locked' ? ACCENT : WARN

  // left: the main agent gauge (wide and mid), a single line when narrow
  const g = gaugeCells(m.effort)
  const gauge =
    tier === 'narrow' ? (
      <Text wrap="truncate-end">
        <Text bold>{'主 agent  '}</Text>
        {pips(t, m.effort)}
        <Text color={m.src === 'notrouted' ? WARN : EFFORT_COLOR[m.effort]} bold>{` ${m.effort}  `}</Text>
        <Text color={srcColor} bold={m.src !== 'decided'}>{srcWord}</Text>
        <Text color={MUTED}>{m.conf !== undefined ? ` · 置信 ${m.conf.toFixed(2)}` : ''}</Text>
        <Text color={m.src === 'notrouted' ? WARN : MUTED}>{` · ${m.reason}`}</Text>
      </Text>
    ) : (
      <Box flexDirection="column" width={leftW}>
        <Text bold>
          {'主 agent'}
          <Text color={MUTED}>{' · '}</Text>
          <Text color={srcColor} bold={m.src !== 'decided'}>{srcWord}</Text>
        </Text>
        <Raster key="gauge" columns={g.columns} rows={g.rows} cells={g.cells} />
        <Text>
          <Text color={m.src === 'notrouted' ? WARN : EFFORT_COLOR[m.effort]} bold>{m.effort}</Text>
          <Text color={MUTED}>{m.conf !== undefined ? `   置信 ${m.conf.toFixed(2)}` : m.src === 'notrouted' ? '   沿用当前档位' : ''}</Text>
        </Text>
        <Text color={m.src === 'notrouted' ? WARN : MUTED} wrap="truncate-end">{m.reason}</Text>
      </Box>
    )

  // middle: the agent table
  const cap = Math.max(3, Math.min(6, v.rows - 3))
  const { shown, hidden } = prioritize(scene.agents, cap)
  const c = counts(scene.agents)
  const table = (
    <Box flexDirection="column" width={tableW}>
      <Text>
        <Text bold>派出 agent</Text>
        <Text color={MUTED}>{scene.agents.length === 0 ? '  无' : '  '}</Text>
        {c.running > 0 ? <Text color={STATE_COLOR.running}>{`运行 ${c.running}  `}</Text> : null}
        {c.done > 0 ? <Text color={STATE_COLOR.done}>{`完成 ${c.done}  `}</Text> : null}
        {c.failed > 0 ? <Text color={STATE_COLOR.failed} bold>{`失败 ${c.failed}  `}</Text> : null}
        {c.esc > 0 ? <Text color={WARN}>{`升级 ${c.esc}  `}</Text> : null}
      </Text>
      {shown.map((n) => agentRow(v, n, nameW, noteW, tier))}
      {hidden.length > 0 ? <Text color={MUTED}>{hiddenSummary(hidden)}</Text> : null}
    </Box>
  )

  // right: Workflow progress and skills
  const wf = scene.wf
  const skills = (
    <Box flexDirection="column">
      <Text bold>
        {'技能'}
        <Text color={MUTED}>{scene.skills.length === 0 ? '  本轮无建议' : ''}</Text>
      </Text>
      {scene.skills.map((s) => (
        <Box>
          <Box width={rightW - 11}>
            <Text wrap="truncate-end">{s.name}</Text>
          </Box>
          <Text color={OK}>{hbar(s.fit, 5)}</Text>
          <Text color={MUTED}>{' ' + pct(s.fit)}</Text>
        </Box>
      ))}
    </Box>
  )
  let wfBlock = null
  if (wf) {
    const wc = counts(wf.agents)
    const rb = ribbonCells(wc.done, wc.total, 16, wc.running)
    const active = wf.agents.filter((n) => n.state === 'running').slice(0, 2)
    wfBlock = (
      <Box flexDirection="column" width={rightW}>
        <Text bold wrap="truncate-end">
          {'Workflow '}
          <Text color={MUTED}>{wf.name}</Text>
        </Text>
        <Box>
          <Raster key="wf" columns={rb.columns} rows={rb.rows} cells={rb.cells} />
          <Text bold>{`  ${wc.done}`}</Text>
          <Text color={MUTED}>{` / ${wc.total}`}</Text>
          {wc.failed > 0 ? <Text color={BAD}>{`  ✘${wc.failed}`}</Text> : null}
        </Box>
        {modelMix(v, wf.agents)}
        {active.map((n) => (
          <Box>
            <Box width={2}>{stateGlyph(t, n.state, v.frame)}</Box>
            <Box width={6}>{pips(t, n.effort)}</Box>
            <Box width={rightW - 8}>
              <Text wrap="truncate-end">{n.name}</Text>
            </Box>
          </Box>
        ))}
        {skills}
      </Box>
    )
  }

  const right =
    tier === 'wide' ? (
      wfBlock ?? (
        <Box flexDirection="column" width={rightW}>
          {skills}
        </Box>
      )
    ) : null

  // below the table when there is no room beside it
  let strip = null
  if (tier !== 'wide') {
    const wc = wf ? counts(wf.agents) : null
    strip = (
      <Box flexDirection="column" width={cols}>
        {wf && wc ? (
          <Text wrap="truncate-end">
            <Text bold>{'Workflow '}</Text>
            <Text color={MUTED}>{wf.name + '  '}</Text>
            <Text color={ACCENT}>{'▰'.repeat(wc.done)}</Text>
            <Text color={MUTED}>{'▱'.repeat(wc.total - wc.done)}</Text>
            <Text bold>{` ${wc.done}`}</Text>
            <Text color={MUTED}>{`/${wc.total}  运行：`}</Text>
            {wf.agents.filter((n) => n.state === 'running').map((n) => `${n.name} ${n.model}·${n.effort}`).join('，')}
          </Text>
        ) : null}
        <Text wrap="truncate-end">
          <Text bold>{'技能 '}</Text>
          <Text color={MUTED}>{scene.skills.length === 0 ? '本轮无建议' : ''}</Text>
          {scene.skills.map((s) => `${s.name} ${pct(s.fit)}`).join('  ·  ')}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={cols}>
      {header(v)}
      {tier === 'narrow' ? (
        <Box flexDirection="column" width={cols}>
          {gauge}
          {table}
        </Box>
      ) : (
        <Box gap={gap}>
          {gauge}
          {table}
          {right}
        </Box>
      )}
      {strip}
    </Box>
  )
}

// -- pane: flat numbered log ----------------------------------------------------

function entry(v: View, e: LogEntry) {
  const { Box, Text } = v.t
  const rail = e.tone === 'warn' ? WARN : e.tone === 'fail' ? BAD : MUTED
  const w = v.cols - 2
  const probs = e.probs
  const picked = e.pick?.effort
  return (
    <Box width={v.cols}>
      <Box width={2}>
        <Text color={rail}>{'▎\n▎\n▎'}</Text>
      </Box>
      <Box flexDirection="column" width={w}>
        <Box width={w}>
          <Text bold>{padL('#' + e.n, 3)}</Text>
          <Text>{'  '}</Text>
          <Text color={outcomeColor(e.outcome)} bold>{padR(e.outcome, 8)}</Text>
          {e.pick?.model ? chip(v.t, e.pick.model) : <Text>{' '.repeat(8)}</Text>}
          <Text>{' '}</Text>
          {picked ? effortTag(v.t, picked, 12) : null}
          <Box flexGrow={1} justifyContent="flex-end">
            <Text color={MUTED}>{e.feature}</Text>
          </Box>
        </Box>
        <Text wrap="truncate-end">{'     ' + e.subject}</Text>
        <Box width={w}>
          <Text>{'     '}</Text>
          {probs ? histogram(v.t, probs, picked) : e.fits ? fitBars(v.t, e.fits.map((f) => f.fit)) : <Text color={MUTED}>{'·····'}</Text>}
          <Text>{'  '}</Text>
          <Box width={Math.max(10, w - 14)}>
            <Text color={MUTED} wrap="truncate-end">
              {(e.conf !== undefined ? `置信 ${e.conf.toFixed(2)} · ` : '') +
                (e.fits ? e.fits.map((f) => `${f.name} ${pct(f.fit)}`).join('  ') : e.reason)}
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

export function cockpitPane(v: View) {
  const { Box, Text } = v.t
  return (
    <Box flexDirection="column" width={v.cols}>
      <Box width={v.cols} justifyContent="space-between">
        <Text>
          <Text color={ACCENT} bold>◆ 决定记录</Text>
          <Text color={MUTED}>{`  共 ${LOG.length} 条`}</Text>
        </Text>
        <Text color={MUTED}>{`原型 ${v.variantName}`}</Text>
      </Box>
      <Text color={MUTED} wrap="truncate-end">
        {'概率条 5 格依次为 '}
        {EFFORTS.map((e) => (
          <Text color={EFFORT_COLOR[e]}>{e + ' '}</Text>
        ))}
        {'· 亮色 = 选中档位'}
      </Text>
      <Text>{' '}</Text>
      {LOG.map((e) => entry(v, e))}
    </Box>
  )
}

// -- footer ---------------------------------------------------------------------

export function cockpitFooter(v: View) {
  const { Text } = v.t
  const m = v.scene.main
  const c = counts(allNodes(v.scene))
  return (
    <Text>
      <Text color={ACCENT} bold>dp </Text>
      {pips(v.t, m.effort)}
      <Text color={m.src === 'notrouted' ? WARN : EFFORT_COLOR[m.effort]} bold>{` ${m.effort}`}</Text>
      <Text color={MUTED}>{v.scene.done ? ' 空闲' : c.total > 0 ? ` ${c.running}/${c.total}` : ''}</Text>
      {m.src === 'notrouted' ? <Text color={WARN}>{' 未路由'}</Text> : null}
      {c.failed > 0 ? <Text color={BAD}>{` ✘${c.failed}`}</Text> : null}
    </Text>
  )
}
