// The options the person set (userConfig), read once per load into what every
// feature receives: `ctx`. Pure: no `$`.
//
// Every option is read here, and only here: its bounds and its fallback are
// written once, and every feature (and the eval, which builds its requests
// from the same Config) reads the value from `ctx.config`. The fallbacks are
// the manifest's defaults (the engine fills those in; a test or the eval may
// leave an option out), except for the options whose default depends on the
// decision model: those have no default in the manifest, so the engine
// passes nothing for them until the person sets one, and their defaults are
// in BACKEND_DEFAULTS below, the one table the mod, the eval and
// scripts/decide*.ts read them from.

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

/** The decision models the person can choose (`decisionModel`). */
export type BackendName = 'jev' | 'clef'

/** The decision model the options choose: Jev unless they say clef (the engine reads a value outside the option's list as its default, jev). */
export function backendNameOf(options: PluginOptions): BackendName {
  return stringOf(options.decisionModel, 'jev') === 'clef' ? 'clef' : 'jev'
}

/** The options whose default depends on the decision model: the manifest gives them none. */
export const PER_BACKEND_OPTIONS = [
  'timeoutMs',
  'contextMessages',
  'contextTokens',
  'rejudgeSteps',
  'thetaUp',
  'thetaDown',
  'thetaMax',
  'thetaExpected',
  'agentOverride',
  'skillsMinRelevance',
  'findSkillMinRelevance',
] as const
export type PerBackendOption = (typeof PER_BACKEND_OPTIONS)[number]

/**
 * What one decision model brings: each option's default where the person left
 * it unset, the most `contextTokens` reads as, and whether skills are
 * suggested beside each message until the person flips it (`/dp skills
 * on|off`).
 */
export type BackendDefaults = Readonly<Record<PerBackendOption, number>> & {
  /** `contextTokens` above this reads as this. */
  contextTokensMax: number
  /** Whether the `skills` switch (suggestions beside each message, the listing withheld) starts on. */
  suggestSkills: boolean
}

/** Jev's: the values the eval of #4, #14, #15 and #16 set or kept (README, 配置 has the table; DEVELOPMENT.md, 配置 what each rests on). */
const JEV_DEFAULTS: BackendDefaults = {
  timeoutMs: 1500,
  contextMessages: 4,
  contextTokens: 2000,
  contextTokensMax: 16000,
  rejudgeSteps: 4,
  thetaUp: 0.4,
  thetaDown: 0.6,
  thetaMax: 0.5,
  thetaExpected: 0.25,
  agentOverride: 0.6,
  // #16, both runs on the old wording: from 0.7 to 0.75 the Chinese-English gap of the skill suggestions went from -3.7 to -2.3 points.
  skillsMinRelevance: 0.75,
  findSkillMinRelevance: 0.5,
  suggestSkills: true,
}

/**
 * The defaults by decision model: the only place they are written. Clef is
 * not calibrated (#17 ran no comparison, by the person's decision): it takes
 * Jev's values, except where Clef was measured.
 */
export const BACKEND_DEFAULTS: Readonly<Record<BackendName, BackendDefaults>> = {
  jev: JEV_DEFAULTS,
  clef: {
    ...JEV_DEFAULTS,
    // Clef answers in 0.6-1.4 s once the connection is up, and a cold connection's first request took 1.8 s (DEVELOPMENT.md, 待评测).
    timeoutMs: 3000,
    // Clef sometimes reads only the first ~2.1k tokens of a state (#17: 4 long states of 18 were cut there, plan 8.7), and the
    // newest messages and steps come last in it: 2000 estimated tokens (about 1.6-1.8k as Clef counts them) stay within that.
    contextTokensMax: 2000,
    // The skills' first stage, with every profile, took Clef 3.7-7.9 s (#16): past any wait a message can afford.
    suggestSkills: false,
  },
}

export type Config = {
  /** The decision model the options were read for: its defaults (BACKEND_DEFAULTS) stand for what the person left unset. */
  backend: BackendName
  /**
   * What came from that decision model's defaults (for the debug log, describeDefaults): the options the person left
   * unset, with the value each took, and an option set above that model's most, read as the most.
   */
  defaults: { used: readonly (readonly [PerBackendOption, number])[]; capped: readonly { option: PerBackendOption; set: number; read: number }[] }
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
    /** Whether the `skills` switch starts on (the decision model's default; `/dp skills on|off` flips it). */
    suggestByDefault: boolean
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
  const backend =
    config.backend === 'clef'
      ? clefBackend({ accountId: stringOf(options.cloudflareAccountId, '').trim(), apiToken: stringOf(options.cloudflareApiToken, '').trim() })
      : jevBackend(config.typesafeApiKey)
  return { config, backend, ask: DEFAULT_ASK }
}

/**
 * The person's options, each within its bounds; where one is missing or of
 * the wrong type, the manifest's default, or for an option whose default
 * depends on the decision model (PER_BACKEND_OPTIONS), that model's
 * (BACKEND_DEFAULTS). `contextTokens` reads at most that model's most.
 */
