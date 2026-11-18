import { expect, test } from 'claude-code/testing'

import { boardModel } from '../hooks/board/model.ts'
import type { BoardModel, BoardState, TrackCell } from '../hooks/board/model.ts'
import { displayWidth, fitRow, fitTrack, footerLabel, paneSections, rowText, runsOf, timelineRows } from '../hooks/board/view.ts'
import type { Part, Row } from '../hooks/board/view.ts'
import { readConfig } from '../hooks/config.ts'
import type { Decision } from '../hooks/log.ts'
import { SCENES } from './support/scenes.ts'

const CFG = readConfig({ drexApiKey: 'k' })
const model = (s: BoardState): BoardModel => boardModel(CFG, s)
const up = model(SCENES.up)
const start = model(SCENES.start)
const ordinary = model(SCENES.ordinary)
const notsent = model(SCENES.notsent)
const idle = model(SCENES.idle)
const locked = model(SCENES.locked)
const ALL = { up, start, ordinary, notsent, idle, locked }

const width = (r: Row): number => displayWidth(rowText(r))
const texts = (r: Row): string[] => r.parts.flatMap((p) => (p.t === 'text' ? [p.text] : []))
const drawn = (p: Part | undefined): string => (p === undefined ? '' : runsOf(p).map((r) => r.text).join(''))
const sectionsOf = (m: BoardModel): Record<string, string[]> => Object.fromEntries(paneSections(m).map((x) => [x.id, x.rows.map(rowText)]))

// The brief's six.

test('面板关着 5 行，开着 3 行，空闲 1 行', () => {
  expect(timelineRows(up, { columns: 120, isPaneOpen: false }).map((r) => r.id)).toEqual(['now', 'track', 'marks', 'last', 'features'])
  expect(timelineRows(up, { columns: 120, isPaneOpen: true }).map((r) => r.id)).toEqual(['now', 'track', 'marks'])
  expect(timelineRows(idle, { columns: 120, isPaneOpen: false }).map((r) => r.id)).toEqual(['idle'])
})

test('每一行里该有的话', () => {
  const rows = timelineRows(up, { columns: 120, isPaneOpen: false }).map(rowText)
  expect(rows[0]).toMatch(/high.*已发出.*第 7 轮 · 第 10 步/)
  expect(rows[1]).toMatch(/下次评估.*下一份脚本结果到达时/)
  expect(rows[2]).toMatch(/medium.*high.*同一失败在修改后又出现/)
  expect(rows[3]).toMatch(/上次评估.*不变.*Drex · 312 ms/)
  expect(rows[4]).toMatch(/生效.*发消息定档.*关.*进展记录/)
})

test('300 步的一轮：轨道不超过可用的列数，写明每格几步（Review Focus 4）', () => {
  const long = { ...up, track: Array.from({ length: 300 }, () => ({ level: 'high', sent: 'high', mark: null }) as const) }
  const row = timelineRows(long, { columns: 80, isPaneOpen: false })[1]!
  const track = row.parts.find((p) => p.t === 'track')
  expect(track?.t === 'track' && track.cells.length).toBeLessThanOrEqual(46)
  expect(rowText(row)).toContain('每格 7 步')
  expect(width(row)).toBeLessThanOrEqual(80)
})

test('fitTrack：一格里有几次评估时留最要紧的记号', () => {
  const cells = [
    { level: 'medium', sent: 'medium', mark: 'hold' },
    { level: 'medium', sent: 'medium', mark: 'fail' },
    { level: 'high', sent: 'high', mark: 'up' },
    { level: 'high', sent: 'high', mark: null },
  ] as const
  expect(fitTrack(cells, 2)).toEqual({ per: 2, cells: [{ level: 'medium', sent: 'medium', mark: 'fail' }, { level: 'high', sent: 'high', mark: 'up' }] })
  expect(fitTrack(cells, 10).per).toBe(1)
})

