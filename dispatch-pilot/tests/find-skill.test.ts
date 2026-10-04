// find_skill (#12): mid-turn, the main agent asks for the skills that fit a
// piece of work. Seam 1: the engine's session start and tool call in; what
// reaches the decision backend, the tool's answer, the status line and the
// logs out.

import { expect, test } from 'claude-code/testing'
import type { SkillsWorld } from './support/world.ts'
import { jev, world } from './support/world.ts'

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
  const w = world($, on, { skills: SKILLS, session: true })
  await w.start()
  expect(w.tools).toEqual([])
})

/** Jev's answer to whatever is asked: these shares of the skills question (effort medium, if asked). */
function rates(shares: Record<string, number>) {
  return jev([0, 1, 0, 0, 0], { shares: { 'skills.which': shares } })
}

const PDF_DESCRIPTION = 'Use this skill whenever the user wants to do anything with PDF files: read, fill in forms, merge, split.'
const REVIEW_DESCRIPTION = 'Review the changes since a fixed point along two axes: Standards and Spec.'

test("find_skill's answer names the skills that fit, most relevant first, each by the name the Skill tool takes, with its relevance and description", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ 'anthropic-skills:pdf': 0.7, 'code-review': 0.2, tdd: 0.02, '(none)': 0.08 }), skills: SKILLS, disk: PERSON_FILES })
  const answer = await w.findSkill('fill in a form in a PDF')

  expect(answer.result).toBe(
    [
      'Skills that fit "fill in a form in a PDF", rated by Dispatch Pilot’s decision model (relevance 0 to 1), most relevant first. Load one with the Skill tool by its exact name if it fits the work:',
      `- anthropic-skills:pdf (relevance 0.70): ${PDF_DESCRIPTION}`,
      `- code-review (relevance 0.20): ${REVIEW_DESCRIPTION}`,
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
  const w = world($, on, { backend: rates({ 'anthropic-skills:pdf': 0.9, '(none)': 0.1 }), skills: SKILLS, disk: PERSON_FILES, messages })
  await w.findSkill('fill in a form in a PDF')

  expect(w.requests).toHaveLength(1)
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['skills.which'])
  expect(w.requests[0]?.body.state).toEqual({
    user_message: 'fill in a form in a PDF',
    recent_context: 'user: 把这份合同 PDF 里的表格填好，再发给我\nassistant: [tools: Read, mcp__dispatch-pilot__find_skill] 先看看文件。',
  })
})

test('find_skill asks the very question a message asks about the skills: the same skills in the same order (those only the person can start among them), in the same words', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ '(none)': 1 }), skills: SKILLS, disk: PERSON_FILES })
  await w.submit('先把合同里的表格填好')
  await w.findSkill('fill in a form in a PDF')

  expect(w.requests).toHaveLength(2)
  const beside = w.requests[0]?.body.questions['skills.which']
  expect(Object.keys(beside.criteria)).toEqual(['tdd', 'code-review', 'anthropic-skills:pdf', 'grill-me', '(none)'])
  expect(w.requests[1]?.body.questions['skills.which']).toEqual(beside)
})

test('findSkillMax caps how many skills come back, the most relevant first', { options: { ...KEY, findSkillMax: 1 } }, async ($, on) => {
  const w = world($, on, { backend: rates({ 'anthropic-skills:pdf': 0.5, 'code-review': 0.3, tdd: 0.15, '(none)': 0.05 }), skills: SKILLS, disk: PERSON_FILES })
  const answer = String((await w.findSkill('fill in a form in a PDF')).result)
  expect(answer).toContain('\n- anthropic-skills:pdf (relevance 0.50): ')
  expect(answer).not.toContain('code-review')
  expect(answer).not.toContain('tdd')
})

test('findSkillMinRelevance is the relevance a skill needs to come back', { options: { ...KEY, findSkillMinRelevance: 0.4 } }, async ($, on) => {
  const w = world($, on, { backend: rates({ 'anthropic-skills:pdf': 0.45, 'code-review': 0.35, '(none)': 0.2 }), skills: SKILLS, disk: PERSON_FILES })
  const answer = String((await w.findSkill('fill in a form in a PDF')).result)
  expect(answer).toContain('\n- anthropic-skills:pdf (relevance 0.45): ')
  expect(answer).not.toContain('code-review')
})

