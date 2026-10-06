// What people see on the terminal (spec #22 「Band」「脚部」, ADR 0004): the band above the prompt, the short summary
// at the right end of the footer, and a toast when a route fails; never the status row. Seam 1: engine events in,
// the screens mounted through the mod (`w.band()`, `w.footer()`) and the toasts out. The tests read the drawn trees
// by key and look for the data a person needs (a model, an effort, a reason), not for whole lines of wording.

import { expect, test } from 'claude-code/testing'
import { jev, world } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }

// ---- never the status row (ADR 0004) --------------------------------------------

test('nothing the mod does draws on the status row: decisions, failures, agents, re-decisions, switches and the mod off and on', { options: { ...KEY, rejudgeEvery: 1 } }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => (n === 3 ? { status: 500, body: 'down' } : jev([0, 0.2, 0.7, 0.1, 0])(request)), store: {}, session: true })
  await w.start()
  await w.submit('把登录模块重构成三层')
  await w.step({ index: 0, tools: [{ tool: 'Bash', input: { command: 'pnpm test' }, ends: { error: 'exit 1' } }] })
  const started = await w.spawn({ prompt: 'Review the diff of src/auth.', description: '审查改动' })
  await w.step({ index: 0, turnId: 'sub-1', agentId: started.agentId })
  await w.step({ index: 1 })
  await w.complete({ agentId: started.agentId })
  await w.complete()
  for (const args of ['midturn-effort off', 'midturn-effort on', 'lock high', 'unlock', 'off', 'on', 'log']) await w.command('dp', args)
  await w.submit('再看看测试')
  await w.step({ index: 0 })

  expect(w.requests.length).toBeGreaterThanOrEqual(3)
  expect((await w.board()).log.length).toBeGreaterThan(0)
  expect(w.statuses).toEqual([])
})

// ---- the toast ------------------------------------------------------------------

test("a route that fails raises a toast naming who is not routed and why; the board says the same", { options: { ...KEY, timeoutMs: 800 } }, async ($, on) => {
  const w = world($, on, { backend: () => ({ status: 401, body: { detail: 'Invalid API key' } }) })
  await w.submit('看看这个报错是怎么回事')

  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]?.text).toContain('主 agent')
  expect(w.toasts[0]?.text).toContain('未路由')
  expect(w.toasts[0]?.text).toContain('jev: key refused (HTTP 401)')
  expect((await w.board()).nodes.find((node) => node.id === 'main')).toMatchObject({ routed: false, why: 'jev: key refused (HTTP 401)' })
})

test('a decision made raises no toast', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  await w.submit('把登录模块重构成三层')
  await w.step({ index: 0 })
  expect(w.toasts).toEqual([])
})

test('routes failing within two seconds of the last toast raise none of their own (the engine would drop it); later ones do', { options: { ...KEY, timeoutMs: 800 } }, async ($, on) => {
  const w = world($, on, { backend: () => ({ status: 500, body: 'down' }) })
  await w.submit('第一条')
  await w.clock.advance(1500)
  await w.submit('第二条')
  expect(w.toasts).toHaveLength(1)
  await w.clock.advance(600)
  await w.submit('第三条')
  expect(w.toasts.map((toast) => toast.at)).toEqual([0, 2100])
})

test('a failed request beside the route (the skills, a re-decision) raises no toast: its own route stands', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => (n === 1 ? jev([0, 0, 1, 0, 0])(request) : { status: 500, body: 'down' }) })
  await w.submit('把登录模块重构成三层')
  await w.step({ index: 0, tools: [{ tool: 'Agent', input: { description: 'x' } }] })
  await w.step({ index: 1 })
  // The re-decision asked as the agent was dispatched failed: a note for the band, no toast.
  expect(w.requests).toHaveLength(2)
  expect((await w.board()).notes).toMatchObject([{ turn: 1, id: 'main', feature: 'midturn-effort', kind: 'failed', why: 'jev: HTTP 500' }])
  expect(w.toasts).toEqual([])
})
