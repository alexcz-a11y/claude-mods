// Skills (#10): the main agent's skill listing withheld, and the skills that
// fit each message the person sends suggested beside it. Seam 1: engine
// events in; what reaches the model, the decision backend and the status line
// out.

import { expect, test } from 'claude-code/testing'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import { choiceRanker, pickSkills, readSkills, skillsPart, skillsRequest, type SkillOption } from '../hooks/decision/skills.ts'
import { answersFor } from '../hooks/decision/system-one.ts'
import type { SkillsWorld } from './support/world.ts'
import { jev, world } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }

// What the engine lists for the main agent at the first request of a session.
const LISTING = [
  'The following skills are available for use with the Skill tool:',
  '',
  '- tdd: Test-driven development. Use when the user wants to build features or fix bugs test-first.',
  '- code-review: Review the changes since a fixed point along two axes: Standards and Spec.',
  '- anthropic-skills:computer-use: Read this skill before the first step of any request to do something in an app on the person’s own computer.',
].join('\n')

// A session's skills as Claude Code reports them: the commands the person can
// run, the main agent's listing as the context counts it, the settings, the
// SKILL.md files on disk.
const SKILLS: SkillsWorld = {
  commands: [
    { name: 'tdd', description: 'Test-driven development. Use when the user wants to build features or fix bugs test-first.', source: 'user' },
    { name: 'code-review', description: 'Review the changes since a fixed point along two axes: Standards and Spec.', source: 'user' },
    { name: 'computer-use', description: 'Read this skill before the first step of any request to do something in an app on the person’s own computer.', source: 'user' },
  ],
  listed: [
    { name: 'tdd', source: 'userSettings', tokens: 52 },
    { name: 'code-review', source: 'userSettings', tokens: 144 },
    { name: 'computer-use', source: 'syncedSkills', tokens: 322 },
  ],
}

test("the main agent's skill listing is withheld; a dispatched agent's reaches it as the engine wrote it", { options: KEY }, async ($, on) => {
  const w = world($, on, { skills: SKILLS })
  expect(await w.listing(LISTING)).toEqual({ text: null })
  expect(await w.listing(LISTING, 'a1')).toEqual({ text: LISTING })
})

test('with suggestSkills off, the main agent reads the listing as the engine wrote it', { options: { ...KEY, suggestSkills: false } }, async ($, on) => {
  const w = world($, on, { skills: SKILLS })
  expect(await w.listing(LISTING)).toEqual({ text: LISTING })
})

test('without a TypeSafe key nothing could suggest a skill, so the main agent keeps its listing', async ($, on) => {
  const w = world($, on, { skills: SKILLS })
  expect(await w.listing(LISTING)).toEqual({ text: LISTING })
})

test("a message's one decision request also asks which skill the main agent could load for it, by name and description, or none", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]), skills: SKILLS })
  await w.submit('先写一个失败的测试，再实现登录限流')

  expect(w.requests).toHaveLength(1)
  const questions = w.requests[0]?.body.questions
  expect(Object.keys(questions)).toEqual(['effort.level', 'skills.which'])
  const which = questions['skills.which']
  expect(which.type).toBe('choice')
  // The names the Skill tool takes (a synced skill with its prefix), then "none" last.
  expect(Object.keys(which.criteria)).toEqual(['tdd', 'code-review', 'anthropic-skills:computer-use', '(none)'])
  expect(which.criteria.tdd).toBe('Test-driven development. Use when the user wants to build features or fix bugs test-first.')
  expect(which.criteria['anthropic-skills:computer-use']).toBe('Read this skill before the first step of any request to do something in an app on the person’s own computer.')
  expect(JSON.stringify(which.instructions)).toContain('`user_message`')
})

/** Jev's answer: effort medium, and these shares of the skills question. */
function rates(shares: Record<string, number>) {
  return jev([0, 1, 0, 0, 0], { shares: { 'skills.which': shares } })
}

test('the skills the decision model rates relevant are suggested beside the message, with name, description and relevance', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.62, 'code-review': 0.23, 'anthropic-skills:computer-use': 0.01, '(none)': 0.14 }), skills: SKILLS })
  await w.submit('先写一个失败的测试，再实现登录限流')

  expect(w.prompts[0]?.context).toEqual([
    [
      '<skill_relevance>',
      'Skills that may fit this message, rated by Dispatch Pilot’s decision model (relevance 0 to 1). Most skills are left out of the skill listing in this session: load one of these with the Skill tool by its exact name if it fits the work, and skip any that does not.',
      '- tdd (relevance 0.62): Test-driven development. Use when the user wants to build features or fix bugs test-first.',
      '- code-review (relevance 0.23): Review the changes since a fixed point along two axes: Standards and Spec.',
      '</skill_relevance>',
    ].join('\n'),
  ])
})

