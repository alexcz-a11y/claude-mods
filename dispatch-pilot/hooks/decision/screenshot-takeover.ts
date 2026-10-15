// The screenshot takeover's judgments, pure (#62, spec #55 「截图接管」, ADR 0008): what the agent is told in place of an image,
// how the image blocks of a tool's result are found and swapped, what a Read result looks like once its image is gone.
//
// Nothing here touches the engine: saving an image to a file, asking a file's age and reporting are the feature's
// (features/screenshot-takeover.ts), which hands the swap a closure.

import { readImageHeader } from './image-header.ts'
import { VISUAL_CHECK_TOOL_CALLED } from './visual-check-tool.ts'

/** An image as a tool's result holds it. */
export type ResultImage = { base64: string; mediaType: string }

/** Where an image the agent is not shown is, and how big. `width` and `height` are 0 when not known. */
export type Kept = { path: string; width: number; height: number; format: string }

/** The `.ext` an image is saved under, by its media type; PNG for what is not known. */
export function extensionOf(mediaType: string): 'png' | 'jpg' | 'gif' | 'webp' {
  const subtype = mediaType.toLowerCase().replace(/^image\//, '')
  return subtype === 'jpeg' || subtype === 'jpg' ? 'jpg' : subtype === 'gif' ? 'gif' : subtype === 'webp' ? 'webp' : 'png'
}

/** The format of an image by its media type (`png`, `jpeg`, ...). */
export function formatOf(mediaType: string): string {
  const subtype = mediaType.toLowerCase().replace(/^image\//, '')
  return subtype === 'jpg' ? 'jpeg' : subtype
}

/** The size of an image from its own bytes (PNG and JPEG); null for another format or bytes that are none. */
export function sizeOfImage(base64: string): { width: number; height: number } | null {
  const header = readImageHeader(base64)
  return header === null ? null : { width: header.width, height: header.height }
}

/**
 * What the agent reads in place of the image (written for the model: English). `source`: how it came to be, a sentence that goes
 * first and ends the way a sentence does ("This image was read from /x.png."). Names the tool and the two ways to use the file:
 * check it, or look at it. Says that Read would bring this note again, so that the agent does not try it.
 */
export function takeoverNote(kept: Kept, source: string): string {
  const size = kept.width > 0 && kept.height > 0 ? `${kept.width}x${kept.height} ${kept.format}` : kept.format
  return [
    `${source} Screenshot takeover is on: the image was made in your current loop, so it was kept out of your context. It is saved at ${kept.path} (${size}).`,
    `To check it, call ${VISUAL_CHECK_TOOL_CALLED} with images: ["${kept.path}"] and the checks you need (what each part should look like); the decision model looks at the image for you and answers pass, fail or unsure for each check.`,
    `To look at the image yourself, call ${VISUAL_CHECK_TOOL_CALLED} with images: ["${kept.path}"] and look: true. Reading the file with Read gives you this note again.`,
  ].join('\n')
}

/** The Read result in its text form, as the engine records a Read of a text file (spec #55 「实测得到的形状」), with `content` as the file's one line. */
export function noteAsReadResult(path: string, note: string) {
  return { type: 'text' as const, file: { filePath: path, content: note, numLines: 1, startLine: 1, totalLines: 1 } }
}

/**
 * The image in a content block, whichever of the two shapes a block has: MCP's (`{ type: 'image', data, mimeType }`) or the
 * Messages API's (`{ type: 'image', source: { type: 'base64', media_type, data } }`); null for any other block.
 */
export function imageOf(block: unknown): ResultImage | null {
  if (typeof block !== 'object' || block === null || (block as { type?: unknown }).type !== 'image') return null
  const { data, mimeType, source } = block as { data?: unknown; mimeType?: unknown; source?: { type?: unknown; data?: unknown; media_type?: unknown } }
  if (typeof data === 'string' && data !== '') return { base64: data, mediaType: typeof mimeType === 'string' ? mimeType : 'image/png' }
  if (source !== undefined && source !== null && source.type === 'base64' && typeof source.data === 'string' && source.data !== '') {
    return { base64: source.data, mediaType: typeof source.media_type === 'string' ? source.media_type : 'image/png' }
  }
  return null
}

/** The blocks of a tool's result: the array itself, or the `content` of an MCP result; null for a result with no blocks (text, undefined, ...). */
function blocksOf(result: unknown): { blocks: unknown[]; rebuild: (blocks: unknown[]) => unknown } | null {
  if (Array.isArray(result)) return { blocks: result, rebuild: (blocks) => blocks }
  if (typeof result === 'object' && result !== null && Array.isArray((result as { content?: unknown }).content)) {
    const content = (result as { content: unknown[] }).content
    return { blocks: content, rebuild: (blocks) => ({ ...(result as object), content: blocks }) }
  }
  return null
}

/**
 * The result with each of its image blocks swapped for a text block holding what `swap` gives for that image. An image `swap`
 * gives null for (it could not be saved) stays as it was: the agent sees what it could not be spared. `swapped` counts the
 * images swapped; with none, `result` is the one given, unchanged.
 */
export async function swapImages(result: unknown, swap: (image: ResultImage) => Promise<string | null>): Promise<{ result: unknown; swapped: number }> {
  const found = blocksOf(result)
  if (found === null || !found.blocks.some((block) => imageOf(block) !== null)) return { result, swapped: 0 }
  let swapped = 0
  const blocks: unknown[] = []
  for (const block of found.blocks) {
    const image = imageOf(block)
    const note = image === null ? null : await swap(image)
    if (note === null) {
      blocks.push(block)
    } else {
      swapped += 1
      blocks.push({ type: 'text', text: note })
    }
  }
  return swapped === 0 ? { result, swapped } : { result: found.rebuild(blocks), swapped }
}
