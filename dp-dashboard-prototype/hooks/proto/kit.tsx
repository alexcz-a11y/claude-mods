// PROTOTYPE kit: the shared palette, width helpers and small drawing parts.
//
// Palette rules
//   one accent (theme key `claude`), semantic state colours from theme keys,
//   so light and dark terminals both work; hex only for the effort ramp
//   (low cool -> max hot) and the four model chips.

import type { Elements } from 'claude-code'
import type { AState, Effort, Model, Probs } from './data'
import { EFFORTS } from './data'

export type T = Elements['terminal']

export const ACCENT = 'claude'
export const STATE_COLOR: Record<AState, string> = {
  running: 'claude',
  done: 'success',
  failed: 'error',
  queued: 'inactive',
}
export const WARN = 'warning'
export const OK = 'success'
export const BAD = 'error'
export const MUTED = 'inactive'

/** Effort ramp: cool blue to hot red; mid tones that read on light and dark. */
export const EFFORT_COLOR: Record<Effort, string> = {
  low: '#4A90D9',
  medium: '#2BAE9C',
  high: '#D1A21F',
  xhigh: '#E8742A',
  max: '#D93B4B',
}
export const EFFORT_LABEL: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }
export const EFFORT_SHORT: Record<Effort, string> = { low: 'low', medium: 'med', high: 'high', xhigh: 'xhi', max: 'max' }

/** Model chips: light tints with dark ink, one hue per model. */
export const MODEL_BG: Record<Model, string> = {
  haiku: '#8AD7E1',
  sonnet: '#A9B4F5',
  opus: '#D5A5F0',
  fable: '#F2C078',
}
export const MODEL_INK = '#14171C'

export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// -- display width ----------------------------------------------------------

function cw(cp: number): number {
  if (cp < 0x20) return 0
  if (cp < 0x300) return 1
  if (cp <= 0x36f) return 0
  if (cp === 0x200b || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  )
    return 2
  return 1
}

export function dw(s: string): number {
  let n = 0
  for (const ch of s) n += cw(ch.codePointAt(0) ?? 0)
  return n
}

/** Cut `s` to at most `w` cells, ending in an ellipsis when something was lost. */
export function fit(s: string, w: number): string {
  if (w <= 0) return ''
  if (dw(s) <= w) return s
  let out = ''
  let used = 0
  for (const ch of s) {
    const c = cw(ch.codePointAt(0) ?? 0)
    if (used + c > w - 1) break
    out += ch
    used += c
  }
  return out + '…'
}

export function padR(s: string, w: number): string {
  const f = fit(s, w)
  return f + ' '.repeat(Math.max(0, w - dw(f)))
}
export function padL(s: string, w: number): string {
  const f = fit(s, w)
  return ' '.repeat(Math.max(0, w - dw(f))) + f
}

export function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function pct(p: number): string {
  return p < 0.005 ? '.00' : p >= 0.995 ? '1.0' : p.toFixed(2).slice(1)
}

// -- text parts -------------------------------------------------------------

/** A model chip: tinted background, dark ink, fixed 8 cells. */
export function chip(t: T, model: Model | undefined, routed = true) {
  const { Text } = t
  if (model === undefined) return <Text color={MUTED}>{' 待定   '}</Text>
  // not routed: the agent runs on the main agent's model, drawn as amber text with a star
  if (!routed) return <Text color={WARN} bold>{(' ' + model + '*').padEnd(8)}</Text>
  return (
    <Text backgroundColor={MODEL_BG[model]} color={MODEL_INK} bold>
      {' ' + model.padEnd(6) + ' '}
    </Text>
  )
}

/** Five pips, `n` filled in the effort's colour: ▰▰▰▰▱ */
export function pips(t: T, effort: Effort | undefined) {
  const { Text } = t
  if (effort === undefined) return <Text color={MUTED}>▱▱▱▱▱</Text>
  const n = EFFORTS.indexOf(effort) + 1
  return (
    <Text>
      <Text color={EFFORT_COLOR[effort]}>{'▰'.repeat(n)}</Text>
      <Text color={MUTED}>{'▱'.repeat(5 - n)}</Text>
    </Text>
  )
}

