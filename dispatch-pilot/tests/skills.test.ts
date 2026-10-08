// Skills (#10): the main agent's skill listing withheld, and the skills that
// fit each message the person sends suggested beside it. Seam 1: engine
// events in; what reaches the model, the decision backend and the board data
// (`w.board()`) out.

import { expect, test } from 'claude-code/testing'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import { pickSkills, readHints, readSkills, skillsPart, skillsRequest, type SkillOption } from '../hooks/decision/skills.ts'
import { CLEF_OPTIONS, clef, clefInputProblems } from './support/cloudflare.ts'
import type { Reply, Sent, SkillsWorld } from './support/world.ts'
import { isSecondSkillsRequest, jev, rates, world, type World } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }
/** The switch is off until the person turns it on (#48): these tests are about what the request is with it on. */
const UNRESOLVED_ON = { unresolved: true }

/** The skills decisions the board keeps, oldest first. */
async function skillDecisions(w: World) {
  return (await w.board()).log.filter((entry) => entry.feature === 'skills')
}

/** The names the latest skills decision suggested to the main agent, and pointed out to the person (「可试 /x」). */
async function picked(w: World) {
  const skills = (await skillDecisions(w)).at(-1)?.skills
  return { suggest: skills?.suggest.map((skill) => skill.name), try: skills?.try.map((skill) => skill.name) }
}

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

// What the main agent reads in place of the listing: a fixed note on how to
// come by a skill, naming none (the attachment is part of the prompt cache).
const HINT =
  "Dispatch Pilot leaves most of this session's skills out of the skill listing. The ones that fit a message may be suggested beside it. For any other skill, call the find_skill tool (mcp__dispatch-pilot__find_skill; load it with ToolSearch first if it is deferred) with a few words on the work, then load a skill it returns with the Skill tool by its exact name."

test("the main agent's skill listing is withheld, a fixed note on finding skills in its place; a dispatched agent's reaches it as the engine wrote it", { options: KEY }, async ($, on) => {
  const w = world($, on, { skills: SKILLS })
  expect(await w.listing(LISTING)).toEqual({ text: HINT })
  expect(await w.listing(LISTING, 'a1')).toEqual({ text: LISTING })
})

// The note with the find_skill tool switched off: it does not send the main agent to it.
const HINT_WITHOUT_FIND_SKILL =
  "Dispatch Pilot leaves most of this session's skills out of the skill listing. The ones that fit a message may be suggested beside it; load one, or any skill you know, with the Skill tool by its exact name."

test('with find_skill switched off (/dp find-skill off, kept from an earlier session), the note does not name it', { options: KEY }, async ($, on) => {
  const w = world($, on, { skills: SKILLS, store: { switches: { 'find-skill': false } }, session: true })
  await w.start()
  expect(await w.listing(LISTING)).toEqual({ text: HINT_WITHOUT_FIND_SKILL })
})

test('the note is the same text each time the engine asks, whatever skills the session has or the listing holds', { options: KEY }, async ($, on) => {
  const skills = { commands: [...(SKILLS.commands ?? [])], listed: [...(SKILLS.listed ?? [])] }
  const w = world($, on, { skills, session: true })
  await w.start()
  const first = await w.listing(LISTING)
  const again = await w.listing(LISTING)
  // A new conversation (/clear), with one more skill installed meanwhile: the skills are read afresh.
  skills.commands.push({ name: 'wrangler', description: 'Deploy Cloudflare Workers with Wrangler.', source: 'user' })
  skills.listed.push({ name: 'wrangler', source: 'userSettings', tokens: 40 })
  await w.clear()
  const later = await w.listing(`${LISTING}\n- wrangler: Deploy Cloudflare Workers with Wrangler.`)

  expect(first).toEqual({ text: HINT })
  expect(again).toEqual(first)
  expect(later).toEqual(first)
})

// The engine asks about the listing once per conversation and keeps the answer
// (a mid-conversation `$.ui.invalidate` does not ask again: real engine,
// 2.1.289), so the note follows the find-skill switch as it stands when the
// engine asks, and a switch flipped mid-conversation shows from the next
// conversation on. Meanwhile the tool itself answers by the switch.
test('the note follows the find-skill switch as it stands when the engine asks: flipped, it shows from the next conversation (/clear) on', { options: KEY }, async ($, on) => {
  const w = world($, on, { skills: SKILLS, session: true })
  expect(await w.listing(LISTING)).toEqual({ text: HINT })
  await w.command('dp', 'find-skill off')
  await w.clear()
  expect(await w.listing(LISTING)).toEqual({ text: HINT_WITHOUT_FIND_SKILL })
  await w.command('dp', 'find-skill on')
  await w.clear()
  expect(await w.listing(LISTING)).toEqual({ text: HINT })
})

