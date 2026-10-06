// The /dp command (#13): the effort lock, the switches, the decision log and
// the signals the engine reports. Seam 1: engine events in, what reaches the
// engine, the decision backend, the store and the debug log out.

import { expect, test } from 'claude-code/testing'
import { jev, world } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }

// ---- The lock ---------------------------------------------------------------

test('/dp lock holds the main agent at that effort on every step, over the decision, until /dp unlock', { options: KEY }, async ($, on) => {
  // The decision model says high.
  const w = world($, on, { backend: jev([0.05, 0.1, 0.7, 0.1, 0.05]) })

  expect(await w.command('dp', 'lock max')).toContain('locked at max')
  await w.submit('把登录模块重构成三层')
  await w.step({ index: 0, effort: 'xhigh' })
  await w.step({ index: 1, effort: 'medium' })
  expect(w.steps.map((s) => s.effort)).toEqual(['max', 'max'])
  expect((await w.board()).main).toMatchObject({ effort: 'max', locked: true })
  expect(w.status()).toBe('dp effort max (locked)')

  // Released in the middle of the turn: the decision takes over from the next step.
  expect(await w.command('dp', 'unlock')).toContain('unlocked')
  await w.step({ index: 2, effort: 'xhigh' })
  expect(w.steps.at(-1)?.effort).toBe('high')
  const main = (await w.board()).main
  expect(main).toMatchObject({ effort: 'high', routed: true })
  expect(main?.locked).toBeUndefined()
})

test('a lock outlives the turn it was set in, /dp shows it, and /dp lock off releases it', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0.9, 0.05, 0.05, 0, 0]) })
  await w.command('dp', 'lock xhigh')
  await w.submit('改个错别字')
  await w.step({ index: 0, effort: 'medium' })
  await w.submit('再改一个')
  await w.step({ index: 0, effort: 'medium' })
  expect(w.steps.map((s) => s.effort)).toEqual(['xhigh', 'xhigh'])
  expect(await w.command('dp')).toContain('Effort lock: xhigh.')

  expect(await w.command('dp', 'lock off')).toContain('unlocked')
  expect(await w.command('dp')).toContain('Effort lock: none.')
  await w.step({ index: 1, effort: 'medium' })
  expect(w.steps.at(-1)?.effort).toBe('low')
})

// ---- The master switch ------------------------------------------------------

test('/dp off stands the whole mod down: nothing is asked, every step goes out as the engine made it, the status line says off; /dp on brings the decisions back', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0.05, 0.1, 0.7, 0.1, 0.05]) })

  expect(await w.command('dp', 'off')).toContain('off')
  expect(w.status()).toBe('dp off')
  await w.submit('把登录模块重构成三层')
  await w.step({ index: 0, effort: 'xhigh' })
  expect(w.requests).toHaveLength(0)
  expect(w.steps.map((s) => s.effort)).toEqual(['xhigh'])
  expect(w.status()).toBe('dp off')

  expect(await w.command('dp', 'on')).toContain('on')
  await w.submit('再看看别的模块')
  await w.step({ index: 0, effort: 'xhigh' })
  expect(w.requests).toHaveLength(1)
  expect(w.steps.at(-1)?.effort).toBe('high')
  expect((await w.board()).main).toMatchObject({ effort: 'high', routed: true })
})

test('while Dispatch Pilot is off a lock has no effect, and the command says so', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0.05, 0.1, 0.7, 0.1, 0.05]) })
  await w.command('dp', 'off')

  expect(await w.command('dp', 'lock max')).toContain('off')
  await w.step({ index: 0, effort: 'medium' })
  expect(w.steps.map((s) => s.effort)).toEqual(['medium'])

  // Back on: the lock that was set meanwhile holds.
  await w.command('dp', 'on')
  await w.step({ index: 1, effort: 'medium' })
  expect(w.steps.at(-1)?.effort).toBe('max')
})

// ---- One feature's switch ---------------------------------------------------

