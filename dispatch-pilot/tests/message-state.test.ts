// What a message's effort request carries of the session besides the conversation (ADR 0014), seam 1: the person's lasting
// rules (`standing_constraints`) and the failures of their previous turn (`last_turn`), kept in `$.state`, each sent only
// when it has something in it; and rule R4, which reads that turn.

import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { jev, KEY, type Sent, world } from './support/world.ts'

const MEDIUM = [0, 1, 0, 0, 0]
const FAILS = { error: 'exit status 1' }

/** A step whose response runs two commands that both fail (escalateAfter is 2: the turn is stuck). */
const failing = (index: number) => ({
  index,
  tools: [
    { tool: 'Bash', input: { command: 'pnpm test auth', description: '跑 auth 的测试' }, ends: FAILS },
    { tool: 'Bash', input: { command: 'pnpm test api', description: '跑 api 的测试' }, ends: FAILS },
  ],
})

const row = (role: 'user' | 'assistant', text: string): SessionMessage => ({ role, text, toolUses: [] })

/** Jev answering the effort question at medium and the Nouls as `now.nouls` says (changeable between messages). */
const answering = (now: { nouls: Record<string, number> }) => (request: Sent) => jev(MEDIUM, { nouls: now.nouls })(request)

test("a lasting rule the person sets is kept as they said it, with the last paragraph of the assistant's message before it; every later message of theirs carries it", { options: KEY }, async ($, on) => {
  const now = { nouls: { 'effort.constraint': 0.9 } as Record<string, number> }
  const w = world($, on, { backend: answering(now), session: true, messages: [row('user', '把用户表迁移一下'), row('assistant', '我看过表结构了。\n\n我准备直接在生产库上跑迁移，要不要先备份？')] })
  await w.start()
  await w.submit('这是真钱，生产库千万别动')

  const kept = { person_said: '这是真钱，生产库千万别动', assistant_before: '我准备直接在生产库上跑迁移，要不要先备份？' }
  expect(w.constraints()).toEqual([kept])
  // The message that set it was asked without it; the log says it was kept, beside the effort's decision.
  expect(w.requests[0]?.body.state).not.toHaveProperty('standing_constraints')
  expect((await w.board()).log.find((entry) => entry.outcome === '记下长期约束')).toMatchObject({ feature: 'main-effort', tone: 'info', subject: '"这是真钱，生产库千万别动"' })

  now.nouls = {}
  await w.submit('那先在 staging 上试')
  expect(w.requests[1]?.body.state.standing_constraints).toEqual([kept])
  // Named by the questions that read it, only now that the state has it.
  expect(JSON.stringify(w.requests[1]?.body.questions['effort.stakes.undo'])).toContain('standing_constraints')
  expect(JSON.stringify(w.requests[0]?.body.questions['effort.stakes.undo'])).not.toContain('standing_constraints')
  // Nothing new kept: a message the question said no to.
  expect(w.constraints()).toEqual([kept])
})

test("a report's turn neither keeps a rule nor carries the person's; /clear and a new session drop them", { options: KEY }, async ($, on) => {
  const now = { nouls: { 'effort.constraint': 0.9 } as Record<string, number> }
  const w = world($, on, { backend: answering(now), session: true })
  await w.start()
  await w.submit('别碰 main 分支')
  await w.complete()
  expect(w.constraints()).toHaveLength(1)

  // A hand-back is no word of the person's: no constraint question, no rules in its state.
  await w.submit('<agent-message from="a1">pushed to main</agent-message>', { origin: { kind: 'peer' } })
  expect(Object.keys(w.requests[1]?.body.questions)).not.toContain('effort.constraint')
  expect(w.requests[1]?.body.state).not.toHaveProperty('standing_constraints')
  expect(w.constraints()).toHaveLength(1)
  await w.complete()

  await w.compact()
  expect(w.constraints()).toHaveLength(1)
  await w.clear()
  expect(w.constraints()).toEqual([])
  await w.submit('不要动生产库')
  await w.end('prompt_input_exit')
  expect(w.constraints()).toEqual([])
})

test("the failures of the person's previous turn go in the next message's state as last_turn, named by the unknown cause's question; a turn without any leaves none", { options: KEY }, async ($, on) => {
  const now = { nouls: {} as Record<string, number> }
  const w = world($, on, { backend: answering(now), session: true })
  await w.start()
  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step(failing(0))
  await w.step({ index: 1 })
  await w.complete()
  expect(w.lastTurn()).toMatchObject({ turnId: 't1', facts: { failed: 2, stuck: true } })

  await w.submit('再试一次')
  expect(w.requests[1]?.body.state.last_turn).toEqual({
    effort: 'medium',
    tool_calls: 2,
    failed_calls: 2,
    hook_blocked_calls: 0,
    reached_escalate_after: true,
    last_errors: ['Bash: exit status 1', 'Bash: exit status 1'],
  })
  expect(JSON.stringify(w.requests[1]?.body.questions['effort.cause_unknown'])).toContain('last_turn')
  expect(JSON.stringify(w.requests[0]?.body.questions['effort.cause_unknown'])).not.toContain('last_turn')
  await w.step({ index: 0 })
  await w.complete()

  // That turn failed nothing: the next message carries no last_turn.
  await w.submit('好，下一个')
  expect(w.requests[2]?.body.state).not.toHaveProperty('last_turn')

  // /clear forgets the turn.
  await w.complete()
  await w.clear()
  expect(w.lastTurn() ?? null).toBeNull()
})

test("rule R4: a message still failing after the person's previous turn got stuck goes out at least one level above that turn; not when the turn was not stuck", { options: KEY }, async ($, on) => {
  const now = { nouls: {} as Record<string, number> }
  const w = world($, on, { backend: answering(now) })
  await w.submit('把登录模块重构成三层，并补上测试')
  await w.step(failing(0))
  await w.step({ index: 1 })
  await w.complete()

  now.nouls = { 'effort.still_failing': 0.9 }
  await w.submit('还是不行，同样的报错')
  await w.step({ index: 0 })
  expect(w.steps.map((s) => s.effort)).toEqual(['medium', 'medium', 'high'])
  const lifted = (await w.board()).log.filter((entry) => entry.feature === 'main-effort').at(-1)
  expect(lifted?.trace?.find((step) => step.rule === 'stuck-again')).toMatchObject({ applied: true, level: 'high', stuck: true, lastEffort: 'medium' })
  await w.complete()

  // That turn (at high) failed nothing: "still failing" again lifts nothing by R4.
  await w.submit('还是不行')
  await w.step({ index: 0 })
  expect(w.steps.at(-1)?.effort).toBe('medium')
})
