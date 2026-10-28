// How the decision model picks the skill for a message, as TypeSafe's skill suggestion cookbook does it
// (docs.typesafe.ai/cookbooks/skill_suggestion, ADR 0018): two requests, at most one skill.
//
//   stage one  in the message's skills request (the effort question has its own, ADR 0005): a Choice over the skills
//              the main agent can load, each described as it describes itself (`skills.which`; no "none of these"
//              option, the cookbook asks that apart), one over those only the person can start (`skills.hint`), and
//              three yes/no questions on whether the message wants something done rather than explained
//              (`skills.gate.<key>`). Their mean, `prose_suffices` counted the other way round, decides whether to look
//              any further: below the guide's bar nothing is suggested and stage two is not asked.
//   stage two  a request of its own about the same state, for the SHORTLIST skills of each Choice stage one rated
//              highest: each re-read with its description and the opening of its SKILL.md, the same Choice over those
//              (which one), and a yes/no each on whether it does the specific thing asked (`skills.fits.<i>`). The best
//              of those decides whether to say anything at all, the Choice which skill.
//
// find_skill (#12) ranks through the same ranker without the gate (the main agent asked for a skill) and with a shortlist
// of findSkillMax, and returns every candidate whose fit reaches the bar, best first.
//
// `modRanker` is the one entry: the message's suggestion (features/skills.ts), find_skill (features/find-skill.ts) and the
// eval (#16) rank through it. Pure (see system-one.ts): the mod and the eval build the same questions from the same code.
// The questions are the cookbook's words; the bars are each decision model's guide's (decision/guides.ts).

import type { Asked, Failure } from './backend.ts'
import { clipToTokens, estimateTokens, turnStartState, type ContextLimits, type ContextMessage } from './context.ts'
import { fitsBar, type SkillBars } from './guides.ts'
import { redactSecrets } from './redact.ts'
import { answersFor, mergeParts, type Answer, type DecisionRequest, type Part, type Question, type State } from './system-one.ts'

/**
 * A skill the decision model may name. `by` says who can start it: `model`,
 * the main agent with the Skill tool; `person`, only the person by typing
 * `/name` (its SKILL.md sets `disable-model-invocation: true`): such a skill
 * is never suggested to the main agent, the board names it instead (可试 /x).
 * `description` is its own, as the engine lists it.
 */
export type SkillOption = { name: string; description: string; by: 'model' | 'person' }

/** The skills part's name and its questions' ids: `skills.which`, `skills.hint` and `skills.gate.<key>` (stage one), `skills.which`, `skills.hint` and `skills.fits.<i>` (stage two). */
export const SKILLS_PART = 'skills'
export const WHICH = 'which'
export const HINT = 'hint'
export const GATE = 'gate'
export const FITS = 'fits'

/** The cookbook's SHORTLIST: the candidates of each Choice carried from the first request into the second. */
export const SHORTLIST = 3
/** The cookbook's EXCERPT_CHARS: the characters of its SKILL.md each candidate brings to the second request. */
export const EXCERPT_CHARS = 700
/** A Choice takes at most this many options (Jev's limit, and Liquid's). */
export const MAX_CHOICE_OPTIONS = 255

/** The cookbook's CHOICE_INSTRUCTIONS, word for word: the state is `{ user_message, recent_context }`. */
const CHOICE_INSTRUCTIONS = "Which of these skills, if any, is the right one to load to help with the user's latest request?"
/** The same about the skills only the person can start (not in the cookbook): it says who starts them, so a skill is not passed over for being one the model cannot load. */
const HINT_INSTRUCTIONS = "Which of these skills, if any, is the right one to help with the user's latest request? The user starts these skills themselves, by typing their name."

/**
 * The cookbook's GATE_QUESTIONS, word for word: each asks a different way whether the message wants an action taken
 * rather than an explanation given. A yes to `prose_suffices` points away from needing a skill (INVERTED).
 */
