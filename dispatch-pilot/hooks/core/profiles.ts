// Skill profiles (#11): what each skill is for, in English and in Chinese,
// written once per version of its SKILL.md by a cheap model through
// `$.model.complete` and kept in `$.store`, so that a request in Chinese can
// match a skill its author described in English. The ranking offers a skill by
// its profile when one is written, else by its description
// (decision/skills.ts).
//
// Pure: no `$`. The skills feature runs the completions and reads and writes
// the store; this module writes the prompt, reads the reply, names each
// profile's store key (from the SKILL.md, so an edited file gets a new one)
// and keeps the profiles within their share of the store's 4 MiB.

import type { PluginOptions } from 'claude-code'
import { clipToTokens } from '../decision/context.ts'
import { redactSecrets } from '../decision/redact.ts'
import type { SkillProfile } from '../decision/skills.ts'
import { stringOf } from './setup.ts'
import { loadCatalog, type CatalogIo, type CatalogSkill } from './skills.ts'

/** Bumped when the prompt changes: every profile is written again. */
export const PROFILE_VERSION = 1
/** A profile's store key is this prefix and a hash of what it was written from. */
export const PROFILE_PREFIX = 'profile.'
/** The cheap model, unless the person names another (`skillsProfileModel`). */
export const DEFAULT_PROFILE_MODEL = 'haiku'
/** How much of a SKILL.md the model reads: its start, where a skill says what it is for. */
export const SOURCE_TOKENS = 3000
/** The reply's cap, and how long one completion may take. */
export const PROFILE_MAX_TOKENS = 700
export const PROFILE_TIMEOUT_MS = 60_000
/** A field longer than this (characters) is cut: English, Chinese. */
export const EN_CHARS = 200
export const ZH_CHARS = 60
/**
 * The store keeps at most this many profiles; past it the oldest written that
 * the session does not use go, down to EVICT_TO. At most about 1.3 KB each
 * (the field caps), so they take well under 1 MiB of the store's 4 MiB.
 */
export const MAX_PROFILES = 500
export const EVICT_TO = 400

/** The model that writes profiles, as the person set it (`skillsProfileModel`); it is part of every profile's key. */
export function profileModel(ctx: { options: PluginOptions }): string {
  return stringOf(ctx.options.skillsProfileModel, DEFAULT_PROFILE_MODEL).trim() || DEFAULT_PROFILE_MODEL
}

export const PROFILE_SYSTEM =
  'You write short routing profiles of Claude Code skills. A router that reads requests written in Chinese or English uses them to decide whether a skill fits a request. Reply with one JSON object and nothing else.'

/** What the model is asked for one skill: its name, its description and the start of its SKILL.md (null when it has none to read). */
export function profilePrompt(skill: { name: string; description: string }, markdown: string | null): string {
  const source =
    markdown === null
      ? 'SKILL.md: not available; work from the name and the description.'
      : `SKILL.md (it may be cut short):\n<<<\n${clipToTokens(markdown.trim(), SOURCE_TOKENS)}\n>>>`
  return [
    `Skill name: ${skill.name}`,
    `Description: ${skill.description.trim() || '(none)'}`,
    source,
    '',
    "Write this skill's profile as JSON with exactly these fields:",
    '{"en": {"what": "...", "use_when": "...", "not_for": "..."}, "zh": {"what": "...", "use_when": "...", "not_for": "..."}}',
    '- en.what: what the skill does, in one sentence of at most 20 words.',
    '- en.use_when: the requests or situations it is for, in at most 25 words.',
    '- en.not_for: nearby requests it does not cover, in at most 20 words.',
    '- zh.what, zh.use_when, zh.not_for: the same three in natural Chinese (not a word-for-word translation), at most 40 characters each.',
    'Say only what the skill itself says it does; do not invent features. Plain text in the strings, no markdown.',
  ].join('\n')
}

/** The profile in the model's reply (the JSON object in it); null when there is none or a field is missing. Every field is tidied and cut to its cap. */
export function readProfile(reply: string): SkillProfile | null {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return profileFrom(JSON.parse(reply.slice(start, end + 1)))
  } catch {
    return null
  }
}

/** A profile as the store keeps it: whose it is (for the log), when it was written, and the profile. */
export type StoredProfile = { name: string; at: number; profile: SkillProfile }

/** The profile a store value holds; null when it holds none (missing, or not a profile). */
export function storedProfile(value: unknown): SkillProfile | null {
  return isRecord(value) ? profileFrom(value.profile) : null
}

