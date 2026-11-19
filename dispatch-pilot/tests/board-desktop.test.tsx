import { expect, test } from 'claude-code/testing'

import { boardModel } from '../hooks/board/model.ts'
import type { BoardState, TrackCell } from '../hooks/board/model.ts'
import { LEVEL_HEX, NEUTRAL_HEX, PX_PER_COLUMN, barPixels, barSvg, desktopLabel, desktopStatus, desktopTimelineRows, desktopTrackCells, desktopWidth, pipsSvg, trackSvg } from '../hooks/board/view.ts'
import type { Row } from '../hooks/board/view.ts'
import { readConfig } from '../hooks/config.ts'
import type { Decision } from '../hooks/log.ts'
import { holdBoard, record, redraw } from '../hooks/runtime.ts'
import { standIn } from './support/standin.ts'
import { LEVELS } from '../hooks/levels.ts'
import { SCENES } from './support/scenes.ts'
import { KEYS, dp, drexOk, noul, score, start, step, submit, turns, world } from './support/world.ts'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const CFG = readConfig(KEYS)
const up = boardModel(CFG, SCENES.up)

const BAND = { plugin: 'dispatch-pilot', component: 'AbovePrompt', requestId: 'band', surface: 'desktop', props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} } } as const
const PANE = { plugin: 'dispatch-pilot', component: 'Pane', requestId: 'dispatch-pilot', surface: 'desktop', props: { title: 'Dispatch Pilot', isFocused: false, bodyColumns: 46, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const
const FOOTER = { plugin: 'dispatch-pilot', component: 'SessionMode', requestId: 'mode', surface: 'desktop', props: { modes: ['focus'] } } as const

/** The Svg element's own bound on its source (SvgProps.source in the generated types). */
const SVG_LIMIT = 131072

/** How many elements a drawn tree holds (design 5.14: fewer than 2000 on the Desktop). */
function nodes(tree: unknown): number {
  if (tree === null || typeof tree !== 'object') return 0
  const children = (tree as { children?: unknown[] }).children ?? []
  return 1 + children.reduce<number>((n, c) => n + nodes(c), 0)
}

/** The cells a track drawing paints, in order: each one's colour. */
const cellColours = (source: string): string[] => [...source.matchAll(/<rect class="cell" [^>]*fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]!)
/** The marks a track drawing paints, in order, by kind. */
const markKinds = (source: string): string[] => [...source.matchAll(/class="mark-(up|down|fail|hold)"/g)].map((m) => m[1]!)

function decision(): Decision {
  return { id: 'd1', at: 1, kind: 'submit', backend: 'drex', model: 'drex-max-v1.1', ms: 300, raw: null, from: 'medium', to: 'high', reason: 'more-open', detail: '', turnId: 't1', step: 0, bars: null, failure: null, requestId: null, applied: true, sent: null }
}

const cell = (level: TrackCell['level'], mark: TrackCell['mark'] = null, sent: TrackCell['sent'] = level): TrackCell => ({ level, sent, mark })

/** A turn of n work steps: the first half at medium, the rest at high, a hold under every cell and an up at the shift. */
function longTurn(n: number): BoardState {
  const half = Math.floor(n / 2)
  const track = Array.from({ length: n }, (_, i) => cell(i < half ? 'medium' : 'high', i === half ? 'up' : 'hold'))
  return { ...SCENES.up, turn: { ...SCENES.up.turn, journal: { ...SCENES.up.turn.journal, workSteps: n - 1 }, stepNo: n, track } }
}

// The message's judgement from medium to high (the answers tests/track.test.ts gives SUBMIT_RAISE).
const RAISE = drexOk({ open: score([0.02, 0.08, 0.25, 0.55, 0.1]), mechanical: noul(0.1), unknown_cause: noul(0.2) })

// The brief's eight.

test('trackSvg：以 <svg 开头，不带脚本、文字和外链，alt 写着步数和下次评估', () => {
  const d = trackSvg(up.track, 1)
  expect(d.source.startsWith('<svg')).toBe(true)
  expect(/<script|<text|href=/.test(d.source)).toBe(false)
  expect(d.alt).toBe('10 步：medium 6 步，high 4 步；下次评估在 1 步后')
  expect(d.source.length).toBeLessThan(SVG_LIMIT)
  // One cell per step, each in its level's colour, and every mark under its cell.
  expect(cellColours(d.source)).toEqual([...Array(6).fill(LEVEL_HEX.medium), ...Array(4).fill(LEVEL_HEX.high)])
  expect(markKinds(d.source)).toEqual(['hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'up', 'hold', 'hold', 'hold'])
  expect(d.source).toContain('class="ahead"')
  expect(d.source).toContain('class="next"')
})

test('Desktop 的时间轴：两个 Svg（档位格、轨道），行里的话和终端一样', { options: KEYS }, async ($, on) => {
  world(on, { scene: SCENES.up })
  await start($)
  const ui = await $.ui.mount(BAND)
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs).toHaveLength(2)
  expect(svgs.map((s) => s.props.alt)).toEqual(['档位 high，五档中的第 3 档', '10 步：medium 6 步，high 4 步；下次评估在 1 步后'])
  expect(svgs[0]!.props.source).toBe(pipsSvg('high').source)
  expect(svgs[1]!.props.source).toBe(trackSvg(up.track, 1).source)
  expect((await ui.find({ type: 'Text', text: /已发出/ }))?.text).toBe(' high  ✓ 已发出   第 7 轮 · 第 10 步 · Code Mode 会话')
  expect((await ui.find({ type: 'Text', text: /下一份脚本结果到达时/ }))?.text).toBe('   下次评估 下一份脚本结果到达时')
  // The marks are in the drawing: the row under the track carries only the shift, with no label and no mark glyph.
  expect((await ui.find({ type: 'Text', text: /第 6 步后/ }))?.text).toBe('第 6 步后 medium → high · 已发出 · 同一失败在修改后又出现')
  expect(await ui.find({ type: 'Text', text: /[▲▼·×]{3}|^评|^步/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^上次评估 不变/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^生效 发消息定档/ })).toBeTruthy()
  // The level's name is drawn semibold, in its theme key.
  expect((await ui.find({ type: 'Text', text: /^ high$/ }))?.props).toMatchObject({ color: 'warning', weight: 'semibold' })
  await ui.unmount()
})

test('300 步：还是两个 Svg，轨道不超过 60 格（Review Focus 4）', { options: KEYS }, async ($, on) => {
  world(on, { scene: longTurn(300) })
  await start($)
  const ui = await $.ui.mount(BAND)
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs).toHaveLength(2)
  const track = svgs[1]!.props as { source: string; alt: string; width: number }
  // 120 columns hold 49 cells of 14 px (desktopTrackCells): 300 steps go 7 to a cell, 43 cells.
  expect(desktopTrackCells(120)).toBe(49)
  expect(cellColours(track.source)).toHaveLength(43)
  expect(cellColours(track.source)).toEqual([...Array(21).fill(LEVEL_HEX.medium), ...Array(22).fill(LEVEL_HEX.high)])
  // The group holding the shift shows its up; every other group a hold.
  expect(markKinds(track.source).filter((k) => k === 'up')).toHaveLength(1)
  expect(markKinds(track.source)).toHaveLength(43)
  expect(track.alt).toBe('43 格，每格 7 步：medium 21 格，high 22 格；下次评估在 1 步后')
  expect(track.source.length).toBeLessThan(SVG_LIMIT)
  // The drawing and its scale fit; the next evaluation, past 120 columns, is dropped whole.
  expect((await ui.find({ type: 'Text', text: /每格 7 步/ }))?.text).toBe('  每格 7 步')
  expect(Math.ceil(track.width / PX_PER_COLUMN) + 11).toBeLessThanOrEqual(120)
  expect(await ui.find({ type: 'Text', text: /下一份脚本结果到达时/ })).toBe(undefined)
  // The tree's size does not grow with the steps: the whole turn is two drawings.
  const size = nodes(await ui.drawn())
  expect(size).toBeLessThan(60)
  await ui.unmount()
  const pane = await $.ui.mount(PANE)
  expect(nodes(await pane.drawn())).toBeLessThan(2000)
  await pane.unmount()
})

test('Desktop 的面板：五档各一条概率条，各是一个 Svg，alt 写着档名和概率', { options: KEYS }, async ($, on) => {
  world(on, { scene: SCENES.up, pane: 'placed' })
  await start($)
  const ui = await $.ui.mount(PANE)
  const bars = (await ui.findAll({ type: 'Svg' })).filter((s) => /^(max|xhigh|high|medium|low) /.test(String(s.props.alt)))
  expect(bars.map((b) => b.props.alt)).toEqual(['max 0.08', 'xhigh 0.33', 'high 0.46（现在）', 'medium 0.10', 'low 0.03'])
  const width = barPixels(46)
  expect(bars.map((b) => b.props.width)).toEqual([width, width, width, width, width])
  expect(bars.map((b) => b.props.source)).toEqual([barSvg(0.08, 'max', false, width), barSvg(0.33, 'xhigh', false, width), barSvg(0.46, 'high', true, width), barSvg(0.1, 'medium', false, width), barSvg(0.03, 'low', false, width)].map((d) => d.source))
  bars.forEach((b, i) => expect(String(b.props.source)).toContain(`fill="${LEVEL_HEX[[...LEVELS].reverse()[i]!]}"`))
  // The figures stand right after the bars, one space away (the drawings are one width); the current level is marked.
  expect((await ui.find({ type: 'Text', text: /^ 0\.46/ }))?.text).toBe(' 0.46  ◂ 现在')
  // The pane's titles and the sentences are the terminal's.
  const titles = await ui.findAll({ type: 'Text', text: /^(现在|换挡记录|上次评估|下次评估|功能|agent)$/ })
  expect(titles.map((t) => t.text)).toEqual(['现在', '换挡记录', '上次评估', '下次评估', '功能', 'agent'])
  expect(await ui.find({ type: 'Text', text: '同一失败在修改后又出现' })).toBeTruthy()
  // Six drawings in all: the pips and the five bars.
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(6)
  await ui.unmount()
})

test('desktopStatus 的四种写法', () => {
  expect(desktopStatus(up)).toBe('high · ↑ 第 6 步后由 medium 升到 high')
  expect(desktopStatus(boardModel(CFG, SCENES.locked))).toBe('high · 已锁定')
  expect(desktopStatus(boardModel(CFG, SCENES.idle))).toBe('medium · 空闲，下一条消息时定档')
  expect(desktopStatus(boardModel(CFG, SCENES.notsent))).toBe('要 xhigh，实际发出 high')
})

test('Desktop 上写状态行，终端不写', { options: KEYS }, async ($, on) => {
  // The array world() reads on every $.session.surfaces(): the desktop app detaches halfway through.
  const surfaces = ['desktop']
  const w = world(on, { scene: SCENES.up, pane: 'placed', surfaces })
  await start($)
  // At session.start, then after the pane opened and after it closed (the ui.close hook redraws).
  expect(w.statuses).toEqual(['high · ↑ 第 6 步后由 medium 升到 high'])
  expect(await dp($)).toBe('面板已打开。')
  expect(await dp($)).toBe('面板已关上。')
  expect(w.statuses).toEqual(Array(3).fill('high · ↑ 第 6 步后由 medium 升到 high'))
  // The desktop gone, the board is still drawn again on each, and no status is written.
  surfaces.splice(0, 1, 'terminal')
  const n = w.invalidated.length
  expect(await dp($)).toBe('面板已打开。')
  expect(await dp($)).toBe('面板已关上。')
  expect(w.invalidated.slice(n)).toEqual(['ui.render', 'ui.render'])
  expect(w.statuses).toHaveLength(3)
})

test('Desktop 的脚部标签不超过 24 个字符', { options: KEYS }, async ($, on) => {
  const labels = Object.values(SCENES).map((s) => desktopLabel(boardModel(CFG, s)))
  expect(labels).toEqual(['dp · high ✓', 'dp · high ✓', 'dp · high ✓', 'dp · high !', 'dp · medium –', 'dp · high ■'])
  expect(labels.every((l) => l.length <= 24)).toBe(true)
  const w = world(on, { scene: SCENES.notsent })
  await start($)
  const ui = await $.ui.mount(FOOTER)
  expect(w.footers).toEqual([['focus', 'dp · high !']])
  await ui.unmount()
})

test('vscode、mobile：三个渲染 hook 都原样交给 next', { options: KEYS }, async ($, on) => {
  const w = world(on, { scene: SCENES.up, pane: 'placed' })
  await start($)
  for (const surface of ['vscode', 'mobile'] as const) {
    for (const target of [{ ...BAND, surface }, { ...PANE, surface }]) {
      const ui = await $.ui.mount(target)
      expect([surface, target.component, await ui.drawn()]).toMatchObject([surface, target.component, { type: 'engine' }])
      expect(await ui.find({ type: 'Text', text: /已发出|现在/ })).toBe(undefined)
      await ui.unmount()
    }
  }
  const foot = await $.ui.mount({ ...FOOTER, surface: 'vscode' })
  expect(w.footers).toEqual([['focus']])
  await foot.unmount()
  // The same targets on the desktop draw.
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /已发出/ })).toBeTruthy()
  await ui.unmount()
})

