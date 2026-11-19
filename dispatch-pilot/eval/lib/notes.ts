// The progress notes of the mid-run cases (calibration plan, Task 12 Step 1): which steps each note is written from,
// a note merged into its case, and the environment a note's call runs in. Pure: notes.ts imports it, as do the tests.
//
// The note is the mod's own (progressPrompt, parseProgress): after a checkpoint the mod writes one note from the turn's
// request, the note it held (previous_note) and the step that checkpoint judged (latest_step), so its note is built up
// step by step. Here a case is one checkpoint: "before" is the note the mod would hold there, folded over input.recent in
// order from no note at all, and "after" the next one, written at the latest step on top of "before".
import { progressPrompt } from '../../hooks/progress.ts'
import type { ProgressNote, StepRecord } from '../../hooks/statebuild.ts'
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

// Global constraints: no command and no session runs with OpenTelemetry on.
const TELEMETRY = ['CLAUDE_CODE_ENABLE_TELEMETRY', 'ENABLE_BETA_TRACING_DETAILED']

/** A copy of an environment without the variables that turn OpenTelemetry on. */
export function withoutTelemetry(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !TELEMETRY.includes(k) && !k.startsWith('OTEL_')) out[k] = v
  return out
}
