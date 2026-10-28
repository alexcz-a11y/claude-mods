// Skills (#10, ADR 0018): the main agent's skill listing withheld, and the
// skill that fits each message the person sends suggested beside it, picked as
// TypeSafe's skill suggestion cookbook picks it. Seam 1: engine events in;
// what reaches the model, the decision backend and the board data
// (`w.board()`) out.

import { expect, test } from 'claude-code/testing'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import { LIQUID_GUIDE, TYPESAFE_GUIDE } from '../hooks/decision/guides.ts'
import {
  EXCERPT_CHARS,
  findSkills,
  modRanker,
  pickSkills,
  readGate,
  relevanceBlock,
  skillOpening,
  skillsPart,
  skillsRequest,
  type SkillOption,
  type SkillRanking,
} from '../hooks/decision/skills.ts'
import type { Reply, Sent, SkillsWorld } from './support/world.ts'
import { isSecondSkillsRequest, jev, KEY, OWN_EFFORT, rates, UNRESOLVED_ON, type World, world } from './support/world.ts'

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
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(OWN_EFFORT)
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

  // The first message was rated (nothing fits: the main agent is told so); the next ones are not.
  expect(w.prompts.map((prompt) => prompt.context)).toEqual([[NONE_BLOCK], [RESTORED], undefined])
  expect(Object.keys(w.requests.at(-1)?.body.questions)).toEqual(OWN_EFFORT)
})

/** The cookbook's block naming a skill, with its description the first time the main agent meets it. */
function suggested(name: string, description?: string): string {
  return ['<skill_relevance>', `Relevant to the current request: ${name}. Ignore this if it does not fit what the user actually asked for.`, ...(description === undefined ? [] : [`${name}: ${description}`]), '</skill_relevance>'].join('\n')
}
/** The cookbook's block when no skill fits. */
const NONE_BLOCK = ['<skill_relevance>', 'No skill in the roster appears relevant to this request.', '</skill_relevance>'].join('\n')

const TDD_DESCRIPTION = 'Test-driven development. Use when the user wants to build features or fix bugs test-first.'
const REVIEW_DESCRIPTION = 'Review the changes since a fixed point along two axes: Standards and Spec.'

test('/dp off brings the withheld listing back the same way; switched on again, suggestions resume and the listing is not sent twice', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.7, '(none)': 0.3 }, { tdd: 0.7 }), skills: SKILLS })
  await w.listing(LISTING)
  await w.command('dp', 'off')
  await w.submit('先写一个失败的测试')
  await w.command('dp', 'on')
  await w.submit('再写一个')
  await w.command('dp', 'skills off')
  await w.submit('还有吗')

  expect(w.prompts[0]?.context).toEqual([RESTORED])
  // Only the suggestion: the listing went back with the first message and does not go again.
  expect(w.prompts[1]?.context).toEqual([suggested('tdd', TDD_DESCRIPTION)])
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

test("a message's skills request asks, in the cookbook's words, which skill the main agent could load for it, each by its own description, and three questions on whether it needs one at all", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]), skills: SKILLS })
  await w.submit('先写一个失败的测试，再实现登录限流')

  const questions = w.withoutEffort[0]?.body.questions
  expect(Object.keys(questions)).toEqual(['skills.which', 'skills.gate.acts_on_user_system', 'skills.gate.would_follow_documented_procedure', 'skills.gate.prose_suffices'])
  const which = questions['skills.which']
  expect(which.type).toBe('choice')
  // The names the Skill tool takes (a synced skill with its prefix); no "none of these" option (the gate asks that).
  expect(Object.keys(which.criteria)).toEqual(['tdd', 'code-review', 'anthropic-skills:computer-use'])
  expect(which.criteria.tdd).toBe(TDD_DESCRIPTION)
  expect(which.instructions).toBe("Which of these skills, if any, is the right one to load to help with the user's latest request?")
  expect(questions['skills.gate.acts_on_user_system']).toEqual({
    type: 'noul',
    instructions: "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
  })
  expect(questions['skills.gate.prose_suffices'].instructions).toBe(
    "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
  )
})