test('/dp lists the switch each feature registered; a feature switched off asks nothing, and /dp <name> on brings it back', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0.05, 0.1, 0.7, 0.1, 0.05]) })

  expect(await w.command('dp')).toMatch(/\bon +main-effort +\S/)

  expect(await w.command('dp', 'main-effort off')).toContain('main-effort is off')
  expect(await w.command('dp')).toMatch(/\boff +main-effort +\S/)
  await w.submit('把登录模块重构成三层')
  await w.step({ index: 0, effort: 'xhigh' })
  expect(w.requests).toHaveLength(0)
  expect(w.steps.map((s) => s.effort)).toEqual(['xhigh'])
  expect((await w.board()).main).toMatchObject({ effort: 'xhigh', routed: false })

  expect(await w.command('dp', 'main-effort on')).toContain('main-effort is on')
  await w.submit('再看看别的模块')
  await w.step({ index: 0, effort: 'xhigh' })
  expect(w.requests).toHaveLength(1)
  expect(w.steps.at(-1)?.effort).toBe('high')
})

test('a feature switched off takes what it showed off the status line', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: () => ({ status: 401, body: { detail: 'Invalid API key' } }) })
  await w.submit('解释一下这个函数做了什么')
  await w.step({ index: 0, effort: 'medium' })
  expect(w.status()).toBe('dp effort medium (not routed) | jev: key refused (HTTP 401)')

  await w.command('dp', 'main-effort off')
  expect(w.status()).toBe('dp effort medium (not routed)')
})

test('a switch nobody registered is refused and nothing changes', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0.05, 0.1, 0.7, 0.1, 0.05]) })

  const text = await w.command('dp', 'teleport off')
  expect(text).toContain('no switch named "teleport"')
  expect(text).toContain('main-effort')
  await w.submit('把登录模块重构成三层')
  expect(w.requests).toHaveLength(1)
})

test('the command takes any case and spacing, and what it does not understand changes nothing and says how to use it', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })

  expect(await w.command('dp', '  Main-Effort   OFF ')).toContain('main-effort is off')
  for (const args of ['lock', 'lock turbo', 'lock high now', 'log 0', 'log many', 'log 2 3', 'main-effort', 'main-effort maybe', 'frobnicate']) {
    expect(await w.command('dp', args)).toMatch(/^not understood\.\n.*\/dp lock <low\|medium\|high\|xhigh\|max>/)
  }
  expect(await w.command('dp')).toContain('Effort lock: none.')
  expect(await w.command('dp')).toMatch(/\boff +main-effort +\S/)
})

// ---- What the person flipped is kept ---------------------------------------

test('what the person flips is kept in the store, and only while it differs from the default', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), store: {} })

  await w.command('dp', 'main-effort off')
  expect(w.stored('switches')).toEqual({ 'main-effort': false })
  await w.command('dp', 'off')
  expect(w.stored('switches')).toEqual({ 'main-effort': false, master: false })
  await w.command('dp', 'on')
  await w.command('dp', 'main-effort on')
  expect(w.stored('switches')).toEqual({})
})

test('flipping a switch keeps what another session saved meanwhile', { options: KEY }, async ($, on) => {
  // Another session saved master off after this one loaded its switches (it never did here).
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), store: { switches: { master: false, 'future-feature': false } } })

  await w.command('dp', 'signals off')
  expect(w.stored('switches')).toEqual({ master: false, 'future-feature': false, signals: false })
  await w.command('dp', 'signals on')
  expect(w.stored('switches')).toEqual({ master: false, 'future-feature': false })
})

test('a new session starts as the person left it: Dispatch Pilot off stays off, the status line says so, and /dp is registered to run mid-turn', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), store: { switches: { master: false } }, session: true })

  await w.start()
  expect(w.commands.map((c) => ({ name: c.name, immediate: c.immediate }))).toEqual([{ name: 'dp', immediate: true }])
  expect(w.status()).toBe('dp off')
  await w.submit('把登录模块重构成三层')
  expect(w.requests).toHaveLength(0)
  expect(await w.command('dp')).toContain('Dispatch Pilot is off')
})

