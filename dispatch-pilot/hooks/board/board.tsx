// The board on the terminal (design 5.14): the timeline above the prompt, the pane /dp opens, and a label in the
// footer. Each hook reads the state, builds the model and the rows (board/model.ts, board/view.ts) and draws them; it
// writes nothing, asks no decision model, and on any error draws what it would have drawn without the mod (next).
import { atom, read } from 'claude-code'
import type { Elements, EngineInterface, On, ThemeKey } from 'claude-code'

import type { Config } from '../config.ts'
import { failOpen } from '../runtime.ts'
import { emptySession } from '../state.ts'
import { boardModel } from './model.ts'
import type { BoardModel } from './model.ts'
import { fitRow, footerLabel, paneSections, runsOf, timelineRows } from './view.ts'
import type { Row, Tone } from './view.ts'

// The state atoms this file reads, one line each and alike in every file that declares them: the module scan takes
// only a const of the file that reads or writes (eval/validate.ts checks the copies are the same text).
const SESSION = atom({ plugin: 'dispatch-pilot', key: 'session' } as const, emptySession())
const TURN = atom({ plugin: 'dispatch-pilot', key: 'turn' } as const, null)
const RECENT = atom({ plugin: 'dispatch-pilot', key: 'recent' } as const, [])
const SKILLS = atom({ plugin: 'dispatch-pilot', key: 'skills' } as const, [])

/** The pane's id: $.ui.open, $.ui.close and its ui.render requestId. */
export const PANE_ID = 'dispatch-pilot'

/**
 * Each Tone on the terminal: a theme key, the theme's dim colour, or the plain text colour. Theme keys only: a hook
 * cannot tell a light theme from a dark one, and the engine gives each key a colour that reads on the person's.
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

// One row as one Text: a stretch in the plain colour is a bare string, every other stretch a Text of its look.
function drawRow(Text: TerminalText, row: Row, wrap: 'wrap' | 'truncate-end') {
  return (
    <Text wrap={wrap}>
      {row.parts.flatMap(runsOf).map((r) => (r.tone === 'plain' && r.bold !== true ? r.text : <Text {...TONE_LOOK[r.tone]} {...(r.bold === true ? { bold: true } : {})}>{r.text}</Text>))}
    </Text>
  )
}

/** The board's three hooks (design 5.14), on the terminal; none while cfg.board is off. */
export function registerBoard(on: On, cfg: Config): void {
  if (!cfg.board) return

  // The timeline. Collapsed, under a survey, or on another surface, it draws nothing of its own.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isCollapsed || e.props.hasSurvey) return next(e)
    const { bodyColumns, maxRows } = e.props
    // Everything that can fail comes before next(e), which is called once whatever happens.
    const drawn = await failOpen($, 'ui.render', null, async () => {
      const m = await modelOf($, cfg)
      const rows = timelineRows(m, { columns: bodyColumns, isPaneOpen: await isPaneShown($) }).slice(0, maxRows)
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
    if (e.surface !== 'terminal') return next(e)
    const columns = e.props.bodyColumns
    const tree = await failOpen($, 'ui.render', null, async () => {
      const sections = paneSections(await modelOf($, cfg))
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {sections.flatMap((s, i) => [
            ...(i === 0 ? [] : [<Text> </Text>]),
            <Text {...TONE_LOOK.accent}>{s.title}</Text>,
            ...s.rows.map((row) => drawRow(Text, fitRow(row, columns), 'wrap')),
          ])}
        </Box>
      )
    })
    return tree ?? next(e)
  })

  // The footer keeps the engine's own labels (SessionMode's modes) and adds the board's, drawn dim as they are.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const label = await failOpen($, 'ui.render', null, async () => footerLabel(await modelOf($, cfg)))
    return next(label === null ? e : { ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
  })
}