test("the skill stage two's Choice picks is suggested beside the message in the cookbook's words, described the first time", { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: rates({ tdd: 0.62, 'code-review': 0.23, 'anthropic-skills:computer-use': 0.01, '(none)': 0.14 }, { tdd: 0.64, 'code-review': 0.91 }),
    skills: SKILLS,
  })
  await w.submit('先写一个失败的测试，再实现登录限流')

  // The three best of stage one re-read: one Choice over them, one yes/no each, in the cookbook's words.
  const second = w.withoutEffort[1]?.body.questions
  expect(Object.keys(second)).toEqual(['skills.which', 'skills.fits.0', 'skills.fits.1', 'skills.fits.2'])
  expect(second['skills.which'].instructions).toBe("Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name.")
  expect(second['skills.fits.0'].instructions).toBe(`Does the skill 'tdd' do the specific thing the user's request asks for? It is described as: ${TDD_DESCRIPTION}`)
  expect(w.prompts[0]?.context).toEqual([suggested('code-review', REVIEW_DESCRIPTION)])
})

test("as in the cookbook's deck example, the Choice settles which skill and the fits whether to say anything: the pick need not be the best fit", { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: (request) =>
      isSecondSkillsRequest(request)
        ? jev([0, 1, 0, 0, 0], { nouls: { 'skills.fits.0': 0.73, 'skills.fits.1': 0.38, 'skills.fits.2': 0.02 }, shares: { 'skills.which': { 'code-review': 0.8, tdd: 0.2 } } })(request)
        : rates({ tdd: 0.7, 'code-review': 0.3, '(none)': 0 })(request),
    skills: SKILLS,
  })
  await w.submit('先审一下这个分支')
  await w.step({ index: 0 })

  expect(w.prompts[0]?.context).toEqual([suggested('code-review', REVIEW_DESCRIPTION)])
  expect(await picked(w)).toEqual({ suggest: ['code-review'], try: [] })
  expect((await skillDecisions(w))[0]?.skills?.suggest[0]?.relevance).toBe(0.38)
})

test('when the three gate questions say the message needs no skill, nothing is asked a second time, and the main agent is told none appears relevant', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.03, 'code-review': 0.04, 'anthropic-skills:computer-use': 0.02, '(none)': 0.91 }), skills: SKILLS })
  await w.submit('这个函数为什么返回 undefined？')
  await w.step({ index: 0 })
  expect(w.withoutEffort).toHaveLength(1)
  expect(w.prompts[0]?.context).toEqual([NONE_BLOCK])
  expect((await skillDecisions(w))[0]).toMatchObject({ outcome: '没有推荐 skill', reason: '要不要 skill 0.09（低于 0.30 不推荐）' })
})

test('when no candidate does the specific thing asked (the best fit under 0.30), nothing is suggested, and the main agent is told so', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.3, 'code-review': 0.2, '(none)': 0.5 }, { tdd: 0.12, 'code-review': 0.05 }), skills: SKILLS })
  await w.submit('这个函数为什么返回 undefined？')
  expect(w.withoutEffort).toHaveLength(2)
  expect(w.prompts[0]?.context).toEqual([NONE_BLOCK])
})

test('one skill at most is suggested, however many fit', { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: rates({ tdd: 0.3, 'code-review': 0.45, 'anthropic-skills:computer-use': 0.2, '(none)': 0.05 }, { tdd: 0.8, 'code-review': 0.9, 'anthropic-skills:computer-use': 0.6 }),
    skills: SKILLS,
  })
  await w.submit('先审一下这个分支，再补测试')
  await w.step({ index: 0 })
  expect(w.prompts[0]?.context).toEqual([suggested('code-review', REVIEW_DESCRIPTION)])
  expect(await picked(w)).toEqual({ suggest: ['code-review'], try: [] })
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

