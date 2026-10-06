// What people see on the terminal (spec #22 「Band」「脚部」, ADR 0004): the band above the prompt, the short summary
// at the right end of the footer, and a toast when a route fails; never the status row. Seam 1: engine events in,
// the screens mounted through the mod (`w.band()`, `w.footer()`) and the toasts out. The tests read the drawn trees
// by key and look for the data a person needs (a model, an effort, a reason), not for whole lines of wording.

import { expect, test } from 'claude-code/testing'
import { siteJev } from './support/workflow.ts'
import { runWorld } from './support/workflow-run.ts'
import { jev, rates, world } from './support/world.ts'

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

// ---- the band: a turn going ---------------------------------------------------------

/** A drawn element as plain data (what `drawn()` and `find` hand back). */
type Drawn = { type?: string; key?: string | undefined; props?: Record<string, unknown>; children?: unknown[] }

/** What a drawn element shows: its descendants' text in order, a Button as `hotkey: label` (FoundElement's own `text` is only its string children). */
function shown(element: unknown): string {
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (element === null || typeof element !== 'object') return ''
  const { children = [], props = {} } = element as Drawn
  const label = typeof props.label === 'string' ? `${typeof props.hotkey === 'string' ? `${props.hotkey}: ` : ''}${props.label}` : ''
  const kids = Array.isArray(props.children) ? props.children : children
  return label + kids.map(shown).join('')
}

/** The band's rows an agent each, as they read, in order. */
async function agentRows(ui: { findAll: (query: { type?: string }) => Promise<Drawn[]> }): Promise<string[]> {
  return (await ui.findAll({ type: 'Box' })).filter((box) => box.key?.startsWith('band-agent-')).map((box) => shown(box))
}

test('a turn with several agents: the main agent first, then each in the order it started, with its digit key, model, effort and state', { options: KEY }, async ($, on) => {
  // The decision model puts the main agent at xhigh and each dispatched agent on sonnet.
  const w = runWorld($, on, { backend: jev([0, 0.1, 0.2, 0.7, 0], { choice: 'sonnet' }) })
  await w.submit('把这几个模块都审查一遍')
  await w.step({ index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })
  await w.clock.advance(5000)
  const first = await w.spawn({ prompt: 'Review src/auth/login.ts and list the risks.', description: '审查登录模块', subagentType: 'Explore' })
  await w.agentStep(first.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  await w.clock.advance(3000)
  // One the engine started on its own, unknown to the decisions: its steps go out as the engine made them.
  w.agents.push({ id: 'a9', description: '写迁移脚本', type: 'general-purpose', status: 'running' })
  await w.agentStep('a9', { index: 0, model: 'claude-haiku-4-5-20251001', effort: null })
  await w.clock.advance(4000)
  await w.complete({ agentId: 'a9', durationMs: 4000 })

  const ui = await w.band({ columns: 180, rows: 12 })
  const rows = await agentRows(ui)
  const sent = w.steps.find((step) => step.agentId === first.agentId)
  expect(rows).toHaveLength(3)
  expect(rows[0]).toContain('0: 主 agent')
  expect(rows[0]).toContain('opus')
  expect(rows[0]).toContain('xhigh')
  expect(rows[1]).toContain('1: 审查登录模块')
  expect(rows[1]).toContain('sonnet')
  expect(rows[1]).toContain(String(sent?.effort))
  expect(rows[1]).toContain('运行 0:07')
  expect(rows[2]).toContain('2: 写迁移脚本')
  expect(rows[2]).toContain('haiku')
  // Not routed, with why: nothing decided it.
  expect(rows[2]).toContain('未路由 · ')
  // The digit keys: 0 the main agent, then by start.
  expect((await ui.findAll({ type: 'Button' })).map((button) => button.props.hotkey)).toEqual(['0', '1', '2'])
  // Each agent's time on the turn: a ribbon each, of the same width.
  const ribbons = await ui.findAll({ type: 'Raster' })
  expect(ribbons).toHaveLength(3)
  expect(new Set(ribbons.map((ribbon) => ribbon.props.columns)).size).toBe(1)
})

/** The script of a Workflow with three agent() calls. */
const AUDIT = `export const meta = { name: 'audit', description: 'Audit three modules', phases: [] }
const a = await agent('Audit src/auth and list the risks.', { label: 'audit:auth' })
const b = await agent('Audit src/billing and list the risks.', { label: 'audit:billing' })
const c = await agent('Audit src/search and list the risks.', { label: 'audit:search' })
return [a, b, c]
`

test("a Workflow's turn: its agents under their labels as they start, its calls not started yet queued, its progress in the strip", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: siteJev(() => ({ model: { sonnet: 0.9 }, effort: [0, 0, 1, 0, 0] })) })
  await w.submit('审计这三个模块')
  await w.step({ index: 0 })
  await w.workflow({ script: AUDIT })
  w.started('wf_test-1', 'wa1', 'audit:auth')
  w.started('wf_test-1', 'wa2', 'audit:billing')
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'high' })
  await w.clock.advance(2000)
  await w.agentStep('wa2', { index: 0, model: 'claude-sonnet-5-5', effort: 'high' })
  await w.clock.advance(3000)
  await w.complete({ agentId: 'wa1', durationMs: 5000 })

  const ui = await w.band({ columns: 180 })
  const rows = await agentRows(ui)
  expect(rows.map((row) => /\d: (audit:\w+|主 agent)/.exec(row)?.[1])).toEqual(['主 agent', 'audit:auth', 'audit:billing', 'audit:search'])
  expect(rows[1]).toContain('完成 0:05')
  expect(rows[2]).toContain('运行 0:03')
  expect(rows[3]).toContain('排队')
  // One of its three is done; the one never started is not counted as running.
  expect(shown(await ui.find({ key: 'band-strip' }))).toContain('Workflow 1/3')
  // The decisions of the script's calls are one event.
  expect(shown(await ui.drawn())).toContain('Workflow audit · 3 个 agent()')
  expect(shown(await (await w.footer()).find({ key: 'dp-footer' }))).toMatch(/\+1$/)
})

