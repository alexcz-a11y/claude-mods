// visual_check with `sequence: true` (#61, ADR 0008): the agent hands over screenshots of one view at rising quality levels (the sea at
// low, medium, high, ultra) and the checks name the parts that the level may change. Each two neighbouring levels are compared in
// every named part by the zoomed re-check (core/quality-series.ts), and the answer says from which level on the higher ones look
// alike, so that the agent need not hand the choice of a level, one look at a time, to the person. Called from the tool in
// features/visual-check.ts, which has read the call, checked the switches and built the closures; like that file, a call here never
// fails: whatever goes wrong, the answer says so.

import type { Asked } from '../decision/backend.ts'
import { errorText } from '../decision/backend.ts'
import { limitsFor } from '../decision/image-fit.ts'
import type { DecisionRequest } from '../decision/system-one.ts'
import { type PairReport, seriesText } from '../decision/visual-check-sequence-text.ts'
import { seriesRecordOf, type VisualCheckRecord } from '../decision/visual-check-record.ts'
import { isRecording } from '../decision/visual-check-frames.ts'
import type { VisualCheckInput } from '../decision/visual-check-tool.ts'
import { type ImageFilesIo, type LoadedImage, loadImages } from '../core/image-files.ts'
import { compareLevels } from '../core/quality-series.ts'
import type { CallTrouble } from '../core/visual-check-report.ts'

/** What a call needs of the world: files and programs, the decision model that takes images (Jev: a series needs its boxes), the report. */
export type SeriesDeps = {
  files: ImageFilesIo
  ask: (request: DecisionRequest) => Promise<Asked>
  backend: 'jev' | 'pplx'
  /** `$.clock.now()`: a call's duration is in its record. */
  now: () => Promise<number>
  /** A line for the debug log. */
  debug: (line: string) => void
  /** Hands a finished call to the board and the decision log (core/visual-check-report.ts). */
  report: (record: VisualCheckRecord, trouble?: CallTrouble) => Promise<void>
}

type Block = { type: 'text'; text: string }

/** A call that did not run: the agent is told why, and that it can look at the images itself. */
const LOOK_YOURSELF = 'Look at the levels yourself (visual_check with look: true).'

/**
 * The images of the series, loaded, or why not. A request holds the two images of one pair, never all of the series, and two images
 * at the most Jev takes of one (JEV_IMAGE_LIMITS, 2.46 megapixels, about 12,800 tokens of the 24,000 a request may hold) fit it
 * whole, so each is loaded within the limits and no further.
 */
async function loadLevels(deps: SeriesDeps, paths: readonly string[]): Promise<{ ok: true; levels: LoadedImage[] } | { ok: false; reason: string }> {
  const recording = paths.find(isRecording)
  if (recording !== undefined) {
    return { ok: false, reason: `${recording} is a recording, and a series is compared on stills: cut the same moment from the recording of each level (for example ffmpeg -ss 2 -i level.mov -frames:v 1 level.png) and give those frames as the series` }
  }
  let loaded: Awaited<ReturnType<typeof loadImages>>
  try {
    loaded = await loadImages(deps.files, paths, limitsFor(deps.backend))
  } catch (error) {
    return { ok: false, reason: errorText(error) }
  }
  const broken = loaded.find((one) => !one.ok)
  if (broken !== undefined && !broken.ok) return { ok: false, reason: broken.reason }
  return { ok: true, levels: loaded.flatMap((one) => (one.ok ? [one.image] : [])) }
}

/** One call with a series, from its input to its answer. */
export async function checkSeries(deps: SeriesDeps, input: VisualCheckInput): Promise<Block[]> {
  const { checks } = input
  const startedAt = await deps.now()
  const read = await loadLevels(deps, input.images)
  if (!read.ok) {
    deps.debug(`visual_check could not use the levels of its series: ${read.reason}`)
    const unsure = checks.map((check) => ({ check, verdict: 'unsure' as const, probability: null, basis: 'whole' as const, why: read.reason }))
    await deps.report(seriesRecordOf({ levels: input.images, backend: deps.backend, pairs: [{ results: unsure }], ms: (await deps.now()) - startedAt }), { kind: 'error' })
    return [{ type: 'text', text: `visual_check could not read the levels: ${read.reason}. ${LOOK_YOURSELF}` }]
  }
  const series = await compareLevels({ files: deps.files, ask: deps.ask, backend: deps.backend }, read.levels, input.sameView, checks)
  const pairs = series.pairs.map((pair): PairReport & { from: number; to: number } => ({ from: pair.from, to: pair.to, results: pair.outcome.results, elsewhere: pair.outcome.elsewhere === null ? null : pair.outcome.elsewhere.place }))
  await deps.report(
    seriesRecordOf({ levels: input.images, backend: deps.backend, pairs, ms: (await deps.now()) - startedAt }),
    series.failure === null ? undefined : { kind: 'request', failure: { backend: deps.backend, ...series.failure } },
  )
  return [{ type: 'text', text: seriesText(input.images, pairs) }]
}