test('a skill only the person can start never comes back to the main agent, even as the best fit', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ 'grill-me': 0.55, 'code-review': 0.3, '(none)': 0.15 }), skills: SKILLS, disk: PERSON_FILES })
  const answer = String((await w.findSkill('poke holes in this plan')).result)
  expect(answer).toContain(`\n- code-review (relevance 0.30): ${REVIEW_DESCRIPTION}`)
  expect(answer).not.toContain('grill-me')
})

test('skills named in skillsNeverSuggested are neither asked about nor returned', { options: { ...KEY, skillsNeverSuggested: ['code-review', 'grill-me'] } }, async ($, on) => {
  const w = world($, on, { backend: rates({ 'code-review': 0.8, '(none)': 0.2 }), skills: SKILLS, disk: PERSON_FILES })
  const answer = String((await w.findSkill('review a branch before merging')).result)
  expect(Object.keys(w.requests[0]?.body.questions['skills.which'].criteria)).toEqual(['tdd', 'anthropic-skills:pdf', '(none)'])
  expect(answer).not.toContain('code-review')
})

const SKILL_TOOL_LINE = 'Carry on without it, or load a skill you know with the Skill tool by its exact name.'

test('switched off (/dp find-skill off), find_skill says so when called and asks nothing; /dp lists its switch', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 1 }), skills: SKILLS, disk: PERSON_FILES })
  expect(await w.command('dp')).toMatch(/\bon +find-skill +answers the main agent's find_skill/)
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
  const w = world($, on, { backend: rates({ tdd: 0.8, '(none)': 0.2 }), skills: SKILLS, disk: PERSON_FILES, store: { switches: { skills: false } }, session: true })
  await w.start()
  const answer = String((await w.findSkill('write the tests first')).result)

  expect(Object.keys(w.requests[0]?.body.questions['skills.which'].criteria)).toEqual(['tdd', 'code-review', 'anthropic-skills:pdf', 'grill-me', '(none)'])
  expect(answer).toContain('\n- tdd (relevance 0.80): ')
})

test('a failed decision request: find_skill answers at once that it could not rate the skills, and why; the status line reports it', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: () => ({ status: 503, body: 'overloaded' }), skills: SKILLS, disk: PERSON_FILES })
  const answer = await w.findSkill('fill in a form in a PDF')

  expect(answer.result).toBe(`find_skill could not rate the skills (jev: busy (HTTP 503)). ${SKILL_TOOL_LINE}`)
  expect(w.status()).toBe('dp find_skill failed (jev: busy (HTTP 503))')
})

test('no answer within timeoutMs: find_skill stops waiting and says so; the status line reports it', { options: { ...KEY, timeoutMs: 800 } }, async ($, on) => {
  const w = world($, on, { backend: (request) => ({ after: 60_000, reply: rates({ tdd: 1 })(request) }), skills: SKILLS, disk: PERSON_FILES })
  const calling = w.findSkill('write the tests first')
  await w.clock.settle() // the hook is now waiting on the request and its timer
  await w.clock.advance(800)
  const answer = await calling

  expect(answer.result).toBe(`find_skill could not rate the skills (jev: no answer in 800 ms). ${SKILL_TOOL_LINE}`)
  expect(w.status()).toBe('dp find_skill failed (jev: no answer in 800 ms)')
})

test('an answer that leaves the skills question out is a failure too', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: () => ({ status: 200, body: { model: 'jev-1.13.0', answers: {} } }), skills: SKILLS, disk: PERSON_FILES })
  const answer = await w.findSkill('write the tests first')

  expect(answer.result).toBe(`find_skill could not rate the skills (jev: unreadable answer). ${SKILL_TOOL_LINE}`)
  expect(w.status()).toBe('dp find_skill failed (jev: unreadable answer)')
})

