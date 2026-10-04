// Skill profiles (#11): a cheap model writes each skill a bilingual profile
// (what it does, when to use it, when not to) from its SKILL.md, once per
// version of the file; the profiles are kept in the store and offered to the
// decision model in place of the bare descriptions. Seam 1: engine events in;
// what reaches the cheap model, the store, the decision model out.

import type { ModelCompleteRequest } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { rates, world, type Completion, type SkillsWorld } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }

const TDD_DESCRIPTION = 'Test-driven development. Use when the user wants to build features or fix bugs test-first.'
const REVIEW_DESCRIPTION = 'Review the changes since a fixed point along two axes: Standards and Spec.'
const COMPUTER_DESCRIPTION = 'Read this skill before the first step of any request to do something in an app on the person’s own computer.'

// tdd and code-review are the person's own (SKILL.md under ~/.claude/skills);
// computer-use is a synced one whose file is not on this disk.
const SKILLS: SkillsWorld = {
  commands: [
    { name: 'tdd', description: TDD_DESCRIPTION, source: 'user' },
    { name: 'code-review', description: REVIEW_DESCRIPTION, source: 'user' },
    { name: 'computer-use', description: COMPUTER_DESCRIPTION, source: 'user' },
  ],
  listed: [
    { name: 'tdd', source: 'userSettings', tokens: 52 },
    { name: 'code-review', source: 'userSettings', tokens: 144 },
    { name: 'computer-use', source: 'syncedSkills', tokens: 322 },
  ],
}
const TDD_FILE = '/home/u/.claude/skills/tdd/SKILL.md'
const REVIEW_FILE = '/home/u/.claude/skills/code-review/SKILL.md'
const files = (): Record<string, string> => ({
  [TDD_FILE]: `---\nname: tdd\ndescription: ${TDD_DESCRIPTION}\n---\n\n# Test-Driven Development\n\nWrite one failing test, then only the code that makes it pass.\n`,
  [REVIEW_FILE]: `---\nname: code-review\ndescription: ${REVIEW_DESCRIPTION}\n---\n\n# Code review\n\nReview the diff against the repo's standards, then against the issue.\n`,
})

/** A profile whose every field names its skill, so a test can tell whose it is. */
function profileOf(name: string) {
  return {
    en: { what: `${name}: what it does`, use_when: `${name}: when to use it`, not_for: `${name}: when not to` },
    zh: { what: `${name}：用途`, use_when: `${name}：何时用`, not_for: `${name}：何时不用` },
  }
}

/** The skill a profile completion is about, as its prompt names it. */
function skillOf(request: ModelCompleteRequest): string {
  return /^Skill name: (\S+)$/m.exec(request.prompt)?.[1] ?? '?'
}

/** The cheap model: each skill's profile as JSON, unless `special` says otherwise for that skill. */
function writer(special: Record<string, Completion> = {}) {
  return (request: ModelCompleteRequest): Completion => special[skillOf(request)] ?? { text: JSON.stringify(profileOf(skillOf(request))) }
}

/** What a skill with a profile is offered as, in the first stage's Choice. */
function offered(name: string) {
  const { en, zh } = profileOf(name)
  return { what: en.what, use_when: en.use_when, not_for: en.not_for, 用途: zh.what, 何时用: zh.use_when, 何时不用: zh.not_for }
}

test('at session start the cheap model writes a profile of each skill from its SKILL.md, and the next message offers the skills by their profiles', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ '(none)': 1 }), skills: SKILLS, disk: files(), store: {}, session: true, model: writer() })
  await w.start()
  await w.clock.settle()

  // One completion per skill, on the cheap model: from its SKILL.md, or from its description when there is no file.
  expect(w.completions.map(skillOf)).toEqual(['tdd', 'code-review', 'anthropic-skills:computer-use'])
  expect(w.completions.map((request) => request.model)).toEqual(['haiku', 'haiku', 'haiku'])
  expect(w.completions[0]?.prompt).toContain('Write one failing test, then only the code that makes it pass.')
  expect(w.completions[2]?.prompt).toContain(COMPUTER_DESCRIPTION)

  await w.submit('先写一个失败的测试')
  const which = w.requests[0]?.body.questions['skills.which']
  expect(which.criteria).toEqual({
    tdd: offered('tdd'),
    'code-review': offered('code-review'),
    'anthropic-skills:computer-use': offered('anthropic-skills:computer-use'),
    '(none)': 'None of these skills fits: the request is ordinary work that no listed skill is specifically about.',
  })
})
