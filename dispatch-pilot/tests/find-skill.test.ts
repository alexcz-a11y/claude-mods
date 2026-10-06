// find_skill (#12): mid-turn, the main agent asks for the skills that fit a
// piece of work. Seam 1: the engine's session start and tool call in; what
// reaches the decision backend, the tool's answer, the board data and the
// logs out; a failed call is a note on the board.

import { expect, test } from 'claude-code/testing'
import { profileKey } from '../hooks/core/profiles.ts'
import { asClef, CLEF_OPTIONS } from './support/cloudflare.ts'
import type { Reply, Sent, SkillsWorld } from './support/world.ts'
import { isSecondSkillsRequest, rates, world } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }

// A session's skills as Claude Code reports them: three the main agent can
// load (one synced from claude.ai), one only the person can start.
const SKILLS = {
  commands: [
    { name: 'tdd', description: 'Test-driven development. Use when the user wants to build features or fix bugs test-first.', source: 'user' },
    { name: 'code-review', description: 'Review the changes since a fixed point along two axes: Standards and Spec.', source: 'user' },
    { name: 'pdf', description: 'Use this skill whenever the user wants to do anything with PDF files: read, fill in forms, merge, split.', source: 'user' },
    { name: 'grill-me', description: 'Interview the user relentlessly about a plan until every branch is resolved.', source: 'user' },
  ],
  listed: [
    { name: 'tdd', source: 'userSettings', tokens: 52 },
    { name: 'code-review', source: 'userSettings', tokens: 144 },
    { name: 'pdf', source: 'syncedSkills', tokens: 300 },
  ],
} satisfies SkillsWorld
const PERSON_FILES: Record<string, string> = {
  '/home/u/.claude/skills/grill-me/SKILL.md': '---\nname: grill-me\ndisable-model-invocation: true\n---\nAsk one question at a time.\n',
}

const PDF_DESCRIPTION = 'Use this skill whenever the user wants to do anything with PDF files: read, fill in forms, merge, split.'
const REVIEW_DESCRIPTION = 'Review the changes since a fixed point along two axes: Standards and Spec.'
/** How an answer that brings no skill ends. */
const SKILL_TOOL_LINE = 'Carry on without it, or load a skill you know with the Skill tool by its exact name.'

// Jev's answers come from `rates(shares, fits)` (support/world.ts): the first
// request's shares of the skills question, then the second request's fit of
// each skill re-read (#11: the fit is the relevance that comes back).

// ---- Registration -------------------------------------------------------------

test('at session start find_skill is registered: it takes a query, and its description names no skill and stays the same however the skills and switches change', { options: KEY }, async ($, on) => {
  const skills = { commands: [...SKILLS.commands], listed: [...SKILLS.listed] }
  const w = world($, on, { skills, disk: PERSON_FILES, session: true })
  await w.start()
  // Reloaded later in a session whose skills and switches have changed since.
  skills.commands.push({ name: 'wrangler', description: 'Deploy Cloudflare Workers with Wrangler.', source: 'user' })
  skills.listed.push({ name: 'wrangler', source: 'userSettings', tokens: 40 })
  await w.command('dp', 'find-skill off')
  await w.start()

  expect(w.tools).toHaveLength(2)
  const [first, again] = w.tools
  expect(first?.name).toBe('find_skill')
  expect(first?.inputSchema).toMatchObject({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] })
  for (const name of ['tdd', 'code-review', 'pdf', 'grill-me', 'wrangler']) expect(first?.description).not.toContain(name)
  expect(again).toEqual(first)
})

test('without a decision model find_skill is not registered: nothing could rate the skills, and the main agent keeps its full listing', async ($, on) => {
  const listing = [
    'The following skills are available for use with the Skill tool:',
    '',
    `- tdd: ${SKILLS.commands[0]?.description}`,
    `- code-review: ${REVIEW_DESCRIPTION}`,
    `- anthropic-skills:pdf: ${PDF_DESCRIPTION}`,
  ].join('\n')
  const w = world($, on, { skills: SKILLS, session: true })
  await w.start()
  expect(w.tools).toEqual([])
  expect(await w.listing(listing)).toEqual({ text: listing })
})