test('锁定的一轮没有记号也没有换挡：没有记号那一行，轨道那一行还在', () => {
  expect(timelineRows(locked, { columns: 120, isPaneOpen: false }).map((r) => r.id)).toEqual(['now', 'track', 'last', 'features'])
  expect(timelineRows(locked, { columns: 120, isPaneOpen: true }).map((r) => r.id)).toEqual(['now', 'track'])
  expect(rowText(timelineRows(locked, { columns: 120, isPaneOpen: false })[1]!)).toBe('步 █████   下次评估 不评估')
  // A mark alone, or a shift alone, keeps the row.
  const marked = boardModel(CFG, { ...SCENES.locked, turn: { ...SCENES.locked.turn!, track: [...SCENES.locked.turn!.track.slice(0, -1), { level: 'high', sent: 'high', mark: 'hold' }] } })
  expect(timelineRows(marked, { columns: 120, isPaneOpen: false }).map((r) => r.id)).toEqual(['now', 'track', 'marks', 'last', 'features'])
  expect(timelineRows(start, { columns: 120, isPaneOpen: false }).map((r) => r.id)).toEqual(['now', 'track', 'marks', 'last', 'features'])
})

test('fitTrack：一格里既有升又有降时留后来的那个', () => {
  const upThenDown = [
    { level: 'medium', sent: 'medium', mark: 'up' },
    { level: 'medium', sent: 'medium', mark: 'down' },
  ] as const
  const downThenUp = [
    { level: 'high', sent: 'high', mark: 'down' },
    { level: 'high', sent: 'high', mark: 'up' },
  ] as const
  expect(fitTrack(upThenDown, 1).cells.map((c) => c.mark)).toEqual(['down'])
  expect(fitTrack(downThenUp, 1).cells.map((c) => c.mark)).toEqual(['up'])
  // A hold after a shift does not hide it, and a failure before one still wins.
  expect(fitTrack([...upThenDown, { level: 'medium', sent: 'medium', mark: 'hold' }], 1).cells.map((c) => c.mark)).toEqual(['down'])
  expect(fitTrack([{ level: 'low', sent: 'low', mark: 'fail' }, ...downThenUp], 1).cells.map((c) => c.mark)).toEqual(['fail'])
})

test('面板的分区和顺序；没有 agent 和 skill 时不出现那两区', () => {
  expect(paneSections(up).map((s) => s.id)).toEqual(['now', 'shifts', 'last', 'next', 'features', 'agents'])
  expect(paneSections(start).map((s) => s.id)).toEqual(['now', 'shifts', 'last', 'next', 'features', 'skill'])
  expect(paneSections(locked).map((s) => s.id)).toEqual(['now', 'shifts', 'last', 'next', 'features'])
  expect(paneSections(locked)[2]!.rows.map(rowText)).toEqual(['锁定期间不评估'])
})

test('脚部标签', () => {
  expect([up, notsent, locked, idle].map(footerLabel)).toEqual(['dp high ✓', 'dp high !', 'dp high ■', 'dp medium –'])
})

// What the six do not reach.

test('displayWidth：ASCII 一列，中文和全角标点两列，轨道用的字符一列', () => {
  expect(displayWidth('')).toBe(0)
  expect(displayWidth('dp high 312 ms')).toBe(14)
  expect(displayWidth('下次评估')).toBe(8)
  expect(displayWidth('第 7 轮 · 第 10 步')).toBe(18)
  expect(displayWidth('（还没发出）：，「」')).toBe(20)
  expect(displayWidth('█┄◇▲▼×·▮▯▏◂✓■–—→')).toBe(16)
  // A combining mark takes no column of its own.
  expect(displayWidth(`e${String.fromCodePoint(0x301)}`)).toBe(1)
})

test('各 part 的字符：五格、轨道、记号、概率条', () => {
  expect(runsOf({ t: 'pips', level: 'high' })).toEqual([{ text: '▮▮▮', tone: 'high' }, { text: '▯▯', tone: 'dim' }])
  expect(drawn({ t: 'pips', level: 'max' })).toBe('▮▮▮▮▮')
  const cells: TrackCell[] = [
    { level: 'medium', sent: 'medium', mark: 'hold' },
    { level: 'high', sent: null, mark: 'up' },
    { level: 'high', sent: 'xhigh', mark: 'fail' },
    { level: 'high', sent: 'high', mark: 'down' },
    { level: 'high', sent: 'high', mark: null },
  ]
  // A cell's colour is the level its request carried, else the level the step was written at.
  expect(runsOf({ t: 'track', cells, ahead: 0 })).toEqual([
    { text: '█', tone: 'medium' },
    { text: '█', tone: 'high' },
    { text: '█', tone: 'xhigh' },
    { text: '██', tone: 'high' },
  ])
  expect(drawn({ t: 'track', cells, ahead: 2 })).toBe('█████┄┄◇')
  expect(runsOf({ t: 'track', cells: [], ahead: 9 })).toEqual([{ text: '┄┄┄┄┄┄', tone: 'dim' }, { text: '◇', tone: 'accent' }])
  expect(runsOf({ t: 'marks', cells })).toEqual([
    { text: '·', tone: 'dim' },
    { text: '▲', tone: 'high' },
    { text: '×', tone: 'err' },
    { text: '▼', tone: 'high' },
    { text: ' ', tone: 'plain' },
  ])
  expect(drawn({ t: 'bar', value: 0.46, tone: 'high', isStrong: true })).toBe('████████')
  expect(drawn({ t: 'bar', value: 1, tone: 'max', isStrong: false })).toBe('█'.repeat(18))
  expect(runsOf({ t: 'bar', value: 0.02, tone: 'low', isStrong: false })).toEqual([{ text: '▏', tone: 'low' }])
})

