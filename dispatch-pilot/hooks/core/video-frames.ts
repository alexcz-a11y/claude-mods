// The frames of a recording (#60, ADR 0008), cut with ffmpeg and brought within a decision model's limits like any image. Written
// for every feature that sends a recording to a decision model: it keeps no state of its own and asks for nothing but the closures of
// an `ImageFilesIo` (the same as image-files.ts, which sizes the frames), built where `$` is.

import { errorText } from '../decision/backend.ts'
import type { ImageLimits } from '../decision/image-fit.ts'
import { type Frame, frameArgs, frameTimes, parseDuration, probeArgs, type Span } from '../decision/visual-check-frames.ts'
import { type ImageFilesIo, type LoadedImage, loadImages } from './image-files.ts'

/** ffmpeg gets longer than the 30 seconds `$.process.run` allows a program by default: a long recording takes a while to seek in. */
const RUN = { timeoutMs: 60_000 }

/** The frames of a recording, each with the moment it was cut at; or why not (written for the model, in English). */
export type RecordingFrames = { ok: true; frames: (Frame & { picture: LoadedImage })[] } | { ok: false; reason: string }

/** What an error says, less the engine's `plugin: $.call: ` in front of it. */
const errorMessage = (error: unknown): string => errorText(error).replace(/^[\w.-]+: \$\.[\w.]+: /, '')

/** The last line a program said, for a reason (ffmpeg ends with the one that names the failure). */
const lastLine = (text: string): string => text.trim().split('\n').pop()?.trim().slice(0, 200) ?? ''

/**
 * `count` frames of the recording at `path`, cut evenly through `span` (the whole recording when it names no end) and sized for
 * `limits` the way `loadImages` sizes them, together within `megapixels` if that is given. Nothing throws: where ffmpeg is not
 * there, or cannot read the file, or cuts nothing, the reason says so.
 */
export async function readRecording(io: ImageFilesIo, path: string, span: Span, count: number, limits: ImageLimits, megapixels?: number): Promise<RecordingFrames> {
  let probed: Awaited<ReturnType<ImageFilesIo['run']>>
  try {
    probed = await io.run(probeArgs(path), RUN)
  } catch (error) {
    return { ok: false, reason: `ffmpeg could not be run (${errorMessage(error)}), so ${path} cannot be read: take screenshots of the moments to check and give those instead` }
  }
  const duration = parseDuration(`${probed.stderr}\n${probed.stdout}`)
  if (duration === null) return { ok: false, reason: `ffmpeg could not read ${path}${lastLine(probed.stderr) === '' ? '' : ` (${lastLine(probed.stderr)})`}` }
  const times = frameTimes(duration, span, count)
  if (!times.ok) return { ok: false, reason: `${path}: ${times.reason}` }

  const cut: { file: string; seconds: number }[] = []
  for (const seconds of times.times) {
    const made = await cutFrame(io, path, seconds, span.from)
    if (!made.ok) return { ok: false, reason: made.reason }
    cut.push(made)
  }
  const loaded = await loadImages(io, cut.map((frame) => frame.file), limits, megapixels)
  const frames: RecordingFrames = { ok: true, frames: [] }
  for (const [i, one] of loaded.entries()) {
    if (!one.ok) return { ok: false, reason: `the frame of ${path} at ${(cut[i] as { seconds: number }).seconds} s could not be read: ${one.reason}` }
    frames.frames.push({ picture: one.image, seconds: (cut[i] as { seconds: number }).seconds })
  }
  return frames
}

/** How far back from a moment ffmpeg is asked again when it has no frame there (a recording whose picture stood still at its end). */
const FALLBACKS = [0.25, 1, 4, 16]

/** One frame, cut at `seconds`; where ffmpeg has none there, at a moment shortly before (never before `floor`): the frame says at which it was cut. */
async function cutFrame(io: ImageFilesIo, path: string, seconds: number, floor: number): Promise<{ ok: true; file: string; seconds: number } | { ok: false; reason: string }> {
  let failure = ''
  for (const back of [0, ...FALLBACKS]) {
    const at = Math.round((seconds - back) * 100) / 100
    if (at < floor) break
    try {
      const file = await io.newFile('jpg')
      const run = await io.run(frameArgs(path, at, file), RUN)
      if (run.exitCode === 0) return { ok: true, file, seconds: at }
      failure = `ffmpeg could not cut the frame of ${path} at ${at} s (exit code ${run.exitCode}${lastLine(run.stderr) === '' ? '' : `: ${lastLine(run.stderr)}`})`
    } catch (error) {
      return { ok: false, reason: `ffmpeg could not be run (${errorMessage(error)}), so ${path} cannot be read` }
    }
  }
  return { ok: false, reason: failure }
}
