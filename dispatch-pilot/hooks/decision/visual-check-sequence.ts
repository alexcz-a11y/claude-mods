// A series of quality levels in visual_check (#61, ADR 0008): the agent hands over screenshots of one view at rising levels (the
// sea at low, medium, high, ultra) and asks whether the higher levels still look different in the places it names, so as to find
// the level from which they do not. Each two neighbouring levels are compared as any pair of images is (core/zoom-review.ts
// `comparePair`: the named part located in both, cropped, enlarged, judged on the crops); this module is what comes of the pairs.
// The eval's visual-check suite (#65) reads a series the very same way, so it is pure (see system-one.ts).

import { packByCost } from './images.ts'
import { SERIES_PASS_AT, type CheckResult } from './visual-check.ts'

/** Most levels one call takes: each neighbouring pair is its own requests, and they go out in waves (`pairWaves`). */
export const MAX_LEVELS = 12

// ---- What the agent reads of it -------------------------------------------------------------------------------------

/** With Jev, in the tool's description (visual-check-tool.ts): what a series is for, how it is judged, what to put in the final report. */
export const SERIES_DESCRIPTION =
  `To find the quality level from which higher ones look no different, give the screenshots of one view at rising levels in images, lowest first (2 to ${MAX_LEVELS} levels), with sequence: true, and name the parts the level may change: each two neighbouring levels are compared in every part you name, on enlarged crops, and the answer lists each pair and says from which level up nothing differs. It counts as no difference only if every part you named passes (${SERIES_PASS_AT} or more). Use it instead of handing the user the levels to compare. A still does not show flicker or rippling jitter: for those cut the same moment out of a recording of each level (for example with ffmpeg) and give those frames as the series. List the levels you tried, the parts you compared, the result and the probabilities in your final report.`

/** With pplx, in its description: a series needs the zoomed re-check, which needs the boxes only Jev answers. */
export const SERIES_UNAVAILABLE =
  'With pplx, sequence (a series of quality levels) is not available: it needs the zoomed re-check, which needs a TypeSafe key. Look at the levels yourself.'

// ---- What a pair comes to -------------------------------------------------------------------------------------------

/**
 * What two neighbouring levels come to. "No difference" is the weak direction of the decision model's answers, which only a pass
 * at SERIES_PASS_AT (0.9: the old bar, kept for this; a screenshot passes at 0.8) on the crop of a part can show (ADR 0008), and it takes every part the checks name: `same` when all pass; `differs`
 * when any fails (a part known to differ outweighs a doubt about another); `unsure` otherwise.
 */
export type PairConclusion = 'same' | 'differs' | 'unsure'

export function pairConclusion(results: readonly Pick<CheckResult, 'verdict'>[]): PairConclusion {
  if (results.some((result) => result.verdict === 'fail')) return 'differs'
  return results.length > 0 && results.every((result) => result.verdict === 'pass') ? 'same' : 'unsure'
}

// ---- What the series comes to ---------------------------------------------------------------------------------------

/**
 * What the pairs come to, by levels counted from 1. `from`: the higher levels look alike from this one up (it is the lowest
 * level beyond which a higher one is not worth its cost). `differs`: the top pair still differs, so there is no such level;
 * `every`: every pair differs. `unknown`: the top pair could not be told.
 */
export type SeriesVerdict = { kind: 'from'; level: number } | { kind: 'differs'; every: boolean } | { kind: 'unknown' }

/**
 * The series' verdict from the conclusions of its pairs, in order (the pair `i` is level `i + 1` and level `i + 2`). The levels
 * from which none differs from the next are the unbroken run of `same` pairs at the top; a pair lower down that looked the same
 * does not count when a higher one differs again.
 */
export function seriesVerdict(pairs: readonly PairConclusion[]): SeriesVerdict {
  const top = pairs.at(-1)
  if (top === 'differs') return { kind: 'differs', every: pairs.every((pair) => pair === 'differs') }
  if (top !== 'same') return { kind: 'unknown' }
  let first = pairs.length - 1
  while (first > 0 && pairs[first - 1] === 'same') first--
  return { kind: 'from', level: first + 1 }
}

// ---- Sending the pairs ----------------------------------------------------------------------------------------------

/** About how many input tokens the images of the pairs in one wave may cost in all: three requests at the 24,000 tokens a Jev request takes of images. */
const WAVE_TOKENS = 72_000
/** Most pairs in one wave, however small their images: each is a few requests of its own. */
const WAVE_PAIRS = 6

/**
 * The pairs split into waves that go out one after the other, the pairs of a wave at once: a series of many levels at full size
 * would otherwise put a dozen requests of two large images on the decision model together and wait for the slowest. `tokens`:
 * what the images of each pair cost, in order. A pair is never split; the result holds the pairs' indexes.
 */
export function pairWaves(tokens: readonly number[]): number[][] {
  return packByCost(tokens, WAVE_TOKENS, WAVE_PAIRS)
}
