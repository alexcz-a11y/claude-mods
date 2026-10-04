// The skill suite: the skills suggested beside a message the person sends
// (#10, ranked in two stages since #11). An item is the message and the
// conversation before it; the session's skills are the person's own, as a
// snapshot of their machine records them (skill-catalog.json beside the
// dataset), each offered by the profile the mod would have written for it
// (skill-profiles.json, the store's entries) and re-read in stage two from its
// SKILL.md on disk. The requests are built by the ranking the mod uses
// (hooks/decision/skills.ts: skillsRequest, then modRanker's second stage),
// with the mod's settings, so the eval measures what the mod sends.
//
// Variants: `profiles` (the mod once its profiles are written) and
// `descriptions` (before they are, or with `skill-profiles` off).
//
// Pure: no Node API. What it reads besides its items comes in as SkillSources.

import { lookUpProfiles, profileModel } from '../../hooks/core/profiles.ts'
import { namesOf, numberIn } from '../../hooks/core/setup.ts'
import { rankingSettings, type CatalogSkill } from '../../hooks/core/skills.ts'
import { DEFAULT_ASK } from '../../hooks/decision/effort.ts'
import {
  MAX_SHORTLIST,
  modRanker,
  pickSkills,
  readSkills,
  rerankPart,
  skillOpening,
  skillsRequest,
  type SkillPolicy,
  type SkillRanker,
  type SkillRankerIo,
  type SkillRanking,
} from '../../hooks/decision/skills.ts'
import { answersFor, mergeParts, type DecisionRequest, type Part } from '../../hooks/decision/system-one.ts'
import type { Language, SkillItem, SubmitAsked } from './datasets.ts'
import { contextMessages } from './effort-submit.ts'
import type { VariantSummary } from './metrics.ts'
import type { Row } from './runner.ts'
import { settingsFrom, type Grade, type Settings, type Suite } from './suite.ts'

/** What the suite decides for a message: the skills the main agent is shown, and those only the person can start, hinted on the status line. */
export type SkillAnswer = { suggest: string[]; hint: string[] }

/** What the suite reads besides its items. */
export type SkillSources = {
  /** skill-catalog.json as parsed: the snapshot of the person's skills. */
  catalog: unknown
  /** skill-profiles.json as parsed (`{ profiles: { <store key>: { name, at, profile } } }`); without it every skill is offered by its description. */
  profiles: unknown
  /** A SKILL.md by the path the snapshot records (`~` the home directory); rejects when it cannot be read. */
  read: (path: string) => Promise<string>
}

/** The variants by name; the first is how the mod asks once its profiles are written. */
export const SKILL_VARIANTS = ['profiles', 'descriptions'] as const

/**
 * The session's skills in the snapshot as the mod's catalog holds them
 * (core/skills.ts loadCatalog): those the main agent may load
 * (`status: candidate`) in the snapshot's order, which is the engine's
 * listing's, then those only the person can start (`user-only-frontmatter`),
 * in the order the commands list them; skills switched off are not offered.
 * Each with its description trimmed and its SKILL.md (null for a built-in
 * skill).
 */
export function catalogSkills(catalog: unknown): CatalogSkill[] {
  if (!isRecord(catalog) || !Array.isArray(catalog.skills)) throw new Error('not a skill catalog (skill-catalog.json): no skills')
  const skills = catalog.skills.filter(isRecord)
  const of = (status: string, by: CatalogSkill['by']): CatalogSkill[] =>
    skills
      .filter((skill) => skill.status === status && typeof skill.name === 'string')
      .map((skill) => ({
        name: skill.name as string,
        description: typeof skill.description === 'string' ? skill.description.trim() : '',
        by,
        source: typeof skill.engine_source === 'string' ? skill.engine_source : typeof skill.source === 'string' ? skill.source : '',
        file: typeof skill.path === 'string' && skill.path !== '' ? skill.path : null,
      }))
  return [...of('candidate', 'model'), ...of('user-only-frontmatter', 'person')]
}

/** The profiles a profiles file holds, by store key. */
function storedEntries(file: unknown): ReadonlyMap<string, unknown> {
  const entries = isRecord(file) && isRecord(file.profiles) ? file.profiles : {}
  return new Map(Object.entries(entries))
}