test('not routed, with why: the main agent whose decision failed and an agent started as the main agent sent it each say so in their row', { options: { ...KEY, timeoutMs: 800 } }, async ($, on) => {
  const w = runWorld($, on, { backend: () => ({ status: 500, body: 'down' }) })
  await w.submit('看看这个报错')
  await w.step({ index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })
  const started = await w.spawn({ prompt: 'Find the failing request in logs/app.log.', description: '查日志', model: 'opus' })
  await w.agentStep(started.agentId ?? '', { index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })

  const rows = await agentRows(await w.band())
  expect(rows[0]).toContain('未路由 · jev: HTTP 500')
  expect(rows[1]).toContain('opus*')
  expect(rows[1]).toContain('未路由 · jev: HTTP 500')
})

// ---- the band's event stream -----------------------------------------------------

/** The band's event rows as they read, oldest first. */
async function eventRows(ui: { findAll: (query: { type?: string }) => Promise<Drawn[]> }): Promise<string[]> {
  return (await ui.findAll({ type: 'Box' })).filter((box) => box.key?.startsWith('band-event-')).map((box) => shown(box))
}

test("the event stream: the turn's decision, the skills suggested, and an effort changed mid-turn as one event (from, to and why), not one per step", { options: { ...KEY, skillsMinRelevance: 0.5, rejudgeEvery: 0 } }, async ($, on) => {
  const first = rates({ tdd: 0.8, '(none)': 0.2 }, { tdd: 0.9 })
  const w = runWorld($, on, {
    // The message is medium; the re-decision as the agent is dispatched says xhigh, surely.
    backend: (request, n) => (n <= 2 ? first(request) : jev([0, 0, 0.1, 0.9, 0], { confidence: 0.8 })(request)),
    skills: { commands: [{ name: 'tdd', description: 'Test-driven development.', source: 'user' }], listed: [{ name: 'tdd', source: 'userSettings', tokens: 20 }] },
    disk: { '/home/u/.claude/skills/tdd/SKILL.md': '---\nname: tdd\n---\nRed, green.\n' },
  })
  await w.submit('先写失败的测试，再派个 agent 去查')
  await w.step({ index: 0, effort: 'xhigh', tools: [{ tool: 'Agent', input: { description: '查' } }] })
  await w.clock.advance(2000)
  for (const index of [1, 2, 3]) await w.step({ index, effort: 'xhigh' })
  expect(w.steps.map((step) => step.effort)).toEqual(['medium', 'xhigh', 'xhigh', 'xhigh'])

  const events = await eventRows(await w.band())
  expect(events).toHaveLength(3)
  expect(events[0]).toMatch(/决定.*主 agent → medium/)
  expect(events[1]).toMatch(/推荐.*tdd \.90/)
  expect(events[2]).toMatch(/重判.*medium → xhigh.*置信 \.80/)
  expect(events.some((event) => event.includes('改档'))).toBe(false)
})

