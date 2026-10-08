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
import type { ContextLimits } from '../decision/context.ts'
import { DEFAULT_AGENT_MODELS, type AgentModel, type DispatchAsk, type DispatchSettings } from '../decision/dispatched-agent.ts'
import type { EffortAsk, EffortRules } from '../decision/effort.ts'
import { RAISE_MODES, type RaiseMode } from '../decision/escalation.ts'
import { jevBackend } from '../decision/jev.ts'
import type { MidturnLimits, MidturnRules } from '../decision/midturn.ts'
import { resolveModel, type ResolvedModel } from '../decision/model-ids.ts'
import { pplxBackend } from '../decision/pplx.ts'
import type { SkillPolicy } from '../decision/skills.ts'

/** The decision models the person can choose (`decisionModel`): Perplexity's pplx-decider and TypeSafe's Jev. */
export type BackendName = 'pplx' | 'jev'

/**
 * The decision model the person asked for: Jev when `decisionModel` names it, else pplx, the default (ADR 0006). Anything
 * that names neither (unset, a typo, the `clef` of a 0.3.x configuration) reads as unset. Which one decides in the end also
 * depends on the keys (`chooseBackend`).
 */
export function backendNameOf(options: PluginOptions): BackendName {
  return options.decisionModel === 'jev' ? 'jev' : 'pplx'
}

/** Which decision model decides, and whether it is not the one asked for. */
export type Choice = { backend: BackendName; fellBack: boolean }

/**
 * The decision model that decides (ADR 0006). Jev when the person asked for Jev. Otherwise pplx when there is a Perplexity key;
 * with none, Jev when there is a TypeSafe key (`fellBack`: a 0.3.1 configuration keeps its routing); with neither, pplx, which
 * then fails every request with the Perplexity key named as the one missing.
 */
export function chooseBackend(asked: BackendName, keys: { perplexity: string; typesafe: string }): Choice {
  if (asked === 'jev') return { backend: 'jev', fellBack: false }
  if (keys.perplexity !== '') return { backend: 'pplx', fellBack: false }
  return keys.typesafe !== '' ? { backend: 'jev', fellBack: true } : { backend: 'pplx', fellBack: false }
}

/**
 * A `decisionModel` that names a decision model since removed (Clef, 0.4.0), left in the person's settings from before.
 * The engine reads a value outside the option's list as the option's default (and warns), so the mod is handed the
 * default, never the old value: this finds it in the settings file itself (`pluginConfigs[dispatch-pilot@...].options`,
 * as `$.settings.read({ source: 'user' })` returns them). Null when the settings name none.
 */
export function removedDecisionModel(settings: unknown): 'clef' | null {
  const configs = (settings as { pluginConfigs?: unknown } | null | undefined)?.pluginConfigs
  if (typeof configs !== 'object' || configs === null) return null
  for (const [plugin, config] of Object.entries(configs)) {
    if (!plugin.startsWith('dispatch-pilot@')) continue
    const options = (config as { options?: unknown } | null)?.options
    if (typeof options === 'object' && options !== null && (options as { decisionModel?: unknown }).decisionModel === 'clef') return 'clef'
  }
  return null
}

/** The options whose default depends on the decision model: the manifest gives them none. */
export const PER_BACKEND_OPTIONS = [
  'timeoutMs',
  'contextMessages',
  'contextTokens',
  'rejudgeSteps',
  'rejudgeWaitMs',
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
 * The kinds of request whose state has a budget of its own (`contextTokens`
 * reads by kind): a message that carries the skills' question (and find_skill's
 * first stage) is `Config.context`; the rest are these. `rejudge` is a
 * mid-turn re-decision and a stuck one.
 */
export const CONTEXT_KINDS = ['messagePlain', 'rejudge', 'agent', 'workflow'] as const
export type ContextKind = (typeof CONTEXT_KINDS)[number]