/**
 * The skill suite over the person's skills (`sources`): each SKILL.md read
 * once, as the mod reads them for their profile keys and the second stage.
 */
export async function skillSuite(sources: SkillSources): Promise<Suite<SkillItem, SkillAnswer>> {
  const skills = catalogSkills(sources.catalog)
  const texts = new Map<string, string | null>()
  for (const skill of skills) if (skill.file !== null && !texts.has(skill.file)) texts.set(skill.file, await sources.read(skill.file).catch(() => null))
  const markdown = (file: string | null): string | null => (file === null ? null : (texts.get(file) ?? null))
  const stored = storedEntries(sources.profiles)
  const profiled = new Map<string, Promise<CatalogSkill[]>>()

  /** The skills offered under `variant` and the person's options, as the mod offers them for a message. */
  const offered = async (variant: string, settings: Settings): Promise<CatalogSkill[]> => {
    const model = profileModel({ options: settings.options })
    let found = profiled.get(model)
    if (found === undefined) {
      const io = {
        read: async (path: string) => {
          const text = markdown(path)
          if (text === null) throw new Error(`cannot read ${path}`)
          return text
        },
        get: async (key: string) => stored.get(key),
      }
      found = lookUpProfiles(skills, io, model).then((looked) => looked.skills)
      profiled.set(model, found)
    }
    const never = new Set(namesOf(settings.options.skillsNeverSuggested))
    const kept = (await found).filter((skill) => !never.has(skill.name))
    if (variant === 'descriptions') return kept.map((skill) => ({ ...skill, profile: null }))
    if (variant === 'profiles') return kept
    throw new RangeError(`no variant "${variant}" (${SKILL_VARIANTS.join(', ')})`)
  }

  /** The opening of a skill's SKILL.md as stage two reads it (null without one), as the mod reads it for its catalog's skill of that name. */
  const openingOf = (options: readonly CatalogSkill[], name: string): string | null => {
    const text = markdown(options.find((skill) => skill.name === name)?.file ?? null)
    return text === null ? null : skillOpening(text)
  }
  /** The mod's ranker under the person's settings; `ask` sends stage two. */
  const rankerFor = (options: readonly CatalogSkill[], settings: Settings, ask: SkillRankerIo['ask']): SkillRanker =>
    modRanker({ ask, opening: async (option) => openingOf(options, option.name) }, rankingSettings({ options: settings.options, config: settings, ask: DEFAULT_ASK }))
  /** Stage one's request, as the mod sends it when the person sends this message after this conversation. */
  const firstRequest = (asked: SubmitAsked, options: readonly CatalogSkill[], settings: Settings, ranker: SkillRanker) =>
    skillsRequest({ message: asked.message, recent_context: contextMessages(asked.recent_context) }, options, { limits: settings.context, ranker })
  /** Stage two's request for these candidates, about stage one's state. */
  const secondRequest = (state: DecisionRequest['state'], options: readonly CatalogSkill[], candidates: readonly CatalogSkill[]) =>
    mergeParts(state, [rerankPart(candidates.map((option) => ({ option, opening: openingOf(options, option.name) })), { language: DEFAULT_ASK.language }) as Part])
  const unsent: SkillRankerIo['ask'] = async () => ({ ok: false, failure: { kind: 'config', detail: 'not sent' } })

  // What each variant asks under the manifest's defaults, recorded with the
  // results: stage one in full; stage two for the first two skills.
  const defaults = settingsFrom({})
  const asks: Record<string, unknown> = {}
  for (const variant of SKILL_VARIANTS) {
    const options = await offered(variant, defaults)
    const { request } = firstRequest({ message: '', recent_context: [] }, options, defaults, rankerFor(options, defaults, unsent))
    asks[variant] = { first: request.questions, second: secondRequest(request.state, options, options.slice(0, 2)).questions }
  }

  // What was read, against the snapshot the dataset was written for: each
  // SKILL.md beside the sha256 the snapshot recorded, and the profiles found.
  const recorded = snapshotHashes(sources.catalog)
  const filed = skills.filter((skill) => skill.file !== null)
  const unreadable = filed.filter((skill) => markdown(skill.file) === null).map((skill) => skill.name)
  const changed: string[] = []
  for (const skill of filed) {
    const text = markdown(skill.file)
    const want = recorded.get(skill.name)
    if (text !== null && want !== undefined && (await sha256(text)) !== want) changed.push(skill.name)
  }
  const without = (await offered('profiles', defaults)).filter((skill) => !skill.profile).map((skill) => skill.name)
  const skillsCount = (names: readonly string[]) => `${names.length} ${names.length === 1 ? 'skill' : 'skills'}`
  const about = {
    skills: { offered: skills.length, model: skills.filter((skill) => skill.by === 'model').length, person: skills.filter((skill) => skill.by === 'person').length },
    profiles: { model: profileModel(defaults), with: skills.length - without.length, without },
    files: { read: filed.length - unreadable.length, unreadable, changed },
    warnings: [
      ...(changed.length > 0 ? [`SKILL.md differs from the snapshot for ${skillsCount(changed)}: ${changed.join(', ')}`] : []),
      ...(unreadable.length > 0 ? [`SKILL.md cannot be read for ${skillsCount(unreadable)}: ${unreadable.join(', ')}`] : []),
      ...(without.length > 0 ? [`no profile in skill-profiles.json for ${skillsCount(without)} (the profiles variant offers them by their descriptions): ${without.join(', ')}`] : []),
    ],
  }

  return {
    name: 'skill',
    variants: SKILL_VARIANTS,
    async decide(item, language, variant, ask, settings) {
      const options = await offered(variant, settings)
      // How long each stage's answered request took, in order.
      const stages: number[] = []
      const ranker = rankerFor(options, settings, async (request) => {
        const sent = await ask(request)
        stages.push(sent.ms)
        return sent.asked
      })
      const { request, part } = firstRequest(item[language], options, settings, ranker)
      if (part === null) return { ok: false, failure: 'request: no skill to offer' }
      const first = await ask(request)
      stages.push(first.ms)
      if (!first.asked.ok) return { ok: false, failure: `${first.asked.failure.kind}: ${first.asked.failure.detail}` }
      const answers = answersFor(part, first.asked.answers)
      const ranking = await ranker.rank(answers, options, { state: request.state })
      if (ranking === null) return { ok: false, failure: 'parse: no answer about the skills' }
      if (ranking.failed !== undefined) return { ok: false, failure: `second request: ${ranking.failed.kind}: ${ranking.failed.detail}` }
      const { suggest, hint } = pickSkills(ranking, options, suggestPolicy(settings))
      return {
        ok: true,
        prediction: { suggest: suggest.map((skill) => skill.name), hint: hint.map((skill) => skill.name) },
        detail: detailOf(readSkills(answers, options), ranking, stages),
      }
    },
    grade: gradeSkills,
    show: showAnswer,
    constants: [{ suggest: [], hint: [] }],
    questions: (variant) => asks[variant],
    // Stage one as decide asks it, and stage two as if stage one had put a
    // full shortlist forward: the skills the item wants (acceptable, then
    // hinted) first, then the others in order.
    async estimate(item, language, variant, settings) {
      const options = await offered(variant, settings)
      const { request, part } = firstRequest(item[language], options, settings, rankerFor(options, settings, unsent))
      if (part === null) return [request]
      const wanted = [...item.accept, ...item.user_only_hint]
      const ordered = [...wanted.flatMap((name) => options.filter((option) => option.name === name)), ...options.filter((option) => !wanted.includes(option.name))]
      const count = Math.max(1, Math.min(MAX_SHORTLIST, rankingSettings({ options: settings.options, config: settings, ask: DEFAULT_ASK }).shortlist))
      return [request, secondRequest(request.state, options, ordered.slice(0, count))]
    },
    breakdown: (items, rows, _variant, settings) => {
      const never = new Set(namesOf(settings.options.skillsNeverSuggested))
      return skillBreakdown(items, rows, skills.filter((skill) => !never.has(skill.name)), settings)
    },
    report: reportLines,
    scoring: SCORING,
    about,
  }
}

