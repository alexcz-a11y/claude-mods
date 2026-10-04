// How the decision model ranks the session's skills for a message, in two
// stages (#11), and how the ranking becomes the skills suggested.
//
//   stage one  one Choice over every skill and "(none)", in the message's one
//              decision request (`skills.which`): a skill is offered by its
//              bilingual profile when one is written (`SkillProfile`), else by
//              its description. Only for ranking: its shares are relative.
//   stage two  a request of its own about the same state, for the few skills
//              stage one rated highest: each re-read with the opening of its
//              SKILL.md, a yes/no `skills.fits.<i>` each (the absolute
//              relevance shown and compared with the threshold) and a Choice
//              `skills.best` between them (breaks ties).
//
// `modRanker` is the one entry: the message's suggestions (features/
// skills.ts) and find_skill (#12, features/find-skill.ts) rank through it, and
// so does the eval (#16).
//
// Pure (see system-one.ts): the mod and the eval build the same questions from
// the same code. Written to TypeSafe's guide (docs/research/
// typesafe-question-guide.md §2.4, §2.5, §4.3): every candidate is an option
// described by its own fields, a "(none)" option lets the model say no skill
// fits (jev-pilot measured it: without one the ranking always names a skill),
// and question ids use Clef's characters (`fits.0`, not the skill's name).

import type { Asked, Failure } from './backend.ts'
import { clipToTokens, estimateTokens, turnStartState, type ContextLimits, type ContextMessage } from './context.ts'
import { turnStartEffortPart, type EffortAsk, type Language } from './effort.ts'
import { redactSecrets } from './redact.ts'
import { answersFor, mergeParts, type Answer, type DecisionRequest, type Part, type Question, type State, type Text } from './system-one.ts'

/**
 * What a skill is for, in English and in Chinese, written once per version of
 * its SKILL.md by a cheap model (core/profiles.ts): what it does, the requests
 * it is for, and the nearby requests it is not for.
 */
export type SkillProfile = {
  en: { what: string; use_when: string; not_for: string }
  zh: { what: string; use_when: string; not_for: string }
}

/**
 * A skill the decision model may name. `by` says who can start it: `model`,
 * the main agent with the Skill tool; `person`, only the person by typing
 * `/name` (its SKILL.md sets `disable-model-invocation: true`): such a skill
 * is never suggested to the main agent, the status line names it instead.
 * `profile`, when one is written, describes it in place of the description.
 */
export type SkillOption = { name: string; description: string; by: 'model' | 'person'; profile?: SkillProfile | null }

/** The skills part's name and its questions' ids: `skills.which` (stage one), `skills.best` and `skills.fits.<i>` (stage two). */
export const SKILLS_PART = 'skills'
export const WHICH = 'which'
export const BEST = 'best'
export const FITS = 'fits'
/** The option that says no skill fits; parentheses keep it apart from any skill's name. */
export const NO_SKILL = '(none)'

/** The question; the state is `{ user_message, recent_context }`, as for effort. */
const WHICH_INSTRUCTIONS: Record<Language, Readonly<Record<string, string>>> = {
  en: {
    question: 'Which of these skills, if any, is the right one to load for the work that `user_message` asks for, given `recent_context`?',
    focus: 'Match the kind of work asked for (such as debugging a failure, planning, reviewing, designing, writing a document), not only a product or technology the message names.',
    platforms: 'A skill for one product or platform fits only when `user_message` or `recent_context` shows that product is the one in use here; otherwise choose a general skill or none.',
    short_replies:
      'When `user_message` only approves, continues or picks an option (such as "go ahead", "1", "继续"), judge the work it approves, as described at the end of `recent_context`.',
  },
  zh: {
    问题: '结合 `recent_context`，要完成 `user_message` 所要求的工作，应该加载下面哪个 skill？如果都不合适，选「都不合适」。',
    看什么: '按请求要做的工作类型来匹配（例如排查故障、做计划、审查、设计、写文档），而不只是看消息里提到的产品或技术。',
    平台: '针对某个产品或平台的 skill，只有在 `user_message` 或 `recent_context` 表明这里用的正是那个产品时才合适；否则选通用的 skill，或者都不选。',
    简短回复: '如果 `user_message` 只是同意、让继续或选一个选项（例如“go ahead”“1”“继续”），按它所同意的那项工作来判断；那项工作写在 `recent_context` 的末尾。',
  },
}