test('skills only the person can start (disable-model-invocation in their SKILL.md) are asked about in a Choice of their own; one switched off in settings is not', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({}), skills: WITH_PERSONS, disk: PERSON_FILES })
  await w.submit('这个方案往死里挑刺')
  const questions = w.withoutEffort[0]?.body.questions
  expect(Object.keys(questions)).toEqual(['skills.which', 'skills.hint', 'skills.gate.acts_on_user_system', 'skills.gate.would_follow_documented_procedure', 'skills.gate.prose_suffices'])
  expect(Object.keys(questions['skills.which'].criteria)).toEqual(['tdd', 'code-review', 'anthropic-skills:computer-use'])
  const hint = questions['skills.hint']
  expect(hint.type).toBe('choice')
  expect(Object.keys(hint.criteria)).toEqual(['grill-me', 'ship:release'])
  expect(hint.criteria['grill-me']).toBe('Interview the user relentlessly about a plan until every branch is resolved.')
  expect(hint.instructions).toContain('The user starts these skills themselves')
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
      shares[id] = Object.fromEntries(options.map((option) => [option, sum > 0 ? (weights[option] ?? 0) / sum : 1 / options.length]))
    }
    return jev([0, 1, 0, 0, 0], { shares, nouls: { 'skills.gate.acts_on_user_system': 0.9, 'skills.gate.would_follow_documented_procedure': 0.8, 'skills.gate.prose_suffices': 0.1 } })(request)
  }
}

// The eval's 033 and 090: a skill only the person can start that fits the
// message outright took nearly all of one shared Choice, and the skill the
// main agent should load got too little to be re-read. Asked apart, each
// question shares its own probability.
test('a skill only the person can start that fits outright takes nothing from the skills the main agent can load: both kinds are re-read, one suggested, one pointed out', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: competing({ 'grill-me': 98, 'code-review': 1 }, { 'code-review': 0.9, 'grill-me': 0.95 }), skills: WITH_PERSONS, disk: PERSON_FILES })
  await w.submit('这个方案往死里挑刺，再审一下改动')
  await w.step({ index: 0 })

  expect(Object.keys(w.withoutEffort[1]?.body.questions ?? {})).toEqual(['skills.which', 'skills.hint', 'skills.fits.0', 'skills.fits.1', 'skills.fits.2', 'skills.fits.3', 'skills.fits.4'])
  expect(w.prompts[0]?.context).toEqual([suggested('code-review', REVIEW_DESCRIPTION)])
  expect(await picked(w)).toEqual({ suggest: ['code-review'], try: ['grill-me'] })
  const [entry] = await skillDecisions(w)
  expect(entry).toMatchObject({ turn: 1, agent: 'main', tone: 'ok', subject: '"这个方案往死里挑刺，再审一下改动"', outcome: '推荐 code-review；可试 /grill-me' })
  expect(entry?.skills?.try[0]?.relevance).toBe(0.95)
})

test('with only skills the person can start to ask about, the main agent keeps its listing, and the one that fits is pointed out to the person', { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: rates({ 'grill-me': 0.7, '(none)': 0.3 }, { 'grill-me': 0.9 }),
    skills: { commands: [{ name: 'grill-me', description: 'Interview the user relentlessly about a plan.', source: 'user' }], listed: [] },
    disk: { '/home/u/.claude/skills/grill-me/SKILL.md': '---\nname: grill-me\ndisable-model-invocation: true\n---\nAsk.\n' },
  })
  expect(await w.listing(LISTING)).toEqual({ text: LISTING })
  await w.submit('这个方案往死里挑刺')
  await w.step({ index: 0 })

  // One skill of that kind: no Choice to ask, it goes to stage two as it is.
  expect(Object.keys(w.withoutEffort[0]?.body.questions)).toEqual(['skills.gate.acts_on_user_system', 'skills.gate.would_follow_documented_procedure', 'skills.gate.prose_suffices'])
  expect(Object.keys(w.withoutEffort[1]?.body.questions)).toEqual(['skills.fits.0'])
  expect(w.prompts[0]?.context).toEqual([NONE_BLOCK])
  expect(await picked(w)).toEqual({ suggest: [], try: ['grill-me'] })
})

