import { expect, test } from 'claude-code/testing'

import { record } from '../hooks/runtime.ts'
import { LOG_KEEP, RECENT_KEEP, amendLog, decisionId, pushLog, readLog } from '../hooks/log.ts'
import type { Decision } from '../hooks/log.ts'
import { KEYS, dp, start, step, world } from './support/world.ts'

function decision(over: Partial<Decision> = {}): Decision {
  return {
    id: 'd0',
    at: 1_700_000_000_000,
    kind: 'submit',
    backend: 'drex',
    model: 'drex-max-v1.1',
    ms: 312,
    raw: { open: { type: 'score', score: 2.4, probabilities: [0.02, 0.08, 0.25, 0.55, 0.1] }, mechanical: { type: 'noul', noul: 0.1 } },
    from: 'medium',
    to: 'high',
    reason: 'more-open',
    detail: '',
    turnId: 't1',
    step: 0,
    bars: null,
    failure: null,
    requestId: 'req_1',
    applied: true,
    sent: null,
    ...over,
  }
}

const many = (n: number): Decision[] => Array.from({ length: n }, (_, i) => decision({ id: `d${i}` }))

// A stand-in for the mod's $ with only what record() touches: $.state with versions (so the
// state library's compare-and-set works), $.store and $.ui.log. storeDelay: turns of the event loop a
// store read takes, so two records in flight overlap; logThrows: $.ui.log itself throws.
function fakeDollar(o: { store?: Record<string, unknown>; storeFails?: boolean; storeDelay?: number; logThrows?: boolean } = {}) {
  const state = new Map<string, { value: unknown; version: number }>()
  const store = new Map<string, unknown>(Object.entries(o.store ?? {}))
  const logs: { text: string; to: string | undefined }[] = []
  const $ = {
    ui: {
      log: (text: string, options?: { to?: string }) => {
        if (o.logThrows) throw new Error('log refused')
        logs.push({ text, to: options?.to })
      },
      // record() asks for the board to be drawn again.
      invalidate: () => undefined,
    },
    state: {
      get: async (ref: { key: string }) => state.get(ref.key) ?? { value: undefined, version: 0 },
      set: async (ref: { key: string }, value: unknown, opts?: { ifVersion?: number }) => {
        const held = state.get(ref.key) ?? { value: undefined, version: 0 }
        if (opts?.ifVersion !== undefined && opts.ifVersion !== held.version) return { isSet: false, version: held.version }
        state.set(ref.key, { value, version: held.version + 1 })
        return { isSet: true, version: held.version + 1 }
      },
    },
    store: {
      get: async (key: string) => {
        if (o.storeFails) throw new Error('store unreadable')
        const held = store.get(key)
        for (let i = 0; i < (o.storeDelay ?? 0); i++) await Promise.resolve()
        return held
      },
      set: async (key: string, value: unknown) => {
        store.set(key, JSON.parse(JSON.stringify(value)))
      },
    },
  }
  return { $: $ as never, state, store, logs }
}

// The brief's five.

test('pushLog 只留最后 200 条', () => {
  const full = many(LOG_KEEP)
  const next = pushLog(full, decision({ id: 'new' }))
  expect(LOG_KEEP).toBe(200)
  expect(next).toHaveLength(200)
  expect(next[0]!.id).toBe('d1')
  expect(next.at(-1)!.id).toBe('new')
  // The log it was given is left as it was.
  expect(full).toHaveLength(200)
  expect(full[0]!.id).toBe('d0')
  expect(pushLog([], decision({ id: 'only' })).map((d) => d.id)).toEqual(['only'])
})

test('/dp 在两个密钥都没配时写明没有可用的后端（Review Focus 1）', async ($, on) => {
  const w = world(on)
  await start($)
  const text = await dp($)
  expect(text).toContain('没有可用的后端')
  expect(text).toContain('Drex 和 Jev 都没有密钥')
  expect(w.fetched).toHaveLength(0)
})