/** Pips plus the effort word, in the effort's colour. */
export function effortTag(t: T, effort: Effort | undefined, width = 12) {
  const { Text } = t
  if (effort === undefined) return <Text color={MUTED}>{padR('▱▱▱▱▱ —', width)}</Text>
  return (
    <Text>
      {pips(t, effort)}
      <Text color={EFFORT_COLOR[effort]} bold>
        {' ' + effort.padEnd(Math.max(0, width - 6))}
      </Text>
    </Text>
  )
}

export function stateGlyph(t: T, state: AState, frame: number, routed = true) {
  const { Text } = t
  if (state === 'running') return <Text color={routed ? STATE_COLOR.running : WARN} bold>{SPIN[frame % SPIN.length]}</Text>
  if (state === 'done') return <Text color={STATE_COLOR.done}>✔</Text>
  if (state === 'failed') return <Text color={STATE_COLOR.failed} bold>✘</Text>
  return <Text color={STATE_COLOR.queued}>○</Text>
}

// -- bars -------------------------------------------------------------------

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** A horizontal bar `w` cells wide, with eighth-block resolution. Padded with spaces. */
export function hbar(p: number, w: number): string {
  const v = Math.max(0, Math.min(1, p)) * w
  let full = Math.floor(v)
  let eighth = Math.round((v - full) * 8)
  if (eighth === 8) {
    full += 1
    eighth = 0
  }
  const s = '█'.repeat(full) + EIGHTHS[eighth]
  return s + ' '.repeat(Math.max(0, w - dw(s)))
}

const STEPS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** Five tiny vertical bars for a probability row; the picked level in its ramp colour, the rest muted. */
export function histogram(t: T, probs: Probs, picked: Effort | undefined) {
  const { Text } = t
  const max = Math.max(...EFFORTS.map((e) => probs[e]), 0.0001)
  return (
    <Text>
      {EFFORTS.map((e) => {
        const p = probs[e]
        const glyph = p < 0.005 ? '·' : (STEPS[Math.max(0, Math.min(7, Math.round((p / max) * 7)))] ?? '▁')
        return (
          <Text color={e === picked ? EFFORT_COLOR[e] : MUTED} bold={e === picked}>
            {glyph}
          </Text>
        )
      })}
    </Text>
  )
}

/** Skill fits as tiny vertical bars, 0..1 on the full height. */
export function fitBars(t: T, fits: number[]) {
  const { Text } = t
  return (
    <Text color={OK}>
      {fits.slice(0, 5).map((f) => STEPS[Math.max(0, Math.min(7, Math.round(f * 7)))]).join('').padEnd(5, ' ')}
    </Text>
  )
}

// -- Raster -----------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function b64(bytes: number[]): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | (b >> 4)]
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '='
    out += i + 2 < bytes.length ? B64[c & 63] : '='
  }
  return out
}

export const DEFAULT = 0x01000000

export function rgb(hex: string): number {
  return parseInt(hex.slice(1), 16)
}

export type Cell = [string, number, number] // glyph, foreground, background

/** Packs cells (row-major) into the base64 of little-endian u32 triplets a Raster takes. */
export function packCells(cells: Cell[]): string {
  const bytes: number[] = []
  const push = (v: number) => {
    bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255)
  }
  for (const [g, fg, bg] of cells) {
    push(g.codePointAt(0) ?? 32)
    push(fg)
    push(bg)
  }
  return b64(bytes)
}

function mix(a: string, b: string, f: number): number {
  const x = rgb(a)
  const y = rgb(b)
  const ch = (s: number) => Math.round(((x >> s) & 255) * (1 - f) + ((y >> s) & 255) * f)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** The ramp colour at position f in 0..1, interpolated between the five stops. */
export function rampAt(f: number): number {
  const stops = EFFORTS.map((e) => EFFORT_COLOR[e])
  const x = Math.max(0, Math.min(1, f)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))
  return mix(stops[i] ?? stops[0]!, stops[i + 1] ?? stops[0]!, x - i)
}

const TRACK = rgb('#8A9099')

function hex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0')
}

/** A softened ramp colour for the levels that were not picked: same hue, pulled toward grey. */
export function soft(color: string): string {
  return hex(mix(color, '#9AA0A6', 0.55))
}

/**
 * One 100% stacked bar, `columns` wide: a segment per effort level in its ramp colour,
 * the boundary inside a cell drawn with an eighth block (left colour as foreground,
 * right colour as background), so the edges are sub-cell exact.
 */
