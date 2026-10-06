// The screens' visual language (spec #22 「视觉语言」, prototype D's kit): the
// palette, the cell-width helpers the fixed columns need, and the small parts
// every screen draws (a model chip, an effort tag, a state glyph, a Raster's
// cells). Pure: the element table comes in as `t` (`$.ui.resolve(e)` in the
// hook's file); nothing here reads the board.
//
// Colours: one accent (the theme's `claude`), the theme's semantic keys for
// state, so light and dark terminals both read; hex only for the effort ramp
// and the four model chips, mid tones that hold on either background.

import type { Elements } from 'claude-code'
import { EFFORTS, type Effort } from '../decision/effort.ts'
import type { AgentState, Model } from '../core/report.ts'

/** The terminal's element table: every part here draws with it. */
export type T = Elements['terminal']

export const ACCENT = 'claude'
export const OK = 'success'
export const BAD = 'error'
export const WARN = 'warning'
export const MUTED = 'inactive'
/** A skill for the person to try (「可试 /x」). */
export const SKILL = 'suggestion'

/** The effort ramp, cool to hot: low to max. */
export const EFFORT_COLOR: Record<Effort, string> = {
  low: '#4A90D9',
  medium: '#2BAE9C',
  high: '#D1A21F',
  xhigh: '#E8742A',
  max: '#D93B4B',
}

/** The model chips: a light tint each, dark ink on it. */
export const MODEL_BG: Record<Model, string> = {
  haiku: '#8AD7E1',
  sonnet: '#A9B4F5',
  opus: '#D5A5F0',
  fable: '#F2C078',
}
export const MODEL_INK = '#14171C'

/** A running agent's glyph, one frame per tick. */
export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Whether an effort the engine sent is one of the five levels (it may be an integer budget). */
export function isLevel(effort: unknown): effort is Effort {
  return typeof effort === 'string' && (EFFORTS as readonly string[]).includes(effort)
}

// ---- cell widths --------------------------------------------------------------

/** The cells one code point takes on the terminal: CJK and fullwidth two, combining marks none. */
function cells(cp: number): number {
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

/** The cells a text takes on the terminal. */
export function width(text: string): number {
  let n = 0
  for (const ch of text) n += cells(ch.codePointAt(0) ?? 0)
  return n
}

/** The text cut to at most `w` cells, ending in `…` when something was cut. */
export function fit(text: string, w: number): string {
  if (w <= 0) return ''
  if (width(text) <= w) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const c = cells(ch.codePointAt(0) ?? 0)
    if (used + c > w - 1) break
    out += ch
    used += c
  }
  return `${out}…`
}

/** The text fitted to `w` cells and padded on the right to fill them. */
export function padRight(text: string, w: number): string {
  const cut = fit(text, w)
  return cut + ' '.repeat(Math.max(0, w - width(cut)))
}

/** The text fitted to `w` cells and padded on the left. */
export function padLeft(text: string, w: number): string {
  const cut = fit(text, w)
  return ' '.repeat(Math.max(0, w - width(cut))) + cut
}

/** Seconds as `m:ss`. */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A probability or confidence in two digits: `.59`, `1.0`. */
export function pct(p: number): string {
  return p < 0.005 ? '.00' : p >= 0.995 ? '1.0' : p.toFixed(2).slice(1)
}

// ---- parts ------------------------------------------------------------------

/** A model chip, 8 cells: the model's tint with dark ink; not routed, the engine's model in amber with a star. */
export function chip(t: T, model: Model | undefined, routed: boolean) {
  const { Text } = t
  if (model === undefined) return <Text color={MUTED}>{padRight(' —', 8)}</Text>
  if (!routed) return <Text color={WARN} bold>{padRight(` ${model}*`, 8)}</Text>
  return (
    <Text backgroundColor={MODEL_BG[model]} color={MODEL_INK} bold>
      {` ${model.padEnd(6)} `}
    </Text>
  )
}

/** Five pips, as many filled as the level is high, in the level's colour: ▰▰▰▱▱. */
export function pips(t: T, effort: Effort) {
  const { Text } = t
  const n = EFFORTS.indexOf(effort) + 1
  return (
    <Text>
      <Text color={EFFORT_COLOR[effort]}>{'▰'.repeat(n)}</Text>
      <Text color={MUTED}>{'▱'.repeat(5 - n)}</Text>
    </Text>
  )
}

