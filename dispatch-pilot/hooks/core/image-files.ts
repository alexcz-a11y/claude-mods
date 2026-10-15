// Image files for the features that send images to a decision model (#57, ADR 0008): finding an image's size and format with
// sips, bringing it within a model's limits, reading it as bytes. Written for every feature that needs images (visual_check, the
// zoomed re-check, the frames of a recording, the complexity reading), so it keeps no state of its own and asks for nothing but
// the closures of an `ImageFilesIo`: like BackendIo, they are built where `$` is (a module cannot pass `$` across imports).

import { fits, type ImageLimits, planSize, turnsSides, uprightArgs } from '../decision/image-fit.ts'
import { readImageHeader } from '../decision/image-header.ts'
import type { Picture } from '../decision/images.ts'

/** What a program run gives back (`$.process.run`). */
export type ProcessOutput = { exitCode: number; stdout: string; stderr: string }

/** What a program may be run with besides its arguments (`$.process.run`'s `init`; the 30 second default of a run is long enough for sips, not for ffmpeg). */
export type ProcessInit = { stdin?: string; timeoutMs?: number }

/**
 * What the image functions need of the engine. All reject when the engine cannot do it (`run` outside the CLI, `readBytes` for a
 * file that is missing or over 4 MiB).
 */
export type ImageFilesIo = {
  /** `$.process.run(argv, init)`: a program by its argument vector, no shell. */
  run(argv: readonly string[], init?: ProcessInit): Promise<ProcessOutput>
  /** `$.fs.read(path, { as: 'bytes' })`: the file's bytes as base64. */
  readBytes(path: string): Promise<string>
  /** The path of a new file for a derived image, in the session's temporary directory (which exists by then). */
  newFile(extension: string): Promise<string>
}

/**
 * An image ready to send, and what was done to it on the way. `path` is the file it came from; `file` is the one whose bytes
 * `base64` holds, at the size `width` by `height` and upright (`path` itself when nothing had to be done to it), for what is
 * done to the image further (the zoomed re-check crops from it).
 */
export type LoadedImage = Picture & { path: string; file: string; steps: readonly string[] }

/** An image loaded, or why it could not be (written for the model, in English). */
export type Loaded = { ok: true; image: LoadedImage } | { ok: false; reason: string }

/** What sips says of an image. */
export type ImageInfo = { width: number; height: number; format: string }

/** A path as an argument of a program: one that starts with a dash is not taken for an option (the path is the model's). */
const asArgument = (path: string): string => (path.startsWith('-') ? `./${path}` : path)

/** The size and format of an image file, or why sips could not read it. */
async function inspect(io: ImageFilesIo, path: string): Promise<{ ok: true; info: ImageInfo } | { ok: false; reason: string }> {
  const { stdout } = await io.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', asArgument(path)])
  const width = Number(/pixelWidth: (\d+)/.exec(stdout)?.[1])
  const height = Number(/pixelHeight: (\d+)/.exec(stdout)?.[1])
  const format = /format: (\S+)/.exec(stdout)?.[1]
  if (!(width > 0) || !(height > 0) || format === undefined) return { ok: false, reason: `${path} is not an image sips can read (is the path right?)` }
  return { ok: true, info: { width, height, format } }
}

/** The format an image is sent in when it is not a PNG or a JPEG already: photographic formats become JPEG, the rest PNG. */
function formatFor(format: string): 'png' | 'jpeg' {
  return format === 'png' || format === 'jpeg' ? format : /^(heic|heif|jp2|dng|raw)$/.test(format) ? 'jpeg' : 'png'
}

/** The first line of what a program said, for a reason. */
const firstLine = (text: string): string => text.trim().split('\n')[0]?.slice(0, 200) ?? ''

/** A way to bring the file to what the request sends: in this format, at this share of the size the limits allow. */
type Attempt = { format: 'png' | 'jpeg'; share: number }

/**
 * The file at `path` as an image within `limits`, read as bytes. An image that fits and is a PNG or a JPEG is read as it is;
 * any other is made by sips into a new file (scaled to fit, converted). The engine reads at most 4 MiB: when a read is refused,
 * the image is made smaller: first as a JPEG, then at three quarters and then at half the size. `share`: the share of its size to
 * bring it to, within the limits (1 for the whole size).
 */