/**
 * The store key of a skill's profile: a hash of what it is written from (its
 * SKILL.md, or its description when it has none), its name, the model and
 * PROFILE_VERSION. A changed file, another model or a new prompt gets a new
 * key, so its profile is written again. Synchronous (two 53-bit hashes, not
 * `crypto.subtle`), so it is computed in line with the code around it.
 */
export function profileKey(skill: { name: string; description: string }, markdown: string | null, model: string): string {
  const source = ['dispatch-pilot skill profile', String(PROFILE_VERSION), model, skill.name, markdown ?? `description: ${skill.description.trim()}`].join('\n')
  return `${PROFILE_PREFIX}${hash53(source, 1)}${hash53(source, 2)}`
}

/** cyrb53 (bryc, public domain): a 53-bit hash of `text` as 14 hex digits; another `seed` gives an independent one. */
function hash53(text: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/** What looking up the profiles needs of the session, as closures over `$`. */
export type ProfileIo = {
  /** `$.fs.read(path)`. */
  read: (path: string) => Promise<string>
  /** `$.store.get(key)`: rejects when the store cannot be read. */
  get: (key: string) => Promise<unknown>
}

/**
 * The catalog with each skill's profile key and, when the store holds it, its
 * profile. `store` is false when the store cannot be read: then no profile is
 * found, and none should be written (it could not be kept).
 */
export async function lookUpProfiles(skills: readonly CatalogSkill[], io: ProfileIo, model: string): Promise<{ skills: CatalogSkill[]; store: boolean }> {
  let store = true
  const found = await Promise.all(
    skills.map(async (skill): Promise<CatalogSkill> => {
      const markdown = skill.file === null ? null : await io.read(skill.file).catch(() => null)
      const key = profileKey(skill, markdown, model)
      const value = await io.get(key).catch(() => {
        store = false
        return undefined
      })
      return { ...skill, profileKey: key, profile: storedProfile(value) }
    }),
  )
  return { skills: store ? found : found.map((skill) => ({ ...skill, profile: null })), store }
}

/**
 * The session's skills (`loadCatalog`), each with its profile when the store
 * holds one (`lookUpProfiles`): what both the skills feature and find_skill
 * keep as the session's catalog. Null when the skills cannot be read.
 */
export async function readSessionSkills(io: CatalogIo & Pick<ProfileIo, 'get'>, model: string): Promise<{ skills: CatalogSkill[]; store: boolean } | null> {
  const skills = await loadCatalog(io).catch(() => null)
  return skills === null ? null : lookUpProfiles(skills, io, model)
}

/** The catalog with `profile` given to the skills whose profile key is `key`. */
export function withProfile(skills: readonly CatalogSkill[], key: string, profile: SkillProfile): CatalogSkill[] {
  return skills.map((skill) => (skill.profileKey === key ? { ...skill, profile } : skill))
}

/**
 * The profiles to drop from the store: none while it holds at most
 * MAX_PROFILES; past it, the oldest written among those not in `keep` (the
 * session's), until EVICT_TO remain.
 */
export function evictions(entries: readonly { key: string; at: number }[], keep: ReadonlySet<string>): string[] {
  if (entries.length <= MAX_PROFILES) return []
  const spare = entries.filter((entry) => !keep.has(entry.key)).sort((a, b) => a.at - b.at)
  return spare.slice(0, entries.length - EVICT_TO).map((entry) => entry.key)
}

function profileFrom(value: unknown): SkillProfile | null {
  if (!isRecord(value) || !isRecord(value.en) || !isRecord(value.zh)) return null
  const en = side(value.en, EN_CHARS)
  const zh = side(value.zh, ZH_CHARS)
  return en === null || zh === null ? null : { en, zh }
}

/** One language's fields: `what` and `use_when` must be there; `not_for` may be empty. */
function side(value: Record<string, unknown>, max: number): SkillProfile['en'] | null {
  const read = (field: string) => {
    const text = value[field]
    return typeof text === 'string' ? tidy(text, max) : null
  }
  const what = read('what')
  const useWhen = read('use_when')
  const notFor = read('not_for') ?? ''
  return what && useWhen ? { what, use_when: useWhen, not_for: notFor } : null
}

/** A field as the decision model reads it: secrets masked, whitespace collapsed, cut to `max` characters. */
function tidy(text: string, max: number): string {
  const chars = [...redactSecrets(text).replace(/\s+/g, ' ').trim()]
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.join('')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
