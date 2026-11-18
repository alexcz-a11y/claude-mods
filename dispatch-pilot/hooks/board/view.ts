// The board as rows and sections (design 5.14): the timeline above the prompt and the pane beside it, built from a
// BoardModel alone, and the characters each part is drawn with. Pure: nothing here reads state or touches $, and
// nothing the model has said is worked out again. board.tsx draws these; each Tone becomes a theme key there.
import { LEVELS } from '../levels.ts'
import type { Level } from '../levels.ts'
import type { BoardModel, Mark, TrackCell } from './model.ts'

/** How a stretch of text looks. Only theme keys stand behind them, so the board follows the person's theme. */
export type Tone = 'plain' | 'dim' | 'ok' | 'warn' | 'err' | 'info' | 'accent' | Level

export type Part =
  | { t: 'text'; text: string; tone?: Tone; bold?: boolean }
  | { t: 'pips'; level: Level }
  | { t: 'track'; cells: readonly TrackCell[]; ahead: number }
  | { t: 'marks'; cells: readonly TrackCell[] }
  | { t: 'bar'; value: number; tone: Tone; isStrong: boolean }

/**
 * One line. Its parts go in groups: a text part that begins with a space begins a group, and the parts after it, up
 * to the next such part, go with it (a label and its value, one item of a list). A line too wide for its columns
 * loses its last groups whole (fitRow), never its first, and never half a word or half a wide character.
 */
export type Row = { id: string; parts: Part[] }

export type Section = { id: 'now' | 'shifts' | 'last' | 'next' | 'features' | 'agents' | 'skill'; title: string; rows: Row[] }

/** One stretch of a part as drawn: its characters and its look. */
export type Run = { text: string; tone: Tone; bold?: boolean }

// Two columns: the East Asian Wide and Fullwidth ranges, as terminals draw them. Ambiguous characters (·, →, █, ┄, ◇,
// ▲, ×, ▮ and the rest the board draws with) are one, as Ink measures them; marks that combine take none.
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
]
const ZERO: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
]

const within = (c: number, ranges: readonly (readonly [number, number])[]): boolean => ranges.some(([lo, hi]) => c >= lo && c <= hi)

/** The columns a string takes on a terminal. */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (within(c, ZERO)) continue
    w += within(c, WIDE) ? 2 : 1
  }
  return w
}

/** A probability bar's length at 1. */
const BAR_CELLS = 18
/** The most dashes drawn before the next evaluation's mark. */
const AHEAD_MAX = 6
const MARK_GLYPH: Record<Mark, string> = { up: '▲', down: '▼', fail: '×', hold: '·' }

const cellTone = (c: TrackCell): Tone => c.sent ?? c.level

// Neighbours that look alike are drawn as one stretch.
function joined(runs: Run[]): Run[] {
  const out: Run[] = []
  for (const r of runs) {
    if (r.text === '') continue
    const last = out.at(-1)
    if (last !== undefined && last.tone === r.tone && last.bold === r.bold) out[out.length - 1] = { ...last, text: last.text + r.text }
    else out.push(r)
  }
  return out
}

/** The characters a part is drawn with on the terminal, and how each stretch looks (the brief's table). */
export function runsOf(p: Part): Run[] {
  switch (p.t) {
    case 'text':
      return p.text === '' ? [] : [{ text: p.text, tone: p.tone ?? 'plain', ...(p.bold === true ? { bold: true } : {}) }]
    case 'pips': {
      const n = LEVELS.indexOf(p.level) + 1
      return joined([
        { text: '▮'.repeat(n), tone: p.level },
        { text: '▯'.repeat(LEVELS.length - n), tone: 'dim' },
      ])
    }
    case 'track': {
      const ahead: Run[] = p.ahead > 0 ? [{ text: '┄'.repeat(Math.min(p.ahead, AHEAD_MAX)), tone: 'dim' }, { text: '◇', tone: 'accent' }] : []
      return joined([...p.cells.map((c): Run => ({ text: '█', tone: cellTone(c) })), ...ahead])
    }
    case 'marks':
      return joined(
        p.cells.map((c): Run => {
          if (c.mark === null) return { text: ' ', tone: 'plain' }
          if (c.mark === 'hold') return { text: MARK_GLYPH.hold, tone: 'dim' }
          if (c.mark === 'fail') return { text: MARK_GLYPH.fail, tone: 'err' }
          return { text: MARK_GLYPH[c.mark], tone: cellTone(c) }
        }),
      )
    case 'bar':
      return [{ text: barText(p.value), tone: p.tone, ...(p.isStrong ? { bold: true } : {}) }]
  }
}

