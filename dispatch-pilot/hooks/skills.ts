// The skill features (design 5.6): the engine's skill listing folded into one sentence, at most one skill suggested
// beside a message, and find-skill's answer. The questions and their reading follow TypeSafe's skill_suggestion
// cookbook (design 3.4; ADR 0018, 0021). Pure functions: no $ calls. The entry's hooks read and write state and ask.
import { noulOf } from './backend.ts'
import type { AskResult, Answer, Backend, Failure } from './backend.ts'
import { failureText } from './log.ts'
import { estimateTokens } from './statebuild.ts'
import type { Decision } from './log.ts'
import { SKILL_CHOICE, SKILL_GATES, SKILL_NOUL_CRITERIA, SKILL_RERANK, skillFits } from './questions.ts'
import type { Question } from './questions.ts'

export type Skill = { name: string; description: string }

/** What the main agent reads in place of the listing. */
export const LISTING_NOTE =
  "Dispatch Pilot leaves most of this session's skills out of the skill listing. The ones that fit a message may be suggested beside it. For any other skill, load the skill dispatch-pilot:find-skill with the Skill tool, with a few words on the work as its args: it answers with the skills that fit. Then load one of them with the Skill tool by its exact name."

// The cookbook's constants: ACTION_THRESHOLD, NAMED_THRESHOLD, FITS_THRESHOLD, SHORTLIST.
export const ACTION_BAR = 0.3
export const NAMED_BAR = 0.5
export const FITS_BAR = 0.3
export const SHORTLIST = 3
/** Skills per choice question: Drex takes at most 255 options, and its questions carry one more (other). */
export const BATCH = 250
/** The second request is sent only with at least this much of the deadline left. */
export const SECOND_MIN_MS = 500

// The listing. Each skill is a line "- <name>: <description>", or "- <name>" with none; a name runs to the first
// colon followed by a space, so "superpowers:brainstorming" keeps its colon. A line that does not start with "- "
// continues the description above it; a blank line ends it. Entries are recognised by their own shape: the
// preamble is worded differently in a Code Mode session and an ordinary one.

const ENTRY = /^- (.+)$/
const WRAPPER = /<\/?system-reminder>/g

export function parseListing(text: string): Skill[] {
  const out: Skill[] = []
  const seen = new Set<string>()
  let open: Skill | null = null
  for (const raw of text.replace(WRAPPER, '\n').split('\n')) {
    const line = raw.trim()
    if (line === '') {
      open = null
      continue
    }
    const m = ENTRY.exec(line)
    if (m === null) {
      if (open !== null) open.description = open.description === '' ? line : open.description + '\n' + line
      continue
    }
    const body = m[1]!
    const cut = body.indexOf(': ')
    const name = (cut === -1 ? body : body.slice(0, cut)).trim()
    // A skill's name has no space: a bullet in prose ("- Use the exact name") is not an entry.
    if (name === '' || /\s/.test(name) || seen.has(name)) {
      open = null
      continue
    }
    seen.add(name)
    open = { name, description: cut === -1 ? '' : body.slice(cut + 2).trim() }
    out.push(open)
  }
  return out
}

// The source of a skill: what comes before the first colon of its name; a user's or a project's own skill has none.
const sourceOf = (name: string): string => (name.includes(':') ? name.slice(0, name.indexOf(':')) : '')

// By source, each source in listing order (Array.prototype.sort is stable).
function bySource(skills: Skill[]): Skill[] {
  return [...skills].sort((a, b) => {
    const x = sourceOf(a.name)
    const y = sourceOf(b.name)
    return x < y ? -1 : x > y ? 1 : 0
  })
}

// Batches of at most BATCH, as even as they come: a batch of a single skill would be a choice of one.
function batches(skills: Skill[]): Skill[][] {
  if (skills.length === 0) return []
  const count = Math.ceil(skills.length / BATCH)
  const size = Math.ceil(skills.length / count)
  const out: Skill[][] = []
  for (let i = 0; i < skills.length; i += size) out.push(skills.slice(i, i + size))
  return out
}

