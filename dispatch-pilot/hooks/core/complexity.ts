// Reading a group of reference images, and keeping the readings (#63, ADR 0008). The one place that gets "the complexity reading of
// these images": the message that starts a turn (features/image-routing.ts) calls it, and so will #64's mid-turn re-decision, the
// dispatched agents and the Workflow agents, none of them knowing how the images are prepared, asked or kept. A group of images
// is read once: the readings are kept in `$.state` (`referenceReadings`) under a hash of the images' content, the latest of them
// is what a request that carries no images of its own (an agent's, a Workflow batch's) takes (`latestReading`).
//
// Pure of `$`: the engine comes in as closures (`ComplexityIo`), as for `BackendIo` and `ImageFilesIo`; a module cannot pass `$`
// across an import, so every caller builds the closures from its own `$`.

import { errorText, failureText, type Asked, type BackendName, type Failure } from '../decision/backend.ts'
import { complexityLimits, complexityRequest, MAX_REFERENCE_IMAGES, readComplexity, referenceKey, type ReferenceReading } from '../decision/complexity.ts'
import { readImageHeader } from '../decision/image-header.ts'
import type { DecisionRequest } from '../decision/system-one.ts'
import { type ImageFilesIo, type Loaded, type LoadedImage, loadImage } from './image-files.ts'
import { type Cell, update } from './plans.ts'

/** A reading as it is kept: the group's key (a hash of the images' content), the reading, and when (`$.clock.now()`, ms) it was asked or last reused. */
export type KeptReading = ReferenceReading & { key: string; at: number }

/** What `$.state` keeps under `referenceReadings`: the latest groups' readings, the one asked or reused last at the end. */
export type ReferenceReadings = KeptReading[]

/** The readings of this many groups are kept: a conversation moves from one reference to the next. */
export const READINGS_KEPT = 8

/**
 * An image to read. `path`: a file (a pasted image's original, a file the agent read). `base64`: the bytes of a PNG or a JPEG the
 * engine handed over without a file (a pasted image's block), written to a file first.
 */
export type ReferenceSource = { path: string } | { base64: string }

/** What a reading needs of the engine. */
export type ComplexityIo = {
  files: ImageFilesIo
  /** One request to the decision model that takes images (`ctx.images.backend`), timed and logged by the caller; it never throws. */
  ask: (request: DecisionRequest) => Promise<Asked>
  /** `$.state` key `referenceReadings`. */
  store: Cell<ReferenceReadings>
  now: () => Promise<number>
  /** The decision model `ask` goes to: it sets the limits the images are brought within. */
  backend: BackendName
  /** A line for the debug log. */
  debug?: (line: string) => void
}

export type ReadingResult =
  /** `cached`: this group had been read; no request was made. */
  | { ok: true; reading: ReferenceReading; key: string; cached: boolean }
  /** `failure`: the request failed (the board says why); absent when no request was made (no image could be read, the answer had no level). */
  | { ok: false; reason: string; failure?: Failure }

/** The reading of the latest group asked or reused; null before any. */
export async function latestReading(store: Pick<Cell<ReferenceReadings>, 'get'>): Promise<ReferenceReading | null> {
  const latest = ((await store.get()).value ?? []).at(-1)
  return latest === undefined ? null : { level: latest.level, images: latest.images }
}

/** The images of `sources` (the first `MAX_REFERENCE_IMAGES`), each brought to about a megapixel and within the model's limits; those that cannot be, with why. */
async function prepare(io: ComplexityIo, sources: readonly ReferenceSource[]): Promise<{ images: LoadedImage[]; reasons: string[] }> {
  const images: LoadedImage[] = []
  const reasons: string[] = []
  for (const source of sources.slice(0, MAX_REFERENCE_IMAGES)) {
    const loaded = await load(io, source)
    if (loaded.ok) images.push(loaded.image)
    else reasons.push(loaded.reason)
  }
  return { images, reasons }
}

async function load(io: ComplexityIo, source: ReferenceSource): Promise<Loaded> {
  try {
    const limits = complexityLimits(io.backend)
    if ('path' in source) return await loadImage(io.files, source.path, limits)
    const header = readImageHeader(source.base64)
    if (header === null) return { ok: false, reason: 'an image the engine handed over is not a PNG or a JPEG' }
    // macOS's base64 decodes its standard input into the file named by -o; the engine's `$.fs.write` writes text only.
    const file = await io.files.newFile(header.format === 'jpeg' ? 'jpg' : 'png')
    const wrote = await io.files.run(['base64', '-D', '-o', file], { stdin: source.base64 })
    if (wrote.exitCode !== 0) return { ok: false, reason: `an image the engine handed over could not be written to a file (exit code ${wrote.exitCode})` }
    return await loadImage(io.files, file, limits)
  } catch (error) {
    return { ok: false, reason: errorText(error) }
  }
}

/**
 * The complexity reading of a group of reference images. The images are prepared first (sips: about a megapixel each, within the
 * model's limits), because a group is recognised by the content it is sent with: one that was read before is answered from the
 * readings kept, without a request; any other is one request to the decision model that takes images. A group of more than six is
 * read by its first six. Never throws: whatever goes wrong is a `reason`.
 */
export async function readReferenceComplexity(io: ComplexityIo, sources: readonly ReferenceSource[]): Promise<ReadingResult> {
  try {
    if (sources.length === 0) return { ok: false, reason: 'no reference image to read' }
    const { images, reasons } = await prepare(io, sources)
    if (images.length === 0) return { ok: false, reason: reasons.join('; ') }
    if (reasons.length > 0) io.debug?.(`reference images left out of the reading: ${reasons.join('; ')}`)
    const key = await referenceKey(images)
    const now = await io.now()

    const kept = (await io.store.get()).value ?? []
    const hit = kept.find((reading) => reading.key === key)
    if (hit !== undefined) {
      await remember(io, { ...hit, at: now })
      return { ok: true, reading: { level: hit.level, images: hit.images }, key, cached: true }
    }

    const { request, part } = complexityRequest(images)
    const asked = await io.ask(request)
    if (!asked.ok) return { ok: false, reason: failureText(io.backend, asked.failure), failure: asked.failure }
    const reading = readComplexity(part, asked.answers, images.length)
    if (reading === null) return { ok: false, reason: `${io.backend}: the answer had no complexity level` }
    await remember(io, { ...reading, key, at: now })
    return { ok: true, reading, key, cached: false }
  } catch (error) {
    return { ok: false, reason: errorText(error) }
  }
}

/** The reading kept as the latest (a store that cannot be written does not lose the reading itself: the next group is asked again). */
async function remember(io: ComplexityIo, reading: KeptReading): Promise<void> {
  try {
    await update(io.store, (list) => [...(list ?? []).filter((other) => other.key !== reading.key), reading].slice(-READINGS_KEPT))
  } catch (error) {
    io.debug?.(`reference reading not kept: ${errorText(error)}`)
  }
}
