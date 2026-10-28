// The questions about the problem the person and the main agent are on, asked of each of the person's messages, and how
// their answers move the unresolved count (#36, #39; GLOSSARY 未解决次数; ADR 0014).
//
// Pure (see system-one.ts): the mod and the eval import it as it is. Three yes/no questions (Nouls) in the main agent's
// effort part, so they read that request's state: does the message say the earlier attempt failed, does it say the problem
// is solved, does it turn to another task. They were one Choice; a message can say two of them at once ("still broken, and
// also do X"), and TypeSafe's guide asks for a Noul per statement when more than one can be true. Only the person's own
// words count. The code decides what the answers do to the count (here) and to the effort (decision/message-effort.ts, R4 and R5).

import type { Language } from './effort.ts'
import { TYPESAFE_GUIDE, type NoulBars } from './guides.ts'
import { readNoul, verdictOf, type Verdict } from './nouls.ts'
import type { Answer, Part, Question } from './system-one.ts'

/** The questions' ids inside the effort part: `effort.still_failing`, `effort.solved`, `effort.new_task`. */
export const STILL_FAILING = 'still_failing'
export const SOLVED = 'solved'
export const NEW_TASK = 'new_task'
export const UNRESOLVED_OPTIONS = [STILL_FAILING, SOLVED, NEW_TASK] as const
export type UnresolvedOption = (typeof UNRESOLVED_OPTIONS)[number]

type Words = { question: string; yes: string; no: string }

/** The questions' words, in the language they are asked in; `results` is said once, on each. */
const WORDS: Record<Language, { results: string; questions: Record<UnresolvedOption, Words> }> = {
  en: {
    results: 'Only the person\'s own words count. What the assistant said about its own work, such as "fixed" or "should work now", is not a result.',
    questions: {
      [STILL_FAILING]: {
        question: 'Does `user_message` say that what was tried for the problem the person and the assistant were last working on, at the end of `recent_context`, did not work, or that the problem still happens?',
        yes: 'The person says the earlier attempt did not work or the problem is still there: the same error again, the same wrong behaviour, a request to look at the same problem once more, or a pasted error that is the one from before.',
        no: 'The person does not say the earlier attempt failed: they accept it, ask for something else, or `recent_context` holds no earlier problem.',
      },
      [SOLVED]: {
        question: 'Does `user_message` say that the problem the person and the assistant were last working on, at the end of `recent_context`, is solved, or accept the result?',
        yes: 'The person says the problem is solved or accepts the result: it works now, thanks, looks good, or a request to commit, push or wrap up what was done for it.',
        no: 'The person does not say the problem is solved and does not accept a result: they only agree to a plan or tell the assistant to go ahead or continue ("ok, do it", "continue", "选 2"), which is not the problem solved, or they say nothing of it.',
      },
      [NEW_TASK]: {
        question: 'Does `user_message` turn to a different problem or task than the one the person and the assistant were last working on at the end of `recent_context`?',
        yes: 'The person turns to another problem or task, asks something that has nothing to do with that problem, or `recent_context` holds no earlier problem to speak of.',
        no: 'The person stays with the same problem or task.',
      },
    },
  },
  zh: {
    results: '只看用户自己的话。助手对自己的工作说的“已修复”“应该可以了”不算结果。',
    questions: {
      [STILL_FAILING]: {
        question: '`user_message` 是否在说：为 `recent_context` 末尾用户和助手最近在处理的那个问题试过的做法没有用，或者问题还在？',
        yes: '用户说之前的尝试没有用、问题还在：同样的报错又出现了、同样的错误行为、让再看一遍同一个问题，或者贴出的报错就是之前那个。',
        no: '用户没说之前的尝试失败：他接受了结果、要做别的事，或者 `recent_context` 里没有更早的问题。',
      },
      [SOLVED]: {
        question: '`user_message` 是否在说 `recent_context` 末尾用户和助手最近在处理的那个问题已经解决，或接受了结果？',
        yes: '用户说那个问题已经解决，或接受了结果：现在好了、谢谢、可以了，或者让提交、推送、收尾。',
        no: '用户没说问题已经解决，也没接受结果：只是同意某个方案、让助手照做或继续（「好，就这么做」「继续」「选 2」），这不算问题已经解决；或者根本没提这件事。',
      },
      [NEW_TASK]: {
        question: '`user_message` 是否转到了和 `recent_context` 末尾用户和助手最近在处理的问题不同的另一个问题或任务？',
        yes: '用户转到另一个问题或任务，问的和那个问题毫无关系，或者 `recent_context` 里没有更早的问题可言。',
        no: '用户还在说同一个问题或任务。',
      },
    },
  },
}

