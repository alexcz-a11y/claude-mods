// PROTOTYPE variant C, "Tree": the turn as a tree rooted at the main agent.
//   band   root + dispatched agents + Workflow (with its agents as children) + skills;
//          every node numbered, a number key selects it
//   pane   master and detail: the node list on top, the selected node's evidence below
//   footer dp <effort> . node counts

import { allNodes, counts, EFFORTS } from './data'
import type { Effort, Node, Scene } from './data'
import {
  ACCENT, BAD, EFFORT_COLOR, MUTED, OK, SPIN, STATE_COLOR, WARN,
  chip, dw, effortTag, fit, hbar, mmss, padR, pct, pips, soft, stateGlyph,
} from './kit'
import { hiddenSummary, prioritize } from './cockpit'
import { elapsed } from './view'
import type { View } from './view'

/** Selectable items: 0 is the main agent, 1.. the dispatched agents then the Workflow's agents. */
export function treeItems(s: Scene): (Node | null)[] {
  return [null, ...allNodes(s)]
}

function statusText(v: View, n: Node, wide: boolean): { text: string; color: string } {
  if (n.state === 'failed') return { text: `失败 · ${n.why ?? ''}`, color: BAD }
  if (!n.routed && n.model) return { text: `未路由 · ${n.why ?? ''}`, color: WARN }
  if (n.esc) return { text: wide ? `↑ ${n.esc.from}→${n.esc.to} · 失败${n.esc.failed} 阻塞${n.esc.blocked} 提升${n.esc.raised}` : `↑ ${n.esc.from}→${n.esc.to}`, color: WARN }
  if (n.state === 'running') return { text: `运行 ${mmss(elapsed(n, v))}`, color: ACCENT }
  if (n.state === 'queued') return { text: '排队中', color: MUTED }
  return { text: `完成 ${mmss(elapsed(n, v))}`, color: MUTED }
}

function node(v: View, n: Node, idx: number, prefix: string, nameW: number, statusW: number, wide: boolean) {
  const { Box, Button, Text } = v.t
  const selected = v.sel === idx
  const st = statusText(v, n, wide)
  const label = fit(idx <= 9 ? n.name : `${idx}: ${n.name}`, nameW - 3)
  return (
    <Box>
      <Box width={2}>
        <Text color={ACCENT} bold>{selected ? '▌' : ' '}</Text>
      </Box>
      <Text color={MUTED}>{prefix}</Text>
      <Box width={2}>{stateGlyph(v.t, n.state, v.frame, n.routed)}</Box>
      <Box width={nameW}>
        <Button
          key={`node-${idx}`}
          label={label}
          hotkey={idx <= 9 ? String(idx) : undefined}
          plain
          dimColor={!selected && n.state === 'done'}
          onPress={() => v.act.select(idx)}
        />
      </Box>
      <Box width={9}>{chip(v.t, n.model, n.routed)}</Box>
      <Box width={13}>{effortTag(v.t, n.effort, 12)}</Box>
      <Box width={statusW}>
        <Text color={st.color} wrap="truncate-end">{st.text}</Text>
      </Box>
    </Box>
  )
}