const SCORING =
  'suggest (the skills the main agent is shown: at most skillsMax, with relevance skillsMinRelevance or more): where no skill fits (gold empty), right only when nothing is suggested; otherwise right when a suggested skill is in accept and none is in must_not. A neutral skill (in neither list) costs nothing beside an acceptable one, but suggested alone it misses. hint (the skills only the person can start, named on the status line, at most 2 a message): where user_only_hint is empty, right only when nothing is hinted; otherwise right when a hinted skill is in user_only_hint. Whole answer (accuracy): both parts right; exact (gold): the suggested skills are the gold ones and the hinted ones those of user_only_hint, no more and no fewer. No decision (a request failed, no answer about the skills, the second request failed) is wrong. Misses: must-not, extra (a skill where none fits), neutral-only, missed (none where one fits), hint-extra, hint-missed, hint-other. Latency: both stages together (the mod gives them one wait, timeoutMs); the eval does not cut stage two to what stage one left of it, it counts the answers past timeoutMs.'

/** The lines eval/run.ts prints about a variant's own figures. */
function reportLines(summary: VariantSummary): string[] {
  const own = summary.breakdown as SkillBreakdown | undefined
  if (own === undefined) return []
  const pct = (value: number | undefined) => (value === undefined ? '-' : `${Math.round(value * 1000) / 10}`)
  const ms = (value: number | null) => (value === null ? '-' : `${value}`)
  const v = summary.variant
  const swept = (entries: readonly Swept[], field: string) => entries.map((entry) => `${entry.value}${entry.current ? '*' : ''} ${pct(entry.zh[field])}/${pct(entry.en[field])}`).join(', ')
  const best = (bar: 'skillsMinRelevance' | 'findSkillMinRelevance', field: string) =>
    (['zh', 'en'] as const).map((language) => `${language} ${own.best[bar][language].values.join(', ')} (${pct(own.best[bar][language][field])}%)`).join('; ')
  return [
    `${v}: right by situation, whole answer zh/en % (items): ${own.groups.map((group) => `${group.group} ${pct(group.zh.whole)}/${pct(group.en.whole)} (${group.items})`).join(', ')}`,
    `${v}: stage one p50 ${ms(own.stages.first.p50)} ms, p90 ${ms(own.stages.first.p90)} ms; stage two asked for ${pct(own.stages.second.share)}% of answers, p50 ${ms(own.stages.second.p50)} ms, p90 ${ms(own.stages.second.p90)} ms`,
    `${v}: of the ${own.funnel.zh.items} items a skill fits, stage one put an acceptable one forward for zh ${own.funnel.zh.shortlisted}, en ${own.funnel.en.shortlisted}; one passed skillsMinRelevance for zh ${own.funnel.zh.passed}, en ${own.funnel.en.passed}`,
    `${v}: skillsMinRelevance (* the run's), whole answer right zh/en %: ${swept(own.sweeps.skillsMinRelevance, 'whole')}; best ${best('skillsMinRelevance', 'whole')}`,
    `${v}: findSkillMinRelevance (* the run's), returned skills right zh/en %: ${swept(own.sweeps.findSkillMinRelevance, 'suggest')}; recall zh/en %: ${swept(own.sweeps.findSkillMinRelevance, 'recall')}; best ${best('findSkillMinRelevance', 'suggest')}`,
  ]
}

