// Writes the skill profiles the skill suite offers the skills by
// (eval/datasets/skill-profiles.json): what the mod's profile writer
// (features/skills.ts) keeps in `$.store` for each skill of the catalog
// snapshot (skill-catalog.json), written from the same prompt
// (core/profiles.ts: PROFILE_SYSTEM, profilePrompt over the skill's SKILL.md)
// by the same cheap model (haiku), read with readProfile and filed under
// profileKey, entry for entry as the store holds them. The eval then offers
// each skill as the mod does once its profile is written, the same in every
// run (a profile is not written twice the same way).
//
//   node dispatch-pilot/eval/profiles.ts --estimate     how many are missing (one call each); nothing is asked
//   node dispatch-pilot/eval/profiles.ts                writes the missing ones; keeps those whose SKILL.md is unchanged
//
// Options: --concurrency 4, --only a,b (only these skills), --model haiku (the
// mod's skillsProfileModel, part of every key).
//
// `$.model.complete` exists only inside Claude Code, so each profile is one
// `claude -p` on the person's own login (their subscription), kept as bare as
// the CLI allows, so that it reads what the mod's completion reads: the
// profile prompt on stdin and PROFILE_SYSTEM as the whole system prompt, no
// tools, no thinking, no user or project settings (no language or output
// style of the person's), safe mode (no CLAUDE.md, plugins or hooks), no MCP,
// in an empty directory. Measured on 2026-10-04 with haiku: about 1.5k input
// and 220 output tokens and 3 s a profile, as the mod's own completions
// (README, 开发).

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { PROFILE_SYSTEM, PROFILE_VERSION, profileKey, profilePrompt, readProfile, type StoredProfile } from '../hooks/core/profiles.ts'
import { catalogSkills } from './lib/skill.ts'
import { DATASETS_DIR, nodeHost, shown } from './node.ts'

const { values } = parseArgs({
  options: {
    estimate: { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '4' },
    only: { type: 'string' },
    model: { type: 'string', default: 'haiku' },
  },
})

const CATALOG = join(DATASETS_DIR, 'skill-catalog.json')
const PROFILES = join(DATASETS_DIR, 'skill-profiles.json')
const SETTINGS = JSON.stringify({ enabledPlugins: { 'jev-pilot@jev-pilot': false }, alwaysThinkingEnabled: false })

const model = values.model
const catalogText = readFileSync(CATALOG, 'utf8')
const host = nodeHost(join(DATASETS_DIR, 'skill.jsonl'))
const skills = catalogSkills(JSON.parse(catalogText))
const only = values.only?.split(',')

// Each skill's SKILL.md (as the mod reads it) and the key its profile is filed under.
const keyed = await Promise.all(
  skills.map(async (skill) => {
    const markdown = skill.file === null ? null : await host.read(skill.file).catch(() => null)
    return { skill, markdown, key: profileKey(skill, markdown, model) }
  }),
)
type File = { about: Record<string, unknown>; profiles: Record<string, StoredProfile> }
const before: File = existsSync(PROFILES) ? JSON.parse(readFileSync(PROFILES, 'utf8')) : { about: {}, profiles: {} }
const missing = keyed.filter(({ key }) => before.profiles[key] === undefined)
const due = missing.filter(({ skill }) => only === undefined || only.includes(skill.name))
// Profiles of a SKILL.md since changed (or of a skill gone from the snapshot) are no longer read: dropped.
const stale = Object.keys(before.profiles).filter((key) => !keyed.some((entry) => entry.key === key))
console.log(
  `${skills.length} skills in the snapshot: ${skills.length - missing.length} have a profile, ${missing.length} have none; ${due.length} to write now with ${model} (one claude -p call each)${stale.length > 0 ? `; ${stale.length} stale to drop` : ''}`,
)
if (values.estimate || (due.length === 0 && stale.length === 0)) process.exit(0)

const dir = mkdtempSync(join(tmpdir(), 'dp-profiles-'))
const systemFile = join(dir, 'system.txt')
writeFileSync(systemFile, PROFILE_SYSTEM)