test('with the skills switch off (/dp skills off, kept from an earlier session), nothing is asked about the skills and the main agent reads the listing as the engine wrote it', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]), skills: SKILLS, store: { switches: { skills: false } }, session: true })
  await w.start()
  await w.submit('先写一个失败的测试')
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['effort.level'])
  expect(await w.listing(LISTING)).toEqual({ text: LISTING })
  expect(await w.command('dp', 'status')).toMatch(/关 +skills +\S/)
})

// The engine keeps its answer about the listing for the conversation (a
// mid-conversation `$.ui.invalidate` does not bring it back: real engine,
// 2.1.289), so the listing the feature withheld travels with a message instead.
const RESTORED = `Dispatch Pilot's skill suggestions are switched off, so here is the skill listing it had left out:\n\n${LISTING}`

test('switched off mid-conversation, the listing it withheld reaches the main agent with the next message, once; suggestions stop', { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: rates({ '(none)': 1 }), skills: SKILLS })
  expect(await w.listing(LISTING)).toEqual({ text: HINT })
  await w.submit('先写一个失败的测试')
  await w.command('dp', 'skills off')
  await w.submit('再写一个')
  await w.submit('还有吗')

  expect(w.prompts.map((prompt) => prompt.context)).toEqual([undefined, [RESTORED], undefined])
  expect(Object.keys(w.requests.at(-1)?.body.questions)).toEqual(['effort.level', 'effort.unresolved'])
})

test('/dp off brings the withheld listing back the same way; switched on again, suggestions resume and the listing is not sent twice', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.7, '(none)': 0.3 }, { tdd: 0.7 }), skills: SKILLS })
  await w.listing(LISTING)
  await w.command('dp', 'off')
  await w.submit('先写一个失败的测试')
  await w.command('dp', 'on')
  await w.submit('再写一个')
  await w.command('dp', 'skills off')
  await w.submit('还有吗')

  expect(w.prompts[0]?.context).toEqual([RESTORED])
  expect(w.prompts[1]?.context?.[0]).toContain('- tdd (relevance 0.70)')
  expect(w.prompts[2]?.context).toBeUndefined()
})

test('after /compact the listing goes back again with the next message while the switch stays off', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]), skills: SKILLS, session: true })
  await w.listing(LISTING)
  await w.command('dp', 'skills off')
  await w.submit('再写一个')
  await w.compact()
  await w.submit('还有吗')
  await w.submit('继续')

  expect(w.prompts.map((prompt) => prompt.context)).toEqual([[RESTORED], [RESTORED], undefined])
})

test('without a TypeSafe key nothing could suggest a skill, so the main agent keeps its listing', async ($, on) => {
  const w = world($, on, { skills: SKILLS })
  expect(await w.listing(LISTING)).toEqual({ text: LISTING })
})

// Withheld, the listing could only come back as suggestions: with no skill the
// main agent can load left to suggest, it stays.
test('with no skill the main agent can load to suggest, the main agent keeps its listing, and the debug log says why', { options: KEY }, async ($, on) => {
  const w = world($, on, {
    skills: { commands: [{ name: 'grill-me', description: 'Interview the user relentlessly about a plan.', source: 'user' }], listed: [] },
    disk: { '/home/u/.claude/skills/grill-me/SKILL.md': '---\nname: grill-me\ndisable-model-invocation: true\n---\nAsk.\n' },
    session: true,
  })
  await w.start()
  expect(await w.listing(LISTING)).toEqual({ text: LISTING })
  expect(w.logs.map((log) => log.text)).toContain('skills: 0 the main agent can load, 1 only you can start (/grill-me); the main agent keeps the skill listing, since no skill in it could be suggested')
})

test('every skill the main agent can load in skillsNeverSuggested: none could be suggested, so the listing stays', { options: { ...KEY, skillsNeverSuggested: ['tdd', 'code-review', 'anthropic-skills:computer-use'] } }, async ($, on) => {
  const w = world($, on, { skills: SKILLS })
  expect(await w.listing(LISTING)).toEqual({ text: LISTING })
})

test('Clef chosen without its Cloudflare credentials could suggest nothing either, so the main agent keeps its listing', { options: { decisionModel: 'clef' } }, async ($, on) => {
  const w = world($, on, { skills: SKILLS })
  expect(await w.listing(LISTING)).toEqual({ text: LISTING })
})

