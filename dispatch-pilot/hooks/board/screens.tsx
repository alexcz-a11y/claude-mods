// The screens' hooks (ADR 0004: drawn from the decision report's data, never
// written to by a feature): the band above the prompt (`AbovePrompt`), the
// summary at the right end of the footer (`SessionMode`) and the rationale pane
// (`Pane`, the pane `/dp` opens). One hook tree for every surface, branching on
// `e.surface`: the terminal draws the full design (band.tsx, footer.tsx,
// pane.tsx); the other surfaces get the engine's own drawing for now (their
// plain-text band, footer tag and pane are #31's).
//
// Each hook reads the board, the log and the agent the person picked from
// $.state while it draws, so the host draws it again when they change; while
// an agent runs it asks for one more frame every `TICK_MS` (the spinner, the
// running clocks and ribbons). The band and the footer keep what other mods
// draw in the same place: the engine's drawing beneath goes in first (spec
// story 38); the pane is Dispatch Pilot's own.

import type { EngineInterface, On, Timer } from 'claude-code'
import { isOn, isShown, listSwitches, masterOn } from '../core/switches.ts'
import { bandTree } from './band.tsx'
import { footerTree } from './footer.tsx'
import { paneTree } from './pane.tsx'
import { NO_PANE_STATE, PANE_COLUMNS, PANE_ID, PANE_TITLE, withFold } from './rationale.ts'
import { screenView, TICK_MS, type AgentRow, type ScreenView } from './view.ts'

const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
const SELECTED = { plugin: 'dispatch-pilot', key: 'selected' } as const
const PROFILES = { plugin: 'dispatch-pilot', key: 'skillProfiles' } as const
const LOCK = { plugin: 'dispatch-pilot', key: 'lock' } as const
const PANE_VIEW = { plugin: 'dispatch-pilot', key: 'paneView' } as const

/** The next frame asked for while an agent runs (module state: a hot reload cancels it with the old module, and the next draw asks again). */
let ticking: Timer | null = null

/** The screens' view, read from $.state now (a read while drawing subscribes the drawing to the value). */
async function viewOf($: EngineInterface, isWorking: boolean): Promise<ScreenView> {
  const [board, log, picked, now] = await Promise.all([$.state.get(BOARD), $.state.get(DECISIONS), $.state.get(SELECTED), $.clock.now()])
  return screenView({
    board: board.value ?? { turn: 0, nodes: [] },
    log: log.value ?? [],
    now,
    selected: picked.value ?? null,
    master: masterOn(),
    isOn,
    isShown,
    isWorking,
  })
}

/** One more frame in `TICK_MS` while something runs; none once nothing does. */
function tick($: EngineInterface, view: ScreenView): void {
  const moving = view.live && (view.counts.running > 0 || view.rows.some((row) => row.node.state === 'running'))
  if (!moving || ticking !== null) return
  try {
    ticking = $.clock.after(TICK_MS, () => {
      ticking = null
      $.ui.invalidate('ui.render')
    })
  } catch {
    // no timer: the screens move on at the board's next change
    ticking = null
  }
}

/** The agent picked, its card shown in the rationale pane (written from a press, never while drawing). */
async function pick($: EngineInterface, row: AgentRow): Promise<void> {
  await $.state.set(SELECTED, { turn: row.node.turn, id: row.node.id })
}

export function registerScreens(on: On): void {
  // The band above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const own = await next(e)
    try {
      const t = $.ui.resolve(e)
      const view = await viewOf($, e.props.isWorking)
      tick($, view)
      // A digit picks an agent and brings up its card: a press is the person's asking, so the pane is placed at
      // any width; it opens without taking the keys, so the next digit still picks. One not placed is closed again.
      const select = async (row: AgentRow) => {
        await pick($, row)
        const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE, closeOnEscape: true, columns: PANE_COLUMNS })
        if (!opened.isPlaced) {
          await $.ui.close({ id: PANE_ID })
          $.ui.log(`rationale pane not placed (${opened.reason}), closed again`, { to: 'debug' })
        }
      }
      const tree = bandTree(t, view, { cols: e.props.bodyColumns, rows: e.props.maxRows }, { select: (row) => void select(row).catch(() => undefined) })
      if (tree === null) return own
      const { Box } = t
      return (
        <Box flexDirection="column">
          {own}
          {tree}
        </Box>
      )
    } catch (error) {
      // A band that cannot be drawn leaves the place to the others.
      $.ui.log(`band not drawn: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
      return own
    }
  })

  // The right end of the footer, beside the engine's modes.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const own = await next(e)
    try {
      const t = $.ui.resolve(e)
      const view = await viewOf($, false)
      tick($, view)
      const tree = footerTree(t, view)
      if (tree === null) return own
      const { Box } = t
      return (
        <Box gap={1}>
          {own}
          {tree}
        </Box>
      )
    } catch (error) {
      $.ui.log(`footer not drawn: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
      return own
    }
  })

  // The rationale pane (`/dp`): the card of the agent picked, the decision log.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    try {
      const t = $.ui.resolve(e)
      const [view, log, profiles, lock, kept] = await Promise.all([viewOf($, false), $.state.get(DECISIONS), $.state.get(PROFILES), $.state.get(LOCK), $.state.get(PANE_VIEW)])
      tick($, view)
      const entries = log.value ?? []
      const state = kept.value ?? NO_PANE_STATE
      const shown = isOn('skills') && isOn('skill-profiles') ? (profiles.value ?? null) : null
      return paneTree(
        t,
        { view, log: entries, profiles: shown, off: listSwitches().filter((s) => !s.on).map((s) => s.name), master: masterOn(), lock: lock.value ?? null, state },
        e.props.bodyColumns,
        {
          pick: (row) => void pick($, row).catch(() => undefined),
          fold: (turn, open) => void $.state.set(PANE_VIEW, withFold(state, turn, open, entries)).catch(() => undefined),
          failures: (open) => void $.state.set(PANE_VIEW, { ...state, failures: open }).catch(() => undefined),
        },
      )
    } catch (error) {
      $.ui.log(`rationale pane not drawn: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
      return next(e)
    }
  })
}
