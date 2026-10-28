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
import type { Backend, BackendName, ImageBackendName } from '../decision/backend.ts'
import type { ContextLimits } from '../decision/context.ts'
import { DEFAULT_AGENT_MODELS, WORDS_SHARE, type AgentModel, type DispatchAsk, type DispatchSettings } from '../decision/dispatched-agent.ts'
import type { EffortAsk } from '../decision/effort.ts'
import { LIQUID_GUIDE, TYPESAFE_GUIDE, type Guide } from '../decision/guides.ts'
import { jevBackend, JEV_REGULAR_STATE } from '../decision/jev.ts'
import { JEV_DEFAULT_LIMITS, jevRateLimited, type JevLimits } from '../decision/jev-rate.ts'
import { liquidBackend } from '../decision/liquid.ts'
import { resolveModel, type ResolvedModel } from '../decision/model-ids.ts'
import { pplxBackend } from '../decision/pplx.ts'
import { rateLimited } from '../decision/pplx-rate.ts'
import type { DecisionRequest } from '../decision/system-one.ts'
import { BATCHES_BUDGET_MS } from '../decision/workflow.ts'
import { listSwitches } from './switches.ts'

/** The decision models the person can choose (`decisionModel`): TypeSafe's Jev, Perplexity's pplx-decider and Liquid's d1-ultra (decision/backend.ts, where the pure modules read it). */
export type { BackendName, ImageBackendName }

/**
 * The decision model that decides (ADR 0014, ADR 0017): pplx or d1-ultra only when `decisionModel` names it, else Jev, the
 * default. Anything else (unset, a typo, the `clef` of a 0.3.x configuration) reads as unset. Nothing falls back on the keys:
 * without its key the model chosen fails every request with that key named as the one missing, and the board says so.
 */
export function backendNameOf(options: PluginOptions): BackendName {
  return options.decisionModel === 'pplx' ? 'pplx' : options.decisionModel === 'd1-ultra' ? 'd1-ultra' : 'jev'
}

/** Which decision model takes the requests with images, and whether it is not Jev (`chooseImageBackend`). */
export type Choice = { backend: ImageBackendName; fellBack: boolean }

/**
 * The decision model that takes requests with images (#56, ADR 0008), apart from the one that decides everything else and
 * whatever `decisionModel` says: Jev with a TypeSafe key (its Box question and one-time image tokens make zooming possible);
 * else pplx with a Perplexity key, which cannot zoom (`fellBack`); else none (null), and the features that need images are
 * unavailable. Never d1-ultra (ADR 0017): with it deciding the rest, the images are still Jev's.
 */
export function chooseImageBackend(keys: { perplexity: string; typesafe: string }): Choice | null {
  if (keys.typesafe !== '') return { backend: 'jev', fellBack: false }
  return keys.perplexity !== '' ? { backend: 'pplx', fellBack: true } : null
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
] as const
export type PerBackendOption = (typeof PER_BACKEND_OPTIONS)[number]

/**
 * The kinds of request whose state has a budget of its own (`contextTokens`
 * reads by kind): a message that carries the skills' question (and find_skill's
 * first stage) is `Config.context`; the rest are these.
 */
export const CONTEXT_KINDS = ['messagePlain', 'agent', 'workflow'] as const
export type ContextKind = (typeof CONTEXT_KINDS)[number]

/**
 * What one decision model brings: each option's default where the person left
 * it unset, the most `contextTokens` and `contextMessages` read as, how every
 * question is asked, and how its answers are read (`guide`: its maker's guide,
 * decision/guides.ts). The rules that turn answers into levels are the same for
 * every decision model (decision/message-effort.ts, ADR 0014); the bars they
 * read a Noul at, the rule for an unsure effort answer and how an agent's model
 * is chosen are its guide's (ADR 0017).
 *
 * Adding a decision model means touching, beyond its entry here: `BackendName`; the backend in decision/ and its
 * construction in `setup()` (`configs`, `backends`, and whether it passes through the rate limit); `backendNameOf` (the
 * `decisionModel` value that names it) and `chooseImageBackend` (whether it takes images); `DECISION_MODELS` in
 * core/report.ts (its name and key settings, for the entry about images); `decisionModel`'s options in plugin.json, its key option and the README's
 * configuration tables (a column each); and, for the eval, `backendFor` and `PRICES` in eval/node.ts, `--backend` in
 * eval/run.ts and eval/eval-v2-flow.ts, and the BACKENDS list in eval/lib/docs.ts. A `Record<BackendName, ...>` the compiler
 * checks (this table, `setup()`, PRICES, DECISION_MODELS); the rest it does not, and tests/docs-sync.test.ts only the README tables.
 */