test('Clef takes both skills requests as they are (its input rules hold), and the listing is withheld', { options: CLEF_OPTIONS }, async ($, on) => {
  // Clef's answer puts the whole Choice on its first option (tdd), so a second request re-reads it.
  const w = world($, on, { switches: UNRESOLVED_ON, backend: clef([0, 1, 0, 0, 0]), skills: SKILLS })
  // With Clef the suggestions start off (tests/backend-defaults.test.ts): the person turns them on.
  await w.command('dp', 'skills on')
  await w.submit('先写一个失败的测试')
  expect(w.requests).toHaveLength(3)
  expect(w.requests.map((request) => clefInputProblems(request.body))).toEqual([[], [], []])
  expect(w.requests.map((request) => Object.keys(request.body.questions))[0]).toEqual(['effort.level', 'effort.unresolved'])
  expect(Object.keys(w.withoutEffort[0]?.body.questions)).toEqual(['skills.which'])
  // One skill re-read: its yes/no alone (Clef refuses a Choice of one option).
  expect(Object.keys(w.withoutEffort[1]?.body.questions)).toEqual(['skills.fits.0'])
  expect(await w.listing(LISTING)).toEqual({ text: HINT })
})

test("a message's skills request asks which skill the main agent could load for it, by name and description, or none", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]), skills: SKILLS })
  await w.submit('先写一个失败的测试，再实现登录限流')

  const questions = w.withoutEffort[0]?.body.questions
  expect(Object.keys(questions)).toEqual(['skills.which'])
  const which = questions['skills.which']
  expect(which.type).toBe('choice')
  // The names the Skill tool takes (a synced skill with its prefix), then "none" last.
  expect(Object.keys(which.criteria)).toEqual(['tdd', 'code-review', 'anthropic-skills:computer-use', '(none)'])
  expect(which.criteria.tdd).toBe('Test-driven development. Use when the user wants to build features or fix bugs test-first.')
  expect(which.criteria['anthropic-skills:computer-use']).toBe('Read this skill before the first step of any request to do something in an app on the person’s own computer.')
  expect(JSON.stringify(which.instructions)).toContain('`user_message`')
})

test('the skills that fit are suggested beside the message, with name, description and relevance, the best fit first', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, {
    backend: rates({ tdd: 0.62, 'code-review': 0.23, 'anthropic-skills:computer-use': 0.01, '(none)': 0.14 }, { tdd: 0.64, 'code-review': 0.91 }),
    skills: SKILLS,
  })
  await w.submit('先写一个失败的测试，再实现登录限流')

  expect(w.prompts[0]?.context).toEqual([
    [
      '<skill_relevance>',
      'Skills that may fit this message, rated by Dispatch Pilot’s decision model (relevance 0 to 1). Most skills are left out of the skill listing in this session: load one of these with the Skill tool by its exact name if it fits the work, and skip any that does not.',
      '- code-review (relevance 0.91): Review the changes since a fixed point along two axes: Standards and Spec.',
      '- tdd (relevance 0.64): Test-driven development. Use when the user wants to build features or fix bugs test-first.',
      '</skill_relevance>',
    ].join('\n'),
  ])
})

test('when the first stage rates no skill, nothing is asked a second time and nothing is attached to the message', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.03, 'code-review': 0.04, 'anthropic-skills:computer-use': 0.02, '(none)': 0.91 }), skills: SKILLS })
  await w.submit('这个函数为什么返回 undefined？')
  expect(w.withoutEffort).toHaveLength(1)
  expect(w.prompts[0]?.context).toBeUndefined()
})

test('when no skill rated in the first stage fits on its own, nothing is attached to the message', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.3, 'code-review': 0.2, '(none)': 0.5 }, { tdd: 0.12, 'code-review': 0.05 }), skills: SKILLS })
  await w.submit('这个函数为什么返回 undefined？')
  expect(w.withoutEffort).toHaveLength(2)
  expect(w.prompts[0]?.context).toBeUndefined()
})

test('skillsMax caps how many skills are suggested, the most relevant first', { options: { ...KEY, skillsMax: 1, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, {
    backend: rates({ tdd: 0.3, 'code-review': 0.45, 'anthropic-skills:computer-use': 0.2, '(none)': 0.05 }, { tdd: 0.8, 'code-review': 0.9, 'anthropic-skills:computer-use': 0.3 }),
    skills: SKILLS,
  })
  await w.submit('先审一下这个分支，再补测试')
  const block = w.prompts[0]?.context?.[0] ?? ''
  expect(block).toContain('- code-review (relevance 0.90): ')
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

test('skills only the person can start (disable-model-invocation in their SKILL.md) are asked about in a question of their own; one switched off in settings is not', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({}), skills: WITH_PERSONS, disk: PERSON_FILES })
  await w.submit('这个方案往死里挑刺')
  const questions = w.withoutEffort[0]?.body.questions
  expect(Object.keys(questions)).toEqual(['skills.which', 'skills.hint'])
  expect(Object.keys(questions['skills.which'].criteria)).toEqual(['tdd', 'code-review', 'anthropic-skills:computer-use', '(none)'])
  const hint = questions['skills.hint']
  expect(hint.type).toBe('choice')
  expect(Object.keys(hint.criteria)).toEqual(['grill-me', 'ship:release', '(none)'])
  expect(hint.criteria['grill-me']).toBe('Interview the user relentlessly about a plan until every branch is resolved.')
  expect(JSON.stringify(hint.instructions)).toContain('The user starts these skills themselves')
})

