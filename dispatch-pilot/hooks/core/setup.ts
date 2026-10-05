// The options the person set (userConfig), read once per load into what every
// feature receives: `ctx`. Pure: no `$`.
//
// Every option is read here, and only here: its bounds and its fallback are
// written once, and every feature (and the eval, which builds its requests
// from the same Config) reads the value from `ctx.config`. The fallbacks are
// the manifest's defaults (the engine fills those in; a test or the eval may
// leave an option out).

import type { PluginOptions } from 'claude-code'
import type { Backend } from '../decision/backend.ts'
import { clefBackend } from '../decision/clef.ts'
import type { ContextLimits } from '../decision/context.ts'
import { DEFAULT_AGENT_MODELS, type AgentModel, type DispatchAsk, type DispatchSettings } from '../decision/dispatched-agent.ts'
import { DEFAULT_ASK, type EffortAsk } from '../decision/effort.ts'
import { RAISE_MODES, type RaiseMode } from '../decision/escalation.ts'
import { jevBackend } from '../decision/jev.ts'
import type { MidturnLimits, MidturnRules } from '../decision/midturn.ts'
import { resolveModel, type ResolvedModel } from '../decision/model-ids.ts'
import type { SkillPolicy } from '../decision/skills.ts'

export type Config = {
  typesafeApiKey: string
  /** How long a decision request may take before the prompt goes on without it. */
  timeoutMs: number
  /** `max` only when its own probability reaches this. */
  thetaMax: number
  /** What the decision model reads of the conversation: how many recent messages, how many tokens in all. */
  context: ContextLimits
  /** The main agent's effort decided again while a turn runs (#5); a stuck loop's re-decision (#7) reads its loop the same way. */
  midturn: {
    /** Re-decide at every step whose index is a multiple of this; 0 for never. */
    every: number
    /** How long a step waits for a re-decision (or a stuck one) not back yet. */
    waitMs: number
    /** What a re-decision reads: the latest steps, within the context budget. */
    limits: MidturnLimits
    /** How an answer moves the level: thetaUp, thetaDown, thetaMax, holdSteps. */
    rules: MidturnRules
  }
  /** Forced escalation (#7). */
  escalation: {
    /** Counted failures that make a loop stuck. */
    after: number
    mode: RaiseMode
    /** Forced raises a loop gets at most. */
    limit: number
    /** The failures count as expected when the answer reaches this probability. */
    thetaExpected: number
    /** The model a failing haiku agent is switched to, resolved to a full id; null: never switch (left empty, or a name no model family has). */
    haikuTo: ResolvedModel | null
    /** `escalateHaikuTo` as the person wrote it, for the log when it names no model. */
    haikuToWritten: string
  }
  /** Dispatched agents and a Workflow's agents (#6, #8, #9). */
  agents: {
    /** The models the decision model may choose, cheapest first (fable with `agentFable`). */
    models: readonly AgentModel[]
    /** The decision model's pick replaces the main agent's (or the script's) only at this confidence or above. */
    thetaOverride: number
    /** `rewrite` writes a Workflow's decisions into its script; `return` sends the Workflow back with them, once. */
    workflowMode: 'rewrite' | 'return'
  }
  /** Skills (#10, #11, #12). */
  skills: {
    /** What a message is suggested: at most `max`, from `minRelevance`. */
    suggest: SkillPolicy
    /** What find_skill returns: at most `max`, from `minRelevance`. */
    find: SkillPolicy
    /** How many of stage one's best stage two re-reads. */
    shortlist: number
    /** Skills the main agent keeps in its listing (names as the listing spells them). */
    alwaysListed: readonly string[]
    /** Skills never offered, to the main agent or to the person. */
    neverSuggested: readonly string[]
    /** The model that writes skill profiles; part of every profile's key. */
    profileModel: string
    /** How many missing profiles a session start writes at most. */
    profilesPerSession: number
  }
}

/** What the entry hands every feature's register: data and pure functions, never `$`. */
export type Ctx = {
  config: Config
  /** The decision model the person chose. */
  backend: Backend
  /** How effort questions are asked: eval variables, the spec's defaults in the mod. */
  ask: EffortAsk
}

export function setup(options: PluginOptions): Ctx {
  const config = readConfig(options)
  // One decision model or the other, as the person chose: only that one is built, and there is no fallback.
  // (The engine reads a value outside the option's list as the default, jev.)
  const backend =
    stringOf(options.decisionModel, 'jev') === 'clef'
      ? clefBackend({ accountId: stringOf(options.cloudflareAccountId, '').trim(), apiToken: stringOf(options.cloudflareApiToken, '').trim() })
      : jevBackend(config.typesafeApiKey)
  return { config, backend, ask: DEFAULT_ASK }
}