test('空闲的一行：会话设定的档位、上一轮结束在哪一档、下次评估在什么时候', () => {
  const [row] = timelineRows(idle, { columns: 120, isPaneOpen: false })
  expect(rowText(row!)).toBe('▮▮▯▯▯ medium  – 空闲   上一轮结束在 high   下次评估 发出下一条消息时 · 说「继续」这类话会从上一轮的 high 起算')
  // The pane being open changes nothing between turns: the row is one already.
  expect(timelineRows(idle, { columns: 120, isPaneOpen: true }).map(rowText)).toEqual([rowText(row!)])
  // Where the reason does not fit, it goes whole and the next evaluation stays.
  expect(timelineRows(idle, { columns: 80, isPaneOpen: false }).map(rowText)).toEqual(['▮▮▯▯▯ medium  – 空闲   上一轮结束在 high   下次评估 发出下一条消息时'])
})

test('空闲时不评估：时间轴的一行也写出原因', () => {
  const noKey = boardModel(readConfig({}), SCENES.idle)
  expect(noKey.next).toEqual({ main: '不评估', sub: '没有可用的后端', ahead: 0 })
  expect(timelineRows(noKey, { columns: 120, isPaneOpen: false }).map(rowText)).toEqual(['▮▮▯▯▯ medium  – 空闲   上一轮结束在 high   下次评估 不评估 · 没有可用的后端'])
  // With no reason to give, the row ends at the next evaluation.
  const fresh = boardModel(CFG, { ...SCENES.idle, session: { ...SCENES.idle.session, previous: null } })
  expect(timelineRows(fresh, { columns: 120, isPaneOpen: false }).map(rowText)).toEqual(['▮▮▯▯▯ medium  – 空闲   上一轮结束在 high   下次评估 发出下一条消息时'])
})

test('一轮里还没有评估（没锁定）：上次评估那一行和面板都写「本轮还没有评估」', () => {
  const fresh = model({ ...SCENES.up, recent: [] })
  expect(fresh.last).toBe(null)
  expect(rowText(timelineRows(fresh, { columns: 120, isPaneOpen: false })[3]!)).toBe('上次评估 本轮还没有评估')
  expect(paneSections(fresh)[2]!.rows.map(rowText)).toEqual(['本轮还没有评估'])
})

test('想升没执行的评估：时间轴和面板都照模型的话写', () => {
  const recent = SCENES.up.recent.map((d) => (d.id === 't7-m9' ? { ...d, to: 'xhigh', reason: 'same-failure', applied: false, sent: null } : d)) as Decision[]
  const m = model({ ...SCENES.up, recent })
  expect(m.last?.text).toBe('想升到 xhigh，未执行')
  expect(rowText(timelineRows(m, { columns: 120, isPaneOpen: false })[3]!)).toMatch(/^上次评估 想升到 xhigh，未执行 · 同一失败又出现 /)
  expect(rowText(paneSections(m)[2]!.rows[0]!)).toBe('想升到 xhigh，未执行')
  // An applied shift reads with its arrow.
  expect(rowText(paneSections(start)[2]!.rows[0]!)).toBe('↑ 升到 high')
})

