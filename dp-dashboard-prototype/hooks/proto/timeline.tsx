// PROTOTYPE variant B, "Timeline": this turn as a stream of events.
//   band   a one-line ribbon (state at a glance) over a vertical stream, oldest first
//   pane   the log grouped by turn, groups fold; probability bars on each entry
//   footer dp <glyph> <running> . newest agent

import { allNodes, counts, EFFORTS, events, LOG, TURNS } from './data'
import type { Effort, Ev, LogEntry, Node, Probs } from './data'
import {
  ACCENT, BAD, EFFORT_COLOR, EFFORT_SHORT, MUTED, OK, SPIN, WARN,
  chip, effortTag, fit, mmss, padL, padR, pct, pips, soft, stackCells, stateGlyph,
} from './kit'
import { outcomeColor } from './cockpit'
import { elapsed } from './view'
import type { View } from './view'

export function ribbon(v: View) {
  const { Box, Text } = v.t
  const s = v.scene
  const m = s.main
  const c = counts(allNodes(s))
  const compact = v.cols < 118
  const sep = <Text color={MUTED}>{compact ? ' ▏ ' : '  ▏ '}</Text>
  const wc = s.wf ? counts(s.wf.agents) : null
  return (
    <Box width={v.cols} justifyContent="space-between">
      <Box flexShrink={1}>
        <Text wrap="truncate-end">
          <Text color={ACCENT} bold>◆ </Text>
          <Text bold>{`第 ${s.turn} 轮`}</Text>
          <Text color={MUTED}>{compact ? '' : ` ${mmss(s.now + v.live)}`}</Text>
          {sep}
          <Text color={MUTED}>{compact ? '' : '主 '}</Text>
          {pips(v.t, m.effort)}
          <Text color={m.src === 'notrouted' ? WARN : EFFORT_COLOR[m.effort]} bold>{` ${m.effort}`}</Text>
          <Text color={m.src === 'notrouted' ? WARN : m.src === 'locked' ? ACCENT : MUTED}>
            {m.src === 'notrouted' ? ' 未路由' : m.src === 'locked' ? ' 已锁定' : ' 已决定'}
          </Text>
          {sep}
          <Text color={MUTED}>{'agent '}</Text>
          {c.running > 0 ? <Text color={ACCENT} bold>{`${SPIN[v.frame % SPIN.length]}${c.running} `}</Text> : null}
          {c.done > 0 ? <Text color={OK}>{`✔${c.done} `}</Text> : null}
          {c.failed > 0 ? <Text color={BAD} bold>{`✘${c.failed} `}</Text> : null}
          {c.total === 0 ? <Text color={MUTED}>无</Text> : null}
          {wc ? sep : null}
          {wc ? <Text color={MUTED}>{compact ? 'WF ' : 'Workflow '}</Text> : null}
          {wc ? <Text bold>{`${wc.done}`}</Text> : null}
          {wc ? <Text color={MUTED}>{`/${wc.total}`}</Text> : null}
          {s.skills.length > 0 ? sep : null}
          {s.skills.length > 0 ? <Text color={MUTED}>{`技能 ${s.skills.length}`}</Text> : null}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={MUTED}>
          {compact ? ' ' : '  原型 '}
          <Text color={ACCENT} bold>{v.variantName}</Text>
          {compact ? ` · ${v.sceneName}` : ` · 场景 ${v.sceneName}`}
        </Text>
      </Box>
    </Box>
  )
}

export const TAG: Record<Ev['kind'], string> = { main: '主 agent', skills: '技能', wf: 'Workflow', start: '派出', raise: '升级' }

