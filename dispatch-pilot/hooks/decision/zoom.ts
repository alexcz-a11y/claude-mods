// The geometry of the zoomed re-check (#59, ADR 0008): where a Box answer lies in an image, the piece of the image to cut out
// around it, and the sips arguments that cut it out and enlarge it. The numbers are the ones of the experiment that found the
// re-check worth doing (a margin of 15% around the box, at least 160 pixels, at most 3.5 to 1, enlarged to about 1000 pixels on the
// long side). The eval's visual-check suite (#65) crops with the same functions, so this is pure (see system-one.ts).

import type { BoxAnswer } from './system-one.ts'

/** A box in an image, each edge as a share of the image's height or width from the top left (a Box answer's). */
export type Box = BoxAnswer['box']

/** The size of an image in pixels. */
export type Size = { width: number; height: number }

/** A piece of an image in pixels: the top left corner and the size. */
export type Rect = { x: number; y: number; width: number; height: number }

/** The margin around a box, as a share of the box's own size on each side. */
const MARGIN = 0.15
/** A crop is at least this many pixels on each side: a smaller piece is not enough to see the context of a part. */
const MIN_CROP = 160
/** A crop is at most this many times longer than wide (or wider than long). */
const MAX_ASPECT = 3.5
/** A crop is enlarged until its longer side is this long (Jev takes 256 to 1568 on each side). */
export const ENLARGE_TO = 1000

/** The share of the screen above which a box is too large to be "another place" (ADR 0008: at most a quarter of the picture). */
export const ELSEWHERE_MAX_AREA = 0.25
/** The confidence from which the box of "where do they differ" is taken to be a place that differs (below it the model is unsure, not sure of a match). */
export const ELSEWHERE_MIN_CONFIDENCE = 0.2

/** How far the aspect ratios of two images may be apart (as a share) for them to be taken for the same view of the same thing. */
const SAME_SHAPE = 0.02

/** The least a box must be wide and high (as a share of the image) to be one: below it the model has boxed nothing. */
const LEAST_EXTENT = 0.002

/**
 * A Box answer's edges put in order and inside the image; null for a box that is not one (an edge that is not a number, or no
 * extent at all).
 */
export function normalizeBox(box: Box): Box | null {
  const edges = [box.top, box.bottom, box.left, box.right]
  if (!edges.every((edge) => Number.isFinite(edge))) return null
  const clamp = (edge: number): number => Math.min(1, Math.max(0, edge))
  const [top, bottom] = [clamp(Math.min(box.top, box.bottom)), clamp(Math.max(box.top, box.bottom))]
  const [left, right] = [clamp(Math.min(box.left, box.right)), clamp(Math.max(box.left, box.right))]
  return bottom - top < LEAST_EXTENT || right - left < LEAST_EXTENT ? null : { top, bottom, left, right }
}

/** The smallest box that holds both. */
export function unionBox(a: Box, b: Box): Box {
  return { top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom), left: Math.min(a.left, b.left), right: Math.max(a.right, b.right) }
}

/** The share of the image a box covers. */
export const boxArea = (box: Box): number => (box.right - box.left) * (box.bottom - box.top)

/** The share of `inner` that lies within `outer` (0 to 1). */
export function coverage(inner: Box, outer: Box): number {
  const width = Math.max(0, Math.min(inner.right, outer.right) - Math.max(inner.left, outer.left))
  const height = Math.max(0, Math.min(inner.bottom, outer.bottom) - Math.max(inner.top, outer.top))
  return boxArea(inner) === 0 ? 0 : (width * height) / boxArea(inner)
}

/**
 * The piece of an image of `size` to cut out for `box`: the box with a margin of 15% on each side, at least 160 pixels each way,
 * not more than 3.5 to 1 (the short side is made longer), moved to lie within the image (and made smaller where the image itself
 * is smaller, or so narrow that its shape would not allow the ratio).
 */