export type BackendDefaults = Readonly<Record<PerBackendOption, number>> & {
  /** `contextTokens` above this reads as this. */
  contextTokensMax: number
  /** `contextMessages` above this reads as this. */
  contextMessagesMax: number
  /**
   * How the decision model is asked, language and kind of question (the eval's variables, `effort-submit` for the effort part
   * beside a message, `subagent` for an agent's): `turnStart` for that part, `agent` for the questions about a dispatched agent
   * and a Workflow's, `other` for every other one (the skills). Not options. English throughout (ADR 0014: TypeSafe names
   * English as the language Jev is most accurate in).
   */
  ask: { turnStart: EffortAsk; agent: EffortAsk; other: EffortAsk }
  /**
   * What the state of each other kind of request may take, in estimated tokens (`contextTokens` is the message that carries the
   * skills' question). Not options: each is the most that kind's longest question leaves, worked out in DEVELOPMENT.md (配置,
   * 「Jev 的上下文默认值怎么算」) and checked by tests/backend-defaults.test.ts. What the person sets as `contextTokens` holds for
   * every kind, each taking the smaller of it and its own.
   */
  contextByKind: Readonly<Record<ContextKind, number>>
  /**
   * Whether an agent's request carries the background it was written in, in what its brief and the person's words leave
   * of the budget: the conversation it was dispatched from (`recent_context`) and, for a Workflow's agents, the script
   * (`workflow_script`). It fills the request to its budget, so it is on where the decision model answers a full request
   * in time. Not an option.
   */
  agentBackground: boolean
  /**
   * How long a request past the model's regular limits waits for its answer, at least (`Backend.longContext`: Jev's
   * long-context header), and so does every request sent beside it, which may wait behind it for its place within the
   * account's token rate (decision/jev-rate.ts); null where no request is (pplx). Not an option: set by the latency measured.
   */
  longWaitMs: number | null
  /**
   * How many requests about agents go out at once at most (core/agent-lane.ts): the agents that come while they are
   * all out wait, and are merged into the next request. Not an option: set by how the model answers several at once.
   */
  agentLanes: number
  /**
   * How long find_skill's two requests may take in all, in ms; null: as long
   * as a message waits (`timeoutMs`). Not an option: set by the latency
   * measured, not calibrated. A hook has 10 s of its own, and the timer's wait
   * counts toward it (the mods reference, Limits): this leaves room for the rest.
   */
  findSkillWaitMs: number | null
  /**
   * The least a skills ranking's second request is given, in ms, however much of the wait the first took (beside a message
   * and in find_skill); null: only what the first left. Not an option: set by the latency measured.
   */
  skillsSecondStageMs: number | null
  /** How its answers are read: its maker's guide (decision/guides.ts; Jev and pplx TypeSafe's, d1-ultra Liquid's). Not an option. */
  guide: Guide
}

/**
 * Jev's, the default decision model (ADR 0014). Jev takes 64k tokens a request and 32k for "the state and the longest
 * question" (262k for both with its long-context header, which the docs call slower and less accurate: decision/jev.ts sends
 * it only for a request that would not fit otherwise). The longest question is the first stage of the skills, a Choice over
 * every skill (measured with 111 skills offered by their profiles, before ADR 0018: about 16k tokens as the mod counts, 21.9k
 * as Jev does; by their own descriptions it is shorter, and cut to `questionBudget` when it is not), which shares its request
 * with the state, so `contextTokens` is what that leaves, 6000 (DEVELOPMENT.md, 配置, 「Jev 的上下文默认值怎么算」; tests/backend-defaults.test.ts
 * checks the sum). Every other kind of request stays within the regular limits too (`contextByKind`). The count that fills a
 * state is at its most (`contextMessages` 2000), so the token budget, not the count, ends what is sent.
 */