export function evGlyph(v: View, ev: Ev) {
  const { Text } = v.t
  if (ev.kind === 'start' && ev.node) return stateGlyph(v.t, ev.node.state, v.frame, ev.node.routed)
  if (ev.kind === 'raise') return <Text color={WARN} bold>↑</Text>
  if (ev.kind === 'main') return <Text color={v.scene.main.src === 'notrouted' ? WARN : ACCENT}>◆</Text>
  if (ev.kind === 'wf') return <Text color={ACCENT}>◈</Text>
  return <Text color="suggestion">⚑</Text>
}

export function evBody(v: View, ev: Ev, bodyW: number) {
  const { Box, Text } = v.t
  const s = v.scene
  if (ev.kind === 'main') {
    const m = s.main
    return (
      <Text wrap="truncate-end">
        {effortTag(v.t, m.effort, 8)}
        <Text color={m.src === 'notrouted' ? WARN : MUTED}>
          {m.src === 'decided' ? `  已决定${m.conf !== undefined ? ` · 置信 ${m.conf.toFixed(2)}` : ''}` : `  ${m.src === 'locked' ? '已锁定' : '未路由'} · ${m.reason}`}
        </Text>
      </Text>
    )
  }
  if (ev.kind === 'skills') {
    return (
      <Text wrap="truncate-end">
        {s.skills.map((k, i) => (
          <Text>
            {i > 0 ? <Text color={MUTED}>{'  ·  '}</Text> : null}
            {k.name}
            <Text color={OK}>{' ' + pct(k.fit)}</Text>
          </Text>
        ))}
      </Text>
    )
  }
  if (ev.kind === 'wf' && s.wf) {
    const wc = counts(s.wf.agents)
    return (
      <Text wrap="truncate-end">
        <Text bold>{s.wf.name}</Text>
        <Text color={MUTED}>{`  ${wc.total} 个 agent · 进度 `}</Text>
        <Text color={ACCENT}>{'▰'.repeat(wc.done)}</Text>
        <Text color={MUTED}>{'▱'.repeat(wc.total - wc.done)}</Text>
        <Text bold>{` ${wc.done}`}</Text>
        <Text color={MUTED}>{`/${wc.total}`}</Text>
      </Text>
    )
  }
  const n = ev.node
  if (!n) return null
  if (ev.kind === 'raise' && n.esc) {
    const e = n.esc
    return (
      <Text color={WARN} wrap="truncate-end">
        <Text bold>{`#${n.n} `}</Text>
        {`${n.name}  ${e.from} → ${e.to}  失败${e.failed} 阻塞${e.blocked} 提升${e.raised}`}
      </Text>
    )
  }
  const nameW = Math.max(8, bodyW - (5 + 9 + 13) - 1)
  return (
    <Box>
      <Box width={5}>
        <Text color={MUTED}>{n.n !== undefined ? `#${n.n}` : ' ·'}</Text>
      </Box>
      <Box width={9}>{chip(v.t, n.model, n.routed)}</Box>
      <Box width={13}>{effortTag(v.t, n.effort, 12)}</Box>
      <Box width={nameW}>
        <Text bold={n.state === 'running'} dimColor={n.state === 'done'} color={n.state === 'failed' ? BAD : undefined} wrap="truncate-end">
          {n.name}
        </Text>
      </Box>
    </Box>
  )
}

export function evStatus(v: View, ev: Ev) {
  const { Text } = v.t
  const n = ev.node
  if (ev.kind !== 'start' || !n) return null
  if (n.state === 'failed') return <Text color={BAD} wrap="truncate-end">{`失败 · ${n.why ?? ''}`}</Text>
  if (!n.routed && n.model) return <Text color={WARN} wrap="truncate-end">{`未路由 · ${n.why ?? ''}`}</Text>
  if (n.state === 'running') return <Text color={ACCENT} wrap="truncate-end">{`运行 ${mmss(elapsed(n, v))}`}</Text>
  return <Text color={MUTED}>{`完成 ${mmss(elapsed(n, v))}`}</Text>
}