test('a forced raise is an event of its own, with the failures that forced it', { options: { ...KEY, rejudgeEvery: 0, escalateAfter: 2 } }, async ($, on) => {
  // Medium for the message; the failures are not what the work expects.
  const w = runWorld($, on, { backend: jev([0, 1, 0, 0, 0], { nouls: { 'escalation.expected': 0.05 } }) })
  await w.submit('把登录模块重构成三层')
  const failing = { tool: 'Bash', input: { command: 'pnpm test' }, ends: { error: 'exit 1' } }
  await w.step({ index: 0, tools: [failing, failing] })
  await w.step({ index: 1 })
  expect(w.steps.map((step) => step.effort)).toEqual(['medium', 'high'])

  const events = await eventRows(await w.band())
  expect(events.at(-1)).toMatch(/升档.*主 agent  medium → high.*失败 2/)
})

test('what only the old status line used to say is in the stream now: a re-decision that failed, a skills request that gave nothing', { options: { ...KEY, rejudgeEvery: 0 } }, async ($, on) => {
  const w = runWorld($, on, { backend: (request, n) => (n === 1 ? jev([0, 1, 0, 0, 0])(request) : { status: 500, body: 'down' }) })
  await w.submit('派个 agent 去查')
  await w.step({ index: 0, tools: [{ tool: 'Agent', input: { description: '查' } }] })
  await w.step({ index: 1 })

  const events = await eventRows(await w.band())
  expect(events.at(-1)).toMatch(/失败.*中途重判失败 · jev: HTTP 500/)
})

// ---- what is switched off, what is picked, what is never shown -------------------------

test('a feature switched off leaves the band and the footer: its decisions, its notes and the parts of the board it owns; on again, they are back', { options: { ...KEY, skillsMinRelevance: 0.5, rejudgeEvery: 0 } }, async ($, on) => {
  const first = rates({ tdd: 0.8, '(none)': 0.2 }, { tdd: 0.9 })
  const w = runWorld($, on, {
    backend: (request, n) => (n <= 2 ? first(request) : jev([0, 0, 0.1, 0.9, 0], { confidence: 0.8 })(request)),
    skills: { commands: [{ name: 'tdd', description: 'Test-driven development.', source: 'user' }], listed: [{ name: 'tdd', source: 'userSettings', tokens: 20 }] },
    disk: { '/home/u/.claude/skills/tdd/SKILL.md': '---\nname: tdd\n---\nRed, green.\n' },
    store: {},
  })
  await w.submit('先写失败的测试，再派个 agent 去查')
  await w.step({ index: 0, tools: [{ tool: 'Agent', input: { description: '查' } }] })
  await w.step({ index: 1 })
  const all = shown(await (await w.band()).drawn())
  expect(all).toContain('推荐')
  expect(all).toContain('中途重判 2 次')

  for (const name of ['skills', 'midturn-effort']) await w.command('dp', `${name} off`)
  const ui = await w.band()
  const left = shown(await ui.drawn())
  expect(left).not.toContain('推荐')
  expect(left).not.toContain('重判')
  // What stands is the readout: the main agent at the effort its steps go out with.
  expect((await agentRows(ui))[0]).toContain('xhigh')

  await w.command('dp', 'skills on')
  expect(shown(await (await w.band()).drawn())).toContain('推荐')
})

test("main-effort switched off: the main agent is not routed, and its row says the feature is off", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 1, 0, 0, 0]), store: {} })
  await w.command('dp', 'main-effort off')
  await w.submit('改个错别字')
  await w.step({ index: 0, effort: 'xhigh' })
  expect((await agentRows(await w.band()))[0]).toContain('未路由 · 功能已关')
})

