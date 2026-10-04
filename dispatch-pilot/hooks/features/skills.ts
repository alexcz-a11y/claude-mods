// Feature: skills (#10, #11). The main agent no longer reads the full skill
// listing the engine attaches at the start of a session (ADR 0002); instead,
// each time the person sends a message, the decision model ranks the skills
// against it in two stages (decision/skills.ts) and the few that fit are
// suggested beside the message. Skills only the person can start are pointed
// out on the status line instead.
//
// At session start a cheap model writes each skill a bilingual profile from
// its SKILL.md, in the background, once per version of the file
// (core/profiles.ts); the ranking offers a skill by its profile once one is
// written, by its description until then.
//
// Its switch is `skills` (`/dp skills off`, and `/dp off`): off, nothing is
// suggested and the main agent gets the listing back: a listing the engine
// asks about from then on passes as it is, and one already withheld in this
// conversation (the engine keeps that answer) goes beside the next message.
// `skill-profiles` switches the profiles alone (neither written nor offered).
// The find_skill tool (#12) has a switch of its own.

import type { EngineInterface, HttpInit, ModelCompleteResult, On } from 'claude-code'
import type { Asked } from '../decision/backend.ts'
import { redactSecrets } from '../decision/redact.ts'
import { pickSkills, relevanceBlock, SHORTLIST_FLOOR, skillOpening, twoStageRanker, type SkillPick, type SkillPolicy, type SkillRanking } from '../decision/skills.ts'
import type { DecisionRequest } from '../decision/system-one.ts'
import { contribute } from '../core/ballot.ts'
import { recordDecision } from '../core/decisions.ts'
import { update, type Cell } from '../core/plans.ts'
import {
  DEFAULT_PROFILE_MODEL,
  evictions,
  lookUpProfiles,
  MAX_PROFILES,
  PROFILE_MAX_TOKENS,
  PROFILE_PREFIX,
  PROFILE_SYSTEM,
  PROFILE_TIMEOUT_MS,
  profileKey,
  profilePrompt,
  readProfile,
  storedProfile,
  withProfile,
  type StoredProfile,
} from '../core/profiles.ts'
import { isPersonsMessage } from '../core/prompts.ts'
import { namesOf, numberIn, stringOf, type Ctx } from '../core/setup.ts'
import { listingNames, loadCatalog, rankingSettings, trimListing, type CatalogSkill } from '../core/skills.ts'
import { failureText, setStatus } from '../core/status.ts'
import { defineSwitch, isOn } from '../core/switches.ts'