const JEV_DEFAULTS: BackendDefaults = {
  timeoutMs: 1500,
  // As many as pplx: the budget ends what is sent (32, the old most, held a long conversation to a fraction of 96000 tokens).
  contextMessages: 2000,
  contextMessagesMax: 2000,
  contextTokens: 6000,
  contextTokensMax: 16000,
  // Within Jev's regular limits (ADR 0014; TypeSafe: the long context is "slower and less accurate ... turn it on only for
  // requests that need it"): the state takes what 32k leaves beside the request's longest question at 90%, with Jev counting
  // about 1.2 of each estimated token, `JEV_REGULAR_STATE` (24000). The effort request's longest question, the effort Score,
  // is about 450 estimated tokens and its nine questions about 2000 together; an agent's longest is its effort Score, about
  // 330, and its 11 to 19 questions (ADR 0015) about 2,900 at most, 4 agents a request (the 64 questions a request holds,
  // decision/workflow.ts MAX_PER_REQUEST) about 11,500, so the request stays within the 64k too (`JEV_REGULAR_REQUEST`). What lies further back
  // in a long conversation reaches the effort request as code-kept facts instead: the problem summary, the person's lasting
  // rules (`standing_constraints`) and the previous turn's failures (`last_turn`).
  contextByKind: { messagePlain: JEV_REGULAR_STATE, agent: JEV_REGULAR_STATE, workflow: JEV_REGULAR_STATE },
  // On (2026-10-15): an agent's request reads the conversation it was dispatched from, and a Workflow's its script, within its
  // budget; the agents dispatched together share one request (core/agent-lane.ts), so the conversation is paid for once.
  agentBackground: true,
  // For a request that still goes past the regular limits (several agents merged into one request with long briefs: Jev's
  // long-context header, decision/jev.ts): one of 96000 estimated tokens took 1.0-1.6 s on 1.14 (2026-10-15); 3000 leaves
  // room for the wait for its place within the account's token rate (decision/jev-rate.ts) when a burst is out.
  longWaitMs: 3000,
  // Four: four long requests of one key sent at once (115k tokens each) were all answered in 1.39-1.53 s, one alone in 1.44 s
  // (2026-10-15, DEVELOPMENT.md 「Jev 的长上下文」); more were not tried. The account's token rate paces them beyond that
  // (decision/jev-rate.ts: four full ones take most of a burst). The agents that come while four are out go in the next request.
  agentLanes: 4,
  findSkillWaitMs: null,
  // Several sessions on one key slow the first request (26k tokens) from 0.6-0.8 s to 0.9-1.3 s, and the second took
  // 0.27-0.48 s: sharing 1500 ms, 3 of 15 messages lost the second (2026-10-19, five sessions at once). 800 ms is above
  // the second's slowest; a message waits 2.3 s at most then, 3.8 s with a long effort request (`longWaitMs`).
  skillsSecondStageMs: 800,
  // English throughout (ADR 0014): TypeSafe names English as the language Jev is most accurate in; the person's own words go as they are.
  ask: { turnStart: { language: 'en', primitive: 'score' }, agent: { language: 'en', primitive: 'score' }, other: { language: 'en', primitive: 'score' } },
  guide: TYPESAFE_GUIDE,
}

/**
 * pplx-decider-v1.1-27b's, used only when `decisionModel` names it (ADR 0014: no longer evaluated). From B′ of eval v2 (#45,
 * ADR 0006: the state within 48000 tokens, every question in English). It takes 262,144 tokens
 * a request (state and questions), so what it reads is not cut to Jev's 32k: 2000 messages (the budget, not the count, ends
 * what is sent) and its state up to what it answers within a message's wait (below); the skills' two stages keep Jev's 6000,
 * since the skills' Choice is the same length for either model. A request takes seconds, not Jev's fraction of one,
 * so a message waits 8000 ms (a hook has 10 s). What the eval did not calibrate for pplx (the skills' relevance) is
 * Jev's.
 */
