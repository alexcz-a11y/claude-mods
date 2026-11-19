// One threshold moved over a grid, the others held, and the stretch that scores best (calibration plan, Task 5;
// amendment A3 gives each threshold its own grid). Pure: no node: module.
import type { Case } from './case.ts'
import { mark, outcomeOf } from './read.ts'
import type { Bars, Mark, Stored } from './read.ts'
import { VARIANTS } from './request.ts'

/** unusable: the cases whose outcome is null at this value (no answer, a failed one, or a second request missing). */
export type Row = { value: number; right: number; unusable: number; marks: Record<string, Mark> }

const LEVEL_BARS = ['up', 'upHigh', 'down', 'yes', 'no', 'modelDown']
const SKILL_BARS = ['action', 'named', 'fits']
const STEP = 0.05
const two = (x: number): number => Math.round(x * 100) / 100

function range(from: number, to: number): number[] {
  const count = Math.round((to - from) / STEP) + 1
  return Array.from({ length: count }, (_, i) => two(from + i * STEP))
}

// 'submit.up' to ['submit', 'up'], or a throw for a path that names no threshold.
function split(path: string): [keyof Bars, string] {
  const [group, key, ...rest] = path.split('.')
  const ok =
    rest.length === 0 &&
    key !== undefined &&
    ((['submit', 'midrun', 'agent'].includes(group!) && LEVEL_BARS.includes(key)) || (group === 'skill' && SKILL_BARS.includes(key)))
  if (!ok) throw new Error(`no threshold at ${path}`)
  return [group as keyof Bars, key]
}

/** The values a threshold is swept over (amendment A3), in steps of 0.05. */
export function gridFor(path: string): readonly number[] {
  const [group, key] = split(path)
  if (group === 'skill') return key === 'named' ? range(0.3, 0.8) : range(0.1, 0.6)
  return key === 'no' ? range(0.05, 0.5) : range(0.5, 0.95)
}

/** Which end of the best stretch to take: the lowest for no (a stricter "no"), the highest for every other. */
export function conservativeFor(path: string): 'high' | 'low' {
  return split(path)[1] === 'no' ? 'low' : 'high'
}

function withBar(base: Bars, path: string, value: number): Bars {
  const [group, key] = split(path)
  return { ...base, [group]: { ...base[group], [key]: value } }
}

/**
 * 只动一个门槛（path 如 'submit.up'、'skill.fits'），其余用 base。stored(id, variant) gives a case's answers to one
 * variant: the category's default (VARIANTS' first entry), and for a skill case also 'stage-2'. A case with no usable
 * outcome at a value has no mark in that row and is counted in its unusable: a gate moved below its start value can
 * let a case through whose second request was never asked, and the rows' right counts are then over different cases.
 */
export function sweep(cases: readonly Case[], stored: (id: string, variant: string) => Stored | undefined, base: Bars, path: string, grid: readonly number[] = gridFor(path)): Row[] {
  split(path)
  return grid.map((value) => {
    const bars = withBar(base, path, value)
    const marks: Record<string, Mark> = {}
    let unusable = 0
    for (const c of cases) {
      const first = stored(c.id, VARIANTS[c.category][0]!.name)
      const o = first === undefined ? null : outcomeOf(c, first, bars, c.category === 'skill' ? { second: stored(c.id, 'stage-2') } : {})
      if (o === null) unusable += 1
      else marks[c.id] = mark(c, o)
    }
    return { value, right: Object.values(marks).filter((m) => m === 'right').length, unusable, marks }
  })
}

/**
 * 对得最多的那一段和取哪一端；conservative 'high' 取最大的值，'low' 取最小的。When the best score is reached in
 * more than one stretch, the stretch at the conservative end is taken.
 */
export function plateau(rows: readonly Row[], conservative: 'high' | 'low'): { best: number; from: number; to: number; pick: number } {
  if (rows.length === 0) throw new Error('no rows to choose from')
  const sorted = [...rows].sort((a, b) => a.value - b.value)
  const best = Math.max(...sorted.map((r) => r.right))
  const stretches: [number, number][] = []
  sorted.forEach((r, i) => {
    if (r.right !== best) return
    const last = stretches.at(-1)
    if (last !== undefined && sorted[i - 1]?.right === best) last[1] = r.value
    else stretches.push([r.value, r.value])
  })
  const [from, to] = conservative === 'high' ? stretches.at(-1)! : stretches[0]!
  return { best, from, to, pick: conservative === 'high' ? to : from }
}
