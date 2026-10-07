// The unresolved count: the one module that writes it (`$.state` `unresolved`;
// GLOSSARY 未解决次数, ADR 0005). Two hooks reach it: the main-effort feature moves
// it by each message's answer, and the unresolved feature starts it over when the
// conversation ends. It only counts; the count is a basis for the decision model's
// judgment of effort, never a rule.
//
// Cells come in as closures (a `$` cannot cross a file), like the plan table's.

import { countAfter, UNRESOLVED_OPTIONS, type UnresolvedJudgement, type UnresolvedOption } from '../decision/unresolved.ts'
import { replace, update, type Cell } from './plans.ts'
import type { Decided, UnresolvedRecord } from './report.ts'

/** The stored count (`$.state` `unresolved`). */
export type CountCell = Cell<{ count: number }>

/** What the log and the card call the three options. */
export const OPTION_WORDS: Readonly<Record<UnresolvedOption, string>> = {
  still_unresolved: '仍未解决',
  resolved: '已经解决',
  new_or_unrelated: '新问题或无关',
}

/** The count before and after a change (a change that leaves it as it was is not written). */
export async function moveCount(cell: CountCell, change: UnresolvedJudgement['change']): Promise<{ before: number; count: number }> {
  if (change === 'keep') {
    const count = (await cell.get()).value?.count ?? 0
    return { before: count, count }
  }
  const { before, after } = await replace(cell, (current) => ({ count: countAfter(current?.count ?? 0, change) }))
  return { before: before?.count ?? 0, count: after.count }
}

/** A conversation that ends (`/clear`, a new session) starts the count over. */
export async function clearCount(cell: CountCell): Promise<void> {
  await update(cell, () => ({ count: 0 }))
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