// ---- What it asks and what it answers -------------------------------------------

test("find_skill's answer names the skills that fit, most relevant first, each by the name the Skill tool takes, with its relevance and description", { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: rates({ 'anthropic-skills:pdf': 0.7, 'code-review': 0.2, tdd: 0.02, '(none)': 0.08 }, { 'anthropic-skills:pdf': 0.93, 'code-review': 0.61 }),
    skills: SKILLS,
    disk: PERSON_FILES,
  })
  const answer = await w.findSkill('fill in a form in a PDF')

  expect(answer.result).toBe(
    [
      'Skills that fit "fill in a form in a PDF", rated by Dispatch Pilot’s decision model (relevance 0 to 1), most relevant first. Load one with the Skill tool by its exact name if it fits the work:',
      `- anthropic-skills:pdf (relevance 0.93): ${PDF_DESCRIPTION}`,
      `- code-review (relevance 0.61): ${REVIEW_DESCRIPTION}`,
    ].join('\n'),
  )
})

test('the decision model reads the work the main agent names and the recent conversation, by the same rules as beside a message: the text and the tools called, never their output', { options: KEY }, async ($, on) => {
  const messages = [
    { role: 'user' as const, text: '把这份合同 PDF 里的表格填好，再发给我', toolUses: [] },
    { role: 'assistant' as const, text: '先看看文件。', toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: { file_path: 'contract.pdf' }, text: 'CONTRACT BODY' }] },
    { role: 'user' as const, text: '', toolUses: [] },
    { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'u2', tool: 'mcp__dispatch-pilot__find_skill', input: { query: 'fill in a form in a PDF' } }] },
  ]
  const w = world($, on, { backend: rates({ 'anthropic-skills:pdf': 0.9, '(none)': 0.1 }, { 'anthropic-skills:pdf': 0.9 }), skills: SKILLS, disk: PERSON_FILES, messages })
  await w.findSkill('fill in a form in a PDF')

  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['skills.which'])
  expect(w.requests[0]?.body.state).toEqual({
    user_message: 'fill in a form in a PDF',
    recent_context: 'user: 把这份合同 PDF 里的表格填好，再发给我\nassistant: [tools: Read, mcp__dispatch-pilot__find_skill] 先看看文件。',
  })
  // The skill rated in the first request is re-read in a second (#11), about the same work and conversation.
  expect(w.requests).toHaveLength(2)
  expect(Object.keys(w.requests[1]?.body.questions)).toEqual(['skills.fits.0'])
  expect(w.requests[1]?.body.state).toEqual(w.requests[0]?.body.state)
})

test('find_skill asks the very question a message asks about the skills the main agent can load: the same skills in the same order, in the same words; the question on those only the person can start it leaves out', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ '(none)': 1 }), skills: SKILLS, disk: PERSON_FILES })
  await w.submit('先把合同里的表格填好')
  await w.findSkill('fill in a form in a PDF')

  expect(w.requests).toHaveLength(2)
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['effort.level', 'skills.which', 'skills.hint'])
  const beside = w.requests[0]?.body.questions['skills.which']
  expect(Object.keys(beside.criteria)).toEqual(['tdd', 'code-review', 'anthropic-skills:pdf', '(none)'])
  expect(w.requests[1]?.body.questions).toEqual({ 'skills.which': beside })
})

test('find_skill speaks only when called: the steps around the call ask nothing about skills, and its answer is the tool result alone', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.8, '(none)': 0.2 }, { tdd: 0.9 }), skills: SKILLS, disk: PERSON_FILES })
  await w.submit('先写一个失败的测试')
  await w.step({ index: 0 })
  const answer = await w.findSkill('write the tests first')
  await w.step({ index: 1 })
  await w.step({ index: 2 })

  // The message's two requests, then the call's two: none for the steps.
  expect(w.requests.map((request) => Object.keys(request.body.questions))).toEqual([['effort.level', 'skills.which', 'skills.hint'], ['skills.fits.0'], ['skills.which'], ['skills.fits.0']])
  expect(answer.context).toBeUndefined()
})