/** The person's options, each within its bounds, the manifest's default where one is missing or of the wrong type. */
export function readConfig(options: PluginOptions): Config {
  const whole = (value: unknown, min: number, max: number, fallback: number) => Math.round(numberIn(value, min, max, fallback))
  const thetaMax = numberIn(options.thetaMax, 0, 1, 0.5)
  const context = { messages: whole(options.contextMessages, 0, 32, 4), tokens: whole(options.contextTokens, 100, 16000, 2000) }
  const haikuToWritten = stringOf(options.escalateHaikuTo, 'sonnet').trim()
  return {
    typesafeApiKey: stringOf(options.typesafeApiKey, '').trim(),
    // A hook's own budget is 10 s and the timer's wait counts toward it.
    timeoutMs: numberIn(options.timeoutMs, 200, 8000, 1500),
    thetaMax,
    context,
    midturn: {
      every: whole(options.rejudgeEvery, 0, 50, 3),
      waitMs: whole(options.rejudgeWaitMs, 0, 2000, 300),
      limits: { steps: whole(options.rejudgeSteps, 1, 16, 4), tokens: context.tokens },
      rules: {
        thetaUp: numberIn(options.thetaUp, 0, 1, 0.4),
        thetaDown: numberIn(options.thetaDown, 0, 1, 0.6),
        thetaMax,
        holdSteps: whole(options.holdSteps, 0, 50, 3),
      },
    },
    escalation: {
      after: whole(options.escalateAfter, 1, 20, 2),
      mode: RAISE_MODES.find((mode) => mode === options.escalateMode) ?? 'one-level',
      limit: whole(options.escalateLimit, 0, 10, 2),
      thetaExpected: numberIn(options.thetaExpected, 0, 1, 0.25),
      haikuTo: haikuToWritten === '' ? null : resolveModel(haikuToWritten),
      haikuToWritten,
    },
    agents: {
      models: options.agentFable === true ? [...DEFAULT_AGENT_MODELS, 'fable'] : DEFAULT_AGENT_MODELS,
      thetaOverride: numberIn(options.agentOverride, 0, 1, 0.6),
      workflowMode: stringOf(options.workflowMode, 'rewrite') === 'return' ? 'return' : 'rewrite',
    },
    skills: {
      suggest: { max: whole(options.skillsMax, 0, 10, 3), minRelevance: numberIn(options.skillsMinRelevance, 0, 1, 0.7) },
      find: { max: whole(options.findSkillMax, 1, 10, 5), minRelevance: numberIn(options.findSkillMinRelevance, 0, 1, 0.5) },
      shortlist: whole(options.skillsShortlist, 1, 10, 4),
      alwaysListed: namesOf(options.skillsAlwaysListed),
      neverSuggested: namesOf(options.skillsNeverSuggested),
      profileModel: stringOf(options.skillsProfileModel, DEFAULT_PROFILE_MODEL).trim() || DEFAULT_PROFILE_MODEL,
      profilesPerSession: whole(options.skillsProfilesPerSession, 0, 500, 30),
    },
  }
}

/**
 * How an agent's model and effort are decided (decision/dispatched-agent.ts):
 * the same for a dispatched agent (#6) and a Workflow's agents (#8, #9), and
 * for the eval; `ask` is how its questions are written (the eval's variants).
 */
export function dispatchSettings(ctx: { config: Pick<Config, 'agents' | 'thetaMax'>; ask: EffortAsk }, ask: Partial<DispatchAsk> = {}): DispatchSettings {
  return { models: ctx.config.agents.models, ask: { ...ctx.ask, ...ask }, thetaOverride: ctx.config.agents.thetaOverride, thetaMax: ctx.config.thetaMax }
}

/** The cheap model that writes skill profiles, unless the person names another (`skillsProfileModel`). */
export const DEFAULT_PROFILE_MODEL = 'haiku'

/** A numeric option clamped to [min, max]; `fallback` when it is not a number. */
export function numberIn(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

/** A string option; `fallback` when it is not a string. A sensitive one never set arrives as ''. */
export function stringOf(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** A list-of-names option (`multiple` in the manifest; a comma-separated string also reads): trimmed, empty ones dropped. */
export function namesOf(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return items.flatMap((item) => (typeof item === 'string' && item.trim() !== '' ? [item.trim()] : []))
}
