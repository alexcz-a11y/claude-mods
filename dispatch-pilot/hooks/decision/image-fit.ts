// How an image must be sized for a decision model (#57, ADR 0008): the limits of each, and the size a given image is brought to.
// Jev takes no image outside its limits ("never resized to fit"), and pplx hangs for a minute on one over its tile count, so the
// mod sizes every image itself (core/image-files.ts does it with sips; the eval does it the same way in Node). Pure (see system-one.ts).

import type { BackendName } from './backend.ts'

/** What a decision model takes of an image's pixels. A bound left out is none. */
export type ImageLimits = {
  /** The shortest and the longest side. */
  minSide?: number
  maxSide?: number
  /** The width times the height. */
  minPixels?: number
  maxPixels?: number
  /** The most 32 by 32 tiles the image covers (pplx: more hangs the request for a minute and ends in a 504). */
  maxTiles?: number
}

/** Jev: each side 256 to 1568 pixels, 78,400 to 2,458,624 pixels in all; both ends are in (docs.typesafe.ai/images). */
export const JEV_IMAGE_LIMITS: ImageLimits = { minSide: 256, maxSide: 1568, minPixels: 78_400, maxPixels: 2_458_624 }

/** pplx: at most 2,048 tiles of 32 by 32 pixels (docs.perplexity.ai/docs/decisions). */
export const PPLX_IMAGE_LIMITS: ImageLimits = { maxTiles: 2048 }

/** What the agent is handed back to look at (`look: true`, an image that is unsure): not larger than it reads well; a small one stays small. */
export const LOOK_IMAGE_LIMITS: ImageLimits = { maxSide: 1568 }

/** The limits of the decision model that takes images. */
export function limitsFor(backend: BackendName): ImageLimits {
  return backend === 'jev' ? JEV_IMAGE_LIMITS : PPLX_IMAGE_LIMITS
}

/** How many 32 by 32 tiles an image covers. */
export const tiles = (width: number, height: number): number => Math.ceil(width / 32) * Math.ceil(height / 32)

/**
 * The size an image of `width` by `height` is brought to for `limits`: as it is when it fits; else scaled, keeping its shape, by
 * the least that fits (down from too large, up from too small). Fails for a shape no scale fits (a strip: Jev takes 256 pixels
 * at the least on the short side and 1568 at the most on the long one).
 */
export function planSize(width: number, height: number, limits: ImageLimits): { ok: true; width: number; height: number } | { ok: false; reason: string } {
  if (fits(width, height, limits)) return { ok: true, width, height }
  const longest = Math.max(width, height)
  const shortest = Math.min(width, height)
  const smallest = Math.max((limits.minSide ?? 0) / shortest, Math.sqrt((limits.minPixels ?? 0) / (width * height)))
  const largest = Math.min((limits.maxSide ?? Infinity) / longest, Math.sqrt((limits.maxPixels ?? Infinity) / (width * height)), Math.sqrt(((limits.maxTiles ?? Infinity) * 32 * 32) / (width * height)))
  if (smallest > largest) return { ok: false, reason: `its shape (${width}x${height}) cannot be brought within the decision model's limits` }
  // The scale nearest to 1 that is allowed; sizes are rounded, and a rounding that leaves the limits is nudged back.
  let scale = Math.min(Math.max(1, smallest), largest)
  for (let attempt = 0; attempt < 400; attempt++) {
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    if (fits(w, h, limits)) return { ok: true, width: w, height: h }
    scale *= tooLarge(w, h, limits) ? 0.998 : 1.002
  }
  return { ok: false, reason: `it cannot be brought within the decision model's limits (${width}x${height})` }
}

/**
 * The sips options that turn the pixels of a JPEG upright for its EXIF orientation (2 to 8; 1 needs none), the same picture as a
 * viewer that applies the tag shows. Measured with sips on a picture of eight distinct pixels, against Pillow's `exif_transpose`.
 */
export function uprightArgs(orientation: number): string[] {
  switch (orientation) {
    case 2:
      return ['-f', 'horizontal']
    case 3:
      return ['-r', '180']
    case 4:
      return ['-f', 'vertical']
    case 5:
      return ['-r', '270', '-f', 'horizontal']
    case 6:
      return ['-r', '90']
    case 7:
      return ['-r', '90', '-f', 'horizontal']
    case 8:
      return ['-r', '270']
    default:
      return []
  }
}

/** Whether turning an image upright for this EXIF orientation changes the places of its width and its height. */
export const turnsSides = (orientation: number): boolean => orientation >= 5 && orientation <= 8

/** Whether an image of this size is over a limit from above (not below one). */
function tooLarge(width: number, height: number, limits: ImageLimits): boolean {
  return Math.max(width, height) > (limits.maxSide ?? Infinity) || width * height > (limits.maxPixels ?? Infinity) || tiles(width, height) > (limits.maxTiles ?? Infinity)
}

/** Whether an image of this size is within `limits`. */
export function fits(width: number, height: number, limits: ImageLimits): boolean {
  const pixels = width * height
  return (
    Math.min(width, height) >= (limits.minSide ?? 0) &&
    Math.max(width, height) <= (limits.maxSide ?? Infinity) &&
    pixels >= (limits.minPixels ?? 0) &&
    pixels <= (limits.maxPixels ?? Infinity) &&
    tiles(width, height) <= (limits.maxTiles ?? Infinity)
  )
}
