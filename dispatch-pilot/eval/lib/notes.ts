// The progress notes of the mid-run cases (calibration plan, Task 12 Step 1): which steps each note is written from,
// a note merged into its case, and the environment a note's call runs in. Pure: notes.ts imports it, as do the tests.
//
// The note is the mod's own (progressPrompt, parseProgress): after a checkpoint the mod writes one note from the turn's
// request, the note it held (previous_note) and the step that checkpoint judged (latest_step), so its note is built up
// step by step. Here a case is one checkpoint: "before" is the note the mod would hold there, folded over input.recent in
// order from no note at all, and "after" the next one, written at the latest step on top of "before".
import { progressPrompt } from '../../hooks/progress.ts'
import type { ProgressNote, StepRecord } from '../../hooks/statebuild.ts'
import { recordDir } from '../accept/lib/records.ts'
import type { MidrunCase } from './case.ts'

export type Notes = { before: ProgressNote | null; after: ProgressNote | null }
type Prompt = { system: string; prompt: string }

type Ask = (p: Prompt) => Promise<ProgressNote | null>

/** The prompt of one step, on top of the note held before it. */
function stepPrompt(input: MidrunCase['input'], previous: ProgressNote | null, latest: StepRecord): Prompt {
  return progressPrompt({ request: input.request, previous, latest })
}

/**
 * Both notes, by one call per step: "before" folded over input.recent (null when it is empty), "after" on the latest
 * step. A reply that cannot be read (ask gives null) leaves the note held before it standing for the next step.
 */
export async function foldNotes(input: MidrunCase['input'], ask: Ask): Promise<Notes> {
  let before: ProgressNote | null = null
  for (const step of input.recent) before = (await ask(stepPrompt(input, before, step))) ?? before
  const after = await ask(stepPrompt(input, before, input.latest))
  return { before, after }
}

/** How many calls foldNotes makes for a case: one per recent step and one for "after". */
export function callsFor(input: MidrunCase['input']): number {
  return input.recent.length + 1
}

/** The first call's prompt: the oldest recent step with no note yet, or "after" when there is no recent step. */
export function firstPrompt(input: MidrunCase['input']): Prompt {
  return stepPrompt(input, null, input.recent[0] ?? input.latest)
}

/** Whether a case's notes are to be written: it has none yet, or force rewrites them. */
export function notesWanted(c: MidrunCase, force: boolean): boolean {
  return force || c.input.notes === null
}

/** The cases with one case's notes replaced; nothing else changes, and the array given is left as it was. */
export function withNotes(cases: readonly MidrunCase[], id: string, notes: Notes): MidrunCase[] {
  if (!cases.some((c) => c.id === id)) throw new Error(`no case ${id}`)
  return cases.map((c) => (c.id === id ? { ...c, input: { ...c.input, notes } } : c))
}

/**
 * The arguments of one note's call. Only the project's settings are read, and the call runs in an empty directory, so
 * that is none: the user's hooks, env and plugins must not shape a note the mod writes through its own model call.
 * (claude --help: "Comma-separated list of setting sources to load (user, project, local)"; whether the user's own
 * CLAUDE.md is left out with them it does not say.)
 */
export function noteArgs(system: string): string[] {
  return ['-p', '--model', 'haiku', '--setting-sources', 'project', '--system-prompt', system]
}

// Global constraints: no command and no session runs with OpenTelemetry on.
const TELEMETRY = ['CLAUDE_CODE_ENABLE_TELEMETRY', 'ENABLE_BETA_TRACING_DETAILED']

/** A copy of an environment without the variables that turn OpenTelemetry on. */
export function withoutTelemetry(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !TELEMETRY.includes(k) && !k.startsWith('OTEL_')) out[k] = v
  return out
}

/**
 * The environment of one note's call: no telemetry variable and no Nace key. The call needs no key, and one in the
 * environment is one `env` away from the session's record (as sessionEnv in accept/lib/session.ts).
 */
export function noteEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out = withoutTelemetry(env)
  delete out.NACE_API_KEY
  return out
}

// What every call directory's record folder is named from (notes.ts makes its call directories under /private/tmp/dp-notes).
const CALL_RECORD_PREFIX = '-private-tmp-dp-notes-call-'

/**
 * The folder Claude Code keeps a call's session record in, which notes.ts removes after the call; null for a directory
 * that is not a note's call directory, so nothing else under ~/.claude/projects/ is ever removed.
 */
export function callRecord(home: string, callDir: string): string | null {
  const dir = recordDir(home, callDir)
  return dir.slice(dir.lastIndexOf('/') + 1).startsWith(CALL_RECORD_PREFIX) ? dir : null
}