export function treeBand(v: View) {
  const { t, scene, cols } = v
  const { Box, Button, Text } = t
  const m = scene.main
  const all = allNodes(scene)
  const wide = cols >= 118
  const W = cols
  const statusW = wide ? 34 : 15
  const longest = Math.max(16, ...all.map((n) => dw(n.name) + 5)) + 3
  const nameW = Math.max(14, Math.min(36, W - (2 + 3 + 2 + 9 + 13 + statusW) - 1, longest))

  const effortW = 2 + 2 + 11 + 2 + 5 + 1 + m.effort.length
  const statusStr =
    m.src === 'decided'
      ? `  已决定${m.conf !== undefined ? ` · 置信 ${m.conf.toFixed(2)}` : ''}${m.step ? `  · ${m.step}` : ''}`
      : m.src === 'locked'
        ? '  已锁定 · /effort'
        : `  未路由 · ${m.reason}`
  const tagStr = wide ? `第 ${scene.turn} 轮 ${mmss(scene.now + v.live)}  原型 ${v.variantName} · 场景 ${v.sceneName}` : `${v.variantName} · ${v.sceneName}`
  const room = Math.max(8, cols - effortW - dw(tagStr) - 2)
  const root = (
    <Box width={cols}>
      <Box width={2}>
        <Text color={ACCENT} bold>{v.sel === 0 ? '▌' : ' '}</Text>
      </Box>
      <Text color={ACCENT} bold>◆ </Text>
      <Button key="node-0" label="主 agent" hotkey="0" plain onPress={() => v.act.select(0)} />
      <Text>{'  '}</Text>
      {pips(t, m.effort)}
      <Text color={m.src === 'notrouted' ? WARN : EFFORT_COLOR[m.effort]} bold>{` ${m.effort}`}</Text>
      <Text color={m.src === 'notrouted' ? WARN : m.src === 'locked' ? ACCENT : MUTED}>{fit(statusStr, room)}</Text>
      <Box flexGrow={1} justifyContent="flex-end">
        <Text color={MUTED}>
          {wide ? `第 ${scene.turn} 轮 ${mmss(scene.now + v.live)}  原型 ` : ''}
          <Text color={ACCENT} bold>{v.variantName}</Text>
          {wide ? ` · 场景 ${v.sceneName}` : ` · ${v.sceneName}`}
        </Text>
      </Box>
    </Box>
  )

  if (scene.done) {
    const c = counts(scene.agents)
    return (
      <Box flexDirection="column" width={cols}>
        {root}
        <Text color={MUTED}>{`  └─ 空闲 · ${c.total} 个 agent 全部完成${c.esc ? `（${c.esc} 次升级）` : ''}${scene.skills.length ? ' · 技能 ' + scene.skills.map((s) => `${s.name} ${pct(s.fit)}`).join('  ') : ''}`}</Text>
      </Box>
    )
  }

  // budget the rows: root, skills and the Workflow header are fixed, agents fill the rest
  const budget = Math.max(5, Math.min(11, v.rows - 1))
  const fixed = 2 + (scene.wf ? 1 : 0)
  const numbered = all.map((n, i) => ({ n, idx: i + 1 }))
  const { shown, hidden } = prioritize(all, Math.max(2, budget - fixed))
  const shownSet = new Set(shown)
  const dispatched = numbered.filter((x) => scene.agents.includes(x.n) && shownSet.has(x.n))
  const children = numbered.filter((x) => scene.wf?.agents.includes(x.n) && shownSet.has(x.n))

  type Row =
    | { kind: 'agent'; n: Node; idx: number }
    | { kind: 'wf' }
    | { kind: 'child'; n: Node; idx: number }
    | { kind: 'more'; hidden: Node[] }
    | { kind: 'morechild'; hidden: Node[] }
    | { kind: 'skills' }
  const hiddenWf = hidden.filter((n) => scene.wf?.agents.includes(n))
  const hiddenDisp = hidden.filter((n) => !scene.wf?.agents.includes(n))
  const rows: Row[] = dispatched.map((x) => ({ kind: 'agent' as const, n: x.n, idx: x.idx }))
  if (hiddenDisp.length > 0) rows.push({ kind: 'more', hidden: hiddenDisp })
  if (scene.wf) {
    rows.push({ kind: 'wf' })
    for (const x of children) rows.push({ kind: 'child', n: x.n, idx: x.idx })
    if (hiddenWf.length > 0) rows.push({ kind: 'morechild', hidden: hiddenWf })
  }
  rows.push({ kind: 'skills' })

  const lastTop = (() => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i]?.kind !== 'child' && rows[i]?.kind !== 'morechild') return i
    return rows.length - 1
  })()

  return (
    <Box flexDirection="column" width={cols}>
      {root}
      {rows.map((r, i) => {
        const isLast = i === lastTop
        const branch = isLast ? '└─ ' : '├─ '
        if (r.kind === 'agent') return node(v, r.n, r.idx, branch, nameW, statusW, wide)
        if (r.kind === 'child' || r.kind === 'morechild') {
          const after = rows.slice(i + 1)
          const isLastChild = after.every((x) => x.kind !== 'child' && x.kind !== 'morechild')
          const rail = after.some((x) => x.kind !== 'child' && x.kind !== 'morechild') ? '│  ' : '   '
          const prefix = rail + (isLastChild ? '└─ ' : '├─ ')
          if (r.kind === 'child') return node(v, r.n, r.idx, prefix, nameW - 3, statusW, wide)
          return (
            <Box width={W}>
              <Box width={2}>
                <Text>{' '}</Text>
              </Box>
              <Text color={MUTED}>{prefix + hiddenSummary(r.hidden)}</Text>
            </Box>
          )
        }
        if (r.kind === 'wf' && scene.wf) {
          const wc = counts(scene.wf.agents)
          return (
            <Box width={W}>
              <Box width={2}>
                <Text>{' '}</Text>
              </Box>
              <Text color={MUTED}>{branch}</Text>
              <Box width={2}>
                <Text color={ACCENT}>◈</Text>
              </Box>
              <Text bold wrap="truncate-end">{`Workflow ${scene.wf.name}`}</Text>
              <Text color={MUTED}>{'   '}</Text>
              <Text color={ACCENT}>{'▰'.repeat(wc.done)}</Text>
              <Text color={MUTED}>{'▱'.repeat(wc.total - wc.done)}</Text>
              <Text bold>{` ${wc.done}`}</Text>
              <Text color={MUTED}>{` / ${wc.total}`}</Text>
              {wc.failed > 0 ? <Text color={BAD}>{`  ✘${wc.failed}`}</Text> : null}
            </Box>
          )
        }
        if (r.kind === 'more') {
          return (
            <Box width={W}>
              <Box width={2}>
                <Text>{' '}</Text>
              </Box>
              <Text color={MUTED}>{branch + hiddenSummary(r.hidden)}</Text>
            </Box>
          )
        }
        return (
          <Box width={W}>
            <Box width={2}>
              <Text>{' '}</Text>
            </Box>
            <Text color={MUTED}>{branch}</Text>
            <Box width={2}>
              <Text color="suggestion">⚑</Text>
            </Box>
            <Text bold>{'技能  '}</Text>
            <Text wrap="truncate-end">
              {scene.skills.length === 0 ? <Text color={MUTED}>本轮无建议</Text> : null}
              {scene.skills.map((s, k) => (
                <Text>
                  {k > 0 ? <Text color={MUTED}>{'  ·  '}</Text> : null}
                  {s.name}
                  <Text color={OK}>{' ' + pct(s.fit)}</Text>
                </Text>
              ))}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

// -- pane: master and detail -----------------------------------------------------------

function probRows(v: View, probs: Record<Effort, number>, picked: Effort | undefined, w: number) {
  const { Box, Text } = v.t
  const barW = Math.max(8, Math.min(36, w - 22))
  return (
    <Box flexDirection="column">
      {EFFORTS.map((e) => {
        const on = e === picked
        return (
          <Box>
            <Text color={on ? EFFORT_COLOR[e] : MUTED} bold={on}>{padR(e, 8)}</Text>
            <Text color={on ? EFFORT_COLOR[e] : soft(EFFORT_COLOR[e])}>{hbar(probs[e], barW)}</Text>
            <Text color={on ? undefined : MUTED} bold={on}>{' ' + pct(probs[e])}</Text>
            <Text color={EFFORT_COLOR[e]}>{on ? '  ◂ 选中' : ''}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

export function treePane(v: View) {
  const { t, scene, cols } = v
  const { Box, Button, Text } = t
  const items = treeItems(scene)
  const idx = Math.max(0, Math.min(items.length - 1, v.sel))
  const cur = items[idx] ?? null
  const m = scene.main

  const list = items.map((n, i) => {
    const selected = i === idx
    const name = n === null ? '主 agent' : n.name
    const nameW = Math.max(14, cols - 2 - 2 - 10 - 1)
    return (
      <Box width={cols}>
        <Box width={2}>
          <Text color={ACCENT} bold>{selected ? '▌' : ' '}</Text>
        </Box>
        <Box width={2}>
          {n === null ? <Text color={ACCENT}>◆</Text> : stateGlyph(t, n.state, v.frame, n.routed)}
        </Box>
        <Box width={nameW}>
          <Button
            key={`item-${i}`}
            label={fit(i <= 9 ? name : `${i}: ${name}`, nameW - 3)}
            hotkey={i <= 9 ? String(i) : undefined}
            plain
            dimColor={!selected}
            onPress={() => v.act.select(i)}
          />
        </Box>
        <Box width={10}>{n === null ? <Text color={EFFORT_COLOR[m.effort]}>{m.effort}</Text> : chip(t, n.model, n.routed)}</Box>
      </Box>
    )
  })

  // the detail card
  let detail
  if (cur === null) {
    detail = (
      <Box flexDirection="column">
        <Text>
          <Text color={ACCENT} bold>◆ 主 agent</Text>
          <Text color={m.src === 'notrouted' ? WARN : MUTED}>
            {m.src === 'decided' ? '  已决定' : m.src === 'locked' ? '  已锁定' : '  未路由'}
          </Text>
          {m.n !== undefined ? <Text color={MUTED}>{`  #${m.n}`}</Text> : null}
        </Text>
        <Text>
          <Text color={MUTED}>{padR('effort', 8)}</Text>
          {effortTag(t, m.effort, 12)}
          {m.conf !== undefined ? <Text color={MUTED}>{`   置信 ${m.conf.toFixed(2)}`}</Text> : null}
        </Text>
        {m.step ? (
          <Text>
            <Text color={MUTED}>{padR('轮中', 8)}</Text>
            {m.step}
          </Text>
        ) : null}
        <Text wrap="truncate-end">
          <Text color={MUTED}>{padR('理由', 8)}</Text>
          <Text color={m.src === 'notrouted' ? WARN : undefined}>{m.reason}</Text>
        </Text>
        {m.probs ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={MUTED}>effort 概率</Text>
            {probRows(v, m.probs, m.effort, cols)}
          </Box>
        ) : null}
      </Box>
    )
  } else {
    const n = cur
    const stateWord = n.state === 'running' ? `运行 ${mmss(elapsed(n, v))}` : n.state === 'done' ? `完成 ${mmss(elapsed(n, v))}` : n.state === 'failed' ? '失败' : '排队中'
    detail = (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          {stateGlyph(t, n.state, v.frame, n.routed)}
          <Text bold>{` ${n.name}`}</Text>
          {n.n !== undefined ? <Text color={MUTED}>{`  #${n.n}`}</Text> : null}
          <Text color={STATE_COLOR[n.state]}>{`   ${stateWord}`}</Text>
        </Text>
        <Text color={MUTED}>{`${n.kind === 'wf' ? 'Workflow ' + (scene.wf?.name ?? '') : n.type} · 开始于 ${mmss(n.t0)}`}</Text>
        <Box marginTop={1}>
          <Text color={MUTED}>{padR('模型', 8)}</Text>
          {chip(t, n.model, n.routed)}
          <Text>{'   '}</Text>
          {effortTag(t, n.effort, 12)}
        </Box>
        {n.conf !== undefined ? (
          <Box>
            <Text color={MUTED}>{padR('置信', 8)}</Text>
            <Text color={OK}>{hbar(n.conf, 20)}</Text>
            <Text>{' ' + n.conf.toFixed(2)}</Text>
          </Box>
        ) : null}
        <Text wrap="truncate-end">
          <Text color={MUTED}>{padR('理由', 8)}</Text>
          {n.reason}
        </Text>
        {n.why ? (
          <Text wrap="truncate-end">
            <Text color={MUTED}>{padR(n.state === 'failed' ? '失败' : '未路由', 8)}</Text>
            <Text color={n.state === 'failed' ? BAD : WARN}>{n.why}</Text>
          </Text>
        ) : null}
        {n.esc ? (
          <Text wrap="truncate-end">
            <Text color={MUTED}>{padR('升级', 8)}</Text>
            <Text color={WARN}>{`${n.esc.from} → ${n.esc.to}  `}</Text>
            {`失败 ${n.esc.failed} · 阻塞 ${n.esc.blocked} · 提升 ${n.esc.raised}`}
          </Text>
        ) : null}
        {n.probs ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={MUTED}>{n.esc ? `起步 effort 概率（${n.esc.from} 起步，后被提升）` : 'effort 概率'}</Text>
            {probRows(v, n.probs, n.esc ? n.esc.from : n.effort, cols)}
          </Box>
        ) : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={cols}>
      <Box width={cols} justifyContent="space-between">
        <Text>
          <Text color={ACCENT} bold>◆ 节点详情</Text>
          <Text color={MUTED}>{`  ${idx + 1} / ${items.length}`}</Text>
        </Text>
        <Text color={MUTED}>{`原型 ${v.variantName}`}</Text>
      </Box>
      <Box>
        <Button key="prev" label="‹ 上一个" hotkey="p" onPress={() => v.act.select(Math.max(0, idx - 1))} />
        <Text>{' '}</Text>
        <Button key="next" label="下一个 ›" hotkey="n" variant="primary" onPress={() => v.act.select(Math.min(items.length - 1, idx + 1))} />
        <Text color={MUTED}>{'  数字键直接选；/dpp sel <n>'}</Text>
      </Box>
      {v.placement === 'inline' ? null : (
        <Box flexDirection="column" width={cols}>
          <Text>{' '}</Text>
          {list}
          <Text color={MUTED}>{'─'.repeat(Math.max(10, cols - 1))}</Text>
        </Box>
      )}
      {v.placement === 'inline' ? <Text color={MUTED}>{`▌ ${idx === 0 ? '主 agent' : (cur?.name ?? '')}`}</Text> : null}
      {detail}
    </Box>
  )
}

// -- footer --------------------------------------------------------------------------

export function treeFooter(v: View) {
  const { Text } = v.t
  const m = v.scene.main
  const c = counts(allNodes(v.scene))
  return (
    <Text>
      <Text color={ACCENT} bold>dp </Text>
      <Text color={m.src === 'notrouted' ? WARN : EFFORT_COLOR[m.effort]} bold>{`◆ ${m.effort}`}</Text>
      <Text color={MUTED}>{v.scene.done ? ` └${c.total} 空闲` : c.total > 0 ? ` ├${c.total} ` : ' └无'}</Text>
      {c.running > 0 ? <Text color={ACCENT} bold>{`${SPIN[v.frame % SPIN.length]}${c.running} `}</Text> : null}
      {c.done > 0 && !v.scene.done ? <Text color={OK}>{`✔${c.done} `}</Text> : null}
      {c.failed > 0 ? <Text color={BAD}>{`✘${c.failed}`}</Text> : null}
    </Text>
  )
}