test('Clef takes stage one with both its Choices, and the second request over skills of both kinds (its input rules hold)', { options: CLEF_OPTIONS }, async ($, on) => {
  // Clef's answer puts each whole Choice on its first option: tdd, and grill-me.
  const w = world($, on, { switches: UNRESOLVED_ON, backend: clef([0, 1, 0, 0, 0]), skills: WITH_PERSONS, disk: PERSON_FILES })
  await w.command('dp', 'skills on')
  await w.submit('这个方案往死里挑刺，再补测试')
  expect(w.requests.map((request) => Object.keys(request.body.questions))).toEqual([
    ['effort.level', 'effort.unresolved'],
    ['skills.which', 'skills.hint'],
    ['skills.best', 'skills.fits.0', 'skills.fits.1'],
  ])
  expect(w.requests.map((request) => clefInputProblems(request.body))).toEqual([[], [], []])
})

/**
 * Jev answering as one Choice shares its probability: each option of a
 * skills Choice gets its weight over the weights of the options asked beside
 * it; the second request gets `fits`.
 */
function competing(weights: Record<string, number>, fits: Record<string, number>) {
  return (request: Sent): Reply => {
    if (isSecondSkillsRequest(request)) return rates({}, fits)(request)
    const shares: Record<string, Record<string, number>> = {}
    for (const [id, question] of Object.entries(request.body.questions as Record<string, { type: string; criteria?: Record<string, unknown> }>)) {
      if (question.type !== 'choice' || !id.startsWith('skills.')) continue
      const options = Object.keys(question.criteria ?? {})
      const sum = options.reduce((total, option) => total + (weights[option] ?? 0), 0)
      shares[id] = Object.fromEntries(options.map((option) => [option, sum > 0 ? (weights[option] ?? 0) / sum : 0]))
    }
    return jev([0, 1, 0, 0, 0], { shares })(request)
  }
}

// The eval's 033 and 090: a skill only the person can start that fits the
// message outright took nearly all of one shared Choice, and the skill the
// main agent should load got too little to be re-read. Asked apart, each
// question shares its own probability.
test('a skill only the person can start that fits outright takes nothing from the skills the main agent can load: both are re-read, one suggested, one pointed out', { options: { ...KEY, skillsMinRelevance: 0.5 } }, async ($, on) => {
  const w = world($, on, { backend: competing({ 'grill-me': 98, 'code-review': 1, '(none)': 1 }, { 'code-review': 0.9, 'grill-me': 0.95 }), skills: WITH_PERSONS, disk: PERSON_FILES })
  await w.submit('这个方案往死里挑刺，再审一下改动')
  await w.step({ index: 0 })

  expect(Object.keys(w.withoutEffort[1]?.body.questions ?? {})).toEqual(['skills.best', 'skills.fits.0', 'skills.fits.1'])
  expect(w.prompts[0]?.context?.[0]).toContain('- code-review (relevance 0.90): ')
  expect(await picked(w)).toEqual({ suggest: ['code-review'], try: ['grill-me'] })
  const [entry] = await skillDecisions(w)
  expect(entry).toMatchObject({ turn: 1, agent: 'main', tone: 'ok', subject: '"这个方案往死里挑刺，再审一下改动"', outcome: '推荐 code-review；可试 /grill-me' })
  expect(entry?.skills?.try[0]?.relevance).toBeGreaterThan(0.9)
})

test('with only skills the person can start to ask about, the hint is still asked, and the main agent keeps its listing', { options: { ...KEY, skillsMinRelevance: 0.5 } }, async ($, on) => {
  const w = world($, on, {
    backend: rates({ 'grill-me': 0.7, '(none)': 0.3 }, { 'grill-me': 0.9 }),
    skills: { commands: [{ name: 'grill-me', description: 'Interview the user relentlessly about a plan.', source: 'user' }], listed: [] },
    disk: { '/home/u/.claude/skills/grill-me/SKILL.md': '---\nname: grill-me\ndisable-model-invocation: true\n---\nAsk.\n' },
  })
  expect(await w.listing(LISTING)).toEqual({ text: LISTING })
  await w.submit('这个方案往死里挑刺')
  await w.step({ index: 0 })

  expect(Object.keys(w.withoutEffort[0]?.body.questions)).toEqual(['skills.hint'])
  expect(w.prompts[0]?.context).toBeUndefined()
  expect(await picked(w)).toEqual({ suggest: [], try: ['grill-me'] })
})

