// The progress notes of the mid-run cases (calibration plan, Task 12 Step 1): which steps each note is written from,
// a note merged into its case, and the environment a note's call runs in. Pure: notes.ts imports it, as do the tests.
//
// The note is the mod's own (progressPrompt, parseProgress): after a checkpoint the mod writes one note from the turn's
// request, the note it held (previous_note) and the step that checkpoint judged (latest_step). Here a case is one
// checkpoint, so "before" is the note the mod would hold at it, written at the step before the latest with no older
// note (none is known), and "after" the next note, written at the latest step with "before" as previous_note.
import { progressPrompt } from '../../hooks/progress.ts'
import type { ProgressNote } from '../../hooks/statebuild.ts'
import type { MidrunCase } from './case.ts'

export type Notes = { before: ProgressNote | null; after: ProgressNote | null }
type Prompt = { system: string; prompt: string }

/** The prompt of "before": the step before the latest, no previous note; null when the latest step is the first. */
export function beforePrompt(input: MidrunCase['input']): Prompt | null {
  const latest = input.recent.at(-1)
  return latest === undefined ? null : progressPrompt({ request: input.request, previous: null, latest })
}

/** The prompt of "after": the latest step, on top of "before" (null when there is none or it could not be read). */
export function afterPrompt(input: MidrunCase['input'], before: ProgressNote | null): Prompt {
  return progressPrompt({ request: input.request, previous: before, latest: input.latest })
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

// Global constraints: no command and no session runs with OpenTelemetry on.
const TELEMETRY = ['CLAUDE_CODE_ENABLE_TELEMETRY', 'ENABLE_BETA_TRACING_DETAILED']

/** A copy of an environment without the variables that turn OpenTelemetry on. */
export function withoutTelemetry(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !TELEMETRY.includes(k) && !k.startsWith('OTEL_')) out[k] = v
  return out
}
