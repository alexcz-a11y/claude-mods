// PROTOTYPE variant D, "时间线 + 依据": B's band and pane, C's selection, and the effort rule trace.
//   band   B's ribbon and event stream; every agent row and the main agent can be selected (0-9)
//   pane   top: why the selected one got its model and effort, rule by rule
//          (most likely level, the max threshold, the round-up, the model floor, a forced raise;
//          for the main agent also this turn's mid-turn re-decisions with confidence against
//          the threshold), below: B's log grouped by turn
//   footer B's

import { allNodes, EFFORTS, LOG, RULES, TURNS } from './data'
import type { Effort, Ev, LogEntry, Node, Probs, Scene } from './data'
import {
  ACCENT, BAD, DEFAULT, EFFORT_COLOR, MUTED, OK, WARN,
  chip, effortTag, fit, mmss, packCells, padL, padR, pct, rampAt, rgb, stateGlyph,
} from './kit'
import type { Cell } from './kit'
import { entry, evBody, evGlyph, evStatus, probLine, ribbon, TAG, timelineFooter } from './timeline'
import { events } from './data'
import { elapsed } from './view'
import type { View } from './view'

// -- selection ---------------------------------------------------------------

type Item = { idx: number; name: string; node?: Node }

/** The main agent, then every agent in the order it started, so the band's 1-9 run top to bottom. */
function ordered(s: Scene): Node[] {
  return allNodes(s)
    .map((node, i) => ({ node, i }))
    .sort((a, b) => (a.node.state === 'queued' ? 1 : 0) - (b.node.state === 'queued' ? 1 : 0) || a.node.t0 - b.node.t0 || a.i - b.i)
    .map((x) => x.node)
}

function items(s: Scene): Item[] {
  return [{ idx: 0, name: '主 agent' }, ...ordered(s).map((node, i) => ({ idx: i + 1, name: node.name, node }))]
}

function idxOf(s: Scene, ev: Ev): number | null {
  if (ev.kind === 'main') return 0
  if (!ev.node) return null
  const i = ordered(s).indexOf(ev.node)
  return i < 0 ? null : i + 1
}

// -- band --------------------------------------------------------------------

function selectable(v: View, idx: number, label: string, w: number, bold: boolean, dim: boolean) {
  const { Button, Text } = v.t
  if (idx > 9) return <Text bold={bold} dimColor={dim} wrap="truncate-end">{fit(label, w)}</Text>
  return <Button key={`d-sel-${idx}`} label={fit(label, w - 3)} hotkey={String(idx)} plain dimColor={dim} onPress={() => v.act.select(idx)} />
}

function rowBody(v: View, ev: Ev, idx: number | null, bodyW: number) {
  const { Box, Text } = v.t
  const m = v.scene.main
  if (ev.kind === 'main' && idx !== null) {
    return (
      <Box>
        <Box width={11}>{selectable(v, 0, '主 agent', 11, v.sel === 0, false)}</Box>
        {effortTag(v.t, m.effort, 8)}
        <Text color={m.src === 'notrouted' ? WARN : MUTED} wrap="truncate-end">
          {m.src === 'decided' ? '  已决定 · 选中看依据' : `  ${m.src === 'locked' ? '已锁定' : '未路由'} · ${m.reason}`}
        </Text>
      </Box>
    )
  }
  const n = ev.node
  if (ev.kind !== 'start' || !n || idx === null) return evBody(v, ev, bodyW)
  const nameW = Math.max(8, bodyW - (5 + 9 + 13))
  return (
    <Box>
      <Box width={5}>
        <Text color={MUTED}>{n.n !== undefined ? `#${n.n}` : ' ·'}</Text>
      </Box>
      <Box width={9}>{chip(v.t, n.model, n.routed)}</Box>
      <Box width={13}>{effortTag(v.t, n.effort, 12)}</Box>
      <Box width={nameW}>{selectable(v, idx, n.name, nameW, v.sel === idx || n.state === 'running', n.state === 'done' && v.sel !== idx)}</Box>
    </Box>
  )
}

