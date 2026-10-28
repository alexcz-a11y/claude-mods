// The fake Jev the eval suites' tests ask: a network whose replies a test writes per request body, and the answer of a Jev to the
// effort question and the Nouls beside it (ADR 0014).

import type { BackendIo } from '../../hooks/decision/backend.ts'
import { EFFORTS } from '../../hooks/decision/effort.ts'
import { JEV_MODEL } from '../../hooks/decision/jev.ts'

/** One HTTP reply of the fake network: a status and a JSON body. */
export type Reply = { status: number; body: unknown }

/** What the decision model says of the problem, by the three Nouls' ids. */
export const STILL = { still_failing: 0.8, solved: 0.1, new_task: 0.1 }
export const SOLVED = { still_failing: 0.1, solved: 0.8, new_task: 0.1 }
export const ELSEWHERE = { still_failing: 0.1, solved: 0.1, new_task: 0.8 }

/**
 * A Jev answer to the effort question putting `p` on the levels (lowest first), to the three Nouls about the problem the
 * values `triage` gives by their ids, to the other Nouls of the effort part (`nouls`, by their ids within the part) 0 unless
 * given, and to any other question the probabilities `triage`.
 */
export function answers(body: any, p: readonly number[], triage: Record<string, number> = STILL, nouls: Record<string, number> = {}): Reply {
  const out: Record<string, unknown> = {}
  const score = (levels: readonly number[]) => ({ type: 'score', probabilities: Object.fromEntries(EFFORTS.map((_, i) => [String(i), levels[i] ?? 0])), confidence: 0.5, score: 0 })
  for (const [id, question] of Object.entries(body.questions as Record<string, { type: string }>)) {
    const local = id.startsWith('effort.') ? id.slice('effort.'.length) : null
    if (id === 'effort.level') out[id] = score(p)
    else if (question.type === 'noul' && local !== null) out[id] = { type: 'noul', noul: triage[local] ?? nouls[local] ?? 0 }
    else out[id] = { type: question.type, probabilities: triage, confidence: 0.5, choice: '' }
  }
  return { status: 200, body: { model: JEV_MODEL, answers: out, usage: { input_tokens: 700 } } }
}

/** A fake network: `reply` answers each request (120 ms each on the clock); the bodies sent are kept. */
export function network(reply: (body: any) => Reply) {
  const bodies: any[] = []
  let clock = 0
  const io: BackendIo = {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body))
      bodies.push(body)
      const { status, body: out } = reply(body)
      clock += 120
      return { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(out) }
    },
    sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))),
  }
  return { io, bodies, now: () => clock }
}
