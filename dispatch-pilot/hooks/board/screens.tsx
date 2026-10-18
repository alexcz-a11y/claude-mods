// The screens' hooks (ADR 0004: drawn from the decision report's data, never
// written to by a feature): the band above the prompt (`AbovePrompt`), the
// summary at the right end of the footer (`SessionMode`) and the rationale pane
// (`Pane`, the pane `/dp` opens). One hook tree for every surface, branching on
// `e.surface`: every surface draws the same design (band.tsx, footer.tsx,
// pane.tsx), its marks (time ribbons, probability bars, confidence meters) a
// Raster on the terminal and an Svg on Desktop, VS Code and the mobile app;
// off the terminal the footer's tag is at most 24 characters and the log keeps
// to a window short of Desktop's 2000 nodes.
//
// Where the band is not drawn (a session without a terminal: VS Code draws
// none, Desktop's is gone while idle), the status line under the prompt says
// the band's line in words (status-line.ts, ADR 0011): its hooks set it as a
// turn starts and ends, an agent starts and the person runs `/dp`.
//
// Each hook reads the board, the log and the agent the person picked from
// $.state while it draws, so the host draws it again when they change; while
// an agent runs it asks for one more frame every `TICK_MS` on the terminal (the
// spinner, the running clocks and ribbons) and every `SLOW_TICK_MS` elsewhere,
// where a redraw costs the person a press (view.ts) and the running ribbons
// grow by themselves in between. The band and the footer keep what other mods
// draw in the same place: the engine's drawing beneath goes in first (spec
// story 38); the pane is Dispatch Pilot's own.

import type { EngineInterface, On, RenderInput, Timer } from 'claude-code'
import { errorText } from '../decision/backend.ts'
import { report, type NoticeIo, type SwitchIo } from '../core/report.ts'
import { isOn, isShown, keepSwitch, listSwitches, masterOn, setMaster, setSwitch, SWITCHES_KEY } from '../core/switches.ts'
import type { Effort } from '../decision/effort.ts'
import { bandTree, statusText } from './band.tsx'
import { FOOTER_COLUMNS, footerTree, TAG_CHARS } from './footer.tsx'
import { paneTree } from './pane.tsx'
import { appPaneTree } from './pane-app.tsx'
import { nodeCount, rasterMarks, showsText, svgMarks, type Marks } from './kit.tsx'
import { NO_PANE_STATE, PANE_COLUMNS, PANE_ID, PANE_TITLE, withFold } from './rationale.ts'
import { screenView, SLOW_TICK_MS, TICK_MS, type AgentRow, type ScreenView } from './view.ts'
import { bandHintIs, hintLineIs, statusLineUsed, surfacesAre, turnLineIs, type StatusUpdate } from './status-line.ts'

const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
const SELECTED = { plugin: 'dispatch-pilot', key: 'selected' } as const
const PROFILES = { plugin: 'dispatch-pilot', key: 'skillProfiles' } as const
const LOCK = { plugin: 'dispatch-pilot', key: 'lock' } as const
const PANE_VIEW = { plugin: 'dispatch-pilot', key: 'paneView' } as const
const COUNT = { plugin: 'dispatch-pilot', key: 'unresolved' } as const
const BAND_FOLD = { plugin: 'dispatch-pilot', key: 'bandFolded' } as const
const DRAFT_HINT = { plugin: 'dispatch-pilot', key: 'draftHint' } as const

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

/** The screens' view, read from $.state now (a read while drawing subscribes the drawing to the value); `slow` for a surface other than the terminal. */
async function viewOf($: EngineInterface, isWorking: boolean, slow: boolean): Promise<ScreenView> {
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
    slow,
  })
}

/** The first engine with `$.ui.view`. */
const VIEW_SINCE = [2, 1, 300] as const

/** Whether a version (`2.1.299`, `2.1.300-dev.…`) is `least` or later; one that does not read as a version is taken to be. */
export function atLeast(version: string, least: readonly number[]): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (parts === null) return true
  for (let i = 0; i < least.length; i++) {
    const part = Number(parts[i + 1])
    const want = least[i] ?? 0
    if (part !== want) return part > want
  }
  return true
}

/** Whether the engine can put an agent's transcript in the main view (`$.ui.view`); an engine that does not say its version is taken to. */
async function viewsTranscripts($: EngineInterface): Promise<boolean> {
  const version = await $.session.version().catch(() => undefined)
  return version === undefined || atLeast(version.version, VIEW_SINCE)
}

/** The surface's marks: a Raster's cells on the terminal, an Svg where the surface has one. */
function marksOf($: EngineInterface, e: RenderInput<'AbovePrompt' | 'Pane'>): Marks {
  return e.surface === 'terminal' ? rasterMarks($.ui.resolve(e).Raster) : svgMarks($.ui.resolve(e).Svg, $.ui.resolve(e).Box)
}