export const GATE_QUESTIONS = {
  acts_on_user_system: "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
  would_follow_documented_procedure: 'Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?',
  prose_suffices: "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
} as const
export type GateKey = keyof typeof GATE_QUESTIONS
const GATE_KEYS = Object.keys(GATE_QUESTIONS) as GateKey[]
const INVERTED: ReadonlySet<GateKey> = new Set<GateKey>(['prose_suffices'])

/** The cookbook's RERANK_INSTRUCTIONS, word for word. */
const RERANK_INSTRUCTIONS = "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name."
/** The same about the skills only the person can start. */
const RERANK_HINT_INSTRUCTIONS = "Exactly one of these skills is the right one for the user's latest request; the user starts these skills themselves, by typing their name. Which one? Read what each actually does, not just its name."

/** The cookbook's `fits::{name}` question, word for word (its description left out when the skill has none). */
function fitsInstructions(option: SkillOption): string {
  const asked = `Does the skill '${option.name}' do the specific thing the user's request asks for?`
  const description = option.description.trim()
  return description === '' ? asked : `${asked} It is described as: ${description}`
}

/**
 * The opening of a SKILL.md as stage two reads it: the body after the frontmatter, whitespace collapsed, secrets masked,
 * its first EXCERPT_CHARS characters (the cookbook's `body[:excerpt]`). Empty when the body is.
 */