// A choice over skills, each option its description (null when the listing gives none). Drex's has an option
// other for "none fits"; Jev's has none: its documents answer that with the nouls beside the choice. A Jev choice
// needs 2 to 255 options, so Jev is asked no choice over a single skill (a refused question would fail the whole
// request, the effort's part with it).
function options(skills: Skill[], backend: Backend): Record<string, string | null> {
  const criteria: Record<string, string | null> = {}
  for (const s of skills) criteria[s.name] = s.description === '' ? null : s.description
  if (backend === 'drex') criteria.other = null
  return criteria
}

const choosable = (skills: Skill[], backend: Backend): boolean => backend === 'drex' || skills.length >= 2

const yesNo = (instructions: string): Question => ({ type: 'noul', instructions, criteria: { ...SKILL_NOUL_CRITERIA } })

/** The first request's skill questions: one choice per batch (skill_<n>), and with the gate the four nouls. */
export function stageOne(skills: Skill[], backend: Backend, withGate: boolean): Record<string, Question> {
  const questions: Record<string, Question> = {}
  batches(bySource(skills)).forEach((batch, i) => {
    if (choosable(batch, backend)) questions['skill_' + i] = { type: 'choice', instructions: SKILL_CHOICE, criteria: options(batch, backend) }
  })
  if (withGate) for (const [id, text] of Object.entries(SKILL_GATES)) questions[id] = yesNo(text)
  return questions
}

/** The cookbook's needs_skill: the action answers' mean at ACTION_BAR, or named at NAMED_BAR. One of the three missing: no mean. */
export function wantsSkill(a: { acts?: number; procedure?: number; prose?: number; named?: number }): boolean {
  const acting = a.acts !== undefined && a.procedure !== undefined && a.prose !== undefined && (a.acts + a.procedure + (1 - a.prose)) / 3 >= ACTION_BAR
  return acting || (a.named !== undefined && a.named >= NAMED_BAR)
}

function gateOf(answers: Record<string, Answer>): { acts?: number; procedure?: number; prose?: number; named?: number } {
  return {
    acts: noulOf(answers.acts_on_user_system),
    procedure: noulOf(answers.would_follow_documented_procedure),
    prose: noulOf(answers.prose_suffices),
    named: noulOf(answers.named),
  }
}

/**
 * The SHORTLIST skills the batches gave most, their probabilities taken together; other and unknown names left out.
 * A single candidate is the shortlist whatever the answers (on Jev it was asked no choice).
 */
export function shortlist(skills: Skill[], answers: Record<string, Answer>): Skill[] {
  if (skills.length === 1) return [...skills]
  const p = new Map<string, number>()
  for (const [id, a] of Object.entries(answers)) {
    if (!id.startsWith('skill_') || a.type !== 'choice') continue
    for (const [name, q] of Object.entries(a.probabilities)) if (name !== 'other') p.set(name, q)
  }
  // Ties keep the order the questions listed the skills in.
  return bySource(skills)
    .filter((s) => p.has(s.name))
    .sort((a, b) => p.get(b.name)! - p.get(a.name)!)
    .slice(0, SHORTLIST)
}

/** The second request: which of the shortlist (none on Jev for a shortlist of one), and one fits noul per skill (fits_<i>, in shortlist order). */
export function stageTwo(short: Skill[], backend: Backend): Record<string, Question> {
  const questions: Record<string, Question> = {}
  if (choosable(short, backend)) questions.which = { type: 'choice', instructions: SKILL_RERANK, criteria: options(short, backend) }
  short.forEach((s, i) => {
    questions['fits_' + i] = yesNo(skillFits(s.name, s.description))
  })
  return questions
}

const fitsOf = (short: Skill[], answers: Record<string, Answer>): (number | undefined)[] => short.map((_, i) => noulOf(answers['fits_' + i]))

function bestFit(short: Skill[], answers: Record<string, Answer>): number | undefined {
  const known = fitsOf(short, answers).filter((f): f is number => f !== undefined)
  return known.length === 0 ? undefined : Math.max(...known)
}