export function stackCells(probs: Record<Effort, number>, picked: Effort | undefined, columns: number): { columns: number; rows: number; cells: string } {
  const total = EFFORTS.reduce((a, e) => a + probs[e], 0) || 1
  const colorOf = (e: Effort) => rgb(e === picked || picked === undefined ? EFFORT_COLOR[e] : soft(EFFORT_COLOR[e]))
  const edges: { e: Effort; from: number; to: number }[] = []
  let at = 0
  for (const e of EFFORTS) {
    const w = (probs[e] / total) * columns
    edges.push({ e, from: at, to: at + w })
    at += w
  }
  const cells: Cell[] = []
  for (let c = 0; c < columns; c++) {
    const here = edges.filter((x) => x.to > c + 0.001 && x.from < c + 0.999).map((x) => ({ e: x.e, w: Math.min(x.to, c + 1) - Math.max(x.from, c) }))
    here.sort((a, b) => b.w - a.w)
    const first = here[0]
    if (!first) {
      cells.push([' ', DEFAULT, DEFAULT])
      continue
    }
    if (here.length === 1 || first.w > 0.94) {
      cells.push(['█', colorOf(first.e), DEFAULT])
      continue
    }
    // two segments share this cell: the left one by its share, in eighths
    const ordered = [...here].sort((a, b) => EFFORTS.indexOf(a.e) - EFFORTS.indexOf(b.e))
    const left = ordered[0]!
    const right = ordered[ordered.length - 1]!
    const eighth = Math.max(1, Math.min(7, Math.round(left.w * 8)))
    cells.push([EIGHTHS[eighth] ?? '▌', colorOf(left.e), colorOf(right.e)])
  }
  return { columns, rows: 1, cells: packCells(cells) }
}

/**
 * The effort gauge: 5 segments of 4 cells with a 1-cell gap, 24 columns, 3 rows.
 * Row 0 a marker over the current level, row 1 the bar (gradient up to the
 * level, a thin track beyond), row 2 the end labels.
 */
export function gaugeCells(level: Effort | undefined): { columns: number; rows: number; cells: string } {
  const columns = 24
  const rows = 3
  const idx = level === undefined ? -1 : EFFORTS.indexOf(level)
  const cells: Cell[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const seg = Math.floor(c / 5)
      const inSeg = c % 5 < 4
      if (r === 0) {
        const center = idx * 5 + 1
        cells.push(idx >= 0 && (c === center || c === center + 1) ? [c === center ? '◥' : '◤', rgb(EFFORT_COLOR[level!]), DEFAULT] : [' ', DEFAULT, DEFAULT])
      } else if (r === 1) {
        if (!inSeg) cells.push([' ', DEFAULT, DEFAULT])
        else if (seg <= idx) cells.push(['█', rampAt((seg * 5 + (c % 5) + 0.5) / 24), DEFAULT])
        else cells.push(['▄', TRACK, DEFAULT])
      } else {
        const label = 'low' + ' '.repeat(18) + 'max'
        cells.push([label[c] ?? ' ', TRACK, DEFAULT])
      }
    }
  }
  return { columns, rows, cells: packCells(cells) }
}

/** A progress ribbon `columns` wide, 1 row, with a gradient fill and a soft end. */
export function ribbonCells(done: number, total: number, columns: number, running = 0): { columns: number; rows: number; cells: string } {
  const v = total <= 0 ? 0 : (done / total) * columns
  const rv = total <= 0 ? 0 : ((done + running) / total) * columns
  const full = Math.floor(v)
  const part = Math.round((v - full) * 8)
  const cells: Cell[] = []
  for (let c = 0; c < columns; c++) {
    const col = rampAt(0.15 + (c / Math.max(1, columns - 1)) * 0.55)
    if (c < full) cells.push(['█', col, DEFAULT])
    else if (c === full && part > 0) cells.push([EIGHTHS[part] ?? '▏', col, TRACK])
    else if (c < rv) cells.push(['▓', mix('#8A9099', '#E8742A', 0.55), DEFAULT])
    else cells.push(['▁', TRACK, DEFAULT])
  }
  return { columns, rows: 1, cells: packCells(cells) }
}