/** The three questions, by id, asked in `language`. */
export function unresolvedQuestions(language: Language): Record<UnresolvedOption, Question> {
  const { results, questions } = WORDS[language]
  const key = language === 'zh' ? { question: '问题', results: '结果' } : { question: 'question', results: 'results' }
  return Object.fromEntries(
    UNRESOLVED_OPTIONS.map((id) => [id, { type: 'noul', instructions: { [key.question]: questions[id].question, [key.results]: results }, criteria: { true: questions[id].yes, false: questions[id].no } }]),
  ) as Record<UnresolvedOption, Question>
}

/** The effort part with the three questions added to it (the part keeps its name: they go in the effort request). */
export function withUnresolved(part: Part, language: Language): Part {
  return { ...part, questions: { ...part.questions, ...unresolvedQuestions(language) } }
}

/** The count's field in the state of a request that carries it (beside `problem_summary`); present from the first "still failing" on. */
export const COUNT_FIELD = 'unresolved_count'

/** Each question's probability of yes; null where its answer is missing. */
export type UnresolvedReading = { probabilities: Readonly<Record<UnresolvedOption, number | null>> }

/** The three answers among a part's (by the part's own ids). Null when none of them came back. */
export function readUnresolved(answers: Readonly<Record<string, Answer>>): UnresolvedReading | null {
  const probabilities = Object.fromEntries(UNRESOLVED_OPTIONS.map((id) => [id, readNoul(answers[id])])) as Record<UnresolvedOption, number | null>
  return UNRESOLVED_OPTIONS.every((id) => probabilities[id] === null) ? null : { probabilities }
}

/**
 * The bars a Noul is held to: the decision model's guide (decision/guides.ts). `inclusive` false: Liquid's, a probability must
 * pass a bar; absent (a record an earlier version kept) reads as TypeSafe's, on a bar counts.
 */
export type UnresolvedThresholds = { yes: number; no: number; inclusive?: boolean }
/** TypeSafe's bars, Jev's and pplx's. */
export const UNRESOLVED_THRESHOLDS: UnresolvedThresholds = { yes: TYPESAFE_GUIDE.noul.yes, no: TYPESAFE_GUIDE.noul.no, inclusive: true }

/** What a reading does to the count: one more, back to nothing, or nothing. */
export type UnresolvedChange = 'add' | 'reset' | 'keep'

/** A reading judged: what it does to the count, each question's verdict and probability, the bars (the log keeps all of it). */
export type UnresolvedJudgement = {
  change: UnresolvedChange
  verdicts: Readonly<Record<UnresolvedOption, Verdict>>
  probabilities: Readonly<Record<UnresolvedOption, number | null>>
  thresholds: UnresolvedThresholds
}

/**
 * still_failing yes: one more. Else solved yes, or new_task yes with still_failing no: back to nothing. Anything else (the
 * band, or answers missing) leaves the count as it is: a count lost is worse than one left standing for a message. A message
 * that only agrees or goes on (decision/asks.ts `confirm`) moves nothing by itself: `solved`'s criteria say it is no solution.
 * Read at `bars` (TypeSafe's unless given).
 */
export function judgeUnresolved(reading: UnresolvedReading, bars: NoulBars = TYPESAFE_GUIDE.noul): UnresolvedJudgement {
  const verdict = (id: UnresolvedOption): Verdict => {
    const p = reading.probabilities[id]
    return p === null ? 'band' : verdictOf(p, bars)
  }
  const verdicts = { [STILL_FAILING]: verdict(STILL_FAILING), [SOLVED]: verdict(SOLVED), [NEW_TASK]: verdict(NEW_TASK) } as Record<UnresolvedOption, Verdict>
  const change: UnresolvedChange =
    verdicts[STILL_FAILING] === 'yes' ? 'add' : verdicts[SOLVED] === 'yes' || (verdicts[NEW_TASK] === 'yes' && verdicts[STILL_FAILING] === 'no') ? 'reset' : 'keep'
  return { change, verdicts, probabilities: reading.probabilities, thresholds: { yes: bars.yes, no: bars.no, inclusive: bars.inclusive } }
}

/** The count after a change. */
export function countAfter(count: number, change: UnresolvedChange): number {
  return change === 'add' ? count + 1 : change === 'reset' ? 0 : count
}