// What the eight do not reach.

test('barSvg：0、小到不足一个像素、1', () => {
  const at = (v: number, isStrong = false) => barSvg(v, 'xhigh', isStrong, 120)
  const length = (d: { source: string }) => Number(/<rect class="bar" [^>]*width="(\d+)"/.exec(d.source)?.[1])
  expect([length(at(0)), length(at(0.004)), length(at(0.5)), length(at(1))]).toEqual([2, 2, 60, 120])
  expect(at(0)).toMatchObject({ width: 120, height: 9, alt: 'xhigh 0.00' })
  expect(at(1, true).alt).toBe('xhigh 1.00（现在）')
  expect(at(1, true).source).toContain('opacity="1"')
  expect(at(0.5).source).toContain('opacity="0.8"')
  expect(at(0.5).source).toContain(`fill="${LEVEL_HEX.xhigh}"`)
  // Out of range reads as the nearest end.
  expect([length(at(-1)), length(at(3)), length(at(Number.NaN))]).toEqual([2, 120, 2])
  for (const v of [0, 0.004, 1]) expect(/<script|<text|href=/.test(at(v).source)).toBe(false)
})

test('pipsSvg：每一档点亮到它那一格，用它的颜色', () => {
  LEVELS.forEach((level, i) => {
    const d = pipsSvg(level)
    const fills = [...d.source.matchAll(/<rect class="pip" [^>]*fill="([^"]+)"/g)].map((m) => m[1])
    expect([level, fills]).toEqual([level, [...Array(i + 1).fill(LEVEL_HEX[level]), ...Array(4 - i).fill(NEUTRAL_HEX)]])
    expect(d.alt).toBe(`档位 ${level}，五档中的第 ${i + 1} 档`)
    expect(d).toMatchObject({ width: 57, height: 15 })
    expect(d.source.startsWith('<svg')).toBe(true)
  })
})

