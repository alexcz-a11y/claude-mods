// Skills ranked in two stages (#11): the message's one decision request rates
// every skill (stage one, a Choice over those the main agent can load and one
// over those only the person can start); a second request re-reads
// the opening of the few rated highest and judges each on its own (stage two,
// one yes/no `fits` per skill), and that absolute fit is the relevance the main
// agent is shown. Seam 1: engine events in; what reaches the decision model,
// the main agent and the board out.

import { expect, test } from 'claude-code/testing'
import { estimateTokens } from '../hooks/decision/context.ts'
import { skillsPart, type SkillOption } from '../hooks/decision/skills.ts'
import { clefInputProblems, CLEF_OPTIONS, clef } from './support/cloudflare.ts'
import { isSecondSkillsRequest, rates, world, type SkillsWorld } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }
/** The switch is off until the person turns it on (#48): these tests are about what the request is with it on. */
const UNRESOLVED_ON = { unresolved: true }

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

test('the skills rated highest are re-read in a second request, and the relevance shown is how well each fits on its own', { options: { ...KEY, skillsMinRelevance: 0.5 } }, async ($, on) => {
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
  // One yes/no question per skill rated high enough, with the opening of its SKILL.md; one Choice between them.
  expect(Object.keys(second?.body.questions)).toEqual(['skills.best', 'skills.fits.0', 'skills.fits.1'])
  const fits = second?.body.questions['skills.fits.0']
  expect(fits.type).toBe('noul')
  expect(fits.instructions.skill.name).toBe('tdd')
  expect(fits.instructions.skill.opening).toContain('Write one failing test, then only the code that makes it pass.')
  expect(fits.instructions.skill.opening).not.toContain('description:')
  expect(Object.keys(second?.body.questions['skills.best'].criteria)).toEqual(['tdd', 'code-review'])

  expect(w.prompts[0]?.context).toEqual([
    [
      '<skill_relevance>',
      'Skills that may fit this message, rated by Dispatch Pilot’s decision model (relevance 0 to 1). Most skills are left out of the skill listing in this session: load one of these with the Skill tool by its exact name if it fits the work, and skip any that does not.',
      `- tdd (relevance 0.97): ${TDD_DESCRIPTION}`,
      '</skill_relevance>',
    ].join('\n'),
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
  const second = w.withoutEffort[1]?.body.questions
  expect(second['skills.fits.0'].instructions.skill.opening).toBe('Lay out the page on a grid first.')
  expect(second['skills.fits.1'].instructions.skill.opening).toBe('Build, then push to the host.')
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

test('Clef takes the second request with a Choice between the skills re-read (its input rules hold)', { options: { ...CLEF_OPTIONS, skillsMinRelevance: 0.5 } }, async ($, on) => {
  // Workers AI checks each request (its refusals come back as they are); the answers rate two skills,
  // in Cloudflare's envelope, so the second request carries a Choice between them.
  const answer = rates({ tdd: 0.62, 'code-review': 0.23, '(none)': 0.15 }, { tdd: 0.97, 'code-review': 0.35 })
  const cloudflare = clef([0, 1, 0, 0, 0])
  const w = world($, on, { switches: UNRESOLVED_ON,
    backend: (request) => {
      const refused = cloudflare(request)
      if ('status' in refused && refused.status !== 200) return refused
      const { body } = answer(request) as { body: { answers: unknown } }
      return { status: 200, body: { result: { model: 'clef', answers: body.answers, usage: { input_tokens: 151, output_tokens: 0 } }, success: true, errors: [], messages: [] } }
    },
    skills: SKILLS,
    disk: FILES,
  })
  // With Clef the suggestions start off (tests/backend-defaults.test.ts): the person turns them on.
  await w.command('dp', 'skills on')
  await w.submit('先写一个失败的测试')
  expect(w.requests.map((request) => Object.keys(request.body.questions))).toEqual([
    ['effort.level', 'effort.unresolved'],
    ['skills.which'],
    ['skills.best', 'skills.fits.0', 'skills.fits.1'],
  ])
  expect(w.requests.map((request) => clefInputProblems(request.body))).toEqual([[], [], []])
  expect(w.prompts[0]?.context?.[0]).toContain(`- tdd (relevance 0.97): ${TDD_DESCRIPTION}`)
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

/** Thirty skills, each with a profile of some length. */
const PROFILED: SkillOption[] = Array.from({ length: 30 }, (_, i) => ({
  name: `skill-${i}`,
  description: `Skill ${i}.`,
  by: 'model',
  profile: {
    en: { what: `Skill ${i} does one rather specific kind of work for the user.`, use_when: 'The user asks for that kind of work, in so many words or by describing it.', not_for: 'Nearby work that another skill covers.' },
    zh: { what: `第${i}个 skill 专门做某一类工作。`, use_when: '用户要求做这类工作，或描述了这类工作。', not_for: '其他 skill 负责的相近工作。' },
  },
}))

test('stage one keeps its question within its token budget: past it the "not for" fields go first, then the last skills fall back to their descriptions', () => {
  const question = (budget: number) => skillsPart(PROFILED, { budget })?.questions.which
  const criteria = (budget: number) => {
    const which = question(budget)
    return which?.type === 'choice' ? (which.criteria as Record<string, unknown>) : {}
  }
  const size = (budget: number) => estimateTokens(JSON.stringify(question(budget)))
  const full = size(1_000_000)
  expect(criteria(1_000_000)['skill-0']).toHaveProperty('not_for')

  const trimmed = criteria(full - 1)
  expect(Object.values(trimmed).filter((criterion) => typeof criterion === 'object' && criterion !== null && 'not_for' in criterion)).toEqual([])
  expect(trimmed['skill-29']).toHaveProperty('用途')

  const tight = Math.floor(full / 3)
  expect(criteria(tight)['skill-0']).toHaveProperty('what')
  expect(criteria(tight)['skill-29']).toBe('Skill 29.')
  expect(size(tight)).toBeLessThanOrEqual(tight)
  expect(Object.keys(criteria(tight))).toHaveLength(31)
})