/** The sha256 the snapshot recorded for each skill's SKILL.md, by name. */
function snapshotHashes(catalog: unknown): ReadonlyMap<string, string> {
  const skills = isRecord(catalog) && Array.isArray(catalog.skills) ? catalog.skills.filter(isRecord) : []
  return new Map(skills.flatMap((skill) => (typeof skill.name === 'string' && typeof skill.sha256 === 'string' ? [[skill.name, skill.sha256] as const] : [])))
}

/** A text's sha256 (of its UTF-8 bytes), in hex. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * An answer scores by the review's rules (eval/review/skill.review-summary.md),
 * in two parts. `suggest`, the skills the main agent is shown: where no skill
 * fits (gold empty), right only when none is suggested; otherwise right when
 * one suggested is acceptable and none is in must_not. A skill in neither
 * list (neutral) costs nothing beside an acceptable one, but alone it misses.
 * `hint`, the skills only the person can start, named on the status line:
 * where the item hints none, right only when none is hinted; otherwise right
 * when one hinted is among user_only_hint. The answer is right when both
 * parts are; exact when it suggests the gold skills and hints the
 * user_only_hint ones, no more and no fewer. A miss names each part that
 * missed: `must-not`, `extra` (a skill where none fits), `neutral-only`,
 * `missed` (none where one fits); `hint-extra`, `hint-missed`, `hint-other`
 * (only skills the item does not hint).
 */
