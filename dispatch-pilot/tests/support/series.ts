// The decision model answering a series of quality levels (#61), for the tests of visual_check: the levels are files `/levels/1.png`,
// `/levels/2.png`, ... whose label is their path, so that the request of a pair (its two images, or the crops cut from them, which
// carry the path of the file they came from) says which pair it is about, however the pairs are interleaved. Each pair is given its
// own answers. Not a test file (no `.test.ts`).

import { readFake } from './images.ts'
import { type Reply, type Sent } from './world.ts'
import { type Edges, zoomBackend } from './zoom.ts'

/** The path of level `n`. */
export const level = (n: number): string => `/levels/${n}.png`

/** The disk of `count` levels, each a PNG of the given size whose label is its own path. */
export function levels(count: number, size = { width: 1000, height: 1000 }): Record<string, { format: string; width: number; height: number; label: string }> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [level(i + 1), { format: 'png', ...size, label: level(i + 1) }]))
}

/** The levels a request holds images of, lowest first: `[1, 2]` for the request about levels 1 and 2. */
export function pairOf(request: Sent): [number, number] | null {
  const assets = Object.values((request.body?.assets ?? {}) as Record<string, { data_base64: string }>)
  const found = new Set<number>()
  for (const asset of assets) for (const match of (readFake(asset.data_base64)?.label ?? '').matchAll(/\/levels\/(\d+)\.png/g)) found.add(Number(match[1]))
  const [low, high] = [...found].sort((a, b) => a - b)
  return low === undefined || high === undefined ? null : [low, high]
}

export type SeriesAnswers = {
  /** The probability of "the same" on the crops of a pair, by the pair (`1-2`): one value for every check, or by question id (`zoom.0.0`); 0.5 for a pair left out. */
  zoom?: Record<string, number | Record<string, number>>
  /** The boxes the model gives, as in `zoomBackend`, for every pair. */
  boxes?: Record<string, { box: Edges; confidence: number }>
  /** The request of a pair (`1-2`) is answered like this instead (an HTTP error, a timeout). */
  reply?: Record<string, Reply | ((request: Sent) => Reply)>
}

/** The backend of a world that answers the requests of each pair of levels as `answers` says. */
export function seriesBackend(answers: SeriesAnswers = {}) {
  return (request: Sent): Reply => {
    const pair = pairOf(request)
    const key = pair === null ? '' : `${pair[0]}-${pair[1]}`
    const own = answers.reply?.[key]
    if (own !== undefined) return typeof own === 'function' ? own(request) : own
    return zoomBackend({ ...(answers.boxes === undefined ? {} : { boxes: answers.boxes }), ...(answers.zoom?.[key] === undefined ? {} : { zoom: answers.zoom[key] }) })(request)
  }
}
