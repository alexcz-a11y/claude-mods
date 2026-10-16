// What a series of quality levels answers the agent (#61, ADR 0008): each pair of neighbouring levels with its checks, then from which
// level on the higher ones look alike. English, for the model (the person's words are in visual-check-record.ts). Pure (see system-one.ts).

import { pairConclusion, type PairConclusion, seriesVerdict } from './visual-check-sequence.ts'
import { checkLine, placeLine } from './visual-check-tool.ts'
import type { CheckResult } from './visual-check.ts'
import type { Box } from './zoom.ts'

/** One pair of neighbouring levels as the answer tells it: how its checks came out, and the other place the images may differ in, if the model found one. */
export type PairReport = { results: readonly CheckResult[]; elsewhere?: { box: Box; confidence: number } | null }

const CONCLUSION_WORDS: Readonly<Record<PairConclusion, string>> = { same: 'NO DIFFERENCE', differs: 'DIFFERENT', unsure: 'UNSURE' }
/** The answer's text for a series: `levels` are the paths, lowest first, and `pairs[i]` is level `i + 1` against level `i + 2`. */
export function seriesText(levels: readonly string[], pairs: readonly PairReport[]): string {
  const lines = [`Visual check of a series of ${levels.length} quality levels, in the order given:`]
  levels.forEach((path, i) => lines.push(`level ${i + 1}: ${path}`))
  const conclusions = pairs.map((pair) => pairConclusion(pair.results))
  pairs.forEach((pair, i) => {
    lines.push(`Level ${i + 1} to level ${i + 2}: ${CONCLUSION_WORDS[conclusions[i] as PairConclusion]}`)
    pair.results.forEach((result, k) => lines.push(`  ${checkLine(result, k)}`))
    if (pair.elsewhere != null) lines.push(`  ${placeLine({ ...pair.elsewhere, cropped: false })}`)
  })
  const top = `the top pair, level ${levels.length - 1} to level ${levels.length}`
  const verdict = seriesVerdict(conclusions)
  if (verdict.kind === 'from') {
    lines.push(`Result: from level ${verdict.level} upward no difference was seen in the parts you named. Level ${verdict.level} is the lowest level beyond which a higher one looks the same there.`)
  } else if (verdict.kind === 'differs') {
    lines.push(
      verdict.every
        ? 'Result: every level differs from the next in the parts you named, up to the top: no level was found from which the higher ones look the same.'
        : `Result: no level was found from which the higher ones look the same: ${top}, still differs.`,
    )
  } else {
    lines.push(`Result: it could not be told from which level on the higher ones look alike: ${top}, is UNSURE. Look at those two levels yourself (visual_check with look: true).`)
  }
  const passed = pairs.some((pair) => pair.results.some((result) => result.verdict === 'pass'))
  lines.push(`${passed ? 'PASS only means that nothing obviously wrong was seen; it is not an acceptance. ' : ''}A still shows no flicker or jitter: compare frames of a recording for those.`)
  lines.push('In your final report list the levels you tried, the parts you compared, and the result with these probabilities.')
  return lines.join('\n')
}
