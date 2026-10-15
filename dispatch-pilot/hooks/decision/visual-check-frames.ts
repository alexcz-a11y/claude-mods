// A recording as visual_check reads it (#60, ADR 0008): which paths are recordings, which moments of one become frames, how ffmpeg
// is asked for them, and the request that holds the frames. The eval's visual-check suite (#65) frames and asks the very same way,
// so this is pure (see system-one.ts): no `$`, no files; core/video-frames.ts runs ffmpeg with it.

import { imageRef, type Picture } from './images.ts'
import { mergeParts, type DecisionRequest, type Part, type Question, type RequestImage } from './system-one.ts'
import { CHECK_PART, type Check } from './visual-check.ts'

/** A path that is a recording, by its extension (a GIF is an image sips reads). */
const RECORDING = /\.(mov|mp4|m4v|webm|mkv|avi|mpe?g|ogv|3gp|flv|wmv)$/i

export const isRecording = (path: string): boolean => RECORDING.test(path)

/**
 * How many frames a recording is read into (ADR 0008): Jev takes 12 in a request with room to spare, pplx 8 at the most. Frames are
 * sent as they are, one after the other, not laid out on a contact sheet, which neither model reads motion from.
 */
export const FRAME_COUNT = { jev: 12, pplx: 8 } as const

/** How many frames `look: true` hands back from a recording. */
export const LOOK_FRAME_COUNT = 8

/** The part of a recording to read, in seconds: from `from`, to `to` (the end of the recording when null). */
export type Span = { from: number; to: number | null }

/** The whole recording. */
export const WHOLE_RECORDING: Span = { from: 0, to: null }

/** A recording's length, from what `ffmpeg -i file` says on stderr (`  Duration: 00:00:03.50, start: ...`); null where it says none. */
export function parseDuration(text: string): number | null {
  const found = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text)
  if (found === null) return null
  return Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3])
}

/** A path as ffmpeg's input: one that is not absolute starts with `./`, so that it is never taken for an option or a protocol (`http:`, `concat:`). */
const asInput = (path: string): string => (path.startsWith('/') ? path : `./${path}`)

/** The arguments that make ffmpeg report what it knows of a recording and stop (it ends with exit code 1 for want of an output; the report is on stderr). */
export const probeArgs = (path: string): string[] => ['ffmpeg', '-hide_banner', '-i', asInput(path)]

/** The arguments that write the frame at `seconds` of a recording to `out` as a JPEG (fast seek to the time, then decode just that frame). */
export const frameArgs = (path: string, seconds: number, out: string): string[] => ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-ss', seconds.toFixed(3), '-i', asInput(path), '-frames:v', '1', '-q:v', '2', out]

/** The picture of the last frame is never quite at the end of a recording: a frame is asked for this far (seconds) before it. */
const BEFORE_THE_END = 0.1

const round = (seconds: number): number => Math.round(seconds * 100) / 100

/**
 * The moments to cut `count` frames at: evenly from the start of the span to its end, both in. A recording's own end is not a
 * moment ffmpeg has a frame at, so a span that runs to it stops a tenth of a second before. Fails for a span that starts at or
 * after the end of the recording.
 */
export function frameTimes(duration: number, span: Span, count: number): { ok: true; times: number[] } | { ok: false; reason: string } {
  if (span.from >= duration) return { ok: false, reason: `the span starts at ${round(span.from)} s, and the recording is ${round(duration)} s long` }
  const end = span.to !== null && span.to < duration ? span.to : Math.max(span.from, duration - BEFORE_THE_END)
  if (count <= 1) return { ok: true, times: [round(span.from)] }
  return { ok: true, times: Array.from({ length: count }, (_, i) => round(span.from + ((end - span.from) * i) / (count - 1))) }
}

/** A frame, with the moment it was cut at. */
export type Frame = { picture: Picture; seconds: number }

const FRAMES_NAME = (i: number): string => `frame-${i + 1}`

/**
 * The first request of a call about a recording: one Noul for each check, all in the same request, the frames in the state once, in
 * order of time. A recording is judged on the wording of the checks, or against a written spec; the answers are read as a
 * spec's are (`readWholeImage`).
 */
export function framesRequest(spec: string | null, frames: readonly Frame[], checks: readonly Check[]): { request: DecisionRequest; part: Part } {
  const images: RequestImage[] = frames.map((frame, i) => ({ name: FRAMES_NAME(i), format: frame.picture.format, base64: frame.picture.base64, width: frame.picture.width, height: frame.picture.height }))
  const state: Record<string, unknown> = { frames: frames.map((frame, i) => ({ seconds: frame.seconds, frame: imageRef(FRAMES_NAME(i)) })) }
  if (spec !== null) state.specification = spec
  const lead = `\`frames\` are ${frames.length} frames of a screen recording, in order of time (\`seconds\` is the time of each). Looking at how the picture changes from one frame to the next, does`
  const ask = (check: Check) => `${lead} ${check.part === '' ? 'the screen' : check.part} meet this requirement: ${check.property}?${spec === null ? '' : ' The specification it belongs to is in `specification`.'}`
  const questions: Record<string, Question> = Object.fromEntries(checks.map((check, i) => [String(i), { type: 'noul' as const, instructions: ask(check) }]))
  const part: Part = { part: CHECK_PART, questions }
  return { request: { ...mergeParts(state, [part]), images }, part }
}
