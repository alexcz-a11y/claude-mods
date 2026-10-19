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
import type { Backend, BackendName } from '../decision/backend.ts'
import type { ContextLimits } from '../decision/context.ts'
import { DEFAULT_AGENT_MODELS, WORDS_SHARE, type AgentModel, type DispatchAsk, type DispatchSettings } from '../decision/dispatched-agent.ts'
import type { EffortAsk, EffortRules } from '../decision/effort.ts'
import { RAISE_MODES, type RaiseMode } from '../decision/escalation.ts'
import { jevBackend } from '../decision/jev.ts'
import { JEV_DEFAULT_LIMITS, jevRateLimited, type JevLimits } from '../decision/jev-rate.ts'
import type { MidturnLimits, MidturnRules } from '../decision/midturn.ts'
import { resolveModel, type ResolvedModel } from '../decision/model-ids.ts'
import { pplxBackend } from '../decision/pplx.ts'
import { rateLimited } from '../decision/pplx-rate.ts'
import type { SkillPolicy } from '../decision/skills.ts'
import type { DecisionRequest } from '../decision/system-one.ts'
import { BATCHES_BUDGET_MS } from '../decision/workflow.ts'
import { listSwitches } from './switches.ts'

/** The decision models the person can choose (`decisionModel`): Perplexity's pplx-decider and TypeSafe's Jev (decision/backend.ts, where the pure modules read it). */
export type { BackendName }

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
 * The decision model that takes requests with images (#56, ADR 0008), apart from the one that decides everything else and
 * whatever `decisionModel` says: Jev with a TypeSafe key (its Box question and one-time image tokens make zooming possible);
 * else pplx with a Perplexity key, which cannot zoom (`fellBack`); else none (null), and the features that need images are unavailable.
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
 * question is asked and the threshold for taking the level above.
 *
 * Adding a decision model means touching, beyond its entry here: `BackendName`; the backend in decision/ and its
 * construction in `setup()` (`configs`, `backends`, and whether it passes through the rate limit); `backendNameOf` and
 * `chooseBackend` (which key decides, and what it falls back to); `DECISION_MODELS` in core/report.ts (its name and key
 * settings, for the fallback entry); `decisionModel`'s options in plugin.json, its key option and the README's
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
   * The least probability the level above the most probable one needs to be taken instead (`EffortRules.roundUp`, decision/effort.ts).
   * Not an option: set from the stored answers of the decision model (eval/resummarize.ts), like the other values of the table.
   */
  roundUp: number
  /**
   * `thetaMax` for an effort question that carries the strong hint (#41: the problem has come back unsolved
   * `unresolvedMaxAfter` times; decision/unresolved.ts `withHint`), at a message and mid-turn. Never above `thetaMax`.
   * Not an option: set from the stored answers of the flows' hinted requests (DEVELOPMENT.md 「强提示（#41）」).
   */
  hintThetaMax: number
  /**
   * How the decision model is asked, language and kind of question (the eval's variables, `effort-submit` for the effort question
   * beside a message, `subagent` for an agent's): `turnStart` for that question, `agent` for the questions about a dispatched agent
   * and a Workflow's, `other` for every other one (the mid-turn re-decision, a stuck loop, the skills, the problem summary's text).
   * Not options.
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
  /** Whether find_skill's first request offers a skill by its profile (else by its description); the second re-reads it by both. */
  findSkillProfiles: boolean
}

/**
 * Jev's: the values the eval of #4, #14, #15 and #16 set or kept (README, 配置 has the table; DEVELOPMENT.md, 配置 what each rests on),
 * except the ones that say how much Jev reads of the conversation: by the person's decision ("the more it is given, the
 * better it judges"), those are set to what Jev takes, not to what the eval ran (4 messages, 2000 tokens, 4 steps). Jev
 * takes 64k tokens a request and 32k for "the state and the longest question", or 262k for both with its long-context
 * header (decision/jev.ts, `needsLongContext`). The longest question is the first stage of the skills (111 skills with
 * profiles: about 16k tokens as the mod counts, 21.9k as Jev does), which shares its request with the state, so
 * `contextTokens` is what that leaves, 6000 (DEVELOPMENT.md, 配置, 「Jev 的上下文默认值怎么算」; tests/backend-defaults.test.ts
 * checks the sum). The counts that fill a state are at their most (`contextMessages` 2000, `rejudgeSteps` 16), so the
 * token budget, not the count, ends what is sent.
 */