/** One completion through `claude -p`: the reply's text and the model that answered, or why there is none. */
function complete(prompt: string): Promise<{ text: string; models: string[] } | { failed: string }> {
  return new Promise((done) => {
    const args = ['-p', '--model', model, '--safe-mode', '--setting-sources', 'project', '--tools', '', '--system-prompt-file', systemFile, '--output-format', 'json', '--no-session-persistence', '--settings', SETTINGS, '--strict-mcp-config']
    const child = spawn('claude', args, { cwd: dir, env: { ...process.env, MAX_THINKING_TOKENS: '0' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('error', (error) => done({ failed: error.message }))
    child.on('close', (code) => {
      try {
        const result = JSON.parse(out) as { result?: string; is_error?: boolean; modelUsage?: Record<string, unknown> }
        if (result.is_error || typeof result.result !== 'string') return done({ failed: `claude -p answered an error (exit ${code}): ${String(result.result).slice(0, 200)}` })
        done({ text: result.result, models: Object.keys(result.modelUsage ?? {}) })
      } catch {
        done({ failed: `claude -p exited ${code}: ${(err || out).slice(0, 200)}` })
      }
    })
    child.stdin.end(prompt)
  })
}

const written: Record<string, StoredProfile> = {}
const answeredBy = new Set<string>()
const failed: string[] = []
let next = 0
const worker = async () => {
  while (next < due.length) {
    const { skill, markdown, key } = due[next++] as (typeof due)[number]
    const prompt = profilePrompt(skill, markdown)
    // A reply that is not a profile is asked once more (the mod skips it until its next session).
    for (let attempt = 1; attempt <= 2; attempt++) {
      const reply = await complete(prompt)
      if ('failed' in reply) {
        console.log(`  ${skill.name}: ${reply.failed}`)
        continue
      }
      const profile = readProfile(reply.text)
      if (profile === null) {
        console.log(`  ${skill.name}: the reply is not a profile: ${JSON.stringify(reply.text.slice(0, 80))}`)
        continue
      }
      for (const name of reply.models) answeredBy.add(name)
      written[key] = { name: skill.name, at: Date.now(), profile }
      console.log(`  ${skill.name}: written (${Object.keys(written).length}/${due.length})`)
      break
    }
    if (written[key] === undefined) failed.push(skill.name)
  }
}
await Promise.all(Array.from({ length: Math.max(1, Number(values.concurrency)) }, worker))
rmSync(dir, { recursive: true, force: true })

// In the snapshot's order, as the mod writes them (the skills the main agent can load first).
const profiles: Record<string, StoredProfile> = {}
for (const { key } of keyed) {
  const entry = written[key] ?? before.profiles[key]
  if (entry !== undefined) profiles[key] = entry
}
const about = {
  what: "Each skill's profile as the mod's profile writer keeps it in $.store (key: profileKey over the SKILL.md, the model alias and PROFILE_VERSION; value: { name, at, profile }), for the skills of skill-catalog.json. Written by eval/profiles.ts.",
  model,
  answered_by: [...new Set([...((before.about.answered_by as string[] | undefined) ?? []), ...answeredBy])].sort(),
  profile_version: PROFILE_VERSION,
  written: new Date().toISOString().slice(0, 10),
  how: `claude -p --model ${model} --safe-mode --setting-sources project --tools "" --system-prompt-file <PROFILE_SYSTEM> --output-format json --no-session-persistence --settings '${SETTINGS}' --strict-mcp-config, MAX_THINKING_TOKENS=0, the profile prompt on stdin, in an empty directory`,
  catalog_sha256: createHash('sha256').update(catalogText).digest('hex'),
}
writeFileSync(PROFILES, `${JSON.stringify({ about, profiles }, null, 2)}\n`)
console.log(`${shown(PROFILES)}: ${Object.keys(profiles).length} of ${skills.length} skills have a profile${failed.length > 0 ? `; none for ${failed.join(', ')}` : ''}`)
process.exit(failed.length > 0 ? 1 : 0)
