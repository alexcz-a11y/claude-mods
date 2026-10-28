// Skills ranked in two stages, as TypeSafe's skill suggestion cookbook ranks
// them (ADR 0018): the message's skills request rates every skill (stage one, a
// Choice over those the main agent can load and one over those only the person
// can start, beside the gate); a second request re-reads the three rated highest
// with the opening of each SKILL.md (a Choice over them) and judges each on its
// own (one yes/no `fits` per skill). Seam 1: engine events in; what reaches the
// decision model, the main agent and the board out.

import { expect, test } from 'claude-code/testing'
import { estimateTokens } from '../hooks/decision/context.ts'
import { skillsPart, type SkillOption } from '../hooks/decision/skills.ts'
import { isSecondSkillsRequest, KEY, rates, type SkillsWorld, world } from './support/world.ts'

const TDD_DESCRIPTION = 'Test-driven development. Use when the user wants to build features or fix bugs test-first.'
const REVIEW_DESCRIPTION = 'Review the changes since a fixed point along two axes: Standards and Spec.'

// The session's skills, as #10's tests give them; tdd and code-review are the
// person's own (userSettings), so their SKILL.md is under ~/.claude/skills.
const SKILLS: SkillsWorld = {
  commands: [
    { name: 'tdd', description: TDD_DESCRIPTION, source: 'user' },
    { name: 'code-review', description: REVIEW_DESCRIPTION, source: 'user' },
    { name: 'computer-use', description: 'Read this skill before the first step of any request to do something in an app on the person’s own computer.', source: 'user' },
  ],
  listed: [
    { name: 'tdd', source: 'userSettings', tokens: 52 },
    { name: 'code-review', source: 'userSettings', tokens: 144 },
    { name: 'computer-use', source: 'syncedSkills', tokens: 322 },
  ],
}
const FILES: Record<string, string> = {
  '/home/u/.claude/skills/tdd/SKILL.md': `---\nname: tdd\ndescription: ${TDD_DESCRIPTION}\n---\n\n# Test-Driven Development\n\nWrite one failing test, then only the code that makes it pass.\n`,
  '/home/u/.claude/skills/code-review/SKILL.md': `---\nname: code-review\ndescription: ${REVIEW_DESCRIPTION}\n---\n\n# Code review\n\nReview the diff against the repo's standards, then against the issue.\n`,
}

test("the three skills rated highest are re-read in a second request: a Choice over them, each by its description and the opening of its SKILL.md, and a yes/no each", { options: KEY }, async ($, on) => {
  const w = world($, on, {
    backend: rates({ tdd: 0.62, 'code-review': 0.23, 'anthropic-skills:computer-use': 0.01, '(none)': 0.14 }, { tdd: 0.97, 'code-review': 0.35 }),
    skills: SKILLS,
    disk: FILES,
  })
  await w.submit('先写一个失败的测试，再实现登录限流')

  // The effort question has its request, then the skills' two stages.
  expect(w.requests).toHaveLength(3)
  expect(w.withoutEffort).toHaveLength(2)
  const [first, second] = w.withoutEffort
  expect(isSecondSkillsRequest(first!)).toBe(false)
  // The second request asks about the same message and conversation.
  expect(second?.body.state).toEqual(first?.body.state)
  expect(Object.keys(second?.body.questions)).toEqual(['skills.which', 'skills.fits.0', 'skills.fits.1', 'skills.fits.2'])
  // The cookbook's `f"{description_full} — {body[:excerpt]}"`: the frontmatter left out; a skill with no SKILL.md by its description.
  expect(second?.body.questions['skills.which'].criteria).toEqual({
    tdd: `${TDD_DESCRIPTION} — # Test-Driven Development Write one failing test, then only the code that makes it pass.`,
    'code-review': `${REVIEW_DESCRIPTION} — # Code review Review the diff against the repo's standards, then against the issue.`,
    'anthropic-skills:computer-use': 'Read this skill before the first step of any request to do something in an app on the person’s own computer.',
  })
  const fits = second?.body.questions['skills.fits.0']
  expect(fits).toEqual({ type: 'noul', instructions: `Does the skill 'tdd' do the specific thing the user's request asks for? It is described as: ${TDD_DESCRIPTION}` })

  expect(w.prompts[0]?.context).toEqual([
    ['<skill_relevance>', 'Relevant to the current request: tdd. Ignore this if it does not fit what the user actually asked for.', `tdd: ${TDD_DESCRIPTION}`, '</skill_relevance>'].join('\n'),
  ])
})

