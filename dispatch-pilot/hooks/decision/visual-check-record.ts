// What a visual_check call leaves for people (#58, ADR 0008): the record the decision log keeps of it, and the words the board, the
// log and the rationale card use for it. For the model's side (the tool's answer) see visual-check-tool.ts; this is the person's,
// so it is in Chinese. Pure (see system-one.ts).
//
// The record holds paths, verdicts, probabilities and times, and never an image's bytes, a key or the specification's text.

import type { CheckResult, Comparison, Verdict } from './visual-check.ts'

/**
 * One check as the log keeps it. `zoomed`: its verdict rests on the zoomed re-check of the part (#59), not on the whole image. `why`:
 * for an unsure verdict, the reason (as the tool tells the agent). `pair`: in a series of quality levels (#61) a check is made on
 * each two neighbouring levels, and this is which two, counted from 1.
 */
export type CheckRecord = { part: string; property: string; verdict: Verdict; probability: number | null; zoomed: boolean; why?: string; pair?: [number, number] }

/** What the screenshot was checked against: the kind, and the paths of the images it was compared with (none for a spec). */
export type AgainstRecord = { kind: Comparison['kind']; paths: string[] }

/** One call of visual_check, as the decision log keeps it. */
export type VisualCheckRecord = {
  /** The screenshot's path. */
  image: string
  against: AgainstRecord
  /** The decision model that took the images (`jev`, `pplx`). */
  backend: string
  checks: CheckRecord[]
  /** Whether any verdict rests on the zoomed re-check. */
  zoomed: boolean
  /** How long the call took, ms (the images read and sized, the requests). */
  ms: number
}

/** How many checks of a loop passed, failed, or got no verdict to trust; `takeovers`: the images the screenshot takeover kept from the agent (#62). */
export type CheckTally = { passed: number; failed: number; unsure: number; takeovers?: number }

/** The paths a comparison names besides the screenshot. */
function pathsOf(comparison: Comparison): string[] {
  return comparison.kind === 'reference' ? [...comparison.paths] : comparison.kind === 'compare_to' ? [comparison.path] : []
}

/** The record of a call from what it found. */
export function recordOf(call: { image: string; comparison: Comparison; backend: string; results: readonly CheckResult[]; ms: number }): VisualCheckRecord {
  const checks = call.results.map((result): CheckRecord => ({
    part: result.check.part,
    property: result.check.property,
    verdict: result.verdict,
    probability: result.probability,
    zoomed: result.basis === 'zoom',
    ...(result.why === undefined ? {} : { why: result.why }),
  }))
  return { image: call.image, against: { kind: call.comparison.kind, paths: pathsOf(call.comparison) }, backend: call.backend, checks, zoomed: checks.some((check) => check.zoomed), ms: Math.max(0, Math.round(call.ms)) }
}

/**
 * The record of a series of quality levels (#61): the first level is the call's image, `against.paths` are all the levels in order,
 * and each pair of neighbours has its checks, in the order of the pairs (a series that could not be read has one set of checks, of no pair).
 */
export function seriesRecordOf(call: { levels: readonly string[]; backend: string; pairs: readonly { from?: number; to?: number; results: readonly CheckResult[] }[]; ms: number }): VisualCheckRecord {
  const checks = call.pairs.flatMap((pair) => recordOf({ image: '', comparison: { kind: 'sequence' }, backend: call.backend, results: pair.results, ms: 0 }).checks.map((check): CheckRecord => ({ ...check, ...(pair.from === undefined || pair.to === undefined ? {} : { pair: [pair.from, pair.to] as [number, number] }) })))
  return { image: call.levels[0] ?? '', against: { kind: 'sequence', paths: [...call.levels] }, backend: call.backend, checks, zoomed: checks.some((check) => check.zoomed), ms: Math.max(0, Math.round(call.ms)) }
}

/** How many of the checks came out each way. */
export function tallyOf(checks: readonly { verdict: Verdict }[]): CheckTally {
  const count = (verdict: Verdict) => checks.filter((check) => check.verdict === verdict).length
  return { passed: count('pass'), failed: count('fail'), unsure: count('unsure') }
}

export const VERDICT_WORDS: Readonly<Record<Verdict, string>> = { pass: '过', fail: '不过', unsure: '没把握' }

const percent = (p: number) => `${Math.round(p * 100)}%`

/** The count in the person's words, for the board's row and the log: `核对 3：1 过 · 1 不过 · 1 没把握`, then `· 接管 n` when the takeover kept some images. */
export function tallyText(tally: CheckTally): string {
  const total = tally.passed + tally.failed + tally.unsure
  const base = `核对 ${total}：${tally.passed} 过 · ${tally.failed} 不过 · ${tally.unsure} 没把握`
  if (tally.takeovers === undefined || tally.takeovers === 0) return base
  // An agent whose images were taken over and who has made no check yet: only the takeover's count (#62).
  return total === 0 ? `接管 ${tally.takeovers}` : `${base} · 接管 ${tally.takeovers}`
}

/** One check in the person's words: `the title · is fully visible 过 97%（整图）`. */
export function checkWords(check: CheckRecord): string {
  const level = check.pair === undefined ? '' : `档 ${check.pair[0]}→${check.pair[1]} · `
  const named = `${level}${check.part === '' ? check.property : `${check.part} · ${check.property}`}`
  const odds = check.probability === null ? '' : ` ${percent(check.probability)}`
  return `${named} ${VERDICT_WORDS[check.verdict]}${odds}（${check.zoomed ? '放大复核' : '整图'}）`
}

/** The log entry's outcome: the call's count. */
export function outcomeText(record: VisualCheckRecord): string {
  return tallyText(tallyOf(record.checks))
}

/** The log entry's reason: each check's verdict, then how long the call took and whether the zoomed re-check was done. */
export function reasonText(record: VisualCheckRecord): string {
  const seconds = (record.ms / 1000).toFixed(1)
  return `${record.checks.map(checkWords).join('；')}；${record.zoomed ? '做了放大复核' : '没有放大复核'}，用时 ${seconds} 秒`
}

/** What the screenshot was checked against, in the person's words. */
export function againstWords(against: AgainstRecord): string {
  switch (against.kind) {
    case 'reference':
      return `对参考图 ${against.paths.join('、')}`
    case 'compare_to':
      return `对另一张截图 ${against.paths.join('、')}`
    case 'sequence':
      return '对一串档位'
    case 'spec':
      return '对文字规范'
  }
}
