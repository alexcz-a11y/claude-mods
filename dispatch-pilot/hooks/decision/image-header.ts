// What the first bytes of a PNG or a JPEG say: its size, and the orientation a JPEG's EXIF gives it. Read from the base64 text
// of the file (`$.fs.read(path, { as: 'bytes' })` gives no more), without decoding more of it than the header needs. Where there
// is sips (the CLI) it tells the size; this is for where there is not, and for the orientation, which sips cannot tell.
// Pure (see system-one.ts).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** What a header says of an image. `orientation`: the EXIF tag, 1 (upright) to 8; 1 for a PNG or a JPEG without one. */
export type ImageHeader = { format: 'png' | 'jpeg'; width: number; height: number; orientation: number }

/** A reader of the bytes of a base64 text: the byte at an index, or 0 beyond the end. */
function bytesOf(base64: string): (index: number) => number {
  const value = (at: number): number => {
    const char = base64[at]
    return char === undefined || char === '=' ? 0 : Math.max(0, ALPHABET.indexOf(char))
  }
  return (index) => {
    const group = Math.floor(index / 3) * 4
    const bits = (value(group) << 18) | (value(group + 1) << 12) | (value(group + 2) << 6) | value(group + 3)
    return (bits >> ((2 - (index % 3)) * 8)) & 255
  }
}

/** The size of the file in bytes that a base64 text holds. */
function byteLength(base64: string): number {
  return Math.max(0, Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0))
}

export function readImageHeader(base64: string): ImageHeader | null {
  const at = bytesOf(base64)
  const length = byteLength(base64)
  const u16 = (index: number, little = false) => (little ? at(index) | (at(index + 1) << 8) : (at(index) << 8) | at(index + 1))
  const u32 = (index: number, little = false) => (little ? (u16(index, true) | (u16(index + 2, true) << 16)) >>> 0 : ((u16(index) << 16) | u16(index + 2)) >>> 0)
  const text = (index: number, count: number) => String.fromCharCode(...Array.from({ length: count }, (_, i) => at(index + i)))

  if (length >= 24 && at(0) === 0x89 && text(1, 3) === 'PNG') return { format: 'png', width: u32(16), height: u32(20), orientation: 1 }

  if (length >= 4 && at(0) === 0xff && at(1) === 0xd8) {
    let orientation = 1
    let index = 2
    while (index + 4 <= length) {
      if (at(index) !== 0xff) return null
      const marker = at(index + 1)
      if (marker === 0xff) {
        index += 1
        continue
      }
      // Markers without a length, and the start of the image data, which the size comes before.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        index += 2
        continue
      }
      if (marker === 0xd9 || marker === 0xda) return null
      const segment = u16(index + 2)
      // The start of a frame: precision, then the height and the width.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { format: 'jpeg', width: u16(index + 7), height: u16(index + 5), orientation }
      if (marker === 0xe1 && text(index + 4, 4) === 'Exif') orientation = exifOrientation(index + 10, index + 2 + segment)
      index += 2 + segment
    }
    return null
  }
  return null

  /** The orientation in the TIFF block that starts at `from` and ends before `to`, 1 when it has none. */
  function exifOrientation(from: number, to: number): number {
    const little = text(from, 2) === 'II'
    if (!little && text(from, 2) !== 'MM') return 1
    const first = from + u32(from + 4, little)
    const entries = u16(first, little)
    for (let i = 0; i < entries && first + 2 + i * 12 + 12 <= to; i++) {
      const entry = first + 2 + i * 12
      if (u16(entry, little) === 0x0112) {
        const value = u16(entry + 8, little)
        return value >= 1 && value <= 8 ? value : 1
      }
    }
    return 1
  }
}
