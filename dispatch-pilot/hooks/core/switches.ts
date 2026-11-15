// What is switched on: the whole mod (the master switch) and each feature.
// Each switch is one boolean option of the plugin's configuration (plugin.json
// `userConfig`; `optionOf` names it), and the configuration is the only place a
// switch is kept (ADR 0027): the entry hands the options over as the module
// loads (`loadSwitches`), and `/dp` (features/control.ts) and the pane's buttons
// write the option through `$.config.set` (`writeSwitch`), which reloads the
// module with the new options. A feature registers its switch in its register:
//
//   defineSwitch({ name: 'escalation', info: '派出的 agent 的工具调用失败够多次时，升 effort、换更强的模型', parts: ['counts'] })
//
// and asks `isOn('escalation')` where it would act (DEVELOPMENT.md, 开发).
// The screens ask the same as they draw: a feature that is off leaves its
// decisions and the board parts it owns off the band and the footer.
//
// Pure module state, no `$`. A flip is also kept here for the rest of this
// load, for the session whose configuration cannot be written (one without a
// `/config` panel, as `claude -p`): there it holds until the module is loaded
// again.

/**
 * The parts of the agents' nodes on the board a feature writes, beside its decisions in the log (which are its
 * own by its name): `counts`, a loop's failed calls and model step-ups; `checks`, a loop's visual_check verdicts.
 */
export type BoardPart = 'counts' | 'checks'

export type SwitchSpec = {
  /** What the person types in `/dp <name> on|off`: lowercase letters, digits and `-`, starting with a letter. */
  name: string
  /** What the switch does, for `/dp`'s listing: the description of its option in plugin.json, word for word (eval/lib/docs.ts `checkSwitchOptions`). */
  info: string
  /** Whether it is on until the person flips it; on when left out. The `default` of its option in plugin.json. */
  default?: boolean
  /** The board parts the feature owns: the screens leave them out while it is off. */
  parts?: readonly BoardPart[]
}

/** A registered switch. */
type Registered = { name: string; info: string; default: boolean; parts: readonly BoardPart[] }
/** A registered switch as `/dp` lists it, with its state. */
export type SwitchInfo = Registered & { on: boolean }

/** The master switch's name; no feature may take it. */
export const MASTER = 'master'
/** Words `/dp` itself understands: a feature named like one would make `/dp <name> on` ambiguous. */
const RESERVED = [MASTER, 'on', 'off', 'all', 'reset', 'status', 'help', 'lock', 'unlock', 'log']
const NAME = /^[a-z][a-z0-9-]*$/

/** The plugin's name, as the engine starts the key of each of its `/config` rows with it. */
const PLUGIN = 'dispatch-pilot'

/** The registered switches, in registration order. */
const specs = new Map<string, Registered>()
/** The plugin's options as the engine handed them at this load: a switch reads its own (`optionOf`). */
let configured: Readonly<Record<string, unknown>> = {}
/** What was flipped since this load, by switch name (the master included): what the configuration will say once it is written. */
let flipped: Record<string, boolean> = {}

/**
 * The option of the plugin's configuration a switch is: its name in camel case (`midrun-steps` is `midrunSteps`); the master
 * switch is `enabled`.
 */
export function optionOf(name: string): string {
  return name === MASTER ? 'enabled' : name.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase())
}

/** The key of a switch's row in `/config`, which `$.config.set` takes: `dispatch-pilot.<option>`. */
export function configKey(name: string): string {
  return `${PLUGIN}.${optionOf(name)}`
}

/** Takes the plugin's options as the module loads (the entry, before any feature registers): the switches are as they say. */
export function loadSwitches(options: Readonly<Record<string, unknown>>): void {
  configured = options
  flipped = {}
}

/** A switch as it stands: what was flipped since this load, else its option, else `fallback` (the option missing or not a boolean). */
function valueOf(name: string, fallback: boolean): boolean {
  const set = flipped[name] ?? configured[optionOf(name)]
  return typeof set === 'boolean' ? set : fallback
}

/** Registers a feature's switch. Registering a name again replaces it; a name `/dp` cannot take throws. */
export function defineSwitch(spec: SwitchSpec): void {
  if (!NAME.test(spec.name) || RESERVED.includes(spec.name)) {
    throw new Error(`switch name "${spec.name}" is not allowed: use lowercase letters, digits and "-", and none of ${RESERVED.join(', ')}`)
  }
  specs.set(spec.name, { name: spec.name, info: spec.info, default: spec.default ?? true, parts: spec.parts ?? [] })
}