export function gradeSkills(item: SkillItem, answer: SkillAnswer): Grade {
  const suggestMiss = suggestionMiss(item, answer.suggest)
  const hintMiss = hintingMiss(item, answer.hint)
  const misses = [suggestMiss, hintMiss].filter((miss): miss is string => miss !== null)
  const same = (names: readonly string[], list: readonly string[]) => names.length === list.length && names.every((name) => list.includes(name))
  const correct = misses.length === 0
  return {
    correct,
    exact: correct && same(answer.suggest, item.gold) && same(answer.hint, item.user_only_hint),
    parts: { suggest: suggestMiss === null, hint: hintMiss === null },
    ...(correct ? {} : { miss: misses.join(' ') }),
  }
}

/** How the skills suggested miss (null when they are right). */
function suggestionMiss(item: SkillItem, suggest: readonly string[]): string | null {
  if (suggest.some((name) => item.must_not.includes(name))) return 'must-not'
  if (item.gold.length === 0) return suggest.length === 0 ? null : 'extra'
  if (suggest.length === 0) return 'missed'
  return suggest.some((name) => item.accept.includes(name)) ? null : 'neutral-only'
}

/** How the skills hinted miss (null when they are right). */
function hintingMiss(item: SkillItem, hint: readonly string[]): string | null {
  if (item.user_only_hint.length === 0) return hint.length === 0 ? null : 'hint-extra'
  if (hint.length === 0) return 'hint-missed'
  return hint.some((name) => item.user_only_hint.includes(name)) ? null : 'hint-other'
}

/**
 * An answer as one line, names in alphabetical order (the same skills in
 * another order are the same answer): the skills suggested (`none`), then
 * those hinted as the status line hints them (`try /grill-me`).
 */
function showAnswer(answer: SkillAnswer): string {
  const suggested = [...answer.suggest].sort().join(', ') || 'none'
  return answer.hint.length === 0 ? suggested : `${suggested} | try ${[...answer.hint].sort().map((name) => `/${name}`).join(' ')}`
}

/** How many skills a message is shown at most, and the least relevance one needs, read as features/skills.ts reads them. */
function suggestPolicy(settings: Settings): SkillPolicy {
  return { max: Math.round(numberIn(settings.options.skillsMax, 0, 10, 3)), minRelevance: numberIn(settings.options.skillsMinRelevance, 0, 1, 0.7) }
}

/** How many skills find_skill returns at most, and the least relevance one needs, read as features/find-skill.ts reads them. */
function findPolicy(settings: Settings): SkillPolicy {
  return { max: Math.round(numberIn(settings.options.findSkillMax, 1, 10, 5)), minRelevance: numberIn(settings.options.findSkillMinRelevance, 0, 1, 0.5) }
}

/**
 * What a run keeps of an answer: stage one's five highest shares (0.01 and
 * up) and none's; stage two's fit for each skill stage one put forward, in
 * the ranking's order and as answered (the relevance the bars compare, kept
 * whole so a sweep at the run's own bar is the run); how long each stage's
 * request took, in ms.
 */
function detailOf(first: SkillRanking | null, ranking: SkillRanking, stages: readonly number[]): Record<string, unknown> {
  return {
    first: (first?.ranked ?? []).filter((entry) => entry.relevance >= 0.01).slice(0, 5).map((entry) => ({ name: entry.name, share: round(entry.relevance) })),
    none: round(ranking.none),
    fits: ranking.ranked.map((entry) => ({ name: entry.name, relevance: entry.relevance })),
    stages_ms: stages.map((ms) => Math.round(ms)),
  }
}

/** A stage two fit as an answer records it (detailOf). */
type Fit = { name: string; relevance: number }

/** The fits an answer records; null for an answer without them (no answer). */
function fitsOf(row: Row<SkillAnswer> | undefined): Fit[] | null {
  const fits = row?.ok ? row.detail?.fits : undefined
  return Array.isArray(fits) ? (fits as Fit[]) : null
}