test('when no skill fits, nothing is attached to the message', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.05, 'code-review': 0.08, 'anthropic-skills:computer-use': 0.02, '(none)': 0.85 }), skills: SKILLS })
  await w.submit('这个函数为什么返回 undefined？')
  expect(w.requests).toHaveLength(1)
  expect(w.prompts[0]?.context).toBeUndefined()
})

test('skillsMax caps how many skills are suggested, the most relevant first', { options: { ...KEY, skillsMax: 1, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.3, 'code-review': 0.45, 'anthropic-skills:computer-use': 0.2, '(none)': 0.05 }), skills: SKILLS })
  await w.submit('先审一下这个分支，再补测试')
  const block = w.prompts[0]?.context?.[0] ?? ''
  expect(block).toContain('- code-review (relevance 0.45): ')
  expect(block).not.toContain('- tdd')
  expect(block).not.toContain('computer-use')
})

// The same session with two more skills the person can run that the engine
// keeps out of the main agent's listing: grill-me, whose SKILL.md reserves it
// for the person, and claude-handoff, reserved too but switched off in the
// project's local settings. And one of a plugin, reserved for the person.
const WITH_PERSONS: SkillsWorld = {
  ...SKILLS,
  commands: [
    ...(SKILLS.commands ?? []),
    { name: 'grill-me', description: 'Interview the user relentlessly about a plan until every branch is resolved.', source: 'user' },
    { name: 'claude-handoff', description: 'Hand the current conversation off to a fresh background agent.', source: 'user' },
    { name: 'ship:release', description: 'Cut a release: tag, changelog, publish.', source: 'plugin', plugin: 'ship' },
    { name: 'clear', description: 'Clear conversation history and free up context', source: 'builtin' },
  ],
  overrides: { user: { 'claude-handoff': 'on' }, local: { 'claude-handoff': 'off' } },
}
const PERSON_FILES: Record<string, string> = {
  '/home/u/.claude/skills/grill-me/SKILL.md': '---\nname: grill-me\ndescription: Interview the user relentlessly.\ndisable-model-invocation: true\n---\n\nAsk one question at a time.\n',
  '/home/u/.claude/skills/claude-handoff/SKILL.md': '---\nname: claude-handoff\ndisable-model-invocation: true\n---\nHand off.\n',
  '/home/u/.claude/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'ship@acme': [{ scope: 'user', installPath: '/home/u/.claude/plugins/cache/acme/ship/1.0.0' }] } }),
  '/home/u/.claude/plugins/cache/acme/ship/1.0.0/skills/release/SKILL.md': '---\nname: release\ndisable-model-invocation: "true"\n---\nRelease.\n',
}

test('skills only the person can start (disable-model-invocation in their SKILL.md) are asked about too; one switched off in settings is not', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({}), skills: WITH_PERSONS, disk: PERSON_FILES })
  await w.submit('这个方案往死里挑刺')
  const which = w.requests[0]?.body.questions['skills.which']
  expect(Object.keys(which.criteria)).toEqual(['tdd', 'code-review', 'anthropic-skills:computer-use', 'grill-me', 'ship:release', '(none)'])
  expect(which.criteria['grill-me']).toBe('Interview the user relentlessly about a plan until every branch is resolved.')
})

test('a skill only the person can start is never suggested to the main agent: the status line names it for them', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, { backend: rates({ 'grill-me': 0.55, 'code-review': 0.3, '(none)': 0.15 }), skills: WITH_PERSONS, disk: PERSON_FILES })
  await w.submit('这个方案往死里挑刺，问到我答不上来为止')
  await w.step({ index: 0 })

  const block = w.prompts[0]?.context?.[0] ?? ''
  expect(block).toContain('- code-review (relevance 0.30): ')
  expect(block).not.toContain('grill-me')
  expect(w.status()).toBe('dp effort medium | skills code-review | try /grill-me')
})

test('the status line names the skills suggested for the latest message, and none once nothing fits', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => rates(n === 1 ? { tdd: 0.7, '(none)': 0.3 } : { '(none)': 1 })(request), skills: SKILLS })
  await w.submit('先写失败的测试')
  await w.step({ index: 0 })
  expect(w.status()).toBe('dp effort medium | skills tdd')
  await w.submit('这个报错是什么意思？')
  await w.step({ index: 0 })
  expect(w.status()).toBe('dp effort medium')
})