const NO_SKILL_CRITERION: Record<Language, string> = {
  en: 'None of these skills fits: the request is ordinary work that no listed skill is specifically about.',
  zh: '都不合适：这个请求是普通的工作，没有哪个列出的 skill 专门针对它。',
}

/** Stage two's Choice: the shortlist side by side, each with the opening of its instructions. */
const BEST_INSTRUCTIONS: Record<Language, Readonly<Record<string, string>>> = {
  en: {
    question: 'Exactly one of these skills is the right one to load for the work that `user_message` asks for, given `recent_context`. Which one?',
    read: 'Read what each skill actually does (its description and the opening of its instructions), not only its name.',
  },
  zh: {
    问题: '结合 `recent_context`，要完成 `user_message` 所要求的工作，下面这些 skill 中正好有一个最该加载。是哪一个？',
    看什么: '看每个 skill 实际做什么（它的描述和说明的开头），不要只看名字。',
  },
}

/** Stage two's yes/no per skill (the cookbook's `fits`); the skill goes in a field of its own beside the question. */
const FITS_INSTRUCTIONS: Record<Language, Readonly<Record<string, string>>> = {
  en: {
    question: 'Does `skill` do the specific kind of work that `user_message` asks for, given `recent_context`?',
    platforms: 'A skill for one product or platform fits only when `user_message` or `recent_context` shows that product is the one in use here.',
    short_replies:
      'When `user_message` only approves, continues or picks an option (such as "go ahead", "1", "继续"), judge the work it approves, as described at the end of `recent_context`.',
  },
  zh: {
    问题: '结合 `recent_context`，`skill` 是否正好做 `user_message` 所要求的那种工作？',
    平台: '针对某个产品或平台的 skill，只有在 `user_message` 或 `recent_context` 表明这里用的正是那个产品时才合适。',
    简短回复: '如果 `user_message` 只是同意、让继续或选一个选项（例如“go ahead”“1”“继续”），按它所同意的那项工作来判断；那项工作写在 `recent_context` 的末尾。',
  },
}

/** A Choice takes at most this many options (Jev's limit; Clef's too), "(none)" among them. */
export const MAX_CHOICE_OPTIONS = 255

/**
 * How much of a SKILL.md stage two reads: the opening of its body, frontmatter
 * off, about 700 English characters (the cookbook's EXCERPT_CHARS), counted in
 * tokens so Chinese text is cut to the same scale.
 */
export const OPENING_TOKENS = 180

/**
 * The opening of a SKILL.md as stage two reads it: the body after the
 * frontmatter, whitespace collapsed, secrets masked, cut to OPENING_TOKENS.
 * Empty when the body is.
 */
export function skillOpening(markdown: string): string {
  const frontmatter = /^﻿?---\r?\n[\s\S]*?\r?\n---[^\n]*(?:\r?\n|$)/.exec(markdown)
  const body = (frontmatter ? markdown.slice(frontmatter[0].length) : markdown).replace(/\s+/g, ' ').trim()
  return clipToTokens(redactSecrets(body), OPENING_TOKENS)
}

/**
 * A profile as the decision model reads it: the English fields, then the
 * Chinese ones, each under a label of its own language (the same labels for
 * every skill, so the options compare field by field). An empty `not_for` is
 * left out, and so is every `not_for` when `brief`.
 */
export function profileFields(profile: SkillProfile, brief = false): Record<string, string> {
  const fields: Record<string, string> = { what: profile.en.what, use_when: profile.en.use_when }
  if (profile.en.not_for && !brief) fields.not_for = profile.en.not_for
  fields['用途'] = profile.zh.what
  fields['何时用'] = profile.zh.use_when
  if (profile.zh.not_for && !brief) fields['何时不用'] = profile.zh.not_for
  return fields
}