test("a plugin's skill is re-read from its SKILL.md, also where the plugin's manifest keeps its skills", { options: KEY }, async ($, on) => {
  const root = '/home/u/.claude/plugins/cache/market/acme/1.0.0'
  const w = world($, on, {
    backend: rates({ 'acme:design': 0.6, 'acme:deploy': 0.3, '(none)': 0.1 }, { 'acme:design': 0.9, 'acme:deploy': 0.2 }),
    skills: {
      commands: [
        { name: 'acme:design', description: 'Design pages.', source: 'plugin', plugin: 'acme' },
        { name: 'acme:deploy', description: 'Deploy the site.', source: 'plugin', plugin: 'acme' },
      ],
      listed: [
        { name: 'acme:design', source: 'plugin', pluginName: 'acme', tokens: 10 },
        { name: 'acme:deploy', source: 'plugin', pluginName: 'acme', tokens: 10 },
      ],
    },
    disk: {
      '/home/u/.claude/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'acme@market': [{ scope: 'user', installPath: root }] } }),
      [`${root}/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'acme', skills: './.claude/skills/' }),
      [`${root}/.claude/skills/design/SKILL.md`]: '---\nname: design\n---\nLay out the page on a grid first.\n',
      [`${root}/skills/deploy/SKILL.md`]: '---\nname: deploy\n---\nBuild, then push to the host.\n',
    },
  })
  await w.submit('把首页重新排一下版')
  expect(w.withoutEffort[1]?.body.questions['skills.which'].criteria).toEqual({
    'acme:design': 'Design pages. — Lay out the page on a grid first.',
    'acme:deploy': 'Deploy the site. — Build, then push to the host.',
  })
})

test('both requests share the message’s wait: the second gets what the first left of timeoutMs, and given up, the message goes on with nothing suggested and the board notes why', { options: { ...KEY, timeoutMs: 1500 } }, async ($, on) => {
  const answer = rates({ tdd: 0.62, '(none)': 0.38 }, { tdd: 0.97 })
  const w = world($, on, {
    // The first request answers after 400 ms; the second would take a minute.
    backend: (request) => (isSecondSkillsRequest(request) ? { after: 60_000, reply: answer(request) } : { after: 400, reply: answer(request) }),
    skills: SKILLS,
    disk: FILES,
  })
  const entering = w.submit('先写一个失败的测试')
  await w.clock.settle()
  await w.clock.advance(400)
  await w.clock.advance(1100)
  await entering
  await w.step({ index: 0 })

  expect(w.requests).toHaveLength(3)
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]?.context).toBeUndefined()
  // The effort still went through; the second request had 1100 ms and got nothing, so no skills decision: a note says why.
  expect((await w.board()).log.filter((entry) => entry.feature === 'skills')).toEqual([])
  expect((await w.board()).notes).toMatchObject([{ turn: 1, id: 'main', feature: 'skills', kind: 'failed', why: 'jev：1100 毫秒内没有回答' }])
})

// With Jev the second request has 800 ms at least (BACKEND_DEFAULTS skillsSecondStageMs): several sessions on one key slow the
// first to 0.9-1.3 s, which left the second 200 ms of 1500 and it failed without being sent (2026-10-19).
test('with Jev, a first request that takes most of the wait still leaves the second 800 ms, and the skill it rates is suggested', { options: KEY }, async ($, on) => {
  const answer = rates({ tdd: 0.62, '(none)': 0.38 }, { tdd: 0.97 })
  const w = world($, on, {
    // The first request answers after 1300 ms, 200 ms short of the 1500 ms wait; the second takes 300 ms.
    backend: (request) => ({ after: isSecondSkillsRequest(request) ? 300 : 1300, reply: answer(request) }),
    skills: SKILLS,
    disk: FILES,
  })
  const entering = w.submit('先写一个失败的测试')
  await w.clock.settle()
  await w.clock.advance(1300)
  await w.clock.advance(300)
  await entering

  expect(w.requests).toHaveLength(3)
  expect(w.prompts[0]?.context?.join('\n')).toContain('Relevant to the current request: tdd.')
  expect((await w.board()).notes.filter((note) => note.feature === 'skills')).toEqual([])
})

test('with Jev, the second request given its 800 ms and no answer: nothing is suggested and the board says it waited 800 ms', { options: KEY }, async ($, on) => {
  const answer = rates({ tdd: 0.62, '(none)': 0.38 }, { tdd: 0.97 })
  const w = world($, on, { backend: (request) => ({ after: isSecondSkillsRequest(request) ? 60_000 : 1300, reply: answer(request) }), skills: SKILLS, disk: FILES })
  const entering = w.submit('先写一个失败的测试')
  await w.clock.settle()
  await w.clock.advance(1300)
  await w.clock.advance(800)
  await entering

  expect(w.prompts[0]?.context).toBeUndefined()
  expect((await w.board()).notes).toMatchObject([{ turn: 1, id: 'main', feature: 'skills', kind: 'failed', why: 'jev：800 毫秒内没有回答' }])
})

test('a second request that fails suggests nothing and leaves no skills decision (a note on the board says why) until a message is rated again', { options: KEY }, async ($, on) => {
  const answer = rates({ tdd: 0.62, '(none)': 0.38 }, { tdd: 0.97 })
  let refuse = true
  const w = world($, on, { backend: (request) => (isSecondSkillsRequest(request) && refuse ? { status: 503, body: 'overloaded' } : answer(request)), skills: SKILLS, disk: FILES })
  await w.submit('先写一个失败的测试')
  await w.step({ index: 0 })
  expect(w.prompts[0]?.context).toBeUndefined()
  expect((await w.board()).log.filter((entry) => entry.feature === 'skills')).toEqual([])
  expect((await w.board()).notes).toMatchObject([{ feature: 'skills', kind: 'failed', why: 'jev：繁忙（状态码 503）' }])
  refuse = false
  await w.submit('再写一个失败的测试')
  await w.step({ index: 0 })
  expect((await w.board()).log.filter((entry) => entry.feature === 'skills').map((entry) => [entry.turn, entry.skills?.suggest.map((skill) => skill.name)])).toEqual([[2, ['tdd']]])
})

// The decision module's interface (pure): what the eval (#16) and find_skill
// (#12) build the same questions with.

/** Thirty skills, each with a long description. */
const DESCRIBED: SkillOption[] = Array.from({ length: 30 }, (_, i) => ({
  name: `skill-${i}`,
  description: `Skill ${i} does one rather specific kind of work for the user. ${'Use it when the user asks for that kind of work, in so many words or by describing it. '.repeat(4)}`,
  by: 'model',
}))

test('stage one keeps its Choice within its token budget: past it every description is cut to the same length, the most that fits, and no skill is left out', () => {
  const question = (budget: number) => skillsPart(DESCRIBED, { budget, gate: false })?.questions.which
  const criteria = (budget: number) => {
    const which = question(budget)
    return which?.type === 'choice' ? (which.criteria as Record<string, string | null>) : {}
  }
  const size = (budget: number) => estimateTokens(JSON.stringify(question(budget)))
  const full = size(1_000_000)
  expect(criteria(1_000_000)['skill-0']).toBe(DESCRIBED[0]?.description.trim())

  const tight = Math.floor(full / 3)
  expect(size(tight)).toBeLessThanOrEqual(tight)
  expect(Object.keys(criteria(tight))).toHaveLength(30)
  expect(String(criteria(tight)['skill-0']).startsWith('Skill 0 does one rather specific kind of work')).toBe(true)
  expect(String(criteria(tight)['skill-0']).length).toBeLessThan(String(DESCRIBED[0]?.description).length)
})
