// The plan table: what later features write in $.state, and what the core's
// turn.step writer then sends. Each test answers the mod's $.state reads
// beneath it as if another feature had written the table, and checks the
// steps that reach the engine.

import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { jev, world } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }

/** Answers the mod's $.state.get for these values (`key` or `key/id`); everything else reads the kit's store. */
function table(on: On, values: Record<string, unknown>) {
  on('state.get', async (_$, e, next) => {
    const at = e.id === undefined ? e.key : `${e.key}/${e.id}`
    return at in values ? { value: { value: values[at], version: 1 } } : next(e)
  })
}

test("a dispatched agent's plan (agents table) sets its effort and model on every step; other agents pass", async ($, on) => {
  table(on, { 'agents/a1': { effort: 'low', floor: null, model: 'sonnet' } })
  const w = world($, on)
  await w.step({ index: 0, turnId: 'sub-1', agentId: 'a1', model: 'claude-opus-5-5', effort: 'xhigh' })
  await w.step({ index: 1, turnId: 'sub-1', agentId: 'a1', model: 'claude-opus-5-5', effort: 'xhigh' })
  await w.step({ index: 0, turnId: 'sub-2', agentId: 'a2', model: 'claude-opus-5-5', effort: 'xhigh' })

  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual([
    'a1 sonnet low',
    'a1 sonnet low',
    'a2 claude-opus-5-5 xhigh',
  ])
})

test("an agent's turn-level plan wins over its agent-level plan", async ($, on) => {
  table(on, { 'agents/a1': { effort: 'low', floor: null, model: 'sonnet' }, 'turns/a1:sub-1': { effort: 'high', floor: null, model: null, prompt: '', decisions: 1, changes: 0 } })
  const w = world($, on)
  await w.step({ index: 0, turnId: 'sub-1', agentId: 'a1', model: 'claude-opus-5-5', effort: 'xhigh' })

  expect(w.steps.map((s) => `${s.model} ${String(s.effort)}`)).toEqual(['sonnet high'])
})

test('the main agent never goes out on another model, whatever a plan names', { options: KEY }, async ($, on) => {
  table(on, { 'turns/main:t1': { effort: 'medium', floor: null, model: 'claude-haiku-4-5', prompt: 'x', decisions: 1, changes: 0 } })
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]) })
  await w.submit('x')
  await w.step({ index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })

  expect(w.steps.map((s) => `${s.model} ${String(s.effort)}`)).toEqual(['claude-opus-5-5 medium'])
})

test("a lock holds the main agent's effort over any decision, and the status line says so", { options: KEY }, async ($, on) => {
  table(on, { lock: 'max' })
  const w = world($, on, { backend: jev([1, 0, 0, 0, 0]) })
  await w.submit('改个错别字')
  await w.step({ index: 0, effort: 'medium' })
  await w.step({ index: 0, turnId: 'sub-1', agentId: 'a1', effort: 'medium' })

  expect(w.steps.map((s) => String(s.effort))).toEqual(['max', 'medium'])
  expect(w.status()).toBe('dp effort max (locked)')
})

test('a floor lifts the effort to at least its level and never lowers it', async ($, on) => {
  const record = (effort: string | null) => ({ effort, floor: 'high', model: null, prompt: '', decisions: 1, changes: 0 })
  table(on, { 'turns/main:t1': record('low'), 'turns/main:t2': record('xhigh'), 'turns/main:t3': record(null), 'turns/main:t4': record(null) })
  const w = world($, on)
  await w.step({ index: 0, turnId: 't1', effort: 'medium' })
  await w.step({ index: 0, turnId: 't2', effort: 'medium' })
  // Not routed: the floor lifts the engine's own effort, or leaves a higher one.
  await w.step({ index: 0, turnId: 't3', effort: 'medium' })
  await w.step({ index: 0, turnId: 't4', effort: 'max' })

  expect(w.steps.map((s) => `${s.turnId} ${String(s.effort)}`)).toEqual(['t1 high', 't2 xhigh', 't3 high', 't4 max'])
})