/**
 * Jev reads at most 32k tokens of "the state and the longest question" (the
 * skills Choice is the longest). Stage one's question gets what the state may
 * leave of it: the state is at most `contextTokens` (the person's budget,
 * estimated as context.ts estimates), and the estimate runs low on JSON, so
 * the limit is taken as 32k / 1.35 in estimated tokens.
 */
export function questionBudget(contextTokens: number): number {
  return Math.max(4000, Math.floor(32_000 / 1.35) - contextTokens)
}

/**
 * The part a message's decision request carries for the skills (stage one):
 * one Choice, `skills.which`, over `options` in their order and then
 * "(none)", each skill described by its profile (`profileFields`) when it
 * has one, else by its description; past MAX_CHOICE_OPTIONS - 1 skills, the
 * rest are left out. Within `budget` (estimated tokens of the question):
 * past it every profile drops its "not for" fields, then the last skills are
 * described by their descriptions instead, from the end, until it fits.
 * Null when there is no skill to ask about.
 */
export function skillsPart(options: readonly SkillOption[], ask: { language?: Language; budget?: number } = {}): Part | null {
  if (options.length === 0) return null
  const language = ask.language ?? 'en'
  const offered = options.slice(0, MAX_CHOICE_OPTIONS - 1)
  const question = (criteria: readonly (Text | null)[]): Question => {
    const named: Record<string, Text | null> = {}
    offered.forEach((option, i) => (named[option.name] = criteria[i] ?? null))
    named[NO_SKILL] = NO_SKILL_CRITERION[language]
    return { type: 'choice', instructions: WHICH_INSTRUCTIONS[language], criteria: named }
  }
  const budget = ask.budget ?? Number.POSITIVE_INFINITY
  const described = (option: SkillOption): Text | null => option.description.trim() || null
  const full = offered.map((option) => (option.profile ? profileFields(option.profile) : described(option)))
  const size = (criteria: readonly (Text | null)[]) => estimateTokens(JSON.stringify(question(criteria)))
  let criteria = full
  if (size(criteria) > budget) {
    criteria = offered.map((option) => (option.profile ? profileFields(option.profile, true) : described(option)))
    // From the end, profiles give way to descriptions; each swap's saving is
    // estimated alone, then the whole is measured again until it fits.
    for (let i = offered.length - 1, total = size(criteria); i >= 0 && total > budget; i--) {
      const option = offered[i] as SkillOption
      if (!option.profile) continue
      const before = estimateTokens(JSON.stringify(criteria[i]))
      criteria = criteria.map((criterion, j) => (j === i ? described(option) : criterion))
      total -= before - estimateTokens(JSON.stringify(criteria[i]))
      if (total <= budget) total = size(criteria)
    }
  }
  return { part: SKILLS_PART, questions: { [WHICH]: question(criteria) } }
}

/** A skill stage two re-reads, with the opening of its SKILL.md (null when it could not be read). */
export type Candidate = { option: SkillOption; opening: string | null }

/** What stage two shows of a candidate: its description, its profile when it has one, and the opening of its instructions. */
function detailOf(candidate: Candidate): Record<string, string> {
  const detail: Record<string, string> = {}
  const description = candidate.option.description.trim()
  if (description) detail.description = description
  if (candidate.option.profile) Object.assign(detail, profileFields(candidate.option.profile))
  if (candidate.opening) detail.opening = candidate.opening
  return detail
}

/**
 * The part of stage two's request: a yes/no `fits.<i>` for each candidate
 * (the skill as structured data beside the question), and a Choice `best`
 * between them when there are two or more (Clef refuses a Choice of one).
 * Null for no candidate.
 */
