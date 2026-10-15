// A result file's summary brought up to the metrics of now (metrics.ts) from
// the answers the file holds, without asking again: each language's late,
// retried and inTime (`inTimeOf`), and each variant's pass (`passes`). The
// rest of the summary (accuracy, agreement, latency, breakdowns, constants) is
// what the run computed: their metrics did not change.
//
// Pure; the Node script eval/resummarize.ts reads and writes the files.

import { isRecord } from './datasets.ts'
import { inTimeOf, passes, type Timed } from './metrics.ts'

/** The parts of a result file read here; the rest is kept as it is. */
export type StoredResult = {
  settings: { timeoutMs: number }
  summary: { variants: readonly StoredVariant[] }
  answers: readonly Readonly<Record<string, unknown>>[]
}
type StoredVariant = { variant: string; zh: StoredLanguage; en: StoredLanguage; gap: number; pass: boolean }
type StoredLanguage = { items: number; late?: number; retried?: number; inTime?: number }
/** A variant's summary as it comes back: each language with its timings. */
type Brought<V extends StoredVariant> = V & { zh: V['zh'] & Timings; en: V['en'] & Timings }
type Timings = { late: number; retried: number; inTime: number }
/** A result as it comes back. */
export type Resummarized<R extends StoredResult> =Omit<R, 'summary'> & {
  summary: Omit<R['summary'], 'variants'> & { variants: Brought<R['summary']['variants'][number]>[] }
  resummarized: { date: string; by: string; what: string }
}

/** What the note in a brought-up file says was done. */
export const RESUMMARIZED_WHAT =
  "each variant's pass by the bar of 2026-10-05 (Chinese at most 4 points below English, exactly 4 passing); each language's late, retried and inTime from the answers kept here (an answer that took more attempts than requests is no decision in time: the mod never retries)"

/**
 * `result` with its summary brought up to date (see the head of this file)
 * and a note of when and how (`resummarized`). The answers and every other
 * field stay as they were.
 */
export function resummarize<R extends StoredResult>(result: R, date: string): Resummarized<R> {
  const slowMs = result.settings.timeoutMs
  const variants = result.summary.variants.map((summary) => {
    const language = (name: 'zh' | 'en') => {
      const { late: _late, retried: _retried, inTime: _inTime, ...rest } = summary[name]
      const rows = result.answers.flatMap((line) => {
        const answer = line[summary.variant]
        return line.language === name && isRecord(answer) ? [timed(answer)] : []
      })
      return { ...rest, ...inTimeOf(rows, rest.items, slowMs) }
    }
    return { ...summary, zh: language('zh'), en: language('en'), pass: passes(summary.gap) }
  })
  return { ...result, summary: { ...result.summary, variants }, resummarized: { date, by: 'eval/resummarize.ts', what: RESUMMARIZED_WHAT } } as Resummarized<R>
}

/** A file as the script read it: where from, and what it holds. */
export type FileText = { file: string; text: string }

/** What `resummarizeAll` makes of the files: those brought up to date (`before` as stored, `after` as it is to be written), and those skipped with the reason. */
export type Resummarizing = {
  done: { file: string; before: StoredResult; after: Resummarized<StoredResult> }[]
  skipped: { file: string; why: string }[]
}

/**
 * Every file brought up to date or, when it is no result, skipped with why: the results/ folders also hold flow files
 * (eval-v2-flow/) and scans (eval-v2/compare.json, thresholds-*.json), which have no summary of variants. Nothing is
 * written here: the script writes `done` once all of it is known, so a file that fails halfway leaves nothing half done.
 */
export function resummarizeAll(files: readonly FileText[], date: string): Resummarizing {
  const out: Resummarizing = { done: [], skipped: [] }
  for (const { file, text } of files) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      out.skipped.push({ file, why: 'not JSON' })
      continue
    }
    const problem = notAResult(parsed)
    if (problem !== null) {
      out.skipped.push({ file, why: problem })
      continue
    }
    const before = parsed as StoredResult
    out.done.push({ file, before, after: resummarize(before, date) })
  }
  return out
}

/** Why `value` is not a result file (what `resummarize` reads of it is missing), or null when it is one. */
function notAResult(value: unknown): string | null {
  if (!isRecord(value)) return 'not a result: not an object'
  if (!isRecord(value.settings) || typeof value.settings.timeoutMs !== 'number') return 'not a result: no settings.timeoutMs'
  if (!isRecord(value.summary) || !Array.isArray(value.summary.variants)) return 'not a result: no summary.variants'
  if (!Array.isArray(value.answers)) return 'not a result: no answers'
  const shaped = value.summary.variants.every((variant) => isRecord(variant) && typeof variant.variant === 'string' && typeof variant.gap === 'number' && isRecord(variant.zh) && isRecord(variant.en))
  return shaped ? null : 'not a result: a variant of the summary lacks its name, gap, zh or en'
}

/** A stored answer as the metrics read it: answered unless it says why not; the skill suite's stages are its requests. */
function timed(answer: Readonly<Record<string, unknown>>): Timed {
  return {
    ok: answer.failure === undefined,
    correct: answer.correct === true,
    ms: typeof answer.ms === 'number' ? answer.ms : null,
    attempts: typeof answer.attempts === 'number' ? answer.attempts : 1,
    requests: Array.isArray(answer.stages_ms) ? answer.stages_ms.length : 1,
  }
}
