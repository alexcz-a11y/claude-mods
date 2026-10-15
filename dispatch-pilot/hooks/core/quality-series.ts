// A series of quality levels compared pair by pair (#61, ADR 0008): the zoomed re-check (core/zoom-review.ts `comparePair`) of each two
// neighbouring levels, in the parts the checks name. Like zoom-review.ts it keeps no state and asks for nothing but closures (a module
// cannot pass `$` across an import): the files, and `ask`, which sends one request to the decision model that takes images.

import type { Failure } from '../decision/backend.ts'
import { imageTokens } from '../decision/images.ts'
import { SERIES_BARS, type Check } from '../decision/visual-check.ts'
import { pairWaves } from '../decision/visual-check-sequence.ts'
import type { LoadedImage } from './image-files.ts'
import { comparePair, type ZoomDeps, type ZoomOutcome } from './zoom-review.ts'

/** What two neighbouring levels came to: `from` and `to` are their places in the series, counted from 1. */
export type PairOutcome = { from: number; to: number; outcome: ZoomOutcome }

export type SeriesOutcome = {
  /** One for each two neighbouring levels, lowest first. */
  pairs: PairOutcome[]
  /** The first request that failed, if one did (the board keeps it as a note, #58). */
  failure: Failure | null
}

/**
 * Every two neighbouring levels of `levels` (lowest first), compared on the parts the checks name. The pairs go out in waves
 * (`pairWaves`): those of a wave at once, one wave after the other, so that a series of many large images keeps to what the
 * decision model takes in one go and each request keeps to its own wait. Each pair's higher level is the candidate. A pair whose
 * re-check cannot be made has its checks unsure, with the reason; nothing throws.
 */
export async function compareLevels(deps: ZoomDeps, levels: readonly LoadedImage[], sameView: boolean | null, checks: readonly Check[]): Promise<SeriesOutcome> {
  const neighbours = levels.slice(1).map((high, i) => ({ from: i + 1, to: i + 2, candidate: high, other: levels[i] as LoadedImage }))
  const pairs: PairOutcome[] = []
  for (const wave of pairWaves(neighbours.map((pair) => imageTokens('jev', [pair.candidate, pair.other], 1)))) {
    pairs.push(
      ...(await Promise.all(
        wave.map(async (index): Promise<PairOutcome> => {
          const { from, to, candidate, other } = neighbours[index] as (typeof neighbours)[number]
          return { from, to, outcome: await comparePair(deps, { candidate, other, sameView }, checks, SERIES_BARS) }
        }),
      )),
    )
  }
  return { pairs, failure: pairs.find((pair) => pair.outcome.failure !== null)?.outcome.failure ?? null }
}