// ---- How many come back -------------------------------------------------------

test('findSkillMax caps how many skills come back, the most relevant first', { options: { ...KEY, findSkillMax: 1 } }, async ($, on) => {
  const w = world($, on, {
    backend: rates({ 'anthropic-skills:pdf': 0.5, 'code-review': 0.3, tdd: 0.15, '(none)': 0.05 }, { 'anthropic-skills:pdf': 0.92, 'code-review': 0.6, tdd: 0.55 }),
    skills: SKILLS,
    disk: PERSON_FILES,
  })
  const answer = String((await w.findSkill('fill in a form in a PDF')).result)
  expect(answer).toContain('\n- anthropic-skills:pdf (relevance 0.92): ')
  expect(answer).not.toContain('code-review')
  expect(answer).not.toContain('tdd')
})

test('findSkillMinRelevance is the relevance a skill needs to come back', { options: { ...KEY, findSkillMinRelevance: 0.4 } }, async ($, on) => {
  const w = world($, on, { backend: rates({ 'anthropic-skills:pdf': 0.45, 'code-review': 0.35, '(none)': 0.2 }, { 'anthropic-skills:pdf': 0.45, 'code-review': 0.35 }), skills: SKILLS, disk: PERSON_FILES })
  const answer = String((await w.findSkill('fill in a form in a PDF')).result)
  expect(answer).toContain('\n- anthropic-skills:pdf (relevance 0.45): ')
  expect(answer).not.toContain('code-review')
})

test('when no skill reaches the bar the answer says so, and still points at the Skill tool', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.06, '(none)': 0.94 }, { tdd: 0.04 }), skills: SKILLS, disk: PERSON_FILES })
  const answer = await w.findSkill('rename a variable')
  expect(answer.result).toBe(
    'No skill fits "rename a variable": none reached relevance 0.50. Carry on without one, try other words for the work, or load a skill you know with the Skill tool by its exact name.',
  )
})

test('a second request that fails is a failure: find_skill says it could not rate the skills, and why', { options: KEY }, async ($, on) => {
  const answer1 = rates({ tdd: 0.8, '(none)': 0.2 }, { tdd: 0.9 })
  const w = world($, on, { backend: (request) => (isSecondSkillsRequest(request) ? { status: 503, body: 'overloaded' } : answer1(request)), skills: SKILLS, disk: PERSON_FILES })
  const answer = await w.findSkill('write the tests first')

  expect(answer.result).toBe(`find_skill could not rate the skills (jev: busy (HTTP 503)). ${SKILL_TOOL_LINE}`)
  expect((await w.board()).notes).toMatchObject([{ feature: 'find-skill', kind: 'failed', why: 'jev：繁忙（状态码 503）' }])
})

// ---- Skills that never come back -------------------------------------------------

test('a skill only the person can start is neither asked about nor returned to the main agent, however well it would fit', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ 'grill-me': 0.55, 'code-review': 0.3, '(none)': 0.15 }, { 'grill-me': 0.97, 'code-review': 0.62 }), skills: SKILLS, disk: PERSON_FILES })
  const answer = String((await w.findSkill('poke holes in this plan')).result)
  expect(JSON.stringify(w.requests.map((request) => request.body.questions))).not.toContain('grill-me')
  expect(answer).toContain(`\n- code-review (relevance 0.62): ${REVIEW_DESCRIPTION}`)
  expect(answer).not.toContain('grill-me')
})

test('skills named in skillsNeverSuggested are neither asked about nor returned', { options: { ...KEY, skillsNeverSuggested: ['code-review', 'grill-me'] } }, async ($, on) => {
  const w = world($, on, { backend: rates({ 'code-review': 0.8, '(none)': 0.2 }), skills: SKILLS, disk: PERSON_FILES })
  const answer = String((await w.findSkill('review a branch before merging')).result)
  expect(Object.keys(w.requests[0]?.body.questions['skills.which'].criteria)).toEqual(['tdd', 'anthropic-skills:pdf', '(none)'])
  expect(answer).not.toContain('code-review')
})