export function digestBand(v: View) {
  const { t, scene, cols } = v
  const { Box, Text } = t
  const evs = events(scene, v.live)
  if (scene.done) {
    return (
      <Box flexDirection="column" width={cols}>
        {ribbon(v)}
        <Text color={MUTED}>{`空闲 · 本轮 ${allNodes(scene).length} 个 agent 都已结束 · 0-9 选中，/dpp log 看依据`}</Text>
      </Box>
    )
  }
  const cap = Math.max(3, Math.min(8, v.rows - 2))
  const hidden = Math.max(0, evs.length - cap)
  const shown = hidden > 0 ? evs.slice(evs.length - (cap - 1)) : evs
  const statusW = cols >= 110 ? 30 : 16
  const bodyW = Math.min(64, cols - (1 + 5 + 2 + 2 + 9 + statusW))
  const W = 1 + 5 + 2 + 2 + 9 + bodyW + statusW
  return (
    <Box flexDirection="column" width={cols}>
      {ribbon(v)}
      {hidden > 0 ? (
        <Box width={W}>
          <Box width={8}>
            <Text color={MUTED}>{'       ┊'}</Text>
          </Box>
          <Text color={MUTED}>{`  更早 ${hidden + 1} 个事件 · 0-9 选中 · /dpp log 看依据`}</Text>
        </Box>
      ) : null}
      {shown.map((ev, i) => {
        const idx = idxOf(scene, ev)
        const on = idx !== null && idx === v.sel && ev.kind !== 'raise'
        const rail = i === shown.length - 1 ? '└' : i === 0 && hidden === 0 ? '┬' : '├'
        return (
          <Box width={W}>
            <Box width={1}>
              <Text color={ACCENT} bold>{on ? '▌' : ' '}</Text>
            </Box>
            <Box width={5}>
              <Text color={MUTED}>{padL(mmss(ev.t), 4)}</Text>
            </Box>
            <Box width={2}>
              <Text color={MUTED}>{rail}</Text>
            </Box>
            <Box width={2}>{evGlyph(v, ev)}</Box>
            <Box width={9}>
              <Text color={ev.kind === 'raise' ? WARN : on ? ACCENT : MUTED} bold={on}>{TAG[ev.kind]}</Text>
            </Box>
            <Box width={bodyW}>{rowBody(v, ev, ev.kind === 'raise' ? null : idx, bodyW)}</Box>
            <Box width={statusW}>{evStatus(v, ev)}</Box>
          </Box>
        )
      })}
    </Box>
  )
}

// -- the rule trace ------------------------------------------------------------

type Step = { mark: 'hit' | 'pass' | 'lift' | 'raise'; head: string; body: string }

/** pickEffort, step by step, as dispatch-pilot applies it (decision/effort.ts), plus the model floor. */
function trace(probs: Probs, node?: Node): { steps: Step[]; result: Effort } {
  const p = EFFORTS.map((e) => probs[e])
  const top = (count: number) => {
    let best = 0
    for (let i = 1; i < count; i++) if ((p[i] ?? 0) >= (p[best] ?? 0)) best = i
    return best
  }
  const last = EFFORTS.length - 1
  const steps: Step[] = []
  let level = top(EFFORTS.length)
  steps.push({ mark: 'hit', head: '最可能', body: `${EFFORTS[level]} ${pct(p[level] ?? 0)}` })
  if (level === last && (p[level] ?? 0) < RULES.thetaMax) {
    level = top(last)
    steps.push({ mark: 'pass', head: 'max 门槛', body: `max ${pct(p[last] ?? 0)} < ${pct(RULES.thetaMax)}，改取其余最可能的 ${EFFORTS[level]}` })
  }
  const above = level + 1
  if (above <= last) {
    const pa = p[above] ?? 0
    const ok = pa >= RULES.roundUp && (above < last || pa >= RULES.thetaMax)
    steps.push(
      ok
        ? { mark: 'hit', head: '上取一档', body: `${EFFORTS[above]} ${pct(pa)} ≥ ${pct(RULES.roundUp)}，取高一档 ${EFFORTS[above]}` }
        : { mark: 'pass', head: '上取一档', body: `${EFFORTS[above]} ${pct(pa)} < ${pct(RULES.roundUp)}，不上取` },
    )
    if (ok) level = above
  }
  let result = EFFORTS[level] as Effort
  if (node?.model === 'sonnet' || node?.model === 'opus') {
    if (EFFORTS.indexOf(result) < EFFORTS.indexOf('medium')) {
      steps.push({ mark: 'lift', head: '模型下限', body: `${node.model} 至少 medium，${result} 抬到 medium` })
      result = 'medium'
    }
  }
  if (node?.esc) {
    steps.push({ mark: 'raise', head: '强制升档', body: `失败 ${node.esc.failed}、阻塞 ${node.esc.blocked} 后 ${node.esc.from} → ${node.esc.to}` })
    result = node.esc.to
  }
  return { steps, result }
}