test('/dp lock high 之后主循环每步都是 high；/dp unlock 之后恢复', { options: KEYS }, async ($, on) => {
  const w = world(on)
  await start($)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  expect(await dp($, 'lock high')).toContain('已锁定')
  await step($, { turnId: 't1', index: 1, effort: 'medium' })
  await step($, { turnId: 't1', index: 2, effort: 'medium' })
  expect(await dp($)).toContain('锁定：high')
  expect(await dp($, 'unlock')).toContain('已解锁')
  await step($, { turnId: 't1', index: 3, effort: 'medium' })
  expect(w.stepsSent.map((s) => s.effort)).toEqual(['medium', 'high', 'high', 'medium'])
  // Only effort is written: the model is never changed.
  expect(w.stepsSent.map((s) => s.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
  expect(await dp($)).toContain('锁定：没有')
})

test('/dp lock 给了认不出的档位：回答说明可用的五档，不改状态', { options: KEYS }, async ($, on) => {
  const w = world(on)
  await start($)
  const before = w.stateWrites.length
  const text = await dp($, 'lock turbo')
  expect(text).toContain('「turbo」')
  expect(text).toContain('low、medium、high、xhigh、max')
  expect(await dp($, 'lock')).toContain('low、medium、high、xhigh、max')
  expect(w.stateWrites).toHaveLength(before)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  expect(w.stepsSent.map((s) => s.effort)).toEqual(['medium'])
  expect(await dp($)).toContain('锁定：没有')
})

test('/dp log 2 列出最近两条，含原始回答', { options: KEYS }, async ($, on) => {
  const log = [
    decision({ id: 'a', raw: { mechanical: { type: 'noul', noul: 0.11 } } }),
    decision({ id: 'b', raw: { mechanical: { type: 'noul', noul: 0.22 } }, requestId: 'req_b' }),
    decision({ id: 'c', kind: 'midrun', raw: { open: { type: 'score', score: 1, probabilities: [0.1, 0.2, 0.3, 0.3, 0.1] } }, from: 'high', to: 'xhigh', reason: 'same-failure' }),
  ]
  world(on, { store: { log } })
  await start($)
  const text = await dp($, 'log 2')
  expect(text).toContain('最近 2 条')
  expect(text).not.toContain('0.11')
  expect(text).toContain('mechanical 0.22')
  expect(text).toContain('req_b')
  expect(text).toContain('open [0.10 0.20 0.30 0.30 0.10]')
  expect(text).toContain('high → xhigh')
  expect(text).toContain('same-failure')
  // Oldest first, so the newest is at the bottom where the eye lands.
  expect(text.indexOf('0.22')).toBeLessThan(text.indexOf('xhigh'))
})

// What the five do not reach.

test('record 把决策追加进 $.store 的 log 和状态 recent；recent 只留 30 条', async () => {
  const f = fakeDollar({ store: { log: many(LOG_KEEP) } })
  for (let i = 0; i < 35; i++) await record(f.$, decision({ id: `r${i}` }))
  const recent = f.state.get('recent')?.value as Decision[]
  expect(RECENT_KEEP).toBe(30)
  expect(recent).toHaveLength(30)
  expect(recent[0]!.id).toBe('r5')
  expect(recent.at(-1)!.id).toBe('r34')
  const log = f.store.get('log') as Decision[]
  expect(log).toHaveLength(200)
  expect(log.at(-1)!.id).toBe('r34')
  expect(log[0]!.id).toBe('d35')
})

test('record：$.store 出错时不抛，recent 照写', async () => {
  const f = fakeDollar({ storeFails: true })
  await record(f.$, decision({ id: 'x' }))
  expect((f.state.get('recent')?.value as Decision[]).map((d) => d.id)).toEqual(['x'])
  expect(f.store.has('log')).toBe(false)
})

test('record：两条同时在途，$.store 的 log 一条不丢', async () => {
  const f = fakeDollar({ store: { log: [decision({ id: 'old' })] }, storeDelay: 20 })
  await Promise.all([record(f.$, decision({ id: 'a' })), record(f.$, decision({ id: 'b' })), record(f.$, decision({ id: 'c' }))])
  expect((f.store.get('log') as Decision[]).map((d) => d.id)).toEqual(['old', 'a', 'b', 'c'])
  expect((f.state.get('recent')?.value as Decision[]).map((d) => d.id).sort()).toEqual(['a', 'b', 'c'])
})

test('record：$.store 出错时在 debug 日志里写一行；写日志本身出错也不抛', async () => {
  const f = fakeDollar({ storeFails: true })
  await record(f.$, decision({ id: 'x' }))
  expect(f.logs).toHaveLength(1)
  expect(f.logs[0]!.to).toBe('debug')
  expect(f.logs[0]!.text).toContain('record')
  expect(f.logs[0]!.text).toContain('store unreadable')
  // Nothing of the decision itself goes into the line.
  expect(f.logs[0]!.text).not.toContain('drex-max-v1.1')

  const g = fakeDollar({ storeFails: true, logThrows: true })
  await record(g.$, decision({ id: 'y' }))
  expect((g.state.get('recent')?.value as Decision[]).map((d) => d.id)).toEqual(['y'])
  // A store that works again takes the next one.
  const h = fakeDollar({ logThrows: true })
  await record(h.$, decision({ id: 'z' }))
  expect((h.store.get('log') as Decision[]).map((d) => d.id)).toEqual(['z'])
})

test('amendLog 只改 id 对得上的那一条', () => {
  const log = [decision({ id: 'a' }), decision({ id: 'b' }), decision({ id: 'c' })]
  const next = amendLog(log, 'b', { sent: 'high' })
  expect(next.map((d) => d.sent)).toEqual([null, 'high', null])
  expect(next[1]).toEqual({ ...log[1]!, sent: 'high' })
  // The id itself is never patched, and the log given is left as it was.
  expect(amendLog(log, 'a', { id: 'z' })[0]!.id).toBe('a')
  expect(log[1]!.sent).toBe(null)
  expect(amendLog(log, 'nope', { sent: 'not-sent' })).toEqual(log)
})

test('decisionId：同一毫秒里也不重复', () => {
  const ids = new Set([decisionId(5), decisionId(5), decisionId(5), decisionId(6)])
  expect(ids.size).toBe(4)
})

test('readLog：$.store 里的 log 不是数组或混着别的东西时，只留像决策的条目', () => {
  expect(readLog(undefined)).toEqual([])
  expect(readLog({ log: 1 })).toEqual([])
  const good = decision({ id: 'ok' })
  expect(readLog([good, null, 'x', { id: 3 }, { id: 'y', at: 1, kind: 'nonsense' }])).toEqual([good])
})

test('session.start 注册 /dp，并记下这个会话的端', { options: KEYS }, async ($, on) => {
  const w = world(on, { surfaces: ['terminal', 'desktop'] })
  await start($)
  expect(w.commands.map((c) => c.name)).toEqual(['dp'])
  const session = w.stateWrites.filter((s) => s.key === 'session' && s.isSet).at(-1)
  expect(session?.value).toMatchObject({ surfaces: ['terminal', 'desktop'], lock: null })
})

test('热重载（再一次 session.start）不清锁定，也不重写 turn、recent、skills', { options: KEYS }, async ($, on) => {
  const w = world(on)
  await start($)
  await dp($, 'lock xhigh')
  const before = w.stateWrites.length
  await start($)
  // The reload refreshes the surfaces in session and writes nothing else.
  const reload = w.stateWrites.slice(before)
  expect(reload.map((s) => [s.key, s.isSet])).toEqual([['session', true]])
  expect(reload[0]!.value).toMatchObject({ lock: 'xhigh', surfaces: ['terminal'] })
  await step($, { turnId: 't1', index: 0, effort: 'low' })
  expect(w.stepsSent.map((s) => s.effort)).toEqual(['xhigh'])
  expect(await dp($)).toContain('锁定：xhigh')
})

test('/dp 认不出的参数：回答用法，列出四种写法，不改状态', { options: KEYS }, async ($, on) => {
  const w = world(on)
  await start($)
  const before = w.stateWrites.length
  for (const args of ['foo', 'unlock now', 'lock high please']) {
    const text = await dp($, args)
    expect(text).toContain('/dp lock')
    expect(text).toContain('/dp unlock')
    expect(text).toContain('/dp log [n]')
  }
  expect(w.stateWrites).toHaveLength(before)
})

test('/dp log 后面不是正整数：回答用法；不写 n 时列出最近 10 条', { options: KEYS }, async ($, on) => {
  world(on, { store: { log: many(12) } })
  await start($)
  expect(await dp($, 'log abc')).toContain('/dp log [n]')
  expect(await dp($, 'log 0')).toContain('/dp log [n]')
  expect(await dp($, 'log')).toContain('最近 10 条')
  expect(await dp($, 'log 500')).toContain('最近 12 条')
})

test('锁定不碰 agent 的步、不带 effort 的步和数字 effort 的步', { options: KEYS }, async ($, on) => {
  const w = world(on)
  await start($)
  await dp($, 'lock high')
  await step($, { turnId: 'a1', index: 0, effort: 'medium', agentId: 'agent-1' })
  await step($, { turnId: 't1', index: 0 })
  await step($, { turnId: 't1', index: 1, effort: 31999 })
  await step($, { turnId: 't1', index: 2, effort: 'low' })
  expect(w.stepsSent.map((s) => s.effort)).toEqual(['medium', undefined, 31999, 'high'])
})

test('shadow：锁定不写出去', { options: { ...KEYS, mode: 'shadow' } }, async ($, on) => {
  const w = world(on)
  await start($)
  expect(await dp($, 'lock high')).toContain('shadow')
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  expect(w.stepsSent.map((s) => s.effort)).toEqual(['medium'])
})

test('/dp 的文字版：后端可用、档位未核对、最近的决策', { options: KEYS }, async ($, on) => {
  world(on)
  await start($)
  const text = await dp($)
  expect(text).toContain('Drex（drex-max-v1.1）· 可用')
  expect(text).toContain('锁定：没有')
  expect(text).toContain('还没有决策')
})
