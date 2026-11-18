import { expect, test } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'

import { PANE_ID, TONE_LOOK } from '../hooks/board/board.tsx'
import { boardModel } from '../hooks/board/model.ts'
import { displayWidth, paneSections, runsOf, timelineRows } from '../hooks/board/view.ts'
import type { Tone } from '../hooks/board/view.ts'
import { readConfig } from '../hooks/config.ts'
import { openStep, readout } from '../hooks/flows/readout.ts'
import type { Decision } from '../hooks/log.ts'
import { amendSent, record, redraw } from '../hooks/runtime.ts'
import { SCENES } from './support/scenes.ts'
import { standIn } from './support/standin.ts'
import { KEYS, complete, dp, start, step, turnStart, world } from './support/world.ts'

const BAND = { plugin: 'dispatch-pilot', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} } } as const
const PANE = { plugin: 'dispatch-pilot', component: 'Pane', requestId: 'dispatch-pilot', surface: 'terminal', props: { title: 'Dispatch Pilot', isFocused: false, bodyColumns: 46, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const FOOTER = { plugin: 'dispatch-pilot', component: 'SessionMode', requestId: 'mode', surface: 'terminal', props: { modes: ['focus'] } } as const

/** The theme keys a tree may name (ThemeKey in the generated types): the board names no other colour. */
const THEME_KEYS = ['text', 'inverseText', 'inactive', 'subtle', 'suggestion', 'remember', 'success', 'error', 'warning', 'merged', 'claude', 'permission', 'planMode', 'autoAccept', 'promptBorder', 'bashBorder', 'ide', 'diffAdded', 'diffRemoved', 'diffAddedDimmed', 'diffRemovedDimmed', 'diffAddedWord', 'diffRemovedWord']

const OPUS = 'claude-opus-5-5'
const MESSAGES = 'https://api.anthropic.com/v1/messages?beta=true'

/** Every colour named in a drawn tree. */
function colours(node: unknown): unknown[] {
  if (node === null || typeof node !== 'object') return []
  const n = node as { props?: Record<string, unknown>; children?: unknown[] }
  const own = n.props === undefined ? [] : ['color', 'backgroundColor'].flatMap((k) => (n.props?.[k] === undefined ? [] : [n.props[k]]))
  return [...own, ...(n.children ?? []).flatMap(colours)]
}

/**
 * Closes the board's pane the way /dp does not: the kit's own $ raises no ui.close (its ui noun has render, scroll and
 * focus), so another plugin's $.ui.close stands in for the person's close key or mark. Every close passes the same
 * ui.close chain.
 */
const CLOSER: Plugin = {
  name: 'pane-closer',
  register(on) {
    on('command.run', { command: 'close-dp-pane' }, async ($) => {
      await $.ui.close({ id: 'dispatch-pilot' })
      return { text: 'closed' }
    })
  },
}

function decision(over: Partial<Decision> = {}): Decision {
  return { id: 'd1', at: 1, kind: 'submit', backend: 'drex', model: 'drex-max-v1.1', ms: 300, raw: null, from: 'medium', to: 'high', reason: 'more-open', detail: '', turnId: 't1', step: 0, bars: null, failure: null, requestId: null, applied: true, sent: null, ...over }
}

// The brief's ten.

test('时间轴：档位、状态、下次评估、换挡的原因都在', { options: KEYS }, async ($, on) => {
  world(on, { scene: SCENES.up })
  await start($)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /已发出/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /下一份脚本结果到达时/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /同一失败在修改后又出现/ })).toBeTruthy()
  // What the rest of the chain draws for this row stays under the timeline.
  const tree = (await ui.drawn()) as { children?: unknown[] }
  expect(tree.children?.at(-1)).toMatchObject({ type: 'engine' })
  await ui.unmount()
})

test('要的档和实际发出的不一样：两个都写', { options: KEYS }, async ($, on) => {
  world(on, { scene: SCENES.notsent })
  await start($)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /要 xhigh，实际发出 high/ }))?.text).toMatch(/^▮▮▮▯▯ high  ! 要 xhigh，实际发出 high/)
  await ui.unmount()
})

test('面板开着时时间轴没有「上次评估」那一行', { options: KEYS }, async ($, on) => {
  const w = world(on, { scene: SCENES.up, pane: 'placed' })
  await start($)
  expect(await dp($)).toBe('面板已打开。')
  expect(w.panes).toEqual([{ id: PANE_ID, title: 'Dispatch Pilot', isShown: true, isFocused: false, isPlaced: true }])
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /已发出/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /同一失败在修改后又出现/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /上次评估/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /生效/ })).toBe(undefined)
  await ui.unmount()
})