const MARK: Record<Step['mark'], { g: string; c: string }> = {
  hit: { g: '●', c: ACCENT },
  pass: { g: '○', c: MUTED },
  lift: { g: '▲', c: OK },
  raise: { g: '↑', c: WARN },
}

/** Confidence against a threshold: a ramp-filled meter with a tick at the threshold. */
function meterCells(conf: number, need: number, columns: number): { columns: number; rows: number; cells: string } {
  const cells: Cell[] = []
  const tick = Math.min(columns - 1, Math.round(need * columns))
  const fill = conf * columns
  const pass = conf >= need
  for (let c = 0; c < columns; c++) {
    if (c === tick) {
      cells.push(['┃', rgb(pass ? '#2BAE9C' : '#D1A21F'), c < fill ? rampAt(0.2 + (c / columns) * 0.4) : DEFAULT])
    } else if (c + 1 <= fill) cells.push(['█', rampAt(0.2 + (c / columns) * 0.4), DEFAULT])
    else if (c < fill) cells.push(['▌', rampAt(0.2 + (c / columns) * 0.4), DEFAULT])
    else cells.push(['─', rgb('#8A9099'), DEFAULT])
  }
  return { columns, rows: 1, cells: packCells(cells) }
}

function midRow(v: View, e: LogEntry, w: number) {
  const { Box, Raster, Text } = v.t
  const m = e.mid
  if (!m || e.conf === undefined) return null
  const at = (x: Effort) => EFFORTS.indexOf(x)
  const dir = at(m.picked) > at(m.current) ? 'up' : at(m.picked) < at(m.current) ? 'down' : 'same'
  const need = dir === 'down' ? Math.max(RULES.thetaDown, RULES.thetaUp) : RULES.thetaUp
  const verdict =
    m.held !== undefined
      ? `保持 ${m.result} · ${m.held}`
      : dir === 'same'
        ? `保持 ${m.result}`
        : e.conf >= need
          ? `${dir === 'up' ? '升到' : '降一档到'} ${m.result}`
          : `保持 ${m.result}`
  const meterW = 16
  return (
    <Box flexDirection="column" width={w}>
      <Box width={w}>
        <Text bold>{padL('#' + e.n, 3)}</Text>
        <Text color={MUTED}>{'  ' + padR(e.subject, 18)}</Text>
        <Text color={MUTED}>建议 </Text>
        <Text color={EFFORT_COLOR[m.picked]} bold>{padR(m.picked, 7)}</Text>
        <Text color={MUTED}>当前 </Text>
        <Text color={EFFORT_COLOR[m.current]}>{m.current}</Text>
      </Box>
      <Box width={w}>
        <Text>{'     '}</Text>
        <Raster key={`d-meter-${e.n}`} columns={meterW} rows={1} cells={meterCells(e.conf, need, meterW).cells} />
        <Text>{' '}</Text>
        <Text bold>{pct(e.conf)}</Text>
        <Text color={MUTED}>{` ${dir === 'same' ? '·' : e.conf >= need ? '≥' : '<'} ${pct(need)} ${dir === 'down' ? '降档线' : '升档线'}  → `}</Text>
        <Text color={m.result === m.current ? MUTED : EFFORT_COLOR[m.result]} bold={m.result !== m.current} wrap="truncate-end">
          {fit(verdict, Math.max(8, w - meterW - 32))}
        </Text>
      </Box>
    </Box>
  )
}