test('trackSvg：四种记号各画成它的形状，ahead 为 0 时没有虚线和菱形', () => {
  const cells = [cell('low', 'hold'), cell('medium', 'up'), cell('medium', 'fail'), cell('low', 'down'), cell('high', null, 'medium'), cell('xhigh', null, null)]
  const d = trackSvg(cells, 0)
  expect(markKinds(d.source)).toEqual(['hold', 'up', 'fail', 'down'])
  // A shift is drawn in its cell's colour, a failure in the failure's, a hold in the neutral grey.
  expect(d.source).toMatch(new RegExp(`class="mark-up" [^>]*fill="${LEVEL_HEX.medium}"`))
  expect(d.source).toMatch(new RegExp(`class="mark-down" [^>]*fill="${LEVEL_HEX.low}"`))
  expect(d.source).toMatch(new RegExp(`class="mark-hold" [^>]*fill="${NEUTRAL_HEX}"`))
  expect(d.source).toMatch(/class="mark-fail" [^>]*stroke="#[0-9a-f]{6}"/)
  // A cell is the level its request carried, the level asked for while none was read.
  expect(cellColours(d.source)).toEqual([LEVEL_HEX.low, LEVEL_HEX.medium, LEVEL_HEX.medium, LEVEL_HEX.low, LEVEL_HEX.medium, LEVEL_HEX.xhigh])
  expect(d.source).not.toContain('class="ahead"')
  expect(d.source).not.toContain('class="next"')
  expect(d.alt).toBe('6 步：low 2 步，medium 3 步，xhigh 1 步')
  expect(d).toMatchObject({ width: 6 * 14 - 1, height: 26 })
  // Far ahead: at most six cells of dashes, then the diamond.
  const far = trackSvg(cells, 9)
  expect(far.source).toMatch(new RegExp(`class="ahead" [^>]*x1="86" [^>]*x2="170" [^>]*stroke="${NEUTRAL_HEX}"`))
  expect(far.alt).toBe('6 步：low 2 步，medium 3 步，xhigh 1 步；下次评估在 9 步后')
  expect(far.width).toBeGreaterThan(170)
})