test('a skill only the person can start is never suggested to the main agent: the board data names it for them (可试 /x)', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, { backend: rates({ 'grill-me': 0.55, 'code-review': 0.3, '(none)': 0.15 }, { 'grill-me': 0.95, 'code-review': 0.3 }), skills: WITH_PERSONS, disk: PERSON_FILES })
  await w.submit('这个方案往死里挑刺，问到我答不上来为止')
  await w.step({ index: 0 })

  const block = w.prompts[0]?.context?.[0] ?? ''
  expect(block).toContain('- code-review (relevance 0.30): ')
  expect(block).not.toContain('grill-me')
  expect(await picked(w)).toEqual({ suggest: ['code-review'], try: ['grill-me'] })
})

// A project's own skills: `$.command.list()` gives a project's file the same
// source as the person's own (`user`: CommandSource in Claude Code's types),
// and the context counts a listed one as `projectSettings`. Both are read
// under the session's working directory.
const PROJECT: SkillsWorld = {
  commands: [
    { name: 'deploy-docs', description: 'Build the docs site and deploy it.', source: 'user' },
    { name: 'release-notes', description: 'Write the release notes for a tag.', source: 'user' },
  ],
  listed: [{ name: 'deploy-docs', source: 'projectSettings', tokens: 20 }],
  cwd: '/work',
}
const PROJECT_FILES: Record<string, string> = {
  '/work/.claude/skills/deploy-docs/SKILL.md': '---\nname: deploy-docs\n---\nRun the docs build, then push the site.\n',
  '/work/.claude/skills/release-notes/SKILL.md': '---\nname: release-notes\ndisable-model-invocation: true\n---\nList the merged changes since the last tag.\n',
}

test("a project's own skills are read under its working directory: one the main agent can load is re-read from there, one only the person can start is pointed out", { options: { ...KEY, skillsMinRelevance: 0.5 } }, async ($, on) => {
  const w = world($, on, { backend: rates({ 'deploy-docs': 0.7, 'release-notes': 0.6, '(none)': 0.1 }, { 'deploy-docs': 0.9, 'release-notes': 0.85 }), skills: PROJECT, disk: PROJECT_FILES })
  await w.submit('发版：更新文档站，再写这次的发布说明')
  await w.step({ index: 0 })

  const fits = Object.values(w.withoutEffort[1]?.body.questions ?? {}).flatMap((question: any) => (question.type === 'noul' ? [question.instructions.skill] : []))
  expect(fits.map((skill: any) => [skill.name, skill.opening])).toEqual([
    ['deploy-docs', 'Run the docs build, then push the site.'],
    ['release-notes', 'List the merged changes since the last tag.'],
  ])
  expect(await picked(w)).toEqual({ suggest: ['deploy-docs'], try: ['release-notes'] })
})

/** Answers each message's two skills requests by the message they ask about: `byMessage[text]` is `[shares, fits]`. */
function byMessage(answers: Record<string, [Record<string, number>, Record<string, number>?]>) {
  return (request: Parameters<ReturnType<typeof rates>>[0]) => {
    const [shares, fits] = answers[request.body.state.user_message] ?? [{ '(none)': 1 }]
    return rates(shares, fits)(request)
  }
}

test('each message gets its own skills decision: the skills suggested, and none once nothing fits', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, { backend: byMessage({ 先写失败的测试: [{ tdd: 0.7, '(none)': 0.3 }, { tdd: 0.9 }] }), skills: SKILLS })
  await w.submit('先写失败的测试')
  await w.step({ index: 0 })
  expect(await picked(w)).toEqual({ suggest: ['tdd'], try: [] })
  await w.submit('这个报错是什么意思？')
  await w.step({ index: 0 })
  expect(await picked(w)).toEqual({ suggest: [], try: [] })
  expect((await skillDecisions(w)).map((entry) => [entry.turn, entry.outcome])).toEqual([
    [1, '推荐 tdd'],
    [2, '没有推荐 skill'],
  ])
})

test("a failed decision request suggests nothing: no skills decision for that message, and its main agent's node says why", { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  // The first message's three requests (effort, skills, the skills' second stage) are answered; the next message's are refused.
  const w = world($, on, { backend: (request, n) => (n <= 3 ? rates({ tdd: 0.7, '(none)': 0.3 }, { tdd: 0.9 })(request) : { status: 503, body: 'overloaded' }), skills: SKILLS })
  await w.submit('先写失败的测试')
  await w.step({ index: 0 })
  expect(await picked(w)).toEqual({ suggest: ['tdd'], try: [] })
  await w.submit('然后把限流也加上')
  await w.step({ index: 0, effort: 'xhigh' })

  expect(w.requests).toHaveLength(5)
  expect(w.prompts[1]?.context).toBeUndefined()
  expect((await skillDecisions(w)).map((entry) => entry.turn)).toEqual([1])
  expect((await w.board()).main).toMatchObject({ turn: 2, routed: false, why: 'jev：繁忙（状态码 503）' })
})

