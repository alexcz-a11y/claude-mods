// Feature: skill profiles (#11). At session start a cheap model writes each
// skill a bilingual profile from its SKILL.md, in the background, once per
// version of the file (core/profiles.ts); the skills feature (features/
// skills.ts) offers a skill by its profile once one is written, by its
// description until then, and find_skill (#12) does the same.
//
// It works on the session's skills as the skills feature reads them at
// session start (`$.state`'s skillCatalog), so it registers outside that
// feature: its session.start goes on once the skills are read. Its switch,
// `skill-profiles`, is registered here; off, none is written, and the skills
// feature and find_skill offer every skill by its description. Nothing is
// written while the skills switch is off or no decision model is set up.
//
// What it does is told to the decision report (core/report.ts, `reportProfiles`;
// ADR 0004), which writes the debug log lines, keeps `$.state`'s `skillProfiles`
// up to date as the profiles are written and adds the session's entry to the
// decision log. This file shows people nothing itself.

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
import { reportProfiles, type ProfileEvent, type ProfilesIo, type ProfilesStop } from '../core/report.ts'
import type { Ctx } from '../core/setup.ts'
import type { CatalogSkill } from '../core/skills.ts'
import { defineSwitch, isOn } from '../core/switches.ts'

const CATALOG = { plugin: 'dispatch-pilot', key: 'skillCatalog' } as const
const BOARD = { plugin: 'dispatch-pilot', key: 'board' } as const
const DECISIONS = { plugin: 'dispatch-pilot', key: 'decisionLog' } as const
const PROFILES_STATE = { plugin: 'dispatch-pilot', key: 'skillProfiles' } as const

/** The skills feature's switch: profiles serve its suggestions. */
const SKILLS = 'skills'
/** The profiles' own switch: written at session start, and offered in the ranking (the skills feature and find_skill read it too). */
const PROFILES = 'skill-profiles'

/** Profiles are being written now (one batch at a time). */
let writing = false

/** How profiles are written: the model, how many at most per session start, the skills never offered (none written for them). */
type ProfileSettings = { model: string; perSession: number; skip: ReadonlySet<string> }

export function registerSkillProfiles(on: On, ctx: Ctx): void {
  defineSwitch({ name: PROFILES, info: '按 skill 画像给 skill 排序：便宜的模型每个 SKILL.md 版本写一次中英文画像（关掉就按描述排序）' })
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
    const offered = catalog.filter((skill) => !settings.skip.has(skill.name))
    if (!(await $.store.keys().then(() => true, () => false))) {
      await reportProfiles(profilesIo($), { event: 'unreadable', model: settings.model, offered: offered.length })
      return result
    }
    const due = offered.filter((skill) => !skill.profile).length
    await reportProfiles(profilesIo($), { event: 'start', model: settings.model, perSession: settings.perSession, offered: offered.length, due })
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
  const io = profilesIo($)
  const report = (event: ProfileEvent) => reportProfiles(io, event)
  const cell: Cell<{ skills: CatalogSkill[] } | null> = { get: () => $.state.get(CATALOG), set: (value, options) => $.state.set(CATALOG, value, options) }
  const due = catalog.filter((skill) => !skill.profile && typeof skill.profileKey === 'string' && !settings.skip.has(skill.name))
  let written = 0
  // The skills dealt with (written, kept by another session, or failed): what is left of `due` is for a later session start.
  let tried = 0
  let stopped = false
  const stop = async (cause: ProfilesStop) => {
    stopped = true
    await report({ event: 'stop', cause, left: due.length - tried })
  }
  try {
    for (const skill of due) {
      if (!isOn(SKILLS) || !isOn(PROFILES) || ctx.backend.configured === false) {
        await stop({ reason: 'off' })
        break
      }
      if (written >= settings.perSession) {
        await report({ event: 'quota', perSession: settings.perSession, left: due.length - written })
        break
      }
      const markdown = skill.file === null ? null : await $.fs.read(skill.file).catch(() => null)
      const key = profileKey(skill, markdown, settings.model)
      // Another session may have written it meanwhile.
      const kept = storedProfile(await $.store.get(key).catch(() => undefined))
      if (kept !== null) {
        await update(cell, (value) => (value ? { skills: withProfile(value.skills, key, kept) } : null))
        tried++
        await report({ event: 'found' })
        continue
      }
      const startedAt = await $.clock.now()
      let reply: ModelCompleteResult
      try {
        reply = await $.model.complete({ model: settings.model, system: PROFILE_SYSTEM, prompt: profilePrompt(skill, markdown), maxTokens: PROFILE_MAX_TOKENS, timeoutMs: PROFILE_TIMEOUT_MS })
      } catch (error) {
        await stop({ reason: 'model-refused', model: settings.model, detail: errorText(error) })
        break
      }
      const ms = (await $.clock.now()) - startedAt
      if (!reply.isAnswered) {
        const why = reply.reason === 'api-error' ? `an API error, HTTP ${reply.status ?? 'none'} ${reply.error}` : reply.reason
        if (reply.reason === 'api-error') {
          await stop({ reason: 'api-error', skill: skill.name, why, ms })
          break
        }
        tried++
        await report({ event: 'failed', skill: skill.name, why, ms })
        continue
      }
      const profile = readProfile(reply.text)
      if (profile === null) {
        tried++
        await report({ event: 'unfit', skill: skill.name, ms, text: reply.text })
        continue
      }
      const entry: StoredProfile = { name: skill.name, at: await $.clock.now(), profile }
      try {
        await $.store.set(key, entry)
      } catch (error) {
        await stop({ reason: 'store-write', skill: skill.name, detail: errorText(error) })
        break
      }
      await update(cell, (value) => (value ? { skills: withProfile(value.skills, key, profile) } : null))
      written++
      tried++
      await report({ event: 'written', skill: skill.name, model: settings.model, ms, input: reply.usage.input_tokens, output: reply.usage.output_tokens })
    }
    await dropOldProfiles($, catalog)
    if (!stopped) await report({ event: 'finish', left: due.length - tried })
  } catch (error) {
    // The session went away under it (its `$` refused), or a bug: either way the session is not held up.
    await stop({ reason: 'error', detail: errorText(error) })
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
    await reportProfiles(profilesIo($), { event: 'tidied', dropped: drop.length, total: keys.length, kb: Math.round(bytes / 1024) })
  } catch (error) {
    await reportProfiles(profilesIo($), { event: 'tidy-failed', detail: errorText(error) })
  }
}

/** What the decision report needs of the session, as closures over `$` (`$` cannot cross an import). */
function profilesIo($: EngineInterface): ProfilesIo {
  return {
    board: { get: () => $.state.get(BOARD), set: (value, options) => $.state.set(BOARD, value, options) },
    decisions: { get: () => $.state.get(DECISIONS), set: (value, options) => $.state.set(DECISIONS, value, options) },
    debug: (line) => $.ui.log(line, { to: 'debug' }),
    profiles: { get: () => $.state.get(PROFILES_STATE), set: (value, options) => $.state.set(PROFILES_STATE, value, options) },
  }
}

/** When a stored profile was written; 0 when the value does not say. */
function writtenAt(value: unknown): number {
  const at = typeof value === 'object' && value !== null ? (value as { at?: unknown }).at : undefined
  return typeof at === 'number' && Number.isFinite(at) ? at : 0
}
