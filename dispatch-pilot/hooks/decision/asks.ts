// What the person's message asks of the work beyond the work itself (ADR 0016): that the assistant only go on with the work
// it set out or is in the middle of (`confirm`: "ok, do it", "continue", "选 2"; not an answer about one detail or one
// small step, such as "blue" or a yes to "delete the old file too?", which starts a small piece of work of its own: 0.16.0,
// measured on effortless's judge cases, runs/effortless-bench-2026-11-17), or that it think harder (`escalate`: "think it through carefully",
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
      question: 'Does `user_message` only tell the assistant to go on with the work it set out or is in the middle of at the end of `recent_context`, asking for nothing new?',
      reads: 'Judge from `user_message` and the end of `recent_context`.',
      yes: 'The person only approves a plan or a piece of work the assistant proposed, picks one of the ways it proposed to do that work, or tells it to carry on with work under way, with no new request: "ok, do it", "continue", "go ahead", "yes, all of it", "next", "选 2", "继续".',
      no: 'The person asks for something new, reports a problem or a result, or changes what should be done; or the person only answers a question about one detail or one small step (which name, colour or value to use, whether to also do one small thing): "blue", "info", a yes or no to "Should I delete the old file too?"; or the end of `recent_context` offers nothing to agree to.',
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
      question: '`user_message` 是否只是让助手把 `recent_context` 末尾它提出的、或正在做的那项工作做下去，没有提新的要求？',
      reads: '根据 `user_message` 和 `recent_context` 的末尾判断。',
      yes: '用户只是同意助手提出的方案或一项工作，从它给出的几种做法里选一种，或者让它把正在做的事接着做，没有新的要求：「好，就这么做」「继续」「可以，全都做」「下一个」「选 2」「go ahead」。',
      no: '用户提了新的要求、报告了问题或结果，或者改了要做的事；或者用户只是回答一个关于某个细节或某一小步的问题（用哪个名字、颜色或取值，要不要顺手再做一件小事）：「蓝色」「info」，对「旧文件也删掉吗？」答是或否；或者 `recent_context` 的末尾没有可以同意的东西。',
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