/** One more frame while something runs, in `TICK_MS` on the terminal and `SLOW_TICK_MS` elsewhere (a view that looks ahead); none once nothing does. */
function tick($: EngineInterface, view: ScreenView): void {
  const moving = view.live && view.rows.some((row) => row.node.state === 'running')
  if (!moving || ticking !== null) return
  try {
    ticking = $.clock.after(view.ahead > 0 ? SLOW_TICK_MS : TICK_MS, () => {
      ticking = null
      $.ui.invalidate('ui.render')
    })
  } catch {
    // no timer: the screens move on at the board's next change
    ticking = null
  }
}

/**
 * Puts an agent's transcript in the main view (null: the main conversation back), from a press in the pane; a view the
 * engine does not move is the decision report's to tell (a toast).
 */
async function showTranscript($: EngineInterface, agentId: string | null): Promise<void> {
  // The engine's refusal comes back as `deny`; a hook's, as an error.
  const why = await $.ui.view(agentId === null ? {} : { agentId }).then(
    (shown) => shown.deny,
    (error: unknown) => errorText(error),
  )
  if (why === undefined) return
  const io: NoticeIo = { debug: (line) => $.ui.log(line, { to: 'debug' }), now: () => $.clock.now(), toast: (text) => $.ui.toast(text) }
  await report(io, { unviewed: { agent: agentId, reason: why } })
}

/** The agent picked, its card shown in the rationale pane (written from a press, never while drawing). */
async function pick($: EngineInterface, row: AgentRow): Promise<void> {
  await $.state.set(SELECTED, { turn: row.node.turn, id: row.node.id })
}

/** Sets the status line to what `update` says, when it changed. */
function putStatusLine($: EngineInterface, update: StatusUpdate): void {
  if (update.changed) $.ui.status(update.line)
}

/** The status line again from the board: where the session draws (it can change), then the band's line. */
async function refreshStatus($: EngineInterface): Promise<void> {
  const surfaces = await $.session.surfaces().catch(() => [] as const)
  putStatusLine($, surfacesAre(surfaces))
  // A session with a terminal has no line: the board is not read for it.
  if (statusLineUsed()) putStatusLine($, turnLineIs(statusText(await viewOf($, false, true))))
}

/** `refreshStatus`, once the event is through: a line that cannot be set never stops anything. */
async function refreshQuietly($: EngineInterface): Promise<void> {
  try {
    await refreshStatus($)
  } catch {
    // the line keeps what it said
  }
}

/**
 * The status line's hooks (status-line.ts), which only watch: outermost of all (dispatch-pilot.ts), so that when a
 * turn ends the line reads the board the decision report has just written.
 */
export function registerStatus(on: On): void {
  on('session.start', { cwd: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    await refreshQuietly($)
    return result
  })
  on('turn.start', { turnId: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    // The draft the hint was about has been sent: off the status line, and off the band's idle line.
    if (e.agentId === undefined) {
      putStatusLine($, hintLineIs(null))
      if (bandHintIs(null)) await $.state.set(DRAFT_HINT, null).catch(() => undefined)
    }
    await refreshQuietly($)
    return result
  })
  on('agent.spawn', { tool_use_id: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    await refreshQuietly($)
    return result
  })
  on('turn.complete', { turnId: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    await refreshQuietly($)
    return result
  })
  on('command.run', { command: 'dp' }, async ($, e, next) => {
    const result = await next(e)
    await refreshQuietly($)
    return result
  })
}

