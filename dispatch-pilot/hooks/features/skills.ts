// Feature: skills (#10, #11). The main agent no longer reads the full skill
// listing the engine attaches at the start of a session (ADR 0002): a fixed
// note takes its place, saying where the skills went and how to come by one
// (the find_skill tool, while its switch is on). Instead, each time the
// person sends a message, the decision model ranks the skills against it in
// two stages (decision/skills.ts) and the few that fit are suggested beside
// the message. Skills only the person can start are pointed out to the person
// instead (「可试 /x」 on the board), never to the main agent.
//
// The ranking offers a skill by its bilingual profile once one is written
// (features/skill-profiles.ts writes them in the background at session
// start), by its description until then.
//
// Its switch is `skills` (`/dp skills off`, and `/dp off`). It starts on with
// Jev and off with Clef (core/setup.ts BACKEND_DEFAULTS: Clef's first stage
// takes longer than a message can wait); `/dp skills on` turns it on with
// either. Off, nothing is suggested and the main agent gets the listing back:
// a listing the engine asks about from then on passes as it is, and one
// already withheld in this conversation (the engine keeps that answer) goes
// beside the next message.
// `skill-profiles` switches the profiles alone (neither written nor offered).
// The find_skill tool (#12) has a switch of its own.

import type { EngineInterface, HttpInit, On } from 'claude-code'
import { type Asked, describeAsked } from '../decision/backend.ts'
import { quoteStart } from '../decision/redact.ts'
import { modRanker, pickSkills, relevanceBlock, skillOpening, type SkillPick, type SkillPolicy, type SkillRanking } from '../decision/skills.ts'
import type { DecisionRequest } from '../decision/system-one.ts'
import { contribute } from '../core/ballot.ts'
import { commandOf } from '../core/commands.ts'
import { update, type Cell } from '../core/plans.ts'
import { readSessionSkills } from '../core/profiles.ts'
import { isPersonsMessage } from '../core/prompts.ts'
import { reportDecision, type ReportIo } from '../core/report.ts'
import type { Ctx } from '../core/setup.ts'
import { describeStages, listingNames, rankingSettings, trimListing, type CatalogSkill } from '../core/skills.ts'
import { defineSwitch, isOn, masterOn } from '../core/switches.ts'

const SHOWN = { plugin: 'dispatch-pilot', key: 'skillsShown' } as const
const CATALOG = { plugin: 'dispatch-pilot', key: 'skillCatalog' } as const
const LISTING = { plugin: 'dispatch-pilot', key: 'skillListing' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

/** The feature's switch: the suggestions, and with them the withheld listing. */
const SWITCH = 'skills'
/** The profiles' switch (features/skill-profiles.ts registers it and writes them): off, skills are offered by their descriptions. */
const PROFILES = 'skill-profiles'
/** The find_skill tool's switch (features/find-skill.ts): the note in place of the listing names the tool only while it is on. */
const FIND_SKILL = 'find-skill'

/**
 * The session's skills read afresh, each with its profile when the store
 * holds one, and kept for the session. Null when the session's skills cannot
 * be read.
 */
async function readCatalog($: EngineInterface, model: string): Promise<CatalogSkill[] | null> {
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
  if (found === null) return null
  await $.state.set(CATALOG, { skills: found.skills })
  return found.skills
}

/**
 * The session's skills: as read earlier this session, else read now (and
 * kept for the session); null when the session cannot be read.
 */
async function sessionCatalog($: EngineInterface, model: string): Promise<CatalogSkill[] | null> {
  const { value } = await $.state.get(CATALOG)
  if (value) return value.skills
  return readCatalog($, model)
}

/** One decision request through the person's decision model, its outcome in the debug log as the core logs its own. */
async function askLogged($: EngineInterface, ctx: Ctx, what: string, request: DecisionRequest, timeoutMs: number): Promise<Asked> {
  const io = { fetch: (url: string, init: HttpInit) => $.http.fetch(url, init), sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }) }
  const startedAt = await $.clock.now()
  const asked = await ctx.backend.ask(io, request, timeoutMs)
  const ms = (await $.clock.now()) - startedAt
  $.ui.log(`${what} [${Object.keys(request.questions).join(', ')}] to ${ctx.backend.name}: ${describeAsked(asked, ms)}`, { to: 'debug' })
  return asked
}