test('60 列和 40 列：每一行都放得下，丢的是整段，不切开任何一段', () => {
  for (const [name, m] of Object.entries(ALL)) {
    for (const isPaneOpen of [false, true]) {
      const wide = timelineRows(m, { columns: 400, isPaneOpen })
      for (const columns of [60, 40]) {
        const rows = timelineRows(m, { columns, isPaneOpen })
        expect(rows.map((r) => r.id)).toEqual(wide.map((r) => r.id))
        rows.forEach((r, i) => {
          expect([name, columns, r.id, width(r) <= columns]).toEqual([name, columns, r.id, true])
          // The text parts kept are the wide row's, whole and in order (the track's own scale aside).
          const kept = texts(r).filter((t) => !t.includes('每格'))
          expect([name, columns, r.id, kept]).toEqual([name, columns, r.id, texts(wide[i]!).slice(0, kept.length)])
        })
      }
    }
  }
  // What 40 columns keeps of a turn under way.
  const narrow = timelineRows(up, { columns: 40, isPaneOpen: false }).map(rowText)
  expect(narrow).toEqual([
    '▮▮▮▯▯ high  ✓ 已发出',
    '步 ██████████┄◇',
    '评 ······▲···   第 6 步后 medium → high',
    '上次评估 不变 · 同一失败又出现 0.12',
    '生效 发消息定档 · 中途换挡 · agent 定档',
  ])
  // 60 columns: one more answer of the evaluation; the shift is still without its reason.
  const sixty = timelineRows(up, { columns: 60, isPaneOpen: false }).map(rowText)
  expect(sixty[2]).toBe('评 ······▲···   第 6 步后 medium → high')
  expect(sixty[3]).toBe('上次评估 不变 · 同一失败又出现 0.12 · 原因已查明 0.22')
})

test('fitRow：留下的是开头的整段；第一段太宽也留着', () => {
  const row: Row = { id: 'r', parts: [{ t: 'text', text: '上次评估 ' }, { t: 'text', text: '不变' }, { t: 'text', text: ' · 原因已查明 0.22' }, { t: 'text', text: '    Drex · 312 ms' }] }
  expect(fitRow(row, 200)).toEqual(row)
  expect(fitRow(row, 32).parts).toEqual(row.parts.slice(0, 3))
  expect(fitRow(row, 20).parts).toEqual(row.parts.slice(0, 2))
  expect(fitRow(row, 4).parts).toEqual(row.parts.slice(0, 2))
})

test('面板在 30 列里：成段的行放得下，只有一段的整句留着（终端里折行）', () => {
  for (const m of Object.values(ALL)) {
    for (const s of paneSections(m)) {
      for (const r of s.rows) {
        const fitted = fitRow(r, 30)
        const isOneGroup = !r.parts.slice(1).some((p) => p.t === 'text' && p.text.startsWith(' '))
        expect([s.id, r.id, width(fitted) <= 30 || (isOneGroup && fitted.parts.length === r.parts.length)]).toEqual([s.id, r.id, true])
      }
    }
  }
  // The bars keep the name, the bar and the figure; the marker of the current level would go first.
  const bars = paneSections(up)[2]!.rows.filter((r) => r.id.startsWith('bar-')).map((r) => rowText(fitRow(r, 30)))
  expect(bars).toEqual(['max     █        0.08', 'xhigh   ██████   0.33', 'high    ████████ 0.46  ◂ 现在', 'medium  ██       0.10', 'low     █        0.03'])
})

test('轨道合并后记号仍在各自那一格下面', () => {
  const long = { ...up, track: Array.from({ length: 300 }, (_, i): TrackCell => ({ level: i < 150 ? 'medium' : 'high', sent: null, mark: i % 50 === 0 ? 'up' : 'hold' })) }
  const [, track, marks] = timelineRows(long, { columns: 80, isPaneOpen: false })
  const t = track!.parts.find((p) => p.t === 'track')
  const k = marks!.parts.find((p) => p.t === 'marks')
  expect(t?.t === 'track' ? t.cells : null).toEqual(k?.t === 'marks' ? k.cells : 'no marks')
  // The same number of characters before the cells and in them, so each mark stands under its column.
  expect(displayWidth(drawn(track!.parts[0]))).toBe(displayWidth(drawn(marks!.parts[0])))
  expect(drawn(t).replace(/[┄◇]/g, '').length).toBe(drawn(k).length)
  expect(drawn(k).length).toBe(43)
})