/**
 * What one decision model brings: each option's default where the person left
 * it unset, the most `contextTokens` and `contextMessages` read as, how every
 * question is asked, the threshold for taking the level above, and whether skills are
 * suggested beside each message until the person flips it (`/dp skills
 * on|off`). A new decision model is one more entry of BACKEND_DEFAULTS, a column in the README's
 * configuration tables and one line in eval/lib/docs.ts BACKENDS: the rest reads the table.
 */
export type BackendDefaults = Readonly<Record<PerBackendOption, number>> & {
  /** `contextTokens` above this reads as this. */
  contextTokensMax: number
  /** `contextMessages` above this reads as this. */
  contextMessagesMax: number
  /**
   * The least probability the level above the most probable one needs to be taken instead (`EffortRules.roundUp`, decision/effort.ts).
   * Not an option: set from the stored answers of the decision model (eval/resummarize.ts), like the other values of the table.
   */
  roundUp: number
  /**
   * How the decision model is asked, language and kind of question (the eval's variables, `effort-submit` for the effort question
   * beside a message): `turnStart` for that question, `other` for every other one (the mid-turn re-decision, a dispatched agent
   * and a Workflow's, a stuck loop, the skills, the problem summary's text). Not options.
   */
  ask: { turnStart: EffortAsk; other: EffortAsk }
  /**
   * What the state of each other kind of request may take, in estimated tokens (`contextTokens` is the message that carries the
   * skills' question). Not options: each is the most that kind's longest question leaves, worked out in DEVELOPMENT.md (配置,
   * 「Jev 的上下文默认值怎么算」) and checked by tests/backend-defaults.test.ts. What the person sets as `contextTokens` holds for
   * every kind, each taking the smaller of it and its own.
   */
  contextByKind: Readonly<Record<ContextKind, number>>
  /** Whether the `skills` switch (suggestions beside each message, the listing withheld) starts on. */
  suggestSkills: boolean
  /**
   * How long find_skill's two requests may take in all, in ms; null: as long
   * as a message waits (`timeoutMs`). Not an option: set by the latency
   * measured, not calibrated. A hook has 10 s of its own, and the timer's wait
   * counts toward it (the mods reference, Limits): this leaves room for the rest.
   */
  findSkillWaitMs: number | null
  /** Whether find_skill's first request offers a skill by its profile (else by its description); the second re-reads it by both. */
  findSkillProfiles: boolean
}

/**
 * Jev's: the values the eval of #4, #14, #15 and #16 set or kept (README, 配置 has the table; DEVELOPMENT.md, 配置 what each rests on),
 * except the three that say how much Jev reads of the conversation: by the person's decision ("the more it is given, the
 * better it judges"), those are set to what Jev accepts, not to what the eval ran (4 messages, 2000 tokens, 4 steps; the
 * eval sets are too short to tell, and no comparison was run). Jev takes 64k tokens a request and 32k for "the state and
 * the longest question". The longest question is the first stage of the skills (111 skills with profiles: about 16k tokens
 * as the mod counts, 21.9k as Jev does), which shares its request with the state, so `contextTokens` is what that leaves,
 * 6000 (DEVELOPMENT.md, 配置, 「Jev 的上下文默认值怎么算」; tests/backend-defaults.test.ts checks the sum). The two counts
 * that fill it are at their most: `contextMessages` 32 and `rejudgeSteps` 16, so the token budget, not the count, ends what is sent.
 */
