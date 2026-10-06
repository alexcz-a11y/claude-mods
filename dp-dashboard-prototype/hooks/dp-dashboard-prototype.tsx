// PROTOTYPE, throwaway. Plan: Three variants of dispatch-pilot's CLI UI (footer summary + band dashboard + diagnostics pane), switchable with /dpp, fake data.
//
// Surfaces drawn (terminal only, every other surface gets next(e)):
//   SessionMode  a short always-visible summary at the right of the prompt footer
//   AbovePrompt  the live dashboard band (collapse it with the engine's [-] or ctrl+x ctrl+a)
//   Pane         diagnostics, opened by /dpp log
//
// Everything is fake and in memory: no network, no model calls, no $.state or $.store.

import type { Register, Timer } from 'claude-code'
import { SCENES, SCENE_KEYS, allNodes, counts } from './proto/data'
import type { SceneKey } from './proto/data'
import { cockpitBand, cockpitFooter, cockpitPane } from './proto/cockpit'
import { timelineBand, timelineFooter, timelinePane } from './proto/timeline'
import { treeBand, treeFooter, treePane } from './proto/tree'
import { digestBand, digestFooter, digestPane } from './proto/digest'
import type { Actions, View } from './proto/view'

type VKey = 'a' | 'b' | 'c' | 'd'

const VARIANTS = {
  a: { name: 'A · Cockpit', band: cockpitBand, pane: cockpitPane, footer: cockpitFooter },
  b: { name: 'B · Timeline', band: timelineBand, pane: timelinePane, footer: timelineFooter },
  c: { name: 'C · Tree', band: treeBand, pane: treePane, footer: treeFooter },
  d: { name: 'D · 时间线+依据', band: digestBand, pane: digestPane, footer: digestFooter },
}

const PANE = 'dpp-log'
const TICK = 125 // ms per animation frame
const DEBUG = false