const JEV_DEFAULTS: BackendDefaults = {
  timeoutMs: 1500,
  // As many as pplx: the budget ends what is sent (32, the old most, held a long conversation to a fraction of 96000 tokens).
  contextMessages: 2000,
  contextMessagesMax: 2000,
  contextTokens: 6000,
  contextTokensMax: 16000,
  // A message's effort request and an agent's (dispatched, or a Workflow's) go past Jev's regular limits, with the long-context
  // header (2026-10-15, DEVELOPMENT.md 「Jev 的长上下文」): the state takes up to 96000 estimated tokens, about 115k as Jev counts
  // Chinese (1.2 a token; English up to 1.37, about 132k), within 40-60% of its 262,144: the share of a window a model reads
  // best in, by the person's rule of thumb, and never full. Measured: the ctx30 run, 94k tokens of one conversation, 25 of 30
  // right against 13 of 30 with the newest 24000 (p 0.0005); eval v2's whole conversations, 146k tokens on average (56%),
  // came out no better than 24000 (60.0% against 67.5%); the docs call the long context less accurate than staying within
  // the regular limits. A re-decision stays at 24000: it reads this turn's steps (16 at most, a few thousand tokens), and a
  // step waits only `rejudgeWaitMs` for it. The other kinds have questions of at most 700 tokens as Jev counts them, a Workflow
  // batch 20,100 for 8 agents, far under 262k.
  contextByKind: { messagePlain: 96000, rejudge: 24000, agent: 96000, workflow: 96000 },
  // On (2026-10-15): an agent's request reads the conversation it was dispatched from, and a Workflow's its script, to 96000
  // tokens; the agents dispatched together share one request (core/agent-lane.ts), so the conversation is paid for once.
  agentBackground: true,
  // A request of 96000 estimated tokens took 1.0-1.6 s (p50 1.34 s) on 1.14 at 100-120k Jev tokens (eval v2, 2026-10-15); 3000
  // leaves room for the wait for its place within the account's token rate (decision/jev-rate.ts) when a burst is out.
  longWaitMs: 3000,
  // Four: four long requests of one key sent at once (115k tokens each) were all answered in 1.39-1.53 s, one alone in 1.44 s
  // (2026-10-15, DEVELOPMENT.md 「Jev 的长上下文」); more were not tried. The account's token rate paces them beyond that
  // (decision/jev-rate.ts: four full ones take most of a burst). The agents that come while four are out go in the next request.
  agentLanes: 4,
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
  findSkillWaitMs: null,
  // Several sessions on one key slow the first request (26k tokens) from 0.6-0.8 s to 0.9-1.3 s, and the second took
  // 0.27-0.48 s: sharing 1500 ms, 3 of 15 messages lost the second (2026-10-19, five sessions at once). 800 ms is above
  // the second's slowest; a message waits 2.3 s at most then, 3.8 s with a long effort request (`longWaitMs`).
  skillsSecondStageMs: 800,
  findSkillProfiles: true,
  // Raising is easy (DEVELOPMENT.md, 「按 AA 基准校正」): the level above the most probable one is taken from 0.3.
  roundUp: 0.3,
  // The hinted effort question's (2026-10-16, DEVELOPMENT.md 「强提示（#41）」): over the hinted answers of the flows,
  // 0.4 took max recall to 20/20 on long-context and 7/7 on eval-v2 (0.5: 18/20 and 7/7), max where it is not accepted 9/15
  // (0.5: 8/15); Jev's hinted answers of the real session that set this off were 0.37-0.48.
  hintThetaMax: 0.4,
  // effort-submit on the current wording, one run each (2026-10-05): asked in Chinese, Chinese items 85% and English
  // items 89%; asked in English, 79% and 78%. An agent's questions are asked in Chinese since Jev 1.14 (the subagent eval of
  // 2026-10-15, DEVELOPMENT.md 「Jev 1.14」: models-hint-zh 72/71% and again 72/72%, against models-hint's 71/68%; on 1.13 the
  // Chinese wording had been the weaker, 67/64% and 65/65%). The other questions stay in English.
  ask: { turnStart: { language: 'zh', primitive: 'score' }, agent: { language: 'zh', primitive: 'score' }, other: { language: 'en', primitive: 'score' } },
}

