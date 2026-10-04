// The skill catalog: which skills the session has, who may start each one,
// and what each is for. The skills feature (#10) suggests from it, and so
// will the bilingual portraits (#11) and the find_skill tool (#12). Also the
// engine's skill listing, read and trimmed.
//
// Pure: no `$`. Whatever reads the session (commands, settings, disk) comes
// in as closures the hook that owns `$` builds (README, 开发).

import type { SkillOption } from '../decision/skills.ts'

/** One skill of the session, as the decision model is offered it. */
export type CatalogSkill = SkillOption & {
  /** Where it comes from, by the engine's word (`userSettings`, `plugin`, `built-in`, `syncedSkills`, ...). */
  source: string
}

/** A command as `$.command.list()` gives it (the part read here). */
export type CommandLike = { name: string; description: string; source: string; plugin?: string }
/** A skill of the main agent's listing as the context counts it (`skillFrontmatter`; the part read here). */
export type ListedLike = { name: string; source: string; pluginName?: string }

/** The settings sources, lowest precedence first (as `$.settings.read({ source })` names them). */
export const SETTINGS_SOURCES = ['user', 'project', 'local', 'flag', 'policy'] as const
export type SettingsSourceName = (typeof SETTINGS_SOURCES)[number]

/** What the catalog reads of the session, as closures over `$`. */
export type CatalogIo = {
  /** `$.command.list()`: every command and skill the person can run, with its description. */
  commands: () => Promise<readonly CommandLike[]>
  /**
   * The skills the engine lists for the main agent, those the model may load
   * (`$.session.usage({ breakdown: 'summary' })`'s
   * `context.breakdown.skills.skillFrontmatter`; empty when it lists none).
   */
  listed: () => Promise<readonly ListedLike[]>
  /** One settings source's `skillOverrides` (`$.settings.read({ source })`), as the file holds it. */
  overrides: (source: SettingsSourceName) => Promise<unknown>
  /** `$.env.get('HOME')`. */
  home: () => Promise<string | undefined>
  /** `$.session.cwd()`. */
  cwd: () => Promise<string>
  /** `$.fs.read(path)`: rejects when the file is missing. */
  read: (path: string) => Promise<string>
}

/**
 * Claude.ai's synced skills: the context counts them by their bare name
 * (`computer-use`), the listing and the Skill tool name them with this prefix.
 */
const SYNCED_PREFIX = 'anthropic-skills:'

/** The name the Skill tool takes for a listed skill. */
function toolName(skill: ListedLike): string {
  return skill.source === 'syncedSkills' && !skill.name.includes(':') ? `${SYNCED_PREFIX}${skill.name}` : skill.name
}

/**
 * The session's skills: first those the engine lists for the main agent (the
 * model may load them), in its order; then those only the person can start,
 * the commands the engine keeps out of the listing whose SKILL.md (or command
 * file) sets `disable-model-invocation: true`, unless settings switch them
 * off. Each is described as `$.command.list()` describes it. Rejects when the
 * commands or the listing cannot be read; a settings source or a file that
 * cannot be read only leaves its part out.
 */
export async function loadCatalog(io: CatalogIo): Promise<CatalogSkill[]> {
  const [commands, listed] = await Promise.all([io.commands(), io.listed()])
  const descriptions = new Map<string, string>()
  for (const command of commands) if (!descriptions.has(command.name)) descriptions.set(command.name, command.description)
  const skills: CatalogSkill[] = []
  const seen = new Set<string>()
  for (const entry of listed) {
    const name = toolName(entry)
    if (seen.has(name)) continue
    seen.add(name)
    const description = descriptions.get(entry.name) ?? descriptions.get(name) ?? ''
    skills.push({ name, description: description.trim(), by: 'model', source: entry.source })
  }

  const listedAs = new Set(listed.map((entry) => entry.name))
  const overrides = await mergedOverrides(io)
  const where = { home: await io.home().catch(() => undefined), cwd: await io.cwd().catch(() => undefined) }
  let installed: Promise<string> | undefined
  const installedPlugins = () => (installed ??= where.home ? io.read(`${where.home}/.claude/plugins/installed_plugins.json`).catch(() => '') : Promise.resolve(''))
  for (const command of commands) {
    if (command.source !== 'user' && command.source !== 'plugin') continue
    if (listedAs.has(command.name) || seen.has(command.name) || isOff(overrides, command.name)) continue
    const files = command.source === 'plugin' ? pluginFiles(command, await installedPlugins()) : ownFiles(command.name, where)
    if (!(await anyReservesForPerson(io, files))) continue
    seen.add(command.name)
    skills.push({ name: command.name, description: command.description.trim(), by: 'person', source: command.source })
  }
  return skills
}

