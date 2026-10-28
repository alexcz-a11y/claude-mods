// Command turns (#19): a turn the person starts with a prompt command (a
// skill, a markdown command) is routed like their own message. Seam 1: engine
// events in (`command.run`, then the prompt as typed, then the turn); out, the
// decision request, what each step went out with, the board.

import { expect, test } from 'claude-code/testing'
import { jev, KEY, OWN_EFFORT, type SkillsWorld, UNRESOLVED_ON, world } from './support/world.ts'

test('a command turn gets the effort question about the command as typed, and goes out at the decided effort', { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: jev([0, 0.1, 0.2, 0.7, 0]) })
  await w.slash('implement', '#19')
  await w.step({ index: 0, effort: 'medium' })

  expect(w.requests).toHaveLength(1)
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(OWN_EFFORT)
  expect(w.requests[0]?.body.state.user_message).toBe('/implement #19')
  expect(w.steps.map((s) => String(s.effort))).toEqual(['xhigh'])
  expect((await w.board()).main).toMatchObject({ effort: 'xhigh', routed: true })
})

// The session's skills, among them the one the person runs as a command.
const SKILLS: SkillsWorld = {
  commands: [
    { name: 'implement', description: 'Implement the work described by the user in the spec or tickets.', source: 'user' },
    { name: 'tdd', description: 'Test-driven development. Use when the user wants to build features or fix bugs test-first.', source: 'user' },
  ],
  listed: [
    { name: 'implement', source: 'userSettings', tokens: 40 },
    { name: 'tdd', source: 'userSettings', tokens: 52 },
  ],
}

test('a command turn suggests no skill: the person has picked the work already', { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: jev([0, 0, 1, 0, 0]), skills: SKILLS })
  await w.slash('implement', '#19')
  await w.step({ index: 0 })

  expect(w.requests).toHaveLength(1)
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(OWN_EFFORT)
  expect(w.prompts[0]?.context).toBeUndefined()
})

test('a message that only starts with a slash is an ordinary message, also after a local command ran', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), skills: SKILLS })
  // A local command: the engine runs it and submits nothing, no turn starts.
  await w.command('usage')
  await w.submit('/Users/me/notes.txt 这个文件写了什么')
  await w.step({ index: 0 })

  expect(w.requests[0]?.body.state.user_message).toBe('/Users/me/notes.txt 这个文件写了什么')
  expect(Object.keys(w.withoutEffort[0]?.body.questions)).toContain('skills.which')
  expect((await w.board()).main).toMatchObject({ routed: true })
})

// The decision model reads the command as typed and what the command is for, never the prompt it expands to.

test("a bare command is judged by what it is for: the command's description beside it", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), skills: SKILLS })
  await w.slash('implement')

  expect(w.requests[0]?.body.state.user_message).toBe('/implement')
  expect(w.requests[0]?.body.state.command).toEqual({ name: 'implement', description: 'Implement the work described by the user in the spec or tickets.' })
})

test("what the person typed after the command is their own words for a dispatched agent's decision; the prompt the command expands to is not", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  await w.slash('implement', '#19 派 agent 时用 opus')
  await w.step({ index: 0 })
  await w.spawn({ prompt: 'Implement ticket #19 test-first.', description: 'implement #19' })

  const agentRequest = w.requests.find((request) => 'agent.effort' in request.body.questions)
  expect(agentRequest?.body.state.user_message).toBe('/implement #19 派 agent 时用 opus')
})

test("a plugin's command typed without its plugin's name is a command turn too", { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: jev([0, 0, 1, 0, 0]), skills: SKILLS })
  await w.slash('release-kit:ship', '0.2.4', { as: 'ship' })

  expect(w.requests[0]?.body.state.user_message).toBe('/ship 0.2.4')
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(OWN_EFFORT)
})

test("a command turn's record keeps the command as typed, not the message the engine wraps it in: what is written about the turn later reads it", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  await w.slash('implement', '#19')
  await w.step({ index: 0, answer: '先看一下 issue。', tools: [{ tool: 'Bash', input: { command: 'gh issue view 19' } }] })
  await w.complete()

  expect(w.turnRecord('t1')).toMatchObject({ prompt: '/implement #19', person: true, facts: { calls: 1 } })
  expect(JSON.stringify(w.turnRecord('t1'))).not.toContain('command-message')
})

test('a command typed while a turn runs is decided, and the turn it starts later goes out at that effort', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 0, 1, 0]) })
  await w.submit('先看一下这个仓库')
  await w.step({ index: 0 })
  await w.slash('implement', '#19', { turnId: 't1' })
  await w.startTurn('<command-message>implement</command-message>\n<command-name>/implement</command-name>\n<command-args>#19</command-args>')
  await w.step({ index: 0, effort: 'medium' })

  expect(w.requests.map((request) => request.body.state.user_message)).toEqual(['先看一下这个仓库', '/implement #19'])
  expect(w.steps.at(-1)?.effort).toBe('xhigh')
  expect((await w.board()).main).toMatchObject({ effort: 'xhigh', routed: true })
})

test('a command typed with a trailing space still finds its decision: the engine trims the arguments its turn starts with (Desktop, 2.1.309)', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 0, 1, 0]) })
  await w.submit('先看一下这个仓库')
  await w.step({ index: 0 })
  await w.slash('implement', '#19 ', { turnId: 't1' })
  await w.startTurn('<command-message>implement</command-message>\n<command-name>/implement</command-name>\n<command-args>#19</command-args>')
  await w.step({ index: 0, effort: 'medium' })

  expect(w.steps.at(-1)?.effort).toBe('xhigh')
  expect((await w.board()).main).toMatchObject({ effort: 'xhigh', routed: true })
})