test('an answer that leaves the skills question out suggests nothing, and the effort still goes through', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  // The second message's skills request is answered with nothing; its effort request is answered as usual.
  const effortOnly = (request: Parameters<ReturnType<typeof rates>>[0]) => {
    const reply = rates({ tdd: 0.7, '(none)': 0.3 }, { tdd: 0.9 })(request)
    if (request.body.state.user_message !== '然后把限流也加上' || 'effort.level' in request.body.questions || !('body' in reply)) return reply
    const body = reply.body as { answers: Record<string, unknown> }
    return { ...reply, body: { ...body, answers: {} } }
  }
  const w = world($, on, { backend: effortOnly, skills: SKILLS })
  await w.submit('先写失败的测试')
  await w.step({ index: 0 })
  await w.submit('然后把限流也加上')
  await w.step({ index: 0, effort: 'xhigh' })

  expect(w.prompts[1]?.context).toBeUndefined()
  // The first message was rated, the second got nothing about the skills: no decision for it, and the effort's went through.
  expect((await skillDecisions(w)).map((entry) => entry.turn)).toEqual([1])
  expect((await w.board()).main).toMatchObject({ turn: 2, routed: true })
})

const TDD_DESCRIPTION = 'Test-driven development. Use when the user wants to build features or fix bugs test-first.'

test('a skill suggested earlier in the conversation is named again without its description', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, {
    backend: byMessage({
      先写失败的测试: [{ tdd: 0.6, '(none)': 0.4 }, { tdd: 0.9 }],
      '再审一下，补边界情况的测试': [{ tdd: 0.5, 'code-review': 0.3, '(none)': 0.2 }, { tdd: 0.5, 'code-review': 0.3 }],
    }),
    skills: SKILLS,
  })
  await w.submit('先写失败的测试')
  await w.submit('再审一下，补边界情况的测试')

  const second = w.prompts[1]?.context?.[0] ?? ''
  expect(second).toContain('\n- tdd (relevance 0.50)\n')
  expect(second).not.toContain(TDD_DESCRIPTION)
  expect(second).toContain('\n- code-review (relevance 0.30): Review the changes since a fixed point along two axes: Standards and Spec.\n')
})

test('after /compact or /clear, a skill suggested earlier is described again', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.6, '(none)': 0.4 }, { tdd: 0.9 }), skills: SKILLS, session: true })
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
  const w = world($, on, { backend: rates({ tdd: 0.6, '(none)': 0.4 }, { tdd: 0.9 }), skills: SKILLS, beneath: { drop: () => (refuse ? 'blocked by a UserPromptSubmit hook' : undefined) } })
  await w.submit('先写失败的测试')
  refuse = false
  await w.submit('先写失败的测试')

  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]?.context?.[0]).toContain(TDD_DESCRIPTION)
})

test('a skill the listing still shows (skillsAlwaysListed) is suggested by name only', { options: { ...KEY, skillsMinRelevance: 0.2, skillsAlwaysListed: ['tdd'] } }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.6, '(none)': 0.4 }, { tdd: 0.88 }), skills: SKILLS })
  await w.submit('先写失败的测试')
  const block = w.prompts[0]?.context?.[0] ?? ''
  expect(block).toContain('\n- tdd (relevance 0.88)\n')
  expect(block).not.toContain(TDD_DESCRIPTION)
})

test('skills named in skillsNeverSuggested are never offered, to the main agent or to the person', { options: { ...KEY, skillsNeverSuggested: ['code-review', 'grill-me'] } }, async ($, on) => {
  const w = world($, on, { backend: rates({}), skills: WITH_PERSONS, disk: PERSON_FILES })
  await w.submit('审一下这个分支')
  const questions = w.withoutEffort[0]?.body.questions
  expect(Object.keys(questions['skills.which'].criteria)).toEqual(['tdd', 'anthropic-skills:computer-use', '(none)'])
  expect(Object.keys(questions['skills.hint'].criteria)).toEqual(['ship:release', '(none)'])
})

test("when the session's skills cannot be read, nothing is asked about them and the main agent keeps its listing", { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: rates({}), skills: { ...SKILLS, listed: null } })
  await w.submit('先写失败的测试')
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['effort.level', 'effort.unresolved'])
  expect(await w.listing(LISTING)).toEqual({ text: LISTING })
})

