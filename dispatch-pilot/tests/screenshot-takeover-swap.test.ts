// What the takeover finds in a tool's result and what it puts there (decision/screenshot-takeover.ts, core/loop-start.ts, #62).
// Seam 2: the pure functions, against the shapes a result may have.

import { expect, test } from 'claude-code/testing'
import { isFromLoop, startedBefore } from '../hooks/core/loop-start.ts'
import { extensionOf, formatOf, imageOf, noteAsReadResult, swapImages, takeoverNote } from '../hooks/decision/screenshot-takeover.ts'

const MCP = { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }
const API = { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'REVG' } }
const TEXT = { type: 'text', text: 'hello' }

test('an image block is found in either shape, with its media type; no other block is one', () => {
  expect(imageOf(MCP)).toEqual({ base64: 'QUJD', mediaType: 'image/jpeg' })
  expect(imageOf(API)).toEqual({ base64: 'REVG', mediaType: 'image/webp' })
  expect(imageOf({ type: 'image', data: 'QUJD' })).toEqual({ base64: 'QUJD', mediaType: 'image/png' })
  for (const other of [TEXT, { type: 'image' }, { type: 'image', data: '' }, { type: 'image', source: { type: 'url', url: 'x' } }, 'image', null, undefined, 3]) {
    expect(imageOf(other)).toBeNull()
  }
})

test('the images of a result are swapped for text blocks where they stand, in an array or in the content of an MCP result', async () => {
  const swap = async (image: { base64: string }) => `kept ${image.base64}`
  expect(await swapImages([TEXT, MCP, API], swap)).toEqual({ result: [TEXT, { type: 'text', text: 'kept QUJD' }, { type: 'text', text: 'kept REVG' }], swapped: 2 })
  expect(await swapImages({ isError: false, content: [MCP, TEXT] }, swap)).toEqual({ result: { isError: false, content: [{ type: 'text', text: 'kept QUJD' }, TEXT] }, swapped: 1 })
})

test('an image that cannot be swapped stays, and a result with nothing to swap comes back as the very same value', async () => {
  const first = async (image: { base64: string }) => (image.base64 === 'QUJD' ? null : 'kept')
  expect(await swapImages([MCP, API], first)).toEqual({ result: [MCP, { type: 'text', text: 'kept' }], swapped: 1 })

  const none = async () => null
  const unchanged = [MCP]
  expect((await swapImages(unchanged, none)).result).toBe(unchanged)
  const plain = [TEXT]
  expect(await swapImages(plain, async () => 'x')).toEqual({ result: plain, swapped: 0 })
  for (const text of ['just text', undefined, null, 7, { content: 'not blocks' }]) {
    expect(await swapImages(text, async () => 'x')).toEqual({ result: text, swapped: 0 })
  }
})

test('the note names the file, the size and visual_check, with both ways to use it, and says where the image came from', () => {
  const note = takeoverNote({ path: '/t/a.png', width: 1200, height: 800, format: 'png' }, 'The tool x returned an image.')
  expect(note).toContain('The tool x returned an image.')
  expect(note).toContain('/t/a.png (1200x800 png)')
  expect(note).toContain('mcp__dispatch-pilot__visual_check with images: ["/t/a.png"]')
  expect(note).toContain('look: true')
  expect(takeoverNote({ path: '/t/a.png', width: 0, height: 0, format: 'png' }, 'x')).toContain('(png)')
  expect(noteAsReadResult('/t/a.png', 'n')).toEqual({ type: 'text', file: { filePath: '/t/a.png', content: 'n', numLines: 1, startLine: 1, totalLines: 1 } })
})

test('a file is saved under the extension of its media type, and named by its format', () => {
  expect(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/heic', 'weird'].map(extensionOf)).toEqual(['png', 'jpg', 'jpg', 'gif', 'webp', 'png', 'png'])
  expect(['image/png', 'image/jpg', 'image/jpeg'].map(formatOf)).toEqual(['png', 'jpeg', 'jpeg'])
})

test('a file modified when the loop began or after is the loop\'s; one older than that is a reference', () => {
  expect(isFromLoop(1000, 1000)).toBe(true)
  expect(isFromLoop(1001, 1000)).toBe(true)
  expect(isFromLoop(999, 1000)).toBe(false)
  expect(startedBefore(999, 1000)).toBe(true)
  expect(startedBefore(1000, 1000)).toBe(false)
})
