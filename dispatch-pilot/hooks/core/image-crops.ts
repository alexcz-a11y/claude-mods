// Cutting a piece out of an image and enlarging it (#59, ADR 0008), for the zoomed re-check: sips does it in two calls on a new
// file of the session's temporary directory. Like image-files.ts it keeps no state and asks for nothing but an `ImageFilesIo`.

import { errorText } from '../decision/backend.ts'
import { ENLARGE_TO, enlargedSize, type Rect, sipsCropArgs, sipsEnlargeArgs } from '../decision/zoom.ts'
import type { Picture } from '../decision/images.ts'
import { asArgument, failedRun, type ImageFilesIo } from './image-files.ts'

/** What a crop is cut from: the image's file (already in the size and format that are sent) and its format, which the crop keeps. */
export type CropSource = { file: string; format: 'png' | 'jpeg' }

/** A crop, enlarged and read as bytes; `rect` is the piece of the source it is. */
export type Crop = Picture & { rect: Rect }

/** A crop made, or why it could not be (written for the model, in English). */
export type Cropped = { ok: true; crop: Crop } | { ok: false; reason: string }

/**
 * The piece `rect` of `source`, cut out and enlarged until its long side is `longSide` pixels, and read. The crop and the
 * enlargement are two calls of sips (given together, sips applies the enlargement first). Never throws: a program that fails, is
 * missing or is not allowed (outside the CLI) is a reason.
 */
export async function cropImage(io: ImageFilesIo, source: CropSource, rect: Rect, longSide: number = ENLARGE_TO): Promise<Cropped> {
  try {
    const file = await io.newFile(source.format === 'jpeg' ? 'jpg' : 'png')
    const cut = await io.run(sipsCropArgs(asArgument(source.file), rect, file))
    if (cut.exitCode !== 0) return { ok: false, reason: `sips could not cut a crop out of ${source.file} (${failedRun(cut)})` }
    const enlarged = await io.run(sipsEnlargeArgs(file, longSide))
    if (enlarged.exitCode !== 0) return { ok: false, reason: `sips could not enlarge a crop (${failedRun(enlarged)})` }
    const base64 = await io.readBytes(file)
    const { width, height } = enlargedSize(rect, longSide)
    return { ok: true, crop: { rect, format: source.format, base64, width, height } }
  } catch (error) {
    return { ok: false, reason: `a crop could not be made (${errorText(error)})` }
  }
}
