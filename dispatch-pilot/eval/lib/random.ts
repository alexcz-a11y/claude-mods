// The seeded generator the eval's generators share (long-filler.ts, eval-v2.ts), each starting it from its own hash of its seed.
//
// Pure: no Node API.

/** mulberry32 from a 32-bit start: the same start, the same numbers, on every machine. */
export function mulberry32(start: number): () => number {
  let a = start >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