/** The suggestion: which's choice, once the best fits reaches FITS_BAR; null for other, or when none fits. A shortlist of one asked no which (Jev): its fits alone decides. */
export function pick(short: Skill[], answers: Record<string, Answer>): Skill | null {
  const best = bestFit(short, answers)
  if (best === undefined || best < FITS_BAR) return null
  const which = answers.which
  if (which === undefined && short.length === 1) return short[0]!
  if (which?.type !== 'choice' || which.choice === 'other') return null
  return short.find((s) => s.name === which.choice) ?? null
}

/** find-skill's answer: every skill whose fits reaches FITS_BAR, best first, at most SHORTLIST. */
export function pickMany(short: Skill[], answers: Record<string, Answer>): Skill[] {
  const fits = fitsOf(short, answers)
  return short
    .map((s, i) => ({ s, f: fits[i] }))
    .filter((x): x is { s: Skill; f: number } => x.f !== undefined && x.f >= FITS_BAR)
    .sort((a, b) => b.f - a.f)
    .slice(0, SHORTLIST)
    .map((x) => x.s)
}

// The sentence beside the message is the cookbook's suggestion_block; the listing is folded, so the skill's
// description and how to load it come with it.
export function suggestionBlock(s: Skill): string {
  const lines = [`Relevant to the current request: ${s.name}. Ignore this if it does not fit what the user actually asked for.`]
  if (s.description !== '') lines.push(`${s.name}: ${s.description}`)
  lines.push(`To use it, load it with the Skill tool by its exact name, ${s.name}.`)
  return lines.join('\n')
}

const FAILURE_EN: Record<Failure, string> = {
  'no-key': 'the decision model has no API key set',
  timeout: 'the decision model did not answer in time',
  http: 'the decision model answered with an error',
  network: 'the decision model could not be reached',
  'bad-answer': "the decision model's answer was incomplete",
  'model-mismatch': 'the decision model answered from another version than the one pinned',
}

export function findSkillReply(query: string, found: Skill[], failure: Failure | null): string {
  if (query === '') return 'find-skill needs a few words on the work as its args, such as "fill in a form in a PDF file". Load it again with them.'
  if (failure !== null) return searchFailedReply(query, failure, [])
  if (found.length === 0) return `No skill in this session fits "${query}". Go on without one.`
  const lines = found.map((s) => (s.description === '' ? '- ' + s.name : '- ' + s.name + ': ' + s.description))
  return [`Skills that fit "${query}", best first:`, ...lines, 'Load one with the Skill tool by its exact name.'].join('\n')
}

/** The most find-skill's reply weighs (estimateTokens) when it lists the candidates because its search did not run. */
export const SEARCH_FAILED_BUDGET = 6000
/** A description is cut no shorter than this share; below it, names only. */
const MIN_SHARE = 8

const entryLine = (s: Skill, description: string): string => (description === '' ? '- ' + s.name : '- ' + s.name + ': ' + description)

// The head of a description within `tokens` (an ellipsis after it), the start being what says what a skill is for.
function cutDescription(text: string, tokens: number): string {
  if (estimateTokens(text) <= tokens) return text
  const chars = Array.from(text)
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (estimateTokens(chars.slice(0, mid).join('') + '…') <= tokens) lo = mid
    else hi = mid - 1
  }
  return lo === 0 ? '' : chars.slice(0, lo).join('').trimEnd() + '…'
}

/**
 * find-skill's answer when its search did not run (final review I4b): it says so, then lists the candidates the
 * session's listings named, so the agent is never worse off than with the listing the mod folded. Within
 * SEARCH_FAILED_BUDGET: the descriptions whole, else each cut to an even share, else names only, else the first names
 * that fit and how many there are.
 */