test("a failed decision request suggests nothing, and the last message's skills leave the status line", { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => (n === 1 ? rates({ tdd: 0.7, '(none)': 0.3 })(request) : { status: 503, body: 'overloaded' }), skills: SKILLS })
  await w.submit('先写失败的测试')
  await w.step({ index: 0 })
  expect(w.status()).toBe('dp effort medium | skills tdd')
  await w.submit('然后把限流也加上')
  await w.step({ index: 0, effort: 'xhigh' })

  expect(w.prompts[1]?.context).toBeUndefined()
  expect(w.status()).toBe('dp effort xhigh (not routed) | jev: busy (HTTP 503)')
})

test('an answer that leaves the skills question out suggests nothing, and the effort still goes through', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const effortOnly = (request: Parameters<ReturnType<typeof rates>>[0], n: number) => {
    const reply = rates({ tdd: 0.7, '(none)': 0.3 })(request)
    if (n === 1 || !('body' in reply)) return reply
    const body = reply.body as { answers: Record<string, unknown> }
    return { ...reply, body: { ...body, answers: { 'effort.level': body.answers['effort.level'] } } }
  }
  const w = world($, on, { backend: effortOnly, skills: SKILLS })
  await w.submit('先写失败的测试')
  await w.step({ index: 0 })
  await w.submit('然后把限流也加上')
  await w.step({ index: 0, effort: 'xhigh' })

  expect(w.prompts[1]?.context).toBeUndefined()
  expect(w.status()).toBe('dp effort medium')
})

const TDD_DESCRIPTION = 'Test-driven development. Use when the user wants to build features or fix bugs test-first.'

test('a skill suggested earlier in the conversation is named again without its description', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => rates(n === 1 ? { tdd: 0.6, '(none)': 0.4 } : { tdd: 0.5, 'code-review': 0.3, '(none)': 0.2 })(request), skills: SKILLS })
  await w.submit('先写失败的测试')
  await w.submit('再审一下，补边界情况的测试')

  const second = w.prompts[1]?.context?.[0] ?? ''
  expect(second).toContain('\n- tdd (relevance 0.50)\n')
  expect(second).not.toContain(TDD_DESCRIPTION)
  expect(second).toContain('\n- code-review (relevance 0.30): Review the changes since a fixed point along two axes: Standards and Spec.\n')
})

test('after /compact or /clear, a skill suggested earlier is described again', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.6, '(none)': 0.4 }), skills: SKILLS })
  await w.submit('先写失败的测试')
  await w.compact()
  await w.submit('继续写测试')
  await w.submit('再补一个')
  await w.clear()
  await w.submit('新的任务：先写测试')

  const described = w.prompts.map((prompt) => (prompt.context?.[0] ?? '').includes(TDD_DESCRIPTION))
  expect(described).toEqual([true, true, false, true])
})

test('a message refused beneath never showed its suggestions, so they are described the next time', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  let refuse = true
  const w = world($, on, { backend: rates({ tdd: 0.6, '(none)': 0.4 }), skills: SKILLS, beneath: { drop: () => (refuse ? 'blocked by a UserPromptSubmit hook' : undefined) } })
  await w.submit('先写失败的测试')
  refuse = false
  await w.submit('先写失败的测试')

  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]?.context?.[0]).toContain(TDD_DESCRIPTION)
})

test('a skill the listing still shows (skillsAlwaysListed) is suggested by name only', { options: { ...KEY, skillsMinRelevance: 0.2, skillsAlwaysListed: ['tdd'] } }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.6, '(none)': 0.4 }), skills: SKILLS })
  await w.submit('先写失败的测试')
  const block = w.prompts[0]?.context?.[0] ?? ''
  expect(block).toContain('\n- tdd (relevance 0.60)\n')
  expect(block).not.toContain(TDD_DESCRIPTION)
})

test('skills named in skillsNeverSuggested are never offered, to the main agent or to the person', { options: { ...KEY, skillsNeverSuggested: ['code-review', 'grill-me'] } }, async ($, on) => {
  const w = world($, on, { backend: rates({}), skills: WITH_PERSONS, disk: PERSON_FILES })
  await w.submit('审一下这个分支')
  const which = w.requests[0]?.body.questions['skills.which']
  expect(Object.keys(which.criteria)).toEqual(['tdd', 'anthropic-skills:computer-use', 'ship:release', '(none)'])
})