export function rerankPart(candidates: readonly Candidate[], ask: { language?: Language } = {}): Part | null {
  if (candidates.length === 0) return null
  const language = ask.language ?? 'en'
  const details = candidates.map(detailOf)
  const questions: Record<string, Question> = {}
  if (candidates.length >= 2) {
    const criteria: Record<string, Text> = {}
    candidates.forEach((candidate, i) => (criteria[candidate.option.name] = details[i] as Record<string, string>))
    questions[BEST] = { type: 'choice', instructions: BEST_INSTRUCTIONS[language], criteria }
  }
  candidates.forEach((candidate, i) => {
    questions[`${FITS}.${i}`] = { type: 'noul', instructions: { skill: { name: candidate.option.name, ...details[i] }, ...FITS_INSTRUCTIONS[language] } }
  })
  return { part: SKILLS_PART, questions }
}

/**
 * One message as the skills eval (#16) gives it: the person's text, and the
 * conversation before it, oldest first. An eval line `{ role, text, tools }`
 * maps onto `{ role, text, toolUses: tools.map((tool) => ({ tool })) }`.
 */
export type SkillsItem = { message: string; recent_context: readonly ContextMessage[] }

/**
 * The decision request the mod sends when the person sends `item.message`:
 * the shared state, the effort question, then the skills question over
 * `options` (stage one; the `ranker`'s when given), in the ballot's order.
 * `part` reads the skills answers back (`answersFor(part, answers)`, then
 * `ranker.rank` with `request.state`); null when there is no option, and the
 * request then asks about effort alone.
 */
export function skillsRequest(
  item: SkillsItem,
  options: readonly SkillOption[],
  settings: { limits: ContextLimits; ask?: Partial<EffortAsk>; ranker?: Pick<SkillRanker, 'part'> },
): { request: DecisionRequest; part: Part | null } {
  const part = settings.ranker ? settings.ranker.part(options) : skillsPart(options, { language: settings.ask?.language, budget: questionBudget(settings.limits.tokens) })
  const state = turnStartState({ prompt: item.message, messages: item.recent_context, limits: settings.limits })
  const request = mergeParts(state, [turnStartEffortPart(settings.ask), ...(part === null ? [] : [part])])
  return { request, part }
}

/**
 * The options ranked, most relevant first, and the share stage one left on
 * "(none)". Two-stage rankings carry what stage one put forward (`shortlist`,
 * with each skill's share) and, when stage two did not answer, why
 * (`failed`): then `ranked` is empty.
 *
 * Relevance is absolute in a two-stage ranking: the second stage's yes/no
 * fit, each skill judged on its own. In stage one alone (`readSkills`,
 * `choiceRanker`) it is the option's share of the Choice: relative, the shares
 * of all options and "(none)" summing to 1.
 */
export type SkillRanking = {
  ranked: readonly { name: string; relevance: number }[]
  none: number
  shortlist?: readonly { name: string; share: number }[]
  failed?: Failure
}

/**
 * The ranking `skills.which` gives (the part's answers, under its own ids):
 * normalized, since backends round; options the question did not offer are
 * ignored. Null when there is no usable answer.
 */
export function readSkills(answers: Readonly<Record<string, Answer>>, options: readonly SkillOption[]): SkillRanking | null {
  const which = answers[WHICH]
  if (which === undefined || which.type !== 'choice') return null
  const order = new Map(options.map((option, i) => [option.name, i]))
  const offered = Object.entries(which.probabilities).filter(([name]) => order.has(name) || name === NO_SKILL)
  const sum = offered.reduce((total, [, p]) => total + p, 0)
  if (!(sum > 0)) return null
  const ranked = offered
    .filter(([name]) => name !== NO_SKILL)
    .map(([name, p]) => ({ name, relevance: p / sum }))
    .sort((a, b) => b.relevance - a.relevance || (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0))
  return { ranked, none: (which.probabilities[NO_SKILL] ?? 0) / sum }
}

/**
 * Stage two's answers as a ranking of the candidates: relevance is each one's
 * `fits` (yes/no, 0 to 1); the higher first, a tie going to the one `best`
 * gave more, then to the candidates' order. A candidate whose `fits` is
 * missing is left out; null when none came back.
 */
