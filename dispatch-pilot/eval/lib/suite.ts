// What every eval suite shares: the mod's settings a decision reads, and the
// shape of a suite (how one dataset's items are asked of a backend and
// graded). The runner (runner.ts) and the metrics (metrics.ts) work with any
// suite; each kind of dataset brings its own (effort-submit.ts, and those of
// #14, #15 and #16 beside it, listed in suites.ts).
//
// Pure: no Node API.

import type { PluginOptions } from 'claude-code'
import type { Asked } from '../../hooks/decision/backend.ts'
import type { DecisionRequest } from '../../hooks/decision/system-one.ts'
import { setup, type Config } from '../../hooks/core/setup.ts'
import type { Item, Language } from './datasets.ts'
import type { VariantSummary } from './metrics.ts'
import type { Row } from './runner.ts'

/**
 * The mod's settings: what every feature shares (`Config`), and the options
 * themselves, for a suite whose feature reads its own (subagent:
 * `agentOverride`, `agentFable`; effort-midturn: `rejudgeSteps` and the
 * mid-turn thresholds).
 */
export type Settings = Config & { options: PluginOptions }

/**
 * The mod's settings for the given options, read the way the mod reads them
 * (`setup`: the same defaults and the same clamping), so a suite asks with
 * the limits the mod runs with. The eval passes the manifest's defaults.
 */
export function settingsFrom(options: PluginOptions): Settings {
  return { ...setup(options).config, options }
}

/** One request a suite sent: the backend's outcome, how long the answered attempt took, how many attempts it took. */
export type Sent = { request: DecisionRequest; asked: Asked; ms: number; attempts: number }

/** Sends one decision request to the backend under evaluation (the runner's: timing, retries, the network). */
export type Ask = (request: DecisionRequest) => Promise<Sent>

/** A suite's decision on one item in one language: what it would do, or why there was none. */
export type Decided<P> = { ok: true; prediction: P; detail?: Readonly<Record<string, unknown>> } | { ok: false; failure: string }

/**
 * How a prediction scores: `correct` when it is acceptable, `exact` when it
 * is the gold answer, and for a wrong one, which way it missed (a suite's
 * own words, such as `under` and `over` for effort). A prediction made of
 * several decisions can score each on its own (`parts`, such as a dispatched
 * agent's `model` and `effort`); `correct` is then the whole answer.
 */
export type Grade = { correct: boolean; exact: boolean; miss?: string; parts?: Readonly<Record<string, boolean>> }

export type AnyItem = Item<unknown, unknown, unknown>

export type Suite<I extends AnyItem, P> = {
  /** The dataset it reads: eval/datasets/<name>.jsonl. */
  name: string
  /** The ways it can ask (eval variables), by name; the first is how the mod asks today. */
  variants: readonly string[]
  /** Asks about one item in one language, through `ask`, exactly as the mod would. */
  decide: (item: I, language: Language, variant: string, ask: Ask, settings: Settings) => Promise<Decided<P>>
  grade: (item: I, prediction: P) => Grade
  /** A prediction as text: equal texts are the same decision (zh and en agree), and the results show it. */
  show: (prediction: P) => string
  /** The answers a suite would score by always giving one of them, reported beside its accuracy. */
  constants: readonly P[]
  /** Optional: baselines whose answer depends on the item (effort-midturn: keep the current level), by name; scored and reported with the constants. */
  baselines?: Readonly<Record<string, (item: I) => P>>
  /** The questions a variant asks, recorded with the results (what a prompt change changes). */
  questions: (variant: string) => unknown
  /**
   * Optional: the suite's own figures for one variant's answers, beside the
   * ones every suite gets (metrics.ts), saved in that variant's summary as
   * `breakdown` (subagent: where models came from, thresholds swept).
   */
  breakdown?: (items: readonly I[], rows: readonly Row<P>[], variant: string, settings: Settings) => Readonly<Record<string, unknown>>
  /** Optional: lines eval/run.ts prints about one variant's summary, after the figures every suite gets. */
  report?: (summary: VariantSummary) => string[]
  /** Optional: how an answer is scored, in words, recorded with the results (what a reader needs to read the numbers). */
  scoring?: string
}