export function readConfig(options: PluginOptions): Config {
  const backend = backendNameOf(options)
  const defaults = BACKEND_DEFAULTS[backend]
  const used: (readonly [PerBackendOption, number])[] = []
  const capped: { option: PerBackendOption; set: number; read: number }[] = []
  /** A per-backend option: the person's value within [min, max], else the decision model's default (noted for the log). */
  const own = (option: PerBackendOption, min: number, max: number, round = false) => {
    const set = options[option]
    if (typeof set !== 'number' || !Number.isFinite(set)) {
      used.push([option, defaults[option]])
      return defaults[option]
    }
    const read = numberIn(set, min, max, defaults[option])
    const value = round ? Math.round(read) : read
    if (set > max) capped.push({ option, set, read: value })
    return value
  }
  const whole = (value: unknown, min: number, max: number, fallback: number) => Math.round(numberIn(value, min, max, fallback))
  const thetaMax = own('thetaMax', 0, 1)
  const context = { messages: own('contextMessages', 0, 32, true), tokens: own('contextTokens', 100, defaults.contextTokensMax, true) }
  const haikuToWritten = stringOf(options.escalateHaikuTo, 'sonnet').trim()
  const config: Config = {
    backend,
    defaults: { used, capped },
    typesafeApiKey: stringOf(options.typesafeApiKey, '').trim(),
    // A hook's own budget is 10 s and the timer's wait counts toward it.
    timeoutMs: own('timeoutMs', 200, 8000),
    thetaMax,
    context,
    midturn: {
      every: whole(options.rejudgeEvery, 0, 50, 3),
      waitMs: whole(options.rejudgeWaitMs, 0, 2000, 300),
      limits: { steps: own('rejudgeSteps', 1, 16, true), tokens: context.tokens },
      rules: {
        thetaUp: own('thetaUp', 0, 1),
        thetaDown: own('thetaDown', 0, 1),
        thetaMax,
        holdSteps: whole(options.holdSteps, 0, 50, 3),
      },
    },
    escalation: {
      after: whole(options.escalateAfter, 1, 20, 2),
      mode: RAISE_MODES.find((mode) => mode === options.escalateMode) ?? 'one-level',
      limit: whole(options.escalateLimit, 0, 10, 2),
      thetaExpected: own('thetaExpected', 0, 1),
      haikuTo: haikuToWritten === '' ? null : resolveModel(haikuToWritten),
      haikuToWritten,
    },
    agents: {
      models: options.agentFable === true ? [...DEFAULT_AGENT_MODELS, 'fable'] : DEFAULT_AGENT_MODELS,
      thetaOverride: own('agentOverride', 0, 1),
      workflowMode: stringOf(options.workflowMode, 'rewrite') === 'return' ? 'return' : 'rewrite',
    },
    skills: {
      suggestByDefault: defaults.suggestSkills,
      suggest: { max: whole(options.skillsMax, 0, 10, 3), minRelevance: own('skillsMinRelevance', 0, 1) },
      find: { max: whole(options.findSkillMax, 1, 10, 5), minRelevance: own('findSkillMinRelevance', 0, 1) },
      shortlist: whole(options.skillsShortlist, 1, 10, 4),
      alwaysListed: namesOf(options.skillsAlwaysListed),
      neverSuggested: namesOf(options.skillsNeverSuggested),
      profileModel: stringOf(options.skillsProfileModel, DEFAULT_PROFILE_MODEL).trim() || DEFAULT_PROFILE_MODEL,
      profilesPerSession: whole(options.skillsProfilesPerSession, 0, 500, 30),
    },
  }
  // In the table's order, whatever order they were read in.
  used.sort((a, b) => PER_BACKEND_OPTIONS.indexOf(a[0]) - PER_BACKEND_OPTIONS.indexOf(b[0]))
  return config
}

/**
 * One debug-log line on what the decision model's defaults decided, e.g.
 * `settings for clef: left unset, so clef's defaults: timeoutMs 3000, ...;
 * skill suggestions off until /dp skills on; contextTokens 4000 reads as 2000,
 * the most with clef`.
 */
export function describeDefaults(config: Pick<Config, 'backend' | 'defaults' | 'skills'>): string {
  const { backend, defaults } = config
  const used = defaults.used.length === 0 ? 'every option set' : `left unset, so ${backend}'s defaults: ${defaults.used.map(([option, value]) => `${option} ${value}`).join(', ')}`
  const skills = config.skills.suggestByDefault ? 'skill suggestions on until /dp skills off' : 'skill suggestions off until /dp skills on'
  const capped = defaults.capped.map((cap) => `; ${cap.option} ${cap.set} reads as ${cap.read}, the most with ${backend}`).join('')
  return `settings for ${backend}: ${used}; ${skills}${capped}`
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