export const register: Register = (on) => {
  let vk: VKey = 'd'
  let sk: SceneKey = 'agents'
  let frame = 0
  let frame0 = 0
  let sel = 0
  let statusOn = false
  let shownStatus: string | undefined
  let play: Timer | undefined
  const folded = new Set<number>([6])

  const scene = () => SCENES[sk]
  const live = () => Math.floor(((frame - frame0) * TICK) / 1000)
  const isAnimating = () => allNodes(scene()).some((n) => n.state === 'running')
  const nodeCount = () => 1 + allNodes(scene()).length // 0 is the main agent
  const clampSel = () => {
    sel = Math.max(0, Math.min(nodeCount() - 1, sel))
  }
  const statusText = () => {
    const s = scene()
    const c = counts(allNodes(s))
    return `dp ${s.main.effort}${s.main.src === 'notrouted' ? ' (未路由)' : ''} · agent ${c.running}/${c.total}`
  }

  const view = (t: View['t'], act: Actions, cols: number, rows: number, placement?: 'dock' | 'inline'): View => {
    clampSel()
    return {
      t,
      scene: scene(),
      frame,
      live: live(),
      cols,
      rows,
      sel,
      folded,
      act,
      variantName: VARIANTS[vk].name,
      sceneName: sk + (DEBUG ? ` r${rows} c${cols}` : ''),
      placement,
    }
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dpp',
      description: '原型：切换 dispatch-pilot 终端界面的四个方案（假数据）',
      argumentHint: '[a|b|c|d|next|scene <名>|play|stop|log|close|sel <n>|fold <轮>|status on|off]',
    })
    $.clock.every(TICK, () => {
      frame += 1
      if (isAnimating()) {
        $.ui.invalidate('ui.render')
        if (statusOn && statusText() !== shownStatus) {
          shownStatus = statusText()
          $.ui.status(shownStatus)
        }
      }
    })
    return next(e)
  })

  on('command.run', { command: 'dpp' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const cmd = (words[0] ?? '').toLowerCase()
    const arg = (words[1] ?? '').toLowerCase()

    const retitle = async () => {
      const open = await $.ui.panes()
      if (open.some((p) => p.id === PANE)) await $.ui.open({ id: PANE, title: `诊断 · ${VARIANTS[vk].name}` })
    }
    const setScene = (k: SceneKey) => {
      sk = k
      frame0 = frame
      sel = 0
      $.ui.toast(`场景 ${k} · ${SCENES[k].label}`)
      if (statusOn) {
        shownStatus = statusText()
        $.ui.status(shownStatus)
      }
      $.ui.invalidate('ui.render')
    }
    const setVariant = async (k: VKey) => {
      vk = k
      $.ui.toast(`原型 ${VARIANTS[k].name}`)
      $.ui.invalidate('ui.render')
      await retitle()
    }

    const state = () => `原型 ${VARIANTS[vk].name} · 场景 ${sk}${play ? ' · 自动播放' : ''}`

    if (cmd === 'a' || cmd === 'b' || cmd === 'c' || cmd === 'd') {
      await setVariant(cmd)
      return { text: `dpp: ${state()}` }
    }
    if (cmd === 'next') {
      await setVariant(vk === 'a' ? 'b' : vk === 'b' ? 'c' : vk === 'c' ? 'd' : 'a')
      return { text: `dpp: ${state()}` }
    }
    if (cmd === 'scene') {
      const hit = SCENE_KEYS.find((k) => k === arg)
      if (arg === 'next') {
        setScene(SCENE_KEYS[(SCENE_KEYS.indexOf(sk) + 1) % SCENE_KEYS.length] ?? 'running')
      } else if (hit) {
        setScene(hit)
      } else {
        return { text: `dpp: 场景有 ${SCENE_KEYS.join(' | ')}` }
      }
      return { text: `dpp: ${state()}` }
    }
    if (cmd === 'play') {
      play?.cancel()
      play = $.clock.every(3000, () => {
        setScene(SCENE_KEYS[(SCENE_KEYS.indexOf(sk) + 1) % SCENE_KEYS.length] ?? 'running')
      })
      return { text: `dpp: 自动播放，每 3 秒换一个场景（/dpp stop 停止）` }
    }
    if (cmd === 'stop') {
      play?.cancel()
      play = undefined
      return { text: `dpp: 已停止自动播放 · ${state()}` }
    }
    if (cmd === 'log') {
      const placed = await $.ui.open({ id: PANE, title: `诊断 · ${VARIANTS[vk].name}` })
      return { text: placed.isPlaced ? `dpp: 诊断面板已打开 · ${state()}` : `dpp: 面板没有放下：${placed.reason}` }
    }
    if (cmd === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'dpp: 诊断面板已关闭' }
    }
    if (cmd === 'sel') {
      const n = Number(arg)
      if (arg === 'next') sel += 1
      else if (arg === 'prev') sel -= 1
      else if (Number.isInteger(n) && n >= 0) sel = n
      clampSel()
      $.ui.invalidate('ui.render')
      return { text: `dpp: 选中 ${sel === 0 ? '主 agent' : '节点 ' + sel}` }
    }
    if (cmd === 'fold') {
      const turn = Number(arg)
      if (Number.isInteger(turn)) {
        if (folded.has(turn)) folded.delete(turn)
        else folded.add(turn)
      }
      $.ui.invalidate('ui.render')
      return { text: `dpp: 已折叠的轮 ${[...folded].join(', ') || '无'}` }
    }
    if (cmd === 'status') {
      statusOn = arg !== 'off'
      shownStatus = statusOn ? statusText() : undefined
      $.ui.status(shownStatus)
      return { text: `dpp: $.ui.status 一行摘要${statusOn ? '已开' : '已关'}` }
    }
    return {
      text: [
        `dpp: ${state()}`,
        '  /dpp a|b|c|d|next        切换方案（d：时间线+依据）',
        `  /dpp scene <名>          固定场景：${SCENE_KEYS.join(' ')}`,
        '  /dpp play | stop         每 3 秒自动换场景',
        '  /dpp log | close         诊断面板',
        '  /dpp sel <n>|next|prev   选中节点（方案 C、D；0 是主 agent）',
        '  /dpp fold <轮>           折叠或展开一轮（方案 B 的面板）',
        '  /dpp status on|off       $.ui.status 一行摘要',
      ].join('\n'),
    }
  })

  // The band above the prompt: the live dashboard.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const t = $.ui.resolve(e)
    const act: Actions = {
      select: (i) => {
        sel = i
        $.ui.invalidate('ui.render')
      },
      fold: (turn) => {
        if (folded.has(turn)) folded.delete(turn)
        else folded.add(turn)
        $.ui.invalidate('ui.render')
      },
      openLog: () => {
        void $.ui.open({ id: PANE, title: `诊断 · ${VARIANTS[vk].name}` })
      },
    }
    const v = view(t, act, e.props.bodyColumns, e.props.maxRows)
    // squeezed (an inline pane took the room): one summary line instead of the dashboard
    if (e.props.maxRows < 4) {
      const { Box, Text } = t
      return (
        <Box>
          {VARIANTS[vk].footer(v)}
          <Text dimColor>{`  原型 ${v.variantName} · 场景 ${v.sceneName}`}</Text>
        </Box>
      )
    }
    return VARIANTS[vk].band(v)
  })

  // The diagnostics pane: opened by /dpp log.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const t = $.ui.resolve(e)
    const act: Actions = {
      select: (i) => {
        sel = i
        $.ui.invalidate('ui.render')
      },
      fold: (turn) => {
        if (folded.has(turn)) folded.delete(turn)
        else folded.add(turn)
        $.ui.invalidate('ui.render')
      },
      openLog: () => {
        void $.ui.open({ id: PANE, title: `诊断 · ${VARIANTS[vk].name}` })
      },
    }
    return VARIANTS[vk].pane(view(t, act, e.props.bodyColumns, e.props.scroll.bodyRows, e.props.placement))
  })

  // The right end of the prompt footer: a short summary, the engine's own modes kept.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const t = $.ui.resolve(e)
    const { Box } = t
    const act: Actions = { select: () => {}, fold: () => {}, openLog: () => {} }
    const own = await next(e)
    return (
      <Box gap={1}>
        {own}
        {VARIANTS[vk].footer(view(t, act, 40, 1))}
      </Box>
    )
  })
}
