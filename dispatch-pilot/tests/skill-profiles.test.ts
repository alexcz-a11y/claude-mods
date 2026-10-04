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

/** The criterion the first stage offers a skill by. */
async function criterionOf(w: ReturnType<typeof world>, name: string, message: string): Promise<unknown> {
  await w.submit(message)
  return w.requests.at(-1)?.body.questions['skills.which']?.criteria[name]
}

test('a later session finds the profiles in the store and writes none again; an edited SKILL.md gets a new profile, the others stay', { options: KEY }, async ($, on) => {
  const disk = files()
  const w = world($, on, { backend: rates({ '(none)': 1 }), skills: SKILLS, disk, store: {}, session: true, model: writer() })
  await w.start()
  await w.clock.settle()
  expect(w.completions).toHaveLength(3)

  // The next session (the same store): every profile is there.
  await w.start()
  await w.clock.settle()
  expect(w.completions).toHaveLength(3)
  expect(await criterionOf(w, 'tdd', '先写一个失败的测试')).toEqual(offered('tdd'))

  // tdd's SKILL.md changes: until its new profile is written it is offered by its description; then by the new one.
  disk[TDD_FILE] = `${disk[TDD_FILE]}\nAlso: name each test after the behaviour it checks.\n`
  await w.start()
  expect(await criterionOf(w, 'tdd', '再写一个失败的测试')).toBe(TDD_DESCRIPTION)
  await w.clock.settle()
  expect(w.completions.slice(3).map(skillOf)).toEqual(['tdd'])
  expect(w.completions[3]?.prompt).toContain('name each test after the behaviour it checks')
  expect(await criterionOf(w, 'tdd', '第三个失败的测试')).toEqual(offered('tdd'))
  expect(await criterionOf(w, 'code-review', '第四个')).toEqual(offered('code-review'))
})

test('a profile that cannot be written leaves its skill offered by its description, and is tried again at the next session start', { options: KEY }, async ($, on) => {
  let replies: Record<string, Completion> = {
    tdd: { text: 'Sorry, I cannot help with that.' },
    'code-review': { fails: 'empty-reply' },
  }
  const w = world($, on, { backend: rates({ '(none)': 1 }), skills: SKILLS, disk: files(), store: {}, session: true, model: (request) => writer(replies)(request) })
  await w.start()
  await w.clock.settle()
  // Each skill is asked once; the two that came back without a profile are skipped, the third is written.
  expect(w.completions.map(skillOf)).toEqual(['tdd', 'code-review', 'anthropic-skills:computer-use'])
  expect(await criterionOf(w, 'tdd', '先写一个失败的测试')).toBe(TDD_DESCRIPTION)
  expect(await criterionOf(w, 'code-review', '审一下')).toBe(REVIEW_DESCRIPTION)
  expect(await criterionOf(w, 'anthropic-skills:computer-use', '打开备忘录')).toEqual(offered('anthropic-skills:computer-use'))
  expect(w.logs.map((log) => log.text)).toContain('skill profiles: the reply for tdd is not a profile (0 ms): "Sorry, I cannot help with that."')

  replies = {}
  await w.start()
  await w.clock.settle()
  expect(w.completions.slice(3).map(skillOf)).toEqual(['tdd', 'code-review'])
  expect(await criterionOf(w, 'tdd', '再写一个失败的测试')).toEqual(offered('tdd'))
})

test('an API error or a model the engine refuses stops the writing for the session: the skills keep their descriptions, nothing waits', { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: rates({ '(none)': 1 }),
    skills: SKILLS,
    disk: files(),
    store: {},
    session: true,
    model: (_request, n) => (n === 1 ? { fails: 'api-error' } : n === 2 ? { reject: 'model claude-nonexistent is not available' } : { text: JSON.stringify(profileOf('tdd')) }),
  })
  await w.start()
  await w.clock.settle()
  expect(w.completions).toHaveLength(1)
  expect(w.logs.map((log) => log.text)).toContain('skill profiles: no profile for tdd (an API error, HTTP 529 overloaded, 0 ms); no more profiles are written this session')

  await w.start()
  await w.clock.settle()
  expect(w.completions).toHaveLength(2)
  expect(w.logs.at(-1)?.text).toMatch(/^skill profiles: haiku was refused \(.*model claude-nonexistent is not available\); no more profiles are written this session$/)
  expect(await criterionOf(w, 'tdd', '先写一个失败的测试')).toBe(TDD_DESCRIPTION)
})