test("when the session's skills cannot be read, find_skill says so and asks nothing", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 1 }), skills: { ...SKILLS, listed: null } })
  const answer = await w.findSkill('write the tests first')

  expect(answer.result).toBe(`find_skill could not read this session's skills. ${SKILL_TOOL_LINE}`)
  expect(w.requests).toHaveLength(0)
  expect(w.status()).toBe("dp find_skill failed (the session's skills could not be read)")
})

test('an error of its own still gets the main agent an answer, and the status line and the debug log say what happened', { options: KEY }, async ($, on) => {
  on('state.get', (_$, e, next) => (e.key === 'skillCatalog' ? { deny: 'state store unavailable' } : next(e)))
  const w = world($, on, { backend: rates({ tdd: 1 }), skills: SKILLS, disk: PERSON_FILES })
  const answer = await w.findSkill('write the tests first')

  expect(answer.result).toBe(`find_skill could not rate the skills (an error in Dispatch Pilot, written to the debug log). ${SKILL_TOOL_LINE}`)
  expect(w.status()).toBe('dp find_skill failed (see the debug log)')
  expect(w.logs.map((log) => log.text)).toEqual([expect.stringContaining('find_skill failed: ')])
  expect(w.logs[0]?.text).toContain('state store unavailable')
})

test('the status line names what find_skill returned last, which takes the place of an earlier failure', { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: (request, n) => (n === 1 ? { status: 503, body: 'overloaded' } : rates(n === 2 ? { 'anthropic-skills:pdf': 0.7, 'code-review': 0.2, '(none)': 0.1 } : { '(none)': 1 })(request)),
    skills: SKILLS,
    disk: PERSON_FILES,
  })
  await w.findSkill('fill in a form in a PDF')
  await w.findSkill('fill in a form in a PDF')
  expect(w.status()).toBe('dp find_skill anthropic-skills:pdf, code-review')
  await w.findSkill('rename a variable')
  expect(w.status()).toBe('dp find_skill none')
})

test('each call goes to the debug log (its request, what it returned and why) and its decision to /dp log, never into the conversation', { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: (request, n) => (n === 1 ? rates({ 'anthropic-skills:pdf': 0.7, 'code-review': 0.2, tdd: 0.02, '(none)': 0.08 })(request) : { status: 500, body: 'boom' }),
    skills: SKILLS,
    disk: PERSON_FILES,
  })
  await w.findSkill('fill in a form in a PDF')
  await w.findSkill('review a branch before merging')

  const decision = 'found anthropic-skills:pdf, code-review for "fill in a form in a PDF": anthropic-skills:pdf 0.70, code-review 0.20, tdd 0.02, none 0.08; returned from 0.10, at most 5'
  expect(w.logs).toEqual([
    { text: 'request [skills.which] to jev for find_skill "fill in a form in a PDF": answered in 0 ms by jev-1.13.0 (300 input tokens)', to: 'debug' },
    { text: decision, to: 'debug' },
    { text: 'request [skills.which] to jev for find_skill "review a branch before merging": http: HTTP 500: boom (0 ms)', to: 'debug' },
  ])
  expect((await w.command('dp', 'log')).split('\n')).toEqual(['the last decision, newest last', `#1 find-skill: ${decision}`])
})

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

test('find_skill speaks only when called: the steps around the call ask nothing about skills, and its answer is the tool result alone', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.8, '(none)': 0.2 }), skills: SKILLS, disk: PERSON_FILES })
  await w.submit('先写一个失败的测试')
  await w.step({ index: 0 })
  const answer = await w.findSkill('write the tests first')
  await w.step({ index: 1 })
  await w.step({ index: 2 })

  // The message's request, then the call's: none for the steps.
  expect(w.requests.map((request) => Object.keys(request.body.questions))).toEqual([['effort.level', 'skills.which'], ['skills.which']])
  expect(answer.context).toBeUndefined()
})

test('when no skill reaches the bar the answer says so, and still points at the Skill tool', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: rates({ tdd: 0.06, '(none)': 0.94 }), skills: SKILLS, disk: PERSON_FILES })
  const answer = await w.findSkill('rename a variable')
  expect(answer.result).toBe(
    'No skill fits "rename a variable": none reached relevance 0.10. Carry on without one, try other words for the work, or load a skill you know with the Skill tool by its exact name.',
  )
})
