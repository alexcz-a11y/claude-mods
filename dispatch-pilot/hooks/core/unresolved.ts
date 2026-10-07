// The unresolved count and the problem summary that goes with it: the one module
// that writes them (`$.state` `unresolved`; GLOSSARY 未解决次数, 问题摘要, ADR 0005).
// The main-effort feature moves the count by each message's answer; the unresolved
// feature starts it over when the conversation ends and keeps the summary (a cheap
// model writes it after each of the person's turns, in the background). They only
// count and record; both are a basis for the decision model's judgment of effort,
// never a rule.
//
// The summary starts over wherever the count does: the problem is solved, another
// one begins, `/clear`, a new session. A write of it that is still going on then
// is dropped when it lands (its turn is no longer in `writing`).
//
// Cells come in as closures (a `$` cannot cross a file), like the plan table's.

import { countAfter, UNRESOLVED_OPTIONS, type UnresolvedJudgement, type UnresolvedOption } from '../decision/unresolved.ts'
import { markLast, SUMMARY_TIMEOUT_MS, type Summary } from '../decision/summary.ts'
import { replace, update, type Cell } from './plans.ts'
import type { Decided, UnresolvedRecord } from './report.ts'

/** The summary as it is kept: the turn it was last written for beside it. */
export type StoredSummary = Summary & { turn: string }

/** What `$.state` `unresolved` holds. */
export type UnresolvedState = {
  count: number
  summary?: StoredSummary
  /** The turns whose summaries are queued or being written, oldest first. */
  writing?: string[]
  /** The turn whose summary, once written, has its last attempt marked unresolved. */
  owed?: string
}

/** The stored count and summary (`$.state` `unresolved`). */
export type CountCell = Cell<UnresolvedState>

/** What the log and the card call the three options. */
export const OPTION_WORDS: Readonly<Record<UnresolvedOption, string>> = {
  still_unresolved: '仍未解决',
  resolved: '已经解决',
  new_or_unrelated: '新问题或无关',
}

/**
 * The state after one more message that said "still unresolved": the count up by one, and the last attempt of the
 * summary marked unresolved, or, when a write of the newest turn's summary is still going on (the summary does not
 * yet hold the attempt the message is about), marked once that write lands.
 */
function oneMore(current: UnresolvedState | undefined): UnresolvedState {
  const state = current ?? { count: 0 }
  const next: UnresolvedState = { ...state, count: state.count + 1 }
  const newest = state.writing?.at(-1)
  if (newest !== undefined) return { ...next, owed: newest }
  if (state.summary !== undefined) next.summary = { ...markLast(state.summary), turn: state.summary.turn }
  return next
}

/** The count before and after a change (a change that leaves it as it was is not written); a clear takes the summary too. */
export async function moveCount(cell: CountCell, change: UnresolvedJudgement['change']): Promise<{ before: number; count: number }> {
  if (change === 'keep') {
    const count = (await cell.get()).value?.count ?? 0
    return { before: count, count }
  }
  const { before, after } = await replace(cell, (current) => (change === 'add' ? oneMore(current) : { count: countAfter(current?.count ?? 0, change) }))
  return { before: before?.count ?? 0, count: after.count }
}

/** A conversation that ends (`/clear`, a new session) starts the count and the summary over. */
export async function clearCount(cell: CountCell): Promise<void> {
  await update(cell, () => ({ count: 0 }))
}

/** The summary, when there is one: what the effort request carries. */
export async function keptSummary(cell: CountCell): Promise<StoredSummary | null> {
  return (await cell.get()).value?.summary ?? null
}

/** A turn of the person's ended: its summary is to be written. */
export async function queueSummary(cell: CountCell, turn: string): Promise<void> {
  await update(cell, (current) => {
    const state = current ?? { count: 0 }
    return { ...state, writing: [...(state.writing ?? []).filter((queued) => queued !== turn), turn] }
  })
}

/** What a write that starts now continues: whether its turn is still wanted (a clear since would have taken it out), and the summary so far. */
export async function summaryFor(cell: CountCell, turn: string): Promise<{ wanted: boolean; previous: StoredSummary | null }> {
  const state = (await cell.get()).value
  return { wanted: state?.writing?.includes(turn) === true, previous: state?.summary ?? null }
}

/** A write of `turn`'s summary ended without a summary (or is no longer wanted): it is off the list, and nothing is owed to it. */
export async function dropSummary(cell: CountCell, turn: string): Promise<void> {
  await update(cell, (current) => {
    if (current === undefined) return { count: 0 }
    const { writing, owed, ...rest } = current
    const left = (writing ?? []).filter((queued) => queued !== turn)
    return { ...rest, ...(left.length === 0 ? {} : { writing: left }), ...(owed === undefined || owed === turn ? {} : { owed }) }
  })
}

/**
 * `turn`'s summary was written. It is kept (its last attempt marked unresolved when a message said so while it was
 * being written) unless the write is no longer wanted: false then.
 */