test('面板：分区的标题按顺序出现', { options: KEYS }, async ($, on) => {
  world(on, { scene: SCENES.up, pane: 'placed' })
  await start($)
  const ui = await $.ui.mount(PANE)
  const titles = await ui.findAll({ type: 'Text', text: /^(现在|换挡记录|上次评估|下次评估|功能|agent)$/ })
  expect(titles.map((t) => t.text)).toEqual(['现在', '换挡记录', '上次评估', '下次评估', '功能', 'agent'])
  expect(titles.map((t) => t.props.color)).toEqual(['claude', 'claude', 'claude', 'claude', 'claude', 'claude'])
  expect(await ui.find({ type: 'Text', text: 'high    ████████ 0.46  ◂ 现在' })).toBeTruthy()
  await ui.unmount()
})

test('/dp：放得下就打开面板，再输一次关上', { options: KEYS }, async ($, on) => {
  const w = world(on, { pane: 'placed' })
  await start($)
  expect(await dp($)).toBe('面板已打开。')
  expect(w.opened).toEqual([{ id: PANE_ID, title: 'Dispatch Pilot' }])
  expect(w.panes.map((p) => p.id)).toEqual([PANE_ID])
  expect(await dp($)).toBe('面板已关上。')
  expect(w.closed).toEqual([PANE_ID])
  expect(w.panes).toEqual([])
  expect(await dp($)).toBe('面板已打开。')
})

test('/dp：放不下回文字版并写明原因', { options: KEYS }, async ($, on) => {
  const w = world(on)
  await start($)
  const text = await dp($)
  expect(text.startsWith('面板放不出来（too narrow），下面是文字版。')).toBe(true)
  expect(text).toContain('锁定：没有')
  expect(text).toContain('Drex（drex-max-v1.1）· 可用')
  // The pane is closed again, so it does not turn up later on its own.
  expect(w.opened.map((p) => p.id)).toEqual([PANE_ID])
  expect(w.closed).toEqual([PANE_ID])
  expect(w.panes).toEqual([])
})

test('board 关着：不画时间轴，/dp 回文字版', { options: { ...KEYS, board: false }, plugins: [CLOSER] }, async ($, on) => {
  const w = world(on, { scene: SCENES.up, pane: 'placed' })
  await start($)
  const ui = await $.ui.mount(BAND)
  expect(await ui.drawn()).toMatchObject({ type: 'engine' })
  expect(await ui.find({ type: 'Text', text: /已发出/ })).toBe(undefined)
  await ui.unmount()
  const text = await dp($)
  expect(text).toContain('锁定：没有')
  expect(text).not.toContain('面板')
  expect(w.opened).toEqual([])
  const foot = await $.ui.mount(FOOTER)
  expect(w.footers).toEqual([['focus']])
  await foot.unmount()
  // No ui.close hook either: a close reaches the engine and nothing is drawn again.
  await $.command.run({ command: 'close-dp-pane', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(w.closed).toEqual([PANE_ID])
  expect(w.invalidated).toEqual([])
})

test('折叠着、有调查问卷、或别的端：原样交给 next', { options: KEYS }, async ($, on) => {
  world(on, { scene: SCENES.up })
  await start($)
  const cases = [
    { ...BAND, props: { ...BAND.props, isCollapsed: true } },
    { ...BAND, props: { ...BAND.props, hasSurvey: true } },
    { ...BAND, surface: 'vscode' },
  ] as const
  for (const target of cases) {
    const ui = await $.ui.mount(target)
    expect(await ui.drawn()).toMatchObject({ type: 'engine' })
    expect(await ui.find({ type: 'Text', text: /已发出/ })).toBe(undefined)
    await ui.unmount()
  }
  // The same mount on the terminal, uncollapsed, draws it.
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /已发出/ })).toBeTruthy()
  await ui.unmount()
})

test('maxRows 只有 2：只画前两行', { options: KEYS }, async ($, on) => {
  world(on, { scene: SCENES.up })
  await start($)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, maxRows: 2 } })
  expect(await ui.find({ type: 'Text', text: /已发出/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /下次评估/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /同一失败在修改后又出现/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /上次评估/ })).toBe(undefined)
  await ui.unmount()
})