function barText(value: number): string {
  const n = Math.round(value * BAR_CELLS)
  return n >= 1 ? '█'.repeat(n) : '▏'
}

/** A row's characters, its parts' runs joined (what the tests read). */
export function rowText(row: Row): string {
  return row.parts
    .flatMap(runsOf)
    .map((r) => r.text)
    .join('')
}

const partWidth = (p: Part): number => runsOf(p).reduce((w, r) => w + displayWidth(r.text), 0)

/** The row in its columns: its last groups dropped whole until it fits; the first group stays, whatever its width. */
export function fitRow(row: Row, columns: number): Row {
  const groups: Part[][] = []
  for (const p of row.parts) {
    const last = groups.at(-1)
    if (last === undefined || (p.t === 'text' && p.text.startsWith(' '))) groups.push([p])
    else last.push(p)
  }
  const kept: Part[] = []
  let width = 0
  for (const g of groups) {
    const w = g.reduce((sum, p) => sum + partWidth(p), 0)
    if (kept.length > 0 && width + w > columns) break
    kept.push(...g)
    width += w
  }
  return kept.length === row.parts.length ? row : { ...row, parts: kept }
}

// Which of a group's marks is drawn: a failure first, then a shift (the later of an up and a down), then a hold.
const MARK_RANK: Record<Mark, number> = { fail: 3, up: 2, down: 2, hold: 1 }

/**
 * The cells in at most maxCells columns: every per cells become one, which takes the level and the sent of its last
 * cell and the weightiest mark among them.
 */
export function fitTrack(cells: readonly TrackCell[], maxCells: number): { cells: TrackCell[]; per: number } {
  const per = Math.max(1, Math.ceil(cells.length / Math.max(1, maxCells)))
  if (per === 1) return { cells: [...cells], per }
  const out: TrackCell[] = []
  for (let i = 0; i < cells.length; i += per) {
    const group = cells.slice(i, i + per)
    let mark: Mark | null = null
    for (const c of group) {
      if (c.mark !== null && (mark === null || MARK_RANK[c.mark] >= MARK_RANK[mark])) mark = c.mark
    }
    const last = group[group.length - 1]
    if (last !== undefined) out.push({ level: last.level, sent: last.sent, mark })
  }
  return { cells: out, per }
}

const text = (s: string, tone?: Tone, bold?: boolean): Part => ({ t: 'text', text: s, ...(tone === undefined ? {} : { tone }), ...(bold === true ? { bold } : {}) })

/** The text padded with spaces to a width, one space at least. */
function padded(s: string, width: number): string {
  return s + ' '.repeat(Math.max(1, width - displayWidth(s)))
}

const STATUS: Record<BoardModel['status']['kind'], { mark: string; tone: Tone }> = {
  sent: { mark: '✓', tone: 'ok' },
  mismatch: { mark: '!', tone: 'warn' },
  unverified: { mark: '–', tone: 'dim' },
  locked: { mark: '■', tone: 'info' },
  idle: { mark: '–', tone: 'dim' },
  none: { mark: '–', tone: 'dim' },
}

const statusText = (m: BoardModel): string => `${STATUS[m.status.kind].mark} ${m.status.text}`