export function registerScreens(on: On): void {
  // The band above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const own = await next(e)
    try {
      const t = $.ui.resolve(e)
      // The time ribbons: the terminal's Raster, an Svg elsewhere.
      const marks = marksOf($, e)
      const [view, folded, drafted] = await Promise.all([viewOf($, e.props.isWorking, e.surface !== 'terminal'), e.surface === 'terminal' ? null : $.state.get(BAND_FOLD), e.surface === 'terminal' ? null : $.state.get(DRAFT_HINT)])
      tick($, view)
      // The terminal folds the band itself; elsewhere the band has its own fold, kept for the session.
      const fold = folded === null ? undefined : { folded: folded.value === true, set: (value: boolean) => void $.state.set(BAND_FOLD, value).catch(() => undefined) }
      // A digit (off the terminal, the agent's name or 依据) brings up the pane: a press is the person's asking, so the
      // pane is placed at any width; it opens without taking the keys, so the next digit still picks. One not placed
      // is closed again, and the decision report tells the person why in a toast.
      const open = async () => {
        const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE, closeOnEscape: true, columns: PANE_COLUMNS })
        if (!opened.isPlaced) {
          await $.ui.close({ id: PANE_ID })
          const io: NoticeIo = { debug: (line) => $.ui.log(line, { to: 'debug' }), now: () => $.clock.now(), toast: (text) => $.ui.toast(text) }
          await report(io, { unplaced: { reason: opened.reason } })
        }
      }
      const select = async (row: AgentRow) => {
        await pick($, row)
        await open()
      }
      const acts = {
        select: (row: AgentRow) => void select(row).catch(() => undefined),
        ...(fold === undefined ? {} : { fold }),
        // Off the terminal the band's own 依据, where the terminal writes `/dp log`.
        ...(e.surface === 'terminal' ? {} : { open: () => void open().catch(() => undefined) }),
      }
      const tree = bandTree(t, view, { cols: e.props.bodyColumns, rows: e.props.maxRows }, acts, marks, drafted?.value ?? null)
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
      const view = await viewOf($, false, e.surface !== 'terminal')
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
      const [view, log, profiles, lock, kept, count] = await Promise.all([viewOf($, false, e.surface !== 'terminal'), $.state.get(DECISIONS), $.state.get(PROFILES), $.state.get(LOCK), $.state.get(PANE_VIEW), $.state.get(COUNT)])
      tick($, view)
      const entries = log.value ?? []
      const state = kept.value ?? NO_PANE_STATE
      const shown = isOn('skills') && isOn('skill-profiles') ? (profiles.value ?? null) : null
      // The summary the session holds, while the feature that writes it is on.
      const summary = isOn('unresolved') ? (count.value?.summary ?? null) : null
      const viewing = e.props.view.agentId ?? null
      // The terminal's labels spell their keys; Desktop draws a key beside its Button, and the others take none.
      // Claude Desktop's own engine (2.1.299) has no `$.ui.view`: no 看它的对话 there, rather than a button that only says so.
      const canView = await viewsTranscripts($)
      const input = { view, log: entries, profiles: shown, switches: listSwitches().map((s) => ({ name: s.name, on: s.on })), master: masterOn(), lock: lock.value ?? null, viewing, summary, state, spellKeys: e.surface === 'terminal', canView }
      const act = {
        pick: (row: AgentRow) => void pick($, row).catch(() => undefined),
        view: (agentId: string | null) => void showTranscript($, agentId).catch(() => undefined),
        fold: (turn: number, open: boolean) => void $.state.set(PANE_VIEW, withFold(state, turn, open, entries)).catch(() => undefined),
        failures: (open: boolean) => void $.state.set(PANE_VIEW, { ...state, failures: open }).catch(() => undefined),
        // Off the terminal the pane's own 关闭: the surface's × is not always heard (Desktop).
        ...(e.surface === 'terminal' ? {} : { close: () => void $.ui.close({ id: PANE_ID }).catch(() => undefined) }),
      }
      const marks = marksOf($, e)
      if (e.surface === 'terminal') return paneTree(t, input, e.props.bodyColumns, act, marks)
      // Elsewhere the pane is clicked: the switches and the lock change where they are shown, as `/dp` would change
      // them (control.ts): the switch kept in $.store, the screens drawn again without what a switch that is off owns.
      const reporting: SwitchIo = { redraw: () => $.ui.invalidate('ui.render') }
      const flip = async (name: string, wanted: boolean) => {
        if (name === 'master') setMaster(wanted)
        else if (!setSwitch(name, wanted)) return
        await report(reporting, { switched: true })
        await keepSwitch({ get: () => $.store.get(SWITCHES_KEY), set: (value) => $.store.set(SWITCHES_KEY, value) }, name)
      }
      const acts = {
        ...act,
        toggle: (name: string, wanted: boolean) => void flip(name, wanted).catch(() => undefined),
        lock: (effort: Effort | null) => void $.state.set(LOCK, effort).catch(() => undefined),
        switches: (open: boolean) => void $.state.set(PANE_VIEW, { ...state, switches: open }).catch(() => undefined),
      }
      // The widest window of the log that stays short of Desktop's 2000 nodes.
      let tree = appPaneTree(t, { ...input, window: WINDOWS[0] }, e.props.bodyColumns, acts, marks)
      for (const window of WINDOWS.slice(1)) {
        if (nodeCount(tree) < MOST_NODES) break
        tree = appPaneTree(t, { ...input, window }, e.props.bodyColumns, acts, marks)
      }
      return tree
    } catch (error) {
      $.ui.log(`rationale pane not drawn: ${errorText(error)}`, { to: 'debug' })
      return next(e)
    }
  })
}