const JEV_DEFAULTS: BackendDefaults = {
  timeoutMs: 1500,
  contextMessages: 32,
  contextMessagesMax: 32,
  contextTokens: 6000,
  contextTokensMax: 16000,
  // Every other kind of request has questions of at most 700 tokens as Jev counts them (the effort question 421, a re-decision's
  // 295 with its trouble, an agent's 457, nine of them 1,836): the state plus the longest of them within 28,800 (90% of 32k)
  // allows about 25,400 estimated tokens, and 24000 is the round number below it. A Workflow batch (at most 8 agents' questions,
  // 20,100 in all) and the whole request stay within 57,600 (90% of 64k) too.
  contextByKind: { messagePlain: 24000, rejudge: 24000, agent: 24000, workflow: 24000 },
  rejudgeSteps: 16,
  // A step waits this long for a re-decision not yet back before it goes on at the level it had: Jev's mid-turn requests took about 280 ms
  // at p50 and 350 ms at p90 (DEVELOPMENT.md, 配置), and they are sent when the step's tools start, so they are mostly back by then.
  rejudgeWaitMs: 300,
  // Raising is easy, lowering is hard (AA: a Sonnet 5.5 at medium scores 41 on the index and at high 47, at low 36; Terminal-Bench
  // 20.7% at low against 43.9% at high): 0.4 to 0.3 for a raise, 0.6 to 0.75 for a lowering, 3 to 5 steps held after a raise.
  // The lowering gate came back down to 0.55 in 0.2.3: with 0.75 the level sent was too high too often (too high 11.5/11.0% to
  // 19.5/17.5%); a scan of the stored effort-midturn answers (eval/rescore.ts --theta-down) found none of 0.55 to 0.75 to bring it back, and 0.55 is the one with the least too high and too low together.
  thetaUp: 0.3,
  thetaDown: 0.55,
  thetaMax: 0.5,
  thetaExpected: 0.25,
  agentOverride: 0.6,
  // #16, both runs on the old wording: from 0.7 to 0.75 the Chinese-English gap of the skill suggestions went from -3.7 to -2.3 points.
  skillsMinRelevance: 0.75,
  findSkillMinRelevance: 0.5,
  suggestSkills: true,
  findSkillWaitMs: null,
  findSkillProfiles: true,
  // Raising is easy (DEVELOPMENT.md, 「按 AA 基准校正」): the level above the most probable one is taken from 0.3.
  roundUp: 0.3,
  // effort-submit on the current wording, one run each (2026-10-05): asked in Chinese, Chinese items 85% and English
  // items 89%; asked in English, 79% and 78%. The questions asked later have no data in Chinese and stay in English.
  ask: { turnStart: { language: 'zh', primitive: 'score' }, other: { language: 'en', primitive: 'score' } },
}

/**
 * pplx-decider-v1.1-27b's: B′ of eval v2 (#45, ADR 0006: the state within 48000 tokens, every question in English, no problem
 * summary), with the thresholds calibrated on its own stored answers (DEVELOPMENT.md, eval v2 的结果). It takes a 262k-token
 * window, so what it reads is not cut to Jev's 32k: 2000 messages (the budget, not the count, ends what is sent) and 48000
 * tokens for every request but the skills'; those two stages keep Jev's 6000, since the profiles of the skills are the same
 * length for either model. A request takes seconds, not Jev's fraction of one, so a message waits 8000 ms (a hook has 10 s) and a
 * step 6000 ms for a re-decision. What the eval did not calibrate for pplx (the failure bar, the agents' override, the skills'
 * relevance) is Jev's.
 */
const PPLX_DEFAULTS: BackendDefaults = {
  timeoutMs: 8000,
  contextMessages: 2000,
  contextMessagesMax: 2000,
  contextTokens: 6000,
  contextTokensMax: 48000,
  contextByKind: { messagePlain: 48000, rejudge: 48000, agent: 48000, workflow: 48000 },
  rejudgeSteps: 16,
  // A re-decision takes seconds, not 300 ms: a step waits for it up to this long (the most the manifest allows is 8000).
  rejudgeWaitMs: 6000,
  // Calibrated offline on the stored pplx answers (eval v2, DEVELOPMENT.md): thetaMax 0.47 (0.48 sits on submit-034's p(max) of
  // 0.480), thetaDown 0.55 as Jev's (from 0.6 up, the English score question sends the level too high more often than Jev).
  // thetaUp 0 raises a level mid-turn on any answer above it (0.3 is the cautious alternative); it does not move the level a
  // message is sent at, which thetaMax and roundUp decide.
  thetaUp: 0,
  thetaDown: 0.55,
  thetaMax: 0.47,
  thetaExpected: 0.25,
  agentOverride: 0.6,
  skillsMinRelevance: 0.75,
  findSkillMinRelevance: 0.5,
  suggestSkills: true,
  // Find_skill's two requests wait as long as the profiles' question takes (a message's wait would be 8000 ms of a 10 s hook).
  findSkillWaitMs: 6000,
  findSkillProfiles: true,
  // The level above the most probable one is taken from 0.45 (ADR 0006): the offline scan of the stored effort-submit answers
  // (English questions) took the level sent too high from 18.5% to 13.0% with the recall of max unchanged (11 of 16); eval v2's
  // level too low went from 12.5% to 15.0%.
  roundUp: 0.45,
  ask: { turnStart: { language: 'en', primitive: 'score' }, other: { language: 'en', primitive: 'score' } },
}