/** Whether Dispatch Pilot as a whole is on. Off: no decision is asked and every step goes out as the engine made it. */
export function masterOn(): boolean {
  return valueOf(MASTER, true)
}

export function setMaster(on: boolean): void {
  flipped[MASTER] = on
}

/** Whether a feature may act: the master switch is on and so is the feature's own. A name nobody registered counts as on. */
export function isOn(name: string): boolean {
  return masterOn() && valueOf(name, specs.get(name)?.default ?? true)
}

/** Whether the screens show a board part: the mod is on, and so is every feature that owns the part. */
export function isShown(part: BoardPart): boolean {
  return masterOn() && [...specs.values()].every((spec) => !spec.parts.includes(part) || isOn(spec.name))
}

/** Flips one feature's switch for this load; false (nothing changed) when no feature registered that name. */
export function setSwitch(name: string, on: boolean): boolean {
  if (!specs.has(name)) return false
  flipped[name] = on
  return true
}

/** The registered switches with their states, in registration order. */
export function listSwitches(): SwitchInfo[] {
  return [...specs.values()].map((spec) => ({ ...spec, on: valueOf(spec.name, spec.default) }))
}

/** `$.config.set` as the caller reaches it: resolves to `{ deny }` when the row is refused, rejects when there is no such row. */
export type ConfigWrite = (args: { key: string; value: boolean }) => Promise<{ deny?: string | undefined }>

/**
 * Writes a switch (or the master switch, `MASTER`) into the plugin's configuration, where it is kept: null once written,
 * else why it was not (the engine's words: a session without a `/config` panel has no row to write, a managed setting
 * owns the row). The engine reloads the module with the new options after a write.
 */
export async function writeSwitch(write: ConfigWrite, name: string, on: boolean): Promise<string | null> {
  try {
    const written = await write({ key: configKey(name), value: on })
    return typeof written.deny === 'string' ? written.deny : null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The `$.store` key 0.13.0 and earlier kept the person's switches under: read only to move them (`moveStoredSwitches`). */
export const STORED_SWITCHES_KEY = 'switches'

/** What a store value holds of the switches an earlier version kept: the names with a true or false; anything else is left out. */
function storedSwitches(stored: unknown): Record<string, boolean> {
  const parsed: Record<string, boolean> = {}
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return parsed
  for (const [name, on] of Object.entries(stored)) {
    if (typeof on === 'boolean' && (name === MASTER || NAME.test(name))) parsed[name] = on
  }
  return parsed
}

/** What moving the stored switches needs of the host: the store's value and a way to empty it, the `/config` rows, the writer. */
export type StoredSwitchesIo = {
  read: () => Promise<unknown>
  clear: () => Promise<unknown>
  /** The rows `/config` has now (`$.config.list`): each one's key and value. */
  rows: () => Promise<readonly { key: string; value: unknown }[]>
  write: ConfigWrite
}

/**
 * Moves the switches 0.13.0 and earlier kept in `$.store` into the configuration, once: each one the code still defines is
 * taken for this load and written to its row unless the row says so already, and the store's value is emptied when none
 * is left to write. The names moved, for the log; none when the store held nothing.
 *
 * A write reloads the module, whose session start comes here again: it finds the rows written so far and goes on with the
 * rest, so the store is emptied last, by whichever load finds nothing left to write. A session whose configuration cannot
 * be written (`claude -p` has no rows) only takes the switches for itself and leaves the store for a session that can.
 */
export async function moveStoredSwitches(io: StoredSwitchesIo): Promise<string[]> {
  const stored = Object.entries(storedSwitches(await io.read().catch(() => undefined))).filter(([name]) => name === MASTER || specs.has(name))
  if (stored.length === 0) return []
  const rows = new Map((await io.rows().catch(() => [])).map((row) => [row.key, row.value]))
  let written = true
  for (const [name, on] of stored) {
    flipped[name] = on
    if (rows.get(configKey(name)) !== on && (await writeSwitch(io.write, name, on)) !== null) written = false
  }
  if (written) await io.clear().catch(() => undefined)
  return stored.map(([name]) => name)
}