function why(v: View, it: Item, w: number) {
  const { Box, Text } = v.t
  const s = v.scene
  const n = it.node
  const m = s.main
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lines: any[] = []
  const probs = n ? n.probs : m.probs
  const conf = n ? n.conf : m.conf
  const effort = n ? n.effort : m.effort

  // header: what was picked
  lines.push(
    <Box width={w}>
      <Box width={2}>{n ? stateGlyph(v.t, n.state, v.frame, n.routed) : <Text color={ACCENT}>◆</Text>}</Box>
      <Text bold>{fit(it.name, Math.max(10, w - 40))}</Text>
      <Text>{'  '}</Text>
      {n ? chip(v.t, n.model, n.routed) : null}
      <Text>{n ? ' ' : ''}</Text>
      {effortTag(v.t, effort, 12)}
      {n && n.state === 'running' ? <Text color={ACCENT}>{` 运行 ${mmss(elapsed(n, v))}`}</Text> : null}
    </Box>,
  )

  // not routed, failed, queued: the reason is the whole story
  const plain = (color: string, text: string) => (
    <Box width={w}>
      <Text>{'  '}</Text>
      <Text color={color} wrap="truncate-end">{fit(text, w - 3)}</Text>
    </Box>
  )
  if (!n && m.src !== 'decided') {
    lines.push(plain(WARN, `${m.src === 'locked' ? '已锁定' : '未路由'} · ${m.reason}`))
    return lines
  }
  if (n && !n.routed) {
    lines.push(plain(n.model ? WARN : MUTED, n.model ? `未路由 · ${n.why ?? ''} · ${n.reason}` : n.reason))
    return lines
  }
  if (n?.model) lines.push(plain(MUTED, `模型${conf !== undefined ? ` 置信 ${pct(conf)}` : ''} · ${n.reason}`))
  if (n && n.state === 'failed') lines.push(plain(BAD, `失败 · ${n.why ?? ''}`))
  if (!probs) return lines

  // effort: the probabilities, then each rule in the order pickEffort applies them
  lines.push(
    <Box width={w}>
      <Text color={MUTED}>{'  effort  '}</Text>
      {probLine(v, `d-p-${it.idx}`, probs, effort, w - 10)}
    </Box>,
  )
  const tr = trace(probs, n)
  tr.steps.forEach((st, i) => {
    const mk = MARK[st.mark]
    lines.push(
      <Box width={w}>
        <Text color={MUTED}>{i === tr.steps.length - 1 ? '  └ ' : '  ├ '}</Text>
        <Text color={mk.c} bold>{mk.g + ' '}</Text>
        <Text color={st.mark === 'pass' ? MUTED : undefined} bold={st.mark !== 'pass'}>{padR(st.head, 9)}</Text>
        <Text color={st.mark === 'pass' ? MUTED : undefined} wrap="truncate-end">{fit(st.body, w - 18)}</Text>
      </Box>,
    )
  })
  lines.push(
    <Box width={w}>
      <Text color={MUTED}>{'  结果  '}</Text>
      {effortTag(v.t, tr.result, 10)}
      {!n && conf !== undefined ? <Text color={MUTED}>{`   置信 ${pct(conf)}：发消息时只记录，不参与选档`}</Text> : null}
    </Box>,
  )

  // the main agent: this turn's mid-turn re-decisions, confidence against the threshold
  if (!n) {
    const mids = LOG.filter((e) => e.turn === s.turn && e.mid)
    if (mids.length > 0) {
      lines.push(<Text>{' '}</Text>)
      lines.push(
        <Text>
          <Text color={ACCENT} bold>{'  中途重判'}</Text>
          <Text color={MUTED}>{`  升档要置信 ≥ ${pct(RULES.thetaUp)}，降档要 ≥ ${pct(RULES.thetaDown)} 且一次一档，升档后 ${RULES.holdSteps} 步内不降`}</Text>
        </Text>,
      )
      for (const e of mids) {
        const row = midRow(v, e, w - 2)
        if (row) lines.push(<Box paddingLeft={2}>{row}</Box>)
      }
    }
  }
  return lines
}

