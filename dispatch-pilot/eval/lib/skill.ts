// The skill suite: the skill suggested beside a message the person sends
// (#10, picked as TypeSafe's skill suggestion cookbook picks it since ADR 0018).
// An item is the message and the conversation before it; the session's skills
// are the person's own, as a snapshot of their machine records them
// (skill-catalog.json beside the dataset), each offered by its own description
// and re-read in stage two from its SKILL.md on disk. The requests are built by
// the ranking the mod uses (hooks/decision/skills.ts: skillsRequest, then
// modRanker's second stage), with the mod's settings and the run's decision
// model's bars, so the eval measures what the mod sends.
//
// One variant, `cookbook`: how the mod asks. (The variants of profiles and of
// Chinese questions went with ADR 0018: the mod writes no profiles and asks the
// cookbook's English questions.)
//
// Pure: no Node API. What it reads besides its items comes in as SkillSources.

import { rankingSettings, type CatalogSkill } from '../../hooks/core/skills.ts'
import {
  modRanker,
  pickSkills,
  SHORTLIST,
  skillOpening,
  skillsRequest,
  stageTwoPart,
  type SkillRanker,
  type SkillRankerIo,
  type SkillRanking,
} from '../../hooks/decision/skills.ts'
import { answersFor, mergeParts, type DecisionRequest, type Part } from '../../hooks/decision/system-one.ts'
import { isRecord, type Language, type SkillItem, type SubmitAsked } from './datasets.ts'
import { contextMessages } from './effort-submit.ts'
import { nearestRank, rate, type VariantSummary } from './metrics.ts'
import type { Row } from './runner.ts'
import { requestFailed, settingsFrom, type Grade, type Settings, type Suite } from './suite.ts'

/** What the suite decides for a message: the skill the main agent is shown (one at most), and the one only the person can start, hinted on the status line. */
export type SkillAnswer = { suggest: string[]; hint: string[] }

/** What the suite reads besides its items. */
export type SkillSources = {
  /** skill-catalog.json as parsed: the snapshot of the person's skills. */
  catalog: unknown
  /** A SKILL.md by the path the snapshot records (`~` the home directory); rejects when it cannot be read. */
  read: (path: string) => Promise<string>
}

export const SKILL_VARIANTS: readonly string[] = ['cookbook']

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