export async function loadImage(io: ImageFilesIo, path: string, limits: ImageLimits, share = 1): Promise<Loaded> {
  let inspected: Awaited<ReturnType<typeof inspect>>
  try {
    inspected = await inspect(io, path)
  } catch (error) {
    return loadWithoutSips(io, path, limits, errorMessage(error))
  }
  if (!inspected.ok) return inspected
  const { width, height, format } = inspected.info
  const wanted = formatFor(format)
  const attempts: Attempt[] = ([
    { format: wanted, share },
    { format: 'jpeg', share },
    { format: 'jpeg', share: share * 0.75 },
    { format: 'jpeg', share: share * 0.5 },
  ] as Attempt[]).filter((attempt, i, all) => all.findIndex((other) => other.format === attempt.format && other.share === attempt.share) === i)
  let refused = ''
  for (const attempt of attempts) {
    // A share is of the size the limits allow the image (#60: an image over a limit, as a frame of a recording is, would otherwise
    // come to more than its share of a budget), and a share can still be too small for the limits: it is then the smallest that fits.
    const whole = planSize(width, height, limits)
    if (!whole.ok) return { ok: false, reason: `${path}: ${whole.reason}` }
    const size = attempt.share === 1 ? whole : planSize(Math.round(whole.width * attempt.share), Math.round(whole.height * attempt.share), limits)
    if (!size.ok) return { ok: false, reason: `${path}: ${size.reason}` }
    const steps: string[] = []
    let file = path
    if (size.width !== width || size.height !== height || attempt.format !== format) {
      file = await io.newFile(attempt.format === 'jpeg' ? 'jpg' : 'png')
      const resize = size.width !== width || size.height !== height
      const run = await io.run(['sips', ...(resize ? ['-z', String(size.height), String(size.width)] : []), ...(attempt.format !== format ? ['-s', 'format', attempt.format] : []), ...(attempt.format === 'jpeg' && attempt.format !== format ? ['-s', 'formatOptions', '85'] : []), asArgument(path), '--out', file])
      if (run.exitCode !== 0) return { ok: false, reason: `sips could not prepare ${path} (exit code ${run.exitCode}: ${firstLine(run.stderr) || firstLine(run.stdout) || 'no message'})` }
      if (resize) steps.push(`scaled ${width}x${height} to ${size.width}x${size.height}`)
      if (attempt.format !== format) steps.push(`converted ${format} to ${attempt.format}`)
    }
    try {
      let base64 = await io.readBytes(file)
      let [wide, high] = [size.width, size.height]
      let readFrom = file
      // Jev does not apply a JPEG's EXIF orientation, and sips cannot tell it: the tag is read out of the bytes, and the pixels turned.
      const orientation = attempt.format === 'jpeg' ? (readImageHeader(base64)?.orientation ?? 1) : 1
      if (orientation > 1) {
        const upright = await io.newFile('jpg')
        const turned = await io.run(['sips', ...uprightArgs(orientation), asArgument(file), '--out', upright])
        if (turned.exitCode !== 0) return { ok: false, reason: `sips could not turn ${path} upright (exit code ${turned.exitCode}: ${firstLine(turned.stderr) || firstLine(turned.stdout) || 'no message'})` }
        base64 = await io.readBytes(upright)
        readFrom = upright
        if (turnsSides(orientation)) [wide, high] = [high, wide]
        steps.push(`turned upright (EXIF orientation ${orientation})`)
      }
      return { ok: true, image: { path, file: readFrom, format: attempt.format, base64, width: wide, height: high, steps } }
    } catch (error) {
      refused = errorMessage(error)
    }
  }
  return { ok: false, reason: `${path} could not be read: ${refused}` }
}

/**
 * Several images for one request, each as `loadImage` loads it, in the order of `paths`. With a budget of `megapixels` in all
 * (`imageMegapixelBudget`): when the images come to more, they are all loaded again at the one share that brings them to it.
 * A request's images cost tokens by their pixels; a budget cannot go below the smallest size the limits allow.
 */
export async function loadImages(io: ImageFilesIo, paths: readonly string[], limits: ImageLimits, megapixels?: number): Promise<Loaded[]> {
  const loaded: Loaded[] = []
  for (const path of paths) loaded.push(await loadImage(io, path, limits))
  if (megapixels === undefined) return loaded
  const pixels = loaded.reduce((sum, one) => sum + (one.ok ? one.image.width * one.image.height : 0), 0) / 1_000_000
  if (pixels <= megapixels || loaded.some((one) => !one.ok)) return loaded
  // A little under, so that the rounding of each side does not leave the total over the budget.
  const share = Math.sqrt(megapixels / pixels) * 0.98
  const smaller: Loaded[] = []
  for (const path of paths) smaller.push(await loadImage(io, path, limits, share))
  return smaller
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Where sips cannot run (outside the CLI): a PNG or a JPEG that already fits, and is upright, is read as it is, its size from its
 * own header; any other cannot be sized or converted, and the reason says so. `why`: what the engine said of running sips.
 */
async function loadWithoutSips(io: ImageFilesIo, path: string, limits: ImageLimits, why: string): Promise<Loaded> {
  let base64: string
  try {
    base64 = await io.readBytes(path)
  } catch (error) {
    return { ok: false, reason: `${path} could not be read: ${errorMessage(error)}` }
  }
  const header = readImageHeader(base64)
  if (header === null) return { ok: false, reason: `${path} is not a PNG or a JPEG, and sips could not run to convert it (${why})` }
  if (!fits(header.width, header.height, limits)) return { ok: false, reason: `${path} is ${header.width}x${header.height}, which the decision model does not take, and sips could not run to resize it (${why})` }
  if (header.orientation > 1) return { ok: false, reason: `${path} lies on its side by its EXIF orientation, which the decision model does not apply, and sips could not run to turn it upright (${why})` }
  return { ok: true, image: { path, file: path, format: header.format, base64, width: header.width, height: header.height, steps: ['read without sips'] } }
}
