// `look: true` of visual_check (#57, #60): the images handed back as they are, within the limits an agent reads well, a recording as
// frames of it; nothing is asked of the decision model. Called from the tool in features/visual-check.ts, which has read the call and
// built the closures; like that file, a call here never fails: each image that cannot be got is a line saying why.

import { errorText } from '../decision/backend.ts'
import { type ImageLimits, LOOK_IMAGE_LIMITS } from '../decision/image-fit.ts'
import type { Picture } from '../decision/images.ts'
import { isRecording, LOOK_FRAME_COUNT, type Span } from '../decision/visual-check-frames.ts'
import { type ImageFilesIo, type Loaded, loadImage } from '../core/image-files.ts'
import { type RecordingFrames, readRecording } from '../core/video-frames.ts'

/** What a tool call answers: a string, or Messages API blocks (the engine takes nothing else of a registered tool). */
export type AnswerBlock = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

export const imageBlock = (picture: Picture): AnswerBlock => ({ type: 'image', source: { type: 'base64', media_type: `image/${picture.format}`, data: picture.base64 } })

const failed = (error: unknown): Loaded => ({ ok: false, reason: errorText(error) })

/** An image file for `look`, loaded within the limits; a failure of any kind is a reason, never a throw. */
export async function load(files: ImageFilesIo, path: string, limits: ImageLimits): Promise<Loaded> {
  return loadImage(files, path, limits).catch(failed)
}

/** `look` at a recording (#60): a line saying when each frame was cut, then the frames; or a line saying why there are none. */
async function lookAtRecording(files: ImageFilesIo, path: string, span: Span): Promise<AnswerBlock[]> {
  const read = await readRecording(files, path, span, LOOK_FRAME_COUNT, LOOK_IMAGE_LIMITS).catch((error: unknown): RecordingFrames => ({ ok: false, reason: errorText(error) }))
  if (!read.ok) return [{ type: 'text', text: read.reason }]
  return [{ type: 'text', text: `Frames of ${path}, in order of time, cut at ${read.frames.map((frame) => `${frame.seconds} s`).join(', ')}.` }, ...read.frames.map((frame) => imageBlock(frame.picture))]
}

/** `look`: the images as they are handed back, each one that cannot be got as a line saying why; a recording as frames of it, through `span`. */
export async function look(files: ImageFilesIo, paths: readonly string[], span: Span): Promise<AnswerBlock[]> {
  const blocks: AnswerBlock[] = []
  for (const path of paths) {
    if (isRecording(path)) {
      blocks.push(...(await lookAtRecording(files, path, span)))
      continue
    }
    const loaded = await load(files, path, LOOK_IMAGE_LIMITS)
    blocks.push(loaded.ok ? imageBlock(loaded.image) : { type: 'text', text: loaded.reason })
  }
  return blocks
}
