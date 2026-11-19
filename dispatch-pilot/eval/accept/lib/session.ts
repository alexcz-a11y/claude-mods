// The interactive session of one acceptance run: its settings, its environment, the command its tmux pane runs, and
// how its screen reads (calibration plan, Task 15 Step 3). Pure: run.ts does the I/O; the tests import this.
import { withoutTelemetry } from '../../lib/notes.ts'

export type Arm = 'on' | 'off'
export type Mode = 'code' | 'ordinary'

const CODE_MODE = 'CLAUDE_CODE_EXPERIMENTAL_CODE_MODE'

export type Settings = {
  enabledPlugins: Record<string, boolean>
  pluginConfigs: Record<string, { options: Record<string, unknown> }>
  env: Record<string, string>
}

/**
 * The --settings file. The installed copies are switched off; the mod loaded with --plugin-dir takes its options only
 * from pluginConfigs (DEVELOPMENT.md, 「内联插件的选项」), so every option is written: the manifest's default, then the
 * run's own. The two arms differ in midrunShift alone. env sets Code Mode by the mode: the user's own settings can set it
 * in their env, which the engine applies over the process's, and these settings come after the user's.
 */
export function settingsFor(o: { arm: Arm; mode: Mode; key: string; userConfig: Record<string, unknown> }): Settings {
  const defaults: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(o.userConfig)) {
    if (typeof spec === 'object' && spec !== null && 'default' in spec) defaults[name] = (spec as { default: unknown }).default
  }
  const options = { ...defaults, backend: 'drex', drexModel: 'drex-max-v1.1', drexApiKey: o.key, mode: 'apply', submitShift: true, midrunShift: o.arm === 'on' }
  return {
    enabledPlugins: { 'dispatch-pilot@alex-mods': false, 'dispatch-pilot-extras@alex-mods': false },
    pluginConfigs: { 'dispatch-pilot@inline': { options } },
    // An empty value reads as unset whether the engine tests the variable for truth or for presence of a value.
    env: { [CODE_MODE]: o.mode === 'code' ? '1' : '' },
  }
}

/**
 * The environment the session starts with: no telemetry variable, no Nace key (the mod takes it from the settings
 * file; a key in the environment is one \`env\` away from the session's record), Code Mode by the mode.
 */
export function sessionEnv(env: Readonly<Record<string, string | undefined>>, mode: Mode): Record<string, string> {
  const out = withoutTelemetry(env)
  delete out.NACE_API_KEY
  delete out[CODE_MODE]
  if (mode === 'code') out[CODE_MODE] = '1'
  return out
}

function quoted(s: string): string {
  if (s.includes("'")) throw new Error(`a path with a quote in it: ${s}`)
  return `'${s}'`
}

/**
 * The shell command the tmux pane runs (with /bin/sh -c). A tmux server already running gives a new session its own
 * environment, not the client's, so the pane cleans it again before it starts the session.
 */
export function paneCommand(o: { pluginDir: string; settings: string; model: string; mode: Mode }): string {
  const clean = `unset CLAUDE_CODE_ENABLE_TELEMETRY ENABLE_BETA_TRACING_DETAILED NACE_API_KEY ${CODE_MODE} $(env | sed -n 's/^\\(OTEL_[A-Za-z0-9_]*\\)=.*/\\1/p')`
  const mode = o.mode === 'code' ? `export ${CODE_MODE}=1; ` : ''
  return `${clean}; ${mode}command claude --plugin-dir ${quoted(o.pluginDir)} --settings ${quoted(o.settings)} --model ${quoted(o.model)}`
}

/** The prompt as one bracketed paste, so its line breaks are not taken for Enter; the Enter is sent after it. */
export function pasted(prompt: string): string {
  return `\x1b[200~${prompt.replace(/\s+$/, '')}\x1b[201~`
}

export type Screen = 'trust' | 'permission' | 'busy' | 'idle'

// The engine's own wording (2.1.328): the trust dialog, a permission prompt, and the line shown while a turn runs.
const TRUST = /Is this a project you created or one you trust|Yes, I trust this folder/
const PERMISSION = /Do you want to (proceed|allow|make this edit|create)|Yes, and don't ask again/
const BUSY = /esc to interrupt/i

export function screenState(text: string): Screen {
  if (TRUST.test(text)) return 'trust'
  if (PERMISSION.test(text)) return 'permission'
  if (BUSY.test(text)) return 'busy'
  return 'idle'
}
