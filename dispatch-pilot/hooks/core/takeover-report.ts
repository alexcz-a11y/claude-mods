// What the screenshot takeover tells the screens (#62, ADR 0004): each image it kept from an agent is a decision in the log, beside
// the agent's route (`aside`; the path and the size, no image), and all of them together are added to the agent's count on its
// row of the board (「接管 n」, with the checks' count: core/visual-check-report.ts). All of it goes through `report`, the one
// writer of what people see.

import { report, type ReportIo } from './report.ts'
import type { Kept } from '../decision/screenshot-takeover.ts'

/** The switch's name: the decision's `feature` in the log. */
const FEATURE = 'screenshot-takeover'

/** The size in the person's words: `1200×800`, or nothing when it was not known. */
const sizeText = (kept: Kept): string => (kept.width > 0 && kept.height > 0 ? `${kept.width}×${kept.height}` : '尺寸不明')

/**
 * Reports the images the takeover kept from `agent` (`main`, or a dispatched agent's id): one entry for each in the log, with
 * the file's path as its subject, and `kept.length` more on the agent's row. Never throws.
 */
export async function reportTakeover(io: ReportIo, agent: string, kept: readonly Kept[]): Promise<void> {
  if (kept.length === 0) return
  await report(io, {
    decisions: kept.map((one) => ({
      feature: FEATURE,
      agent,
      aside: true as const,
      subject: one.path,
      outcome: '接管截图',
      reason: `${sizeText(one)}，没有给 agent 看，存放在 ${one.path}；要看用 visual_check`,
      tone: 'ok' as const,
    })),
  })
  // The row of the board shows these beside the checks (`visual-check`'s part); the count is added to what the node has.
  await report(io, { tally: { feature: 'visual-check', agent, passed: 0, failed: 0, unsure: 0, takeovers: kept.length } })
}
