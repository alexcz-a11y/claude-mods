// Feature: find_skill (#12). Most skills are left out of the main agent's
// listing (features/skills.ts, ADR 0002), so when, partway through a turn,
// the work turns out to need a skill nobody suggested, the main agent can ask:
// it calls the tool with a few words on the work, and the decision model rates
// the session's skills against them, the same way it rates them beside a
// message (the same ranker, `modRanker`, in the same two stages (#11), over the
// same skills and their profiles, with the recent conversation read by the
// same rules). Nothing is pushed: the skills come back only as the tool's
// answer.
//
// Its switch is `find-skill` (`/dp find-skill off`), apart from `skills`
// (spec #56). The tool stays registered whatever the switches say, with a
// description that never changes (the tool list is part of the prompt cache);
// switched off, it says so when called.

import type { EngineInterface, HttpInit, On } from 'claude-code'
import { type Asked, describeAsked } from '../decision/backend.ts'
import { turnStartState } from '../decision/context.ts'
import { quoteStart } from '../decision/redact.ts'
import { modRanker, pickSkills, skillOpening, type SkillPick, type SkillPolicy, type SkillRanking } from '../decision/skills.ts'
import { answersFor, mergeParts, type DecisionRequest } from '../decision/system-one.ts'
import { recordDecision } from '../core/decisions.ts'
import { readSessionSkills } from '../core/profiles.ts'
import type { Ctx } from '../core/setup.ts'
import { describeStages, rankingSettings, type CatalogSkill } from '../core/skills.ts'
import { failureText, setStatus } from '../core/status.ts'
import { defineSwitch, isOn, masterOn } from '../core/switches.ts'

const CATALOG = { plugin: 'dispatch-pilot', key: 'skillCatalog' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

/** The switch's name, in `/dp` and in the decision log. */
const SWITCH = 'find-skill'
/** The skills feature's switch for profiles (#11): off, skills are rated by their descriptions here too. */
const PROFILES = 'skill-profiles'
/** The tool's name; the model calls it as `mcp__dispatch-pilot__find_skill`. */
const TOOL = 'find_skill'
const TOOL_CALLED = 'mcp__dispatch-pilot__find_skill'

/** What the model reads about the tool. Fixed: nothing of the session goes into it. */
const DESCRIPTION =
  "Searches this session's skills for the ones that fit a piece of work, and returns each one's exact name, its relevance (0 to 1) and what it is for. Use it when the work at hand might have a skill you have not been shown: a file format, a service or its tooling, or a way of working such as reviewing, planning, testing or releasing. Load a skill it returns with the Skill tool by that exact name. Skills only the user can start are never returned."
const INPUT = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'The kind of work you need a skill for, in a few words, such as "fill in a form in a PDF file" or "review a branch before merging".',
    },
  },
  required: ['query'],
  additionalProperties: false,
}
/** How an answer that brings no skill ends: the main agent's way on. */
const CARRY_ON = 'Carry on without it, or load a skill you know with the Skill tool by its exact name.'

/**
 * The session's skills: as read earlier this session (the skills feature
 * reads them at its start), else read now, with the profiles the store holds
 * (#11), and kept for the session; null when the session cannot be read.
 */