test('面板的各分区：现在、换挡记录、上次评估、下次评估、功能、agent、skill', () => {
  const s = sectionsOf(up)
  expect(s.now).toEqual(['▮▮▮▯▯ high', '✓ 已发出', '第 7 轮 · 第 10 步', '第 6 步后 medium → high', '同一失败在修改后又出现'])
  expect(s.shifts).toEqual(['第 6 步后  medium → high', '  同一失败在修改后又出现'])
  expect(s.last).toEqual([
    '不变',
    'max     █        0.08',
    'xhigh   ██████   0.33',
    'high    ████████ 0.46  ◂ 现在',
    'medium  ██       0.10',
    'low     █        0.03',
    '同一失败又出现  0.12  否',
    '原因已查明      0.22  否',
    '只剩照做        0.18  否',
    '与计划矛盾      0.09  否',
    '再升一档要上方合计 ≥ 0.80，现在 0.41',
    '降一档要下方合计 ≥ 0.70，现在 0.13',
    '第 9 步后 · Drex · 312 ms',
  ])
  expect(s.next).toEqual(['下一份脚本结果到达时', '每 1 份脚本结果评估一次 · 本轮还可换挡 3 次'])
  expect(s.features).toEqual([
    '● 发消息定档 生效',
    '● 中途换挡   生效 · 每 1 份脚本结果',
    '● agent 定档 生效 · 本轮 2 个',
    '● skill 推荐 生效 · 62 个候选',
    '● 档位核对   生效',
    '○ 进展记录   关',
    '后端 Drex drex-max-v1.1 · 可用',
  ])
  expect(s.agents).toEqual(['✓ Explore          haiku · low', '✓ general-purpose  sonnet · medium'])
  expect(sectionsOf(start).skill).toEqual(['superpowers:systematic-debugging'])
  // A shift not sent yet says so, and so does the status; locked, nothing is judged; a failed evaluation says why.
  expect(sectionsOf(notsent).shifts).toEqual(['第 3 步后  medium → high', '  同一失败在修改后又出现', '第 7 步后  high → xhigh（还没发出）', '  最新结果和原计划矛盾'])
  expect(sectionsOf(notsent).now?.slice(0, 2)).toEqual(['▮▮▮▯▯ high', '! 要 xhigh，实际发出 high'])
  expect(sectionsOf(locked).shifts).toEqual(['这一轮没有换挡'])
  expect(sectionsOf(ordinary).last).toEqual(['× 评估失败，档位不变', '评估失败：超时，按规则放行', '第 13 步后 · Drex 超时'])
  // Between turns: the level the last turn ended at, and the last evaluation recorded.
  const between = sectionsOf(idle)
  expect(between.now).toEqual(['▮▮▯▯▯ medium', '– 空闲', '上一轮结束在 high'])
  expect(between.last?.at(-1)).toBe('此前 · 第 13 步后 · Drex · 301 ms')
  expect(between.next).toEqual(['发出下一条消息时', '说「继续」这类话会从上一轮的 high 起算'])
})

test('时间轴各行在别的场景里：没核对、锁定、失败、后端出错', () => {
  const rowsOf = (m: BoardModel) => timelineRows(m, { columns: 160, isPaneOpen: false }).map(rowText)
  expect(rowsOf(up)[3]).toBe('上次评估 不变 · 同一失败又出现 0.12 · 原因已查明 0.22 · 只剩照做 0.18 · 与计划矛盾 0.09    第 9 步后 · Drex · 312 ms')
  expect(rowsOf(notsent)[0]).toBe('▮▮▮▯▯ high  ! 要 xhigh，实际发出 high   第 5 轮 · 第 8 步')
  expect(rowsOf(notsent)[2]).toBe('评 ···▲···▲   第 7 步后 high → xhigh（还没发出） · 最新结果和原计划矛盾')
  expect(rowsOf(locked)[0]).toBe('▮▮▮▯▯ high  ■ 已锁定   第 2 轮 · 第 5 步')
  expect(rowsOf(locked)[2]).toBe('上次评估 锁定期间不评估')
  expect(rowsOf(locked)[3]).toBe('生效 skill 推荐 · 档位核对   锁定 发消息定档 · 中途换挡 · agent 定档   关 进展记录')
  expect(rowsOf(ordinary)[1]).toBe('步 ██████████████┄┄┄┄┄┄◇   下次评估 再 8 步')
  expect(rowsOf(ordinary)[3]).toBe('上次评估 × 评估失败，档位不变    第 13 步后 · Drex 超时')
  expect(rowsOf(ordinary)[4]).toMatch(/   ! Drex drex-max-v1\.1 · 最近一次超时$/)
  const noBackend = boardModel(readConfig({}), SCENES.up)
  expect(timelineRows(noBackend, { columns: 200, isPaneOpen: false }).map(rowText)[4]).toBe('生效 档位核对   未生效 发消息定档 · 中途换挡 · agent 定档 · skill 推荐   关 进展记录   ! 没有密钥')
})
