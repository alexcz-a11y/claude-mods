// The decision model answering a zoomed re-check (#59), for the tests of visual_check: the first request (the whole images and the
// Box questions) and the second (one Noul for each pair of crops) are told apart by their question ids, and each is given its own
// answers. Not a test file (no `.test.ts`).

import { jev, type Reply, type Sent } from './world.ts'

/** Where in an image a box lies, as shares of its height and width from the top left. */
export type Edges = { top: number; bottom: number; left: number; right: number }

/** A Box answer: `box(top, bottom, left, right, confidence)`. */
export const box = (top: number, bottom: number, left: number, right: number, confidence = 0.9): { box: Edges; confidence: number } => ({ box: { top, bottom, left, right }, confidence })

export type ZoomAnswers = {
  /** The first request's Noul answers by question id (`check.0`); 0.5 for one left out. */
  whole?: Record<string, number>
  /**
   * The first request's Box answers by question id (`box.0.candidate`, `where.screen`); the middle of the image for one left out,
   * except `where.screen`, which is a box nobody is sure of (confidence 0.05) as for two images that are the same: not reported.
   */
  boxes?: Record<string, { box: Edges; confidence: number }>
  /** The second request's Noul answers: one value for every pair, or by question id (`zoom.0.0`); 0.5 for one left out. */
  zoom?: number | Record<string, number>
  /** The second request is answered like this instead (an HTTP error, a timeout). */
  zoomReply?: Reply | ((request: Sent) => Reply)
}

/** Whether a request is the second one of a zoomed re-check: its questions are the `zoom.<check>.<reference>` ones. */
export const isZoomRequest = (request: Sent): boolean => Object.keys(request.body?.questions ?? {}).some((id) => id.startsWith('zoom.'))

/** The backend of a world that answers the two requests of a zoomed re-check as `answers` says. */
export function zoomBackend(answers: ZoomAnswers = {}) {
  return (request: Sent): Reply => {
    if (isZoomRequest(request)) {
      if (answers.zoomReply !== undefined) return typeof answers.zoomReply === 'function' ? answers.zoomReply(request) : answers.zoomReply
      const ids = Object.keys(request.body.questions)
      const nouls = typeof answers.zoom === 'number' ? Object.fromEntries(ids.map((id) => [id, answers.zoom as number])) : answers.zoom
      return jev([0, 1, 0, 0, 0], nouls === undefined ? {} : { nouls })(request)
    }
    return jev([0, 1, 0, 0, 0], { ...(answers.whole === undefined ? {} : { nouls: answers.whole }), boxes: { 'where.screen': box(0.25, 0.75, 0.25, 0.75, 0.05), ...answers.boxes } })(request)
  }
}
