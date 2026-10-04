// The skills question the decision model answers when the person sends a
// message, and how its answer becomes the skills suggested.
//
// Pure (see system-one.ts): the mod and the eval (#16) build the same
// question from the same code. Written to TypeSafe's guide for Choice
// (docs/research/typesafe-question-guide.md §2.4, §4.3): every candidate is an
// option described by its own description, and a "(none)" option lets the
// model say no skill fits (jev-pilot measured it: without one the ranking
// always names a skill).

import { turnStartState, type ContextLimits, type ContextMessage } from './context.ts'
import { turnStartEffortPart, type EffortAsk, type Language } from './effort.ts'
import { mergeParts, type Answer, type DecisionRequest, type Part, type Text } from './system-one.ts'

/**
 * A skill the decision model may name. `by` says who can start it: `model`,
 * the main agent with the Skill tool; `person`, only the person by typing
 * `/name` (its SKILL.md sets `disable-model-invocation: true`): such a skill
 * is never suggested to the main agent, the status line names it instead.
 */
export type SkillOption = { name: string; description: string; by: 'model' | 'person' }

/** The skills part's name and its question's id: `skills.which` in the request. */
export const SKILLS_PART = 'skills'
export const WHICH = 'which'
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

/** A Choice takes at most this many options (Jev's limit; Clef's too), "(none)" among them. */
export const MAX_CHOICE_OPTIONS = 255

/**
 * The part a message's decision request carries for the skills: one Choice,
 * `skills.which`, over `options` in their order and then "(none)"; past
 * MAX_CHOICE_OPTIONS - 1 skills, the rest are left out. Null when there is no
 * skill to ask about.
 */
export function skillsPart(options: readonly SkillOption[], ask: { language?: Language } = {}): Part | null {
  if (options.length === 0) return null
  const language = ask.language ?? 'en'
  const criteria: Record<string, Text | null> = {}
  for (const option of options.slice(0, MAX_CHOICE_OPTIONS - 1)) criteria[option.name] = option.description.trim() || null
  criteria[NO_SKILL] = NO_SKILL_CRITERION[language]
  return { part: SKILLS_PART, questions: { [WHICH]: { type: 'choice', instructions: WHICH_INSTRUCTIONS[language], criteria } } }
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
 * `options` (the `ranker`'s, #10's by default), in the ballot's order. `part`
 * reads the skills answers back (`answersFor(part, answers)`, then
 * `ranker.rank`); null when there is no option, and the request then asks
 * about effort alone.
 */
export function skillsRequest(
  item: SkillsItem,
  options: readonly SkillOption[],
  settings: { limits: ContextLimits; ask?: Partial<EffortAsk>; ranker?: SkillRanker },
): { request: DecisionRequest; part: Part | null } {
  const ranker = settings.ranker ?? choiceRanker({ language: settings.ask?.language })
  const part = ranker.part(options)
  const state = turnStartState({ prompt: item.message, messages: item.recent_context, limits: settings.limits })
  const request = mergeParts(state, [turnStartEffortPart(settings.ask), ...(part === null ? [] : [part])])
  return { request, part }
}

/**
 * The options ranked, most relevant first (a tie keeps the options' order),
 * and the relevance left on "(none)". Here relevance is the option's share of
 * the Choice: relative, the shares of all options and "(none)" summing to 1.
 */
export type SkillRanking = { ranked: readonly { name: string; relevance: number }[]; none: number }

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
 * How a message's skills are ranked: the questions the ranker adds to the
 * message's decision request (`part`), and how their answers become a
 * ranking (`rank`, async so a ranker may send a request of its own). The
 * swap point for #11 (bilingual portraits as the options' criteria, then a
 * second request re-reading the top few, its relevance the absolute `fits`
 * Noul instead of #10's Choice share) and for #12 (find_skill ranks the same
 * way). The mod and the eval both go through it.
 */
export type SkillRanker = {
  part: (options: readonly SkillOption[]) => Part | null
  rank: (answers: Readonly<Record<string, Answer>>, options: readonly SkillOption[]) => Promise<SkillRanking | null>
}

/** #10's ranker: one Choice in the message's request (`skillsPart`); relevance is each option's share of it (`readSkills`). */
export function choiceRanker(ask: { language?: Language } = {}): SkillRanker {
  return {
    part: (options) => skillsPart(options, ask),
    rank: async (answers, options) => readSkills(answers, options),
  }
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
