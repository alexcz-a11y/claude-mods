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
type Resummarized<R extends StoredResult> = Omit<R, 'summary'> & {
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