/**
 * The effort as it went out, `w` cells: pips and the level's name in its colour; an integer budget as the engine
 * sent it; none (a model without effort, haiku) a dash.
 */
export function effortTag(t: T, effort: Effort | number | undefined, w = 12) {
  const { Text } = t
  if (effort === undefined) return <Text color={MUTED}>{padRight('▱▱▱▱▱ —', w)}</Text>
  if (typeof effort === 'number') return <Text color={MUTED}>{padRight(`▱▱▱▱▱ ${effort}`, w)}</Text>
  return (
    <Text>
      {pips(t, effort)}
      <Text color={EFFORT_COLOR[effort]} bold>
        {padRight(` ${effort}`, Math.max(0, w - 5))}
      </Text>
    </Text>
  )
}

/** An agent's state: a spinner while it runs (amber when its steps are not routed), ✔ done, ✘ failed, ○ queued. */
export function stateGlyph(t: T, state: AgentState, frame: number, routed: boolean) {
  const { Text } = t
  if (state === 'running') return <Text color={routed ? ACCENT : WARN} bold>{SPIN[frame % SPIN.length]}</Text>
  if (state === 'done') return <Text color={OK}>✔</Text>
  if (state === 'failed') return <Text color={BAD} bold>✘</Text>
  return <Text color={MUTED}>○</Text>
}

// ---- Raster cells ---------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: readonly number[]): string {
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

/** The terminal's own colour, in a Raster cell. */
export const DEFAULT = 0x01000000

/** `#rrggbb` as the number a Raster cell takes. */
export function rgb(hex: string): number {
  return parseInt(hex.slice(1), 16)
}

/** One cell of a Raster: its glyph (one width-1 character), foreground, background. */
export type RasterCell = [string, number, number]

/** Cells, row by row, as the base64 of little-endian u32 triplets a Raster takes. */
export function packCells(cells: readonly RasterCell[]): string {
  const bytes: number[] = []
  const push = (v: number) => bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255)
  for (const [glyph, fg, bg] of cells) {
    push(glyph.codePointAt(0) ?? 32)
    push(fg)
    push(bg)
  }
  return base64(bytes)
}

/** A colour pulled toward grey: a finished agent's bar. */
export function soft(hex: string): number {
  const x = rgb(hex)
  const grey = 0x9aa0a6
  const mix = (shift: number) => Math.round(((x >> shift) & 255) * 0.45 + ((grey >> shift) & 255) * 0.55)
  return (mix(16) << 16) | (mix(8) << 8) | mix(0)
}

/** The ribbon's empty track. */
const TRACK = rgb('#8A9099')
/** The left eighths, for where a bar ends inside a cell. */
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/**
 * One agent's time ribbon, `columns` cells over the turn's `span` seconds: a thin track, the bar from `from` to
 * `to` (seconds) in `color`, its end exact to an eighth of a cell; a queued agent (`to` null) a dot where it was
 * spawned. Every agent's ribbon has the same span, so bars that overlap ran side by side.
 */
export function ribbonCells(from: number, to: number | null, span: number, columns: number, color: number): string {
  const scale = columns / Math.max(span, 1)
  const start = Math.max(0, Math.min(columns, from * scale))
  const end = to === null ? null : Math.max(start, Math.min(columns, to * scale))
  const out: RasterCell[] = []
  for (let c = 0; c < columns; c++) {
    if (end === null) {
      out.push(c === Math.min(columns - 1, Math.floor(start)) ? ['·', TRACK, DEFAULT] : ['─', TRACK, DEFAULT])
      continue
    }
    // Every agent that started shows at least one cell of its bar.
    const lo = Math.floor(start)
    const covered = Math.min(c + 1, Math.max(end, lo + 1)) - Math.max(c, start)
    if (covered >= 0.94 || (c === lo && end - start < 1)) out.push(['█', color, DEFAULT])
    else if (covered <= 0.06) out.push(['─', TRACK, DEFAULT])
    else if (c < start) out.push(['▐', color, DEFAULT])
    else out.push([EIGHTHS[Math.max(1, Math.min(7, Math.round(covered * 8)))] ?? '▌', color, DEFAULT])
  }
  return packCells(out)
}
