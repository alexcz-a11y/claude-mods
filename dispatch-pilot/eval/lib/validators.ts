// What the dataset checkers share (datasets.ts, visual-check-items.ts, eval-v2.ts): the small tests their rules are made of.
//
// Pure: no Node API.

/** Where a check puts what is wrong with an item. */
export type Add = (message: string) => void

/** A JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Says each key of `keys` that `value` lacks, and each key of it that is not one; `at` names where `value` is ('' for the item itself). */
export function exactKeys(value: Record<string, unknown>, keys: readonly string[], at: string, add: Add): void {
  const prefix = at === '' ? '' : `${at}.`
  for (const key of keys) if (!(key in value)) add(`${prefix}${key} is missing`)
  for (const key of Object.keys(value)) if (!keys.includes(key)) add(`${at === '' ? '' : `${at} has an `}unknown field ${key}`)
}

/** Whether `positions` run on without a gap (in any order, repeats aside). */
export function adjacent(positions: readonly number[]): boolean {
  const sorted = [...new Set(positions)].sort((a, b) => a - b)
  return sorted.every((position, i) => i === 0 || position === (sorted[i - 1] as number) + 1)
}