test('Dispatch Pilot switched off: the band shows nothing of it, the footer says it is off', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 1, 0, 0, 0]), store: {}, beneath: { render: { AbovePrompt: 'another mod' } } })
  await w.submit('改个错别字')
  await w.step({ index: 0 })
  await w.command('dp', 'off')
  expect(shown(await (await w.band()).drawn())).toBe('another mod')
  expect(shown(await (await w.footer()).find({ key: 'dp-footer' }))).toBe('○ dp 已关')
})

test("a digit picks an agent for the rationale pane: its row is marked, and the pick holds as the board changes", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 1, 0, 0, 0], { choice: 'sonnet' }) })
  await w.submit('派两个 agent')
  await w.step({ index: 0 })
  const one = await w.spawn({ prompt: 'Review the diff.', description: '审查' })
  const two = await w.spawn({ prompt: 'Write the tests.', description: '写测试' })
  await w.agentStep(one.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })
  await w.agentStep(two.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })

  const ui = await w.band()
  expect((await agentRows(ui)).some((row) => row.startsWith('▌'))).toBe(false)
  await ui.press({ key: 'band-pick-2' })
  await ui.redraw()
  const rows = await agentRows(ui)
  expect(rows[2]).toMatch(/^▌.*2: 写测试/)
  expect(rows.filter((row) => row.startsWith('▌'))).toHaveLength(1)
})

test('the skill profiles are never shown on the band or in the footer: neither their state nor their log entry', { options: KEY }, async ($, on) => {
  const profiles = { phase: 'writing' as const, turn: 1, model: 'haiku', kept: 3, planned: 5, written: 2, failed: 1, deferred: 4, failures: [{ name: 'tdd', reason: 'the reply is not a profile' }] }
  const entry = { n: 1, turn: 1, at: 0, feature: 'skill-profiles', tone: 'warn' as const, outcome: 'profiles: 1 failed', subject: '', reason: '3 kept, 2 written, 1 failed (tdd: the reply is not a profile)' }
  const w = runWorld($, on, { backend: jev([0, 1, 0, 0, 0]), seed: { profiles, log: [entry] } })
  await w.submit('改个错别字')
  await w.step({ index: 0 })
  const live = shown(await (await w.band()).drawn())
  await w.complete()
  const idle = shown(await (await w.band({ isWorking: false })).drawn())
  const footer = shown(await (await w.footer()).drawn())
  for (const text of [live, idle, footer]) {
    expect(text).not.toMatch(/profile|画像|haiku|2\/5|tdd/)
  }
  // The turn's own decision is there all the same.
  expect(live).toContain('主 agent → medium')
})

// ---- the band: a turn over, a band squeezed, other mods ------------------------------

test("once the turn is over the band is one line: the main agent's model and effort, how the rules came to it, the skills to try", { options: { ...KEY, skillsMinRelevance: 0.5 } }, async ($, on) => {
  const w = runWorld($, on, {
    backend: rates({ 'grill-me': 0.7, '(none)': 0.3 }, { 'grill-me': 0.9 }, [0, 0.05, 0.6, 0.35, 0]),
    skills: { commands: [{ name: 'grill-me', description: 'Interview the user relentlessly about a plan.', source: 'user' }], listed: [] },
    disk: { '/home/u/.claude/skills/grill-me/SKILL.md': '---\nname: grill-me\ndisable-model-invocation: true\n---\nAsk.\n' },
  })
  await w.submit('这个方案往死里挑刺')
  await w.step({ index: 0, model: 'claude-opus-5-5' })
  await w.clock.advance(9000)
  await w.complete({ durationMs: 9000 })

  const ui = await w.band({ isWorking: false })
  expect(await ui.find({ key: 'band' })).toBeUndefined()
  const line = shown(await ui.find({ key: 'band-idle' }))
  expect(line).toContain('第 1 轮')
  expect(line).toContain('opus·xhigh')
  // xhigh came from the round-up: high was most likely, xhigh close behind.
  expect(line).toContain('上取一档 xhigh .35')
  expect(line).toContain('可试 /grill-me')
})