// ---- Switches -------------------------------------------------------------------

test('switched off (/dp find-skill off), find_skill says so when called and asks nothing; /dp lists its switch', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 1 }), skills: SKILLS, disk: PERSON_FILES })
  expect(await w.command('dp', 'status')).toMatch(/开 +find-skill +回答主 agent 的 find_skill/)
  await w.command('dp', 'find-skill off')
  const answer = await w.findSkill('write the tests first')

  expect(answer.result).toBe(`find_skill is switched off (/dp find-skill on turns it back on), so it rated no skills. ${SKILL_TOOL_LINE}`)
  expect(w.requests).toHaveLength(0)
})

test('with Dispatch Pilot switched off (/dp off), find_skill says so when called and asks nothing', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 1 }), skills: SKILLS, disk: PERSON_FILES })
  await w.command('dp', 'off')
  const answer = await w.findSkill('write the tests first')

  expect(answer.result).toBe(`Dispatch Pilot is switched off (/dp on turns it back on), so find_skill rated no skills. ${SKILL_TOOL_LINE}`)
  expect(w.requests).toHaveLength(0)
})

test('find_skill has a switch of its own: with the suggestions off since an earlier session (so the skills were not read at its start), it reads them and answers', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.8, '(none)': 0.2 }, { tdd: 0.8 }), skills: SKILLS, disk: PERSON_FILES, store: { switches: { skills: false } }, session: true })
  await w.start()
  const answer = String((await w.findSkill('write the tests first')).result)

  expect(Object.keys(w.requests[0]?.body.questions['skills.which'].criteria)).toEqual(['tdd', 'code-review', 'anthropic-skills:pdf', '(none)'])
  expect(answer).toContain('\n- tdd (relevance 0.80): ')
})

// ---- Failures: answered at once, never blocking -----------------------------------

test('a failed decision request: find_skill answers at once that it could not rate the skills, and why; the board notes it', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: () => ({ status: 503, body: 'overloaded' }), skills: SKILLS, disk: PERSON_FILES })
  const answer = await w.findSkill('fill in a form in a PDF')

  expect(answer.result).toBe(`find_skill could not rate the skills (jev: busy (HTTP 503)). ${SKILL_TOOL_LINE}`)
  expect((await w.board()).notes).toMatchObject([{ feature: 'find-skill', kind: 'failed', why: 'jev：繁忙（状态码 503）' }])
})

test('no answer within timeoutMs: find_skill stops waiting and says so; the board notes it', { options: { ...KEY, timeoutMs: 800 } }, async ($, on) => {
  const w = world($, on, { backend: (request) => ({ after: 60_000, reply: rates({ tdd: 1 })(request) }), skills: SKILLS, disk: PERSON_FILES })
  const calling = w.findSkill('write the tests first')
  await w.clock.settle() // the hook is now waiting on the request and its timer
  await w.clock.advance(800)
  const answer = await calling

  expect(answer.result).toBe(`find_skill could not rate the skills (jev: no answer in 800 ms). ${SKILL_TOOL_LINE}`)
  expect((await w.board()).notes).toMatchObject([{ feature: 'find-skill', kind: 'failed', why: 'jev：800 毫秒内没有回答' }])
})

// The hook has 10 seconds; timeoutMs is at most 8000, so the two requests share it, as beside a message.
test('both requests share one wait: the second gets what the first left of timeoutMs, and given up, find_skill says so', { options: { ...KEY, timeoutMs: 1500 } }, async ($, on) => {
  const answer1 = rates({ tdd: 0.8, '(none)': 0.2 }, { tdd: 0.9 })
  // The first request answers after 400 ms; the second would take a minute.
  const w = world($, on, { backend: (request) => (isSecondSkillsRequest(request) ? { after: 60_000, reply: answer1(request) } : { after: 400, reply: answer1(request) }), skills: SKILLS, disk: PERSON_FILES })
  const calling = w.findSkill('write the tests first')
  await w.clock.settle()
  await w.clock.advance(400)
  await w.clock.advance(1100)
  const answer = await calling

  expect(w.requests).toHaveLength(2)
  expect(answer.result).toBe(`find_skill could not rate the skills (jev: no answer in 1100 ms). ${SKILL_TOOL_LINE}`)
  expect((await w.board()).notes).toMatchObject([{ feature: 'find-skill', kind: 'failed', why: 'jev：1100 毫秒内没有回答' }])
})