/** The pips and the level's name; a dash when no level is known. */
function levelParts(m: BoardModel): Part[] {
  if (m.level === null) return [text('—', 'dim')]
  return [{ t: 'pips', level: m.level }, text(` ${m.level}`, m.level, true)]
}

const RESULT: Record<Mark, { arrow: string; tone: Tone }> = {
  up: { arrow: '↑ ', tone: 'accent' },
  down: { arrow: '↓ ', tone: 'info' },
  fail: { arrow: '× ', tone: 'err' },
  hold: { arrow: '', tone: 'plain' },
}

function resultPart(last: NonNullable<BoardModel['last']>): Part {
  const r = RESULT[last.mark]
  return text(r.arrow + last.text, r.tone)
}

// Why there is no last evaluation: a lock judges nothing; between turns none was ever recorded; else none came yet.
function noEvaluation(m: BoardModel): string {
  if (m.status.kind === 'locked') return '锁定期间不评估'
  return m.isIdle ? '还没有评估' : '本轮还没有评估'
}

/** The track's room: the brief's columns less 34, and never under 10 cells. */
const trackRoom = (columns: number): number => Math.max(10, columns - 34)

function nowRow(m: BoardModel): Row {
  return { id: 'now', parts: [...levelParts(m), text(`  ${statusText(m)}`, STATUS[m.status.kind].tone), text(`   ${m.where}`, 'dim')] }
}

function nextParts(m: BoardModel): Part[] {
  return [text('   下次评估 ', 'dim'), text(m.next.main)]
}

// The scale goes right after the track: a row too narrow for everything keeps it before the next evaluation, since
// the cells cannot be read without it.
function trackRows(m: BoardModel, columns: number): Row[] {
  const fit = fitTrack(m.track, trackRoom(columns))
  const scale = fit.per > 1 ? [text(`  每格 ${fit.per} 步`, 'dim')] : []
  const shift = m.shifts.at(-1)
  const shiftParts: Part[] =
    shift === undefined
      ? []
      : [
          text(`   ${shift.at} ${shift.from} → ${shift.to}`),
          ...(shift.isSent ? [] : [text('（还没发出）', 'warn')]),
          ...(shift.why === '' ? [] : [text(` · ${shift.why}`, 'dim')]),
        ]
  return [
    { id: 'track', parts: [text('步 ', 'dim'), { t: 'track', cells: fit.cells, ahead: m.next.ahead }, ...scale, ...nextParts(m)] },
    { id: 'marks', parts: [text('评 ', 'dim'), { t: 'marks', cells: fit.cells }, ...shiftParts] },
  ]
}

// The result first, so it is what a narrow row keeps; then each answer, then when and by whom.
function lastRow(m: BoardModel): Row {
  const last = m.last
  if (last === null) return { id: 'last', parts: [text('上次评估 ', 'dim'), text(noEvaluation(m), 'dim')] }
  return {
    id: 'last',
    parts: [text('上次评估 ', 'dim'), resultPart(last), ...last.nouls.map((n) => text(` · ${n.label} ${n.value.toFixed(2)}`, 'dim')), text(`    ${last.at} · ${last.by}`, 'dim')],
  }
}

const FEATURE_GROUPS: { state: BoardModel['features'][number]['state']; label: string; tone: Tone }[] = [
  { state: 'active', label: '生效', tone: 'ok' },
  { state: 'inactive', label: '未生效', tone: 'warn' },
  { state: 'locked', label: '锁定', tone: 'info' },
  { state: 'off', label: '关', tone: 'dim' },
]

function featuresRow(m: BoardModel): Row {
  const parts: Part[] = []
  for (const g of FEATURE_GROUPS) {
    const names = m.features.filter((f) => f.state === g.state).map((f) => f.label)
    if (names.length === 0) continue
    const itemTone: Tone | undefined = g.state === 'off' ? 'dim' : undefined
    parts.push(text(`${parts.length === 0 ? '' : '   '}${g.label} `, g.tone))
    names.forEach((name, i) => parts.push(text(i === 0 ? name : ` · ${name}`, itemTone)))
  }
  if (!m.backend.isOk) parts.push(text(`   ! ${m.backend.text}`, 'warn'))
  return { id: 'features', parts }
}