async function sessionCatalog($: EngineInterface, model: string): Promise<CatalogSkill[] | null> {
  const { value } = await $.state.get(CATALOG)
  if (value) return value.skills
  const found = await readSessionSkills(
    {
      commands: () => $.command.list(),
      listed: async () => (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.skills?.skillFrontmatter ?? [],
      overrides: async (source) => (await $.settings.read({ source })).skillOverrides,
      home: () => $.env.get('HOME'),
      cwd: () => $.session.cwd(),
      exists: (path) => $.fs.exists(path),
      read: (path) => $.fs.read(path),
      list: (path) => $.fs.list(path),
      get: (key) => $.store.get(key),
    },
    model,
  )
  if (found !== null) await $.state.set(CATALOG, { skills: found.skills })
  return found?.skills ?? null
}

/** One decision request for find_skill through the person's decision model, its outcome in the debug log. */
async function askLogged($: EngineInterface, ctx: Ctx, what: string, about: string, request: DecisionRequest, timeoutMs: number): Promise<Asked> {
  const io = { fetch: (url: string, init: HttpInit) => $.http.fetch(url, init), sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }) }
  const startedAt = await $.clock.now()
  const asked = await ctx.backend.ask(io, request, timeoutMs)
  const ms = (await $.clock.now()) - startedAt
  $.ui.log(`${what} [${Object.keys(request.questions).join(', ')}] to ${ctx.backend.name} ${about}: ${describeAsked(asked, ms)}`, { to: 'debug' })
  return asked
}

/** The opening of a catalog skill's SKILL.md for the ranking's second stage; null when it has no file. */
async function openingOf($: EngineInterface, catalog: readonly CatalogSkill[], name: string): Promise<string | null> {
  const file = catalog.find((skill) => skill.name === name)?.file ?? null
  return file === null ? null : skillOpening(await $.fs.read(file))
}

