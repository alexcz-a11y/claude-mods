// What the tests that mount the mod's screens (`w.band()`, `w.pane()`, `w.footer()`) read off a drawn tree. Not a test file.

/** A drawn element as plain data (what `drawn()` and `find` hand back). */
export type Drawn = { type?: string; key?: string | undefined; props?: Record<string, unknown>; children?: unknown[] }

/** What a drawn element shows: its descendants' text in order, a Button as `hotkey: label` (FoundElement's own `text` is only its string children). */
export function shown(element: unknown): string {
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (element === null || typeof element !== 'object') return ''
  const { children = [], props = {} } = element as Drawn
  const label = typeof props.label === 'string' ? `${typeof props.hotkey === 'string' ? `${props.hotkey}: ` : ''}${props.label}` : ''
  const kids = Array.isArray(props.children) ? props.children : children
  return label + kids.map(shown).join('')
}

/** The element types in a drawn tree and how many nodes it has (Desktop refuses a tree of 2000). */
export function inventory(element: unknown, seen: { types: Set<string>; nodes: number } = { types: new Set(), nodes: 0 }) {
  if (typeof element === 'string') {
    seen.nodes += 1
    return seen
  }
  if (element === null || typeof element !== 'object') return seen
  const { type, children = [], props = {} } = element as Drawn
  seen.nodes += 1
  if (type !== undefined) seen.types.add(type)
  for (const child of Array.isArray(props.children) ? props.children : children) inventory(child, seen)
  return seen
}