// Between turns, one row: the level the session is set at, the one the last turn ended at, and the next evaluation.
function idleRow(m: BoardModel): Row {
  const ended = m.sent === null ? [] : [text(`   上一轮结束在 ${m.sent}`, 'dim')]
  return { id: 'idle', parts: [...levelParts(m), text(`  ${statusText(m)}`, STATUS[m.status.kind].tone), ...ended, ...nextParts(m)] }
}

/** The timeline's rows in their columns (design 5.14). With the pane open, only the first three: it shows the rest. */
export function timelineRows(m: BoardModel, o: { columns: number; isPaneOpen: boolean }): Row[] {
  const rows = m.isIdle ? [idleRow(m)] : [nowRow(m), ...trackRows(m, o.columns), ...(o.isPaneOpen ? [] : [lastRow(m), featuresRow(m)])]
  return rows.map((r) => fitRow(r, o.columns))
}

// The pane's rows: a sentence is one group, which the pane wraps; only rows of columns (bars, answers) are cut.

function nowRows(m: BoardModel): Row[] {
  const rows: Row[] = [
    { id: 'level', parts: levelParts(m) },
    { id: 'status', parts: [text(statusText(m), STATUS[m.status.kind].tone)] },
  ]
  if (m.isIdle) {
    if (m.sent !== null) rows.push({ id: 'ended', parts: [text(`上一轮结束在 ${m.sent}`, 'dim')] })
  } else rows.push({ id: 'where', parts: [text(m.where, 'dim')] })
  const shift = m.shifts.at(-1)
  if (shift !== undefined) {
    rows.push({ id: 'shift', parts: [text(`${shift.at} ${shift.from} → ${shift.to}`), ...(shift.isSent ? [] : [text('（还没发出）', 'warn')])] })
    if (shift.why !== '') rows.push({ id: 'why', parts: [text(shift.why, 'dim')] })
  }
  return rows
}

function shiftRows(m: BoardModel): Row[] {
  if (m.shifts.length === 0) return [{ id: 'none', parts: [text('这一轮没有换挡', 'dim')] }]
  const at = Math.max(...m.shifts.map((s) => displayWidth(s.at))) + 2
  return m.shifts.flatMap((s, i): Row[] => [
    { id: `shift-${i}`, parts: [text(padded(s.at, at), 'dim'), text(`${s.from} → ${s.to}`), ...(s.isSent ? [] : [text('（还没发出）', 'warn')])] },
    ...(s.why === '' ? [] : [{ id: `why-${i}`, parts: [text(`  ${s.why}`, 'dim')] }]),
  ])
}

const READING: Record<NonNullable<BoardModel['last']>['nouls'][number]['reading'], { text: string; tone: Tone }> = {
  yes: { text: '是', tone: 'accent' },
  no: { text: '否', tone: 'dim' },
  unsure: { text: '拿不准', tone: 'warn' },
}

const barWidth = (value: number): number => Math.max(1, Math.round(value * BAR_CELLS))