/** The opening of a catalog skill's SKILL.md for the ranking's second stage; null when it has no file or it cannot be read. */
async function openingOf($: EngineInterface, catalog: readonly CatalogSkill[], name: string): Promise<string | null> {
  const file = catalog.find((skill) => skill.name === name)?.file ?? null
  if (file === null) return null
  return skillOpening(await $.fs.read(file))
}

export function registerSkills(on: On, ctx: Ctx): void {
  // On or off until the person flips it, by the decision model: off with Clef, whose first stage takes longer than a message can wait.
  defineSwitch({ name: SWITCH, info: 'suggests the skills that fit each message; the full skill listing stays out', default: ctx.config.skills.suggestByDefault, segments: ['skills'] })

  /** Skills the main agent keeps in its listing (names as the listing spells them). */
  const alwaysListed = new Set(ctx.config.skills.alwaysListed)
  /** Skills never offered, to the main agent or to the person. */
  const neverSuggested = new Set(ctx.config.skills.neverSuggested)
  const policy: SkillPolicy = ctx.config.skills.suggest
  /** How the skills are ranked: by the mod's ranker (`modRanker`, built for each message), as find_skill (#12) ranks them too. */
  const ranking = rankingSettings(ctx)
  /** The model whose profiles the skills are offered by (#11): the store keys them by it. */
  const profileModel = ctx.config.skills.profileModel
  /**
   * Whether the feature is at work now: its switch (and the master switch)
   * on, and a decision model set up to suggest (without one, withholding the
   * listing would only take the skills away). Asked where it acts, never at
   * register: the person's switches are loaded at session start.
   */
  const active = () => isOn(SWITCH) && ctx.backend.configured !== false
  /**
   * Whether the listing is withheld for this catalog: only while some skill
   * in it could be suggested (one the main agent can load, not in
   * skillsNeverSuggested). Withheld, the listing comes back only as
   * suggestions; with none to make, it stays.
   */
  const withholds = (catalog: readonly CatalogSkill[]) => catalog.some((skill) => skill.by === 'model' && !neverSuggested.has(skill.name))

  // Every plugin loaded (after the others' session.start, so their commands
  // are listed): the session's skills, read afresh, and a line saying what
  // came of it. The profiles they lack are written by features/skill-profiles.ts,
  // outside this feature, once this is done.
  on('session.start', { cwd: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    if (!isOn(SWITCH)) {
      if (masterOn() && !ctx.config.skills.suggestByDefault) {
        $.ui.log(`skills: off with ${ctx.config.backend} until /dp skills on, so the main agent keeps the skill listing (find_skill still answers)`, { to: 'debug' })
      }
      return result
    }
    if (!active()) {
      $.ui.log('skills: no decision model is set up, so the main agent keeps the skill listing and nothing is suggested', { to: 'debug' })
      return result
    }
    await $.state.set(CATALOG, null)
    const catalog = await readCatalog($, profileModel)
    if (catalog === null) {
      $.ui.log("skills: the session's skills could not be read, so the main agent keeps the skill listing", { to: 'debug' })
      return result
    }
    const persons = catalog.filter((skill) => skill.by === 'person').map((skill) => `/${skill.name}`)
    const models = catalog.length - persons.length
    const only = persons.length > 0 ? `, ${persons.length} only you can start (${persons.join(' ')})` : ''
    const listing = withholds(catalog) ? 'the listing is withheld from the main agent' : 'the main agent keeps the skill listing, since no skill in it could be suggested'
    $.ui.log(`skills: ${models} the main agent can load${only}; ${listing}`, { to: 'debug' })
    return result
  })

  // The engine's skill listing, as each request of a loop carries it (the
  // engine keeps the answer for the conversation). The main agent's gives way to
  // a fixed note on how to come by a skill, after the skills always listed.
  // A dispatched agent's (and a workflow agent's) reaches it untouched.
  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // Skills that cannot be suggested stay listed: no decision model, no catalog, or none in it to suggest.
    const catalog = active() ? await sessionCatalog($, profileModel) : null
    if (catalog === null || !withholds(catalog)) {
      await $.state.set(LISTING, { answered: 'passed', text: '' })
      return next(e)
    }
    const kept = trimListing(e.text, alwaysListed)
    const keptNames = kept === null ? 'none' : listingNames(kept).join(', ')
    // Picked as the engine asks, by the switch as it stands: the engine keeps the answer for the
    // conversation, so a later `/dp find-skill on|off` shows from the next one (DEVELOPMENT.md, 它做什么).
    const findSkill = isOn(FIND_SKILL)
    const hint = findSkill ? LISTING_HINT : LISTING_HINT_WITHOUT_FIND_SKILL
    const noted = findSkill ? 'the note names find_skill' : 'the note leaves find_skill out (switched off)'
    $.ui.log(`withheld the skill listing from the main agent (${listingNames(e.text).length} skills, ${e.text.length} characters); kept ${keptNames}; ${noted}`, { to: 'debug' })
    await $.state.set(LISTING, { answered: 'withheld', text: e.text })
    return { text: kept === null ? hint : `${kept}\n\n${hint}` }
  })

  // The person's message: the skills question goes into its ballot, beside
  // the effort question (one decision request, sent by the core).
  on('prompt.submit', { text: /(?:)/ }, async ($, e, next) => {
    if (!isPersonsMessage(e)) return next(e)
    if (!active()) {
      // Switched off after the listing was withheld: the engine keeps its answer for the conversation
      // (a $.ui.invalidate does not bring it back), so the listing goes beside this message, once.
      const { value: listing = null } = await $.state.get(LISTING)
      if (listing?.answered !== 'withheld') return next(e)
      await $.state.set(LISTING, { answered: 'restored', text: listing.text })
      $.ui.log(`skills is off: the skill listing withheld earlier goes to the main agent with ${quoteStart(e.text)}`, { to: 'debug' })
      const result = await next({ ...e, context: [...(e.context ?? []), restoredListing(listing.text)] })
      // Refused beneath: the model never read it.
      if (result.drop !== undefined) await $.state.set(LISTING, listing)
      return result
    }
    // A command turn: the person has picked the work already (#19).
    if (commandOf(e.text) !== null) return next(e)
    const known = await sessionCatalog($, profileModel)
    // Profiles switched off: every skill is offered by its description.
    const catalog = known?.filter((skill) => !neverSuggested.has(skill.name)).map((skill) => (isOn(PROFILES) ? skill : { ...skill, profile: null })) ?? null
    if (catalog === null) return next(e)
    const ranker = modRanker(
      {
        ask: (request, timeoutMs) => askLogged($, ctx, 'second skills request', request, timeoutMs),
        opening: (option) => openingOf($, catalog, option.name),
      },
      ranking,
    )
    const part = ranker.part(catalog)
    if (part === null) return next(e)
    const shown: Cell<string[]> = { get: () => $.state.get(SHOWN), set: (value, options) => $.state.set(SHOWN, value, options) }
    /** The skills this message describes for the first time. */
    let described: string[] = []
    // Both requests share the message's wait: the second gets what the first left of timeoutMs.
    const startedAt = await $.clock.now()

    contribute(e.text, {
      ...part,
      settle: async (outcome) => {
        const io: ReportIo = {
          board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
          decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
          debug: (line) => $.ui.log(line, { to: 'debug' }),
          status: (line) => $.ui.status(line),
        }
        // Beside the main agent's own decision for the message: in the log, not on its node.
        const about = { feature: SWITCH, agent: 'main', aside: true as const, forTurn: e.turnId === undefined ? ('next' as const) : ('current' as const), subject: quoteStart(e.text) }
        const left = ctx.config.timeoutMs - ((await $.clock.now()) - startedAt)
        // No answer (the main-effort decision says why) or none about the skills: nothing suggested.
        const ranked = outcome.ok ? await ranker.rank(outcome.answers, catalog, { state: outcome.state, timeoutMs: left }) : null
        if (ranked === null) {
          if (outcome.ok) $.ui.log(`skills for ${quoteStart(e.text)}: no answer about the skills`, { to: 'debug' })
          await reportDecision(io, { ...about, skipped: 'unanswered' as const })
          return
        }
        if (ranked.failed !== undefined) {
          $.ui.log(`skills for ${quoteStart(e.text)}: not rated, the second request failed (${ranked.failed.kind}: ${ranked.failed.detail})`, { to: 'debug' })
          await reportDecision(io, { ...about, failure: { backend: ctx.backend.name, ...ranked.failed } })
          return
        }
        const { suggest, hint } = pickSkills(ranked, catalog, policy)
        await reportDecision(io, {
          ...about,
          outcome: describePicks(suggest, hint),
          reason: describeRanking(ranked, policy),
          skills: { suggest: suggest.map(({ name, relevance }) => ({ name, relevance })), try: hint.map(({ name, relevance }) => ({ name, relevance })) },
        })
        const { value: before = [] } = await $.state.get(SHOWN)
        const known = new Set([...before, ...alwaysListed])
        const block = relevanceBlock(suggest, known)
        described = suggest.map((skill) => skill.name).filter((name) => !known.has(name))
        if (described.length > 0) await update(shown, (list) => [...new Set([...(list ?? []), ...described])])
        return block === null ? [] : [block]
      },
    })

    const result = await next(e)
    // Refused beneath: the model never read those descriptions.
    if (result.drop !== undefined && described.length > 0) {
      const withdrawn = new Set(described)
      await update(shown, (list) => (list ?? []).filter((name) => !withdrawn.has(name)))
    }
    return result
  })

  // A new conversation (/clear) or a compacted one no longer holds what was
  // given beside earlier messages (descriptions, a restored listing): give it
  // again. A new conversation also reads the skills afresh, and the engine
  // asks about its listing anew.
  on('session.end', { reason: /(?:)/ }, async ($, e, next) => {
    await $.state.set(SHOWN, [])
    await $.state.set(CATALOG, null)
    await $.state.set(LISTING, null)
    return next(e)
  })
  on('session.compact', { trigger: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || result.skip !== undefined) return result
    await $.state.set(SHOWN, [])
    const { value: listing = null } = await $.state.get(LISTING)
    if (listing?.answered === 'restored') await $.state.set(LISTING, { answered: 'withheld', text: listing.text })
    return result
  })
}