test("when the session's skills cannot be read, nothing is asked about them and the main agent keeps its listing", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({}), skills: { ...SKILLS, listed: null } })
  await w.submit('先写失败的测试')
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['effort.level'])
  expect(await w.listing(LISTING)).toEqual({ text: LISTING })
})

test('at session start the skills are read, and the debug log says what was found and whether the listing is withheld', { options: KEY }, async ($, on) => {
  const w = world($, on, { skills: WITH_PERSONS, disk: PERSON_FILES })
  await w.startSession()
  expect(w.logs).toEqual([
    { text: 'skills: 3 the main agent can load, 2 only you can start (/grill-me /ship:release); the listing is withheld from the main agent', to: 'debug' },
  ])
})

test('without a decision model the debug log says the listing stays', async ($, on) => {
  const w = world($, on, { skills: SKILLS })
  await w.startSession()
  expect(w.logs.map((log) => log.text)).toEqual(['skills: no decision model is set up, so the main agent keeps the skill listing and nothing is suggested'])
})

test('each listing withheld from the main agent is noted in the debug log, with what it kept', { options: { ...KEY, skillsAlwaysListed: ['tdd'] } }, async ($, on) => {
  const w = world($, on, { skills: SKILLS })
  await w.listing(LISTING)
  await w.listing(LISTING, 'a1')
  expect(w.logs.map((log) => log.text)).toEqual([`withheld the skill listing from the main agent (3 skills, ${LISTING.length} characters); kept tdd`])
})

test('each decision about the skills is written to the debug log, never into the conversation', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.62, 'code-review': 0.23, 'anthropic-skills:computer-use': 0.01, '(none)': 0.14 }), skills: WITH_PERSONS, disk: PERSON_FILES })
  await w.submit('先写一个失败的测试，再实现登录限流')
  const lines = w.logs.filter((log) => log.text.startsWith('skills for '))
  expect(lines).toEqual([
    { text: 'skills for "先写一个失败的测试，再实现登录限流": tdd 0.62, code-review 0.23, anthropic-skills:computer-use 0.01, none 0.14; suggested tdd, code-review', to: 'debug' },
  ])
})

test('what the mod sends is exactly what the decision module builds from a message and its recent context, so the eval measures the live request (spec #67)', { options: KEY }, async ($, on) => {
  const messages = [
    { role: 'user' as const, text: '登录接口加个限流', toolUses: [] },
    { role: 'assistant' as const, text: '好的，要先写测试吗？', toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: {}, text: 'FILE BODY' }] },
  ]
  const w = world($, on, { backend: rates({}), skills: WITH_PERSONS, disk: PERSON_FILES, messages })
  await w.submit('要，先写失败的测试')

  // The session's skills as the eval's catalog gives them: the listing's names, who can start each.
  const options: SkillOption[] = [
    { name: 'tdd', description: 'Test-driven development. Use when the user wants to build features or fix bugs test-first.', by: 'model' },
    { name: 'code-review', description: 'Review the changes since a fixed point along two axes: Standards and Spec.', by: 'model' },
    { name: 'anthropic-skills:computer-use', description: 'Read this skill before the first step of any request to do something in an app on the person’s own computer.', by: 'model' },
    { name: 'grill-me', description: 'Interview the user relentlessly about a plan until every branch is resolved.', by: 'person' },
    { name: 'ship:release', description: 'Cut a release: tag, changelog, publish.', by: 'person' },
  ]
  const { request } = skillsRequest(
    { message: '要，先写失败的测试', recent_context: [{ role: 'user', text: '登录接口加个限流' }, { role: 'assistant', text: '好的，要先写测试吗？', toolUses: [{ tool: 'Read' }] }] },
    options,
    { limits: { messages: 4, tokens: 2000 } },
  )
  expect(w.requests[0]?.body).toEqual({ model: JEV_MODEL, ...request })
})

test('the skills named in skillsAlwaysListed stay in the main agent’s listing, as the engine wrote them', { options: { ...KEY, skillsAlwaysListed: ['anthropic-skills:computer-use', 'code-review', 'not-installed'] } }, async ($, on) => {
  const w = world($, on, { skills: SKILLS })
  expect(await w.listing(LISTING)).toEqual({
    text: [
      'The following skills are available for use with the Skill tool:',
      '',
      '- code-review: Review the changes since a fixed point along two axes: Standards and Spec.',
      '- anthropic-skills:computer-use: Read this skill before the first step of any request to do something in an app on the person’s own computer.',
    ].join('\n'),
  })
})

