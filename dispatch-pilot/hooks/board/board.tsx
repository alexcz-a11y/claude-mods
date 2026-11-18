// The board (design 5.14): the timeline above the prompt, the pane /dp opens, and a label in the footer, on the
// terminal and on the Desktop (whose status line runtime.ts redraw writes). Each hook reads the state, builds the model
// and the rows (board/model.ts, board/view.ts) and draws them; it writes no state, asks no decision model, and on any
// error draws what it would have drawn without the mod (next).
import { atom, read } from 'claude-code'
import type { Elements, EngineInterface, On, RenderChildren, ThemeKey } from 'claude-code'

import type { Config } from '../config.ts'
import { isLevel } from '../levels.ts'
import { holdBoard, redraw, trace } from '../runtime.ts'
import { emptySession } from '../state.ts'
import { boardModel } from './model.ts'
import type { BoardModel } from './model.ts'
import { TRACK_SVG_CELLS, barPixels, barSvg, desktopLabel, desktopRows, fitRow, footerLabel, paneSections, pipsSvg, runsOf, timelineRows, trackSvg } from './view.ts'
import type { Drawing, Part, Row, Run, Tone } from './view.ts'

// The state atoms this file reads, one line each and alike in every file that declares them: the module scan takes
// only a const of the file that reads or writes (eval/validate.ts checks the copies are the same text).
const SESSION = atom({ plugin: 'dispatch-pilot', key: 'session' } as const, emptySession())
const TURN = atom({ plugin: 'dispatch-pilot', key: 'turn' } as const, null)
const RECENT = atom({ plugin: 'dispatch-pilot', key: 'recent' } as const, [])
const SKILLS = atom({ plugin: 'dispatch-pilot', key: 'skills' } as const, [])

/** The pane's id: $.ui.open, $.ui.close and its ui.render requestId. */
export const PANE_ID = 'dispatch-pilot'
/** The Desktop timeline's most rows (design 5.14). */
const DESKTOP_MAX_ROWS = 12

/**
 * Each Tone as text: a theme key, the theme's dim colour, or the plain text colour, on both surfaces. Theme keys only:
 * a hook cannot tell a light theme from a dark one, and the engine gives each key a colour that reads on the person's.
 */
export const TONE_LOOK: Record<Tone, { color?: ThemeKey; dimColor?: true }> = {
  plain: {},
  dim: { dimColor: true },
  ok: { color: 'success' },
  warn: { color: 'warning' },
  err: { color: 'error' },
  info: { color: 'permission' },
  accent: { color: 'claude' },
  low: { color: 'inactive' },
  medium: { color: 'suggestion' },
  high: { color: 'warning' },
  xhigh: { color: 'claude' },
  max: { color: 'error' },
}

type TerminalText = Elements['terminal']['Text']
type DesktopElements = Pick<Elements['desktop'], 'Box' | 'Text' | 'Svg'>

async function modelOf($: EngineInterface, cfg: Config): Promise<BoardModel> {
  const session = await read($, SESSION)
  const turn = await read($, TURN)
  const recent = await read($, RECENT)
  const skills = await read($, SKILLS)
  return boardModel(cfg, { session, turn, recent, skills })
}

/** Whether the pane is on screen now: open, placed, and the one its surface shows. */
export async function isPaneShown($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some((p) => p.id === PANE_ID && p.isPlaced && p.isShown)
}

/**
 * The board's catch-all: a throw in draw gives null, and the hook passes on with next. A hook that keeps failing (a
 * render runs on every redraw) leaves one debug line, the first: failing holds the sites that have written theirs.
 */
async function drawOpen<T>($: EngineInterface, failing: Set<string>, site: string, draw: () => Promise<T>): Promise<T | null> {
  try {
    return await draw()
  } catch (err) {
    if (!failing.has(site)) {
      failing.add(site)
      trace($, 'ui.render', err)
    }
    return null
  }
}

// One row as one Text on the terminal: a stretch in the plain colour is a bare string, every other a Text of its look.
function drawRow(Text: TerminalText, row: Row, wrap: 'wrap' | 'truncate-end') {
  return (
    <Text wrap={wrap}>
      {row.parts.flatMap(runsOf).map((r) => (r.tone === 'plain' && r.bold !== true ? r.text : <Text {...TONE_LOOK[r.tone]} {...(r.bold === true ? { bold: true } : {})}>{r.text}</Text>))}
    </Text>
  )
}

// The parts the Desktop draws as one Svg each; text (and a bar of no level, which never comes) as characters.
function drawingOf(p: Part, barWidth: number): Drawing | null {
  if (p.t === 'pips') return pipsSvg(p.level)
  if (p.t === 'track') return trackSvg(p.cells, p.ahead, p.per)
  if (p.t === 'bar' && isLevel(p.tone)) return barSvg(p.value, p.tone, p.isStrong, barWidth)
  return null
}

const desktopLook = (r: Run) => ({ ...TONE_LOOK[r.tone], ...(r.bold === true ? { weight: 'semibold' as const } : {}) })

/**
 * One row on the Desktop: its text parts in a Text, as on the terminal (a level's name semibold), each drawing an Svg
 * between them. The figure after a bar stands one space away, since every bar's drawing is one width; a row of bars is
 * set in the monospaced face so its padded columns line up.
 */
