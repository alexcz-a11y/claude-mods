// The skill profiles the skills tests write (both languages, the wording named after the skill) and the form the decision model is
// offered them in. Not a test file.

import type { SkillProfile } from '../../hooks/decision/skills.ts'

/** The profile of a skill, in English and in Chinese, each field naming the skill. */
export function profileOf(name: string): SkillProfile {
  return {
    en: { what: `${name}: what it does`, use_when: `${name}: when to use it`, not_for: `${name}: when not to` },
    zh: { what: `${name}：用途`, use_when: `${name}：何时用`, not_for: `${name}：何时不用` },
  }
}

/** What the decision model is offered of the skill: the English fields beside the Chinese ones. */
export function offered(name: string) {
  const { en, zh } = profileOf(name)
  return { what: en.what, use_when: en.use_when, not_for: en.not_for, 用途: zh.what, 何时用: zh.use_when, 何时不用: zh.not_for }
}