const SHOWN = { plugin: 'dispatch-pilot', key: 'skillsShown' } as const
const CATALOG = { plugin: 'dispatch-pilot', key: 'skillCatalog' } as const
const LISTING = { plugin: 'dispatch-pilot', key: 'skillListing' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const

/** The feature's switch: the suggestions, and with them the withheld listing. */
const SWITCH = 'skills'
/** The profiles' own switch: written at session start, and offered in the ranking. */
const PROFILES = 'skill-profiles'

/** Profiles are being written now (one batch at a time). */
let writing = false

/**
 * The session's skills read afresh, each with its profile when the store
 * holds one, and kept for the session; `store` says whether the store could
 * be read. Null when the session's skills cannot be read.
 */
async function readCatalog($: EngineInterface, model: string): Promise<{ skills: CatalogSkill[]; store: boolean } | null> {
  const skills = await loadCatalog({
    commands: () => $.command.list(),
    listed: async () => (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.skills?.skillFrontmatter ?? [],
    overrides: async (source) => (await $.settings.read({ source })).skillOverrides,
    home: () => $.env.get('HOME'),
    cwd: () => $.session.cwd(),
    exists: (path) => $.fs.exists(path),
    read: (path) => $.fs.read(path),
    list: (path) => $.fs.list(path),
  }).catch(() => null)
  if (skills === null) return null
  const found = await lookUpProfiles(skills, { read: (path) => $.fs.read(path), get: (key) => $.store.get(key) }, model)
  await $.state.set(CATALOG, { skills: found.skills })
  return found
}

/**
 * The session's skills: as read earlier this session, else read now (and
 * kept for the session); null when the session cannot be read.
 */
async function sessionCatalog($: EngineInterface, model: string): Promise<CatalogSkill[] | null> {
  const { value } = await $.state.get(CATALOG)
  if (value) return value.skills
  return (await readCatalog($, model))?.skills ?? null
}

/** How profiles are written: the model, how many at most per session start, the skills never offered (none written for them). */
type ProfileSettings = { model: string; perSession: number; skip: ReadonlySet<string> }

/**
 * Writes the profiles the catalog lacks, one completion at a time, in the
 * catalog's order (the skills the main agent can load first), at most
 * `perSession`; each is kept in the store and given to the session's catalog
 * at once. Runs in the background from session start: nothing waits for it.
 * Stops for this session when the model is refused or answers with an API
 * error, the store will not keep a profile, or the person switches profiles
 * off; a skill whose reply is not a profile (or is cut short) is skipped.
 * What is left is tried again at the next session start. Then drops the
 * oldest profiles past MAX_PROFILES.
 */
async function writeProfiles($: EngineInterface, ctx: Ctx, catalog: readonly CatalogSkill[], settings: ProfileSettings): Promise<void> {
  if (writing) return
  writing = true
  const cell: Cell<{ skills: CatalogSkill[] } | null> = { get: () => $.state.get(CATALOG), set: (value, options) => $.state.set(CATALOG, value, options) }
  const due = catalog.filter((skill) => !skill.profile && typeof skill.profileKey === 'string' && !settings.skip.has(skill.name))
  let written = 0
  try {
    for (const skill of due) {
      if (!isOn(SWITCH) || !isOn(PROFILES) || ctx.backend.configured === false) break
      if (written >= settings.perSession) {
        $.ui.log(`skill profiles: ${due.length - written} left to write at a later session start (at most ${settings.perSession} each)`, { to: 'debug' })
        break
      }
      const markdown = skill.file === null ? null : await $.fs.read(skill.file).catch(() => null)
      const key = profileKey(skill, markdown, settings.model)
      // Another session may have written it meanwhile.
      const kept = storedProfile(await $.store.get(key).catch(() => undefined))
      if (kept !== null) {
        await update(cell, (value) => (value ? { skills: withProfile(value.skills, key, kept) } : null))
        continue
      }
      const startedAt = await $.clock.now()
      let reply: ModelCompleteResult
      try {
        reply = await $.model.complete({ model: settings.model, system: PROFILE_SYSTEM, prompt: profilePrompt(skill, markdown), maxTokens: PROFILE_MAX_TOKENS, timeoutMs: PROFILE_TIMEOUT_MS })
      } catch (error) {
        $.ui.log(`skill profiles: ${settings.model} was refused (${errorText(error)}); no more profiles are written this session`, { to: 'debug' })
        break
      }
      const ms = (await $.clock.now()) - startedAt
      if (!reply.isAnswered) {
        const why = reply.reason === 'api-error' ? `an API error, HTTP ${reply.status ?? 'none'} ${reply.error}` : reply.reason
        if (reply.reason === 'api-error') {
          $.ui.log(`skill profiles: no profile for ${skill.name} (${why}, ${ms} ms); no more profiles are written this session`, { to: 'debug' })
          break
        }
        $.ui.log(`skill profiles: no profile for ${skill.name} (${why}, ${ms} ms)`, { to: 'debug' })
        continue
      }
      const profile = readProfile(reply.text)
      if (profile === null) {
        $.ui.log(`skill profiles: the reply for ${skill.name} is not a profile (${ms} ms): ${JSON.stringify(reply.text.slice(0, 80))}`, { to: 'debug' })
        continue
      }
      const entry: StoredProfile = { name: skill.name, at: await $.clock.now(), profile }
      try {
        await $.store.set(key, entry)
      } catch (error) {
        $.ui.log(`skill profiles: the store did not keep the profile of ${skill.name} (${errorText(error)}); no more profiles are written this session`, { to: 'debug' })
        break
      }
      await update(cell, (value) => (value ? { skills: withProfile(value.skills, key, profile) } : null))
      written++
      $.ui.log(`skill profile written for ${skill.name} by ${settings.model} in ${ms} ms (${reply.usage.input_tokens} input, ${reply.usage.output_tokens} output tokens)`, { to: 'debug' })
    }
    await dropOldProfiles($, catalog)
  } catch (error) {
    // The session went away under it (its `$` refused), or a bug: either way the session is not held up.
    try {
      $.ui.log(`skill profiles: stopped writing (${errorText(error)})`, { to: 'debug' })
    } catch {
      // nowhere left to say it
    }
  } finally {
    writing = false
  }
}

/** Past MAX_PROFILES profiles in the store, the oldest written that this session does not use are deleted. */
async function dropOldProfiles($: EngineInterface, catalog: readonly CatalogSkill[]): Promise<void> {
  try {
    const keys = (await $.store.keys()).filter((key) => key.startsWith(PROFILE_PREFIX))
    if (keys.length <= MAX_PROFILES) return
    const entries = await Promise.all(keys.map(async (key) => ({ key, at: writtenAt(await $.store.get(key).catch(() => null)) })))
    const drop = evictions(entries, new Set(catalog.flatMap((skill) => (typeof skill.profileKey === 'string' ? [skill.profileKey] : []))))
    for (const key of drop) await $.store.delete(key)
    $.ui.log(`skill profiles: dropped the ${drop.length} oldest of ${keys.length} kept`, { to: 'debug' })
  } catch (error) {
    $.ui.log(`skill profiles: could not tidy the store (${errorText(error)})`, { to: 'debug' })
  }
}

/** One decision request through the person's decision model, its outcome in the debug log as the core logs its own. */
async function askLogged($: EngineInterface, ctx: Ctx, what: string, request: DecisionRequest, timeoutMs: number): Promise<Asked> {
  const io = { fetch: (url: string, init: HttpInit) => $.http.fetch(url, init), sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }) }
  const startedAt = await $.clock.now()
  const asked = await ctx.backend.ask(io, request, timeoutMs)
  const ms = (await $.clock.now()) - startedAt
  const outcome = asked.ok
    ? `answered in ${ms} ms${asked.model === null ? '' : ` by ${asked.model}`}${asked.inputTokens === null ? '' : ` (${asked.inputTokens} input tokens)`}`
    : `${asked.failure.kind}: ${asked.failure.detail} (${ms} ms)`
  $.ui.log(`${what} [${Object.keys(request.questions).join(', ')}] to ${ctx.backend.name}: ${outcome}`, { to: 'debug' })
  return asked
}