test('300 步：每张图的 source 都在 Svg 的上限以内', () => {
  const cells = longTurn(300).turn!.track
  const track = trackSvg(cells, 6)
  expect(cellColours(track.source)).toHaveLength(60)
  expect(track.alt).toBe('60 格，每格 5 步：medium 30 格，high 30 格；下次评估在 6 步后')
  const marked = trackSvg([cell('low', 'hold'), cell('medium', 'up'), cell('medium', 'fail'), cell('low', 'down')], 3)
  const drawings = [track, marked, ...LEVELS.map(pipsSvg), ...LEVELS.map((l) => barSvg(0.5, l, true, 144))]
  for (const d of drawings) {
    // Drawn as an image, a drawing inherits no text colour: every colour in it is written out.
    expect(d.source).not.toContain('currentColor')
    expect(d.source.length).toBeLessThan(SVG_LIMIT)
    expect(/<script|<text|href=/.test(d.source)).toBe(false)
    expect(d.source.startsWith('<svg')).toBe(true)
    expect(d.source.endsWith('</svg>')).toBe(true)
  }
})

test('Desktop 的面板在窄处：五条概率条都在，宽度跟着变窄，行里的整段放得下', { options: KEYS }, async ($, on) => {
  world(on, { scene: SCENES.notsent, pane: 'placed' })
  await start($)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 24 } })
  const bars = (await ui.findAll({ type: 'Svg' })).filter((s) => /^(max|xhigh|high|medium|low) /.test(String(s.props.alt)))
  expect(bars.map((b) => b.props.alt)).toEqual(['max 0.28', 'xhigh 0.52', 'high 0.15（现在）', 'medium 0.04', 'low 0.01'])
  expect(barPixels(24)).toBeLessThan(barPixels(46))
  expect(bars.every((b) => b.props.width === barPixels(24))).toBe(true)
  // A sentence stays whole (the surface wraps it).
  expect(await ui.find({ type: 'Text', text: '第 7 步后  high → xhigh（还没发出）' })).toBeTruthy()
  await ui.unmount()
})

