// The options the person set (userConfig), read once per load into what every
// feature receives: `ctx`. Pure: no `$`.
//
// Here go the options several features share (the decision model, its
// timeout, the context sent). An option only one feature reads is read in that
// feature's register, from `ctx.options`, with the helpers below.

import type { PluginOptions } from 'claude-code'
import type { Backend } from '../decision/backend.ts'
import { clefBackend } from '../decision/clef.ts'
import type { ContextLimits } from '../decision/context.ts'
import { DEFAULT_ASK, type EffortAsk } from '../decision/effort.ts'
import { jevBackend } from '../decision/jev.ts'

export type Config = {
  typesafeApiKey: string
  /** How long a decision request may take before the prompt goes on without it. */
  timeoutMs: number
  /** `max` only when its own probability reaches this. */
  thetaMax: number
  /** What the decision model reads of the conversation: how many recent messages, how many tokens in all. */
  context: ContextLimits
}

/** What the entry hands every feature's register: data and pure functions, never `$`. */
export type Ctx = {
  config: Config
  /** The decision model the person chose. */
  backend: Backend
  /** How effort questions are asked: eval variables, the spec's defaults in the mod. */
  ask: EffortAsk
  /** Every option as the engine passed it (defaults filled in), for a feature's own. */
  options: PluginOptions
}

export function setup(options: PluginOptions): Ctx {
  const config: Config = {
    typesafeApiKey: stringOf(options.typesafeApiKey, '').trim(),
    // A hook's own budget is 10 s and the timer's wait counts toward it.
    timeoutMs: numberIn(options.timeoutMs, 200, 8000, 1500),
    thetaMax: numberIn(options.thetaMax, 0, 1, 0.5),
    context: {
      messages: Math.round(numberIn(options.contextMessages, 0, 32, 4)),
      tokens: Math.round(numberIn(options.contextTokens, 100, 16000, 2000)),
    },
  }
  const backend =
    stringOf(options.decisionModel, 'jev') === 'clef'
      ? clefBackend({ accountId: stringOf(options.cloudflareAccountId, '').trim(), apiToken: stringOf(options.cloudflareApiToken, '').trim() })
      : jevBackend(config.typesafeApiKey)
  return { config, backend, ask: DEFAULT_ASK, options }
}

/** A numeric option clamped to [min, max]; `fallback` when it is not a number. */
export function numberIn(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

/** A string option; `fallback` when it is not a string. A sensitive one never set arrives as ''. */
export function stringOf(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}