/** The opening of a catalog skill's SKILL.md for the ranking's second stage; null when it has no file or it cannot be read. */
async function openingOf($: EngineInterface, catalog: readonly CatalogSkill[], name: string): Promise<string | null> {
  const file = catalog.find((skill) => skill.name === name)?.file ?? null
  if (file === null) return null
  return skillOpening(await $.fs.read(file))
}

export function registerSkills(on: On, ctx: Ctx): void {
  defineSwitch({ name: SWITCH, info: 'suggests the skills that fit each message; the full skill listing stays out', segments: ['skills'] })
  defineSwitch({ name: PROFILES, info: 'rates skills by bilingual profiles a cheap model writes once per SKILL.md version (off: by description)' })

  /** Skills the main agent keeps in its listing (names as the listing spells them). */
  const alwaysListed = new Set(namesOf(ctx.options.skillsAlwaysListed))
  /** Skills never offered, to the main agent or to the person. */
  const neverSuggested = new Set(namesOf(ctx.options.skillsNeverSuggested))
  const policy: SkillPolicy = {
    max: Math.round(numberIn(ctx.options.skillsMax, 0, 10, 3)),
    minRelevance: numberIn(ctx.options.skillsMinRelevance, 0, 1, 0.2),
  }
  /** How the skills are ranked: the two stages, as find_skill ranks them too. */
  const ranking = rankingSettings(ctx)
  /** How profiles are written. */
  const profiles: ProfileSettings = {
    model: stringOf(ctx.options.skillsProfileModel, DEFAULT_PROFILE_MODEL).trim() || DEFAULT_PROFILE_MODEL,
    perSession: Math.round(numberIn(ctx.options.skillsProfilesPerSession, 0, 500, 30)),
    skip: neverSuggested,
  }
  /**
   * Whether the feature is at work now: its switch (and the master switch)
   * on, and a decision model set up to suggest (without one, withholding the
   * listing would only take the skills away). Asked where it acts, never at
   * register: the person's switches are loaded at session start.
   */
  const active = () => isOn(SWITCH) && ctx.backend.configured !== false

  // Every plugin loaded (after the others' session.start, so their commands
  // are listed): the session's skills, read afresh, and a line saying what
  // came of it; then the profiles they lack are written in the background.
  on('session.start', { cwd: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    if (!isOn(SWITCH)) return result
    if (!active()) {
      $.ui.log('skills: no decision model is set up, so the main agent keeps the skill listing and nothing is suggested', { to: 'debug' })
      return result
    }
    await $.state.set(CATALOG, null)
    const read = await readCatalog($, profiles.model)
    if (read === null) {
      $.ui.log("skills: the session's skills could not be read, so the main agent keeps the skill listing", { to: 'debug' })
      return result
    }
    const catalog = read.skills
    const persons = catalog.filter((skill) => skill.by === 'person').map((skill) => `/${skill.name}`)
    const models = catalog.length - persons.length
    const only = persons.length > 0 ? `, ${persons.length} only you can start (${persons.join(' ')})` : ''
    $.ui.log(`skills: ${models} the main agent can load${only}; the listing is withheld from the main agent`, { to: 'debug' })
    if (!isOn(PROFILES)) return result
    if (!read.store) {
      $.ui.log('skill profiles: the store cannot be read, so no profile is kept or written; skills are rated by their descriptions', { to: 'debug' })
      return result
    }
    const offered = catalog.filter((skill) => !profiles.skip.has(skill.name))
    const due = offered.filter((skill) => !skill.profile).length
    $.ui.log(`skill profiles: ${offered.length - due} kept, ${due} to write with ${profiles.model} (at most ${profiles.perSession} this session)`, { to: 'debug' })
    // In the background: the session goes on, and each profile is used as soon as it is written.
    if (due > 0 && profiles.perSession > 0) void writeProfiles($, ctx, catalog, profiles).catch(() => undefined)
    return result
  })

  // The engine's skill listing, as each request of a loop carries it (the
  // engine keeps the answer for the process). A dispatched agent's (and a
  // workflow agent's) reaches it untouched.
  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // Skills that cannot be suggested stay listed.
    if (!active() || (await sessionCatalog($, profiles.model)) === null) {
      await $.state.set(LISTING, { answered: 'passed', text: '' })
      return next(e)
    }
    const kept = trimListing(e.text, alwaysListed)
    const keptNames = kept === null ? 'none' : listingNames(kept).join(', ')
    $.ui.log(`withheld the skill listing from the main agent (${listingNames(e.text).length} skills, ${e.text.length} characters); kept ${keptNames}`, { to: 'debug' })
    await $.state.set(LISTING, { answered: 'withheld', text: e.text })
    return { text: kept }
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
      $.ui.log(`skills is off: the skill listing withheld earlier goes to the main agent with ${quote(e.text)}`, { to: 'debug' })
      const result = await next({ ...e, context: [...(e.context ?? []), restoredListing(listing.text)] })
      // Refused beneath: the model never read it.
      if (result.drop !== undefined) await $.state.set(LISTING, listing)
      return result
    }
    const known = await sessionCatalog($, profiles.model)
    // Profiles switched off: every skill is offered by its description.
    const catalog = known?.filter((skill) => !neverSuggested.has(skill.name)).map((skill) => (isOn(PROFILES) ? skill : { ...skill, profile: null })) ?? null
    if (catalog === null) return next(e)
    const ranker = twoStageRanker(
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
        const show = (line: string | undefined) => $.ui.status(line)
        const left = ctx.config.timeoutMs - ((await $.clock.now()) - startedAt)
        // No answer (the decision segment says why) or none about the skills: nothing suggested.
        const ranked = outcome.ok ? await ranker.rank(outcome.answers, catalog, { state: outcome.state, timeoutMs: left }) : null
        if (ranked === null) {
          if (outcome.ok) $.ui.log(`skills for ${quote(e.text)}: no answer about the skills`, { to: 'debug' })
          setStatus('skills', null, show)
          return
        }
        if (ranked.failed !== undefined) {
          $.ui.log(`skills for ${quote(e.text)}: not rated, the ${ranked.failed.stage} request failed (${ranked.failed.failure.kind}: ${ranked.failed.failure.detail})`, { to: 'debug' })
          setStatus('skills', `skills not rated (${failureText(ctx.backend.name, ranked.failed.failure)})`, show)
          return
        }
        const { suggest, hint } = pickSkills(ranked, catalog, policy)
        await recordDecision(
          { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
          (line) => $.ui.log(line, { to: 'debug' }),
          { feature: SWITCH, outcome: describePicks(suggest, hint), about: quote(e.text), reason: describeRanking(ranked, policy) },
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

/** The listing the feature withheld, as it goes beside a message once the feature is switched off. */
function restoredListing(text: string): string {
  return `Dispatch Pilot's skill suggestions are switched off, so here is the skill listing it had left out:\n\n${text}`
}

/** The start of a message for the debug log, secrets masked. */
function quote(text: string): string {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim()
  return JSON.stringify(flat.length > 40 ? `${flat.slice(0, 40)}...` : flat)
}

/**
 * Why: the skills stage one put forward with their shares, and none's; how
 * well each fits by stage two (or that nothing was put forward); the bar a
 * skill had to reach.
 */
function describeRanking(ranking: SkillRanking, policy: SkillPolicy): string {
  const shortlist = ranking.shortlist ?? []
  const first = [...shortlist.map((entry) => `${entry.name} ${entry.share.toFixed(2)}`), `none ${ranking.none.toFixed(2)}`].join(', ')
  const second =
    shortlist.length === 0
      ? `no skill rated ${SHORTLIST_FLOOR.toFixed(2)} or more`
      : `fits ${ranking.ranked.map((entry) => `${entry.name} ${entry.relevance.toFixed(2)}`).join(', ')}`
  return `first ${first}; ${second}; suggested from ${policy.minRelevance.toFixed(2)}, at most ${policy.max}`
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

/** When a stored profile was written; 0 when the value does not say. */
function writtenAt(value: unknown): number {
  const at = typeof value === 'object' && value !== null ? (value as { at?: unknown }).at : undefined
  return typeof at === 'number' && Number.isFinite(at) ? at : 0
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
