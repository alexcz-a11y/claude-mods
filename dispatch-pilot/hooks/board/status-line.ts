// The status line under the prompt (`$.ui.status`), in a session that has no
// terminal (ADR 0011): VS Code draws no band and no footer tag, and Desktop's
// band is gone while the session is idle, so the line says in words what the
// band would (band.tsx `statusText`). The terminal puts a plugin's status line
// in its warning colour behind a ⚠ (ADR 0004), so a session with a terminal
// gets none. One line per plugin holds both of what it says: the prompt hint
// while the person writes (prompt-hint.ts), else the band's line.
//
// Pure module state, written by the hooks that set the line (screens.tsx's
// status hooks, prompt-hint.ts), which call `$.ui.status` with what it answers.
// A hot reload clears it: the line stays on screen, and the next event that
// sets it writes it again.

/** Whether the session uses the line: it draws somewhere, and not on a terminal. */
let used = false
/** The band's line for the turn; undefined before the first turn, or with nothing to say. */
let turnLine: string | undefined
/** The prompt hint for the draft being written; null when the draft has none. */
let hintLine: string | null = null
/** What the line shows now, as last set. */
let shown: string | undefined

/** What to set the line to: `changed` false when it shows that already. */
export type StatusUpdate = { changed: boolean; line: string | undefined }

function update(): StatusUpdate {
  const line = used ? (hintLine ?? turnLine) : undefined
  if (line === shown) return { changed: false, line }
  shown = line
  return { changed: true, line }
}

/** The session draws on `surfaces`: the line is used when it draws somewhere and nowhere on a terminal. */
export function surfacesAre(surfaces: readonly string[]): StatusUpdate {
  used = surfaces.length > 0 && !surfaces.includes('terminal')
  return update()
}

/** Whether the line is in use: the prompt hint goes on it only then. */
export function statusLineUsed(): boolean {
  return used
}

/** The band's line for the turn is now `text`. */
export function turnLineIs(text: string | undefined): StatusUpdate {
  turnLine = text
  return update()
}

/** The prompt hint for the draft is now `hint` (null: none). */
export function hintLineIs(hint: string | null): StatusUpdate {
  hintLine = hint
  return update()
}
