// The visual-check dataset's items (#65): what an item is, and the rules lib/datasets.ts checks it against. The items are the
// ones of the experiment of 2026-10-15 (.scratch/visual-judge-experiment-2026-10-15/), their pictures and truths copied into
// eval/datasets/visual-check/: a reference screen and nine candidates, a reference sea and seven candidates, five motions of a card
// in twelve frames each, three groups of reference images to read the complexity of. No picture was made for the eval.
//
// An item has no `zh` and `en` side as the other kinds do: what the decision model reads is English whatever the person writes (the
// mod's own words for it, hooks/decision/visual-check.ts), so there is one version of each question. The files an item names are
// under eval/datasets/visual-check/, by their path there; that they exist is for eval/validate.ts, which can read them.
//
// Pure: no Node API.

/** The four groups of the dataset: a screen against its design, a render of the sea against its reference, the frames of a motion, a group of references to rate. */
export const VISUAL_CHECK_KINDS = ['ui', 'sea', 'anim', 'complexity'] as const
export type VisualCheckKind = (typeof VISUAL_CHECK_KINDS)[number]

/** What the mod's `Check` is, as the dataset writes it: a part of the image and one visible property of it (or a requirement it must meet). */
export type CheckAsked = { part: string; property: string }

/** A screenshot (`ui`) or a render (`sea`) and the reference it is compared with, in the same view (`same_view` null: by the images' shapes, as the mod infers it). */
export type ComparedAsked = { screenshot: string; reference: string[]; same_view: boolean | null; checks: CheckAsked[] }
/** The frames of a motion, in order of time, and the specification the checks are read against (a recording is judged on its frames alone). */
export type AnimAsked = { frames: { file: string; seconds: number }[]; spec: string; checks: CheckAsked[] }
/** A group of reference images to read the complexity of. */
export type ComplexityAsked = { references: string[] }

/** For each check, whether it holds: the part is the same as in the reference, or the frames meet the requirement. */
export type CheckGold = { holds: boolean[] }
/** The level a group reads as (0 trivial to 4 very complex), the levels that are acceptable, and its place in the order of the groups, lowest first. */
export type ComplexityGold = { level: number; accept: number[]; rank: number }

type Base = { id: string; rationale: string; difficulty: 'hard' | 'medium'; tags: string[] }
export type ComparedItem = Base & { kind: 'ui' | 'sea'; asked: ComparedAsked; gold: CheckGold }
export type AnimItem = Base & { kind: 'anim'; asked: AnimAsked; gold: CheckGold }
export type ComplexityItem = Base & { kind: 'complexity'; asked: ComplexityAsked; gold: ComplexityGold }
export type VisualCheckItem = ComparedItem | AnimItem | ComplexityItem

/** The most reference images one group is read from (the mod's MAX_REFERENCE_IMAGES, hooks/decision/complexity.ts). */
const MOST_REFERENCES = 6
/** The tag of an item in which nothing differs and nothing is violated: every check holds. */
export const CONTROL = 'control'

import { adjacent, exactKeys, isRecord, nonEmpty, type Add } from './validators.ts'

/** Top-level fields of an item. */
export const VISUAL_CHECK_FIELDS = ['id', 'kind', 'asked', 'gold', 'rationale', 'difficulty', 'tags'] as const

/** A picture's path in the dataset: relative to eval/datasets/visual-check/, inside it, a PNG. */
function checkPath(value: unknown, at: string, add: Add): void {
  if (!nonEmpty(value)) return add(`${at} must be a path`)
  if (value.startsWith('/') || value.split('/').includes('..')) add(`${at} ${JSON.stringify(value)} must be a path inside eval/datasets/visual-check/, relative to it`)
  else if (!/\.png$/.test(value)) add(`${at} ${JSON.stringify(value)} must be a PNG`)
}

function checkChecks(value: unknown, add: Add): void {
  if (!Array.isArray(value) || value.length === 0) return add('asked.checks must be a non-empty array of { part, property }')
  value.forEach((check, i) => {
    const at = `asked.checks[${i}]`
    if (!isRecord(check)) return add(`${at} must be an object`)
    exactKeys(check, ['part', 'property'], at, add)
    for (const key of ['part', 'property'] as const) if (!nonEmpty(check[key])) add(`${at}.${key} must be a non-empty string`)
  })
}

/** An item of a kind: its asked and gold in the shape of the kind, and the tag `control` exactly when every check holds. */
export function checkVisualCheck(item: Record<string, unknown>, add: Add): void {
  const kind = item.kind
  if (!(VISUAL_CHECK_KINDS as readonly unknown[]).includes(kind)) return add(`kind ${JSON.stringify(kind)} is not one of ${VISUAL_CHECK_KINDS.join(', ')}`)
  const asked = item.asked
  if (!isRecord(asked)) return add('asked must be an object')
  if (kind === 'complexity') return checkComplexity(item, asked, add)
  if (kind === 'anim') {
    exactKeys(asked, ['frames', 'spec', 'checks'], 'asked', add)
    checkFrames(asked.frames, add)
    if (!nonEmpty(asked.spec)) add('asked.spec must be the specification the checks are read against (a non-empty string)')
  } else {
    exactKeys(asked, ['screenshot', 'reference', 'same_view', 'checks'], 'asked', add)
    checkPath(asked.screenshot, 'asked.screenshot', add)
    if (!Array.isArray(asked.reference) || asked.reference.length === 0) add('asked.reference must be a non-empty array of reference images')
    else asked.reference.forEach((path, i) => checkPath(path, `asked.reference[${i}]`, add))
    if (asked.same_view !== null && typeof asked.same_view !== 'boolean') add('asked.same_view must be true, false or null (by the images\' shapes)')
  }
  checkChecks(asked.checks, add)
  checkHolds(item, asked, add)
}

