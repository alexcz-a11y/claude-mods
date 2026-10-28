// The person's lasting rules for the work (ADR 0014; GLOSSARY 长期约束): the question that catches one as the person says it,
// and what is kept of it. A rule said forty turns ago ("this is real money", "never touch the prod database") is out of the
// state's reach by now; caught when it is said, it is kept in the person's own words and goes into every later request
// (`standing_constraints`), where the stakes questions read it. TypeSafe's memory cookbook does the same: a Noul decides
// what is worth keeping, the code keeps it, and the questions never have to find it in the conversation.
//
// What is kept is verbatim: the person's message and the last paragraph of the assistant's message just before it (a
// rule like "same for this one, don't touch it" needs what "this one" was), both masked and clipped. Nothing a model wrote
// about it, which could carry a misreading along with it.
//
// Pure (see system-one.ts).

import { clipToTokens, said, withoutReminders } from './context.ts'
import type { Language } from './effort.ts'
import { redactSecrets } from './redact.ts'
import type { Question } from './system-one.ts'

/** The question's id inside the effort part: `effort.constraint`. */
export const CONSTRAINT = 'constraint'
/** The field the kept rules take in a request's state. */
export const CONSTRAINTS_FIELD = 'standing_constraints'

/** One rule kept: what the person said, and the end of what the assistant said just before it ('' when it said nothing). */
export type StandingConstraint = { person_said: string; assistant_before: string }

/** At most this many are kept, the oldest dropped. */
export const MOST_CONSTRAINTS = 5
/** The person's words keep this many tokens at most (their end too), the assistant's paragraph this many. */
const PERSON_TOKENS = 300
const ASSISTANT_TOKENS = 150

const WORDS: Record<Language, { question: string; yes: string; no: string }> = {
  en: {
    question: 'Does `user_message` set a rule for the rest of this work, such as something that must not be touched or cannot be rolled back?',
    yes: 'The person states a lasting rule or limit for the work ahead: something must not be touched or deleted, cannot be rolled back, involves real money or production, or must always or never be done.',
    no: 'The person only asks for this piece of work, without a rule meant to hold for what comes after.',
  },
  zh: {
    question: '`user_message` 是否给接下来的工作定了规矩，比如某处不能碰，或者不能回滚？',
    yes: '用户为之后的工作定下了长期的规矩或限制：某处不能碰、不能删，不能回滚，涉及真钱或生产环境，或者某件事必须一直做或永远不做。',
    no: '用户只要求了这一件事，没有要对之后一直有效的规矩。',
  },
}

/** The question, asked in `language`: one judgment, yes meaning a rule was set. */
export function constraintQuestion(language: Language): Question {
  const words = WORDS[language]
  return { type: 'noul', instructions: words.question, criteria: { true: words.yes, false: words.no } }
}

/** The last paragraph of an assistant's message: its text after the last blank line, else all of it, whitespace collapsed. */
export function lastParagraph(text: string): string {
  const parts = withoutReminders(text).split(/\n\s*\n/).map(said).filter((part) => part !== '')
  return parts.at(-1) ?? ''
}

/** What is kept of a rule: the person's words and the assistant's paragraph before them, masked and clipped. */
export function constraintOf(person: string, assistantBefore: string): StandingConstraint {
  return {
    person_said: clipToTokens(redactSecrets(person).trim(), PERSON_TOKENS, 0.3),
    assistant_before: clipToTokens(redactSecrets(lastParagraph(assistantBefore)), ASSISTANT_TOKENS, 0.5),
  }
}

/** The rules with one more kept: a rule said again is not kept twice; past `MOST_CONSTRAINTS` the oldest goes. */
export function withConstraint(list: readonly StandingConstraint[], added: StandingConstraint): StandingConstraint[] {
  return [...list.filter((one) => one.person_said !== added.person_said), added].slice(-MOST_CONSTRAINTS)
}