export async function landSummary(cell: CountCell, turn: string, summary: Summary): Promise<boolean> {
  const { before } = await replace(cell, (current) => {
    if (current === undefined || current.writing?.includes(turn) !== true) return current ?? { count: 0 }
    const { writing, owed, ...rest } = current
    const left = writing.filter((queued) => queued !== turn)
    return { ...rest, summary: { ...(owed === turn ? markLast(summary) : summary), turn }, ...(left.length === 0 ? {} : { writing: left }), ...(owed === undefined || owed === turn ? {} : { owed }) }
  })
  return before?.writing?.includes(turn) === true
}

/** The writes a reload of the mod lost: the turns still on the list that no write of this load is running. They are taken off it. */
export async function lostSummaries(cell: CountCell, running: ReadonlySet<string>): Promise<string[]> {
  const lost = (await cell.get()).value?.writing?.filter((turn) => !running.has(turn)) ?? []
  // Nothing lost: nothing is written (a session start finds this almost every time).
  if (lost.length === 0) return []
  await update(cell, (current) => {
    if (current?.writing === undefined) return current ?? { count: 0 }
    const { writing, owed, ...rest } = current
    const left = writing.filter((turn) => running.has(turn))
    return { ...rest, ...(left.length === 0 ? {} : { writing: left }), ...(owed !== undefined && !lost.includes(owed) ? { owed } : {}) }
  })
  return lost
}

/** Why a write of the summary made none: the cheap model could not be asked, answered with an error, a reply without words, or no reply in time, or said something that is no summary; or a reload of the mod lost the call. */
export type SummaryFailure =
  | 'lost'
  | { reason: 'refused'; detail: string }
  | { reason: 'api-error'; status: number | null; error: string }
  | { reason: 'empty-reply' }
  | { reason: 'aborted' }
  | { reason: 'unfit'; text: string }

/** A write that made no summary, as the log's decision: the summary stays as it was. */
export function summaryFailure(failure: SummaryFailure, model: string): Pick<Decided, 'outcome' | 'reason' | 'tone'> {
  const why =
    failure === 'lost'
      ? '热重载中断了正在写摘要的调用'
      : failure.reason === 'refused'
        ? `引擎拒绝了写摘要的模型 ${model}：${failure.detail}`
        : failure.reason === 'api-error'
          ? `写摘要的模型 ${model} 出错（状态码 ${failure.status ?? '无'}，${failure.error}）`
          : failure.reason === 'empty-reply'
            ? `写摘要的模型 ${model} 没有给出文字`
            : failure.reason === 'aborted'
              ? `写摘要的调用超过 ${SUMMARY_TIMEOUT_MS / 1000} 秒，或被中断`
              : `写摘要的模型 ${model} 的回答不是摘要的结构：「${failure.text}」`
  return { outcome: '摘要没写成', reason: `${why}；问题摘要保持原样`, tone: 'warn' }
}

const pct = (p: number) => `${Math.round(p * 100)}%`

/** What a judged answer did to the count, as the log's decision: the count's move in a few words, why, and the record the card draws. */
export function unresolvedDecision(judged: UnresolvedJudgement, moved: { before: number; count: number }): Pick<Decided, 'outcome' | 'reason' | 'tone' | 'conf' | 'unresolved'> {
  const p = judged.probabilities
  const t = judged.thresholds
  const odds = UNRESOLVED_OPTIONS.map((option) => `${OPTION_WORDS[option]} ${pct(p[option])}`).join(' · ')
  const crossed: UnresolvedOption = p.resolved >= t.reset ? 'resolved' : 'new_or_unrelated'
  const rule =
    judged.change === 'add'
      ? `仍未解决 ${pct(p.still_unresolved)} ≥ 加一门槛 ${pct(t.add)}，次数加一`
      : judged.change === 'reset'
        ? `${OPTION_WORDS[crossed]} ${pct(p[crossed])} ≥ 清零门槛 ${pct(t.reset)}，次数清零`
        : `仍未解决没到加一门槛 ${pct(t.add)}，已经解决、新问题或无关也没到清零门槛 ${pct(t.reset)}，次数不变`
  const conf = judged.confidence === null ? '没有' : judged.confidence.toFixed(2)
  const record: UnresolvedRecord = {
    before: moved.before,
    count: moved.count,
    change: judged.change,
    top: judged.top,
    probs: { ...p },
    ...(judged.confidence === null ? {} : { conf: judged.confidence }),
    thresholds: t,
  }
  return {
    outcome: judged.change === 'keep' ? `次数 ${moved.count}（不变）` : `次数 ${moved.before} → ${moved.count}`,
    reason: `${odds}；${rule}；置信度 ${conf}（只记录，不参与）`,
    tone: judged.change === 'keep' ? 'info' : 'ok',
    ...(judged.confidence === null ? {} : { conf: judged.confidence }),
    unresolved: record,
  }
}