export function readRerank(answers: Readonly<Record<string, Answer>>, candidates: readonly Candidate[]): SkillRanking['ranked'] | null {
  const best = answers[BEST]
  const share = (name: string) => (best?.type === 'choice' ? (best.probabilities[name] ?? 0) : 0)
  const read = candidates.flatMap((candidate, i) => {
    const fit = answers[`${FITS}.${i}`]
    return fit?.type === 'noul' && Number.isFinite(fit.noul) ? [{ name: candidate.option.name, relevance: Math.min(1, Math.max(0, fit.noul)), i }] : []
  })
  if (read.length === 0) return null
  read.sort((a, b) => b.relevance - a.relevance || share(b.name) - share(a.name) || a.i - b.i)
  return read.map(({ name, relevance }) => ({ name, relevance }))
}

/**
 * How a message's skills are ranked: the question the ranker adds to the
 * message's decision request (`part`, stage one), and how its answers become
 * a ranking (`rank`; given the state stage one was asked about, so a second
 * stage can ask about the same).
 */
export type SkillRanker = {
  part: (options: readonly SkillOption[]) => Part | null
  rank: (answers: Readonly<Record<string, Answer>>, options: readonly SkillOption[], asked: RankAsked) => Promise<SkillRanking | null>
}

/** What `rank` is told: the state stage one was asked about, and how long stage two may take (the ranker's own when left out). */
export type RankAsked = { state: State; timeoutMs?: number }

/** #10's ranker, stage one alone: relevance is each option's share of the Choice (`readSkills`). */
export function choiceRanker(ask: { language?: Language } = {}): SkillRanker {
  return {
    part: (options) => skillsPart(options, ask),
    rank: async (answers, options) => readSkills(answers, options),
  }
}

/** What the mod's ranker needs of the host, as closures (each caller builds them over its own `$`, the eval over Node). */
export type SkillRankerIo = {
  /** Sends one decision request within `timeoutMs` (the backend's `ask`, its io bound); never throws. */
  ask: (request: DecisionRequest, timeoutMs: number) => Promise<Asked>
  /** The opening of the skill's SKILL.md (`skillOpening`), or null when there is none to read. */
  opening: (option: SkillOption) => Promise<string | null>
}

/** How the mod's ranker ranks (core/skills.ts `rankingSettings` reads them from the person's options). */
export type RankerSettings = {
  /** The questions' language (the state keeps the person's own words either way). */
  language?: Language
  /** How many of stage one's best stage two re-reads (one `fits` each). */
  shortlist: number
  /** The most stage one's question may take, in estimated tokens (`questionBudget`); unbounded when left out. */
  questionTokens?: number
  /** How long stage two may take, unless `rank` is told less. */
  timeoutMs: number
}

/**
 * Stage one must rate a skill at least this share to be re-read: below it,
 * the message most likely needs no skill, and no second request is sent.
 */
export const SHORTLIST_FLOOR = 0.05
/** Clef answers at most 64 questions a request: stage two asks one per candidate and one Choice. */
export const MAX_SHORTLIST = 63

/**
 * The ranker the mod rates the session's skills with, wherever it does:
 * beside each message (features/skills.ts) and when the main agent calls
 * find_skill (features/find-skill.ts, #12). One entry, so the two always rank
 * alike. It needs `$` (a request of its own, files to read), so it takes
 * closures (`io`), which each caller builds in its own hook.
 *
 * Two stages (#11). `part(options)` is stage one, the question the caller
 * sends (in the message's ballot, or on its own); with its answers,
 * `rank(answers, options, { state, timeoutMs? })` sends stage two about the
 * same state, for the SHORTLIST_FLOOR-passing best `settings.shortlist`.
 *
 * `rank` resolves null when stage one gave no usable answer; a ranking with
 * nothing in `ranked` when nothing passed the floor, or with `failed` when
 * stage two did not answer (nothing is suggested then: its relevance is the
 * only absolute one).
 */
