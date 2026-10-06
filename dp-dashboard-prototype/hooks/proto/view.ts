// PROTOTYPE: what a variant is handed to draw one frame.

import type { Node, Scene } from './data'
import type { T } from './kit'

export interface Actions {
  select: (i: number) => void
  fold: (turn: number) => void
  openLog: () => void
}

export interface View {
  t: T
  scene: Scene
  frame: number // animation frame (spinner)
  live: number // whole seconds since the scene began, so running agents tick
  cols: number // columns the tree may use (bodyColumns)
  rows: number // rows the tree may use (maxRows for the band, scroll.bodyRows for a pane)
  sel: number // selected node index (Tree)
  folded: ReadonlySet<number> // folded turns (Timeline pane)
  act: Actions
  variantName: string // "A · Cockpit", always shown in the band header
  sceneName: string // "agents", always shown in the band header
  placement?: 'dock' | 'inline'
}

export function elapsed(n: Node, v: View): number {
  return n.state === 'running' ? v.scene.now + v.live - n.t0 : (n.dur ?? 0)
}