test('a skill only the person can start is never suggested to the main agent: the board data names it for them (可试 /x)', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ 'grill-me': 0.55, 'code-review': 0.3, '(none)': 0.15 }, { 'grill-me': 0.95, 'code-review': 0.3 }), skills: WITH_PERSONS, disk: PERSON_FILES })
  await w.submit('这个方案往死里挑刺，问到我答不上来为止')
  await w.step({ index: 0 })

  // 0.30 is the cookbook's bar, and a fit on it counts.
  expect(w.prompts[0]?.context).toEqual([suggested('code-review', REVIEW_DESCRIPTION)])
  expect(await picked(w)).toEqual({ suggest: ['code-review'], try: ['grill-me'] })
})

// A project's own skills: `$.command.list()` gives a project's file the same
// source as the person's own (`user`: CommandSource in Claude Code's types),
// and the context counts a listed one as `projectSettings`. Both are read
// under the session's working directory.
const PROJECT: SkillsWorld = {
  commands: [
    { name: 'deploy-docs', description: 'Build the docs site and deploy it.', source: 'user' },
    { name: 'check-links', description: 'Check every link of the docs site.', source: 'user' },
    { name: 'release-notes', description: 'Write the release notes for a tag.', source: 'user' },
  ],
  listed: [
    { name: 'deploy-docs', source: 'projectSettings', tokens: 20 },
    { name: 'check-links', source: 'projectSettings', tokens: 20 },
  ],
  cwd: '/work',
}
const PROJECT_FILES: Record<string, string> = {
  '/work/.claude/skills/deploy-docs/SKILL.md': '---\nname: deploy-docs\n---\nRun the docs build, then push the site.\n',
  '/work/.claude/skills/check-links/SKILL.md': '---\nname: check-links\n---\nCrawl the built site and list the broken links.\n',
  '/work/.claude/skills/release-notes/SKILL.md': '---\nname: release-notes\ndisable-model-invocation: true\n---\nList the merged changes since the last tag.\n',
}

test("a project's own skills are read under its working directory: stage two's Choice reads each by its description and the opening of its SKILL.md, and one only the person can start is pointed out", { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: rates({ 'deploy-docs': 0.7, 'check-links': 0.1, 'release-notes': 0.6, '(none)': 0.1 }, { 'deploy-docs': 0.9, 'release-notes': 0.85 }),
    skills: PROJECT,
    disk: PROJECT_FILES,
  })
  await w.submit('发版：更新文档站，再写这次的发布说明')
  await w.step({ index: 0 })

  const second = w.withoutEffort[1]?.body.questions
  // The cookbook's `f"{description_full} — {body[:excerpt]}"`.
  expect(second['skills.which'].criteria).toEqual({
    'deploy-docs': 'Build the docs site and deploy it. — Run the docs build, then push the site.',
    'check-links': 'Check every link of the docs site. — Crawl the built site and list the broken links.',
  })
  expect(Object.keys(second)).toEqual(['skills.which', 'skills.fits.0', 'skills.fits.1', 'skills.fits.2'])
  expect(await picked(w)).toEqual({ suggest: ['deploy-docs'], try: ['release-notes'] })
})

/** Answers each message's two skills requests by the message they ask about: `byMessage[text]` is `[shares, fits]`. */
function byMessage(answers: Record<string, [Record<string, number>, Record<string, number>?]>) {
  return (request: Parameters<ReturnType<typeof rates>>[0]) => {
    const [shares, fits] = answers[request.body.state.user_message] ?? [{ '(none)': 1 }]
    return rates(shares, fits)(request)
  }
}