const PPLX_DEFAULTS: BackendDefaults = {
  timeoutMs: 8000,
  contextMessages: 2000,
  contextMessagesMax: 2000,
  contextTokens: 6000,
  contextTokensMax: 48000,
  // Time, not the window, ends the state (measured 2026-10-13, DEVELOPMENT.md 「pplx 的 agent 预算」): pplx counts about 2.2
  // tokens for each the mod estimates, and the time grows with them (the docs: 90k tokens 5 s, 190k 14 s, the full window
  // 23 s). A state of 48000 took 4.3-5.9 s alone and 72000 8.3-8.8 s, past the 8000 ms wait. Agents are dispatched several
  // at once, each request filled with the conversation (`agentBackground`): five at once at 32000 took 5.2 s at most, three
  // at 48000 up to 7.6 s. So a dispatched agent's request, and each of a Workflow's when it takes several (`planBatches`),
  // is 32000; a Workflow's one request keeps 48000.
  contextByKind: { messagePlain: 48000, agent: 32000, workflow: 48000 },
  // On: pplx answers a full request in about 4 s, several at once (`pplxQps` lets five go together).
  agentBackground: true,
  // pplx takes 262k in every request (no header), and its own wait is seconds already.
  longWaitMs: null,
  // Five: five requests of 32000 at once were all answered within 5.2 s (`pplxQps` lets five go in a second).
  agentLanes: 5,
  // Find_skill's two requests wait as long as the skills' Choice takes (a message's wait would be 8000 ms of a 10 s hook).
  findSkillWaitMs: 6000,
  // pplx's waits are seconds already, and a longer one would go past a hook's 10 s.
  skillsSecondStageMs: null,
  ask: { turnStart: { language: 'en', primitive: 'score' }, agent: { language: 'en', primitive: 'score' }, other: { language: 'en', primitive: 'score' } },
  // pplx answers as Jev does (the same System One API), and is no longer evaluated: TypeSafe's guide, as Jev's.
  guide: TYPESAFE_GUIDE,
}

/**
 * d1-ultra's, Liquid's decision model, used only when `decisionModel` names it (ADR 0017; no eval, the person's choice).
 * Its answers are read by Liquid's guide (decision/guides.ts). A question reads at most 32,768 of Liquid's tokens, its state
 * with it, and there is no long-context header (decision/liquid.ts): Liquid counted 1.092 of its tokens for each estimated one
 * (2026-10-28, DEVELOPMENT.md 「d1-ultra 的预算」), so Jev's budgets fit it as they are (24000 estimated: about 26,200 of its
 * tokens, about 27,200 with the longest question, the effort Score; 83% of the 32,768), and the skills' 6000 beside their
 * question too. It answers more slowly than Jev: a state of 25,484 of its tokens with one question took 2.7 s, and a full
 * message request (11 questions, 25,689 tokens) 2.0 s, where Jev took 0.9 s (2026-10-28), so a message waits 4000 ms
 * (`timeoutMs`, about one and a half times the slower); find_skill's two requests 6000.
 */
const LIQUID_DEFAULTS: BackendDefaults = {
  timeoutMs: 4000,
  contextMessages: 2000,
  contextMessagesMax: 2000,
  contextTokens: 6000,
  contextTokensMax: 16000,
  contextByKind: { messagePlain: JEV_REGULAR_STATE, agent: JEV_REGULAR_STATE, workflow: JEV_REGULAR_STATE },
  agentBackground: true,
  // No long-context header: every request stays within its regular limits.
  longWaitMs: null,
  // Four, as Jev's: Liquid takes 20 requests a second a model, shared by all of an account's keys.
  agentLanes: 4,
  findSkillWaitMs: 6000,
  // Not measured: the second stage's state is the skills' 6000 and a few openings, about a third of the first's tokens.
  skillsSecondStageMs: 1500,
  ask: { turnStart: { language: 'en', primitive: 'score' }, agent: { language: 'en', primitive: 'score' }, other: { language: 'en', primitive: 'score' } },
  guide: LIQUID_GUIDE,
}

