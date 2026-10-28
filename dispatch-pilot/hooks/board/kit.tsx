// The screens' visual language (spec #22 「视觉语言」, prototype D's kit): the
// palette, the cell-width helpers the fixed columns need, and the small parts
// every screen draws (a model chip, an effort tag, a state glyph, the marks:
// a time ribbon, a stacked bar, as a Raster's cells on the terminal and as an
// Svg on the surfaces that have one). Pure: the element table comes
// in as `t` (`$.ui.resolve(e)` in the hook's file); nothing here reads the board.
//
// Faces: the terminal is monospaced; Desktop draws text in a proportional face,
// so whatever stands in a column or changes by itself is drawn `mono` (a chip,
// the pips, a glyph, a column padded with spaces) or `tabular` (a number). The
// terminal ignores both.
//
// Colours: one accent (the theme's `claude`), the theme's semantic keys for
// state, so light and dark terminals both read; hex only where a colour must
// be a fixed one: the effort ramp, the four model chips (a light tint with dark ink on it, its own background),
// the four model inks (mid tones that hold on either background), and the
// greys of a Raster (the ribbon's track, what a finished bar softens toward).

import type { Elements, RenderNode } from 'claude-code'
import { EFFORTS, type Effort } from '../decision/effort.ts'
import type { AgentState, Model } from '../core/report.ts'
import type { StatusTone } from './view.ts'

/** The terminal's element table: what the Raster parts draw with. */
export type T = Elements['terminal']
/**
 * The elements every surface has: all that the text parts need. The terminal's and the other surfaces' tables both
 * fit it, so one drawing serves them all; only a Raster (the terminal's alone, `Raster` below) is left out of it.
 */
export type TT = Pick<T, 'Box' | 'Text' | 'Button'>
/** The terminal's Raster constructor: given to a drawing on the terminal, absent on every other surface (a Raster is refused there). */
export type Raster = T['Raster']
/** The Svg constructor of the surfaces that draw one (Desktop, VS Code, the mobile app); the terminal has none. */
export type Svg = Elements['desktop']['Svg']

/**
 * A time ribbon's bar: from `from` to `to` seconds (null: queued, a dot where it was spawned) of a `span` every ribbon
 * shares, in `color` (`#rrggbb`); a running agent's grows on by itself for `grow` seconds, up to the next redraw where
 * the screens redraw seldom (an Svg's animation; the terminal's cells redraw every frame instead).
 */
export type RibbonBar = { from: number; to: number | null; span: number; color: string; grow?: number }

/**
 * The marks a drawing puts beside its words, `columns` cells wide each: a time ribbon, the effort probabilities'
 * stacked bar. The terminal draws them as a Raster's cells (`rasterMarks`), the surfaces with an Svg as a small SVG
 * (`svgMarks`); a surface with neither gets none, and the words alone say the same.
 */
export type Marks = {
  ribbon: (key: string, bar: RibbonBar, columns: number) => RenderNode
  stack: (key: string, probs: Record<Effort, number>, picked: Effort | undefined, columns: number) => RenderNode
}

export const ACCENT = 'claude'
export const OK = 'success'
export const BAD = 'error'
export const WARN = 'warning'
export const MUTED = 'inactive'
/** A skill for the person to try (「可试 /x」). */
export const SKILL = 'suggestion'

/** An agent's status cell, by its tone (the band's row, the card's state). */
export const STATUS_COLOR: Record<StatusTone, string> = { run: ACCENT, done: MUTED, fail: BAD, warn: WARN, muted: MUTED }

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
const MODEL_INK = '#14171C'
/** A model's name written as text, in its chip's hue: deep enough for a light terminal, light enough for a dark one (contrast 3.7 or more on white and on #1E1E1E). */
export const MODEL_FG: Record<Model, string> = {
  haiku: '#1F8A9A',
  sonnet: '#5B6FD6',
  opus: '#A05BC8',
  fable: '#B07A1F',
}