test('each message gets its own skills decision: the skill suggested, and none once nothing fits', { options: KEY }, async ($, on) => {
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

test("a failed decision request suggests nothing and says nothing: no skills decision for that message, and its main agent's node says why", { options: KEY }, async ($, on) => {
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

test('an answer that leaves the skills questions out suggests nothing, and the effort still goes through', { options: KEY }, async ($, on) => {
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

test('a skill suggested earlier in the conversation is named again without its description', { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: byMessage({
      先写失败的测试: [{ tdd: 0.6, '(none)': 0.4 }, { tdd: 0.9 }],
      '再补边界情况的测试': [{ tdd: 0.5, 'code-review': 0.3, '(none)': 0.2 }, { tdd: 0.8, 'code-review': 0.3 }],
      再审一下: [{ 'code-review': 0.8, '(none)': 0.2 }, { 'code-review': 0.9 }],
    }),
    skills: SKILLS,
  })
  await w.submit('先写失败的测试')
  await w.submit('再补边界情况的测试')
  await w.submit('再审一下')

  expect(w.prompts.map((prompt) => prompt.context)).toEqual([[suggested('tdd', TDD_DESCRIPTION)], [suggested('tdd')], [suggested('code-review', REVIEW_DESCRIPTION)]])
})

test('after /compact or /clear, a skill suggested earlier is described again', { options: KEY }, async ($, on) => {
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

test('a message refused beneath never showed its suggestion, so it is described the next time', { options: KEY }, async ($, on) => {
  let refuse = true
  const w = world($, on, { backend: rates({ tdd: 0.6, '(none)': 0.4 }, { tdd: 0.9 }), skills: SKILLS, beneath: { drop: () => (refuse ? 'blocked by a UserPromptSubmit hook' : undefined) } })
  await w.submit('先写失败的测试')
  refuse = false
  await w.submit('先写失败的测试')

  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]?.context).toEqual([suggested('tdd', TDD_DESCRIPTION)])
})

test('a skill the listing still shows (skillsAlwaysListed) is suggested by name only', { options: { ...KEY, skillsAlwaysListed: ['tdd'] } }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.6, '(none)': 0.4 }, { tdd: 0.88 }), skills: SKILLS })
  await w.submit('先写失败的测试')
  expect(w.prompts[0]?.context).toEqual([suggested('tdd')])
})

test('skills named in skillsNeverSuggested are never offered, to the main agent or to the person', { options: { ...KEY, skillsNeverSuggested: ['code-review', 'grill-me'] } }, async ($, on) => {
  const w = world($, on, { backend: rates({}), skills: WITH_PERSONS, disk: PERSON_FILES })
  await w.submit('审一下这个分支')
  const questions = w.withoutEffort[0]?.body.questions
  expect(Object.keys(questions['skills.which'].criteria)).toEqual(['tdd', 'anthropic-skills:computer-use'])
  // One skill only the person can start is left: no Choice over it, it goes to stage two as it is.
  expect(questions['skills.hint']).toBeUndefined()
  expect(JSON.stringify(w.withoutEffort[1]?.body.questions)).toContain("Does the skill 'ship:release'")
})

test("when the session's skills cannot be read, nothing is asked about them and the main agent keeps its listing", { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: rates({}), skills: { ...SKILLS, listed: null } })
  await w.submit('先写失败的测试')
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(OWN_EFFORT)
  expect(await w.listing(LISTING)).toEqual({ text: LISTING })
})