test('at session start the skills are read, and the debug log says what was found and whether the listing is withheld', { options: KEY }, async ($, on) => {
  // No store in this world: no profile can be kept, so none is written (#11).
  const w = world($, on, { skills: WITH_PERSONS, disk: PERSON_FILES, session: true })
  await w.start()
  // The skills features' lines (the settings line at session start is tests/backend-defaults.test.ts's).
  expect(w.logs.filter((log) => log.text.startsWith('skill'))).toEqual([
    { text: 'skills: 3 the main agent can load, 2 only you can start (/grill-me /ship:release); the listing is withheld from the main agent', to: 'debug' },
    { text: 'skill profiles: the store cannot be read, so no profile is kept or written; skills are rated by their descriptions', to: 'debug' },
  ])
  expect(w.completions).toEqual([])
})

test('without a decision model the debug log says the listing stays', async ($, on) => {
  const w = world($, on, { skills: SKILLS, session: true })
  await w.start()
  expect(w.logs.map((log) => log.text).filter((text) => text.startsWith('skill'))).toEqual(['skills: no decision model is set up, so the main agent keeps the skill listing and nothing is suggested'])
})

test('the skills switch is listed by /dp with what it does', { options: KEY }, async ($, on) => {
  const w = world($, on, { skills: SKILLS })
  expect(await w.command('dp', 'status')).toMatch(/开 +skills +给每条消息推荐合适的 skill/)
})

test('each listing withheld from the main agent is noted in the debug log, with what it kept and whether the note names find_skill', { options: { ...KEY, skillsAlwaysListed: ['tdd'] } }, async ($, on) => {
  const w = world($, on, { skills: SKILLS })
  await w.listing(LISTING)
  await w.listing(LISTING, 'a1')
  await w.command('dp', 'find-skill off')
  await w.listing(LISTING)
  expect(w.logs.map((log) => log.text)).toEqual([
    `withheld the skill listing from the main agent (3 skills, ${LISTING.length} characters); kept tdd; the note names find_skill`,
    `withheld the skill listing from the main agent (3 skills, ${LISTING.length} characters); kept tdd; the note leaves find_skill out (switched off)`,
  ])
})

test('each decision about the skills goes to the decision log (/dp log) and the debug log, never into the conversation', { options: { ...KEY, skillsMinRelevance: 0.2 } }, async ($, on) => {
  const w = world($, on, {
    backend: byMessage({
      先写一个失败的测试再实现登录限流: [{ tdd: 0.62, 'code-review': 0.23, 'anthropic-skills:computer-use': 0.01, '(none)': 0.14 }, { tdd: 0.97, 'code-review': 0.41 }],
      这个方案往死里挑刺: [{ 'grill-me': 0.4, '(none)': 0.6 }, { 'grill-me': 0.93 }],
      这个报错什么意思: [{ tdd: 0.02, '(none)': 0.98 }],
    }),
    skills: WITH_PERSONS,
    disk: PERSON_FILES,
  })
  await w.submit('先写一个失败的测试再实现登录限流')
  await w.submit('这个方案往死里挑刺')
  await w.submit('这个报错什么意思')

  // What the first stage put forward (its shares: the skills the main agent can load, then those only the person
  // can start, each question's own), how each fits on its own (the second stage), the bar.
  const first = '推荐 tdd、code-review · "先写一个失败的测试再实现登录限流"：第一段 tdd 0.62、code-review 0.23、都不合适 0.14；只能你触发的 都不合适 1.00；第二段相关度 tdd 0.97、code-review 0.41；相关度 0.20 起推荐，最多 3 个'
  const second = '没有推荐 skill；可试 /grill-me · "这个方案往死里挑刺"：第一段 都不合适 1.00；只能你触发的 grill-me 0.40、都不合适 0.60；第二段相关度 grill-me 0.93；相关度 0.20 起推荐，最多 3 个'
  const third = '没有推荐 skill · "这个报错什么意思"：第一段 都不合适 0.98；只能你触发的 都不合适 1.00；没有 skill 的份额到 0.10；相关度 0.20 起推荐，最多 3 个'
  expect(w.logs.filter((log) => log.text.startsWith('推荐 ') || log.text.startsWith('没有推荐 '))).toEqual([
    { text: first, to: 'debug' },
    { text: second, to: 'debug' },
    { text: third, to: 'debug' },
  ])
  const log = await w.command('dp', 'log 10')
  expect(log).toContain(`skills：${first}`)
  expect(log).toContain(`skills：${second}`)
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
  // The skills questions in English; the effort question has a request of its own (tests/effort-request.test.ts).
  const { request } = skillsRequest(
    { message: '要，先写失败的测试', recent_context: [{ role: 'user', text: '登录接口加个限流' }, { role: 'assistant', text: '好的，要先写测试吗？', toolUses: [{ tool: 'Read' }] }] },
    options,
    { limits: { messages: 4, tokens: 2000 } },
  )
  expect(w.withoutEffort[0]?.body).toEqual({ model: JEV_MODEL, ...request })
})