/** A running agent's glyph, one frame per tick. */
export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** The running glyph for a frame: the spinner's, or a still dot where the screens redraw too seldom to spin (frame -1). */
export function spin(frame: number): string {
  return frame < 0 ? '●' : (SPIN[frame % SPIN.length] ?? '●')
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

/** The cells one code point takes on the terminal: CJK (extension B and later too), emoji and fullwidth two, combining marks none. */
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
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
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
function padRight(text: string, w: number): string {
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

/** A probability or confidence in two digits: `.59`, `1.0`. Drawn `tabular` where it stands in a column, so its digits line up on a surface whose face is proportional. */
export function pct(p: number): string {
  return p < 0.005 ? '.00' : p >= 0.995 ? '1.0' : p.toFixed(2).slice(1)
}

/** `pct` of a rule step's field, which is typed loosely: `?` where it is not a number. */
export function pctText(value: unknown): string {
  return typeof value === 'number' ? pct(value) : '?'
}

// ---- parts ------------------------------------------------------------------

/** A model chip, 8 cells: the model's tint with dark ink; not routed, the engine's model in amber with a star. */
export function chip(t: TT, model: Model | undefined, routed: boolean) {
  const { Text } = t
  if (model === undefined) return <Text color={MUTED} mono>{padRight(' —', 8)}</Text>
  if (!routed) return <Text color={WARN} bold mono>{padRight(` ${model}*`, 8)}</Text>
  return (
    <Text backgroundColor={MODEL_BG[model]} color={MODEL_INK} bold mono>
      {` ${model.padEnd(6)} `}
    </Text>
  )
}

/** Five pips, as many filled as the level is high, in the level's colour: ▰▰▰▱▱. */
function pips(t: TT, effort: Effort) {
  const { Text } = t
  const n = EFFORTS.indexOf(effort) + 1
  return (
    <Text mono>
      <Text color={EFFORT_COLOR[effort]}>{'▰'.repeat(n)}</Text>
      <Text color={MUTED}>{'▱'.repeat(5 - n)}</Text>
    </Text>
  )
}

/**
 * The effort as it went out, `w` cells: pips and the level's name in its colour; an integer budget as the engine
 * sent it; none (a model without effort) a dash. Under 6 cells (a narrow band) the pips alone.
 */
export function effortTag(t: TT, effort: Effort | number | undefined, w = 12) {
  const { Text } = t
  const word = w > 5
  if (effort === undefined) return <Text color={MUTED} mono>{padRight(word ? '▱▱▱▱▱ —' : '▱▱▱▱▱', w)}</Text>
  if (typeof effort === 'number') return <Text color={MUTED} mono>{padRight(word ? `▱▱▱▱▱ ${effort}` : '▱▱▱▱▱', w)}</Text>
  return (
    <Text>
      {pips(t, effort)}
      {word ? (
        <Text color={EFFORT_COLOR[effort]} bold>
          {padRight(` ${effort}`, w - 5)}
        </Text>
      ) : null}
    </Text>
  )
}

/** The effort as its word alone in its colour, without the terminal's pips: the other surfaces' (a budget in grey, none a dash). */
export function effortWord(t: TT, effort: Effort | number | undefined) {
  const { Text } = t
  if (effort === undefined) return <Text color={MUTED}>—</Text>
  if (typeof effort === 'number') return <Text color={MUTED} tabular>{String(effort)}</Text>
  return (
    <Text color={EFFORT_COLOR[effort]} weight="semibold">
      {effort}
    </Text>
  )
}

/** `opus·xhigh`: the model in its tint, the effort in the colour of `level` (grey when it is none); both amber when not routed. `bold` as the band draws it, not the footer. */
export function readout(t: TT, model: Model | undefined, effort: string | number | undefined, level: Effort | undefined, routed: boolean, bold = true) {
  const { Text } = t
  const weight = bold ? { bold } : {}
  return (
    <Text>
      {model === undefined ? null : <Text color={routed ? MODEL_FG[model] : WARN} {...weight}>{model}</Text>}
      {model !== undefined && effort !== undefined ? <Text color={MUTED}>·</Text> : null}
      {effort === undefined ? null : <Text color={!routed ? WARN : level === undefined ? MUTED : EFFORT_COLOR[level]} {...weight}>{String(effort)}</Text>}
    </Text>
  )
}

/** The skills of a decision: those suggested with their relevance, then those for the person to try (「可试 /x」). */
export function skillsText(t: TT, skills: { suggest: readonly { name: string; relevance: number }[]; try: readonly { name: string }[] }) {
  const { Text } = t
  return (
    <Text>
      {skills.suggest.map((skill, i) => (
        <Text>
          {i > 0 ? <Text color={MUTED}>{' · '}</Text> : null}
          {skill.name}
          <Text color={OK} tabular>{` ${pct(skill.relevance)}`}</Text>
        </Text>
      ))}
      {skills.try.length === 0 ? null : <Text color={SKILL} bold>{`${skills.suggest.length > 0 ? '  ' : ''}可试 ${skills.try.map((skill) => `/${skill.name}`).join(' ')}`}</Text>}
    </Text>
  )
}

/** An agent's state: a spinner while it runs (a still dot off the terminal; amber when its steps are not routed), ✔ done, ✘ failed, ○ queued. */
export function stateGlyph(t: TT, state: AgentState, frame: number, routed: boolean) {
  const { Text } = t
  if (state === 'running') return <Text color={routed ? ACCENT : WARN} bold mono>{spin(frame)}</Text>
  if (state === 'done') return <Text color={OK} mono>✔</Text>
  if (state === 'failed') return <Text color={BAD} bold mono>✘</Text>
  return <Text color={MUTED} mono>○</Text>
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
const DEFAULT = 0x01000000

/** `#rrggbb` as the number a Raster cell takes. */
export function rgb(hex: string): number {
  return parseInt(hex.slice(1), 16)
}

/** One cell of a Raster: its glyph (one width-1 character), foreground, background. */
type RasterCell = [string, number, number]

/** Cells, row by row, as the base64 of little-endian u32 triplets a Raster takes. */
function packCells(cells: readonly RasterCell[]): string {
  const bytes: number[] = []
  const push = (v: number) => bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255)
  for (const [glyph, fg, bg] of cells) {
    push(glyph.codePointAt(0) ?? 32)
    push(fg)
    push(bg)
  }
  return base64(bytes)
}

/** Two colours mixed, `f` of the way from `a` to `b`. */
function mix(a: number, b: number, f: number): number {
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * (1 - f) + ((b >> shift) & 255) * f)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** A colour pulled toward grey: a finished agent's bar. */
export function soft(hex: string): number {
  return mix(rgb(hex), 0x9aa0a6, 0.55)
}

/** A Raster cell's colour as `#rrggbb`. */
export function hexOf(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

/** `soft`, as the `#rrggbb` a Text's colour takes: a level not picked. */
export function softColor(hex: string): string {
  return hexOf(soft(hex))
}

/** The ribbon's empty track, and the bar of an agent with neither an effort nor a model. */
export const TRACK_HEX = '#8A9099'
const TRACK = rgb(TRACK_HEX)
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

// ---- Svg markup ---------------------------------------------------------------------

/** One mark's SVG document, its size in CSS pixels, what it says for a reader that cannot see it, and whether it moves by itself (an animation, drawn interactive). */
type SvgMark = { source: string; alt: string; width: number; height: number; moving?: true }

/** A length in an SVG attribute: one decimal at most. */
function px(n: number): string {
  return String(Math.round(n * 10) / 10)
}

function svgDoc(w: number, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px(w)}" height="${px(h)}" viewBox="0 0 ${px(w)} ${px(h)}">${body}</svg>`
}

/** The track every mark sits on: the ribbon's grey, half see-through, so it reads on a light and a dark theme. */
function track(w: number, y: number, h: number): string {
  return `<rect x="0" y="${px(y)}" width="${px(w)}" height="${px(h)}" rx="${px(h / 2)}" fill="${TRACK_HEX}" fill-opacity="0.45"/>`
}

/**
 * One agent's time ribbon, `w` pixels: a thin track, the bar from `from` to `to` in its colour (at least 2 pixels), a
 * queued agent's dot. A bar that grows (`grow`) animates its width to where it will be `grow` seconds on, and stays there.
 */
export function ribbonSvg(bar: RibbonBar, w: number): SvgMark {
  const h = 8
  const scale = w / Math.max(bar.span, 1)
  const start = Math.max(0, Math.min(w, bar.from * scale))
  const alt = bar.to === null ? `排队，${mmss(bar.from)} 派出` : `${mmss(bar.from)} 到 ${mmss(bar.to)}`
  if (bar.to === null) return { source: svgDoc(w, h, `${track(w, 3.5, 1)}<circle cx="${px(Math.min(w - 2, Math.max(2, start)))}" cy="4" r="2" fill="${TRACK_HEX}"/>`), alt, width: w, height: h }
  const end = Math.max(start + 2, Math.min(w, bar.to * scale))
  const x = Math.min(start, w - 2)
  const grow = bar.grow ?? 0
  if (grow > 0) {
    const later = Math.max(end, Math.min(w, (bar.to + grow) * scale))
    const animate = `<animate attributeName="width" from="${px(end - x)}" to="${px(later - x)}" dur="${px(grow)}s" fill="freeze"/>`
    return { source: svgDoc(w, h, `${track(w, 3.5, 1)}<rect x="${px(x)}" y="1" width="${px(end - x)}" height="6" rx="2" fill="${bar.color}">${animate}</rect>`), alt, width: w, height: h, moving: true }
  }
  return { source: svgDoc(w, h, `${track(w, 3.5, 1)}<rect x="${px(x)}" y="1" width="${px(end - x)}" height="6" rx="2" fill="${bar.color}"/>`), alt, width: w, height: h }
}

/** The effort probabilities as one 100% stacked bar, `w` pixels, rounded at its ends: a segment per level, the levels not picked softened. */
export function stackSvg(probs: Record<Effort, number>, picked: Effort | undefined, w: number): SvgMark {
  const h = 10
  const total = EFFORTS.reduce((sum, level) => sum + probs[level], 0) || 1
  let at = 0
  const parts: string[] = []
  for (const level of EFFORTS) {
    const sw = (probs[level] / total) * w
    if (sw > 0.05) parts.push(`<rect x="${px(at)}" y="0" width="${px(sw)}" height="${h}" fill="${level === picked || picked === undefined ? EFFORT_COLOR[level] : softColor(EFFORT_COLOR[level])}"/>`)
    at += sw
  }
  const body = `<clipPath id="r"><rect width="${px(w)}" height="${h}" rx="3"/></clipPath>${track(w, 0, h)}<g clip-path="url(#r)">${parts.join('')}</g>`
  return { source: svgDoc(w, h, body), alt: `effort 概率：${EFFORTS.map((level) => `${level} ${pct(probs[level])}`).join(' ')}`, width: w, height: h }
}

// ---- the marks, per surface ---------------------------------------------------------

/** The marks as a Raster's cells: the terminal's. */
export function rasterMarks(Raster: Raster): Marks {
  return {
    ribbon: (key, bar, columns) => <Raster key={key} columns={columns} rows={1} cells={ribbonCells(bar.from, bar.to, bar.span, columns, rgb(bar.color))} />,
    stack: (key, probs, picked, columns) => <Raster key={key} columns={columns} rows={1} cells={stackCells(probs, picked, columns)} />,
  }
}

/**
 * The CSS pixels one cell is taken to be where an Svg is drawn: a Box's width there is in cells of the surface's
 * own metric, which the mod cannot read, so a mark is drawn a little short of its cells rather than past them.
 */
export const CELL_PX = 7

/**
 * The marks as a small SVG each, `columns` cells of `CELL_PX`: the surfaces that have an Svg. An Svg takes no key, so a
 * keyed Box holds it. One that moves is drawn interactive: only then does the surface run its SMIL animation.
 */
export function svgMarks(Svg: Svg, Box: TT['Box']): Marks {
  const draw = (key: string, mark: SvgMark) => (
    <Box key={key}>
      {mark.moving === true ? (
        <Svg source={mark.source} alt={mark.alt} width={mark.width} height={mark.height} isInteractive />
      ) : (
        <Svg source={mark.source} alt={mark.alt} width={mark.width} height={mark.height} />
      )}
    </Box>
  )
  return {
    ribbon: (key, bar, columns) => draw(key, ribbonSvg(bar, columns * CELL_PX)),
    stack: (key, probs, picked, columns) => draw(key, stackSvg(probs, picked, columns * CELL_PX)),
  }
}