export function registerFindSkill(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: "answers the main agent's find_skill: the skills that fit the work it names", segments: ['find-skill'] })

  /** Skills never offered (the option the skills feature reads too). */
  const neverSuggested = new Set(ctx.config.skills.neverSuggested)
  const policy: SkillPolicy = ctx.config.skills.find
  /** How the mod's ranker ranks: the settings it rates the skills beside each message with. */
  const rankBy = rankingSettings(ctx)
  /** The model whose profiles the skills are offered by (#11). */
  const model = ctx.config.skills.profileModel

  // Registered once every plugin is loaded, under a match-all matcher (other
  // features set themselves up at session start too). Without a decision
  // model nothing could rate the skills, and the main agent keeps its listing.
  on('session.start', { cwd: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    if (ctx.backend.configured === false) return result
    try {
      const { tool } = await $.tool.register({ name: TOOL, description: DESCRIPTION, inputSchema: INPUT })
      if (tool !== TOOL_CALLED) $.ui.log(`find_skill is registered as ${tool}, but the hook answers ${TOOL_CALLED}: its calls will fail`, { to: 'debug' })
    } catch (error) {
      $.ui.log(`find_skill was not registered: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
    }
    return result
  })

  // The model's call: answered here, never passed on. Whatever goes wrong,
  // the answer says so at once (fail open: the turn goes on without a skill).
  on('tool.call', { tool: TOOL_CALLED }, async ($, e) => {
    if (!masterOn()) return { result: `Dispatch Pilot is switched off (/dp on turns it back on), so find_skill rated no skills. ${CARRY_ON}` }
    if (!isOn(SWITCH)) return { result: `find_skill is switched off (/dp ${SWITCH} on turns it back on), so it rated no skills. ${CARRY_ON}` }
    // A dispatched agent's listing is left whole (ADR 0002): it has every skill in view.
    if (e.agentId !== undefined) {
      return { result: "find_skill rates skills for the main agent, whose skill listing is cut short. Yours lists this session's skills: pick from it and load one with the Skill tool by its exact name." }
    }
    const query = typeof e.query === 'string' ? e.query.replace(/\s+/g, ' ').trim() : ''
    if (query === '') return { result: 'find_skill needs a query: a few words on the kind of work you need a skill for.' }
    const show = (text: string) => setStatus('find-skill', text, (line) => $.ui.status(line))
    try {
      // The skills the main agent can load, as a message asks about them: their question of stage
      // one is the very one beside a message (those only the person can start have one of their
      // own, which is not asked: they never come back); each by its profile, as beside a message,
      // unless profiles are switched off.
      const known = await sessionCatalog($, model)
      const candidates = known?.filter((skill) => skill.by === 'model' && !neverSuggested.has(skill.name)).map((skill) => (isOn(PROFILES) ? skill : { ...skill, profile: null })) ?? null
      if (candidates === null) {
        show("find_skill failed (the session's skills could not be read)")
        return { result: `find_skill could not read this session's skills. ${CARRY_ON}` }
      }
      const about = `for find_skill ${quoteStart(query)}`
      const ranker = modRanker(
        {
          ask: (request, timeoutMs) => askLogged($, ctx, 'second request', about, request, timeoutMs),
          opening: (option) => openingOf($, candidates, option.name),
        },
        rankBy,
      )
      const part = ranker.part(candidates)
      if (part === null) {
        show('find_skill none')
        return { result: `This session has no skill that find_skill could return. ${CARRY_ON}` }
      }

      // The same state as beside a message, the work named in place of the message; the
      // ranker's second request (#11) asks about the same. Both requests share one wait, as
      // beside a message: the second gets what the first left of timeoutMs (the hook has 10 s).
      const startedAt = await $.clock.now()
      const messages = ctx.config.context.messages > 0 ? await $.session.messages().catch(() => []) : []
      const request = mergeParts(turnStartState({ prompt: query, messages, limits: ctx.config.context }), [part])
      const asked = await askLogged($, ctx, 'request', about, request, ctx.config.timeoutMs)
      const left = ctx.config.timeoutMs - ((await $.clock.now()) - startedAt)
      const ranked = asked.ok ? await ranker.rank(answersFor(part, asked.answers), candidates, { state: request.state, timeoutMs: left }) : null
      const failure = !asked.ok ? asked.failure : ranked === null ? { kind: 'parse' as const, detail: 'no answer about the skills' } : ranked.failed
      if (ranked === null || failure !== undefined) {
        const why = failureText(ctx.backend.name, failure ?? { kind: 'parse', detail: 'no answer about the skills' })
        show(`find_skill failed (${why})`)
        return { result: `find_skill could not rate the skills (${why}). ${CARRY_ON}` }
      }
      const ranking = ranked

      // Only skills the main agent can load were asked about, and they alone can come back.
      const { suggest } = pickSkills(ranking, candidates, policy)
      const names = suggest.map((skill) => skill.name).join(', ')
      await recordDecision(
        { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
        (line) => $.ui.log(line, { to: 'debug' }),
        { feature: SWITCH, outcome: suggest.length > 0 ? `found ${names}` : 'found no skill', about: quoteStart(query), reason: describeRanking(ranking, policy) },
      )
      show(`find_skill ${suggest.length > 0 ? names : 'none'}`)
      return { result: found(query, suggest, policy) }
    } catch (error) {
      $.ui.log(`find_skill failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
      show('find_skill failed (see the debug log)')
      return { result: `find_skill could not rate the skills (an error in Dispatch Pilot, written to the debug log). ${CARRY_ON}` }
    }
  })
}

/** Why: what each stage of the ranking said (`describeStages`), and the bar a skill had to reach. */
function describeRanking(ranking: SkillRanking, policy: SkillPolicy): string {
  return `${describeStages(ranking)}; returned from ${policy.minRelevance.toFixed(2)}, at most ${policy.max}`
}

/** The answer: the skills that fit, each by name, relevance and description, most relevant first; or that none does. */
function found(query: string, suggest: readonly SkillPick[], policy: SkillPolicy): string {
  if (suggest.length === 0) {
    return `No skill fits "${query}": none reached relevance ${policy.minRelevance.toFixed(2)}. Carry on without one, try other words for the work, or load a skill you know with the Skill tool by its exact name.`
  }
  return [
    `Skills that fit "${query}", rated by Dispatch Pilot’s decision model (relevance 0 to 1), most relevant first. Load one with the Skill tool by its exact name if it fits the work:`,
    ...suggest.map((skill) => `- ${skill.name} (relevance ${skill.relevance.toFixed(2)})${skill.description ? `: ${skill.description}` : ''}`),
  ].join('\n')
}