export function timelineBand(v: View) {
  const { t, scene, cols } = v
  const { Box, Text } = t
  const evs = events(scene, v.live)
  const cap = scene.done ? 2 : Math.max(3, Math.min(8, v.rows - 2))

  if (scene.done) {
    const c = counts(allNodes(scene))
    return (
      <Box flexDirection="column" width={cols}>
        {ribbon(v)}
        <Text color={MUTED}>{`空闲 · 本轮共 ${evs.length} 个事件，${c.total} 个 agent 全部完成${c.esc ? `（${c.esc} 次升级）` : ''} · /dpp log 看依据`}</Text>
      </Box>
    )
  }

  const hidden = Math.max(0, evs.length - cap)
  const shown = hidden > 0 ? evs.slice(evs.length - (cap - 1)) : evs
  const statusW = cols >= 110 ? 30 : 16
  const bodyW = Math.min(62, cols - (5 + 2 + 2 + 9 + statusW))
  const W = 5 + 2 + 2 + 9 + bodyW + statusW

  return (
    <Box flexDirection="column" width={cols}>
      {ribbon(v)}
      {hidden > 0 ? (
        <Box width={W}>
          <Box width={5}>
            <Text color={MUTED}>{' '}</Text>
          </Box>
          <Box width={2}>
            <Text color={MUTED}>┊</Text>
          </Box>
          <Text color={MUTED}>{` 更早 ${hidden + 1} 个事件 · /dpp log`}</Text>
        </Box>
      ) : null}
      {shown.map((ev, i) => {
        const isLast = i === shown.length - 1
        const rail = isLast ? '└' : i === 0 && hidden === 0 ? '┬' : '├'
        return (
          <Box width={W}>
            <Box width={5}>
              <Text color={MUTED}>{padL(mmss(ev.t), 4)}</Text>
            </Box>
            <Box width={2}>
              <Text color={MUTED}>{rail}</Text>
            </Box>
            <Box width={2}>{evGlyph(v, ev)}</Box>
            <Box width={9}>
              <Text color={ev.kind === 'raise' ? WARN : MUTED}>{TAG[ev.kind]}</Text>
            </Box>
            <Box width={bodyW}>{evBody(v, ev, bodyW)}</Box>
            <Box width={statusW}>{evStatus(v, ev)}</Box>
          </Box>
        )
      })}
    </Box>
  )
}

// -- pane: log grouped by turn ------------------------------------------------------

