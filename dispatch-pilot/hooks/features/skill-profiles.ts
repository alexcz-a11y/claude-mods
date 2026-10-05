// Feature: skill profiles (#11). At session start a cheap model writes each
// skill a bilingual profile from its SKILL.md, in the background, once per
// version of the file (core/profiles.ts); the skills feature (features/
// skills.ts) offers a skill by its profile once one is written, by its
// description until then, and find_skill (#12) does the same.
//
// It works on the session's skills as the skills feature reads them at
// session start (`$.state`'s skillCatalog), so it registers outside that
// feature: its session.start goes on once the skills are read. The profiles'
// switch, `skill-profiles`, is defined by the skills feature (which stops
// offering profiles while it is off); off, none is written either. Nothing is
// written while the skills switch is off or no decision model is set up.

import type { EngineInterface, ModelCompleteResult, On } from 'claude-code'
import { errorText } from '../decision/backend.ts'
import { update, type Cell } from '../core/plans.ts'
import {
  evictions,
  PROFILE_MAX_TOKENS,
  PROFILE_PREFIX,
  PROFILE_SYSTEM,
  PROFILE_TIMEOUT_MS,
  profileKey,
  profilePrompt,
  readProfile,
  storedBytes,
  storedProfile,
  withProfile,
  type StoredProfile,
} from '../core/profiles.ts'
import type { Ctx } from '../core/setup.ts'
import type { CatalogSkill } from '../core/skills.ts'
import { isOn } from '../core/switches.ts'

const CATALOG = { plugin: 'dispatch-pilot', key: 'skillCatalog' } as const

/** The skills feature's switch: profiles serve its suggestions. */
const SKILLS = 'skills'
/** The profiles' own switch (defined by the skills feature): written at session start, and offered in the ranking. */
const PROFILES = 'skill-profiles'

/** Profiles are being written now (one batch at a time). */
let writing = false

/** How profiles are written: the model, how many at most per session start, the skills never offered (none written for them). */
type ProfileSettings = { model: string; perSession: number; skip: ReadonlySet<string> }

export function registerSkillProfiles(on: On, ctx: Ctx): void {
  const settings: ProfileSettings = { model: ctx.config.skills.profileModel, perSession: ctx.config.skills.profilesPerSession, skip: new Set(ctx.config.skills.neverSuggested) }

  // Once the skills feature (inside this one) has read the session's skills: a
  // line on their profiles, then the ones they lack are written in the background.
  on('session.start', { cwd: /(?:)/ }, async ($, e, next) => {
    const result = await next(e)
    if (!isOn(SKILLS) || !isOn(PROFILES) || ctx.backend.configured === false) return result
    const { value } = await $.state.get(CATALOG)
    if (!value) return result
    const catalog = value.skills
    // A store that cannot be read keeps nothing: every session would write every profile again.
    if (!(await $.store.keys().then(() => true, () => false))) {
      $.ui.log('skill profiles: the store cannot be read, so no profile is kept or written; skills are rated by their descriptions', { to: 'debug' })
      return result
    }
    const offered = catalog.filter((skill) => !settings.skip.has(skill.name))
    const due = offered.filter((skill) => !skill.profile).length
    $.ui.log(`skill profiles: ${offered.length - due} kept, ${due} to write with ${settings.model} (at most ${settings.perSession} this session)`, { to: 'debug' })
    // In the background: the session goes on, and each profile is used as soon as it is written.
    if (due > 0 && settings.perSession > 0) void writeProfiles($, ctx, catalog, settings).catch(() => undefined)
    return result
  })
}

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
      if (!isOn(SKILLS) || !isOn(PROFILES) || ctx.backend.configured === false) break
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

/** Past MAX_PROFILES profiles in the store, or MAX_PROFILE_BYTES of them, the oldest written that this session does not use are deleted. */
async function dropOldProfiles($: EngineInterface, catalog: readonly CatalogSkill[]): Promise<void> {
  try {
    const keys = (await $.store.keys()).filter((key) => key.startsWith(PROFILE_PREFIX))
    const entries = await Promise.all(
      keys.map(async (key) => {
        const value = await $.store.get(key).catch(() => null)
        return { key, at: writtenAt(value), bytes: storedBytes(key, value) }
      }),
    )
    const drop = evictions(entries, new Set(catalog.flatMap((skill) => (typeof skill.profileKey === 'string' ? [skill.profileKey] : []))))
    if (drop.length === 0) return
    for (const key of drop) await $.store.delete(key)
    const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
    $.ui.log(`skill profiles: dropped the ${drop.length} oldest of ${keys.length} kept (${Math.round(bytes / 1024)} KB)`, { to: 'debug' })
  } catch (error) {
    $.ui.log(`skill profiles: could not tidy the store (${errorText(error)})`, { to: 'debug' })
  }
}

/** When a stored profile was written; 0 when the value does not say. */
function writtenAt(value: unknown): number {
  const at = typeof value === 'object' && value !== null ? (value as { at?: unknown }).at : undefined
  return typeof at === 'number' && Number.isFinite(at) ? at : 0
}
