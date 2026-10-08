// What every eval suite shares: the mod's settings a decision reads, and the
// shape of a suite (how one dataset's items are asked of a backend and
// graded). The runner (runner.ts) and the metrics (metrics.ts) work with any
// suite; each kind of dataset brings its own (effort-submit.ts, and those of
// #14, #15 and #16 beside it, listed in suites.ts).
//
// Pure: no Node API.

import type { PluginOptions } from 'claude-code'
import type { Asked, Failure } from '../../hooks/decision/backend.ts'
import type { DecisionRequest } from '../../hooks/decision/system-one.ts'
import { CONTEXT_KINDS, readConfig, type BackendName, type Config, type ContextKind } from '../../hooks/core/setup.ts'
import type { Language } from './datasets.ts'
import type { VariantSummary } from './metrics.ts'
import type { Row } from './runner.ts'

/** The mod's settings: every option as the mod reads it (core/setup.ts `Config`). */
export type Settings = Config

/**
 * The mod's settings for the given options, read where the mod reads them
 * (`readConfig`: the same bounds and the same defaults), so a suite asks with
 * the limits the mod runs with. The eval passes the manifest's defaults and
 * the decision model under evaluation (`optionsFor`): what the manifest
 * leaves unset takes that model's defaults (core/setup.ts BACKEND_DEFAULTS, or the
 * `table` given: a test reads a decision model the table does not have yet).
 * Everything the table carries is read here: the budgets, the question asked beside a
 * message, the threshold for taking the level above, the most `contextMessages` may name.
 */
export function settingsFrom(options: PluginOptions, table?: Parameters<typeof readConfig>[1]): Settings {
  return readConfig(options, table)
}

/**
 * The settings with the state's budget set to `tokens` for every kind of request (a message's, the skills' request,
 * a mid-turn re-decision, a dispatched agent, a Workflow's agents). The mod's options only lower a budget
 * (`contextTokens` is the smaller of it and the model's); this widens it, to measure what a decision model with a
 * bigger window gains from a longer conversation (#43, `run.ts --state-tokens`). Not what the mod runs with.
 */
export function withStateTokens(settings: Settings, tokens: number): Settings {
  return {
    ...settings,
    context: { ...settings.context, tokens },
    contextByKind: Object.fromEntries(CONTEXT_KINDS.map((kind) => [kind, tokens])) as Record<ContextKind, number>,
    midturn: { ...settings.midturn, limits: { ...settings.midturn.limits, tokens } },
  }
}

/**
 * The settings with the number of recent messages the state may hold set to `messages` (the mod's own is at most the decision
 * model's, `contextMessagesMax`: with Jev the newest 32, whatever the token budget, so a state of 96000 tokens still stops at the 32nd message back). With
 * `withStateTokens` it lets a long conversation fill a large budget; not what the mod runs with (#44, `run.ts --state-messages`).
 */
export function withStateMessages(settings: Settings, messages: number): Settings {
  return { ...settings, context: { ...settings.context, messages } }
}

/**
 * The options a run or a script hands the mod for `backend` (`decisionModel`),
 * as the engine would: the manifest's defaults, then each `name=value`
 * (`optionsFrom`). The options whose default depends on the decision model
 * have none in the manifest, so `readConfig` gives them `backend`'s.
 */
export function optionsFor(backend: BackendName, userConfig: Readonly<Record<string, OptionSpec>>, assignments: readonly string[] = []): PluginOptions {
  return { ...optionsFrom(userConfig, assignments), decisionModel: backend }
}

/**
 * An option as the manifest (`userConfig` in .claude-plugin/plugin.json)
 * declares it, the parts the eval reads: its type and default (here), whether
 * it is sensitive (left out of result files, run.ts), and the default again
 * for the README's configuration table (docs.ts).
 */
export type OptionSpec = { type?: string; default?: unknown; sensitive?: boolean }

/**
 * The options a run hands the mod, as the engine would: each option's
 * default from the manifest, then each `name=value` (`--option`), read by the
 * type the manifest gives the option: a number, `true` or `false`, else the
 * text as written (a list of names takes them comma-separated, as the mod
 * reads such an option). Throws, saying why, for a name the manifest does not
 * have or a value its type cannot take.
 */