export function searchFailedReply(query: string, failure: Failure, skills: readonly Skill[]): string {
  const lead = `The skill search for "${query}" did not run: ${FAILURE_EN[failure]}. Nothing is known about which skills fit.`
  if (skills.length === 0) return `${lead} Go on without one, or load a skill you already know by its exact name.`
  const head = (note: string): string => `${lead} These are the skills this session's listing named${note}: if one fits the work, load it with the Skill tool by its exact name, else go on without one.`
  const reply = (note: string, lines: readonly string[]): string => [head(note), ...lines].join('\n')
  const whole = reply('', skills.map((s) => entryLine(s, s.description)))
  if (estimateTokens(whole) <= SEARCH_FAILED_BUDGET) return whole
  const names = skills.map((s) => entryLine(s, ''))
  const SHORT = ' (descriptions shortened)'
  let share = Math.floor((SEARCH_FAILED_BUDGET - estimateTokens(reply(SHORT, names))) / skills.length)
  while (share >= MIN_SHARE) {
    const cut = reply(SHORT, skills.map((s) => entryLine(s, cutDescription(s.description, share))))
    if (estimateTokens(cut) <= SEARCH_FAILED_BUDGET) return cut
    share = Math.floor(share * 0.9)
  }
  const bare = reply(' (names only: their descriptions do not fit)', names)
  if (estimateTokens(bare) <= SEARCH_FAILED_BUDGET) return bare
  // Even the names do not fit: the first that do. Each line's estimate plus its line break bounds the whole from above.
  const note = (k: number): string => ` (names only, the first ${k} of ${skills.length})`
  let used = estimateTokens(head(note(skills.length)))
  const kept: string[] = []
  for (const line of names) {
    used += estimateTokens(line) + 1
    if (used > SEARCH_FAILED_BUDGET) break
    kept.push(line)
  }
  return reply(note(kept.length), kept)
}

/** find-skill's answer when no listing has been folded in this session (no key, or none arrived yet). */
export const NO_CANDIDATES_REPLY =
  "Dispatch Pilot has recorded no skills in this session, so find-skill has nothing to search. Use the session's own skill listing: load a skill from it with the Skill tool by its exact name."

/** find-skill's answer while the mod is off, its skills switch is off, or it runs in shadow: the listing was left whole. */
export const SEARCH_OFF_REPLY =
  "The skill search is turned off in Dispatch Pilot. Use the session's own skill listing: load a skill from it with the Skill tool by its exact name."

/** find-skill's query: what follows the first "Query: " in the skill's text (SKILL.md's one line), else the whole text. */
export function queryOf(text: string): string {
  const at = text.indexOf('Query: ')
  return (at === -1 ? text : text.slice(at + 'Query: '.length)).trim()
}

/**
 * The skill.prompt that is this mod's find-skill. How the engine names a plugin skill there (bare or
 * "dispatch-pilot:find-skill") is not measured yet (Task 17): this one line is where to change it.
 */
export function isFindSkill(e: { skill: string; pluginName?: string }): boolean {
  return e.pluginName === 'dispatch-pilot' && /(^|:)find-skill$/.test(e.skill)
}

// How this mod's own find-skill can appear in a listing; it is never a candidate.
const OWN = ['find-skill', 'dispatch-pilot:find-skill']

/**
 * The candidates after a main-loop listing. The engine sends the listing as a delta (measured on 2.1.327: 169 entries,
 * then a listing of the one skill added mid-session), so the held ones are kept: an entry of the listing replaces the
 * held one of the same name in place, new names are appended in listing order. This mod's find-skill is left out.
 */
export function mergeSkills(held: readonly Skill[], listed: readonly Skill[]): Skill[] {
  const out = held.filter((s) => !OWN.includes(s.name))
  for (const s of listed) {
    if (OWN.includes(s.name)) continue
    const at = out.findIndex((h) => h.name === s.name)
    if (at === -1) out.push(s)
    else out[at] = s
  }
  return out
}

// The reading of a message's two requests, and the Decision they make.

const fmt = (p: number | undefined): string => (p === undefined ? '—' : p.toFixed(2))