test("squeezed under four rows, a turn going is one line, with the main agent's readout", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0]) })
  await w.submit('改个错别字')
  await w.step({ index: 0, model: 'claude-opus-5-5' })
  for (const rows of [1, 3]) {
    const ui = await w.band({ rows })
    expect(await ui.find({ key: 'band' })).toBeUndefined()
    expect(shown(await ui.find({ key: 'band-squeezed' }))).toContain('opus·high')
    await ui.unmount()
  }
  expect(await (await w.band({ rows: 4 })).find({ key: 'band' })).toBeDefined()
})

test("what another mod draws in the band keeps its place, above Dispatch Pilot's; in the footer the engine's modes come first", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0]), beneath: { render: { AbovePrompt: 'another mod', SessionMode: 'focus' } } })
  await w.submit('改个错别字')
  await w.step({ index: 0 })
  const band = shown(await (await w.band()).drawn())
  expect(band.indexOf('another mod')).toBe(0)
  expect(band).toContain('第 1 轮')
  const footer = shown(await (await w.footer()).drawn())
  expect(footer.indexOf('focus')).toBe(0)
  expect(footer).toContain('opus·high')
})

test('before any turn, and on a surface other than the terminal, the band and the footer are what the engine and other mods draw', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0]), beneath: { render: { AbovePrompt: 'another mod' } } })
  expect(shown(await (await w.band()).drawn())).toBe('another mod')
  expect(await (await w.footer()).find({ key: 'dp-footer' })).toBeUndefined()
  await w.submit('改个错别字')
  await w.step({ index: 0 })
  expect(shown(await (await w.band({ surface: 'desktop' })).drawn())).toBe('another mod')
  expect(await (await w.footer({ surface: 'desktop' })).find({ key: 'dp-footer' })).toBeUndefined()
})

// ---- the footer -------------------------------------------------------------------

/** Cells a footer text takes on the terminal (CJK two, the rest one). */
function cellsOf(text: string): number {
  let n = 0
  for (const ch of text) n += /[　-鿿＀-￯]/.test(ch) ? 2 : 1
  return n
}

type Seed = NonNullable<NonNullable<NonNullable<Parameters<typeof world>[2]>['seed']>['board']>

/** A board whose turn has the main agent at `model`·`effort` and `running` agents running. */
function boardOf(model: 'haiku' | 'sonnet' | 'opus' | 'fable', effort: 'medium' | 'xhigh' | undefined, running: number): Seed {
  const main = { turn: 1, id: 'main', kind: 'main' as const, name: '主 agent', type: 'main', model, ...(effort === undefined ? {} : { effort }), state: 'running' as const, t0: 0, routed: true }
  const agents = Array.from({ length: running }, (_, i) => ({ turn: 1, id: `a${i}`, kind: 'agent' as const, name: `agent ${i}`, type: 'Explore', model: 'sonnet' as const, effort: 'medium' as const, state: 'running' as const, t0: 1, routed: true }))
  return { turn: 1, starts: [{ turn: 1, at: 0 }], nodes: [main, ...agents] }
}

// The longest of each kind: sonnet·medium, fable·xhigh, a haiku main agent without effort, opus·xhigh.
const FOOTERS: { model: 'haiku' | 'sonnet' | 'opus' | 'fable'; effort: 'medium' | 'xhigh' | undefined }[] = [
  { model: 'sonnet', effort: 'medium' },
  { model: 'fable', effort: 'xhigh' },
  { model: 'opus', effort: 'xhigh' },
  { model: 'haiku', effort: undefined },
]

for (const { model, effort } of FOOTERS) {
  for (const running of [0, 3, 12]) {
    test(`the footer takes at most 12 columns: the state glyph, the main agent's model·effort, +N agents running (${model}·${String(effort)}, ${running} running)`, async ($, on) => {
      const w = world($, on, { seed: { board: boardOf(model, effort, running) } })
      const text = shown(await (await w.footer()).find({ key: 'dp-footer' }))
      expect(cellsOf(text)).toBeLessThanOrEqual(12)
      // The effort (or, short of room, its short form) is always there, and the running agents; the model while it fits.
      if (effort !== undefined) expect(text).toMatch(effort === 'xhigh' ? /xhi/ : /med/)
      if (running > 0) expect(text).toContain(`+${running}`)
      if (running === 0) expect(text).toContain(model)
    })
  }
}