function checkFrames(frames: unknown, add: Add): void {
  if (!Array.isArray(frames) || frames.length < 2) return add('asked.frames must be at least two frames: { file, seconds }')
  let before = -Infinity
  frames.forEach((frame, i) => {
    const at = `asked.frames[${i}]`
    if (!isRecord(frame)) return add(`${at} must be an object { file, seconds }`)
    exactKeys(frame, ['file', 'seconds'], at, add)
    checkPath(frame.file, `${at}.file`, add)
    const seconds = frame.seconds
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return add(`${at}.seconds must be a number of seconds, 0 or more`)
    if (seconds <= before) add(`${at}.seconds ${seconds} is not after the frame before it: the frames are in order of time`)
    before = seconds
  })
}

/** `gold.holds`: one answer for each check; and the control tag exactly where every check holds (an item in which nothing differs has no difference to find). */
function checkHolds(item: Record<string, unknown>, asked: Record<string, unknown>, add: Add): void {
  const gold = item.gold
  if (!isRecord(gold)) return add('gold must be { holds: [...] }, one answer for each check')
  exactKeys(gold, ['holds'], 'gold', add)
  const holds = gold.holds
  if (!Array.isArray(holds) || !holds.every((one) => typeof one === 'boolean')) return add('gold.holds must be an array of true or false, one for each check')
  const checks = Array.isArray(asked.checks) ? asked.checks.length : 0
  if (checks > 0 && holds.length !== checks) return add(`gold.holds has ${holds.length} answers for ${checks} checks`)
  const control = Array.isArray(item.tags) && item.tags.includes(CONTROL)
  const all = holds.every((one) => one === true)
  if (control && !all) add(`tagged ${CONTROL}, but not every check holds: a control is an item in which nothing differs`)
  else if (!control && all) add(`nothing differs (every check holds), so the item is a ${CONTROL}: tag it ${CONTROL}`)
}

function checkComplexity(item: Record<string, unknown>, asked: Record<string, unknown>, add: Add): void {
  exactKeys(asked, ['references'], 'asked', add)
  const references = asked.references
  if (!Array.isArray(references) || references.length === 0) add('asked.references must be a non-empty array of reference images')
  else {
    if (references.length > MOST_REFERENCES) add(`asked.references has ${references.length} images: a group is at most ${MOST_REFERENCES} (the mod reads the first ${MOST_REFERENCES})`)
    references.forEach((path, i) => checkPath(path, `asked.references[${i}]`, add))
  }
  const gold = item.gold
  if (!isRecord(gold)) return add('gold must be { level, accept, rank }')
  exactKeys(gold, ['level', 'accept', 'rank'], 'gold', add)
  const level = gold.level
  const whole = (value: unknown, least: number, most: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= least && value <= most
  if (!whole(level, 0, 4)) add(`gold.level ${JSON.stringify(level)} is not a level, 0 (trivial) to 4 (very complex)`)
  const accept = gold.accept
  if (!Array.isArray(accept) || accept.length === 0 || !accept.every((one) => whole(one, 0, 4))) add('gold.accept must be a non-empty array of levels, 0 to 4')
  else {
    if (new Set(accept).size !== accept.length) add(`gold.accept ${JSON.stringify(accept)} names a level twice`)
    if (whole(level, 0, 4) && !accept.includes(level)) add(`gold.level ${level} is not in gold.accept ${JSON.stringify(accept)}`)
    if (!adjacent(accept as number[])) add(`gold.accept ${JSON.stringify(accept)} is not contiguous: acceptable levels must be adjacent`)
  }
  if (!whole(gold.rank, 0, Number.MAX_SAFE_INTEGER)) add(`gold.rank ${JSON.stringify(gold.rank)} must be a whole number: the group's place in the order, the least complex first`)
}

/** The pictures an item names, in the order it names them (for eval/validate.ts, which checks that they are there). */
export function picturesOf(item: VisualCheckItem): string[] {
  switch (item.kind) {
    case 'complexity':
      return [...item.asked.references]
    case 'anim':
      return item.asked.frames.map((frame) => frame.file)
    default:
      return [item.asked.screenshot, ...item.asked.reference]
  }
}

/** The dataset-wide shares the drafting asked for (warnings): a control among the kinds that compare images, and no two groups of one rank. */
export function visualCheckQuotas(items: readonly Record<string, unknown>[]): string[] {
  const warnings: string[] = []
  for (const kind of ['ui', 'sea'] as const) {
    const own = items.filter((item) => item.kind === kind)
    if (own.length > 0 && !own.some((item) => Array.isArray(item.tags) && item.tags.includes(CONTROL))) warnings.push(`no control item among the ${kind} items; the drafting asked for one: a candidate that is the reference again`)
  }
  const ranks = items.flatMap((item) => (item.kind === 'complexity' && isRecord(item.gold) && typeof item.gold.rank === 'number' ? [item.gold.rank] : []))
  if (new Set(ranks).size !== ranks.length) warnings.push('complexity items share a rank; the order of the groups is what the suite checks')
  return warnings
}