/**
 * pplx-decider-v1.1-27b's: B′ of eval v2 (#45, ADR 0006: the state within 48000 tokens, every question in English, no problem
 * summary), with the thresholds calibrated on its own stored answers (DEVELOPMENT.md, eval v2 的结果). It takes 262,144 tokens
 * a request (state and questions), so what it reads is not cut to Jev's 32k: 2000 messages (the budget, not the count, ends
 * what is sent) and its state up to what it answers within a message's wait (below); the skills' two stages keep Jev's 6000,
 * since the profiles of the skills are the same length for either model. A request takes seconds, not Jev's fraction of one,
 * so a message waits 8000 ms (a hook has 10 s) and a step 6000 ms for a re-decision. What the eval did not calibrate for pplx
 * (the failure bar, the agents' override, the skills' relevance) is Jev's.
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
  contextByKind: { messagePlain: 48000, rejudge: 48000, agent: 32000, workflow: 48000 },
  // On: pplx answers a full request in about 4 s, several at once (`pplxQps` lets five go together).
  agentBackground: true,
  // pplx takes 262k in every request (no header), and its own wait is seconds already.
  longWaitMs: null,
  // Five: five requests of 32000 at once were all answered within 5.2 s (`pplxQps` lets five go in a second).
  agentLanes: 5,
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
  // Find_skill's two requests wait as long as the profiles' question takes (a message's wait would be 8000 ms of a 10 s hook).
  findSkillWaitMs: 6000,
  // pplx's waits are seconds already, and a longer one would go past a hook's 10 s.
  skillsSecondStageMs: null,
  findSkillProfiles: true,
  // The level above the most probable one is taken from 0.45 (ADR 0006): the offline scan of the stored effort-submit answers
  // (English questions) took the level sent too high from 18.5% to 13.0% with the recall of max unchanged (11 of 16); eval v2's
  // level too low went from 12.5% to 15.0%.
  roundUp: 0.45,
  // Its own thetaMax: the hint was not measured on pplx with the wording of 2026-10-16.
  hintThetaMax: 0.47,
  ask: { turnStart: { language: 'en', primitive: 'score' }, agent: { language: 'en', primitive: 'score' }, other: { language: 'en', primitive: 'score' } },
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

/**
 * How long a re-decision's request (mid-turn, or a stuck loop's) waits for its answer: as long as a long request may, since
 * long ones of the mod's (a message's, an agent's) may be ahead of it for a place within the account's token rate
 * (decision/jev-rate.ts). The step it is for waits only `rejudgeWaitMs` for it, and an answer that comes later is taken at
 * a later step.
 */