export function modRanker(io: SkillRankerIo, settings: RankerSettings): SkillRanker {
  const language = settings.language ?? 'en'
  const part = (options: readonly SkillOption[]) => skillsPart(options, { language, ...(settings.questionTokens === undefined ? {} : { budget: settings.questionTokens }) })
  const rank = async (answers: Readonly<Record<string, Answer>>, options: readonly SkillOption[], asked: RankAsked): Promise<SkillRanking | null> => {
    const first = readSkills(answers, options)
    if (first === null) return null
    const count = Math.max(1, Math.min(MAX_SHORTLIST, Math.round(settings.shortlist)))
    const shortlist = first.ranked.filter((entry) => entry.relevance >= SHORTLIST_FLOOR).slice(0, count)
    const put = shortlist.map((entry) => ({ name: entry.name, share: entry.relevance }))
    if (shortlist.length === 0) return { ranked: [], none: first.none, shortlist: put }
    const byName = new Map(options.map((option) => [option.name, option]))
    const candidates = await Promise.all(
      shortlist.map(async (entry): Promise<Candidate> => {
        const option = byName.get(entry.name) as SkillOption
        return { option, opening: await io.opening(option).catch(() => null) }
      }),
    )
    const second = rerankPart(candidates, { language }) as Part
    const timeoutMs = Math.floor(asked.timeoutMs ?? settings.timeoutMs)
    const asked2: Asked =
      timeoutMs >= 1 ? await io.ask(mergeParts(asked.state, [second]), timeoutMs) : { ok: false, failure: { kind: 'timeout', detail: 'no time left for the second request' } }
    if (!asked2.ok) return { ranked: [], none: first.none, shortlist: put, failed: asked2.failure }
    const ranked = readRerank(answersFor(second, asked2.answers), candidates)
    if (ranked === null) return { ranked: [], none: first.none, shortlist: put, failed: { kind: 'parse', detail: 'no fits answer' } }
    return { ranked, none: first.none, shortlist: put }
  }
  return { part, rank }
}

/** How many skills to suggest at most, and the least relevance one needs. */
export type SkillPolicy = { max: number; minRelevance: number }

/** A skill picked for the message, with its relevance. */
export type SkillPick = SkillOption & { relevance: number }

/** At most this many skills only the person can start are pointed out for one message. */
export const MAX_HINTS = 2

/**
 * What the message gets: `suggest`, the most relevant skills the main agent
 * can load (at least `minRelevance`, at most `max`); `hint`, the most
 * relevant ones only the person can start (at least `minRelevance`, at most
 * MAX_HINTS), for the status line, never for the main agent.
 */
export function pickSkills(ranking: SkillRanking, options: readonly SkillOption[], policy: SkillPolicy): { suggest: SkillPick[]; hint: SkillPick[] } {
  const byName = new Map(options.map((option) => [option.name, option]))
  const suggest: SkillPick[] = []
  const hint: SkillPick[] = []
  for (const { name, relevance } of ranking.ranked) {
    const option = byName.get(name)
    if (option === undefined || relevance < policy.minRelevance) continue
    if (option.by === 'model' && suggest.length < policy.max) suggest.push({ ...option, relevance })
    if (option.by === 'person' && hint.length < MAX_HINTS) hint.push({ ...option, relevance })
  }
  return { suggest, hint }
}

/**
 * What the main agent reads beside the message: each suggested skill's name,
 * relevance and description; a skill in `described` (shown before in the
 * conversation, or still in the listing) by name and relevance only. Null
 * when nothing is suggested.
 */
export function relevanceBlock(suggest: readonly SkillPick[], described: ReadonlySet<string> = new Set()): string | null {
  if (suggest.length === 0) return null
  const repeats = suggest.some((skill) => described.has(skill.name))
  return [
    '<skill_relevance>',
    'Skills that may fit this message, rated by Dispatch Pilot’s decision model (relevance 0 to 1). Most skills are left out of the skill listing in this session: load one of these with the Skill tool by its exact name if it fits the work, and skip any that does not.',
    ...(repeats ? ['A skill named here without its description has been described already, in the skill listing or beside an earlier message.'] : []),
    ...suggest.map((skill) => {
      const about = described.has(skill.name) || !skill.description ? '' : `: ${skill.description}`
      return `- ${skill.name} (relevance ${skill.relevance.toFixed(2)})${about}`
    }),
    '</skill_relevance>',
  ].join('\n')
}