/**
 * The situations the dataset was written to cover, each a group of items
 * (README, 评测): no skill fits; a skill fits (in Chinese: a Chinese request
 * matched to a skill described in English); several skills fit in part;
 * look-alike names; a word that lures; a skill only the person can start;
 * work only the conversation before the message names.
 */
const GROUPS: readonly { group: string; has: (item: SkillItem) => boolean }[] = [
  { group: 'none', has: (item) => item.tags.includes('none') },
  { group: 'skill-needed', has: (item) => item.gold.length > 0 },
  { group: 'multi-partial', has: (item) => item.tags.includes('multi-partial') },
  { group: 'near-duplicate', has: (item) => item.tags.includes('near-duplicate') },
  { group: 'lexical-trap', has: (item) => item.tags.includes('lexical-trap') },
  { group: 'user-only', has: (item) => item.tags.includes('user-only') },
  { group: 'needs-context', has: (item) => item.tags.includes('needs-context') },
]

/** The bars swept, besides the run's own. */
const BARS = [0.3, 0.4, 0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95] as const

type Rates = Record<string, number>
type Swept = { value: number; current?: true; zh: Rates; en: Rates }

/** The suite's own figures for one variant (Suite.breakdown). */
export type SkillBreakdown = {
  /** Each situation's items, and the share right in each language: the whole answer and each part. */
  groups: { group: string; items: number; zh: Rates; en: Rates }[]
  /** Each stage's latency over its answered requests; how many answers asked stage two, and what share. */
  stages: { first: Latency; second: Latency & { share: number } }
  /** Of the items a skill fits, in each language: those where stage one put an acceptable skill forward, and where one passed skillsMinRelevance. */
  funnel: Record<Language, { items: number; shortlisted: number; passed: number }>
  /**
   * The two bars swept over the answers the run got (nothing asked again):
   * `skillsMinRelevance`, the skills suggested and hinted again (at most
   * skillsMax), graded whole and in parts; `findSkillMinRelevance`, what
   * find_skill would return (at most findSkillMax, only skills the main
   * agent can load), graded as suggestions (`suggest`), with `recall` (of the
   * items a skill fits, those it returns an acceptable skill for) and
   * `quiet` (of those no skill fits, those it returns nothing for).
   */
  sweeps: { skillsMinRelevance: Swept[]; findSkillMinRelevance: Swept[] }
  /** Each bar's best values in each language: the highest whole answer (skillsMinRelevance) or suggestion (findSkillMinRelevance) right, and every value that reaches it. */
  best: Record<'skillsMinRelevance' | 'findSkillMinRelevance', Record<Language, Rates & { values: number[] }>>
}

type Latency = { answers: number; p50: number | null; p90: number | null; max: number | null }

