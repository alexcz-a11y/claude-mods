// Skills ranked in two stages (#11): the message's one decision request rates
// every skill (stage one, a Choice over all of them); a second request re-reads
// the opening of the few rated highest and judges each on its own (stage two,
// one yes/no `fits` per skill), and that absolute fit is the relevance the main
// agent is shown. Seam 1: engine events in; what reaches the decision model,
// the main agent and the status line out.

import { expect, test } from 'claude-code/testing'
import { isSecondSkillsRequest, rates, world, type SkillsWorld } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }

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

  expect(w.requests).toHaveLength(2)
  const [first, second] = w.requests
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

test('both requests share the message’s wait: the second gets what the first left of timeoutMs, and given up, the message goes on with nothing suggested and the status line says why', { options: { ...KEY, timeoutMs: 1500 } }, async ($, on) => {
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

  expect(w.requests).toHaveLength(2)
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]?.context).toBeUndefined()
  // The effort still went through; the skills say the second request had 1100 ms and got nothing.
  expect(w.status()).toBe('dp effort medium | skills not rated (jev: no answer in 1100 ms)')
})

test('a second request that fails suggests nothing, and the status line says so until a message is rated again', { options: KEY }, async ($, on) => {
  const answer = rates({ tdd: 0.62, '(none)': 0.38 }, { tdd: 0.97 })
  let refuse = true
  const w = world($, on, { backend: (request) => (isSecondSkillsRequest(request) && refuse ? { status: 503, body: 'overloaded' } : answer(request)), skills: SKILLS, disk: FILES })
  await w.submit('先写一个失败的测试')
  await w.step({ index: 0 })
  expect(w.prompts[0]?.context).toBeUndefined()
  expect(w.status()).toBe('dp effort medium | skills not rated (jev: busy (HTTP 503))')
  refuse = false
  await w.submit('再写一个失败的测试')
  await w.step({ index: 0 })
  expect(w.status()).toBe('dp effort medium | skills tdd')
})