export function skillOpening(markdown: string): string {
  const frontmatter = /^﻿?---\r?\n[\s\S]*?\r?\n---[^\n]*(?:\r?\n|$)/.exec(markdown)
  const body = (frontmatter ? markdown.slice(frontmatter[0].length) : markdown).replace(/\s+/g, ' ').trim()
  return Array.from(redactSecrets(body)).slice(0, EXCERPT_CHARS).join('')
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
 * The part a message's skills request carries (stage one): `which`, a Choice over the skills the main agent can load
 * (`by: 'model'`), and `hint`, one over those only the person can start (`by: 'person'`), each when it has two options or
 * more (one alone goes to stage two as it is); and, unless `gate` is false (find_skill), the three gate questions. Null
 * when there is nothing to ask.
 */
export function skillsPart(options: readonly SkillOption[], ask: { budget?: number; gate?: boolean } = {}): Part | null {
  const budget = ask.budget ?? Number.POSITIVE_INFINITY
  const loadable = options.filter((option) => option.by === 'model')
  const persons = options.filter((option) => option.by === 'person')
  if (loadable.length + persons.length === 0) return null
  const questions: Record<string, Question> = {}
  if (loadable.length >= 2) questions[WHICH] = skillsChoice(loadable, CHOICE_INSTRUCTIONS, budget)
  if (persons.length >= 2) questions[HINT] = skillsChoice(persons, HINT_INSTRUCTIONS, budget)
  if (ask.gate !== false) for (const key of GATE_KEYS) questions[`${GATE}.${key}`] = { type: 'noul', instructions: GATE_QUESTIONS[key] }
  return Object.keys(questions).length === 0 ? null : { part: SKILLS_PART, questions }
}

/** The most tokens a description is cut to when a Choice's descriptions do not fit whole. */
const DESCRIPTION_TOKENS_MOST = 400

/**
 * One Choice of stage one: `options` in their order (past MAX_CHOICE_OPTIONS the rest are left out), each described by
 * its own description (the cookbook's: "the same text the agent itself gets"). Within `budget` (estimated tokens of the
 * question): past it every description is cut to the same number of tokens, the most that fits (the cookbook's harness
 * cuts its index to 60 characters).
 */
function skillsChoice(options: readonly SkillOption[], instructions: string, budget: number): Question {
  const offered = options.slice(0, MAX_CHOICE_OPTIONS)
  const question = (cap: number | null): Question => ({
    type: 'choice',
    instructions,
    criteria: Object.fromEntries(offered.map((option) => [option.name, describedAs(option.description, cap)])),
  })
  const fits = (asked: Question) => estimateTokens(JSON.stringify(asked)) <= budget
  const whole = question(null)
  if (fits(whole)) return whole
  let low = 1
  let high = DESCRIPTION_TOKENS_MOST
  let best = question(0)
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const cut = question(mid)
    if (fits(cut)) {
      best = cut
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

/** A description as an option's criteria: null when there is none (or `cap` is 0), cut to `cap` tokens when given. */
function describedAs(description: string, cap: number | null): string | null {
  const text = description.trim()
  if (text === '' || cap === 0) return null
  return cap === null ? text : clipToTokens(text, cap)
}

/** A skill stage two re-reads, with the opening of its SKILL.md (null when it could not be read). */
export type Candidate = { option: SkillOption; opening: string | null }

/** What stage two reads of a candidate: its description, then the opening of its SKILL.md (the cookbook's `f"{description_full} — {body[:excerpt]}"`). */
export function candidateText(candidate: Candidate): string | null {
  const description = candidate.option.description.trim()
  const opening = candidate.opening?.trim() ?? ''
  if (description !== '' && opening !== '') return `${description} — ${opening}`
  return description || opening || null
}

/**
 * The part of stage two's request: `which`, the Choice over the candidates the main agent can load, and `hint`, over
 * those only the person can start, each when it has two or more; and `fits.<i>`, a yes/no for each candidate in order.
 * Null for no candidate.
 */
export function stageTwoPart(candidates: readonly Candidate[]): Part | null {
  if (candidates.length === 0) return null
  const choice = (group: readonly Candidate[], instructions: string): Question => ({
    type: 'choice',
    instructions,
    criteria: Object.fromEntries(group.map((candidate) => [candidate.option.name, candidateText(candidate)])),
  })
  const loadable = candidates.filter((candidate) => candidate.option.by === 'model')
  const persons = candidates.filter((candidate) => candidate.option.by === 'person')
  const questions: Record<string, Question> = {}
  if (loadable.length >= 2) questions[WHICH] = choice(loadable, RERANK_INSTRUCTIONS)
  if (persons.length >= 2) questions[HINT] = choice(persons, RERANK_HINT_INSTRUCTIONS)
  candidates.forEach((candidate, i) => {
    questions[`${FITS}.${i}`] = { type: 'noul', instructions: fitsInstructions(candidate.option) }
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
 * The decision request the mod sends about the skills when the person sends `item.message` (stage one, the `ranker`'s
 * questions when given, else a message's with the gate): the shared state and the skills questions over `options`. The
 * main agent's effort is asked in a request of its own (ADR 0005). `part` reads the answers back (`answersFor(part,
 * answers)`, then `ranker.rank` with `request.state`); both are null when there is nothing to ask: no request is sent.
 */
export function skillsRequest(
  item: SkillsItem,
  options: readonly SkillOption[],
  settings: { limits: ContextLimits; ranker?: Pick<SkillRanker, 'part'> },
): { request: DecisionRequest; part: Part } | { request: null; part: null } {
  const part = settings.ranker ? settings.ranker.part(options) : skillsPart(options, { budget: questionBudget(settings.limits.tokens) })
  if (part === null) return { request: null, part: null }
  const state = turnStartState({ prompt: item.message, messages: item.recent_context, limits: settings.limits })
  return { request: mergeParts(state, [part]), part }
}

/** A skill a Choice put forward, with its share of the Choice. */
export type SkillShare = { name: string; share: number }
/** A candidate stage two judged on its own: its "does it do this" answer. */
export type SkillFit = { name: string; fit: number; by: SkillOption['by'] }
/** The gate's three answers (each as answered) and their mean, `prose_suffices` counted the other way round. */
export type GateReading = { mean: number; values: Readonly<Partial<Record<GateKey, number>>> }

/**
 * What the two requests said. `gate`: the gate's reading (null when it was not asked: find_skill). `shortlist` and `hints`:
 * what each Choice of stage one put forward, with its share. `fits`: stage two's answer for each candidate, those the main
 * agent can load first; `winner` and `hintWinner`: whom stage two's Choices picked (the one candidate of its kind when
 * there was one); `shares`: those Choices' shares, for ties. `stopped: 'gate'`: the gate said no, and stage two was not
 * asked. `failed`: stage two did not answer, and nothing is suggested.
 */
export type SkillRanking = {
  gate: GateReading | null
  shortlist: readonly SkillShare[]
  hints: readonly SkillShare[]
  fits: readonly SkillFit[]
  winner: string | null
  hintWinner: string | null
  shares: Readonly<Record<string, number>>
  stopped?: 'gate'
  failed?: Failure
}

/** The gate as answered: each question's value and their mean, `prose_suffices` turned round; null when none came back. */
export function readGate(answers: Readonly<Record<string, Answer>>): GateReading | null {
  const values: Partial<Record<GateKey, number>> = {}
  const oriented: number[] = []
  for (const key of GATE_KEYS) {
    const answer = answers[`${GATE}.${key}`]
    if (answer?.type !== 'noul' || !Number.isFinite(answer.noul)) continue
    const p = Math.min(1, Math.max(0, answer.noul))
    values[key] = p
    oriented.push(INVERTED.has(key) ? 1 - p : p)
  }
  if (oriented.length === 0) return null
  return { mean: oriented.reduce((sum, p) => sum + p, 0) / oriented.length, values }
}

/**
 * The `count` skills a Choice put forward, its highest shares first (normalized, since backends round; a tie goes to
 * the earlier option): every skill when the group has one (no Choice was asked); null when the group has two or more
 * and the Choice has no usable answer.
 */
function putForward(answer: Answer | undefined, group: readonly SkillOption[], count: number): SkillShare[] | null {
  if (group.length === 0) return []
  if (group.length === 1) return [{ name: (group[0] as SkillOption).name, share: 1 }]
  if (answer?.type !== 'choice') return null
  const order = new Map(group.map((option, i) => [option.name, i]))
  const offered = Object.entries(answer.probabilities).filter(([name, p]) => order.has(name) && Number.isFinite(p))
  const sum = offered.reduce((total, [, p]) => total + p, 0)
  if (!(sum > 0)) return null
  return offered
    .map(([name, p]) => ({ name, share: p / sum }))
    .sort((a, b) => b.share - a.share || (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0))
    .slice(0, count)
}

/** Whom a Choice of stage two picked among `group`: its `choice`, else its highest share; the one candidate when there is one; null without an answer. */
function pickedBy(answer: Answer | undefined, group: readonly Candidate[]): string | null {
  if (group.length === 0) return null
  if (group.length === 1) return (group[0] as Candidate).option.name
  if (answer?.type !== 'choice') return null
  const names = new Set(group.map((candidate) => candidate.option.name))
  if (names.has(answer.choice)) return answer.choice
  const best = Object.entries(answer.probabilities)
    .filter(([name]) => names.has(name))
    .reduce<[string, number] | null>((top, entry) => (top === null || entry[1] > top[1] ? entry : top), null)
  return best?.[0] ?? null
}

/**
 * How a message's skills are ranked: the questions the ranker adds to the
 * message's decision request (`part`, stage one), and how their answers
 * become a ranking (`rank`; given the state stage one was asked about, so the
 * second stage can ask about the same).
 */
export type SkillRanker = {
  part: (options: readonly SkillOption[]) => Part | null
  rank: (answers: Readonly<Record<string, Answer>>, options: readonly SkillOption[], asked: RankAsked) => Promise<SkillRanking | null>
}

/** What `rank` is told: the state stage one was asked about, and how long stage two may take (the ranker's own when left out). */
export type RankAsked = { state: State; timeoutMs?: number }

/** What the mod's ranker needs of the host, as closures (each caller builds them over its own `$`, the eval over Node). */
export type SkillRankerIo = {
  /** Sends one decision request within `timeoutMs` (the backend's `ask`, its io bound); never throws. */
  ask: (request: DecisionRequest, timeoutMs: number) => Promise<Asked>
  /** The opening of the skill's SKILL.md (`skillOpening`), or null when there is none to read. */
  opening: (option: SkillOption) => Promise<string | null>
}

/** How the mod's ranker ranks (core/skills.ts `rankingSettings`). */
export type RankerSettings = {
  /** Whether stage one asks the gate and reads it (a message: yes; find_skill: no). */
  gate: boolean
  /** How many skills of each Choice of stage one stage two re-reads (SHORTLIST beside a message, findSkillMax for find_skill). */
  shortlist: number
  /** The most each Choice of stage one may take, in estimated tokens (`questionBudget`); unbounded when left out. */
  questionTokens?: number
  /** How long stage two may take, unless `rank` is told less. */
  timeoutMs: number
  /** The decision model's bars (decision/guides.ts). */
  bars: SkillBars
}

/** A request holds at most 64 questions (system-one.ts MAX_QUESTIONS): stage two asks one per candidate and up to two Choices. */
export const MAX_SHORTLIST = 30

/**
 * The ranker the mod rates the session's skills with, wherever it does: beside each message (features/skills.ts) and when
 * the main agent calls find_skill (features/find-skill.ts, #12). One entry, so the two always rank alike. It needs `$` (a
 * request of its own, files to read), so it takes closures (`io`), which each caller builds in its own hook.
 *
 * `rank` resolves null when stage one gave no usable answer; a ranking with `stopped` when the gate said no, with
 * `failed` when stage two did not answer, else with stage two's answers.
 */
export function modRanker(io: SkillRankerIo, settings: RankerSettings): SkillRanker {
  const part = (options: readonly SkillOption[]) => skillsPart(options, { gate: settings.gate, ...(settings.questionTokens === undefined ? {} : { budget: settings.questionTokens }) })
  const rank = async (answers: Readonly<Record<string, Answer>>, options: readonly SkillOption[], asked: RankAsked): Promise<SkillRanking | null> => {
    const count = Math.max(1, Math.min(MAX_SHORTLIST, Math.round(settings.shortlist)))
    const gate = settings.gate ? readGate(answers) : null
    if (settings.gate && gate === null) return null
    const shortlist = putForward(answers[WHICH], options.filter((option) => option.by === 'model'), count)
    const hints = putForward(answers[HINT], options.filter((option) => option.by === 'person'), count)
    // The gate first: below its bar nothing is suggested, whatever the Choices said.
    if (gate !== null && gate.mean < settings.bars.gateBelow) return { gate, shortlist: shortlist ?? [], hints: hints ?? [], fits: [], winner: null, hintWinner: null, shares: {}, stopped: 'gate' }
    if (shortlist === null || hints === null) return null
    const base: SkillRanking = { gate, shortlist, hints, fits: [], winner: null, hintWinner: null, shares: {} }
    const byName = new Map(options.map((option) => [option.name, option]))
    const picked = [...shortlist, ...hints].flatMap((entry) => byName.get(entry.name) ?? [])
    if (picked.length === 0) return base
    const candidates = await Promise.all(picked.map(async (option): Promise<Candidate> => ({ option, opening: await io.opening(option).catch(() => null) })))
    const second = stageTwoPart(candidates) as Part
    const timeoutMs = Math.floor(asked.timeoutMs ?? settings.timeoutMs)
    const reply: Asked =
      timeoutMs >= 1 ? await io.ask(mergeParts(asked.state, [second]), timeoutMs) : { ok: false, failure: { kind: 'timeout', detail: 'no time left for the second request' } }
    if (!reply.ok) return { ...base, failed: reply.failure }
    const read = answersFor(second, reply.answers)
    const fits = candidates.flatMap((candidate, i): SkillFit[] => {
      const answer = read[`${FITS}.${i}`]
      return answer?.type === 'noul' && Number.isFinite(answer.noul) ? [{ name: candidate.option.name, fit: Math.min(1, Math.max(0, answer.noul)), by: candidate.option.by }] : []
    })
    if (fits.length === 0) return { ...base, failed: { kind: 'parse', detail: 'no fits answer' } }
    const of = (by: SkillOption['by']) => candidates.filter((candidate) => candidate.option.by === by)
    const shares: Record<string, number> = {}
    for (const id of [WHICH, HINT]) {
      const answer = read[id]
      if (answer?.type === 'choice') for (const [name, p] of Object.entries(answer.probabilities)) shares[name] = p
    }
    return { ...base, fits, winner: pickedBy(read[WHICH], of('model')), hintWinner: pickedBy(read[HINT], of('person')), shares }
  }
  return { part, rank }
}

/** A skill picked for the message, with its fit (stage two's "does it do this" answer). */
export type SkillPick = SkillOption & { relevance: number }

/**
 * What the message gets, the cookbook's `suggest()`: `suggest`, the skill stage two's Choice picked among those the main
 * agent can load, when the best fit among them reaches the bar; `hint`, the same of those only the person can start, for
 * the board (可试 /x), never for the main agent. At most one each; none when the gate said no or stage two did not answer.
 */
export function pickSkills(ranking: SkillRanking, options: readonly SkillOption[], bars: SkillBars): { suggest: SkillPick[]; hint: SkillPick[] } {
  if (ranking.stopped !== undefined || ranking.failed !== undefined) return { suggest: [], hint: [] }
  const byName = new Map(options.map((option) => [option.name, option]))
  const pick = (by: SkillOption['by'], winner: string | null): SkillPick[] => {
    const mine = ranking.fits.filter((fit) => fit.by === by)
    if (mine.length === 0 || winner === null) return []
    if (!fitsBar(bars, Math.max(...mine.map((fit) => fit.fit)))) return []
    const option = byName.get(winner)
    const own = mine.find((fit) => fit.name === winner)
    return option === undefined || own === undefined ? [] : [{ ...option, relevance: own.fit }]
  }
  return { suggest: pick('model', ranking.winner), hint: pick('person', ranking.hintWinner) }
}

/** What find_skill returns: every candidate the main agent can load whose fit reaches the bar, the best first (a tie to the one stage two's Choice gave more), at most `max`. */
export function findSkills(ranking: SkillRanking, options: readonly SkillOption[], bars: SkillBars, max: number): SkillPick[] {
  if (ranking.stopped !== undefined || ranking.failed !== undefined) return []
  const byName = new Map(options.map((option) => [option.name, option]))
  return ranking.fits
    .filter((fit) => fit.by === 'model' && fitsBar(bars, fit.fit))
    .map((fit, i) => ({ fit, i }))
    .sort((a, b) => b.fit.fit - a.fit.fit || (ranking.shares[b.fit.name] ?? 0) - (ranking.shares[a.fit.name] ?? 0) || a.i - b.i)
    .slice(0, Math.max(0, max))
    .flatMap(({ fit }) => {
      const option = byName.get(fit.name)
      return option === undefined ? [] : [{ ...option, relevance: fit.fit }]
    })
}

/**
 * What the main agent reads beside the message: the cookbook's `suggestion_block`, word for word, naming the one skill or
 * saying none appears relevant (sending nothing would leave the agent to guess). The cookbook's agent keeps its skill
 * listing, which this mod withholds (ADR 0002): a skill the main agent has not had described in this conversation
 * (`described`: beside an earlier message, or kept in the listing) is described on a line of its own.
 */
export function relevanceBlock(suggest: SkillPick | null, described: ReadonlySet<string> = new Set()): string {
  const body =
    suggest === null
      ? 'No skill in the roster appears relevant to this request.'
      : `Relevant to the current request: ${suggest.name}. Ignore this if it does not fit what the user actually asked for.`
  const about = suggest !== null && !described.has(suggest.name) && suggest.description.trim() !== '' ? [`${suggest.name}: ${suggest.description.trim()}`] : []
  return ['<skill_relevance>', body, ...about, '</skill_relevance>'].join('\n')
}