test('the skills named in skillsAlwaysListed stay in the main agent’s listing, as the engine wrote them, the note after them', { options: { ...KEY, skillsAlwaysListed: ['anthropic-skills:computer-use', 'code-review', 'not-installed'] } }, async ($, on) => {
  const w = world($, on, { skills: SKILLS })
  expect(await w.listing(LISTING)).toEqual({
    text: [
      'The following skills are available for use with the Skill tool:',
      '',
      '- code-review: Review the changes since a fixed point along two axes: Standards and Spec.',
      '- anthropic-skills:computer-use: Read this skill before the first step of any request to do something in an app on the person’s own computer.',
      '',
      HINT,
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

test("stage one's questions in each language: the skills the main agent can load in one Choice, those only the person can start in another, the same options in the same order, \"(none)\" last in each; no options, no question", () => {
  const en = skillsPart(OPTIONS)
  const zh = skillsPart(OPTIONS, { language: 'zh' })
  const criteria = (part: typeof en, id: string) => {
    const question = part?.questions[id]
    return question?.type === 'choice' ? question.criteria : {}
  }
  expect(Object.keys(en?.questions ?? {})).toEqual(['which', 'hint'])
  expect(Object.keys(criteria(en, 'which'))).toEqual(['pr', 'code-review', '(none)'])
  expect(Object.keys(criteria(zh, 'which'))).toEqual(['pr', 'code-review', '(none)'])
  expect(Object.keys(criteria(en, 'hint'))).toEqual(['grill-me', '(none)'])
  expect(Object.keys(criteria(zh, 'hint'))).toEqual(['grill-me', '(none)'])
  expect(criteria(zh, 'which').pr).toBe('Use when writing a PR body.')
  expect(JSON.stringify(zh?.questions.which?.instructions)).toContain('`user_message`')
  expect(JSON.stringify(zh?.questions.which?.instructions)).toMatch(/应该加载/)
  expect(JSON.stringify(en?.questions.which?.instructions)).not.toMatch(/应该加载/)
  expect(JSON.stringify(zh?.questions.hint?.instructions)).toMatch(/用户自己输入/)
  // Only one kind of skill: only its question.
  expect(Object.keys(skillsPart(OPTIONS.filter((option) => option.by === 'model'))?.questions ?? {})).toEqual(['which'])
  expect(Object.keys(skillsPart(OPTIONS.filter((option) => option.by === 'person'))?.questions ?? {})).toEqual(['hint'])
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
  const answer = { which: { type: 'choice' as const, choice: 'ghost', probabilities: { 'code-review': 0.2, pr: 0.2, ghost: 0.5, 'grill-me': 0.3, '(none)': 0.4 }, confidence: 0.2 } }
  const ranking = readSkills(answer, OPTIONS)
  expect(ranking?.ranked.map((entry) => entry.name)).toEqual(['pr', 'code-review'])
  expect(ranking?.ranked.map((entry) => entry.relevance)).toEqual([0.25, 0.25])
  expect(ranking?.none).toBe(0.5)
  // No usable answer: no ranking.
  expect(readSkills({}, OPTIONS)).toBeNull()
  expect(readSkills({ which: { type: 'choice', choice: '', probabilities: {}, confidence: null } }, OPTIONS)).toBeNull()
})

test('the hint question reads back the same way, over the skills only the person can start', () => {
  const answer = { hint: { type: 'choice' as const, choice: 'grill-me', probabilities: { 'grill-me': 0.3, pr: 0.9, '(none)': 0.2 }, confidence: 0.5 } }
  const ranking = readHints(answer, OPTIONS)
  expect(ranking?.ranked).toEqual([{ name: 'grill-me', relevance: 0.6 }])
  expect(ranking?.none).toBe(0.4)
  expect(readHints({}, OPTIONS)).toBeNull()
})

test('what a ranking suggests: skills the main agent can load at or above minRelevance, at most max; the person-only ones apart, at most two', () => {
  const ranking = { ranked: [{ name: 'grill-me', relevance: 0.5 }, { name: 'code-review', relevance: 0.3 }, { name: 'pr', relevance: 0.15 }], none: 0.05 }
  const picks = pickSkills(ranking, OPTIONS, { max: 3, minRelevance: 0.2 })
  expect(picks.suggest.map((skill) => skill.name)).toEqual(['code-review'])
  expect(picks.hint.map((skill) => skill.name)).toEqual(['grill-me'])
  expect(pickSkills(ranking, OPTIONS, { max: 0, minRelevance: 0 }).suggest).toEqual([])
  expect(pickSkills(ranking, OPTIONS, { max: 3, minRelevance: 0.1 }).suggest.map((skill) => skill.name)).toEqual(['code-review', 'pr'])
})