test('状态行在会话开始、换挡和 /dp lock 之后各写一次', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: () => RAISE, surfaces: ['desktop'] })
  await start($)
  // Before any turn: no level is known yet, only when it will be set.
  expect(w.statuses).toEqual(['空闲，下一条消息时定档'])
  await submit($, 'Fix the flaky retry in the uploader')
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  expect(w.statuses.at(-1)).toBe('high · ↑ 发消息时由 medium 升到 high')
  expect(await dp($, 'lock xhigh')).toContain('已锁定')
  expect(w.statuses.at(-1)).toBe('xhigh · 已锁定')
})

test('board 关着：Desktop 上也不写状态行', { options: { ...KEYS, board: false } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: () => RAISE, surfaces: ['desktop'] })
  await start($)
  await submit($, 'Fix the flaky retry in the uploader')
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  expect(await dp($, 'lock xhigh')).toContain('已锁定')
  // The mod did its work and asked for redraws; nothing wrote a status.
  expect(w.stepsSent.map((s) => s.effort)).toEqual(['high'])
  expect(w.invalidated.length).toBeGreaterThan(1)
  expect(w.statuses).toEqual([])
})

test('Desktop 的行按 Svg 的像素宽度裁：120 列和 80 列、300 步和 10 步，丢的是整段，画不丢', () => {
  const desktopCols = (r: Row): number => r.parts.reduce((n, p) => n + desktopWidth(p, 0), 0)
  const texts = (r: Row): string[] => r.parts.flatMap((p) => (p.t === 'text' ? [p.text] : []))
  for (const steps of [300, 10]) {
    const m = boardModel(CFG, longTurn(steps))
    const wide = desktopTimelineRows(m, { columns: 1000, isPaneOpen: false })
    for (const columns of [120, 80, 40]) {
      const rows = desktopTimelineRows(m, { columns, isPaneOpen: false })
      expect(rows.map((r) => r.id)).toEqual(['now', 'track', 'marks', 'last', 'features'])
      const track = rows[1]!
      // The drawing leads its row and stays; what follows fits by the drawing's pixels, PX_PER_COLUMN to a column.
      expect([steps, columns, track.parts[0]?.t]).toEqual([steps, columns, 'track'])
      expect([steps, columns, desktopCols(track) <= columns]).toEqual([steps, columns, true])
      // Whole parts only, in their order: the wide row's text without its scale (the cells per step differ).
      const kept = texts(track).filter((t) => !t.includes('每格'))
      expect([steps, columns, kept]).toEqual([steps, columns, texts(wide[1]!).filter((t) => !t.includes('每格')).slice(0, kept.length)])
    }
  }
  const tracks = (steps: number, columns: number) => desktopTimelineRows(boardModel(CFG, longTurn(steps)), { columns, isPaneOpen: false })[1]!.parts.map((p) => (p.t === 'text' ? p.text : p.t))
  // 300 steps: the next evaluation does not fit at 120 or 80 columns, the scale does.
  expect(tracks(300, 120)).toEqual(['track', '  每格 7 步'])
  expect(tracks(300, 80)).toEqual(['track', '  每格 12 步'])
  // 10 steps: the next evaluation fits at 120 and 80; at 40 only the drawing stays.
  expect(tracks(10, 120)).toEqual(['track', '   下次评估 ', '下一份脚本结果到达时'])
  expect(tracks(10, 80)).toEqual(['track', '   下次评估 ', '下一份脚本结果到达时'])
  expect(tracks(10, 40)).toEqual(['track'])
  // A drawing's columns are its pixels over PX_PER_COLUMN, rounded up.
  const part = { t: 'track', cells: longTurn(10).turn!.track, ahead: 1 } as const
  expect(desktopWidth(part, 0)).toBe(Math.ceil(trackSvg(part.cells, 1).width / PX_PER_COLUMN))
  expect(desktopWidth({ t: 'pips', level: 'high' }, 0)).toBe(Math.ceil(57 / PX_PER_COLUMN))
  expect(desktopWidth({ t: 'bar', value: 0.3, tone: 'high', isStrong: false }, 100)).toBe(13)
})

