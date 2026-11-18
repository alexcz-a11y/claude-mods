// The board as rows and sections (design 5.14): the timeline above the prompt and the pane beside it, built from a
// BoardModel alone, and the characters each part is drawn with. Pure: nothing here reads state or touches $, and
// nothing the model has said is worked out again. board.tsx draws these; each Tone becomes a theme key there.
import { LEVELS } from '../levels.ts'
import type { Level } from '../levels.ts'
import type { BoardModel, Mark, Readout, TrackCell } from './model.ts'

/** How a stretch of text looks. Only theme keys stand behind them, so the board follows the person's theme. */
export type Tone = 'plain' | 'dim' | 'ok' | 'warn' | 'err' | 'info' | 'accent' | Level

export type Part =
  | { t: 'text'; text: string; tone?: Tone; bold?: boolean }
  | { t: 'pips'; level: Level }
  | { t: 'track'; cells: readonly TrackCell[]; ahead: number; per?: number }
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

/**
 * The row in its columns: its last groups dropped whole until it fits; the first group stays, whatever its width.
 * widthOf measures a part in columns: the terminal's characters by default, the Desktop's drawings by their pixels.
 */
export function fitRow(row: Row, columns: number, widthOf: (p: Part) => number = partWidth): Row {
  const groups: Part[][] = []
  for (const p of row.parts) {
    const last = groups.at(-1)
    if (last === undefined || (p.t === 'text' && p.text.startsWith(' '))) groups.push([p])
    else last.push(p)
  }
  const kept: Part[] = []
  let width = 0
  for (const g of groups) {
    const w = g.reduce((sum, p) => sum + widthOf(p), 0)
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
  starting: { mark: '–', tone: 'dim' },
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

/** The track's room: the brief's columns less 34, and never under 10 cells; at most maxCells where a surface sets one. */
const trackRoom = (columns: number, maxCells = Infinity): number => Math.min(maxCells, Math.max(10, columns - 34))

// The session's kind closes the first row, a group of its own: a row too narrow drops it first.
const kindPart = (m: BoardModel): Part => text(` · ${m.sessionKind}`, 'dim')

function nowRow(m: BoardModel): Row {
  return { id: 'now', parts: [...levelParts(m), text(`  ${statusText(m)}`, STATUS[m.status.kind].tone), text(`   ${m.where}`, 'dim'), kindPart(m)] }
}

function nextParts(m: BoardModel): Part[] {
  return [text('   下次评估 ', 'dim'), text(m.next.main)]
}

// A reading's words (design 5.12), wherever the board prints one; only a reading that differs warns.
const READOUT: Record<Readout, { word: string; tone: Tone }> = {
  sent: { word: '已发出', tone: 'ok' },
  'not-sent': { word: '没发出', tone: 'warn' },
  unverified: { word: '未核对', tone: 'dim' },
}
// A queued note is no reading: the shift waits for a row that can carry it (it warns of nothing).
const QUEUED = '（还没发出）'

/** A shift's or an agent's reading in brackets, after its levels (the pane). */
function readingPart(reading: Readout | 'queued'): Part {
  if (reading === 'queued') return text(QUEUED, 'dim')
  return text(`（${READOUT[reading].word}）`, READOUT[reading].tone)
}

// The scale goes right after the track: a row too narrow for everything keeps it before the next evaluation, since
// the cells cannot be read without it.
function trackRows(m: BoardModel, columns: number, maxCells?: number): Row[] {
  // No cell yet (the first step has not come, or the model takes no effort): no row with an empty 步 label.
  if (m.track.length === 0) return []
  const fit = fitTrack(m.track, trackRoom(columns, maxCells))
  const scale = fit.per > 1 ? [text(`  每格 ${fit.per} 步`, 'dim')] : []
  const shift = m.shifts.at(-1)
  const shiftParts: Part[] =
    shift === undefined
      ? []
      : [
          text(`   ${shift.at} ${shift.from} → ${shift.to}`),
          // A reading is a group of its own, dropped before the shift itself; a queued note stays with it.
          shift.reading === 'queued' ? text(QUEUED, 'dim') : text(` · ${READOUT[shift.reading].word}`, READOUT[shift.reading].tone),
          ...(shift.why === '' ? [] : [text(` · ${shift.why}`, 'dim')]),
        ]
  // When no evaluation is ahead, why, where there is room (a group of its own, dropped first), as the idle row does.
  const why = m.next.ahead === 0 && m.next.sub !== '' ? [text(` · ${m.next.sub}`, 'dim')] : []
  const track: Row = { id: 'track', parts: [text('步 ', 'dim'), { t: 'track', cells: fit.cells, ahead: m.next.ahead, per: fit.per }, ...scale, ...nextParts(m), ...why] }
  // A turn with no evaluation marked and no shift to tell (a locked one) has nothing for the marks row to say.
  if (shift === undefined && fit.cells.every((c) => c.mark === null)) return [track]
  return [track, { id: 'marks', parts: [text('评 ', 'dim'), { t: 'marks', cells: fit.cells }, ...shiftParts] }]
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
  // Why, where there is room: between turns the row is all the timeline shows (a group of its own, dropped first).
  const why = m.next.sub === '' ? [] : [text(` · ${m.next.sub}`, 'dim')]
  return { id: 'idle', parts: [...levelParts(m), text(`  ${statusText(m)}`, STATUS[m.status.kind].tone), ...ended, ...nextParts(m), ...why, kindPart(m)] }
}

// The timeline's rows before they are fitted to their columns; maxCells caps the track's cells (the Desktop's).
function timelineParts(m: BoardModel, o: { columns: number; isPaneOpen: boolean; maxCells?: number }): Row[] {
  return m.isIdle ? [idleRow(m)] : [nowRow(m), ...trackRows(m, o.columns, o.maxCells), ...(o.isPaneOpen ? [] : [lastRow(m), featuresRow(m)])]
}

/**
 * The timeline's rows in their columns (design 5.14). With the pane open, only the rows up to the track's: the pane
 * shows the rest.
 */
export function timelineRows(m: BoardModel, o: { columns: number; isPaneOpen: boolean }): Row[] {
  return timelineParts(m, o).map((r) => fitRow(r, o.columns))
}

// The pane's rows: a sentence is one group, which the pane wraps; only rows of columns (bars, answers) are cut.

function nowRows(m: BoardModel): Row[] {
  const rows: Row[] = [
    { id: 'level', parts: levelParts(m) },
    { id: 'status', parts: [text(statusText(m), STATUS[m.status.kind].tone)] },
  ]
  if (m.isIdle) {
    if (m.sent !== null) rows.push({ id: 'ended', parts: [text(`上一轮结束在 ${m.sent}`, 'dim')] })
    rows.push({ id: 'kind', parts: [text(m.sessionKind, 'dim')] })
  } else rows.push({ id: 'where', parts: [text(`${m.where} · ${m.sessionKind}`, 'dim')] })
  const shift = m.shifts.at(-1)
  if (shift !== undefined) {
    rows.push({ id: 'shift', parts: [text(`${shift.at} ${shift.from} → ${shift.to}`), readingPart(shift.reading)] })
    if (shift.why !== '') rows.push({ id: 'why', parts: [text(shift.why, 'dim')] })
  }
  return rows
}

function shiftRows(m: BoardModel): Row[] {
  if (m.shifts.length === 0) return [{ id: 'none', parts: [text('这一轮没有换挡', 'dim')] }]
  const at = Math.max(...m.shifts.map((s) => displayWidth(s.at))) + 2
  return m.shifts.flatMap((s, i): Row[] => [
    { id: `shift-${i}`, parts: [text(padded(s.at, at), 'dim'), text(`${s.from} → ${s.to}`), readingPart(s.reading)] },
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

const AGENT_MARK: Record<Readout, { mark: string; tone: Tone }> = { sent: { mark: '✓ ', tone: 'ok' }, 'not-sent': { mark: '! ', tone: 'warn' }, unverified: { mark: '– ', tone: 'dim' } }

// An agent the mod left alone has no readout: no mark (its column kept blank) and no words.
function agentRows(m: BoardModel): Row[] {
  const type = Math.max(0, ...m.agents.map((a) => displayWidth(a.type))) + 2
  return m.agents.map((a, i): Row => {
    const reading = a.reading
    const mark = reading === null ? text('  ') : text(AGENT_MARK[reading].mark, AGENT_MARK[reading].tone)
    return { id: `agent-${i}`, parts: [mark, text(padded(a.type, type)), text(a.text), ...(reading === null ? [] : [readingPart(reading)])] }
  })
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

const footerMark = (m: BoardModel): string => (m.status.kind === 'sent' || m.status.kind === 'mismatch' || m.status.kind === 'locked' ? STATUS[m.status.kind].mark : '–')

/** The footer's label: dp, the level (a dash when none is known), the status's mark. */
export function footerLabel(m: BoardModel): string {
  return `dp ${m.level ?? '—'} ${footerMark(m)}`
}

// The Desktop (design 5.14): the same rows and sections, with three kinds of part drawn as one Svg each instead of
// characters. Literal colours appear only inside these drawings; text keeps its theme keys (board.tsx).

/** Each level's colour, cold to warm: on drawings only, never on text. */
export const LEVEL_HEX: Record<Level, string> = { low: '#7c8aa0', medium: '#3fb5b0', high: '#e0b23c', xhigh: '#ee8a3c', max: '#e2557a' }
/**
 * The neutral marks inside a drawing (a hold's dot, the dashes to the next evaluation, the unlit pips): one mid grey
 * that reads on light and dark themes. A drawing is drawn as an image, which does not inherit the text colour, so
 * currentColor would come out black.
 */
export const NEUTRAL_HEX = '#8b8f98'
// The next evaluation's diamond and a failed evaluation's cross, as the prototype draws them.
const ACCENT_HEX = '#d97757'
const FAIL_HEX = '#e8697a'

/** The pixels the Desktop gives one column of the band or the pane: every drawing is measured in columns by it. */
export const PX_PER_COLUMN = 8

/** An Svg's source and how it is laid out: alt says in words what it shows, since the drawing holds no text. */
export type Drawing = { source: string; alt: string; width: number; height: number }

/** The most cells a track drawing holds: more steps share a cell (fitTrack), so its size stays bounded. */
export const TRACK_SVG_CELLS = 60
const CELL_W = 13
const CELL_H = 12
const PITCH = CELL_W + 1
/** The marks' row under the cells. */
const MARK_TOP = CELL_H + 3
const MARK_H = 8
const TRACK_H = MARK_TOP + MARK_H + 3

const svg = (width: number, height: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`

const px = (n: number): string => String(Math.round(n * 10) / 10)

// One evaluation's mark under its cell: a shift is a triangle in the cell's colour, a failure a cross, a hold a grey
// dot.
function markSvg(c: TrackCell, i: number): string {
  const x = i * PITCH
  const mid = x + CELL_W / 2
  const top = MARK_TOP
  const bottom = MARK_TOP + MARK_H
  switch (c.mark) {
    case 'up':
      return `<polygon class="mark-up" points="${px(mid)},${top} ${px(x + 2)},${bottom} ${px(x + CELL_W - 2)},${bottom}" fill="${LEVEL_HEX[c.sent ?? c.level]}"/>`
    case 'down':
      return `<polygon class="mark-down" points="${px(x + 2)},${top} ${px(x + CELL_W - 2)},${top} ${px(mid)},${bottom}" fill="${LEVEL_HEX[c.sent ?? c.level]}"/>`
    case 'fail':
      return `<path class="mark-fail" d="M${px(x + 3)} ${top + 1}L${px(x + CELL_W - 3)} ${bottom - 1}M${px(x + CELL_W - 3)} ${top + 1}L${px(x + 3)} ${bottom - 1}" stroke="${FAIL_HEX}" stroke-width="1.6" stroke-linecap="round" fill="none"/>`
    case 'hold':
      return `<circle class="mark-hold" cx="${px(mid)}" cy="${top + MARK_H / 2}" r="1.5" fill="${NEUTRAL_HEX}"/>`
    default:
      return ''
  }
}

// How many cells each level holds, in the order the levels first appear.
function levelCounts(cells: readonly TrackCell[], unit: string): string {
  const counts = new Map<Level, number>()
  for (const c of cells) counts.set(c.sent ?? c.level, (counts.get(c.sent ?? c.level) ?? 0) + 1)
  return [...counts].map(([level, n]) => `${level} ${n} ${unit}`).join('，')
}

/**
 * The timeline's track as one drawing: a cell per step (13 by 12, one apart) in the level its request carried, the
 * evaluations' marks under them, then a dashed run and a hollow diamond for the next evaluation (none when ahead is
 * 0). More than TRACK_SVG_CELLS cells are merged first; per says how many steps each cell given here already holds.
 */
export function trackSvg(cells: readonly TrackCell[], ahead: number, per = 1): Drawing {
  const fit = fitTrack(cells, TRACK_SVG_CELLS)
  const shown = fit.cells
  const each = per * fit.per
  const trackW = shown.length === 0 ? 0 : shown.length * PITCH - 1
  const parts: string[] = []
  if (shown.length > 0) parts.push(`<clipPath id="ends"><rect width="${trackW}" height="${CELL_H}" rx="${CELL_H / 2}"/></clipPath>`)
  parts.push(`<g clip-path="url(#ends)">${shown.map((c, i) => `<rect class="cell" x="${i * PITCH}" y="0" width="${CELL_W}" height="${CELL_H}" fill="${LEVEL_HEX[c.sent ?? c.level]}"/>`).join('')}</g>`)
  parts.push(shown.map(markSvg).join(''))
  let width = Math.max(1, trackW)
  if (ahead > 0) {
    const from = trackW + 3
    const to = from + Math.min(ahead, AHEAD_MAX) * PITCH
    const mid = CELL_H / 2
    const cx = to + 3 + 5
    parts.push(`<line class="ahead" x1="${from}" y1="${mid}" x2="${to}" y2="${mid}" stroke="${NEUTRAL_HEX}" stroke-width="2" stroke-dasharray="3 3" opacity="0.7"/>`)
    parts.push(`<polygon class="next" points="${cx},${mid - 5} ${cx + 5},${mid} ${cx},${mid + 5} ${cx - 5},${mid}" fill="none" stroke="${ACCENT_HEX}" stroke-width="2"/>`)
    width = cx + 5 + 1
  }
  const unit = each > 1 ? '格' : '步'
  const head = shown.length === 0 ? '还没有步' : each > 1 ? `${shown.length} 格，每格 ${each} 步：${levelCounts(shown, unit)}` : `${shown.length} 步：${levelCounts(shown, unit)}`
  const alt = ahead > 0 ? `${head}；下次评估在 ${ahead} 步后` : head
  return { source: svg(width, TRACK_H, parts.join('')), alt, width, height: TRACK_H }
}

const BAR_H = 9

/**
 * One level's probability bar, width pixels long at 1, never shorter than 2 (a sliver, as the terminal's ▏). The
 * current level's is drawn full, the others a little faded.
 */
export function barSvg(value: number, level: Level, isStrong: boolean, width: number): Drawing {
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  const length = Math.min(width, Math.max(2, Math.round(v * width)))
  const body = `<rect class="bar" x="0" y="0" width="${length}" height="${BAR_H}" rx="3" fill="${LEVEL_HEX[level]}" opacity="${isStrong ? 1 : 0.8}"/>`
  return { source: svg(width, BAR_H, body), alt: `${level} ${v.toFixed(2)}${isStrong ? '（现在）' : ''}`, width, height: BAR_H }
}

/** The pane's bar length for its columns: 18 cells' worth at most, as the terminal draws it, less where it is narrow. */
export function barPixels(columns: number): number {
  return Math.max(3 * PX_PER_COLUMN, Math.min(BAR_CELLS * PX_PER_COLUMN, (columns - 22) * PX_PER_COLUMN))
}

const PIP_W = 9
const PIP_H = 15
const PIP_GAP = 3

/** The five pips: lit up to the level in its colour, the rest grey and faint. */
export function pipsSvg(level: Level): Drawing {
  const n = LEVELS.indexOf(level) + 1
  const width = LEVELS.length * (PIP_W + PIP_GAP) - PIP_GAP
  const body = LEVELS.map((_, i) => {
    const look = i < n ? `fill="${LEVEL_HEX[level]}"` : `fill="${NEUTRAL_HEX}" opacity="0.35"`
    return `<rect class="pip" x="${i * (PIP_W + PIP_GAP)}" y="0" width="${PIP_W}" height="${PIP_H}" rx="2" ${look}/>`
  }).join('')
  return { source: svg(width, PIP_H, body), alt: `档位 ${level}，五档中的第 ${n} 档`, width, height: PIP_H }
}

/**
 * The status line the Desktop shows under the prompt: the level and its latest shift, or what holds it (a lock,
 * the time between turns); a mismatch alone, since it already names both levels.
 */
export function desktopStatus(m: BoardModel): string {
  const lead = m.level === null ? '' : `${m.level} · `
  if (m.status.kind === 'locked') return `${lead}已锁定`
  if (m.isIdle) return `${lead}空闲，${m.next.main === '发出下一条消息时' ? '下一条消息时定档' : m.next.main}`
  if (m.status.kind === 'mismatch') return m.status.text
  const shift = m.shifts.at(-1)
  if (shift === undefined) return `${lead}${m.status.text}`
  const isUp = LEVELS.indexOf(shift.to) > LEVELS.indexOf(shift.from)
  return `${lead}${isUp ? '↑' : '↓'} ${shift.at}由 ${shift.from} ${isUp ? '升到' : '降到'} ${shift.to}`
}

/** The Desktop footer's label: as the terminal's, with a separator its proportional type needs. At most 13 characters. */
export function desktopLabel(m: BoardModel): string {
  return `dp · ${m.level ?? '—'} ${footerMark(m)}`
}

/**
 * A part's width in the Desktop's columns: text by its characters, a drawing by its pixels (PX_PER_COLUMN a column,
 * rounded up). barWidth is the pane's bar length in pixels.
 */
export function desktopWidth(p: Part, barWidth: number): number {
  const columns = (pixels: number): number => Math.ceil(pixels / PX_PER_COLUMN)
  switch (p.t) {
    case 'text':
      return displayWidth(p.text)
    case 'pips':
      return columns(pipsSvg(p.level).width)
    case 'track':
      return columns(trackSvg(p.cells, p.ahead, p.per).width)
    case 'bar':
      return columns(barWidth)
    case 'marks':
      return 0
  }
}

/**
 * A row in the Desktop's columns, its drawings measured by their pixels (fitRow: whole groups dropped from the end,
 * the first kept). Every bar is one width, so the figure after one stands a single space away.
 */
export function fitDesktopRow(row: Row, columns: number, barWidth: number): Row {
  const parts = row.parts.map((p, i) => (p.t === 'text' && row.parts[i - 1]?.t === 'bar' ? { ...p, text: p.text.replace(/^ +/, ' ') } : p))
  return fitRow({ ...row, parts }, columns, (p) => desktopWidth(p, barWidth))
}

/** The track's cells on the Desktop: as many as the terminal's room (columns less 34) holds in pixels, 10 to 60. */
export function desktopTrackCells(columns: number): number {
  return Math.min(TRACK_SVG_CELLS, Math.max(10, Math.floor(((columns - 34) * PX_PER_COLUMN + 1) / PITCH)))
}

/**
 * The timeline's rows as the Desktop draws them, fitted to its columns: the track's drawing holds the marks, so the
 * marks row keeps only its words (the shift), under the track; neither keeps the label that named a row of
 * characters, so the drawing leads its row and is never what a narrow row drops.
 */
export function desktopTimelineRows(m: BoardModel, o: { columns: number; isPaneOpen: boolean }): Row[] {
  const rows = timelineParts(m, { ...o, maxCells: desktopTrackCells(o.columns) }).flatMap((row): Row[] => {
    if (row.id !== 'track' && row.id !== 'marks') return [row]
    const parts = row.parts.slice(1).filter((p) => p.t !== 'marks')
    const [first, ...rest] = parts
    if (first === undefined) return []
    return [{ ...row, parts: first.t === 'text' ? [{ ...first, text: first.text.trimStart() }, ...rest] : parts }]
  })
  return rows.map((row) => fitDesktopRow(row, o.columns, barPixels(o.columns)))
}
