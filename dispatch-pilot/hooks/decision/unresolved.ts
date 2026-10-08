// The unresolved-count question the decision model answers about each message
// of the person's, and how its answer moves the count (#36, #39; GLOSSARY 未解决次数).
//
// Pure (see system-one.ts): the mod and the eval import it as it is. The
// question is one more Choice in the main agent's effort part (`effort.unresolved`),
// so it goes in the effort request and reads that request's state: `user_message`
// and the 24000 tokens of `recent_context`. It is written to TypeSafe's guide for
// Choice (docs/research/typesafe-question-guide.md §2.4): each option is a
// situation, the instructions name the state fields they read and hold the whole
// question, and the options keep one fixed order (guide C5: jev-1.13 leans toward
// the first one, so the order is set here and checked in the eval).
//
// The count is only a basis for the decision model's effort judgment, never a rule
// (ADR 0005): this module says how a reading changes the count, nothing about effort.

import type { Language } from './effort.ts'
import type { Answer, Part, Question } from './system-one.ts'

/** The question's id inside the effort part: `effort.unresolved` in the request. */
export const UNRESOLVED = 'unresolved'

/**
 * What `user_message` says of the problem the person and the assistant were on, in the order the options are asked:
 * the problem is still there, it is solved, or it is another one. The first is the one a lean toward the first
 * option costs least: a count one too high is made up at the next message, a count lost is not (clearing needs
 * more certainty, below).
 */
export const UNRESOLVED_OPTIONS = ['still_unresolved', 'resolved', 'new_or_unrelated'] as const
export type UnresolvedOption = (typeof UNRESOLVED_OPTIONS)[number]

/** The instructions and the option descriptions, in the language the question is asked in. */
const WORDS: Record<Language, { instructions: Readonly<Record<string, string>>; options: Record<UnresolvedOption, string> }> = {
  en: {
    instructions: {
      question: 'What does `user_message` say about the problem the person and the assistant were last working on at the end of `recent_context`?',
      results: 'Only the person\'s own words say whether that problem is solved. What the assistant said about its own work, such as "fixed" or "should work now", is not a result.',
    },
    options: {
      still_unresolved:
        'The person says that what was tried for that problem did not work, or that it still happens: the same error again, the same wrong behaviour, a request to look at the same problem once more, or a pasted error that is the one from before.',
      resolved: 'The person says that problem is solved or accepts the result: it works now, thanks, looks good, or a request to commit, push or wrap up what was done for it.',
      new_or_unrelated:
        'The person turns to a different problem or task, asks something that has nothing to do with that problem, or `recent_context` holds no earlier problem to speak of.',
    },
  },
  zh: {
    instructions: {
      问题: '`user_message` 对 `recent_context` 末尾用户和助手最近在处理的那个问题说了什么？',
      结果: '那个问题解没解决，只看用户自己的话。助手对自己的工作说的“已修复”“应该可以了”不算结果。',
    },
    options: {
      still_unresolved: '用户说为那个问题试过的做法没有用，或者说问题还在：同样的报错又出现了、同样的错误行为、让再看一遍同一个问题，或者贴出的报错就是之前那个。',
      resolved: '用户说那个问题已经解决，或接受了结果：现在好了、谢谢、可以了，或者让提交、推送、收尾。',
      new_or_unrelated: '用户转到另一个问题或任务，问的和那个问题毫无关系，或者 `recent_context` 里没有更早的问题可言。',
    },
  },
}

/** The question, asked in `language`. */
export function unresolvedQuestion(language: Language): Question {
  const { instructions, options } = WORDS[language]
  return { type: 'choice', instructions, criteria: options }
}

/** The effort part with the unresolved question added to it (the part keeps its name: the question goes in the effort request). */
export function withUnresolved(part: Part, language: Language): Part {
  return { ...part, questions: { ...part.questions, [UNRESOLVED]: unresolvedQuestion(language) } }
}

/** The count's field in the state of a request that carries it (beside `problem_summary`); present from the first "still unresolved" on. */
export const COUNT_FIELD = 'unresolved_count'

/**
 * Whether a count calls for the strong hint: it has reached `maxAfter` (the setting; 0 for never). Only a hint (ADR 0005):
 * what it does to the effort is the decision model's to say.
 */
export function givesHint(count: number, maxAfter: number): boolean {
  return maxAfter > 0 && count >= maxAfter
}