export function optionsFrom(userConfig: Readonly<Record<string, OptionSpec>>, assignments: readonly string[]): PluginOptions {
  const options: Record<string, string | number | boolean | readonly string[]> = {}
  for (const [name, spec] of Object.entries(userConfig)) {
    const value = spec.default
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') options[name] = value
    else if (Array.isArray(value)) options[name] = value.filter((entry): entry is string => typeof entry === 'string')
  }
  for (const assignment of assignments) {
    const [name, value] = assignment.split(/=(.*)/s, 2)
    if (!name || value === undefined) throw new Error(`--option takes name=value, not ${assignment}`)
    const spec = userConfig[name]
    if (spec === undefined) throw new Error(`no option "${name}" in the manifest`)
    if (spec.type === 'number') {
      if (value.trim() === '' || !Number.isFinite(Number(value))) throw new Error(`${name} takes a number, not ${JSON.stringify(value)}`)
      options[name] = Number(value)
    } else if (spec.type === 'boolean') {
      if (value !== 'true' && value !== 'false') throw new Error(`${name} takes true or false, not ${JSON.stringify(value)}`)
      options[name] = value === 'true'
    } else {
      options[name] = value
    }
  }
  return options
}

/** A variant's settings from a suite's table of them; throws, naming the variants there are, for a name not in it. */
export function variantIn<T>(table: Readonly<Record<string, T>>, name: string): T {
  const found = table[name]
  if (found === undefined) throw new RangeError(`no variant "${name}" (${Object.keys(table).join(', ')})`)
  return found
}

/** No decision, the request having failed: the row says how (`kind: detail`). */
export function requestFailed(failure: Failure): { ok: false; failure: string } {
  return { ok: false, failure: `${failure.kind}: ${failure.detail}` }
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

/** What the runner and the metrics read of any suite's item: its id and its tags (the long-context items have no English side, so no `en`). */
export type AnyItem = { id: string; tags: string[] }

/**
 * What a suite may read besides its items, from the machine the eval runs on
 * (the skill suite: the catalog and the profiles beside its dataset, the
 * skills' SKILL.md files). eval/node.ts provides it over Node's file system.
 */
export type SuiteHost = {
  /** A JSON file beside the dataset, parsed; undefined when there is none. */
  beside: (name: string) => unknown
  /** A text file by its path (`~` the home directory); rejects when it cannot be read. */
  read: (path: string) => Promise<string>
}

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
   * Optional: the requests an item may send at most, for a suite that asks
   * again once it has read an answer (the skill suite's second stage); the
   * estimate (eval/run.ts --estimate) counts them. Without it the estimate
   * counts what `decide` sends before any answer comes back.
   */
  estimate?: (item: I, language: Language, variant: string, settings: Settings) => Promise<readonly DecisionRequest[]>
  /**
   * Optional: what a suite built from more than its items read (SuiteHost),
   * recorded with the results; eval/run.ts prints its `warnings` (the skill
   * suite: SKILL.md files that differ from the catalog snapshot, skills
   * without a profile).
   */
  about?: Readonly<Record<string, unknown>> & { warnings?: readonly string[] }
  /**
   * Optional: the suite's own figures for one variant's answers, beside the
   * ones every suite gets (metrics.ts), saved in that variant's summary as
   * `breakdown` (`subagent`: where models came from, thresholds swept).
   */
  breakdown?: (items: readonly I[], rows: readonly Row<P>[], variant: string, settings: Settings) => Readonly<Record<string, unknown>>
  /** Optional: lines eval/run.ts prints about one variant's summary, after the figures every suite gets. */
  report?: (summary: VariantSummary) => string[]
  /** Optional: how an answer is scored, in words, recorded with the results (what a reader needs to read the numbers). */
  scoring?: string
  /** Optional: save a digest of each request's state in the result file (`stateDigest`), not the state: for a suite whose states are tens of thousands of tokens. */
  digestState?: boolean
  /** Optional: the languages its items are written in, which a run asks unless `--languages` says otherwise (both by default; eval-v2's conversations are Chinese only). */
  languages?: readonly Language[]
}