test('a feature the person left off stays off in the next session', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), store: { switches: { 'main-effort': false } }, session: true })

  await w.start()
  await w.submit('把登录模块重构成三层')
  expect(w.requests).toHaveLength(0)
  expect(await w.command('dp')).toMatch(/\boff +main-effort +\S/)
})

test('a store that holds anything but switches leaves everything on', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), store: { switches: { 'main-effort': 'no', master: 0, '../x': false } }, session: true })

  await w.start()
  await w.submit('把登录模块重构成三层')
  expect(w.requests).toHaveLength(1)
  expect(await w.command('dp')).toContain('Dispatch Pilot is on')
})

test('with no store to read or write, the switches work for the session and the command says they are not saved', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), session: true })

  await w.start()
  expect(await w.command('dp', 'main-effort off')).toContain('not saved')
  await w.submit('把登录模块重构成三层')
  expect(w.requests).toHaveLength(0)
})

test('a /dp the engine refuses to register does not stop the session, and the debug log says why', { options: KEY }, async ($, on) => {
  const w = world($, on, { session: { registerError: 'the name is taken' } })

  await w.start()
  const note = w.logs.find((l) => l.text.includes('/dp was not registered'))
  expect(note?.to).toBe('debug')
  expect(note?.text).toContain('the name is taken')
})

// ---- The decision log -------------------------------------------------------

test('/dp log shows the last decisions with their reasons, newest last; /dp log N the last N; the same lines go to the debug log, not the conversation', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: (request, n) => jev(n === 1 ? [0.05, 0.1, 0.6, 0.2, 0.05] : [0.9, 0.05, 0.05, 0, 0])(request) })
  expect(await w.command('dp', 'log')).toBe('no decisions recorded yet')

  await w.submit('把登录模块重构成三层')
  await w.submit('改个错别字')
  const first = 'effort high for "把登录模块重构成三层": p low 0.05, medium 0.10, high 0.60, xhigh 0.20, max 0.05; confidence 0.70'
  const second = 'effort low for "改个错别字": p low 0.90, medium 0.05, high 0.05, xhigh 0.00, max 0.00; confidence 0.70'
  expect((await w.command('dp', 'log')).split('\n')).toEqual(['the last 2 decisions, newest last', `#1 main-effort: ${first}`, `#2 main-effort: ${second}`])
  expect((await w.command('dp', 'log 1')).split('\n')).toEqual(['the last decision, newest last', `#2 main-effort: ${second}`])

  const decisions = w.logs.filter((l) => l.text.startsWith('effort '))
  expect(decisions).toEqual([
    { text: first, to: 'debug' },
    { text: second, to: 'debug' },
  ])
  expect(w.logs.every((l) => l.to === 'debug')).toBe(true)
})

test('a decision that thetaMax held back says so in its reason', { options: { ...KEY, thetaMax: 0.6 } }, async ($, on) => {
  // Most likely max, but at 0.5, below thetaMax: the most likely of the rest.
  const w = world($, on, { backend: jev([0, 0.1, 0.15, 0.25, 0.5]) })
  await w.submit('设计一个跨区域的数据迁移方案，保证零停机')

  expect((await w.command('dp', 'log')).split('\n')[1]).toBe(
    '#1 main-effort: effort xhigh for "设计一个跨区域的数据迁移方案，保证零停机": p low 0.00, medium 0.10, high 0.15, xhigh 0.25, max 0.50; max is below thetaMax 0.60; confidence 0.70',
  )
})