test('读状态出错时不抛，时间轴交给 next', { options: KEYS }, async ($, on) => {
  const w = world(on, { refuse: ['state.get'] })
  await start($)
  const ui = await $.ui.mount(BAND)
  expect(await ui.drawn()).toMatchObject({ type: 'engine' })
  expect(await ui.find({ type: 'Text', text: /已发出/ })).toBe(undefined)
  await ui.unmount()
  expect(w.debugLogs.some((l) => l.startsWith('ui.render failed open:'))).toBe(true)
  // The pane and the footer pass as well.
  const pane = await $.ui.mount(PANE)
  expect(await pane.drawn()).toMatchObject({ type: 'engine' })
  await pane.unmount()
  const foot = await $.ui.mount(FOOTER)
  expect(w.footers).toEqual([['focus']])
  await foot.unmount()
})

// What the ten do not reach.

test('脚部：引擎自己的标签留着，后面加上 dp 的', { options: KEYS }, async ($, on) => {
  const w = world(on, { scene: SCENES.notsent })
  await start($)
  const ui = await $.ui.mount(FOOTER)
  expect(w.footers).toEqual([['focus', 'dp high !']])
  await ui.unmount()
})

test('面板在 30 列里：成段的行放得下，整句留着', { options: KEYS }, async ($, on) => {
  world(on, { scene: SCENES.notsent, pane: 'placed' })
  await start($)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 30 } })
  const bars = await ui.findAll({ type: 'Text', text: /^(max|xhigh|high|medium|low) +[█▏]/ })
  expect(bars.map((b) => b.text)).toEqual(['max     █████     0.28', 'xhigh   █████████ 0.52', 'high    ███       0.15  ◂ 现在', 'medium  █         0.04', 'low     ▏         0.01'])
  expect(bars.every((b) => displayWidth(b.text) <= 30)).toBe(true)
  // A sentence is kept whole: the terminal wraps it.
  expect(await ui.find({ type: 'Text', text: '第 7 步后  high → xhigh（还没发出）' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '! 要 xhigh，实际发出 high' })).toBeTruthy()
  await ui.unmount()
})

test('颜色只用主题键：每种 Tone 都有，画出来的树里也只有主题键', { options: KEYS }, async ($, on) => {
  const tones = Object.keys(TONE_LOOK) as Tone[]
  expect(tones.sort()).toEqual(['accent', 'dim', 'err', 'high', 'info', 'low', 'max', 'medium', 'ok', 'plain', 'warn', 'xhigh'])
  for (const tone of tones) {
    const look = TONE_LOOK[tone]
    expect([tone, look.color === undefined || THEME_KEYS.includes(look.color)]).toEqual([tone, true])
  }
  expect(TONE_LOOK).toMatchObject({ dim: { dimColor: true }, ok: { color: 'success' }, warn: { color: 'warning' }, err: { color: 'error' }, info: { color: 'permission' }, accent: { color: 'claude' } })
  expect([TONE_LOOK.low, TONE_LOOK.medium, TONE_LOOK.high, TONE_LOOK.xhigh, TONE_LOOK.max]).toEqual([{ color: 'inactive' }, { color: 'suggestion' }, { color: 'warning' }, { color: 'claude' }, { color: 'error' }])
  // Every tone the six scenes use is one of them.
  const cfg = readConfig(KEYS)
  for (const scene of Object.values(SCENES)) {
    const m = boardModel(cfg, scene)
    const rows = [...timelineRows(m, { columns: 120, isPaneOpen: false }), ...paneSections(m).flatMap((s) => s.rows)]
    for (const run of rows.flatMap((r) => r.parts.flatMap(runsOf))) expect(tones.includes(run.tone)).toBe(true)
  }
  // And what is drawn names theme keys alone.
  world(on, { scene: SCENES.notsent })
  await start($)
  for (const target of [BAND, PANE]) {
    const ui = await $.ui.mount(target)
    const named = colours(await ui.drawn())
    expect(named.length).toBeGreaterThan(5)
    expect(named.filter((c) => typeof c !== 'string' || !THEME_KEYS.includes(c))).toEqual([])
    await ui.unmount()
  }
})