// ---- By decision model: how long the call waits, what its first request offers ----------

// The wait is the decision model's (core/setup.ts BACKEND_DEFAULTS), set by latency, not calibrated: with Jev
// a message's (timeoutMs); with Clef 8000 ms, for Clef's first request alone takes past its 3000 ms (#16, #17).
const WAITS = [
  { name: 'Jev', options: KEY, reply: (answer: (request: Sent) => Reply) => answer, wait: 1500, backend: 'jev' },
  { name: 'Clef', options: CLEF_OPTIONS, reply: asClef, wait: 8000, backend: 'clef' },
] as const

for (const chosen of WAITS) {
  test(`with ${chosen.name}, find_skill's two requests share ${chosen.wait} ms in all: the second gets what the first left, and given up, the call says so`, { options: chosen.options }, async ($, on) => {
    const answer = chosen.reply(rates({ tdd: 0.8, '(none)': 0.2 }, { tdd: 0.9 }))
    // The first request answers 400 ms before the wait is over; the second would take a minute.
    const w = world($, on, { backend: (request) => ({ after: isSecondSkillsRequest(request) ? 60_000 : chosen.wait - 400, reply: answer(request) }), skills: SKILLS, disk: PERSON_FILES })
    const calling = w.findSkill('write the tests first')
    await w.clock.settle()
    await w.clock.advance(chosen.wait - 400)
    await w.clock.advance(400)
    const result = await calling

    expect(w.requests).toHaveLength(2)
    expect(result.result).toBe(`find_skill could not rate the skills (${chosen.backend}: no answer in 400 ms). ${SKILL_TOOL_LINE}`)
  })
}

test('with Clef, find_skill waits past the 3000 ms a message waits: a first request answered at 5 s still brings the skills back', { options: CLEF_OPTIONS }, async ($, on) => {
  const answer = asClef(rates({ tdd: 0.8, '(none)': 0.2 }, { tdd: 0.9 }))
  const w = world($, on, { backend: (request) => ({ after: isSecondSkillsRequest(request) ? 1000 : 5000, reply: answer(request) }), skills: SKILLS, disk: PERSON_FILES })
  const calling = w.findSkill('write the tests first')
  await w.clock.settle()
  await w.clock.advance(5000)
  await w.clock.advance(1000)

  expect(String((await calling).result)).toContain('\n- tdd (relevance 0.90): ')
})

/** A profile whose every field names its skill, so a request shows whose it is. */
function profileOf(name: string) {
  return {
    en: { what: `${name}: what it does`, use_when: `${name}: when to use it`, not_for: `${name}: when not to` },
    zh: { what: `${name}：用途`, use_when: `${name}：何时用`, not_for: `${name}：何时不用` },
  }
}

/** The store as an earlier session left it: a profile of each skill the main agent can load (none has a SKILL.md here: each was written from its description). */
function storedProfiles(): Record<string, unknown> {
  const skills = [
    { name: 'tdd', description: SKILLS.commands[0]?.description ?? '' },
    { name: 'code-review', description: REVIEW_DESCRIPTION },
    { name: 'anthropic-skills:pdf', description: PDF_DESCRIPTION },
  ]
  return Object.fromEntries(skills.map((skill) => [profileKey(skill, null, 'haiku'), { name: skill.name, at: 1, profile: profileOf(skill.name) }]))
}

/** What a skill with a profile is offered as. */
function offered(name: string) {
  const { en, zh } = profileOf(name)
  return { what: en.what, use_when: en.use_when, not_for: en.not_for, 用途: zh.what, 何时用: zh.use_when, 何时不用: zh.not_for }
}