export function redecisionWaitMs(config: Pick<Config, 'timeoutMs' | 'longWaitMs'>): number {
  return Math.max(config.timeoutMs, config.longWaitMs ?? 0)
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
  /** The TypeSafe key in the options (`typesafeApiKey`, trimmed; '' if unset). Not enumerable (see readConfig): it is not in a written-out or copied config. The environment's (`Secrets`) stands where this is empty. */
  readonly typesafeApiKey: string
  /** The Perplexity key in the options (`perplexityApiKey`, trimmed; '' if unset; not enumerable either): the environment's (`Secrets`) stands where this is empty. */
  readonly perplexityApiKey: string
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
  /** Skills (#10, #11, #12). */
  skills: {
    /** What a message is suggested: at most `max`, from `minRelevance`. */
    suggest: SkillPolicy
    /** What find_skill returns: at most `max`, from `minRelevance`. */
    find: SkillPolicy
    /** How long find_skill's two requests may take in all (the decision model's: BACKEND_DEFAULTS findSkillWaitMs). */
    findWaitMs: number
    /** The least a ranking's second request is given (BACKEND_DEFAULTS skillsSecondStageMs); null: what the first left. */
    secondStageMs: number | null
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
    /** `thetaMax` for an effort question that carries the strong hint: the decision model's `hintThetaMax`, never above `thetaMax`. */
    thetaMax: number
  }
}

/** The effort rules for an answer to an effort question that carried the strong hint: `thetaMax` is the hint's (`unresolved.thetaMax`). */
export function hintedRules<R extends EffortRules>(rules: R, config: Pick<Config, 'unresolved'>): R {
  return { ...rules, thetaMax: Math.min(rules.thetaMax, config.unresolved.thetaMax) }
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
}

/** The Perplexity key in use: the options' (`perplexityApiKey`) first, else the environment's. '' for none. */
export function perplexityKey(config: Pick<Config, 'perplexityApiKey'>, secrets: Secrets): string {
  return config.perplexityApiKey !== '' ? config.perplexityApiKey : secrets.perplexityEnvKey
}

/** The TypeSafe key in use: the options' (`typesafeApiKey`) first, else the environment's. '' for none. */
export function typesafeKey(config: Pick<Config, 'typesafeApiKey'>, secrets: Secrets): string {
  return config.typesafeApiKey !== '' ? config.typesafeApiKey : secrets.typesafeEnvKey
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
 * Which decision model decides is not known at register: either key may be in the environment, which the session start
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
  /**
   * The decision model that takes requests with images, with the backend to ask (`chooseImageBackend`); null when there is none
   * and the features that need images are unavailable. `fellBack`: it is pplx for want of a TypeSafe key, which cannot zoom
   * (needs Box questions). It is the same backend object as `backend` would be, so a pplx request goes through the rate limit
   * (its `io` needs `pace`, as every request's does).
   */
  readonly images: { readonly name: BackendName; readonly backend: Backend; readonly fellBack: boolean } | null
}