/**
 * The strong hint, as one more instruction of an effort question: this work belongs to a problem that several attempts
 * did not solve. It names the situation the question's own descriptions already hold, never a level and never a number
 * (ADR 0005); the decision model weighs it with the rest. The key is in the language of the instructions.
 */
const HINT: Record<Language, { key: string; text: string }> = {
  en: {
    key: 'unsolved',
    text: 'This work belongs to a failure that several earlier attempts have not solved: `unresolved_count` is how many times the person has said it is still not solved, and `problem_summary` (when there is one) and `recent_context` show what was tried.',
  },
  zh: {
    key: '未解决',
    text: '这项工作属于多次尝试都没解决的故障：`unresolved_count` 是用户已经说过“仍未解决”的次数，`problem_summary`（有的话）和对话记着试过什么。',
  },
}

/** The part with the strong hint added to its effort question (`level`: the main agent's at a message, and the mid-turn one). */
export function withHint(part: Part, language: Language): Part {
  const level = part.questions.level
  // The effort questions' instructions are always an object (see effort.ts); anything else is left as it is.
  if (level === undefined || typeof level.instructions !== 'object' || Array.isArray(level.instructions)) return part
  const { key, text } = HINT[language]
  return { ...part, questions: { ...part.questions, level: { ...level, instructions: { ...level.instructions, [key]: text } } } }
}

/** The probability of each option (three numbers summing to 1) and the backend's confidence. */
export type UnresolvedReading = { probabilities: Readonly<Record<UnresolvedOption, number>>; confidence: number | null }

/**
 * The options' probabilities an answer gives, normalized (backends round them). Null when the answer is missing, not a
 * Choice, or puts no probability on any of the three options.
 */
export function readUnresolved(answer: Answer | undefined): UnresolvedReading | null {
  if (answer === undefined || answer.type !== 'choice') return null
  const raw = UNRESOLVED_OPTIONS.map((option) => answer.probabilities[option] ?? 0)
  const sum = raw.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return null
  const [still, resolved, other] = raw.map((p) => p / sum) as [number, number, number]
  return { probabilities: { still_unresolved: still, resolved, new_or_unrelated: other }, confidence: answer.confidence }
}

/**
 * The two bars an answer has to reach (probability of the option, after normalizing). Adding takes less certainty than
 * clearing: a message that was not about the problem costs one count at worst, a clear that was wrong loses the record
 * of several tries (story 9). Their sum is over 1, so one answer never meets both and the order they are checked in
 * decides nothing. Provisional: #6 sets them from the eval's `unresolved` dataset and writes the reason here.
 */
export type UnresolvedThresholds = { add: number; reset: number }
export const UNRESOLVED_THRESHOLDS: UnresolvedThresholds = { add: 0.5, reset: 0.7 }

/** What a reading does to the count: one more, back to nothing, or nothing. */
export type UnresolvedChange = 'add' | 'reset' | 'keep'

/** A reading judged: what it does to the count, the option it leaned to most, and the bars it was held to (the log keeps all of it). */
export type UnresolvedJudgement = {
  change: UnresolvedChange
  top: UnresolvedOption
  probabilities: Readonly<Record<UnresolvedOption, number>>
  confidence: number | null
  thresholds: UnresolvedThresholds
}

/**
 * "Still unresolved" at the lower bar adds one; "resolved" or "new or unrelated", each on its own, at the higher bar
 * clears; any other answer leaves the count as it is. Ties for the top go to the earlier option.
 */
export function judgeUnresolved(reading: UnresolvedReading, thresholds: UnresolvedThresholds = UNRESOLVED_THRESHOLDS): UnresolvedJudgement {
  const p = reading.probabilities
  const top = UNRESOLVED_OPTIONS.reduce((best, option) => (p[option] > p[best] ? option : best), UNRESOLVED_OPTIONS[0])
  const change: UnresolvedChange =
    p.still_unresolved >= thresholds.add ? 'add' : p.resolved >= thresholds.reset || p.new_or_unrelated >= thresholds.reset ? 'reset' : 'keep'
  return { change, top, probabilities: p, confidence: reading.confidence, thresholds }
}

/** The count after a change. */
export function countAfter(count: number, change: UnresolvedChange): number {
  return change === 'add' ? count + 1 : change === 'reset' ? 0 : count
}