/** The skill suite over the person's skills (`sources`): each SKILL.md read once, as the mod reads them for the second stage. */
export async function skillSuite(sources: SkillSources): Promise<Suite<SkillItem, SkillAnswer>> {
  const skills = catalogSkills(sources.catalog)
  const texts = new Map<string, string | null>()
  for (const skill of skills) if (skill.file !== null && !texts.has(skill.file)) texts.set(skill.file, await sources.read(skill.file).catch(() => null))
  const markdown = (file: string | null): string | null => (file === null ? null : (texts.get(file) ?? null))

  /** The skills offered under the person's options, as the mod offers them for a message. */
  const offered = (settings: Settings): CatalogSkill[] => {
    const never = new Set(settings.skills.neverSuggested)
    return skills.filter((skill) => !never.has(skill.name))
  }
  /** The opening of a skill's SKILL.md as stage two reads it (null without one), as the mod reads it for its catalog's skill of that name. */
  const openingOf = (offeredSkills: readonly CatalogSkill[], name: string): string | null => {
    const text = markdown(offeredSkills.find((skill) => skill.name === name)?.file ?? null)
    return text === null ? null : skillOpening(text)
  }
  /** The mod's ranker for a message under the person's settings; `ask` sends stage two. */
  const rankerFor = (offeredSkills: readonly CatalogSkill[], settings: Settings, ask: SkillRankerIo['ask']): SkillRanker =>
    modRanker({ ask, opening: async (option) => openingOf(offeredSkills, option.name) }, rankingSettings({ config: settings }, 'message'))
  /** Stage one's request, as the mod sends it when the person sends this message after this conversation (the effort question has its own request). */
  const firstRequest = (asked: SubmitAsked, offeredSkills: readonly CatalogSkill[], settings: Settings, ranker: SkillRanker) =>
    skillsRequest({ message: asked.message, recent_context: contextMessages(asked.recent_context) }, offeredSkills, { limits: settings.context, ranker })
  /** Stage two's request for these candidates, about stage one's state. */
  const secondRequest = (state: DecisionRequest['state'], offeredSkills: readonly CatalogSkill[], candidates: readonly CatalogSkill[]) =>
    mergeParts(state, [stageTwoPart(candidates.map((option) => ({ option, opening: openingOf(offeredSkills, option.name) }))) as Part])
  const unsent: SkillRankerIo['ask'] = async () => ({ ok: false, failure: { kind: 'config', detail: 'not sent' } })

  // What the variant asks under the manifest's defaults, recorded with the results: stage one in full; stage two for the first two skills.
  const defaults = settingsFrom({ decisionModel: 'jev' })
  const defaultSkills = offered(defaults)
  const { request: shown } = firstRequest({ message: '', recent_context: [] }, defaultSkills, defaults, rankerFor(defaultSkills, defaults, unsent))
  const asks: Record<string, unknown> = { cookbook: shown === null ? null : { first: shown.questions, second: secondRequest(shown.state, defaultSkills, defaultSkills.slice(0, 2)).questions } }

  // What was read, against the snapshot the dataset was written for: each SKILL.md beside the sha256 the snapshot recorded.
  const recorded = snapshotHashes(sources.catalog)
  const filed = skills.filter((skill) => skill.file !== null)
  const unreadable = filed.filter((skill) => markdown(skill.file) === null).map((skill) => skill.name)
  const changed: string[] = []
  for (const skill of filed) {
    const text = markdown(skill.file)
    const want = recorded.get(skill.name)
    if (text !== null && want !== undefined && (await sha256(text)) !== want) changed.push(skill.name)
  }
  const skillsCount = (names: readonly string[]) => `${names.length} ${names.length === 1 ? 'skill' : 'skills'}`
  const about = {
    skills: { offered: skills.length, model: skills.filter((skill) => skill.by === 'model').length, person: skills.filter((skill) => skill.by === 'person').length },
    files: { read: filed.length - unreadable.length, unreadable, changed },
    warnings: [
      ...(changed.length > 0 ? [`SKILL.md differs from the snapshot for ${skillsCount(changed)}: ${changed.join(', ')}`] : []),
      ...(unreadable.length > 0 ? [`SKILL.md cannot be read for ${skillsCount(unreadable)}: ${unreadable.join(', ')}`] : []),
    ],
  }

  return {
    name: 'skill',
    variants: SKILL_VARIANTS,
    async decide(item, language, _variant, ask, settings) {
      const offeredSkills = offered(settings)
      // How long each stage's answered request took, in order.
      const stages: number[] = []
      const ranker = rankerFor(offeredSkills, settings, async (request) => {
        const sent = await ask(request)
        stages.push(sent.ms)
        return sent.asked
      })
      const { request, part } = firstRequest(item[language], offeredSkills, settings, ranker)
      if (request === null) return { ok: false, failure: 'request: no skill to offer' }
      const first = await ask(request)
      stages.push(first.ms)
      if (!first.asked.ok) return requestFailed(first.asked.failure)
      const ranking = await ranker.rank(answersFor(part, first.asked.answers), offeredSkills, { state: request.state })
      if (ranking === null) return { ok: false, failure: 'parse: no answer about the skills' }
      if (ranking.failed !== undefined) return { ok: false, failure: `second request: ${ranking.failed.kind}: ${ranking.failed.detail}` }
      const { suggest, hint } = pickSkills(ranking, offeredSkills, settings.guide.skills)
      return {
        ok: true,
        prediction: { suggest: suggest.map((skill) => skill.name), hint: hint.map((skill) => skill.name) },
        detail: detailOf(ranking, stages),
      }
    },
    grade: gradeSkills,
    show: showAnswer,
    constants: [{ suggest: [], hint: [] }],
    questions: (variant) => asks[variant],
    // Stage one as decide asks it, and stage two as if each Choice of stage one had put a full shortlist forward: the
    // acceptable skills first, then the others in order; of those only the person can start, the hinted ones first.
    async estimate(item, language, _variant, settings) {
      const offeredSkills = offered(settings)
      const { request } = firstRequest(item[language], offeredSkills, settings, rankerFor(offeredSkills, settings, unsent))
      if (request === null) return []
      const fullest = (by: CatalogSkill['by'], wanted: readonly string[]) => {
        const mine = offeredSkills.filter((option) => option.by === by)
        return [...wanted.flatMap((name) => mine.filter((option) => option.name === name)), ...mine.filter((option) => !wanted.includes(option.name))].slice(0, SHORTLIST)
      }
      return [request, secondRequest(request.state, offeredSkills, [...fullest('model', item.accept), ...fullest('person', item.user_only_hint)])]
    },
    breakdown: (items, rows) => skillBreakdown(items, rows),
    report: reportLines,
    scoring: SCORING,
    about,
  }
}