/** The defaults by decision model: the only place they are written. */
export const BACKEND_DEFAULTS: Readonly<Record<BackendName, BackendDefaults>> = {
  pplx: PPLX_DEFAULTS,
  jev: JEV_DEFAULTS,
}

/**
 * What the state of a message's decision request may take: the message that
 * carries the skills' question (`withSkills`) has `context`, whose tokens
 * leave room for that question; the effort question's request, and any other
 * plain message, has `contextByKind.messagePlain` (ADR 0005). The core and the
 * eval build the request's state from the same limits.
 */
export function messageLimits(config: Pick<Config, 'context' | 'contextByKind'>, withSkills: boolean): ContextLimits {
  return withSkills ? config.context : { ...config.context, tokens: config.contextByKind.messagePlain }
}

/** The settings are also the effort rules' parameters (`EffortRules`: `thetaMax` and `roundUp`): `traceEffort(reading, config)`. */
export type Config = EffortRules & {
  /** The decision model the options were read for: its defaults (BACKEND_DEFAULTS) stand for what the person left unset. */
  backend: BackendName
  /**
   * What came from that decision model's defaults (for the debug log, describeDefaults): the options the person left
   * unset, with the value each took, and an option set above that model's most, read as the most.
   */
  defaults: { used: readonly (readonly [PerBackendOption, number])[]; capped: readonly { option: PerBackendOption; set: number; read: number }[] }
  typesafeApiKey: string
  /** The Perplexity key in the options (`perplexityApiKey`, trimmed; '' if unset): the environment's (`Secrets`) stands where this is empty. */
  perplexityApiKey: string
  /** How long a decision request may take before the prompt goes on without it. */
  timeoutMs: number
  /** How the decision model is asked (BACKEND_DEFAULTS ask): `turnStart` the effort question beside each message, `other` every other question (`ctx.ask`). */
  ask: { turnStart: EffortAsk; other: EffortAsk }
  /**
   * What the decision model reads of the conversation: how many recent messages, how many tokens in all. The tokens are the
   * budget of a message that carries the skills' question (and of find_skill's first stage); the other kinds of request have
   * theirs in `contextByKind` (a mid-turn re-decision's in `midturn.limits`, too).
   */
  context: ContextLimits
  /** The tokens the state of each other kind of request may take: the decision model's default for the kind, or what the person set if smaller. */
  contextByKind: Readonly<Record<ContextKind, number>>
  /** The main agent's effort decided again while a turn runs (#5); a stuck loop's re-decision (#7) reads its loop the same way. */
  midturn: {
    /** Re-decide at every step whose index is a multiple of this; 0 for never. */
    every: number
    /** How long a step waits for a re-decision (or a stuck one) not back yet. */
    waitMs: number
    /** What a re-decision reads: the latest steps, within the context budget. */
    limits: MidturnLimits
    /** How an answer moves the level: thetaUp, thetaDown, thetaMax, roundUp, holdSteps. */
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
    /** How long find_skill's two requests may take in all (the decision model's: BACKEND_DEFAULTS findSkillWaitMs). */
    findWaitMs: number
    /** Whether find_skill's first request offers skills by their profiles (the decision model's: findSkillProfiles). */
    findByProfile: boolean
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
  /** The unresolved count and the problem summary (#39, #40). */
  unresolved: {
    /** The model that writes the problem summary after each of the person's turns (`summaryModel`). */
    summaryModel: string
    /** The count from which the effort question of a message and of a mid-turn re-decision carries the strong hint (`unresolvedMaxAfter`; 0: never). */
    maxAfter: number
  }
}

/**
 * What the mod reads from the environment: `$.env.get` is asynchronous and needs `$`, which neither `setup` nor an import may
 * have, so the session start (features/control.ts) reads it into this object, which `ctx.backend` reads when it asks. A
 * value set in the options always comes first. Nothing here is ever written down: not to the debug log, the board or `$.state`.
 */
export type Secrets = {
  /** `PERPLEXITY_API_KEY`, trimmed; '' while unread or unset. */
  perplexityEnvKey: string
}

/** The Perplexity key in use: the options' (`perplexityApiKey`) first, else the environment's. '' for none. */
export function perplexityKey(config: Pick<Config, 'perplexityApiKey'>, secrets: Secrets): string {
  return config.perplexityApiKey !== '' ? config.perplexityApiKey : secrets.perplexityEnvKey
}

/**
 * What the entry hands every feature's register: data and pure functions, never `$`.
 *
 * Which decision model decides is not known at register: the Perplexity key may be in the environment, which the session start
 * reads (`secrets`). `config`, `backend`, `ask` and `fellBack` are therefore read afresh at each use and follow the choice: a
 * feature that keeps a value from `ctx.config` when it registers keeps the wrong model's (the defaults differ), so it reads
 * `ctx.config` where it acts.
 */
export type Ctx = {
  /** The settings of the decision model that decides (`chooseBackend`). */
  readonly config: Config
  /** The decision model that decides. */
  readonly backend: Backend
  /** What the session start read from the environment (a key not in the options). */
  readonly secrets: Secrets
  /** How every question but the effort question beside a message is asked: the decision model's (`config.ask.other`). */
  readonly ask: EffortAsk
  /** Whether Jev decides only because there is no Perplexity key (a TypeSafe key is set): the session start records it. */
  readonly fellBack: boolean
}

export function setup(options: PluginOptions, table: Readonly<Record<BackendName, BackendDefaults>> = BACKEND_DEFAULTS): Ctx {
  const asked = backendNameOf(options)
  // Both are worked out here, whichever decides: pure and cheap, and `chooseBackend` picks between them once the environment is read.
  const configs: Record<BackendName, Config> = { pplx: readConfig(options, table, 'pplx'), jev: readConfig(options, table, 'jev') }
  const secrets: Secrets = { perplexityEnvKey: '' }
  const backends: Record<BackendName, Backend> = {
    pplx: pplxBackend(() => perplexityKey(configs.pplx, secrets)),
    jev: jevBackend(configs.jev.typesafeApiKey),
  }
  const choice = () => chooseBackend(asked, { perplexity: perplexityKey(configs.pplx, secrets), typesafe: configs.pplx.typesafeApiKey })
  return {
    get config() {
      return configs[choice().backend]
    },
    get backend() {
      return backends[choice().backend]
    },
    secrets,
    get ask() {
      return configs[choice().backend].ask.other
    },
    get fellBack() {
      return choice().fellBack
    },
  }
}

/**
 * The person's options, each within its bounds; where one is missing or of
 * the wrong type, the manifest's default, or for an option whose default
 * depends on the decision model (PER_BACKEND_OPTIONS), that model's
 * (`table`, BACKEND_DEFAULTS unless a test reads another). `contextTokens`
 * and `contextMessages` read at most that model's most. `backend` is the
 * decision model it reads for: what `decisionModel` asks for unless the
 * keys decide otherwise (`setup` reads both).
 */
export function readConfig(options: PluginOptions, table: Readonly<Record<BackendName, BackendDefaults>> = BACKEND_DEFAULTS, backend: BackendName = backendNameOf(options)): Config {
  const defaults = table[backend]
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
  // `contextTokens` by kind of request: unset, each kind's own (BACKEND_DEFAULTS); set, the smaller of it and each kind's.
  const contextTokens = own('contextTokens', 100, defaults.contextTokensMax, true)
  const contextSet = typeof options.contextTokens === 'number' && Number.isFinite(options.contextTokens)
  const byKind = (cap: number) => (contextSet ? Math.min(contextTokens, cap) : cap)
  const context = { messages: own('contextMessages', 0, defaults.contextMessagesMax, true), tokens: byKind(defaults.contextTokens) }
  const contextByKind = Object.fromEntries(CONTEXT_KINDS.map((kind) => [kind, byKind(defaults.contextByKind[kind])])) as Record<ContextKind, number>
  const haikuToWritten = stringOf(options.escalateHaikuTo, 'sonnet').trim()
  // A hook's own budget is 10 s and the timer's wait counts toward it.
  const timeoutMs = own('timeoutMs', 200, 8000)
  const config: Config = {
    backend,
    defaults: { used, capped },
    typesafeApiKey: stringOf(options.typesafeApiKey, '').trim(),
    perplexityApiKey: stringOf(options.perplexityApiKey, '').trim(),
    timeoutMs,
    ask: defaults.ask,
    thetaMax,
    roundUp: defaults.roundUp,
    context,
    contextByKind,
    midturn: {
      every: whole(options.rejudgeEvery, 0, 50, 3),
      // A hook's own budget is 10 s and the timer's wait counts toward it, as for `timeoutMs`.
      waitMs: own('rejudgeWaitMs', 0, 8000, true),
      limits: { steps: own('rejudgeSteps', 1, 16, true), tokens: contextByKind.rejudge },
      rules: {
        thetaUp: own('thetaUp', 0, 1),
        thetaDown: own('thetaDown', 0, 1),
        thetaMax,
        roundUp: defaults.roundUp,
        holdSteps: whole(options.holdSteps, 0, 50, 5),
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
      findWaitMs: defaults.findSkillWaitMs ?? timeoutMs,
      findByProfile: defaults.findSkillProfiles,
      shortlist: whole(options.skillsShortlist, 1, 10, 4),
      alwaysListed: namesOf(options.skillsAlwaysListed),
      neverSuggested: namesOf(options.skillsNeverSuggested),
      profileModel: stringOf(options.skillsProfileModel, DEFAULT_PROFILE_MODEL).trim() || DEFAULT_PROFILE_MODEL,
      profilesPerSession: whole(options.skillsProfilesPerSession, 0, 500, 30),
    },
    unresolved: {
      summaryModel: stringOf(options.summaryModel, DEFAULT_SUMMARY_MODEL).trim() || DEFAULT_SUMMARY_MODEL,
      maxAfter: whole(options.unresolvedMaxAfter, 0, 10, 3),
    },
  }
  // In the table's order, whatever order they were read in.
  used.sort((a, b) => PER_BACKEND_OPTIONS.indexOf(a[0]) - PER_BACKEND_OPTIONS.indexOf(b[0]))
  return config
}

/**
 * One debug-log line on what the decision model's defaults decided, e.g.
 * `settings for jev: left unset, so jev's defaults: timeoutMs 1500, ...;
 * skill suggestions on until /dp skills off; contextTokens 20000 reads as
 * 16000, the most with jev`.
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
export function dispatchSettings(ctx: { config: Pick<Config, 'agents' | 'thetaMax' | 'roundUp'>; ask: EffortAsk }, ask: Partial<DispatchAsk> = {}): DispatchSettings {
  // Each read goes to `ctx`: a feature builds this when it registers, before the session start has settled the decision model.
  return {
    get models() {
      return ctx.config.agents.models
    },
    get ask() {
      return { ...ctx.ask, ...ask }
    },
    get thetaOverride() {
      return ctx.config.agents.thetaOverride
    },
    get thetaMax() {
      return ctx.config.thetaMax
    },
    get roundUp() {
      return ctx.config.roundUp
    },
  }
}

/** The cheap model that writes skill profiles, unless the person names another (`skillsProfileModel`). */
export const DEFAULT_PROFILE_MODEL = 'haiku'

/** The cheap model that writes the problem summary, unless the person names another (`summaryModel`). */
export const DEFAULT_SUMMARY_MODEL = 'haiku'

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