test('Desktop 的 80 列：轨道的格数跟着列数变少，下次评估整段丢掉', { options: KEYS }, async ($, on) => {
  world(on, { scene: longTurn(300) })
  await start($)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 80 } })
  const track = (await ui.findAll({ type: 'Svg' }))[1]!.props as { source: string; width: number }
  expect(desktopTrackCells(80)).toBe(26)
  expect(cellColours(track.source)).toHaveLength(25)
  expect(Math.ceil(track.width / PX_PER_COLUMN)).toBeLessThanOrEqual(80)
  expect((await ui.find({ type: 'Text', text: /每格/ }))?.text).toBe('  每格 12 步')
  expect(await ui.find({ type: 'Text', text: /下次评估/ })).toBe(undefined)
  await ui.unmount()
})

test('Desktop 上锁定的一轮：没有记号也没有换挡时不画那一行', () => {
  const rows = desktopTimelineRows(boardModel(CFG, SCENES.locked), { columns: 120, isPaneOpen: false })
  expect(rows.map((r) => r.id)).toEqual(['now', 'track', 'last', 'features'])
})

// A turn, a lock and the next step, with the status line's write refused one way or another.
async function statusRefused($: Engine, on: On, refuse: string[]) {
  const w = world(on, { onSubmit: turns($), answer: () => RAISE, surfaces: ['desktop'], refuse })
  await start($)
  await submit($, 'Fix the flaky retry in the uploader')
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  // The step went at the level decided, the board was asked to redraw, the lock took.
  expect(w.stepsSent.map((s) => s.effort)).toEqual(['high'])
  expect(w.invalidated.length).toBeGreaterThan(1)
  expect(await dp($, 'lock xhigh')).toContain('已锁定')
  await step($, { turnId: 't1', index: 1, effort: 'medium' })
  expect(w.stepsSent.map((s) => s.effort)).toEqual(['high', 'xhigh'])
  expect(w.statuses).toEqual([])
  return w
}