// -- pane --------------------------------------------------------------------

const FOLD_KEYS = ['a', 'b', 'c', 'd', 'e']

export function digestPane(v: View) {
  const { t, scene, cols } = v
  const { Box, Button, Text } = t
  const list = items(scene)
  const cur = list[Math.max(0, Math.min(list.length - 1, v.sel))] ?? list[0]!
  const turns = [...TURNS].reverse()
  return (
    <Box flexDirection="column" width={cols}>
      <Box width={cols} justifyContent="space-between">
        <Text>
          <Text color={ACCENT} bold>◆ 依据</Text>
          <Text color={MUTED}>{`  ${cur.idx}/${list.length - 1} · `}</Text>
          <Text bold>{fit(cur.name, Math.max(10, cols - 40))}</Text>
        </Text>
        <Text color={MUTED}>{`原型 ${v.variantName}`}</Text>
      </Box>
      <Box>
        <Button key="d-prev" label="‹ 上一个" hotkey="p" onPress={() => v.act.select(Math.max(0, cur.idx - 1))} />
        <Text>{' '}</Text>
        <Button key="d-next" label="下一个 ›" hotkey="n" variant="primary" onPress={() => v.act.select(Math.min(list.length - 1, cur.idx + 1))} />
        <Text color={MUTED}>{'  band 里按 0-9 直接选'}</Text>
      </Box>
      <Text>{' '}</Text>
      <Box flexDirection="column" width={cols} borderStyle="round" borderColor={MUTED} paddingX={1}>
        {why(v, cur, cols - 4)}
      </Box>
      <Text>{' '}</Text>
      <Text>
        <Text color={ACCENT} bold>◆ 决定记录</Text>
        <Text color={MUTED}>{`  共 ${LOG.length} 条，按轮分组 · 按 a b c 折叠`}</Text>
      </Text>
      {turns.map((tn, i) => {
        const its = LOG.filter((e) => e.turn === tn.turn)
        const folded = v.folded.has(tn.turn)
        const warn = its.filter((e) => e.tone === 'warn').length
        const fail = its.filter((e) => e.tone === 'fail').length
        return (
          <Box flexDirection="column" width={cols}>
            <Box width={cols}>
              <Button
                key={`d-turn-${tn.turn}`}
                label={fit(`${folded ? '▸' : '▾'} 第 ${tn.turn} 轮  ${tn.prompt}`, Math.max(12, cols - 24))}
                hotkey={FOLD_KEYS[i]}
                plain
                onPress={() => v.act.fold(tn.turn)}
              />
              <Box flexGrow={1} justifyContent="flex-end">
                <Text color={MUTED}>{`${its.length} 条 `}</Text>
                <Text color={OK}>{`✔${its.length - warn - fail} `}</Text>
                {warn > 0 ? <Text color={WARN}>{`⚠${warn} `}</Text> : null}
                {fail > 0 ? <Text color={BAD}>{`✘${fail}`}</Text> : null}
              </Box>
            </Box>
            {folded ? null : its.map((e) => entry(v, e, cols))}
          </Box>
        )
      })}
    </Box>
  )
}

export const digestFooter = timelineFooter