// The decision module's skills interface: what the eval (#16) imports to
// build the mod's request and to read an answer the way the mod does
// (seam 2's code side; pure, no network).

const OPTIONS: SkillOption[] = [
  { name: 'pr', description: 'Use when writing a PR body.', by: 'model' },
  { name: 'code-review', description: 'Review the changes since a fixed point.', by: 'model' },
  { name: 'grill-me', description: 'Interview the user relentlessly about a plan.', by: 'person' },
]

test('the skills question in each language: the same options in the same order, "(none)" last; no options, no question', () => {
  const en = skillsPart(OPTIONS)
  const zh = skillsPart(OPTIONS, { language: 'zh' })
  const criteria = (part: typeof en) => (part?.questions.which?.type === 'choice' ? part.questions.which.criteria : {})
  expect(Object.keys(criteria(en))).toEqual(['pr', 'code-review', 'grill-me', '(none)'])
  expect(Object.keys(criteria(zh))).toEqual(['pr', 'code-review', 'grill-me', '(none)'])
  expect(criteria(zh).pr).toBe('Use when writing a PR body.')
  expect(JSON.stringify(zh?.questions.which?.instructions)).toContain('`user_message`')
  expect(JSON.stringify(zh?.questions.which?.instructions)).toMatch(/应该加载/)
  expect(JSON.stringify(en?.questions.which?.instructions)).not.toMatch(/应该加载/)
  expect(skillsPart([])).toBeNull()
})

test('a Choice takes at most 255 options: past 254 skills the rest are left out, "(none)" kept last', () => {
  const many: SkillOption[] = Array.from({ length: 300 }, (_, i) => ({ name: `skill-${i}`, description: `Skill number ${i}.`, by: 'model' }))
  const which = skillsPart(many)?.questions.which
  const names = which?.type === 'choice' ? Object.keys(which.criteria) : []
  expect(names).toHaveLength(255)
  expect(names.at(-2)).toBe('skill-253')
  expect(names.at(-1)).toBe('(none)')
})

test('an answer reads back as a ranking: shares normalized, names not offered ignored, a tie in the options order', () => {
  const answer = { which: { type: 'choice' as const, choice: 'ghost', probabilities: { 'code-review': 0.2, pr: 0.2, ghost: 0.5, '(none)': 0.4 }, confidence: 0.2 } }
  const ranking = readSkills(answer, OPTIONS)
  expect(ranking?.ranked.map((entry) => entry.name)).toEqual(['pr', 'code-review'])
  expect(ranking?.ranked.map((entry) => entry.relevance)).toEqual([0.25, 0.25])
  expect(ranking?.none).toBe(0.5)
  // No usable answer: no ranking.
  expect(readSkills({}, OPTIONS)).toBeNull()
  expect(readSkills({ which: { type: 'choice', choice: '', probabilities: {}, confidence: null } }, OPTIONS)).toBeNull()
})

test('what a ranking suggests: skills the main agent can load at or above minRelevance, at most max; the person-only ones apart, at most two', () => {
  const ranking = { ranked: [{ name: 'grill-me', relevance: 0.5 }, { name: 'code-review', relevance: 0.3 }, { name: 'pr', relevance: 0.15 }], none: 0.05 }
  const picks = pickSkills(ranking, OPTIONS, { max: 3, minRelevance: 0.2 })
  expect(picks.suggest.map((skill) => skill.name)).toEqual(['code-review'])
  expect(picks.hint.map((skill) => skill.name)).toEqual(['grill-me'])
  expect(pickSkills(ranking, OPTIONS, { max: 0, minRelevance: 0 }).suggest).toEqual([])
  expect(pickSkills(ranking, OPTIONS, { max: 3, minRelevance: 0.1 }).suggest.map((skill) => skill.name)).toEqual(['code-review', 'pr'])
})

test('the ranker the mod uses asks the skills question and ranks its answer: the swap point for portraits and a second request (#11) and find_skill (#12)', async () => {
  const ranker = choiceRanker()
  const part = ranker.part(OPTIONS)
  expect(part).toEqual(skillsPart(OPTIONS))
  const answers = { 'skills.which': { type: 'choice', choice: 'pr', probabilities: { pr: 0.7, 'code-review': 0.1, 'grill-me': 0, '(none)': 0.2 }, confidence: 0.6 } }
  const ranking = await ranker.rank(answersFor(part!, answers), OPTIONS)
  expect(ranking?.ranked[0]).toEqual({ name: 'pr', relevance: 0.7 })
})