export function cropRect(box: Box, size: Size): Rect {
  const x0 = box.left * size.width
  const x1 = box.right * size.width
  const y0 = box.top * size.height
  const y1 = box.bottom * size.height
  let width = Math.max(MIN_CROP, (x1 - x0) * (1 + 2 * MARGIN))
  let height = Math.max(MIN_CROP, (y1 - y0) * (1 + 2 * MARGIN))
  if (width / height > MAX_ASPECT) height = width / MAX_ASPECT
  else if (height / width > MAX_ASPECT) width = height / MAX_ASPECT
  width = Math.min(size.width, width)
  height = Math.min(size.height, height)
  // The image itself may be too small or too narrow for the ratio: the piece is then made smaller, never more than 3.5 to 1.
  if (width / height > MAX_ASPECT) width = height * MAX_ASPECT
  else if (height / width > MAX_ASPECT) height = width * MAX_ASPECT
  width = Math.max(1, Math.round(width))
  height = Math.max(1, Math.round(height))
  // Rounding must not tip the ratio over 3.5 to 1.
  if (width > height * MAX_ASPECT) {
    if (Math.ceil(width / MAX_ASPECT) <= size.height) height = Math.ceil(width / MAX_ASPECT)
    else width = Math.floor(height * MAX_ASPECT)
  } else if (height > width * MAX_ASPECT) {
    if (Math.ceil(height / MAX_ASPECT) <= size.width) width = Math.ceil(height / MAX_ASPECT)
    else height = Math.floor(width * MAX_ASPECT)
  }
  const x = Math.round((x0 + x1) / 2 - width / 2)
  const y = Math.round((y0 + y1) / 2 - height / 2)
  return { x: Math.min(Math.max(0, x), size.width - width), y: Math.min(Math.max(0, y), size.height - height), width, height }
}

/** The same piece of another image, by proportion: the rect of an image of size `from`, in an image of size `to`. */
export function scaleRect(rect: Rect, from: Size, to: Size): Rect {
  const width = Math.min(to.width, Math.max(1, Math.round((rect.width * to.width) / from.width)))
  const height = Math.min(to.height, Math.max(1, Math.round((rect.height * to.height) / from.height)))
  const x = Math.round((rect.x * to.width) / from.width)
  const y = Math.round((rect.y * to.height) / from.height)
  return { x: Math.min(Math.max(0, x), to.width - width), y: Math.min(Math.max(0, y), to.height - height), width, height }
}

/** The size a piece has once it is enlarged until its longer side is `longSide` (as `sips -Z` does, to the nearest pixel). */
export function enlargedSize(rect: Size, longSide: number = ENLARGE_TO): Size {
  const longest = Math.max(rect.width, rect.height)
  return { width: Math.max(1, Math.round((rect.width * longSide) / longest)), height: Math.max(1, Math.round((rect.height * longSide) / longest)) }
}

/**
 * The sips arguments that cut `rect` out of `source` into `out`. A crop and an enlargement cannot go in one call (measured with
 * sips on macOS 26: given together, `-Z` is applied before `-c`), so they are two: `sipsEnlargeArgs` after this one.
 */
export function sipsCropArgs(source: string, rect: Rect, out: string): string[] {
  return ['sips', '-c', String(rect.height), String(rect.width), '--cropOffset', String(rect.y), String(rect.x), source, '--out', out]
}

/** The sips arguments that make the longer side of `file` `longSide` pixels, the file itself being replaced. */
export function sipsEnlargeArgs(file: string, longSide: number = ENLARGE_TO): string[] {
  return ['sips', '-Z', String(longSide), file, '--out', file]
}

/**
 * Whether two images show the same view: `said` when the agent said (`same_view`), else whether their aspect ratios are the
 * same (to 2%): a screenshot and its design are alike in shape, a render and a photo of the real thing are not.
 */
export function sameView(said: boolean | null, a: Size, b: Size): boolean {
  if (said !== null) return said
  const [ratioA, ratioB] = [a.width / a.height, b.width / b.height]
  return Math.abs(ratioA - ratioB) / ratioA <= SAME_SHAPE
}
