// Feature: skills (#10). The main agent no longer reads the full skill
// listing the engine attaches at the start of a session (ADR 0002); instead,
// each time the person sends a message, the decision model rates the skills
// against it and the few that fit are suggested beside the message. Skills
// only the person can start are pointed out on the status line instead.
//
// Its switch is `skills` (`/dp skills off`): off, nothing is suggested and the
// main agent reads the listing as the engine wrote it again (from the next
// message on, see `listingWanted`). The find_skill tool (#12) has a switch of
// its own.

import type { EngineInterface, On } from 'claude-code'
import { redactSecrets } from '../decision/redact.ts'
import { choiceRanker, pickSkills, relevanceBlock, type SkillPick, type SkillPolicy, type SkillRanking } from '../decision/skills.ts'
import { contribute } from '../core/ballot.ts'
import { recordDecision } from '../core/decisions.ts'
import { update, type Cell } from '../core/plans.ts'
import { isPersonsMessage } from '../core/prompts.ts'
import { namesOf, numberIn, type Ctx } from '../core/setup.ts'
import { listingNames, loadCatalog, trimListing, type CatalogSkill } from '../core/skills.ts'
import { setStatus } from '../core/status.ts'
import { defineSwitch, isOn } from '../core/switches.ts'

const SHOWN = { plugin: 'dispatch-pilot', key: 'skillsShown' } as const
const CATALOG = { plugin: 'dispatch-pilot', key: 'skillCatalog' } as const
const LISTING = { plugin: 'dispatch-pilot', key: 'skillListing' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

/** The feature's switch: the suggestions, and with them the withheld listing. */
const SWITCH = 'skills'

/**
 * The session's skills: as read earlier this session, else read now (and
 * kept for the session); null when the session cannot be read.
 */
async function sessionCatalog($: EngineInterface): Promise<CatalogSkill[] | null> {
  const { value } = await $.state.get(CATALOG)
  if (value) return value.skills
  const skills = await loadCatalog({
    commands: () => $.command.list(),
    listed: async () => (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.skills?.skillFrontmatter ?? [],
    overrides: async (source) => (await $.settings.read({ source })).skillOverrides,
    home: () => $.env.get('HOME'),
    cwd: () => $.session.cwd(),
    exists: (path) => $.fs.exists(path),
    read: (path) => $.fs.read(path),
  }).catch(() => null)
  if (skills !== null) await $.state.set(CATALOG, { skills })
  return skills
}

export function registerSkills(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: 'suggests the skills that fit each message; the full skill listing stays out', segments: ['skills'] })

  /** Skills the main agent keeps in its listing (names as the listing spells them). */
  const alwaysListed = new Set(namesOf(ctx.options.skillsAlwaysListed))
  /** Skills never offered, to the main agent or to the person. */
  const neverSuggested = new Set(namesOf(ctx.options.skillsNeverSuggested))
  const policy: SkillPolicy = {
    max: Math.round(numberIn(ctx.options.skillsMax, 0, 10, 3)),
    minRelevance: numberIn(ctx.options.skillsMinRelevance, 0, 1, 0.2),
  }
  /** How the skills are rated: one Choice in the message's request (#11 swaps in its own). */
  const ranker = choiceRanker({ language: ctx.ask.language })
  /**
   * Whether the feature is at work now: its switch (and the master switch)
   * on, and a decision model set up to suggest (without one, withholding the
   * listing would only take the skills away). Asked where it acts, never at
   * register: the person's switches are loaded at session start.
   */
  const active = () => isOn(SWITCH) && ctx.backend.configured !== false

  // Every plugin loaded (after the others' session.start, so their commands
  // are listed): the session's skills, read afresh, and a line saying what
  // came of it.
  on('session.start', { cwd: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    if (!isOn(SWITCH)) return result
    if (!active()) {
      $.ui.log('skills: no decision model is set up, so the main agent keeps the skill listing and nothing is suggested', { to: 'debug' })
      return result
    }
    await $.state.set(CATALOG, null)
    const catalog = await sessionCatalog($)
    if (catalog === null) {
      $.ui.log("skills: the session's skills could not be read, so the main agent keeps the skill listing", { to: 'debug' })
      return result
    }
    const persons = catalog.filter((skill) => skill.by === 'person').map((skill) => `/${skill.name}`)
    const models = catalog.length - persons.length
    const only = persons.length > 0 ? `, ${persons.length} only you can start (${persons.join(' ')})` : ''
    $.ui.log(`skills: ${models} the main agent can load${only}; the listing is withheld from the main agent`, { to: 'debug' })
    return result
  })

  // The engine's skill listing, as each request of a loop carries it (the
  // engine keeps the answer for the process). A dispatched agent's (and a
  // workflow agent's) reaches it untouched.
  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // Skills that cannot be suggested stay listed.
    if (!active() || (await sessionCatalog($)) === null) {
      await $.state.set(LISTING, 'passed')
      return next(e)
    }
    const kept = trimListing(e.text, alwaysListed)
    const keptNames = kept === null ? 'none' : listingNames(kept).join(', ')
    $.ui.log(`withheld the skill listing from the main agent (${listingNames(e.text).length} skills, ${e.text.length} characters); kept ${keptNames}`, { to: 'debug' })
    await $.state.set(LISTING, 'withheld')
    return { text: kept }
  })

  // The person's message: the skills question goes into its ballot, beside
  // the effort question (one decision request, sent by the core).
  on('prompt.submit', { text: /(?:)/ }, async ($, e, next) => {
    if (!isPersonsMessage(e)) return next(e)
    // The switch flipped since the engine took its answer about the listing: have it ask again.
    const { value: answered = null } = await $.state.get(LISTING)
    if (answered !== null && answered !== (active() ? 'withheld' : 'passed')) {
      $.ui.invalidate('prompt.attachment')
      await $.state.set(LISTING, null)
    }
    if (!active()) return next(e)
    const catalog = (await sessionCatalog($))?.filter((skill) => !neverSuggested.has(skill.name)) ?? null
    const part = catalog === null ? null : ranker.part(catalog)
    if (catalog === null || part === null) return next(e)
    const shown: Cell<string[]> = { get: () => $.state.get(SHOWN), set: (value, options) => $.state.set(SHOWN, value, options) }
    /** The skills this message describes for the first time. */
    let described: string[] = []

    contribute(e.text, {
      ...part,
      settle: async (outcome) => {
        const show = (line: string | undefined) => $.ui.status(line)
        // No answer (the decision segment says why) or none about the skills: nothing suggested.
        const ranking = outcome.ok ? await ranker.rank(outcome.answers, catalog) : null
        if (ranking === null) {
          if (outcome.ok) $.ui.log(`skills for ${quote(e.text)}: no answer about the skills`, { to: 'debug' })
          setStatus('skills', null, show)
          return
        }
        const { suggest, hint } = pickSkills(ranking, catalog, policy)
        await recordDecision(
          { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
          (line) => $.ui.log(line, { to: 'debug' }),
          { feature: SWITCH, outcome: describePicks(suggest, hint), about: quote(e.text), reason: describeRanking(ranking, policy) },
        )
        setStatus('skills', statusText(suggest, hint), show)
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

  // A new conversation (/clear) or a compacted one no longer holds the
  // descriptions given beside earlier messages: give them again. A new one
  // also reads the skills afresh.
  on('session.end', { reason: /(?:)/ }, async ($, e, next) => {
    await $.state.set(SHOWN, [])
    await $.state.set(CATALOG, null)
    return next(e)
  })
  on('session.compact', { trigger: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && result.skip === undefined) await $.state.set(SHOWN, [])
    return result
  })
}

/** The start of a message for the debug log, secrets masked. */
function quote(text: string): string {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim()
  return JSON.stringify(flat.length > 40 ? `${flat.slice(0, 40)}...` : flat)
}

/** Why: the head of the ranking (no skill under 0.005), none's share, and the bar a skill had to reach. */
function describeRanking(ranking: SkillRanking, policy: SkillPolicy): string {
  const head = ranking.ranked.filter((entry) => entry.relevance >= 0.005).slice(0, 5)
  const shares = [...head.map((entry) => `${entry.name} ${entry.relevance.toFixed(2)}`), `none ${ranking.none.toFixed(2)}`].join(', ')
  return `${shares}; suggested from ${policy.minRelevance.toFixed(2)}, at most ${policy.max}`
}

/** What the message got: the skills suggested, then those for the person to start. */
function describePicks(suggest: readonly SkillPick[], hint: readonly SkillPick[]): string {
  const suggested = suggest.length > 0 ? `suggested ${suggest.map((skill) => skill.name).join(', ')}` : 'suggested no skill'
  return hint.length > 0 ? `${suggested}; try ${hint.map((skill) => `/${skill.name}`).join(' ')}` : suggested
}

/** The status line's skills segment: the skills suggested, then those for the person to start; null for neither. */
function statusText(suggest: readonly SkillPick[], hint: readonly SkillPick[]): string | null {
  const parts = [
    ...(suggest.length > 0 ? [`skills ${suggest.map((skill) => skill.name).join(', ')}`] : []),
    ...(hint.length > 0 ? [`try ${hint.map((skill) => `/${skill.name}`).join(' ')}`] : []),
  ]
  return parts.length > 0 ? parts.join(' | ') : null
}