export function probLine(v: View, key: string, probs: Probs, picked: Effort | undefined, w: number) {
  const { Box, Text, Raster } = v.t
  const bar = stackCells(probs, picked, 20)
  const roomy = w >= 56
  return (
    <Box>
      <Raster key={key} columns={bar.columns} rows={bar.rows} cells={bar.cells} />
      <Text>{'  '}</Text>
      <Text wrap="truncate-end">
        {EFFORTS.map((e) => (
          <Text color={e === picked ? EFFORT_COLOR[e] : soft(EFFORT_COLOR[e])} bold={e === picked}>
            {(roomy ? EFFORT_SHORT[e] : e[0]) + ' ' + pct(probs[e]) + (e === 'max' ? '' : ' ')}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

export function entry(v: View, e: LogEntry, w: number) {
  const { Box, Text } = v.t
  const rail = e.tone === 'warn' ? WARN : e.tone === 'fail' ? BAD : MUTED
  const iw = w - 2
  return (
    <Box width={w}>
      <Box width={2}>
        <Text color={rail}>{Array(e.probs ? 4 : 3).fill('│').join('\n')}</Text>
      </Box>
      <Box flexDirection="column" width={iw}>
        <Box width={iw}>
          <Text bold>{padL('#' + e.n, 3)}</Text>
          <Text>{'  '}</Text>
          <Text color={outcomeColor(e.outcome)} bold>{padR(e.outcome, 8)}</Text>
          {e.pick?.model ? chip(v.t, e.pick.model) : <Text>{' '.repeat(8)}</Text>}
          <Text>{' '}</Text>
          {e.pick?.effort ? effortTag(v.t, e.pick.effort, 12) : null}
        </Box>
        <Box width={iw}>
          <Text color={MUTED}>{padR(e.feature, 18)}</Text>
          <Text>{fit(e.subject, Math.max(8, iw - 19))}</Text>
        </Box>
        {e.probs ? probLine(v, `p${e.n}`, e.probs, e.pick?.effort, iw - 4) : null}
        <Text color={MUTED}>
          {fit((e.conf !== undefined ? `置信 ${e.conf.toFixed(2)} · ` : '') + (e.fits ? e.fits.map((f) => `${f.name} ${pct(f.fit)}`).join('  ') : e.reason), iw - 1)}
        </Text>
      </Box>
    </Box>
  )
}

export function timelinePane(v: View) {
  const { Box, Button, Text } = v.t
  const turns = [...TURNS].reverse()
  return (
    <Box flexDirection="column" width={v.cols}>
      <Box width={v.cols} justifyContent="space-between">
        <Text>
          <Text color={ACCENT} bold>◆ 决定记录</Text>
          <Text color={MUTED}>{`  共 ${LOG.length} 条，按轮分组`}</Text>
        </Text>
        <Text color={MUTED}>{`原型 ${v.variantName}`}</Text>
      </Box>
      <Text color={MUTED}>{'点击轮标题折叠 / 展开，或聚焦面板后按 1 2 3；/dpp fold <轮>'}</Text>
      <Text>{' '}</Text>
      {turns.map((tn, idx) => {
        const items = LOG.filter((e) => e.turn === tn.turn)
        const isFolded = v.folded.has(tn.turn)
        const warn = items.filter((e) => e.tone === 'warn').length
        const fail = items.filter((e) => e.tone === 'fail').length
        const ok = items.length - warn - fail
        const label = fit(`${isFolded ? '▸' : '▾'} 第 ${tn.turn} 轮  ${tn.prompt}`, Math.max(12, v.cols - 24))
        return (
          <Box flexDirection="column" width={v.cols}>
            <Box width={v.cols}>
              <Button key={`turn-${tn.turn}`} label={label} hotkey={String(idx + 1)} plain onPress={() => v.act.fold(tn.turn)} />
              <Box flexGrow={1} justifyContent="flex-end">
                <Text color={MUTED}>{`${items.length} 条 `}</Text>
                <Text color={OK}>{`✔${ok} `}</Text>
                {warn > 0 ? <Text color={WARN}>{`⚠${warn} `}</Text> : null}
                {fail > 0 ? <Text color={BAD}>{`✘${fail}`}</Text> : null}
              </Box>
            </Box>
            {isFolded ? null : items.map((e) => entry(v, e, v.cols))}
            <Text>{' '}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

// -- footer --------------------------------------------------------------------------

export function timelineFooter(v: View) {
  const { Text } = v.t
  const nodes = allNodes(v.scene)
  const c = counts(nodes)
  const running = nodes.filter((n) => n.state === 'running')
  const latest: Node | undefined = running[running.length - 1] ?? nodes[nodes.length - 1]
  return (
    <Text>
      <Text color={ACCENT} bold>dp </Text>
      {c.running > 0 ? <Text color={ACCENT} bold>{`${SPIN[v.frame % SPIN.length]}${c.running}`}</Text> : <Text color={OK}>✔ 空闲</Text>}
      {c.running > 0 && latest && latest.model && latest.effort ? (
        <Text>
          <Text color={MUTED}>{' · '}</Text>
          <Text color={EFFORT_COLOR[latest.effort]}>{latest.model}</Text>
          <Text color={MUTED}>{`·${latest.effort}`}</Text>
        </Text>
      ) : null}
      {c.failed > 0 ? <Text color={BAD}>{` ✘${c.failed}`}</Text> : null}
    </Text>
  )
}