test('at session start the skills are read, and the debug log says what was found and whether the listing is withheld; no model is asked to write anything', { options: KEY }, async ($, on) => {
  const w = world($, on, { skills: WITH_PERSONS, disk: PERSON_FILES, session: true })
  await w.start()
  // The skills feature's line (the settings line at session start is tests/backend-defaults.test.ts's).
  expect(w.logs.filter((log) => log.text.startsWith('skill'))).toEqual([
    { text: 'skills: 3 the main agent can load, 2 only you can start (/grill-me /ship:release); the listing is withheld from the main agent', to: 'debug' },
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

test('each decision about the skills goes to the decision log (/dp log) and the debug log, never into the conversation', { options: KEY }, async ($, on) => {
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

  // The gate against its bar; what each Choice of stage one put forward with its share; each candidate's fit against the
  // bar, and whom stage two's Choice picked of a kind whose best fit reached it; or that the gate stopped it.
  const first =
    '推荐 tdd · "先写一个失败的测试再实现登录限流"：要不要 skill 0.86（低于 0.30 不推荐）；第一段 tdd 0.72、code-review 0.27、anthropic-skills:computer-use 0.01；只能你触发的 grill-me 0.50、ship:release 0.50；第二段相关度 tdd 0.97、code-review 0.41、anthropic-skills:computer-use 0.00、grill-me 0.00、ship:release 0.00（≥ 0.30 才推荐），选择题选 tdd'
  const second =
    '没有推荐 skill；可试 /grill-me · "这个方案往死里挑刺"：要不要 skill 0.40（低于 0.30 不推荐）；第一段 tdd 0.33、code-review 0.33、anthropic-skills:computer-use 0.33；只能你触发的 grill-me 1.00、ship:release 0.00；第二段相关度 tdd 0.00、code-review 0.00、anthropic-skills:computer-use 0.00、grill-me 0.93、ship:release 0.00（≥ 0.30 才推荐），选择题选 grill-me'
  const third = '没有推荐 skill · "这个报错什么意思"：要不要 skill 0.02（低于 0.30 不推荐）'
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
    { name: 'tdd', description: TDD_DESCRIPTION, by: 'model' },
    { name: 'code-review', description: REVIEW_DESCRIPTION, by: 'model' },
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
  { name: 'ship', description: 'Cut a release.', by: 'person' },
]

test("stage one's questions: a Choice over the skills the main agent can load, one over those only the person can start, each with two or more, and the gate unless left out; no skill, no part", () => {
  const part = skillsPart(OPTIONS)
  const criteria = (id: string) => {
    const question = part?.questions[id]
    return question?.type === 'choice' ? question.criteria : {}
  }
  expect(Object.keys(part?.questions ?? {})).toEqual(['which', 'hint', 'gate.acts_on_user_system', 'gate.would_follow_documented_procedure', 'gate.prose_suffices'])
  expect(criteria('which')).toEqual({ pr: 'Use when writing a PR body.', 'code-review': 'Review the changes since a fixed point.' })
  expect(Object.keys(criteria('hint'))).toEqual(['grill-me', 'ship'])
  // find_skill's: no gate.
  expect(Object.keys(skillsPart(OPTIONS, { gate: false })?.questions ?? {})).toEqual(['which', 'hint'])
  // One skill of a kind: no Choice over it.
  expect(Object.keys(skillsPart(OPTIONS.slice(0, 3), { gate: false })?.questions ?? {})).toEqual(['which'])
  expect(skillsPart([OPTIONS[0] as SkillOption], { gate: false })).toBeNull()
  expect(skillsPart([])).toBeNull()
})

test('a Choice takes at most 255 options, and past its budget every description is cut to the same length, the most that fits', () => {
  const many: SkillOption[] = Array.from({ length: 300 }, (_, i) => ({ name: `skill-${i}`, description: `Skill number ${i}. ${'It does a great many things. '.repeat(20)}`, by: 'model' }))
  const whole = skillsPart(many, { gate: false })?.questions.which
  const names = whole?.type === 'choice' ? Object.keys(whole.criteria) : []
  expect(names).toHaveLength(255)
  expect(names.at(-1)).toBe('skill-254')
  const cut = skillsPart(many, { gate: false, budget: 8000 })?.questions.which
  const texts = cut?.type === 'choice' ? Object.values(cut.criteria) : []
  expect(texts).toHaveLength(255)
  expect(JSON.stringify(cut).length).toBeLessThan(JSON.stringify(whole).length)
  expect(String(texts[0]).startsWith('Skill number 0.')).toBe(true)
})

test("the gate reads as the mean of its three answers, prose_suffices turned round; none answered, no reading", () => {
  const noul = (p: number) => ({ type: 'noul' as const, noul: p })
  const gate = readGate({ 'gate.acts_on_user_system': noul(0.9), 'gate.would_follow_documented_procedure': noul(0.6), 'gate.prose_suffices': noul(0.3) })
  expect(Math.abs((gate?.mean ?? 0) - (0.9 + 0.6 + 0.7) / 3)).toBeLessThan(1e-9)
  expect(gate?.values).toEqual({ acts_on_user_system: 0.9, would_follow_documented_procedure: 0.6, prose_suffices: 0.3 })
  expect(readGate({})).toBeNull()
})

/** A ranking as stage two leaves it. */
function ranking(fits: { name: string; fit: number; by?: 'model' | 'person' }[], winner: string | null, hintWinner: string | null = null): SkillRanking {
  return {
    gate: { mean: 0.8, values: {} },
    shortlist: [],
    hints: [],
    fits: fits.map((fit) => ({ name: fit.name, fit: fit.fit, by: fit.by ?? 'model' })),
    winner,
    hintWinner,
    shares: {},
  }
}

test("what a ranking suggests: the Choice's pick when the best fit of its kind reaches the guide's bar (TypeSafe's ≥ 0.30, Liquid's > 0.5), one of each kind at most", () => {
  const read = ranking(
    [
      { name: 'pr', fit: 0.73 },
      { name: 'code-review', fit: 0.38 },
      { name: 'grill-me', fit: 0.5, by: 'person' },
    ],
    'code-review',
    'grill-me',
  )
  expect(pickSkills(read, OPTIONS, TYPESAFE_GUIDE.skills)).toEqual({
    suggest: [{ ...(OPTIONS[1] as SkillOption), relevance: 0.38 }],
    hint: [{ ...(OPTIONS[2] as SkillOption), relevance: 0.5 }],
  })
  // Liquid's bar must be passed: the person's best fit of 0.5 is not enough.
  expect(pickSkills(read, OPTIONS, LIQUID_GUIDE.skills).hint).toEqual([])
  expect(pickSkills(read, OPTIONS, LIQUID_GUIDE.skills).suggest.map((skill) => skill.name)).toEqual(['code-review'])
  // On the bar: TypeSafe's counts it, Liquid's does not.
  const onBar = ranking([{ name: 'pr', fit: 0.3 }], 'pr')
  expect(pickSkills(onBar, OPTIONS, TYPESAFE_GUIDE.skills).suggest.map((skill) => skill.name)).toEqual(['pr'])
  expect(pickSkills(ranking([{ name: 'pr', fit: 0.5 }], 'pr'), OPTIONS, LIQUID_GUIDE.skills).suggest).toEqual([])
  expect(pickSkills(ranking([{ name: 'pr', fit: 0.29 }], 'pr'), OPTIONS, TYPESAFE_GUIDE.skills).suggest).toEqual([])
  // Stopped by the gate, or stage two failed: nothing.
  expect(pickSkills({ ...read, stopped: 'gate' }, OPTIONS, TYPESAFE_GUIDE.skills)).toEqual({ suggest: [], hint: [] })
  expect(pickSkills({ ...read, failed: { kind: 'timeout', detail: 'late' } }, OPTIONS, TYPESAFE_GUIDE.skills)).toEqual({ suggest: [], hint: [] })
})

test('what find_skill returns: every candidate the main agent can load whose fit reaches the bar, the best first, at most its most', () => {
  const read = { ...ranking([{ name: 'code-review', fit: 0.38 }, { name: 'pr', fit: 0.73 }, { name: 'grill-me', fit: 0.99, by: 'person' }], 'pr'), shares: { pr: 0.5, 'code-review': 0.5 } }
  expect(findSkills(read, OPTIONS, TYPESAFE_GUIDE.skills, 5).map((skill) => [skill.name, skill.relevance])).toEqual([
    ['pr', 0.73],
    ['code-review', 0.38],
  ])
  expect(findSkills(read, OPTIONS, LIQUID_GUIDE.skills, 5).map((skill) => skill.name)).toEqual(['pr'])
  expect(findSkills(read, OPTIONS, TYPESAFE_GUIDE.skills, 1).map((skill) => skill.name)).toEqual(['pr'])
})

test("the block beside a message is the cookbook's suggestion_block: the one skill, described the first time, or that none appears relevant", () => {
  const pick = { ...(OPTIONS[0] as SkillOption), relevance: 0.8 }
  expect(relevanceBlock(pick)).toBe(suggested('pr', 'Use when writing a PR body.'))
  expect(relevanceBlock(pick, new Set(['pr']))).toBe(suggested('pr'))
  expect(relevanceBlock(null)).toBe(NONE_BLOCK)
})

test("stage two reads the opening of a SKILL.md as the cookbook's body[:700]: the frontmatter off, whitespace collapsed, 700 characters", () => {
  const body = 'word '.repeat(400)
  const opening = skillOpening(`---\nname: x\ndescription: y\n---\n\n# Title\n\n${body}`)
  expect(opening.startsWith('# Title word word')).toBe(true)
  expect(Array.from(opening)).toHaveLength(EXCERPT_CHARS)
  expect(skillOpening('---\nname: x\n---\n')).toBe('')
})

test('the gate below its bar stops the ranking before stage two: nothing more is sent; find_skill asks no gate and re-reads as many as it may return', async () => {
  let sent = 0
  const io = { ask: async () => ((sent += 1), { ok: false as const, failure: { kind: 'timeout' as const, detail: 'not sent' } }), opening: async () => null }
  const noul = (p: number) => ({ type: 'noul' as const, noul: p })
  const message = modRanker(io, { gate: true, shortlist: 3, timeoutMs: 1000, bars: TYPESAFE_GUIDE.skills })
  const stopped = await message.rank({ 'gate.acts_on_user_system': noul(0.1), 'gate.would_follow_documented_procedure': noul(0.2), 'gate.prose_suffices': noul(0.9) }, OPTIONS, { state: {} })
  expect(stopped?.stopped).toBe('gate')
  expect(sent).toBe(0)
  // No gate answered where it was asked: no ranking.
  expect(await message.rank({ which: { type: 'choice', choice: 'pr', probabilities: { pr: 1, 'code-review': 0 }, confidence: 1 } }, OPTIONS, { state: {} })).toBeNull()
  const find = modRanker(io, { gate: false, shortlist: 5, timeoutMs: 1000, bars: TYPESAFE_GUIDE.skills })
  expect(Object.keys(find.part(OPTIONS)?.questions ?? {})).toEqual(['which', 'hint'])
  const failed = await find.rank({ which: { type: 'choice', choice: 'pr', probabilities: { pr: 0.9, 'code-review': 0.1 }, confidence: 0.9 }, hint: { type: 'choice', choice: 'ship', probabilities: { 'grill-me': 0.4, ship: 0.6 }, confidence: 0.2 } }, OPTIONS, { state: {} })
  expect(failed?.shortlist.map((entry) => entry.name)).toEqual(['pr', 'code-review'])
  expect(failed?.failed?.kind).toBe('timeout')
  expect(sent).toBe(1)
})
