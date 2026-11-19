// Questions asked only in calibration, as controls beside the mod's own (calibration plan, Task 4). A control that
// wins moves to hooks/questions.ts; until then its wording lives here. Pure: no node: module.
import type { Answer } from '../../hooks/backend.ts'
import { LEVELS, isLevel } from '../../hooks/levels.ts'
import type { Level } from '../../hooks/levels.ts'
import type { Question } from '../../hooks/questions.ts'

/** The level asked for in one question, instead of read from the open score and the flags. */
export const DIRECT_LEVEL: Question = {
  type: 'choice',
  instructions: 'Which effort level fits the work described? Judge how open the problem is; the amount of work never raises the level.',
  criteria: {
    low: 'The way to do it is already given; the work is carrying it out.',
    medium: 'A few possibilities within a small area, or one small trap to watch for.',
    high: 'Several workable designs or several possible causes; a choice has to be made between them.',
    xhigh: 'The cause is unknown and the behavior is intermittent, concurrent or state-dependent, or the change is easy to get subtly wrong.',
    max: 'The cause is unknown or the change is easy to get subtly wrong, and in addition it cannot be reproduced, the operation cannot be undone, or it must be switched over while running.',
  },
}

/** A candidate flag: read as yes, the level is at least high (tried only in scoring, never in the mod). */
export const LONG_UNATTENDED: Question = {
  type: 'noul',
  instructions: 'Does the work hand over a long job to be finished alone, with nobody checking in between?',
  criteria: { true: 'Many files or stages are to be completed in one go, and no checkpoint with the user is asked for.', false: 'The work is a few steps, or the user is following along and will answer questions.' },
}

/** 直接选档位那道题的读法：选中项概率不低于 0.5 取它，否则取概率最高两项里较低的一档。 */
export function readDirect(a: Answer | undefined): Level | null {
  if (a?.type !== 'choice' || !isLevel(a.choice)) return null
  const p = a.probabilities
  if ((p[a.choice] ?? 0) >= 0.5) return a.choice
  // No clear pick: of the two likeliest, the lower level (sort is stable, so a tie keeps the lower one first).
  const top = LEVELS.filter((l) => typeof p[l] === 'number')
    .sort((x, y) => p[y]! - p[x]!)
    .slice(0, 2)
  if (top.length < 2) return a.choice
  return LEVELS.indexOf(top[0]!) < LEVELS.indexOf(top[1]!) ? top[0]! : top[1]!
}