/**
 * What the main agent reads in place of the skill listing: where the skills
 * went and how to come by one. Fixed text, naming no skill: the engine keeps
 * the answer for the conversation, and it is part of the prompt cache. It
 * names find_skill in full and says it may need ToolSearch: the tool is
 * deferred, so until loaded the main agent sees only its name. (A wording that
 * also said when to look, in find_skill's own words, did no better on a real
 * engine; DEVELOPMENT.md, 已实测的引擎行为.)
 */
const LISTING_HINT =
  "Dispatch Pilot leaves most of this session's skills out of the skill listing. The ones that fit a message may be suggested beside it. For any other skill, call the find_skill tool (mcp__dispatch-pilot__find_skill; load it with ToolSearch first if it is deferred) with a few words on the work, then load a skill it returns with the Skill tool by its exact name."
/** The same with find_skill switched off: it does not send the main agent to a tool that would only say it is off. */
const LISTING_HINT_WITHOUT_FIND_SKILL =
  "Dispatch Pilot leaves most of this session's skills out of the skill listing. The ones that fit a message may be suggested beside it; load one, or any skill you know, with the Skill tool by its exact name."

/** The listing the feature withheld, as it goes beside a message once the feature is switched off. */
function restoredListing(text: string): string {
  return `Dispatch Pilot's skill suggestions are switched off, so here is the skill listing it had left out:\n\n${text}`
}

/** Why: what each stage of the ranking said (`describeStages`), and the bar a skill had to reach. */
function describeRanking(ranking: SkillRanking, policy: SkillPolicy): string {
  return `${describeStages(ranking)}; suggested from ${policy.minRelevance.toFixed(2)}, at most ${policy.max}`
}

/** What the message got: the skills suggested, then those for the person to start. */
function describePicks(suggest: readonly SkillPick[], hint: readonly SkillPick[]): string {
  const suggested = suggest.length > 0 ? `suggested ${suggest.map((skill) => skill.name).join(', ')}` : 'suggested no skill'
  return hint.length > 0 ? `${suggested}; try ${hint.map((skill) => `/${skill.name}`).join(' ')}` : suggested
}