test("with Jev, find_skill's first request offers each skill by its profile, as a message's does; the second re-reads it by its profile too", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.8, '(none)': 0.2 }, { tdd: 0.9 }), skills: SKILLS, disk: PERSON_FILES, store: storedProfiles() })
  await w.findSkill('write the tests first')

  expect(w.requests[0]?.body.questions['skills.which'].criteria.tdd).toEqual(offered('tdd'))
  expect(w.requests[1]?.body.questions['skills.fits.0'].instructions.skill).toMatchObject(offered('tdd'))
})

test("with Clef, find_skill's first request offers each skill by its description, profiles or not (Clef took 3.7-7.9 s over every profile); the second still re-reads it by its profile", { options: CLEF_OPTIONS }, async ($, on) => {
  const w = world($, on, { backend: asClef(rates({ tdd: 0.8, '(none)': 0.2 }, { tdd: 0.9 })), skills: SKILLS, disk: PERSON_FILES, store: storedProfiles() })
  const answer = await w.findSkill('write the tests first')

  expect(w.requests[0]?.body.questions['skills.which'].criteria.tdd).toBe(SKILLS.commands[0]?.description)
  expect(w.requests[1]?.body.questions['skills.fits.0'].instructions.skill).toMatchObject(offered('tdd'))
  expect(String(answer.result)).toContain('\n- tdd (relevance 0.90): ')
})

test('an answer that leaves the skills question out is a failure too', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: () => ({ status: 200, body: { model: 'jev-1.13.0', answers: {} } }), skills: SKILLS, disk: PERSON_FILES })
  const answer = await w.findSkill('write the tests first')

  expect(answer.result).toBe(`find_skill could not rate the skills (jev: unreadable answer). ${SKILL_TOOL_LINE}`)
  expect((await w.board()).notes).toMatchObject([{ feature: 'find-skill', kind: 'failed', why: 'jev：回答读不懂' }])
})

test("when the session's skills cannot be read, find_skill says so and asks nothing", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 1 }), skills: { ...SKILLS, listed: null } })
  const answer = await w.findSkill('write the tests first')

  expect(answer.result).toBe(`find_skill could not read this session's skills. ${SKILL_TOOL_LINE}`)
  expect(w.requests).toHaveLength(0)
  expect((await w.board()).notes).toMatchObject([{ feature: 'find-skill', kind: 'skipped', why: 'unread' }])
})

test('an error of its own still gets the main agent an answer, and the board and the debug log say what happened', { options: KEY }, async ($, on) => {
  on('state.get', (_$, e, next) => (e.key === 'skillCatalog' ? { deny: 'state store unavailable' } : next(e)))
  const w = world($, on, { backend: rates({ tdd: 1 }), skills: SKILLS, disk: PERSON_FILES })
  const answer = await w.findSkill('write the tests first')

  expect(answer.result).toBe(`find_skill could not rate the skills (an error in Dispatch Pilot, written to the debug log). ${SKILL_TOOL_LINE}`)
  expect((await w.board()).notes).toMatchObject([{ feature: 'find-skill', kind: 'skipped', why: 'error' }])
  expect(w.logs.map((log) => log.text)).toEqual([expect.stringContaining('find_skill failed: ')])
  expect(w.logs[0]?.text).toContain('state store unavailable')
})

// ---- The board and the logs ------------------------------------------------------

