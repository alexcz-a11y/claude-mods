// The screens' hooks (ADR 0004: drawn from the decision report's data, never
// written to by a feature): the band above the prompt (`AbovePrompt`), the
// summary at the right end of the footer (`SessionMode`) and the rationale pane
// (`Pane`, the pane `/dp` opens). One hook tree for every surface, branching on
// `e.surface`: the terminal draws the full design (band.tsx, footer.tsx,
// pane.tsx) with its Raster; every other surface gets the same trees in plain
// text, without a Raster (the tag in the footer in at most 24 characters, the
// log in a window short of Desktop's 2000 nodes), until the Svg versions.
//
// Each hook reads the board, the log and the agent the person picked from
// $.state while it draws, so the host draws it again when they change; while
// an agent runs it asks for one more frame every `TICK_MS` (the spinner, the
// running clocks and ribbons). The band and the footer keep what other mods
// draw in the same place: the engine's drawing beneath goes in first (spec
// story 38); the pane is Dispatch Pilot's own.

import type { EngineInterface, On, Timer } from 'claude-code'
import { errorText } from '../decision/backend.ts'
import { report, type NoticeIo } from '../core/report.ts'
import { isOn, isShown, listSwitches, masterOn } from '../core/switches.ts'
import { bandTree } from './band.tsx'
import { FOOTER_COLUMNS, footerTree, TAG_CHARS } from './footer.tsx'
import { paneTree } from './pane.tsx'
import { nodeCount, showsText } from './kit.tsx'
import { NO_PANE_STATE, PANE_COLUMNS, PANE_ID, PANE_TITLE, withFold } from './rationale.ts'
import { screenView, TICK_MS, type AgentRow, type ScreenView } from './view.ts'

const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
const SELECTED = { plugin: 'dispatch-pilot', key: 'selected' } as const
const PROFILES = { plugin: 'dispatch-pilot', key: 'skillProfiles' } as const
const LOCK = { plugin: 'dispatch-pilot', key: 'lock' } as const
const PANE_VIEW = { plugin: 'dispatch-pilot', key: 'paneView' } as const
const COUNT = { plugin: 'dispatch-pilot', key: 'unresolved' } as const

/** The log's windows for a surface that refuses a large tree, widest first: what the pane keeps of the log and of the re-decisions. */
const WINDOWS = [
  { entries: 40, mids: 20 },
  { entries: 16, mids: 8 },
  { entries: 4, mids: 3 },
  { entries: 0, mids: 0 },
] as const
/** A tree this big is drawn again in the next window: Desktop refuses 2000. */
const MOST_NODES = 1800

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
    if (e.props.hasSurvey) return next(e)
    const own = await next(e)
    try {
      const t = $.ui.resolve(e)
      // The time ribbons are the terminal's Raster; elsewhere the rows are the same without them.
      const ribbon = e.surface === 'terminal' ? $.ui.resolve(e).Raster : undefined
      const view = await viewOf($, e.props.isWorking)
      tick($, view)
      // A digit picks an agent and brings up its card: a press is the person's asking, so the pane is placed at
      // any width; it opens without taking the keys, so the next digit still picks. One not placed is closed again,
      // and the decision report tells the person why in a toast.
      const select = async (row: AgentRow) => {
        await pick($, row)
        const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE, closeOnEscape: true, columns: PANE_COLUMNS })
        if (!opened.isPlaced) {
          await $.ui.close({ id: PANE_ID })
          const io: NoticeIo = { debug: (line) => $.ui.log(line, { to: 'debug' }), now: () => $.clock.now(), toast: (text) => $.ui.toast(text) }
          await report(io, { unplaced: { reason: opened.reason } })
        }
      }
      const tree = bandTree(t, view, { cols: e.props.bodyColumns, rows: e.props.maxRows }, { select: (row) => void select(row).catch(() => undefined) }, ribbon)
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
      $.ui.log(`band not drawn: ${errorText(error)}`, { to: 'debug' })
      return own
    }
  })

  // The right end of the footer, beside the engine's modes.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const own = await next(e)
    try {
      const t = $.ui.resolve(e)
      const view = await viewOf($, false)
      tick($, view)
      // A column between the engine's modes (or another mod's drawing) and the tag, when there are any: it counts in what the tag adds.
      const gap = showsText(own, e.props.modes.length > 0) ? 1 : 0
      const tree = footerTree(t, view, (e.surface === 'terminal' ? FOOTER_COLUMNS : TAG_CHARS) - gap)
      if (tree === null) return own
      const { Box } = t
      return (
        <Box gap={gap}>
          {own}
          {tree}
        </Box>
      )
    } catch (error) {
      $.ui.log(`footer not drawn: ${errorText(error)}`, { to: 'debug' })
      return own
    }
  })

  // The rationale pane (`/dp`): the card of the agent picked, the decision log.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    try {
      const t = $.ui.resolve(e)
      const [view, log, profiles, lock, kept, count] = await Promise.all([viewOf($, false), $.state.get(DECISIONS), $.state.get(PROFILES), $.state.get(LOCK), $.state.get(PANE_VIEW), $.state.get(COUNT)])
      tick($, view)
      const entries = log.value ?? []
      const state = kept.value ?? NO_PANE_STATE
      const shown = isOn('skills') && isOn('skill-profiles') ? (profiles.value ?? null) : null
      // The summary the session holds, while the feature that writes it is on.
      const summary = isOn('unresolved') ? (count.value?.summary ?? null) : null
      const input = { view, log: entries, profiles: shown, switches: listSwitches().map((s) => ({ name: s.name, on: s.on })), master: masterOn(), lock: lock.value ?? null, summary, state }
      const act = {
        pick: (row: AgentRow) => void pick($, row).catch(() => undefined),
        fold: (turn: number, open: boolean) => void $.state.set(PANE_VIEW, withFold(state, turn, open, entries)).catch(() => undefined),
        failures: (open: boolean) => void $.state.set(PANE_VIEW, { ...state, failures: open }).catch(() => undefined),
      }
      if (e.surface === 'terminal') return paneTree(t, input, e.props.bodyColumns, act, $.ui.resolve(e).Raster)
      // Elsewhere: the same pane in text, in the widest window of the log that stays short of Desktop's 2000 nodes.
      let tree = paneTree(t, { ...input, window: WINDOWS[0] }, e.props.bodyColumns, act)
      for (const window of WINDOWS.slice(1)) {
        if (nodeCount(tree) < MOST_NODES) break
        tree = paneTree(t, { ...input, window }, e.props.bodyColumns, act)
      }
      return tree
    } catch (error) {
      $.ui.log(`rationale pane not drawn: ${errorText(error)}`, { to: 'debug' })
      return next(e)
    }
  })
}