test('重画：开了新格、一轮结束、/dp lock 和 unlock、开关面板之后各一次', { options: KEYS }, async ($, on) => {
  const w = world(on, { pane: 'placed' })
  await start($)
  await turnStart($, 't1', 'Fix the flaky retry in the uploader')
  const since = (n: number) => w.invalidated.slice(n)
  let n = w.invalidated.length
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  expect(since(n)).toEqual(['ui.render'])
  // A second request of the same work step opens no cell.
  n = w.invalidated.length
  await step($, { turnId: 't1', index: 1, effort: 'medium' })
  expect(since(n)).toEqual([])
  n = w.invalidated.length
  await complete($, 't1')
  expect(since(n)).toEqual(['ui.render'])
  n = w.invalidated.length
  expect(await dp($, 'lock high')).toContain('已锁定')
  expect(since(n)).toEqual(['ui.render'])
  n = w.invalidated.length
  expect(await dp($, 'unlock')).toContain('已解锁')
  expect(since(n)).toEqual(['ui.render'])
  n = w.invalidated.length
  expect(await dp($)).toBe('面板已打开。')
  expect(await dp($)).toBe('面板已关上。')
  expect(since(n)).toEqual(['ui.render', 'ui.render'])
})

test('面板不是用 /dp 关上的：马上重画，时间轴回到五行', { options: KEYS, plugins: [CLOSER] }, async ($, on) => {
  const w = world(on, { scene: SCENES.up, pane: 'placed' })
  await start($)
  expect(await dp($)).toBe('面板已打开。')
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /上次评估/ })).toBe(undefined)
  const n = w.invalidated.length
  const r = await $.command.run({ command: 'close-dp-pane', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(r.text).toBe('closed')
  expect(w.closed).toEqual([PANE_ID])
  expect(w.panes).toEqual([])
  expect(w.invalidated.slice(n)).toEqual(['ui.render'])
  // The band on screen is drawn again at once, with all five rows.
  expect((await band.find({ type: 'Text', text: /^上次评估/ }))?.text).toMatch(/^上次评估 不变 · /)
  expect((await band.find({ type: 'Text', text: /^生效/ }))?.text).toMatch(/^生效 发消息定档/)
  await band.unmount()
  const again = await $.ui.mount(BAND)
  expect(await again.find({ type: 'Text', text: /上次评估/ })).toBeTruthy()
  expect(await again.find({ type: 'Text', text: /生效/ })).toBeTruthy()
  await again.unmount()
})

test('重画：record、写入 sent、读数写进格子之后', async () => {
  const f = standIn()
  await record(f.$, decision())
  expect(f.invalidated).toEqual(['ui.render'])
  await amendSent(f.$, 'd1', 'high')
  expect(f.invalidated).toEqual(['ui.render', 'ui.render'])
  expect(f.recent().map((d) => d.sent)).toEqual(['high'])

  // A main-loop request read during a step: the session's level and the step's cell are written, then a redraw.
  const turn = { ...SCENES.up.turn, track: [...SCENES.up.turn.track.slice(0, -1), { level: 'high', sent: null, mark: 'hold' }] }
  const g = standIn({ state: { session: { ...SCENES.up.session, lastSent: 'medium' }, turn } })
  const close = openStep({ turnId: 't7', index: 12, model: OPUS })
  try {
    await readout(g.$, { url: MESSAGES, init: { method: 'POST', headers: {}, body: JSON.stringify({ model: OPUS, thread: { id: 'th' }, output_config: { effort: 'high' }, messages: [] }) } }, 'engine')
  } finally {
    close()
  }
  expect(g.session().lastSent).toBe('high')
  expect(g.turn()?.track.at(-1)).toEqual({ level: 'high', sent: 'high', mark: 'hold' })
  expect(g.invalidated).toEqual(['ui.render'])
})

test('重画出错不连累调用它的 hook', { options: KEYS }, async ($, on) => {
  // A redraw that throws: the record still lands in both copies, and the debug log has a line.
  const f = standIn({}, { refuseInvalidate: true })
  expect(() => redraw(f.$)).not.toThrow()
  await record(f.$, decision({ id: 'x' }))
  expect(f.recent().map((d) => d.id)).toEqual(['x'])
  expect(f.log().map((d) => d.id)).toEqual(['x'])
  expect(f.logs.filter((l) => l.startsWith('redraw failed open:'))).toHaveLength(2)
  // In a session, an invalidate the engine refuses changes nothing of what the hooks do.
  const w = world(on, { refuse: ['ui.invalidate'] })
  await start($)
  expect(await dp($, 'lock high')).toContain('已锁定')
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  expect(w.stepsSent.map((s) => s.effort)).toEqual(['high'])
  expect(w.invalidated).toEqual([])
})