/** `table` is only a test's way to read a table the shipped one does not have (a decision model not added yet). */
export function setup(options: PluginOptions, table: Readonly<Record<BackendName, BackendDefaults>> = BACKEND_DEFAULTS): Ctx {
  const asked = backendNameOf(options)
  // Both are worked out here, whichever decides: pure and cheap, and `chooseBackend` picks between them once the environment is read.
  const configs: Record<BackendName, Config> = { pplx: readConfig(options, table, 'pplx'), jev: readConfig(options, table, 'jev') }
  const secrets: Secrets = { perplexityEnvKey: '', typesafeEnvKey: '' }
  const backends: Record<BackendName, Backend> = {
    // Every request goes through its account's rate limit: pplx's (#51), Jev's (requests and input tokens a second).
    pplx: rateLimited(pplxBackend(() => perplexityKey(configs.pplx, secrets)), configs.pplx.pplxQps),
    jev: jevRateLimited(jevBackend(() => typesafeKey(configs.jev, secrets)), () => configs.jev.jevLimits),
  }
  const keys = () => ({ perplexity: perplexityKey(configs.pplx, secrets), typesafe: typesafeKey(configs.jev, secrets) })
  const choice = () => chooseBackend(asked, keys())
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
  const { roundUp } = defaults
  const thetaMax = own('thetaMax', 0, 1)
  // `contextTokens` by kind of request: unset, each kind's own (BACKEND_DEFAULTS); set, the smaller of it and each kind's.
  const contextTokens = own('contextTokens', 100, defaults.contextTokensMax, true)
  const byKind = (cap: number) => (isNumber(options.contextTokens) ? Math.min(contextTokens, cap) : cap)
  const context = { messages: own('contextMessages', 0, defaults.contextMessagesMax, true), tokens: byKind(defaults.contextTokens) }
  const contextByKind = Object.fromEntries(CONTEXT_KINDS.map((kind) => [kind, byKind(defaults.contextByKind[kind])])) as Record<ContextKind, number>
  const haikuToWritten = stringOf(options.escalateHaikuTo, 'sonnet').trim()
  // A hook's own budget is 10 s and the timer's wait counts toward it.
  const timeoutMs = own('timeoutMs', 200, 8000)
  const config: Omit<Config, 'typesafeApiKey' | 'perplexityApiKey'> = {
    backend,
    defaults: { used, capped },
    pplxQps: whole(options.pplxQps, 1, 50, 5),
    jevLimits: {
      requestsPerSecond: whole(options.jevQps, 1, 1000, JEV_DEFAULT_LIMITS.requestsPerSecond),
      tokensPerSecond: whole(options.jevTokensPerSecond, 10_000, 100_000_000, JEV_DEFAULT_LIMITS.tokensPerSecond),
    },
    timeoutMs,
    longWaitMs: defaults.longWaitMs,
    ask: defaults.ask,
    thetaMax,
    roundUp,
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
        roundUp,
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
      background: defaults.agentBackground,
      lanes: defaults.agentLanes,
      waitMs: agentWaitMs(timeoutMs, defaults.longWaitMs),
    },
    skills: {
      suggest: { max: whole(options.skillsMax, 0, 10, 3), minRelevance: own('skillsMinRelevance', 0, 1) },
      find: { max: whole(options.findSkillMax, 1, 10, 5), minRelevance: own('findSkillMinRelevance', 0, 1) },
      findWaitMs: defaults.findSkillWaitMs ?? timeoutMs,
      secondStageMs: defaults.skillsSecondStageMs,
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
      thetaMax: Math.min(thetaMax, defaults.hintThetaMax),
    },
  }
  // In the table's order, whatever order they were read in.
  used.sort((a, b) => PER_BACKEND_OPTIONS.indexOf(a[0]) - PER_BACKEND_OPTIONS.indexOf(b[0]))
  // The keys are not enumerable: `JSON.stringify(config)`, `{ ...config }` and `Object.keys` do not meet them, so a
  // config written to a log, a result file or the board (the eval saves its settings) cannot carry a key by accident.
  return Object.defineProperties(config, {
    typesafeApiKey: { value: stringOf(options.typesafeApiKey, '').trim(), enumerable: false },
    perplexityApiKey: { value: stringOf(options.perplexityApiKey, '').trim(), enumerable: false },
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
  const suggestions = !skillsSwitchOn ? 'skill suggestions off (/dp skills on)' : config.skills.suggest.max === 0 ? 'skill suggestions off (skillsMax 0)' : 'skill suggestions on until /dp skills off'
  return `settings for ${backend}: ${used}; ${suggestions}${capped}`
}

/**
 * How an agent's model and effort are decided (decision/dispatched-agent.ts):
 * the same for a dispatched agent (#6) and a Workflow's agents (#8, #9), and
 * for the eval; its questions are asked as the decision model asks about an
 * agent (`config.ask.agent`), and `ask` writes them otherwise (the eval's variants).
 */
export function dispatchSettings(ctx: { config: Pick<Config, 'agents' | 'thetaMax' | 'roundUp' | 'ask'> }, ask: Partial<DispatchAsk> = {}): DispatchSettings {
  // Each read goes to `ctx`: a feature builds this when it registers, before the session start has settled the decision model.
  return {
    get models() {
      return ctx.config.agents.models
    },
    get ask() {
      return { ...ctx.config.ask.agent, ...ask }
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
const DEFAULT_PROFILE_MODEL = 'haiku'

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