function drawDesktopRow(el: DesktopElements, row: Row, barWidth: number) {
  const { Box, Svg, Text } = el
  const isColumns = row.parts.some((p) => p.t === 'bar')
  const children: RenderChildren[] = []
  let runs: Run[] = []
  const flush = () => {
    if (runs.length === 0) return
    children.push(<Text {...(isColumns ? { mono: true } : {})}>{runs.map((r) => (r.tone === 'plain' && r.bold !== true ? r.text : <Text {...desktopLook(r)}>{r.text}</Text>))}</Text>)
    runs = []
  }
  let afterBar = false
  for (const p of row.parts) {
    const d = drawingOf(p, barWidth)
    if (d === null) {
      runs.push(...runsOf(afterBar && p.t === 'text' ? { ...p, text: p.text.replace(/^ +/, ' ') } : p))
      afterBar = false
      continue
    }
    flush()
    children.push(<Svg source={d.source} alt={d.alt} width={d.width} height={d.height} />)
    afterBar = p.t === 'bar'
  }
  flush()
  return (
    <Box flexDirection="row" alignItems="center">
      {children}
    </Box>
  )
}

/**
 * The board's hooks (design 5.14): three drawings on the terminal and the Desktop, and the pane's close; none while
 * cfg.board is off, and then no Desktop status line either.
 */
export function registerBoard(on: On, cfg: Config): void {
  // The status line (runtime.ts redraw) follows the same switch.
  holdBoard(cfg)
  if (!cfg.board) return
  // The sites whose failure is in the debug log already. Per registration: a hot reload runs register again, so a
  // hook still failing then writes its line once more.
  const failing = new Set<string>()

  // The timeline. Collapsed, under a survey, or on another surface, it draws nothing of its own.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if ((e.surface !== 'terminal' && e.surface !== 'desktop') || e.props.isCollapsed || e.props.hasSurvey) return next(e)
    const { bodyColumns, maxRows } = e.props
    // Everything that can fail comes before next(e), which is called once whatever happens.
    const drawn = await drawOpen($, failing, 'AbovePrompt', async () => {
      const m = await modelOf($, cfg)
      const isPaneOpen = await isPaneShown($)
      if (e.surface === 'desktop') {
        const rows = desktopRows(timelineRows(m, { columns: bodyColumns, isPaneOpen, maxCells: TRACK_SVG_CELLS })).slice(0, Math.min(maxRows, DESKTOP_MAX_ROWS))
        const { Box, Svg, Text } = $.ui.resolve(e)
        return { Box, rows: rows.map((row) => drawDesktopRow({ Box, Svg, Text }, row, barPixels(bodyColumns))) }
      }
      const rows = timelineRows(m, { columns: bodyColumns, isPaneOpen }).slice(0, maxRows)
      const { Box, Text } = $.ui.resolve(e)
      // Cut to the columns already; truncate-end only guards a terminal that measures a character otherwise.
      return { Box, rows: rows.map((row) => drawRow(Text, row, 'truncate-end')) }
    })
    if (drawn === null) return next(e)
    const { Box, rows } = drawn
    // What the rest of the chain draws for this row (another mod's) stays, under the timeline.
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {rows}
        {below}
      </Box>
    )
  })

  // The pane: its sections from top to bottom, a title in the accent colour, a blank line between them. A sentence
  // longer than the pane wraps; a row of columns (bars, answers) drops its last groups instead.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const columns = e.props.bodyColumns
    const tree = await drawOpen($, failing, 'Pane', async () => {
      const sections = paneSections(await modelOf($, cfg))
      const rowsOf = (s: (typeof sections)[number]) => s.rows.map((row) => fitRow(row, columns))
      if (e.surface === 'desktop') {
        const { Box, Svg, Text } = $.ui.resolve(e)
        const barWidth = barPixels(columns)
        return (
          <Box flexDirection="column">
            {sections.flatMap((s, i) => [
              ...(i === 0 ? [] : [<Text> </Text>]),
              <Text {...TONE_LOOK.accent}>{s.title}</Text>,
              ...rowsOf(s).map((row) => drawDesktopRow({ Box, Svg, Text }, row, barWidth)),
            ])}
          </Box>
        )
      }
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {sections.flatMap((s, i) => [...(i === 0 ? [] : [<Text> </Text>]), <Text {...TONE_LOOK.accent}>{s.title}</Text>, ...rowsOf(s).map((row) => drawRow(Text, row, 'wrap'))])}
        </Box>
      )
    })
    return tree ?? next(e)
  })

  // However the pane closes (/dp, the person's close key or mark), the timeline is drawn again at once, back to its
  // five rows: with the pane gone, the last evaluation and the features would otherwise show nowhere. The close goes
  // on as it came.
  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const r = await next(e)
    await redraw($)
    return r
  })

  // The footer keeps the engine's own labels (SessionMode's modes) and adds the board's, drawn dim as they are.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const isDesktop = e.surface === 'desktop'
    const label = await drawOpen($, failing, 'SessionMode', async () => {
      const m = await modelOf($, cfg)
      return isDesktop ? desktopLabel(m) : footerLabel(m)
    })
    return next(label === null ? e : { ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
  })
}
