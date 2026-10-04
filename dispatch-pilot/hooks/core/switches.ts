// What is switched on: the whole mod (the master switch) and each feature.
// The person flips them with `/dp` (features/control.ts); the core and the
// features read them here. A feature registers its switch in its register:
//
//   defineSwitch({ name: 'main-effort', info: "decides the main agent's effort", segments: ['decision'] })
//
// and asks `isOn('main-effort')` where it would act (README, 开发).
//
// Pure module state, no `$`. What the person flipped is kept in $.store by the
// command and loaded back at session start (`loadOverrides`, `overrides`), so
// a hot reload, which resets this module, loses nothing.

import type { Segment } from './status.ts'

export type SwitchSpec = {
  /** What the person types in `/dp <name> on|off`: lowercase letters, digits and `-`, starting with a letter. */
  name: string
  /** What the switch does, for `/dp`'s listing. ASCII, no longer than a line. */
  info: string
  /** Whether it is on until the person flips it; on when left out. */
  default?: boolean
  /** The status line segments the feature owns, taken off the line when the person switches it off. */
  segments?: readonly Segment[]
}

/** A registered switch. */
type Registered = { name: string; info: string; default: boolean; segments: readonly Segment[] }
/** A registered switch as `/dp` lists it, with its state. */
export type SwitchInfo = Registered & { on: boolean }

/** The master switch's key among the overrides; no feature may take it. */
const MASTER = 'master'
/** Words `/dp` itself understands: a feature named like one would make `/dp <name> on` ambiguous. */
const RESERVED = [MASTER, 'on', 'off', 'all', 'reset', 'status', 'help', 'lock', 'unlock', 'log']
const NAME = /^[a-z][a-z0-9-]*$/

/** The registered switches, in registration order. */
const specs = new Map<string, Registered>()
/** What the person flipped away from the defaults, by name (the master included); unknown names are kept as they are. */
let flipped: Record<string, boolean> = {}

/** Registers a feature's switch. Registering a name again replaces it; a name `/dp` cannot take throws. */
export function defineSwitch(spec: SwitchSpec): void {
  if (!NAME.test(spec.name) || RESERVED.includes(spec.name)) {
    throw new Error(`switch name "${spec.name}" is not allowed: use lowercase letters, digits and "-", and none of ${RESERVED.join(', ')}`)
  }
  specs.set(spec.name, { name: spec.name, info: spec.info, default: spec.default ?? true, segments: spec.segments ?? [] })
}

/** Whether Dispatch Pilot as a whole is on. Off: no decision is asked and every step goes out as the engine made it. */
export function masterOn(): boolean {
  return flipped[MASTER] ?? true
}

export function setMaster(on: boolean): void {
  if (on) delete flipped[MASTER]
  else flipped[MASTER] = false
}

/** Whether a feature may act: the master switch is on and so is the feature's own. A name nobody registered counts as on. */
export function isOn(name: string): boolean {
  return masterOn() && (flipped[name] ?? specs.get(name)?.default ?? true)
}

/** Flips one feature's switch; false (nothing changed) when no feature registered that name. */
export function setSwitch(name: string, on: boolean): boolean {
  const spec = specs.get(name)
  if (spec === undefined) return false
  if (on === spec.default) delete flipped[name]
  else flipped[name] = on
  return true
}

/** The registered switches with their states, in registration order. */
export function listSwitches(): SwitchInfo[] {
  return [...specs.values()].map((spec) => ({ ...spec, on: flipped[spec.name] ?? spec.default }))
}

/** What the person flipped away from the defaults, by name (the master switch's is `master`). */
export function overrides(): Record<string, boolean> {
  return { ...flipped }
}

/** What a store value holds of it: the names with a true or false; anything else is left out. */
export function parseOverrides(stored: unknown): Record<string, boolean> {
  const parsed: Record<string, boolean> = {}
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return parsed
  for (const [name, on] of Object.entries(stored)) {
    if (typeof on === 'boolean' && (name === MASTER || NAME.test(name))) parsed[name] = on
  }
  return parsed
}

/** Takes back what the store holds. */
export function loadOverrides(stored: unknown): void {
  flipped = parseOverrides(stored)
}