function skillBreakdown(items: readonly SkillItem[], rows: readonly Row<SkillAnswer>[], options: readonly CatalogSkill[], settings: Settings): SkillBreakdown {
  const answered = (language: Language) => new Map(rows.filter((row) => row.language === language).map((row) => [row.id, row]))
  const by = { zh: answered('zh'), en: answered('en') }
  const suggestBar = suggestPolicy(settings)
  const findBar = findPolicy(settings)

  const groups = GROUPS.map(({ group, has }) => {
    const mine = items.filter(has)
    const rates = (language: Language): Rates => {
      const share = (right: (row: Row<SkillAnswer>) => boolean) => rate(mine.filter((item) => isRight(by[language].get(item.id), right)).length, mine.length)
      return { whole: share((row) => row.correct), suggest: share((row) => row.parts?.suggest === true), hint: share((row) => row.parts?.hint === true) }
    }
    return { group, items: mine.length, zh: rates('zh'), en: rates('en') }
  })

  const stage = (at: number) => rows.flatMap((row) => (row.ok && Array.isArray(row.detail?.stages_ms) && typeof row.detail.stages_ms[at] === 'number' ? [row.detail.stages_ms[at] as number] : []))
  const second = stage(1)
  const stages = { first: latency(stage(0)), second: { ...latency(second), share: rate(second.length, rows.filter((row) => row.ok).length) } }

  const funnel = (language: Language) => {
    const needed = items.filter((item) => item.gold.length > 0)
    const fitsFor = (item: SkillItem) => (fitsOf(by[language].get(item.id)) ?? []).filter((fit) => item.accept.includes(fit.name))
    return {
      items: needed.length,
      shortlisted: needed.filter((item) => fitsFor(item).length > 0).length,
      passed: needed.filter((item) => fitsFor(item).some((fit) => fit.relevance >= suggestBar.minRelevance)).length,
    }
  }

  /** The answer the mod would have given an item under `policy`, from what the run recorded; null without one. */
  const repick = (item: SkillItem, language: Language, policy: SkillPolicy) => {
    const fits = fitsOf(by[language].get(item.id))
    return fits === null ? null : pickSkills({ ranked: fits, none: 0 }, options, policy)
  }
  const suggestRates = (value: number) => {
    const rates = (language: Language): Rates => {
      const grades = items.map((item) => {
        const picked = repick(item, language, { ...suggestBar, minRelevance: value })
        return picked === null ? null : gradeSkills(item, { suggest: picked.suggest.map((skill) => skill.name), hint: picked.hint.map((skill) => skill.name) })
      })
      const share = (right: (grade: Grade) => boolean) => rate(grades.filter((grade) => grade !== null && right(grade)).length, items.length)
      return { whole: share((grade) => grade.correct), suggest: share((grade) => grade.parts?.suggest === true), hint: share((grade) => grade.parts?.hint === true) }
    }
    return { zh: rates('zh'), en: rates('en') }
  }
  const findRates = (value: number) => {
    const rates = (language: Language): Rates => {
      const returned = items.map((item) => {
        const picked = repick(item, language, { ...findBar, minRelevance: value })
        return { item, names: picked === null ? null : picked.suggest.map((skill) => skill.name) }
      })
      const needed = returned.filter(({ item }) => item.gold.length > 0)
      const none = returned.filter(({ item }) => item.gold.length === 0)
      return {
        suggest: rate(returned.filter(({ item, names }) => names !== null && suggestionMiss(item, names) === null).length, items.length),
        recall: rate(needed.filter(({ item, names }) => names !== null && names.some((name) => item.accept.includes(name))).length, needed.length),
        quiet: rate(none.filter(({ names }) => names !== null && names.length === 0).length, none.length),
      }
    }
    return { zh: rates('zh'), en: rates('en') }
  }
  const sweeps = {
    skillsMinRelevance: sweep(suggestBar.minRelevance, suggestRates),
    findSkillMinRelevance: sweep(findBar.minRelevance, findRates),
  }
  return {
    groups,
    stages,
    funnel: { zh: funnel('zh'), en: funnel('en') },
    sweeps,
    best: { skillsMinRelevance: best(sweeps.skillsMinRelevance, 'whole'), findSkillMinRelevance: best(sweeps.findSkillMinRelevance, 'suggest') },
  }
}

function isRight(row: Row<SkillAnswer> | undefined, right: (row: Row<SkillAnswer>) => boolean): boolean {
  return row !== undefined && row.ok && right(row)
}

/** A bar's values (BARS and the run's own, marked), each with the rates `at` gives it. */
function sweep(current: number, at: (value: number) => { zh: Rates; en: Rates }): Swept[] {
  return [...new Set([...BARS, current])].sort((a, b) => a - b).map((value) => ({ value, ...(value === current ? { current: true as const } : {}), ...at(value) }))
}

/** In each language, the highest `field` a sweep reached and every value that reached it. */
function best(swept: readonly Swept[], field: string): Record<Language, Rates & { values: number[] }> {
  const of = (language: Language) => {
    const top = Math.max(...swept.map((entry) => entry[language][field] ?? 0))
    return { [field]: top, values: swept.filter((entry) => entry[language][field] === top).map((entry) => entry.value) } as Rates & { values: number[] }
  }
  return { zh: of('zh'), en: of('en') }
}

/** p50 and p90 by nearest rank, as metrics.ts takes them; the max. */
function latency(values: readonly number[]): Latency {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (p: number) => (sorted.length === 0 ? null : (sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number))
  return { answers: sorted.length, p50: rank(0.5), p90: rank(0.9), max: sorted.at(-1) ?? null }
}

function rate(count: number, of: number): number {
  return of === 0 ? 0 : Math.round((count / of) * 10_000) / 10_000
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