test('each call that rates the skills is a decision on the board data: what find_skill returned, or that no skill fits; a failed call is none', { options: KEY }, async ($, on) => {
  const pdf = rates({ 'anthropic-skills:pdf': 0.7, 'code-review': 0.2, '(none)': 0.1 }, { 'anthropic-skills:pdf': 0.95, 'code-review': 0.5 })
  const w = world($, on, {
    backend: (request, n) => (n === 1 ? { status: 503, body: 'overloaded' } : request.body.state.user_message === 'rename a variable' ? rates({ '(none)': 1 })(request) : pdf(request)),
    skills: SKILLS,
    disk: PERSON_FILES,
  })
  await w.findSkill('fill in a form in a PDF')
  expect((await w.board()).log).toEqual([])
  await w.findSkill('fill in a form in a PDF')
  await w.findSkill('rename a variable')

  const [found, none] = (await w.board()).log
  expect(found).toMatchObject({ n: 1, feature: 'find-skill', agent: 'main', tone: 'ok', subject: '"fill in a form in a PDF"', outcome: '查到 anthropic-skills:pdf、code-review' })
  expect(found?.skills?.suggest.map((skill) => [skill.name, skill.relevance])).toEqual([
    ['anthropic-skills:pdf', 0.95],
    ['code-review', 0.5],
  ])
  expect(found?.skills?.try).toEqual([])
  expect(none).toMatchObject({ n: 2, tone: 'info', subject: '"rename a variable"', outcome: '没查到 skill', skills: { suggest: [], try: [] } })
})

test('each call goes to the debug log (its requests, what it returned and why) and its decision to /dp log, never into the conversation', { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: (request, n) =>
      n <= 2 ? rates({ 'anthropic-skills:pdf': 0.7, 'code-review': 0.2, tdd: 0.02, '(none)': 0.08 }, { 'anthropic-skills:pdf': 0.93, 'code-review': 0.61 })(request) : { status: 500, body: 'boom' },
    skills: SKILLS,
    disk: PERSON_FILES,
  })
  await w.findSkill('fill in a form in a PDF')
  await w.findSkill('review a branch before merging')

  // What each stage said: the first request's shares of the skills it put forward, the second's fits.
  const decision =
    '查到 anthropic-skills:pdf、code-review · "fill in a form in a PDF"：第一段 anthropic-skills:pdf 0.70、code-review 0.20、都不合适 0.08；第二段相关度 anthropic-skills:pdf 0.93、code-review 0.61；相关度 0.50 起返回，最多 5 个'
  expect(w.logs).toEqual([
    { text: 'request [skills.which] to jev for find_skill "fill in a form in a PDF": answered in 0 ms by jev-1.13.0 (300 input tokens)', to: 'debug' },
    { text: 'second request [skills.best, skills.fits.0, skills.fits.1] to jev for find_skill "fill in a form in a PDF": answered in 0 ms by jev-1.13.0 (300 input tokens)', to: 'debug' },
    { text: decision, to: 'debug' },
    { text: 'request [skills.which] to jev for find_skill "review a branch before merging": http: HTTP 500: boom (0 ms)', to: 'debug' },
  ])
  expect((await w.command('dp', 'log 10')).split('\n')).toEqual(['最近 1 条决定，最新的在最后', `#1 find-skill：${decision}`])
  expect((await w.board()).log.map((entry) => [entry.n, entry.feature, entry.skills?.suggest.map((skill) => skill.name)])).toEqual([[1, 'find-skill', ['anthropic-skills:pdf', 'code-review']]])
})

// ---- Calls it does not rate -------------------------------------------------------

test("a dispatched agent's call is pointed at its own skill listing, which the mod leaves whole; nothing is asked", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 1 }), skills: SKILLS, disk: PERSON_FILES })
  const answer = await w.findSkill('write the tests first', { agentId: 'a1' })

  expect(answer.result).toBe(
    "find_skill rates skills for the main agent, whose skill listing is cut short. Yours lists this session's skills: pick from it and load one with the Skill tool by its exact name.",
  )
  expect(w.requests).toHaveLength(0)
})

test('a call without a query asks for one, and nothing is asked of the decision model', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 1 }), skills: SKILLS, disk: PERSON_FILES })
  const answer = await w.findSkill('   ')

  expect(answer.result).toBe('find_skill needs a query: a few words on the kind of work you need a skill for.')
  expect(w.requests).toHaveLength(0)
})

test('a session with no skill to offer: find_skill says so and asks nothing', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({}), skills: { commands: [], listed: [] } })
  const answer = await w.findSkill('write the tests first')

  expect(answer.result).toBe(`This session has no skill that find_skill could return. ${SKILL_TOOL_LINE}`)
  expect(w.requests).toHaveLength(0)
})
