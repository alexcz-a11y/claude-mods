// A run that asks the questions of every request reading the same state together, in one request (`run.ts --merge`,
// DEVELOPMENT.md 「d1-ultra 核验」): the variants of an item that differ only in their question (effort-submit's zh-score
// and zh-choice), and the agents of one Workflow, which all send their script's batch. A request asked twice with
// the same questions is sent once and its answer given to both. The mod asks a message's effort question on its own
// (ADR 0005); a decision model that reads each question on its own (Jev's docs say it does; Liquid's d1-ultra drifts
// no more merged than asked twice alone, 2026-10-15) answers the same either way, and the merged run is the cheaper
// on Jev, which counts the state once.
//
// Every task starts at once; whenever each one still running waits on an answer, the requests they wait on are
// grouped by state and sent, `concurrency` at a time, each with its questions under a prefix of its own, and each task
// gets its own questions' answers back, the tokens shared by its questions' part. Pure: the network, the clock and the
// pauses are handed in.

import type { Asked } from '../../hooks/decision/backend.ts'
import { MAX_QUESTIONS, type DecisionRequest } from '../../hooks/decision/system-one.ts'
import { LANGUAGES } from './datasets.ts'
import { answer, askRetrying, type Row, type RunOptions } from './runner.ts'
import type { AnyItem, Sent, Suite } from './suite.ts'

type Waiting = { request: DecisionRequest; give: (sent: Sent) => void }
/** Requests with one state, asked as one: each distinct request (its questions under `m<i>.`) and the tasks waiting on it. */
type Merged = { request: { state: DecisionRequest['state']; questions: Record<string, DecisionRequest['questions'][string]> }; parts: { prefix: string; count: number; waiting: Waiting[] }[] }

export type MergedRun<P> = { rows: Row<P>[]; requests: number; attempts: number }

export async function runSuiteMerged<I extends AnyItem, P>(suite: Suite<I, P>, items: readonly I[], options: RunOptions): Promise<MergedRun<P>> {
  if ((options.repeats ?? 1) !== 1) throw new RangeError('a merged run asks each item once')
  const languages = options.languages ?? LANGUAGES
  const tasks = items.flatMap((item) => options.variants.flatMap((variant) => languages.map((language) => ({ item, variant, language }))))
  const rows: Row<P>[] = new Array(tasks.length)
  let waiting: Waiting[] = []
  let running = tasks.length
  let requests = 0
  let attempts = 0
  let done = 0
  const send = (request: DecisionRequest) => new Promise<Sent>((give) => waiting.push({ request, give }))
  tasks.forEach((task, at) => {
    void answer(suite, task.item, task.language, task.variant, options, send).then((row) => {
      rows[at] = row
      running--
      options.onRow?.(row as Row<unknown>, ++done, tasks.length)
    })
  })
  while (running > 0) {
    // Let every task run until it waits on an answer or is done.
    let idle = 0
    while (waiting.length < running && idle < 1000) {
      const before = waiting.length + running
      await options.pause(0)
      idle = waiting.length + running === before ? idle + 1 : 0
    }
    // The last answers settled the last tasks.
    if (running === 0) break
    if (waiting.length === 0) throw new Error(`${running} tasks neither answered nor waiting on a request`)
    const batch = merge(waiting)
    waiting = []
    let next = 0
    const worker = async () => {
      while (next < batch.length) {
        const merged = batch[next++] as Merged
        const sent = await askRetrying(merged.request, options)
        requests++
        attempts += sent.attempts
        hand(merged, sent)
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, batch.length)) }, worker))
  }
  return { rows, requests, attempts }
}

/** The waiting requests as merged requests: by state; the same request once; at most MAX_QUESTIONS questions each. */
export function merge(waiting: readonly Waiting[]): Merged[] {
  const byState = new Map<string, Map<string, Waiting[]>>()
  for (const one of waiting) {
    if ((one.request.images ?? []).length > 0) throw new RangeError('a merged run sends no images')
    const state = JSON.stringify(one.request.state)
    const same = byState.get(state) ?? new Map<string, Waiting[]>()
    const key = JSON.stringify(one.request.questions)
    same.set(key, [...(same.get(key) ?? []), one])
    byState.set(state, same)
  }
  const out: Merged[] = []
  for (const same of byState.values()) {
    let current: Merged | null = null
    let count = 0
    for (const group of same.values()) {
      const request = (group[0] as Waiting).request
      const own = Object.keys(request.questions).length
      if (current === null || count + own > MAX_QUESTIONS) {
        current = { request: { state: request.state, questions: {} }, parts: [] }
        count = 0
        out.push(current)
      }
      const prefix = `m${current.parts.length}`
      for (const [id, question] of Object.entries(request.questions)) current.request.questions[`${prefix}.${id}`] = question
      current.parts.push({ prefix, count: own, waiting: group })
      count += own
    }
  }
  return out
}

/** Each waiting task's own answers out of a merged request's, with its part of the tokens. */
function hand(merged: Merged, sent: Sent): void {
  const total = merged.parts.reduce((sum, part) => sum + part.count * part.waiting.length, 0)
  for (const part of merged.parts) {
    for (const one of part.waiting) {
      let asked: Asked = sent.asked
      if (sent.asked.ok) {
        const answers = Object.fromEntries(
          Object.entries(sent.asked.answers).flatMap(([id, value]) => (id.startsWith(`${part.prefix}.`) ? [[id.slice(part.prefix.length + 1), value]] : [])),
        )
        const tokens = sent.asked.inputTokens === null ? null : Math.round((sent.asked.inputTokens * part.count) / total)
        asked = { ...sent.asked, answers, inputTokens: tokens }
      }
      one.give({ request: one.request, asked, ms: sent.ms, attempts: sent.attempts })
    }
  }
}
