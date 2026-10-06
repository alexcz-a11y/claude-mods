// The screens' visual language (spec #22 「视觉语言」, prototype D's kit): the
// palette, the cell-width helpers the fixed columns need, and the small parts
// every screen draws (a model chip, an effort tag, a state glyph, a Raster's
// cells). Pure: the element table comes in as `t` (`$.ui.resolve(e)` in the
// hook's file); nothing here reads the board.
//
// Colours: one accent (the theme's `claude`), the theme's semantic keys for
// state, so light and dark terminals both read; hex only for the effort ramp
// and the four model chips, mid tones that hold on either background.

import type { Elements, RenderNode } from 'claude-code'
import { EFFORTS, type Effort } from '../decision/effort.ts'
import type { AgentState, Model } from '../core/report.ts'

/** The terminal's element table: what the Raster parts draw with. */
export type T = Elements['terminal']
/**
 * The elements every surface has: all that the text parts need. The terminal's and the other surfaces' tables both
 * fit it, so one drawing serves them all; only a Raster (the terminal's alone, `Raster` below) is left out of it.
 */
export type TT = Pick<T, 'Box' | 'Text' | 'Button'>
/** The terminal's Raster constructor: given to a drawing on the terminal, absent on every other surface (a Raster is refused there). */
export type Raster = T['Raster']

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

/** How many nodes a drawn tree has: Desktop refuses one of 2000 (the engine's own limit is 20000, and a test's mount does not check it). */
export function nodeCount(node: RenderNode): number {
  if (typeof node === 'string') return 1
  return 1 + ('children' in node && node.children !== undefined ? node.children.reduce((sum, child) => sum + nodeCount(child), 0) : 0)
}

/**
 * Whether a drawn tree shows anything: some text, or a Button's label, anywhere in it. The engine's own drawing
 * (`type: 'engine'`) cannot be looked into: `engine` says whether it shows something (the footer's, its modes).
 */
export function showsText(node: RenderNode, engine: boolean): boolean {
  if (typeof node === 'string') return node.trim() !== ''
  if (node.type === 'engine') return engine
  if (node.type === 'Button') return node.props.label !== ''
  return 'children' in node && node.children !== undefined && node.children.some((child: RenderNode) => showsText(child, engine))
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
export function chip(t: TT, model: Model | undefined, routed: boolean) {
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
export function pips(t: TT, effort: Effort) {
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
export function effortTag(t: TT, effort: Effort | number | undefined, w = 12) {
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
export function stateGlyph(t: TT, state: AgentState, frame: number, routed: boolean) {
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

/** `soft`, as the `#rrggbb` a Text's colour takes: a level not picked. */
export function softColor(hex: string): string {
  return `#${soft(hex).toString(16).padStart(6, '0')}`
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

/** Two colours mixed, `f` of the way from `a` to `b`. */
function mix(a: number, b: number, f: number): number {
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * (1 - f) + ((b >> shift) & 255) * f)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** The effort ramp's colour at `f` in 0..1, between its five stops. */
export function rampAt(f: number): number {
  const stops = EFFORTS.map((level) => rgb(EFFORT_COLOR[level]))
  const x = Math.max(0, Math.min(1, f)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))
  return mix(stops[i] ?? 0, stops[i + 1] ?? 0, x - i)
}

/**
 * One 100% stacked bar of the effort probabilities, `columns` cells: a segment per level in its ramp colour (the
 * levels not picked softened), a boundary inside a cell drawn with an eighth block, left colour on right colour.
 */
export function stackCells(probs: Record<Effort, number>, picked: Effort | undefined, columns: number): string {
  const total = EFFORTS.reduce((sum, level) => sum + probs[level], 0) || 1
  const colorOf = (level: Effort) => (level === picked || picked === undefined ? rgb(EFFORT_COLOR[level]) : soft(EFFORT_COLOR[level]))
  const edges: { level: Effort; from: number; to: number }[] = []
  let at = 0
  for (const level of EFFORTS) {
    const w = (probs[level] / total) * columns
    edges.push({ level, from: at, to: at + w })
    at += w
  }
  const out: RasterCell[] = []
  for (let c = 0; c < columns; c++) {
    const here = edges.filter((edge) => edge.to > c + 0.001 && edge.from < c + 0.999).map((edge) => ({ level: edge.level, w: Math.min(edge.to, c + 1) - Math.max(edge.from, c) }))
    const widest = [...here].sort((a, b) => b.w - a.w)[0]
    if (widest === undefined) {
      out.push([' ', DEFAULT, DEFAULT])
      continue
    }
    if (here.length === 1 || widest.w > 0.94) {
      out.push(['█', colorOf(widest.level), DEFAULT])
      continue
    }
    const left = here[0] ?? widest
    const right = here.at(-1) ?? widest
    out.push([EIGHTHS[Math.max(1, Math.min(7, Math.round(left.w * 8)))] ?? '▌', colorOf(left.level), colorOf(right.level)])
  }
  return packCells(out)
}

/** The tick's colours: past the line, short of it. */
const PASSED = rgb('#2BAE9C')
const SHORT = rgb('#D1A21F')

/**
 * A confidence meter, `columns` cells: filled to `conf` along the ramp's cool half, a thin track beyond, and a tick
 * at `threshold` (green when `passed`, amber when not; none when no line was asked).
 */
export function meterCells(conf: number, threshold: number | undefined, passed: boolean | null, columns: number): string {
  const tick = threshold === undefined ? -1 : Math.min(columns - 1, Math.round(threshold * columns))
  const fill = Math.max(0, Math.min(1, conf)) * columns
  const out: RasterCell[] = []
  for (let c = 0; c < columns; c++) {
    const color = rampAt(0.2 + (c / columns) * 0.4)
    if (c === tick) out.push(['┃', passed === true ? PASSED : SHORT, c < fill ? color : DEFAULT])
    else if (c + 1 <= fill) out.push(['█', color, DEFAULT])
    else if (c < fill) out.push(['▌', color, DEFAULT])
    else out.push(['─', TRACK, DEFAULT])
  }
  return packCells(out)
}
