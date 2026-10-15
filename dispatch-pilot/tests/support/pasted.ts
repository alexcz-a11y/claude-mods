// Images the person pastes into a message, for the world (tests/support/world.ts, #63): what the engine hands the mod of them.
//
// `prompt.submit` carries only the attachments' metadata (a kind, a MIME type and a handle, no bytes). The images are in the
// message's row, which the engine appends a moment later (`session.append`, door `prompt`): an `image` block for each, scaled by
// the engine to fit in 2000 pixels, and a text block, `[Image: source: <path> ...]`, naming the file the original is kept in.
// (Measured on Claude Code 2.1.300; docs/research/decision-model-images.md and DEVELOPMENT.md.)
//
// Not a test file (no `.test.ts`).

import { fileBase64, type FakeImage } from './images.ts'

/** An image pasted into a message. */
export type PastedImage = {
  /** The picture the row's `image` block holds: the engine's scaled-down copy. */
  shown: FakeImage
  /** The file the original is in, named by the row's `[Image: source: ...]` block; left out: the row names none. */
  path?: string
}

/** What `prompt.submit` carries of the images (`e.attachments`): their kind, MIME type and a handle each, never their bytes. */
export function attachmentsOf(images: readonly PastedImage[]) {
  return images.map((image, i) => ({ type: 'image' as const, mediaType: `image/${image.shown.format}`, id: `media_${i + 1}` }))
}

/** The blocks of the message's row, as the engine appends them: the words, then each image and, when it names one, its file. */
export function rowOf(text: string, images: readonly PastedImage[]): { type: string; [field: string]: unknown }[] {
  return [
    { type: 'text', text },
    ...images.flatMap((image) => [
      { type: 'image', source: { type: 'base64', media_type: `image/${image.shown.format}`, data: fileBase64(image.shown) } },
      ...(image.path === undefined ? [] : [{ type: 'text', text: `[Image: source: ${image.path}]` }]),
    ]),
  ]
}
