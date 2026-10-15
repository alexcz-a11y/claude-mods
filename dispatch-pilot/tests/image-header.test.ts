// What the first bytes of an image say (decision/image-header.ts, #57): the size of a PNG or a JPEG and the EXIF orientation of a
// JPEG, read from base64 text. Seam 2: the pure function against real files (made with Pillow, 12 by 8 pixels).

import { expect, test } from 'claude-code/testing'
import { readImageHeader } from '../hooks/decision/image-header.ts'

/** A JPEG with an EXIF block (big-endian) whose orientation is 6. */
const JPEG_ORIENTATION_6 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAIAAwDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDHooorhPqD/9k='
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAIAAABChommAAAAFUlEQVR42mM8ISfHQAgwMRABhrciADW5ARTIf36eAAAAAElFTkSuQmCC'

test('a PNG’s size is read from its header', () => {
  expect(readImageHeader(PNG)).toEqual({ format: 'png', width: 12, height: 8, orientation: 1 })
})

test('a JPEG’s size is read past its EXIF block, and so is the orientation that block gives', () => {
  expect(readImageHeader(JPEG_ORIENTATION_6)).toEqual({ format: 'jpeg', width: 12, height: 8, orientation: 6 })
})

test('bytes that are neither, or are cut short, give nothing', () => {
  expect(readImageHeader('bm90IGFuIGltYWdl')).toBeNull()
  expect(readImageHeader('')).toBeNull()
  expect(readImageHeader(JPEG_ORIENTATION_6.slice(0, 60))).toBeNull()
  expect(readImageHeader(PNG.slice(0, 16))).toBeNull()
})
