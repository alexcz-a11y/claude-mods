// A number given on the command line (eval/node.ts numberFlag and scriptTimeout: eval/run.ts, the eval-v2 and long-context suites, scripts/decide*.ts), read strictly: `Number()` turns a typo into NaN, and NaN passes
// every comparison the run makes with it unseen (`estimatedUsd > NaN` is false: no spend cap; `attempt > NaN` is
// false: no end to the retries; a timer of NaN ms fires at once; no worker is started for NaN requests in flight).
//
// Pure: no Node API.

/** What a flag's number must be: at least `min`, and a whole number when `integer`. */
export type NumberRule = { min: number; integer?: boolean }

/**
 * The number `text` writes for `flag`, or an error that names the flag, what it takes and what was written. Only a
 * finite number is one: not empty text, not `Infinity`, not words.
 */
export function readNumber(flag: string, text: string, rule: NumberRule): number {
  const value = text.trim() === '' ? Number.NaN : Number(text)
  if (!Number.isFinite(value) || value < rule.min || (rule.integer === true && !Number.isInteger(value))) {
    throw new Error(`${flag} takes ${rule.integer === true ? 'a whole number' : 'a number'} of at least ${rule.min}, not "${text}"`)
  }
  return value
}
