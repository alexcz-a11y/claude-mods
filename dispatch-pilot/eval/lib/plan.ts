// Which requests a run asks: the variants named on the command line, the repeats, and the held-out set's one pass
// (calibration plan, Task 6; Ruling C3; amendment A5). Pure: no node: module, so the tests import it.
import type { Case, Category } from './case.ts'
import { VARIANTS } from './request.ts'
import type { Variant } from './request.ts'

/** One request a run wants: a case in a variant, the nth time it is asked. */
export type Want = { c: Case; variant: Variant; repeat: number }

const isStageTwo = (v: Variant): boolean => v.stage === 2
/** The first skill request a second one takes its shortlist from: the one of the same pair (plain or shuffled). */
export const stageOneOf = (name: string): string => name.replace('stage-2', 'stage-1')
const pairOf = (name: string): string[] => [stageOneOf(name), name.replace('stage-1', 'stage-2')]

/**
 * The variants of a category that names select. No name: the default (for skill both steps of stage-1/stage-2); 'all':
 * every registered variant; a name the category does not register selects nothing there. A skill step brings the
 * other step of its pair: the second request needs the first, and every first answer is followed by a second.
 */
export function variantsFor(category: Category, names: readonly string[]): Variant[] {
  const all = VARIANTS[category]
  if (names.includes('all')) return [...all]
  let wanted = names.length === 0 ? [all[0]!.name] : [...names]
  if (category === 'skill') wanted = wanted.flatMap((n) => (n.startsWith('stage-') ? pairOf(n) : [n]))
  return all.filter((v) => wanted.includes(v.name))
}

/** The names no category registers (a typo on the command line). */
export function unknownVariants(names: readonly string[]): string[] {
  const known = new Set(Object.values(VARIANTS).flatMap((vs) => vs.map((v) => v.name)))
  return names.filter((n) => n !== 'all' && !known.has(n))
}

/** Every case in each selected variant, repeats 1 to repeat. */
export function wants(cases: readonly Case[], names: readonly string[], repeat: number): Want[] {
  const out: Want[] = []
  for (const c of cases) for (const variant of variantsFor(c.category, names)) for (let r = 1; r <= repeat; r++) out.push({ c, variant, repeat: r })
  return out
}

/** How often the held-out pass asks a variant: the category's default 3 times (skill: stage-1 and stage-2), others once. */
const HELDOUT_REPEATS = 3

/** The held-out set's one pass (Ruling C3): every variant registered before it (afterHeldout off) of every case. */
export function heldoutWants(cases: readonly Case[]): Want[] {
  const out: Want[] = []
  for (const c of cases) {
    const all = VARIANTS[c.category]
    const main = c.category === 'skill' ? ['stage-1', 'stage-2'] : [all[0]!.name]
    for (const variant of all) {
      if (variant.afterHeldout === true) continue
      const times = main.includes(variant.name) ? HELDOUT_REPEATS : 1
      for (let r = 1; r <= times; r++) out.push({ c, variant, repeat: r })
    }
  }
  return out
}

/** Second skill requests last: each is built from the answer to its first. */
export function inOrder(ws: readonly Want[]): { first: Want[]; second: Want[] } {
  return { first: ws.filter((w) => !isStageTwo(w.variant)), second: ws.filter((w) => isStageTwo(w.variant)) }
}

/**
 * The state as sent the nth time (amendment A5): the first time as built; from the second on with a one-time
 * request_uid at the end, so no cache on the way can hand back an earlier answer. uid gives 16 hex characters.
 */
export function sentState(state: Record<string, unknown>, repeat: number, uid: () => string): Record<string, unknown> {
  return repeat <= 1 ? state : { ...state, request_uid: uid() }
}
