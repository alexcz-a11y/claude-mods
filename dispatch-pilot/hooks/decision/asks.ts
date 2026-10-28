// What the person's message asks of the work beyond the work itself (ADR 0016): that the assistant only go on with what it
// offered (`confirm`: "ok, do it", "continue", "选 2"), or that it think harder (`escalate`: "think it through carefully",
// "仔细一点", "use the strongest model"). Two yes/no questions (Nouls) in the main agent's effort part, asked of the
// person's own words only, as the questions about the unresolved problem are; decision/message-effort.ts turns them into
// floors: confirm yes keeps at least the effort of the person's previous turn (the work it approves is the one that turn set
// out), escalate yes goes to xhigh at least, as `ultrathink` does. A message that only approves is never read as the problem
// solved: `solved` says so in its own criteria (decision/unresolved.ts), and neither question moves the unresolved count.
//
// Pure (see system-one.ts).

import type { Language } from './effort.ts'
import type { Question } from './system-one.ts'

/** The questions' ids inside the effort part: `effort.confirm`, `effort.escalate`. */
export const CONFIRM = 'confirm'
export const ESCALATE = 'escalate'
export const ASKS = [CONFIRM, ESCALATE] as const
export type Ask = (typeof ASKS)[number]

type Words = { question: string; reads: string; yes: string; no: string }

/** Each question's words: one judgment, true meaning yes, true and false as concrete situations (TypeSafe's guide). */
const WORDS: Record<Language, Record<Ask, Words>> = {
  en: {
    [CONFIRM]: {
      question: 'Does `user_message` only agree to, continue, or pick from what the assistant offered at the end of `recent_context`, asking for nothing new?',
      reads: 'Judge from `user_message` and the end of `recent_context`.',
      yes: 'The person only says to go ahead with what the assistant proposed or asked about, with no new request: "ok, do it", "continue", "go ahead", "yes, the first one", "选 2", "继续".',
      no: 'The person asks for something new, reports a problem or a result, or changes what should be done; or the end of `recent_context` offers nothing to agree to.',
    },
    [ESCALATE]: {
      question: 'Does `user_message` ask the assistant to think harder, work more carefully, or use a stronger model?',
      reads: 'Judge from `user_message` only.',
      yes: 'The person asks for more thought or care in the work, or for a stronger model: "think it through carefully", "take your time and get it right", "仔细一点", "认真想想再改", "use the strongest model".',
      no: 'The person asks for the work without saying how hard to think or which model to use, or asks for less: "quick answer", "just do it".',
    },
  },
  zh: {
    [CONFIRM]: {
      question: '`user_message` 是否只是同意、让继续，或从 `recent_context` 末尾助手给出的选项里选一个，没有提新的要求？',
      reads: '根据 `user_message` 和 `recent_context` 的末尾判断。',
      yes: '用户只是让助手照它提出或问到的去做，没有新的要求：「好，就这么做」「继续」「可以」「选 2」「go ahead」。',
      no: '用户提了新的要求、报告了问题或结果，或者改了要做的事；或者 `recent_context` 的末尾没有可以同意的东西。',
    },
    [ESCALATE]: {
      question: '`user_message` 是否要求助手多想一想、做得更仔细，或者用更强的模型？',
      reads: '只根据 `user_message` 判断。',
      yes: '用户要求在这件事上多想、更仔细，或者用更强的模型：「仔细一点」「认真想想再改」「别着急，想清楚」「用最强的模型」「think it through carefully」。',
      no: '用户只提了要做的事，没说要想多深、用哪个模型，或者要求简单快速：「快速回答一下」「直接改就行」。',
    },
  },
}

/** The two questions, by id, asked in `language`. */
export function askQuestions(language: Language): Record<Ask, Question> {
  const key = language === 'zh' ? { question: '问题', reads: '依据' } : { question: 'question', reads: 'reads' }
  return Object.fromEntries(
    ASKS.map((id) => {
      const words = WORDS[language][id]
      return [id, { type: 'noul', instructions: { [key.question]: words.question, [key.reads]: words.reads }, criteria: { true: words.yes, false: words.no } }]
    }),
  ) as Record<Ask, Question>
}