test('the decision log lives in $.state, so a hot reload of the mod keeps it', { options: KEY }, async ($, on) => {
  // As an earlier load of the mod left it.
  const left = [{ n: 7, turn: 3, feature: 'main-effort', tone: 'ok' as const, outcome: 'effort max', subject: '"迁移"', reason: 'p max 0.80' }]
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), seed: { log: left } })

  expect((await w.command('dp', 'log')).split('\n')).toEqual(['the last decision, newest last', '#7 main-effort: effort max for "迁移": p max 0.80'])
  // The numbering goes on from what it left.
  await w.submit('接着做')
  expect((await w.command('dp', 'log')).split('\n').at(-1)).toContain('#8 main-effort: effort high for "接着做"')
})

test('the decision log keeps the last 20 turns', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  // One decision per message, each message a turn of its own.
  for (let i = 1; i <= 22; i++) await w.submit(`第 ${i} 条消息`)

  const lines = (await w.command('dp', 'log 100')).split('\n')
  expect(lines[0]).toBe('the last 20 decisions, newest last')
  expect(lines[1]).toContain('#3 main-effort: effort high for "第 3 条消息"')
  expect(lines.at(-1)).toContain('#22 main-effort: effort high for "第 22 条消息"')
})

test('the decision log keeps at most 300 entries, however few turns they were made in', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  await w.submit('第一条')
  // Messages typed into the running turn are decided too, and belong to it.
  for (let i = 2; i <= 305; i++) await w.submit(`第 ${i} 条消息`, { turnId: 't1' })

  const board = await w.board()
  expect(board.turn).toBe(1)
  expect(board.log).toHaveLength(300)
  expect(board.log.map((entry) => entry.turn)).toEqual(Array(300).fill(1))
  const lines = (await w.command('dp', 'log 1000')).split('\n')
  expect(lines[0]).toBe('the last 300 decisions, newest last')
  expect(lines[1]).toContain('#6 main-effort: effort high for "第 6 条消息"')
  expect(lines.at(-1)).toContain('#305 main-effort: effort high for "第 305 条消息"')
})

// ---- The signals ------------------------------------------------------------

test("the engine's measurements of the session (context, limits, cost) are written to the debug log as they come", { options: KEY }, async ($, on) => {
  const w = world($, on, { session: true })

  await w.measure({
    context: { tokens: 82_000, window: 200_000, percent: 41 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-04T18:00:00Z' }, { kind: 'seven_day', percentUsed: 7 }],
    cost: { usd: 1.234 },
    changed: ['context', 'cost'],
  })
  // A fresh session on an API key: no fill yet, no limits, no ledger.
  await w.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })

  expect(w.logs).toEqual([
    { text: 'signals: context 41% (82000/200000 tokens); limits five_hour 23.5% resets 2026-10-04T18:00:00Z, seven_day 7%; cost $1.2340; changed context, cost', to: 'debug' },
    { text: 'signals: context n/a (window 200000); limits n/a; cost n/a; changed context', to: 'debug' },
  ])
})

test('the signals are only recorded: a nearly used-up limit and a large cost change neither what is asked nor the effort', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0.05, 0.1, 0.7, 0.1, 0.05]), session: true })

  await w.measure({
    context: { tokens: 199_000, window: 200_000, percent: 99.5 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 99.9 }, { kind: 'seven_day', percentUsed: 98 }],
    cost: { usd: 250 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  await w.submit('把登录模块重构成三层')
  await w.step({ index: 0 })

  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  expect(Object.keys(w.requests[0]?.body.state)).toEqual(['user_message', 'recent_context'])
})

test('the signals switch stops the recording, and so does switching Dispatch Pilot off', { options: KEY }, async ($, on) => {
  const w = world($, on, { session: true })
  const reading = { context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [], changed: ['context' as const] }

  expect(await w.command('dp')).toMatch(/\bon +signals +\S/)
  await w.command('dp', 'signals off')
  await w.measure(reading)
  expect(w.logs).toEqual([])

  await w.command('dp', 'signals on')
  await w.command('dp', 'off')
  await w.measure(reading)
  expect(w.logs).toEqual([])

  await w.command('dp', 'on')
  await w.measure(reading)
  expect(w.logs).toHaveLength(1)
})