const SCORING =
  "suggest (the skill the main agent is shown: at most one, the cookbook's; nothing when the three gate questions average below the decision model's bar, or when the best fit of the three re-read is under its bar): where no skill fits (gold empty), right only when nothing is suggested; otherwise right when the suggested skill is in accept and not in must_not. A neutral skill (in neither list) suggested alone misses. hint (the skill only the person can start, named on the status line, at most one a message): where user_only_hint is empty, right only when nothing is hinted; otherwise right when the hinted skill is in user_only_hint. Whole answer (accuracy): both parts right; exact (gold): the suggested skills are the gold ones and the hinted ones those of user_only_hint, no more and no fewer. No decision (a request failed, no answer about the skills, the second request failed) is wrong. Misses: must-not, extra (a skill where none fits), neutral-only, missed (none where one fits), hint-extra, hint-missed, hint-other. Latency: both stages together (the mod gives them one wait, timeoutMs); the eval does not cut stage two to what stage one left of it, it counts the answers past timeoutMs."

/** The lines eval/run.ts prints about a variant's own figures. */
function reportLines(summary: VariantSummary): string[] {
  const own = summary.breakdown as SkillBreakdown | undefined
  if (own === undefined) return []
  const pct = (value: number | undefined) => (value === undefined ? '-' : `${Math.round(value * 1000) / 10}`)
  const ms = (value: number | null) => (value === null ? '-' : `${value}`)
  const v = summary.variant
  return [
    `${v}: right by situation, whole answer zh/en % (items): ${own.groups.map((group) => `${group.group} ${pct(group.zh.whole)}/${pct(group.en.whole)} (${group.items})`).join(', ')}`,
    `${v}: stage one p50 ${ms(own.stages.first.p50)} ms, p90 ${ms(own.stages.first.p90)} ms; stage two asked for ${pct(own.stages.second.share)}% of answers, p50 ${ms(own.stages.second.p50)} ms, p90 ${ms(own.stages.second.p90)} ms`,
    `${v}: the gate stopped zh/en % of the items no skill fits ${pct(own.gate.zh.quietStopped)}/${pct(own.gate.en.quietStopped)}, of those a skill fits ${pct(own.gate.zh.neededStopped)}/${pct(own.gate.en.neededStopped)}`,
    `${v}: of the ${own.funnel.zh.items} items a skill fits, stage one put an acceptable one forward for zh ${own.funnel.zh.shortlisted}, en ${own.funnel.en.shortlisted}; one was suggested for zh ${own.funnel.zh.passed}, en ${own.funnel.en.passed}`,
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
 * An answer scores by the review's rules (eval/review/skill.review-summary.md), in the two parts `SCORING` says (`suggest`
 * and `hint`); a miss names each part that missed, as `SCORING` lists them.
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

/**
 * What a run keeps of an answer: the gate's mean (null when it was not read) and whether it stopped the ranking; what each
 * Choice of stage one put forward, with its share; stage two's fit for each candidate and whom its Choices picked; how long
 * each stage's request took, in ms.
 */
function detailOf(ranking: SkillRanking, stages: readonly number[]): Record<string, unknown> {
  const shares = (entries: SkillRanking['shortlist']) => entries.map((entry) => ({ name: entry.name, share: round(entry.share) }))
  return {
    gate: ranking.gate === null ? null : round(ranking.gate.mean),
    stopped: ranking.stopped === 'gate',
    first: shares(ranking.shortlist),
    hints: shares(ranking.hints),
    fits: ranking.fits.map((fit) => ({ name: fit.name, relevance: round(fit.fit) })),
    winner: ranking.winner,
    hint_winner: ranking.hintWinner,
    stages_ms: stages.map((ms) => Math.round(ms)),
  }
}

/** The shortlist an answer records; null for an answer without one (no answer). */
function shortlistOf(row: Row<SkillAnswer> | undefined): string[] | null {
  const first = row?.ok ? row.detail?.first : undefined
  return Array.isArray(first) ? (first as { name: string }[]).map((entry) => entry.name) : null
}

/**
 * The situations the dataset was written to cover, each a group of items
 * (DEVELOPMENT.md, 评测): no skill fits; a skill fits (in Chinese: a Chinese request
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

type Rates = Record<string, number>

/** The suite's own figures for one variant (Suite.breakdown). */
export type SkillBreakdown = {
  /** Each situation's items, and the share right in each language: the whole answer and each part. */
  groups: { group: string; items: number; zh: Rates; en: Rates }[]
  /** Each stage's latency over its answered requests; how many answers asked stage two, and what share. */
  stages: { first: Latency; second: Latency & { share: number } }
  /** In each language, the share of the items no skill fits (`quietStopped`) and of those a skill fits (`neededStopped`) the gate stopped. */
  gate: Record<Language, Rates>
  /** Of the items a skill fits, in each language: those where stage one put an acceptable skill forward, and where one was suggested. */
  funnel: Record<Language, { items: number; shortlisted: number; passed: number }>
}

type Latency = { answers: number; p50: number | null; p90: number | null; max: number | null }

function skillBreakdown(items: readonly SkillItem[], rows: readonly Row<SkillAnswer>[]): SkillBreakdown {
  const answered = (language: Language) => new Map(rows.filter((row) => row.language === language).map((row) => [row.id, row]))
  const by = { zh: answered('zh'), en: answered('en') }

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

  const stopped = (row: Row<SkillAnswer> | undefined) => row !== undefined && row.ok && row.detail?.stopped === true
  const gate = (language: Language): Rates => {
    const quiet = items.filter((item) => item.gold.length === 0)
    const needed = items.filter((item) => item.gold.length > 0)
    return {
      quietStopped: rate(quiet.filter((item) => stopped(by[language].get(item.id))).length, quiet.length),
      neededStopped: rate(needed.filter((item) => stopped(by[language].get(item.id))).length, needed.length),
    }
  }

  const funnel = (language: Language) => {
    const needed = items.filter((item) => item.gold.length > 0)
    const row = (item: SkillItem) => by[language].get(item.id)
    return {
      items: needed.length,
      shortlisted: needed.filter((item) => (shortlistOf(row(item)) ?? []).some((name) => item.accept.includes(name))).length,
      passed: needed.filter((item) => {
        const answer = row(item)
        return answer !== undefined && answer.ok && (answer.prediction?.suggest ?? []).some((name) => item.accept.includes(name))
      }).length,
    }
  }

  return { groups, stages, gate: { zh: gate('zh'), en: gate('en') }, funnel: { zh: funnel('zh'), en: funnel('en') } }
}

function isRight(row: Row<SkillAnswer> | undefined, right: (row: Row<SkillAnswer>) => boolean): boolean {
  return row !== undefined && row.ok && right(row)
}

/** p50 and p90 by nearest rank, as metrics.ts takes them; the max. */
function latency(values: readonly number[]): Latency {
  const sorted = [...values].sort((a, b) => a - b)
  return { answers: sorted.length, p50: nearestRank(sorted, 0.5), p90: nearestRank(sorted, 0.9), max: sorted.at(-1) ?? null }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