test('ui.status 被拒不连累调用它的 hook', { options: KEYS }, async ($, on) => {
  // The engine drops a refused status by itself ("$.ui.status dropped"): the mod's call does not throw.
  await statusRefused($, on, ['ui.status'])
})

test('ui.status 或 surfaces 抛错：redraw 照样 resolve，record 两份都写上', async () => {
  // The test file's own copy of runtime.ts, given the board's config as registerBoard gives it.
  holdBoard(CFG)
  for (const failing of ['status', 'surfaces'] as const) {
    const f = standIn()
    const $ = {
      ...(f.$ as object),
      ui: { ...(f.$ as { ui: object }).ui, status: () => { if (failing === 'status') throw new Error('status refused') } },
      session: { surfaces: async () => { if (failing === 'surfaces') throw new Error('surfaces refused'); return ['desktop'] } },
    } as never
    await redraw($)
    await record($, decision())
    expect([failing, f.invalidated]).toEqual([failing, ['ui.render', 'ui.render']])
    expect([failing, f.recent().map((d) => d.id), f.log().map((d) => d.id)]).toEqual([failing, ['d1'], ['d1']])
    expect([failing, f.logs.filter((l) => l.startsWith('status failed open:'))]).toEqual([failing, Array(2).fill(`status failed open: ${failing} refused`)])
  }
  holdBoard({ ...CFG, board: false })
})

test('读 surfaces 出错不连累调用它的 hook', { options: KEYS }, async ($, on) => {
  const w = await statusRefused($, on, ['session.surfaces'])
  expect(w.debugLogs.filter((l) => l.startsWith('status failed open:')).length).toBeGreaterThan(0)
})