/** After the first request: the shortlist to ask the second about, or why there is none (for the Decision). */
export function readStageOne(skills: Skill[], r: AskResult, withGate: boolean): { short: Skill[] } | { detail: string } {
  if (!r.ok) return { detail: failureText(r) }
  // A single candidate needs no choice answer (shortlist takes it as it is).
  if (skills.length > 1 && !Object.keys(r.answers).some((id) => id.startsWith('skill_'))) return { detail: 'skill 题的回答缺题或类型不对' }
  if (withGate) {
    const g = gateOf(r.answers)
    if (!wantsSkill(g)) {
      const mean = g.acts !== undefined && g.procedure !== undefined && g.prose !== undefined ? (g.acts + g.procedure + (1 - g.prose)) / 3 : undefined
      return { detail: `不需要 skill：动手题平均 ${fmt(mean)}，点名题 ${fmt(g.named)}（分别低于 ${fmt(ACTION_BAR)}、${fmt(NAMED_BAR)}）` }
    }
  }
  const short = shortlist(skills, r.answers)
  return short.length === 0 ? { detail: '第一次请求没有选出候选' } : { short }
}

/** After the second request: the suggestion, or why there is none. */
export function readStageTwo(short: Skill[], r: AskResult): { skill: Skill | null; detail: string } {
  if (!r.ok) return { skill: null, detail: failureText(r) }
  const skill = pick(short, r.answers)
  if (skill !== null) return { skill, detail: '' }
  const best = bestFit(short, r.answers)
  if (best === undefined || best < FITS_BAR) return { skill: null, detail: `最合适的 fits 只有 ${fmt(best)}，低于 ${fmt(FITS_BAR)}` }
  return { skill: null, detail: r.answers.which?.type === 'choice' && r.answers.which.choice === 'other' ? '第二次请求选了 other' : '第二次请求选的不在候选里' }
}

export const SECOND_LATE = `剩下的时间不足 ${SECOND_MIN_MS} ms，没有发第二次请求`

/** A message's skill judgement: the first request (and the ids of its skill questions), the second if sent, the outcome. */
export type SkillOutcome = { first: AskResult; asked: string[]; second: AskResult | null; skill: Skill | null; detail: string }

/** Of a choice answer's options, how many of the likeliest a Decision keeps (beside the one picked). */
const RAW_TOP = 5

// What a person can read of one answer (final review G2): a yes-or-no answer whole; a choice's pick and its RAW_TOP
// likeliest options, likeliest first (a real listing gives each choice about 170 options, some 7 KB a Decision).
function readable(a: Answer): Answer {
  if (a.type !== 'choice') return a
  const ranked = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])
  const kept = ranked.slice(0, RAW_TOP)
  const picked = ranked.find(([k]) => k === a.choice)
  if (picked !== undefined && !kept.some(([k]) => k === a.choice)) kept.push(picked)
  return { type: 'choice', choice: a.choice, probabilities: Object.fromEntries(kept) }
}

/** The Decision of kind skill: to is the suggested skill's name; raw the skill answers of both requests, made readable. */
export function skillDecision(o: SkillOutcome, c: { id: string; at: number; turnId: string | null; applied: boolean }): Decision {
  const raw: Record<string, Answer> = {}
  if (o.first.ok) for (const id of o.asked) if (o.first.answers[id] !== undefined) raw[id] = readable(o.first.answers[id]!)
  if (o.second?.ok) for (const [id, a] of Object.entries(o.second.answers)) raw[id] = readable(a)
  const failed = !o.first.ok ? o.first : o.second !== null && !o.second.ok ? o.second : null
  const last = o.second ?? o.first
  const model = last.ok ? last.model : o.first.ok ? o.first.model : null
  return {
    id: c.id,
    at: c.at,
    kind: 'skill',
    backend: last.backend,
    model,
    ms: o.first.ms + (o.second?.ms ?? 0),
    raw: Object.keys(raw).length === 0 ? null : raw,
    from: null,
    to: o.skill?.name ?? null,
    reason: null,
    detail: o.detail,
    turnId: c.turnId,
    step: 0,
    bars: null,
    failure: failed === null ? null : failed.reason,
    requestId: failed === null ? null : (failed.requestId ?? null),
    applied: c.applied,
    sent: null,
  }
}