/** `skillOverrides` over every settings source, a name taking the value of the highest source that sets it. */
async function mergedOverrides(io: CatalogIo): Promise<Map<string, unknown>> {
  const merged = new Map<string, unknown>()
  for (const source of SETTINGS_SOURCES) {
    const overrides = await io.overrides(source).catch(() => undefined)
    if (typeof overrides !== 'object' || overrides === null) continue
    for (const [name, value] of Object.entries(overrides)) merged.set(name, value)
  }
  return merged
}

/** Whether settings switch a skill off (by its own name, or a synced one's prefixed name). */
function isOff(overrides: ReadonlyMap<string, unknown>, name: string): boolean {
  return overrides.get(name) === 'off' || overrides.get(`${SYNCED_PREFIX}${name}`) === 'off'
}

/** Whether a name may go into a path: no separator, no `..`. */
function safeName(name: string): boolean {
  return name !== '' && !name.includes('/') && !name.includes('\\') && !name.split(':').includes('..')
}

/** Where a project or user skill (or command) of this name lives, the project's first. */
function ownFiles(name: string, where: { home: string | undefined; cwd: string | undefined }): string[] {
  if (!safeName(name)) return []
  const roots = [where.cwd, where.home].filter((root): root is string => typeof root === 'string' && root !== '')
  return roots.flatMap((root) => [`${root}/.claude/skills/${name}/SKILL.md`, `${root}/.claude/commands/${name.replace(/:/g, '/')}.md`])
}

/** Where a plugin's skill (or command) lives, under each install path `installed_plugins.json` records for the plugin. */
function pluginFiles(command: CommandLike, installedJson: string): string[] {
  const plugin = command.plugin ?? command.name.split(':')[0] ?? ''
  const short = command.name.startsWith(`${plugin}:`) ? command.name.slice(plugin.length + 1) : command.name
  if (!safeName(plugin) || !safeName(short)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(installedJson)
  } catch {
    return []
  }
  const plugins = typeof parsed === 'object' && parsed !== null ? (parsed as { plugins?: unknown }).plugins : undefined
  if (typeof plugins !== 'object' || plugins === null) return []
  const files: string[] = []
  for (const [key, installs] of Object.entries(plugins)) {
    if (key !== plugin && !key.startsWith(`${plugin}@`)) continue
    for (const install of Array.isArray(installs) ? installs : []) {
      const path = (install as { installPath?: unknown } | null)?.installPath
      if (typeof path !== 'string') continue
      const root = path.replace(/\/+$/, '')
      files.push(`${root}/skills/${short}/SKILL.md`, `${root}/commands/${short.replace(/:/g, '/')}.md`)
    }
  }
  return files
}

/** Whether the first of `files` that exists reserves its skill for the person. */
async function anyReservesForPerson(io: CatalogIo, files: readonly string[]): Promise<boolean> {
  for (const file of files) {
    const markdown = await io.read(file).catch(() => null)
    if (markdown !== null) return reservedForPerson(markdown)
  }
  return false
}

/** Whether a SKILL.md's frontmatter sets `disable-model-invocation: true` (the model may not load it; the person runs `/name`). */
export function reservedForPerson(markdown: string): boolean {
  const frontmatter = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (!frontmatter) return false
  return /^disable-model-invocation:\s*(?:true|yes|on|"true"|'true')\s*(?:#.*)?$/im.test(frontmatter[1] as string)
}

/** One entry of the engine's skill listing: `- name: description`, a description possibly running on over more lines. */
type ListingEntry = { name: string; lines: string[] }

/** The listing's lines before its first entry (the header), and its entries in order. */
function readListing(text: string): { head: string[]; entries: ListingEntry[] } {
  const head: string[] = []
  const entries: ListingEntry[] = []
  for (const line of text.split('\n')) {
    // A name has no spaces and may itself hold `:` (`cloudflare:wrangler`): it runs to the first `: `.
    const entry = /^- (\S+?)(?::\s.*|:)?$/.exec(line)
    if (entry) entries.push({ name: entry[1] as string, lines: [line] })
    else if (entries.length > 0) (entries.at(-1) as ListingEntry).lines.push(line)
    else head.push(line)
  }
  return { head, entries }
}

/** The names the engine's skill listing gives, in order. */
export function listingNames(text: string): string[] {
  return readListing(text).entries.map((entry) => entry.name)
}

/**
 * The listing with only the skills in `keep` left in it, each as the engine
 * wrote it, under the engine's header; null when none of them is in it.
 */
export function trimListing(text: string, keep: ReadonlySet<string>): string | null {
  const { head, entries } = readListing(text)
  const kept = entries.filter((entry) => keep.has(entry.name))
  if (kept.length === 0) return null
  return [...head, ...kept.flatMap((entry) => entry.lines)].join('\n')
}