/** The defaults by decision model: the only place they are written. */
export const BACKEND_DEFAULTS: Readonly<Record<BackendName, BackendDefaults>> = {
  pplx: PPLX_DEFAULTS,
  jev: JEV_DEFAULTS,
  'd1-ultra': LIQUID_DEFAULTS,
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

/**
 * How much of each of the person's messages is kept for the turn (`said`): what the largest request that reads them (a
 * dispatched agent's, a Workflow's) can send of them, a third of its budget (`dispatchWords`). The mod keeps them so
 * (features/dispatched-agents.ts), and the eval cuts an item's message the same way.
 */
export function saidTokens(config: Pick<Config, 'contextByKind'>): number {
  return Math.floor(Math.max(config.contextByKind.agent, config.contextByKind.workflow) * WORDS_SHARE)
}

/**
 * How long an agent waits for its decision at most (`Config.agents.waitMs`): the request about it and one ahead of it in
 * the lane (core/agent-lane.ts), each as long as a long request may wait, within what a hook can spare (BATCHES_BUDGET_MS).
 * Jev 6000, pplx 8000.
 */
export function agentWaitMs(timeoutMs: number, longWaitMs: number | null): number {
  return Math.min(BATCHES_BUDGET_MS, 2 * Math.max(timeoutMs, longWaitMs ?? 0))
}

/**
 * How long requests sent together wait for their answers: `timeoutMs`, or `longWaitMs` at least once any of them goes past
 * the decision model's regular limits (`Backend.longContext`), behind which the others may wait for their place within the
 * account's token rate (decision/jev-rate.ts).
 */
export function waitFor(ctx: { readonly config: Pick<Config, 'timeoutMs' | 'longWaitMs'>; readonly backend: Pick<Backend, 'longContext'> }, requests: readonly DecisionRequest[]): number {
  const { timeoutMs, longWaitMs } = ctx.config
  if (longWaitMs === null || !requests.some((request) => ctx.backend.longContext?.(request) === true)) return timeoutMs
  return Math.max(timeoutMs, longWaitMs)
}

/** The settings, read once per load (the effort rules themselves have no parameters: decision/message-effort.ts, ADR 0014). */
export type Config = {
  /** The decision model the options were read for: its defaults (BACKEND_DEFAULTS) stand for what the person left unset. */
  backend: BackendName
  /**
   * What came from that decision model's defaults (for the debug log, describeDefaults): the options the person left
   * unset, with the value each took, and an option set above that model's most, read as the most.
   */
  defaults: { used: readonly (readonly [PerBackendOption, number])[]; capped: readonly { option: PerBackendOption; set: number; read: number }[] }
  /** The TypeSafe key in the options (`typesafeApiKey`, trimmed; '' if unset). Not enumerable (see readConfig): it is not in a written-out or copied config. The environment's (`Secrets`) stands where this is empty. */
  readonly typesafeApiKey: string
  /** The Perplexity key in the options (`perplexityApiKey`, trimmed; '' if unset; not enumerable either): the environment's (`Secrets`) stands where this is empty. */
  readonly perplexityApiKey: string
  /** The Liquid key in the options (`liquidApiKey`, trimmed; '' if unset; not enumerable either): the environment's (`Secrets`) stands where this is empty. */
  readonly liquidApiKey: string
  /** How the answers are read: the decision model's guide (BACKEND_DEFAULTS guide; decision/guides.ts). */
  guide: Guide
  /** How many pplx requests the mod sends in a second at most (`pplxQps`; the account's limit): the rest wait their turn (decision/pplx-rate.ts). */
  pplxQps: number
  /**
   * The TypeSafe account's limits (`jevQps`, `jevTokensPerSecond`; the console's rate limits, the default plan's 80 requests
   * and 100,000 input tokens a second): every Jev request is paced within them (decision/jev-rate.ts).
   */
  jevLimits: JevLimits
  /** How long a decision request may take before the prompt goes on without it. */
  timeoutMs: number
  /**
   * How long a request past the decision model's regular limits waits, at least, and every request sent beside it
   * (BACKEND_DEFAULTS longWaitMs; `waitFor`); null: no request is.
   */
  longWaitMs: number | null
  /**
   * How the decision model is asked (BACKEND_DEFAULTS ask): `turnStart` the effort question beside each message, `agent` the
   * questions about an agent (a dispatched agent's and a Workflow's, `dispatchSettings`), `other` every other question (`ctx.ask`).
   */
  ask: { turnStart: EffortAsk; agent: EffortAsk; other: EffortAsk }
  /**
   * What the decision model reads of the conversation: how many recent messages, how many tokens in all. The tokens are the
   * budget of a message that carries the skills' question (and of find_skill's first stage); the other kinds of request have
   * theirs in `contextByKind`.
   */
  context: ContextLimits
  /** The tokens the state of each other kind of request may take: the decision model's default for the kind, or what the person set if smaller. */
  contextByKind: Readonly<Record<ContextKind, number>>
  /** Forced escalation (#7, ADR 0013): a dispatched agent whose calls keep failing goes on as the next model up. */
  escalation: {
    /** Counted failures that make an agent step up. */
    after: number
    /** Step-ups an agent gets at most in a run. */
    limit: number
    /** The model a failing haiku agent is switched to, resolved to a full id; null: never switch (left empty, or a name no model family has). */
    haikuTo: ResolvedModel | null
    /** `escalateHaikuTo` as the person wrote it, for the log when it names no model. */
    haikuToWritten: string
  }
  /** Dispatched agents and a Workflow's agents (#6, #8, #9). */
  agents: {
    /** The models the model table may give, weakest first (fable with `agentFable`, ADR 0015). */
    models: readonly AgentModel[]
    /** `rewrite` writes a Workflow's decisions into its script; `return` sends the Workflow back with them, once. */
    workflowMode: 'rewrite' | 'return'
    /** Whether an agent's request carries the conversation it was dispatched from and, a Workflow's, the script (the decision model's: BACKEND_DEFAULTS `agentBackground`). */
    background: boolean
    /** How many requests about agents go out at once at most (BACKEND_DEFAULTS `agentLanes`, core/agent-lane.ts). */
    lanes: number
    /**
     * How long an agent waits for its decision at most before it starts as it was asked: for the request about it and one
     * ahead of it in the lane, each as long as a long request may take, within the 8000 ms a hook can spare (`agentWaitMs`).
     */
    waitMs: number
  }
  /**
   * Skills (#10, #12; ADR 0018). A message is suggested one skill at most, picked as TypeSafe's skill suggestion cookbook
   * picks it; the bars are the decision model's guide's (`guide.skills`), not options.
   */
  skills: {
    /** How many skills find_skill returns at most (`findSkillMax`), and so re-reads in its second request. */
    findMax: number
    /** How long find_skill's two requests may take in all (the decision model's: BACKEND_DEFAULTS findSkillWaitMs). */
    findWaitMs: number
    /** The least a ranking's second request is given (BACKEND_DEFAULTS skillsSecondStageMs); null: what the first left. */
    secondStageMs: number | null
    /** Skills the main agent keeps in its listing (names as the listing spells them). */
    alwaysListed: readonly string[]
    /** Skills never offered, to the main agent or to the person. */
    neverSuggested: readonly string[]
  }
  /** The unresolved count and the problem summary (#39, #40, ADR 0014). */
  unresolved: {
    /** The model that writes the problem summary after each of the person's turns (`summaryModel`). */
    summaryModel: string
    /** The count from which a message still failing goes to max (`unresolvedMaxAfter`, rule R5; 0: never). */
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
  /** `TYPESAFE_API_KEY`, trimmed; '' while unread or unset. Desktop hands a mod no sensitive option (#35): this is its way in there. */
  typesafeEnvKey: string
  /** `LIQUID_API_KEY`, trimmed; '' while unread or unset. */
  liquidEnvKey: string
}

/** The Perplexity key in use: the options' (`perplexityApiKey`) first, else the environment's. '' for none. */
export function perplexityKey(config: Pick<Config, 'perplexityApiKey'>, secrets: Secrets): string {
  return config.perplexityApiKey !== '' ? config.perplexityApiKey : secrets.perplexityEnvKey
}

/** The TypeSafe key in use: the options' (`typesafeApiKey`) first, else the environment's. '' for none. */
export function typesafeKey(config: Pick<Config, 'typesafeApiKey'>, secrets: Secrets): string {
  return config.typesafeApiKey !== '' ? config.typesafeApiKey : secrets.typesafeEnvKey
}

/** The Liquid key in use: the options' (`liquidApiKey`) first, else the environment's. '' for none. */
export function liquidKey(config: Pick<Config, 'liquidApiKey'>, secrets: Secrets): string {
  return config.liquidApiKey !== '' ? config.liquidApiKey : secrets.liquidEnvKey
}

/**
 * Where a key in use came from, for the session start's debug line: `from the options`, `from <variable>` or `not set`.
 * Never the key itself.
 */
export function keySource(option: string, environment: string, variable: string): string {
  return option !== '' ? 'from the options' : environment !== '' ? `from ${variable}` : 'not set'
}

/**
 * What the entry hands every feature's register: data and pure functions, never `$`.
 *
 * The decision model is the one `decisionModel` names (Jev unless it names pplx), known at register. Which model takes the
 * images depends on the keys, which the session start reads from the environment (`secrets`), so `images` is read afresh at
 * each use.
 */
export type Ctx = {
  /** The settings of the decision model that decides (`backendNameOf`). */
  readonly config: Config
  /** The decision model that decides. */
  readonly backend: Backend
  /** What the session start read from the environment (a key not in the options). */
  readonly secrets: Secrets
  /** How every question but the effort question beside a message is asked: the decision model's (`config.ask.other`). */
  readonly ask: EffortAsk
  /**
   * The decision model that takes requests with images, with the backend to ask (`chooseImageBackend`); null when there is none
   * and the features that need images are unavailable. `fellBack`: it is pplx for want of a TypeSafe key, which cannot zoom
   * (needs Box questions). It is the same backend object as `backend` would be, so a pplx request goes through the rate limit
   * (its `io` needs `pace`, as every request's does).
   */
  readonly images: { readonly name: ImageBackendName; readonly backend: Backend; readonly fellBack: boolean } | null
}

/** `table` is only a test's way to read a table the shipped one does not have (a decision model not added yet). */
export function setup(options: PluginOptions, table: Readonly<Record<BackendName, BackendDefaults>> = BACKEND_DEFAULTS): Ctx {
  const asked = backendNameOf(options)
  // Both are worked out here (pure and cheap): the one asked for decides, and the other may still take the images (`chooseImageBackend`).
  const configs: Record<BackendName, Config> = { pplx: readConfig(options, table, 'pplx'), jev: readConfig(options, table, 'jev'), 'd1-ultra': readConfig(options, table, 'd1-ultra') }
  const secrets: Secrets = { perplexityEnvKey: '', typesafeEnvKey: '', liquidEnvKey: '' }
  const backends: Record<BackendName, Backend> = {
    // Every request goes through its account's rate limit: pplx's (#51), Jev's (requests and input tokens a second).
    pplx: rateLimited(pplxBackend(() => perplexityKey(configs.pplx, secrets)), configs.pplx.pplxQps),
    jev: jevRateLimited(jevBackend(() => typesafeKey(configs.jev, secrets)), () => configs.jev.jevLimits),
    // No limit of the mod's own: Liquid's 20 a second is far above what a session sends; its 429 is a busy failure (fail open).
    'd1-ultra': liquidBackend(() => liquidKey(configs['d1-ultra'], secrets)),
  }
  const keys = () => ({ perplexity: perplexityKey(configs.pplx, secrets), typesafe: typesafeKey(configs.jev, secrets) })
  return {
    config: configs[asked],
    backend: backends[asked],
    secrets,
    ask: configs[asked].ask.other,
    get images() {
      const chosen = chooseImageBackend(keys())
      return chosen === null ? null : { name: chosen.backend, backend: backends[chosen.backend], fellBack: chosen.fellBack }
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
    if (!isNumber(set)) {
      used.push([option, defaults[option]])
      return defaults[option]
    }
    const read = numberIn(set, min, max, defaults[option])
    const value = round ? Math.round(read) : read
    if (set > max) capped.push({ option, set, read: value })
    return value
  }
  const whole = (value: unknown, min: number, max: number, fallback: number) => Math.round(numberIn(value, min, max, fallback))
  // `contextTokens` by kind of request: unset, each kind's own (BACKEND_DEFAULTS); set, the smaller of it and each kind's.
  const contextTokens = own('contextTokens', 100, defaults.contextTokensMax, true)
  const byKind = (cap: number) => (isNumber(options.contextTokens) ? Math.min(contextTokens, cap) : cap)
  const context = { messages: own('contextMessages', 0, defaults.contextMessagesMax, true), tokens: byKind(defaults.contextTokens) }
  const contextByKind = Object.fromEntries(CONTEXT_KINDS.map((kind) => [kind, byKind(defaults.contextByKind[kind])])) as Record<ContextKind, number>
  const haikuToWritten = stringOf(options.escalateHaikuTo, 'sonnet').trim()
  // A hook's own budget is 10 s and the timer's wait counts toward it.
  const timeoutMs = own('timeoutMs', 200, 8000)
  const config: Omit<Config, 'typesafeApiKey' | 'perplexityApiKey' | 'liquidApiKey'> = {
    backend,
    defaults: { used, capped },
    guide: defaults.guide,
    pplxQps: whole(options.pplxQps, 1, 50, 5),
    jevLimits: {
      requestsPerSecond: whole(options.jevQps, 1, 1000, JEV_DEFAULT_LIMITS.requestsPerSecond),
      tokensPerSecond: whole(options.jevTokensPerSecond, 10_000, 100_000_000, JEV_DEFAULT_LIMITS.tokensPerSecond),
    },
    timeoutMs,
    longWaitMs: defaults.longWaitMs,
    ask: defaults.ask,
    context,
    contextByKind,
    escalation: {
      after: whole(options.escalateAfter, 1, 20, 2),
      limit: whole(options.escalateLimit, 0, 10, 2),
      haikuTo: haikuToWritten === '' ? null : resolveModel(haikuToWritten),
      haikuToWritten,
    },
    agents: {
      models: options.agentFable === true ? [...DEFAULT_AGENT_MODELS, 'fable'] : DEFAULT_AGENT_MODELS,
      workflowMode: stringOf(options.workflowMode, 'rewrite') === 'return' ? 'return' : 'rewrite',
      background: defaults.agentBackground,
      lanes: defaults.agentLanes,
      waitMs: agentWaitMs(timeoutMs, defaults.longWaitMs),
    },
    skills: {
      findMax: whole(options.findSkillMax, 1, 10, 5),
      findWaitMs: defaults.findSkillWaitMs ?? timeoutMs,
      secondStageMs: defaults.skillsSecondStageMs,
      alwaysListed: namesOf(options.skillsAlwaysListed),
      neverSuggested: namesOf(options.skillsNeverSuggested),
    },
    unresolved: {
      summaryModel: stringOf(options.summaryModel, DEFAULT_SUMMARY_MODEL).trim() || DEFAULT_SUMMARY_MODEL,
      maxAfter: whole(options.unresolvedMaxAfter, 0, 10, 3),
    },
  }
  // In the table's order, whatever order they were read in.
  used.sort((a, b) => PER_BACKEND_OPTIONS.indexOf(a[0]) - PER_BACKEND_OPTIONS.indexOf(b[0]))
  // The keys are not enumerable: `JSON.stringify(config)`, `{ ...config }` and `Object.keys` do not meet them, so a
  // config written to a log, a result file or the board (the eval saves its settings) cannot carry a key by accident.
  return Object.defineProperties(config, {
    typesafeApiKey: { value: stringOf(options.typesafeApiKey, '').trim(), enumerable: false },
    perplexityApiKey: { value: stringOf(options.perplexityApiKey, '').trim(), enumerable: false },
    liquidApiKey: { value: stringOf(options.liquidApiKey, '').trim(), enumerable: false },
  }) as Config
}

/**
 * One debug-log line on what the decision model's defaults decided, e.g.
 * `settings for jev: left unset, so jev's defaults: timeoutMs 1500, ...;
 * skill suggestions on until /dp skills off; contextTokens 20000 reads as
 * 16000, the most with jev`. The skills' switch is read as it stands, so the session start loads the person's switches first.
 */
export function describeDefaults(config: Pick<Config, 'backend' | 'defaults' | 'skills'>): string {
  const { backend, defaults } = config
  const used = defaults.used.length === 0 ? 'every option set' : `left unset, so ${backend}'s defaults: ${defaults.used.map(([option, value]) => `${option} ${value}`).join(', ')}`
  const capped = defaults.capped.map((cap) => `; ${cap.option} ${cap.set} reads as ${cap.read}, the most with ${backend}`).join('')
  // The skills' own switch, not `isOn`: with the master switch off the skills' switch has not moved, and `/dp skills on` would not turn anything on.
  const skillsSwitchOn = listSwitches().find((info) => info.name === 'skills')?.on ?? true
  const suggestions = !skillsSwitchOn ? 'skill suggestions off (/dp skills on)' : 'skill suggestions on until /dp skills off'
  return `settings for ${backend}: ${used}; ${suggestions}${capped}`
}

/**
 * How an agent's model and effort are decided (decision/dispatched-agent.ts):
 * the same for a dispatched agent (#6) and a Workflow's agents (#8, #9), and
 * for the eval; its questions are asked as the decision model asks about an
 * agent (`config.ask.agent`), and `ask` writes them otherwise (the eval's variants).
 */
export function dispatchSettings(ctx: { config: Pick<Config, 'agents' | 'ask' | 'guide'> }, ask: Partial<DispatchAsk> = {}): DispatchSettings {
  // Each read goes to `ctx`: a feature builds this when it registers, before the session start has settled the decision model.
  return {
    get models() {
      return ctx.config.agents.models
    },
    get ask() {
      return { ...ctx.config.ask.agent, ...ask }
    },
    get guide() {
      return ctx.config.guide
    },
  }
}

/** The cheap model that writes the problem summary, unless the person names another (`summaryModel`). */
const DEFAULT_SUMMARY_MODEL = 'haiku'

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** A numeric option clamped to [min, max]; `fallback` when it is not a number. */
function numberIn(value: unknown, min: number, max: number, fallback: number): number {
  return isNumber(value) ? Math.min(max, Math.max(min, value)) : fallback
}

/** A string option; `fallback` when it is not a string. A sensitive one never set arrives as ''. */
function stringOf(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** A list-of-names option (`multiple` in the manifest; a comma-separated string also reads): trimmed, empty ones dropped. */
function namesOf(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return items.flatMap((item) => (typeof item === 'string' && item.trim() !== '' ? [item.trim()] : []))
}
