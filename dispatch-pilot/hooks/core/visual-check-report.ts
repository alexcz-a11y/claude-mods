// What a visual_check call tells the screens (#58, ADR 0004): one decision for the log, beside the caller's route and not on its node
// (`aside`), and the call's checks added to the caller's count on its row of the board. A failure is a note on the board and
// never a toast. All of it goes through `report`, the one writer of what people see.

import { type NodeFailure, report, type ReportIo } from './report.ts'
import { outcomeText, reasonText, tallyOf, type VisualCheckRecord } from '../decision/visual-check-record.ts'

/** The switch's name: the decision's `feature` in the log. */
const FEATURE = 'visual-check'

/**
 * What went wrong in a call beyond a check's own doubt: the decision request failed (`request`, the failure the backend gave),
 * or something before it did (`error`: the images could not be read, a bug of the mod's; the debug log has the details).
 */
export type CallTrouble = { kind: 'request'; failure: NodeFailure } | { kind: 'error' }

/**
 * Reports a finished call of `agent` (`main`, or a dispatched agent's id): its decision in the log (the screenshot's path as
 * its subject), its checks on the agent's row, and `trouble` as a note on the board. Never throws.
 */
export async function reportCall(io: ReportIo, agent: string, record: VisualCheckRecord, trouble?: CallTrouble): Promise<void> {
  const call = { feature: FEATURE, agent, aside: true as const }
  const tally = tallyOf(record.checks)
  const failedCheck = tally.failed > 0
  await report(io, {
    decisions: [
      {
        ...call,
        subject: record.image,
        outcome: outcomeText(record),
        reason: reasonText(record),
        tone: trouble !== undefined ? 'fail' : failedCheck ? 'warn' : 'ok',
        visualCheck: record,
      },
      ...(trouble === undefined ? [] : [trouble.kind === 'request' ? { ...call, failure: trouble.failure } : { ...call, skipped: 'error' as const }]),
    ],
  })
  await report(io, { tally: { feature: FEATURE, agent, passed: tally.passed, failed: tally.failed, unsure: tally.unsure } })
}