function lastRows(m: BoardModel): Row[] {
  const last = m.last
  if (last === null) return [{ id: 'none', parts: [text(noEvaluation(m), 'dim')] }]
  const rows: Row[] = [{ id: 'result', parts: [resultPart(last)] }]
  const probs = last.probs
  if (probs !== null) {
    // The figures stand in one column, just past the longest bar.
    const longest = Math.max(...LEVELS.map((_, i) => barWidth(probs[i] ?? 0)))
    for (const level of [...LEVELS].reverse()) {
      const p = probs[LEVELS.indexOf(level)] ?? 0
      const isNow = level === m.level
      rows.push({
        id: `bar-${level}`,
        parts: [
          text(padded(level, 8), isNow ? level : 'dim', isNow),
          { t: 'bar', value: p, tone: level, isStrong: isNow },
          text(`${' '.repeat(longest - barWidth(p) + 1)}${p.toFixed(2)}`, 'dim'),
          ...(isNow ? [text('  ◂ 现在', 'dim')] : []),
        ],
      })
    }
  }
  const label = Math.max(0, ...last.nouls.map((n) => displayWidth(n.label))) + 2
  last.nouls.forEach((n, i) => {
    const reading = READING[n.reading]
    rows.push({ id: `noul-${i}`, parts: [text(padded(n.label, label)), text(n.value.toFixed(2), 'dim'), text(`  ${reading.text}`, reading.tone)] })
  })
  last.rules.forEach((rule, i) => rows.push({ id: `rule-${i}`, parts: [text(rule, 'dim')] }))
  rows.push({ id: 'by', parts: [text(`${last.at} · ${last.by}`, 'dim')] })
  return rows
}

function nextRows(m: BoardModel): Row[] {
  return [{ id: 'main', parts: [text(m.next.main)] }, ...(m.next.sub === '' ? [] : [{ id: 'sub', parts: [text(m.next.sub, 'dim')] }])]
}

const FEATURE: Record<BoardModel['features'][number]['state'], { glyph: string; word: string; tone: Tone }> = {
  active: { glyph: '●', word: '生效', tone: 'ok' },
  inactive: { glyph: '●', word: '未生效', tone: 'warn' },
  locked: { glyph: '●', word: '已锁定', tone: 'info' },
  off: { glyph: '○', word: '关', tone: 'dim' },
}

function featureRows(m: BoardModel): Row[] {
  const label = Math.max(0, ...m.features.map((f) => displayWidth(f.label))) + 1
  const rows = m.features.map((f, i): Row => {
    const look = FEATURE[f.state]
    return {
      id: `feature-${i}`,
      parts: [text(`${look.glyph} `, look.tone), text(padded(f.label, label), f.state === 'off' ? 'dim' : undefined), text(f.note === '' ? look.word : `${look.word} · ${f.note}`, look.tone)],
    }
  })
  return [...rows, { id: 'backend', parts: [text('后端 ', 'dim'), text(m.backend.text, m.backend.isOk ? 'dim' : 'warn')] }]
}

function agentRows(m: BoardModel): Row[] {
  const type = Math.max(0, ...m.agents.map((a) => displayWidth(a.type))) + 2
  return m.agents.map((a, i): Row => ({
    id: `agent-${i}`,
    parts: [text(a.isVerified ? '✓ ' : '– ', a.isVerified ? 'ok' : 'dim'), text(padded(a.type, type)), text(a.text), ...(a.isVerified ? [] : [text('（未核对）', 'dim')])],
  }))
}

/** The pane's sections, in their fixed order (design 5.14); agents and the skill only when there are some. */
export function paneSections(m: BoardModel): Section[] {
  const out: Section[] = [
    { id: 'now', title: '现在', rows: nowRows(m) },
    { id: 'shifts', title: '换挡记录', rows: shiftRows(m) },
    { id: 'last', title: '上次评估', rows: lastRows(m) },
    { id: 'next', title: '下次评估', rows: nextRows(m) },
    { id: 'features', title: '功能', rows: featureRows(m) },
  ]
  if (m.agents.length > 0) out.push({ id: 'agents', title: 'agent', rows: agentRows(m) })
  if (m.skill !== null) out.push({ id: 'skill', title: '这条消息推荐的 skill', rows: [{ id: 'skill', parts: [text(m.skill)] }] })
  return out
}

/** The footer's label: dp, the level (a dash when none is known), the status's mark. */
export function footerLabel(m: BoardModel): string {
  const mark = m.status.kind === 'sent' || m.status.kind === 'mismatch' || m.status.kind === 'locked' ? STATUS[m.status.kind].mark : '–'
  return `dp ${m.level ?? '—'} ${mark}`
}
