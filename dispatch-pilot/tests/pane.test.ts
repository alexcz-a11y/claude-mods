// The rationale pane (spec #22 「依据面板」, #30): `/dp` (and `/dp log`) opens and closes it; the card of the agent
// picked on the band or paged to with p / n, drawn from the board's data and the rules' own working (never worked out
// again); the decision log grouped by turn, folded with a key; what is switched off and how the skill profiles went at
// its top. Seam 1: engine events and the person's commands and presses in, the pane mounted through the mod
// (`w.pane()`) and the surface's panes (`w.panes`, `w.paneActs`) out. The tests read the drawn tree by key and look for
// the data a person needs, not for whole lines of wording.

import { expect, test } from 'claude-code/testing'
import { runWorld } from './support/workflow-run.ts'
import { jev, world, type LogEntry, type ProfilesState, type Sent } from './support/world.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }
const PANE = 'dp-rationale'

/** A drawn element as plain data (what `drawn()` and `find` hand back). */
type Drawn = { type?: string; key?: string | undefined; props?: Record<string, unknown>; children?: unknown[] }

/** What a drawn element shows: its descendants' text in order, a Button as `hotkey: label`. */
function shown(element: unknown): string {
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (element === null || typeof element !== 'object') return ''
  const { children = [], props = {} } = element as Drawn
  const label = typeof props.label === 'string' ? `${typeof props.hotkey === 'string' ? `${props.hotkey}: ` : ''}${props.label}` : ''
  const kids = Array.isArray(props.children) ? props.children : children
  return label + kids.map(shown).join('')
}

// ---- opening and closing ---------------------------------------------------------

test('/dp opens the rationale pane, asking for the keys; /dp again closes it; /dp log opens the same pane, and leaves it open', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  await w.submit('改个错别字')
  expect(await w.command('dp')).toContain('依据面板')
  expect(w.panes.map((pane) => pane.id)).toEqual([PANE])
  expect(w.panes[0]).toMatchObject({ focus: true, closeOnEscape: true })
  await w.command('dp')
  expect(w.panes).toEqual([])
  await w.command('dp', 'log')
  expect(w.panes.map((pane) => pane.id)).toEqual([PANE])
  await w.command('dp', 'log')
  expect(w.panes.map((pane) => pane.id)).toEqual([PANE])
  await w.command('dp')
  expect(w.panes).toEqual([])
})

test('a pane the surface does not place is closed again at once, and the person is told why and where else to look', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), beneath: { unplaced: 'the attached desktop places no panes' } })
  await w.submit('改个错别字')
  const said = await w.command('dp')
  expect(w.panes).toEqual([])
  expect(w.paneActs.map((act) => act.act)).toEqual(['open', 'close'])
  expect(said).toContain('the attached desktop places no panes')
  expect(said).toContain('/dp log 10')
})

test('/dp status says what is on and the lock; /dp log N lists the last N decisions in the conversation, as /dp and /dp log did', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  await w.submit('改个错别字')
  expect(await w.command('dp', 'status')).toContain('Effort lock: none.')
  const lines = (await w.command('dp', 'log 1')).split('\n')
  expect(lines[0]).toBe('the last decision, newest last')
  expect(lines[1]).toContain('#1 main-effort: effort high')
  expect(w.panes).toEqual([])
})

// ---- the card ---------------------------------------------------------------------

type Ui = { find: (query: { key?: string; type?: string }) => Promise<Drawn | undefined>; findAll: (query: { key?: string; type?: string }) => Promise<Drawn[]> }

/** The rows of the rules' working on the card, as they read. */
async function steps(ui: Ui, prefix = 'pane-card-step-'): Promise<string[]> {
  return (await ui.findAll({ type: 'Box' })).filter((box) => box.key?.startsWith(prefix)).map((box) => shown(box))
}

test("the main agent's card: the effort's probabilities, the rules' working step by step, the result, and that its confidence only goes on record", { options: KEY }, async ($, on) => {
  // high most likely, xhigh close behind: the round-up takes xhigh.
  const w = world($, on, { backend: jev([0, 0.05, 0.6, 0.35, 0], { confidence: 0.25 }) })
  await w.submit('这个方案往死里挑刺')
  await w.step({ index: 0, model: 'claude-opus-5-5' })

  const ui = await w.pane()
  expect(shown(await ui.find({ key: 'pane-head' }))).toContain('主 agent')
  expect(shown(await ui.find({ key: 'pane-card-probs' }))).toMatch(/low \.00 medium \.05 high \.60 xhigh \.35 max \.00/)
  expect(await ui.find({ key: 'pane-card-probs-bar' })).toMatchObject({ type: 'Raster' })
  const rules = await steps(ui)
  expect(rules[0]).toMatch(/●.*最可能.*high \.60/)
  expect(rules[1]).toMatch(/○.*max 门槛/)
  expect(rules[2]).toMatch(/●.*上取一档.*xhigh \.35 ≥ \.30/)
  expect(rules).toHaveLength(3)
  expect(shown(await ui.find({ key: 'pane-card-result' }))).toContain('xhigh')
  expect(shown(await ui.find({ key: 'pane-card-conf' }))).toMatch(/\.25：发消息时只记录，不参与选档/)
})

test('the card draws the rules as they were stored with the decision, never working them out again from the probabilities', async ($, on) => {
  // A decision whose stored working does not follow from its probabilities: the card says what was stored.
  const board = { turn: 1, starts: [{ turn: 1, at: 0 }], nodes: [{ turn: 1, id: 'main', kind: 'main' as const, name: '主 agent', type: 'main', model: 'opus' as const, effort: 'low' as const, state: 'running' as const, t0: 0, routed: true, decision: 1 }] }
  const trace: LogEntry['trace'] = [
    { rule: 'top', applied: true, level: 'low', p: 0.41, tie: false },
    { rule: 'max-gate', applied: false, level: 'low', p: 0, thetaMax: 0.5 },
    { rule: 'round-up', applied: false, level: 'low', above: 'medium', p: 0.12, threshold: 0.3, blockedByMax: false, thetaMax: 0.5 },
  ]
  const entry = { n: 1, turn: 1, at: 0, feature: 'main-effort', agent: 'main', tone: 'ok' as const, outcome: 'effort low', subject: '"改个错别字"', reason: 'stored', probs: { low: 0, medium: 0, high: 1, xhigh: 0, max: 0 }, trace }
  const w = world($, on, { seed: { board, log: [entry] } })

  const rules = await steps(await w.pane())
  expect(rules[0]).toMatch(/最可能.*low \.41/)
  expect(rules[2]).toMatch(/上取一档.*medium \.12 < \.30，不上取/)
  expect(rules.join('\n')).not.toContain('high 1.0')
})

test("a dispatched agent's card: the model it was given, how sure the decision model was and why, then its effort's working with the model's floor", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0.8, 0.2, 0, 0, 0], { choice: 'sonnet' }) })
  await w.submit('派个 agent 去审查登录模块')
  await w.step({ index: 0 })
  const started = await w.spawn({ prompt: 'Review src/auth/login.ts and list the risks.', description: '审查登录模块' })
  await w.agentStep(started.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })

  const ui = await w.pane()
  await ui.press({ key: 'pane-next' })
  expect(shown(await ui.find({ key: 'pane-head' }))).toContain('审查登录模块')
  expect(shown(await ui.find({ key: 'pane-card-model' }))).toMatch(/sonnet.*置信 1\.0/)
  // Why, in the decision report's own words.
  expect(shown(await ui.find({ key: 'pane-card-reason' }))).toContain('pick sonnet')
  const rules = await steps(ui)
  expect(rules.at(-1)).toMatch(/▲.*模型下限.*sonnet 至少 medium，low 抬到 medium/)
  expect(shown(await ui.find({ key: 'pane-card-result' }))).toContain('medium')
})

test('not routed: the card says why in a few words, then the failure in full (its kind, the decision model, the details) and where to look', { options: { ...KEY, timeoutMs: 800 } }, async ($, on) => {
  const w = world($, on, { backend: () => ({ status: 500, body: 'down' }) })
  await w.submit('看看这个报错')
  await w.step({ index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })

  const ui = await w.pane()
  expect(shown(await ui.find({ key: 'pane-card-state' }))).toContain('未路由 · 决策模型出错')
  expect(shown(await ui.find({ key: 'pane-card-kind' }))).toContain('http')
  expect(shown(await ui.find({ key: 'pane-card-backend' }))).toContain('jev')
  expect(shown(await ui.find({ key: 'pane-card-detail' }))).toContain('jev: HTTP 500')
  expect(shown(await ui.find({ key: 'pane-card-where' }))).toContain('debug log')
  // Nothing decided: no probabilities, no rules.
  expect(await ui.find({ key: 'pane-card-probs' })).toBeUndefined()
})

/** Jev answering the message's request with `start` and each mid-turn request with the next of `midturn`. */
function answers(start: readonly number[], ...midturn: { levels: readonly number[]; confidence?: number }[]) {
  let asked = 0
  return (request: Sent) => {
    if (!Object.keys(request.body?.questions ?? {}).includes('midturn.level')) return jev(start)(request)
    const next = midturn[Math.min(asked++, midturn.length - 1)] as { levels: readonly number[]; confidence?: number }
    return jev(next.levels, { confidence: next.confidence })(request)
  }
}

test("the main agent's re-decisions on its card: a raise, a lowering held after it (steps still to wait), one short of the line (blocked), the level kept", { options: { ...KEY, rejudgeEvery: 2, holdSteps: 3 } }, async ($, on) => {
  const LOW = [0.9, 0.1, 0, 0, 0]
  const XHIGH = [0, 0, 0.1, 0.8, 0.1]
  const w = world($, on, { backend: answers([0, 1, 0, 0, 0], { levels: XHIGH, confidence: 0.8 }, { levels: LOW, confidence: 0.9 }, { levels: LOW, confidence: 0.5 }, { levels: XHIGH, confidence: 0.8 }) })
  await w.submit('把这个死锁查清楚')
  for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) await w.step({ index, answer: `第 ${index} 步`, tools: [{ tool: 'Read', input: { file_path: `/repo/f${index}.ts` } }] })
  await w.step({ index: 8 })
  expect(w.steps.map((step) => step.effort)).toEqual(['medium', 'medium', 'xhigh', 'xhigh', 'xhigh', 'xhigh', 'xhigh', 'xhigh', 'xhigh'])

  const ui = await w.pane()
  const mids = (await ui.findAll({ type: 'Box' })).filter((box) => /^pane-mid-\d+$/.test(box.key ?? '')).map((box) => shown(box))
  expect(mids).toHaveLength(4)
  expect(mids[0]).toMatch(/第 2 步.*建议 xhigh · 当前 medium.*\.80 ≥ \.30 升档线.*升到 xhigh/)
  expect(mids[1]).toMatch(/建议 low · 当前 xhigh.*防抖中，还差 1 步，保持 xhigh/)
  expect(mids[2]).toMatch(/\.50 < \.55 降档线.*降档被拦，保持 xhigh/)
  expect(mids[3]).toMatch(/建议就是当前档，保持 xhigh/)
  // Each with its confidence meter.
  expect((await ui.findAll({ type: 'Raster' })).filter((raster) => raster.key?.startsWith('pane-mid-meter-'))).toHaveLength(4)
})

// ---- a narrow pane -------------------------------------------------------------------

test('in the docked pane of 75 columns nothing is cut: a long name and a long reason wrap under their own column (a hanging indent)', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0.8, 0.2, 0, 0, 0], { choice: 'sonnet' }) })
  await w.submit('派个 agent 去审查登录模块')
  await w.step({ index: 0 })
  const name = '审查登录模块，再把发现的每个风险写成一条带复现步骤的说明，按严重程度排好'
  const started = await w.spawn({ prompt: 'Review src/auth/login.ts and list the risks.', description: name })
  await w.agentStep(started.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  const reason = (await w.board()).log.find((entry) => entry.feature === 'dispatched-agents')?.reason ?? ''
  expect(reason.length).toBeGreaterThan(75)

  const ui = await w.pane({ columns: 75 })
  await ui.press({ key: 'pane-next' })
  const all = shown(await ui.drawn())
  expect(all).toContain(name)
  expect(all).toContain(reason)
  expect(all).not.toContain('…')
  // No text is cut to a line: it wraps (the band truncates; the pane never does).
  for (const text of await ui.findAll({ type: 'Text' })) expect(String(text.props?.wrap ?? 'wrap')).toBe('wrap')
  // The reason's row: a label column of a fixed width that never shrinks, the content beside it taking the rest.
  const row = (await ui.find({ key: 'pane-card-reason' })) as Drawn
  const [label, content] = (row.children ?? []) as Drawn[]
  expect(label?.props).toMatchObject({ width: 8, flexShrink: 0 })
  expect(content?.props).toMatchObject({ flexGrow: 1, flexShrink: 1 })
  expect(row.props?.width).toBe(71)
  // The bars narrow with the pane, the short rows stay one line.
  const bars = (await ui.findAll({ type: 'Raster' })).map((raster) => Number(raster.props?.columns))
  expect(bars.every((columns) => columns >= 8 && columns <= 20)).toBe(true)
})

test('squeezed under 48 columns (an inline pane on a narrow terminal) the model chip and effort go under the name, and still nothing is cut', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0.05, 0.6, 0.35, 0]) })
  await w.submit('这个方案往死里挑刺')
  await w.step({ index: 0, model: 'claude-opus-5-5' })
  const ui = await w.pane({ columns: 40, placement: 'inline' })
  expect(shown(await ui.find({ key: 'pane-card-head' }))).not.toContain('opus')
  expect(shown(await ui.find({ key: 'pane-card-readout' }))).toMatch(/opus.*xhigh/)
  expect(shown(await ui.drawn())).not.toContain('…')
})

// ---- paging, picking, folding ----------------------------------------------------------

test('p and n page through the agents in the band\'s order, held at either end', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 1, 0, 0, 0], { choice: 'sonnet' }) })
  await w.submit('派两个 agent')
  await w.step({ index: 0 })
  const one = await w.spawn({ prompt: 'Review the diff.', description: '审查' })
  const two = await w.spawn({ prompt: 'Write the tests.', description: '写测试' })
  await w.agentStep(one.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })
  await w.agentStep(two.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })

  const ui = await w.pane()
  const head = async () => shown(await ui.find({ key: 'pane-head' }))
  expect(await head()).toMatch(/主 agent.*1\/3/)
  await ui.press({ key: 'pane-prev' })
  expect(await head()).toMatch(/主 agent.*1\/3/)
  await ui.press({ key: 'pane-next' })
  expect(await head()).toMatch(/审查.*2\/3/)
  await ui.press({ key: 'pane-next' })
  await ui.press({ key: 'pane-next' })
  expect(await head()).toMatch(/写测试.*3\/3/)
  await ui.press({ key: 'pane-prev' })
  expect(await head()).toMatch(/审查.*2\/3/)
  // p and n are their keys.
  expect((await ui.findAll({ type: 'Button' })).filter((button) => button.key === 'pane-prev' || button.key === 'pane-next').map((button) => button.props?.hotkey)).toEqual(['p', 'n'])
})

test("a digit on the band picks an agent and brings up the pane on its card, without taking the keys (the next digit still picks); the band marks it too", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 1, 0, 0, 0], { choice: 'sonnet' }) })
  await w.submit('派两个 agent')
  await w.step({ index: 0 })
  const one = await w.spawn({ prompt: 'Review the diff.', description: '审查' })
  const two = await w.spawn({ prompt: 'Write the tests.', description: '写测试' })
  await w.agentStep(one.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })
  await w.agentStep(two.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })

  const band = await w.band()
  await band.press({ key: 'band-pick-2' })
  expect(w.panes).toMatchObject([{ id: PANE, focus: false, closeOnEscape: true }])
  const pane = await w.pane()
  expect(shown(await pane.find({ key: 'pane-head' }))).toContain('写测试')
  await band.press({ key: 'band-pick-1' })
  expect(shown(await pane.find({ key: 'pane-head' }))).toContain('审查')
  expect(w.panes).toHaveLength(1)
  await band.redraw()
  expect((await band.findAll({ type: 'Box' })).filter((box) => box.key?.startsWith('band-agent-')).map((box) => shown(box).startsWith('▌'))).toEqual([false, true, false])
})

test('the decision log is grouped by turn, newest first, each with its letter key; a turn folds and opens again with its key; older turns start folded', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  for (const text of ['第一条消息', '第二条消息', '第三条消息']) {
    await w.submit(text)
    await w.step({ index: 0 })
    await w.complete()
  }

  const ui = await w.pane()
  const folds = (await ui.findAll({ type: 'Button' })).filter((button) => button.key?.startsWith('pane-fold-'))
  expect(folds.map((button) => [button.key, button.props?.hotkey])).toEqual([
    ['pane-fold-3', 'a'],
    ['pane-fold-2', 'b'],
    ['pane-fold-1', 'c'],
  ])
  const entries = async () => (await ui.findAll({ type: 'Box' })).filter((box) => box.key?.startsWith('pane-entry-')).map((box) => box.key)
  // The two newest turns open, the oldest folded.
  expect(await entries()).toEqual(['pane-entry-3', 'pane-entry-2'])
  expect(shown(await ui.find({ key: 'pane-turn-3' }))).toContain('第三条消息')
  await ui.press({ key: 'pane-fold-3' })
  expect(await entries()).toEqual(['pane-entry-2'])
  await ui.press({ key: 'pane-fold-1' })
  expect(await entries()).toEqual(['pane-entry-2', 'pane-entry-1'])
  await ui.press({ key: 'pane-fold-3' })
  expect(await entries()).toEqual(['pane-entry-3', 'pane-entry-2', 'pane-entry-1'])
})

test('the log keeps twenty turns, and each has its own fold key: none of them p, n or f', async ($, on) => {
  const log = Array.from({ length: 20 }, (_, i) => ({ n: i + 1, turn: i + 1, at: 0, feature: 'main-effort', agent: 'main', tone: 'ok' as const, outcome: 'effort high', subject: `"消息 ${i + 1}"`, reason: 'p high 1.00' }))
  const w = world($, on, { seed: { board: { turn: 20, nodes: [] }, log } })
  const keys = (await (await w.pane()).findAll({ type: 'Button' })).filter((button) => button.key?.startsWith('pane-fold-')).map((button) => String(button.props?.hotkey))
  expect(keys).toHaveLength(20)
  expect(new Set(keys).size).toBe(20)
  for (const taken of ['p', 'n', 'f']) expect(keys).not.toContain(taken)
})

// ---- the top of the pane ---------------------------------------------------------------

/** The skill profiles' state as #33 keeps it. */
function profiles(over: Partial<ProfilesState> = {}): ProfilesState {
  return { phase: 'done' as const, turn: 1, model: 'haiku', kept: 52, planned: 4, written: 3, failed: 1, deferred: 0, failures: [{ name: 'tdd', reason: 'the reply is not a profile' }], ...over }
}

test('the skill profiles at the top: how many kept, written and failed once done; 生成中 N/M while writing; why it stopped; the failed skills listed on their key', { options: KEY }, async ($, on) => {
  const w = world($, on, { seed: { profiles: profiles() } })
  const ui = await w.pane()
  expect(shown(await ui.find({ key: 'pane-profiles' }))).toContain('skill 画像：保留 52 · 新写 3 · 失败 1')
  // The failed ones by name and why, only when asked for.
  expect(await ui.find({ key: 'pane-profile-failure-0' })).toBeUndefined()
  expect((await ui.find({ key: 'pane-profile-failures' }))?.props?.hotkey).toBe('f')
  await ui.press({ key: 'pane-profile-failures' })
  expect(shown(await ui.find({ key: 'pane-profile-failure-0' }))).toMatch(/tdd.*the reply is not a profile/)
  await ui.press({ key: 'pane-profile-failures' })
  expect(await ui.find({ key: 'pane-profile-failure-0' })).toBeUndefined()
})

test('the skill profiles while they are written say 生成中 written/planned', async ($, on) => {
  const w = world($, on, { seed: { profiles: profiles({ phase: 'writing', written: 2, planned: 5, failed: 0, failures: [], deferred: 3 }) } })
  const line = shown(await (await w.pane()).find({ key: 'pane-profiles' }))
  expect(line).toContain('生成中 2/5')
  expect(line).not.toContain('失败')
})

test('the skill profiles stopped say why, with the stop\'s own words, and what is left for later', async ($, on) => {
  const w = world($, on, { seed: { profiles: profiles({ phase: 'stopped', written: 1, failed: 0, failures: [], deferred: 2, stop: { reason: 'api-error', detail: 'an API error, HTTP 529 overloaded' } }) } })
  const line = shown(await (await w.pane()).find({ key: 'pane-profiles' }))
  expect(line).toMatch(/已停写.*haiku.*API 错误.*HTTP 529 overloaded/)
  expect(line).toContain('延后 2')
})

test('what is switched off is listed in grey at the top, with the skill profiles; the profiles are left out while skills or skill-profiles is off', { options: KEY }, async ($, on) => {
  const w = world($, on, { store: {}, seed: { profiles: profiles() } })
  await w.command('dp', 'midturn-effort off')
  await w.command('dp', 'skill-profiles off')
  const ui = await w.pane()
  const off = await ui.find({ key: 'pane-off' })
  expect(shown(off)).toMatch(/已关的功能：.*midturn-effort.*skill-profiles/)
  expect(await ui.find({ key: 'pane-profiles' })).toBeUndefined()
  await w.command('dp', 'skill-profiles on')
  await ui.redraw()
  expect(shown(await ui.find({ key: 'pane-off' }))).not.toContain('skill-profiles')
  expect(await ui.find({ key: 'pane-profiles' })).toBeDefined()
})

test('the session start\'s profiles entry is in the log under its turn, its tone as #33 set it', async ($, on) => {
  const entry = { n: 1, turn: 1, at: 0, feature: 'skill-profiles', tone: 'warn' as const, outcome: 'profiles: 1 failed', subject: '', reason: '52 kept, 3 written, 1 failed (tdd: the reply is not a profile)' }
  const w = world($, on, { seed: { board: { turn: 1, nodes: [] }, log: [entry], profiles: profiles() } })
  const row = shown(await (await w.pane()).find({ key: 'pane-entry-1' }))
  expect(row).toMatch(/⚠#1 画像有失败/)
  expect(row).toContain('skill 画像')
  expect(row).toContain('tdd: the reply is not a profile')
})

// ---- the other surfaces: the same pane in text (#31) -------------------------------

const SURFACES = ['desktop', 'vscode', 'mobile'] as const

/** The element types in a drawn tree and how many nodes it has (Desktop refuses a tree of 2000). */
function inventory(element: unknown, seen: { types: Set<string>; nodes: number } = { types: new Set(), nodes: 0 }) {
  if (typeof element === 'string') {
    seen.nodes += 1
    return seen
  }
  if (element === null || typeof element !== 'object') return seen
  const { type, children = [], props = {} } = element as Drawn
  seen.nodes += 1
  if (type !== undefined) seen.types.add(type)
  for (const child of Array.isArray(props.children) ? props.children : children) inventory(child, seen)
  return seen
}

test("on a surface other than the terminal the pane is the same pane in text: the card with the probabilities as numbers, the rules' working, the mid-turn meter as its line, the log; no Raster", { options: { ...KEY, rejudgeEvery: 2, holdSteps: 3 } }, async ($, on) => {
  const LOW = [0.9, 0.1, 0, 0, 0]
  const XHIGH = [0, 0, 0.1, 0.8, 0.1]
  const w = world($, on, { backend: answers([0, 0.7, 0.3, 0, 0], { levels: XHIGH, confidence: 0.8 }, { levels: LOW, confidence: 0.5 }) })
  await w.submit('这个方案往死里挑刺')
  for (const index of [0, 1, 2, 3, 4, 5]) await w.step({ index, answer: `第 ${index} 步`, tools: [{ tool: 'Read', input: { file_path: `/repo/f${index}.ts` } }] })

  for (const surface of SURFACES) {
    const ui = await w.pane({ surface })
    expect(shown(await ui.find({ key: 'pane-head' })), surface).toContain('主 agent')
    expect(shown(await ui.find({ key: 'pane-card-probs' }))).toMatch(/low \.00 medium \.70 high \.30 xhigh \.00 max \.00/)
    const rules = await steps(ui)
    expect(rules[0]).toMatch(/●.*最可能.*medium \.70/)
    const mids = (await ui.findAll({ type: 'Box' })).filter((box) => /^pane-mid-\d+$/.test(box.key ?? '')).map((box) => shown(box))
    expect(mids.length).toBeGreaterThan(0)
    expect(mids.join('\n')).toMatch(/\.80 ≥ \.30 升档线.*升到 xhigh/)
    expect(mids.join('\n')).toMatch(/建议 low · 当前 xhigh.*防抖中，还差 1 步/)
    expect(shown(await ui.find({ key: 'pane-log-head' }))).toContain('决策日志')
    expect((await ui.findAll({ type: 'Button' })).filter((button) => button.key === 'pane-prev' || button.key === 'pane-next')).toHaveLength(2)
    expect(inventory(await ui.drawn()).types.has('Raster'), surface).toBe(false)
    await ui.unmount()
  }
})

test("on a surface other than the terminal p and n still page, and the log still folds", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 1, 0, 0, 0], { choice: 'sonnet' }) })
  await w.submit('派个 agent')
  await w.step({ index: 0 })
  const one = await w.spawn({ prompt: 'Review the diff.', description: '审查' })
  await w.agentStep(one.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })
  await w.complete()
  const ui = await w.pane({ surface: 'desktop' })
  await ui.press({ key: 'pane-next' })
  expect(shown(await ui.find({ key: 'pane-head' }))).toMatch(/审查.*2\/2/)
  expect(await ui.find({ key: 'pane-entry-1' })).toBeDefined()
  await ui.press({ key: 'pane-fold-1' })
  expect(await ui.find({ key: 'pane-entry-1' })).toBeUndefined()
})

test('a long log and a long turn do not make the pane a tree of 2000 nodes (Desktop would refuse it): the entries and re-decisions drawn are the latest, and the pane says how many are left out', async ($, on) => {
  const trace: LogEntry['trace'] = [
    { rule: 'top', applied: true, level: 'high', p: 0.6, tie: false },
    { rule: 'max-gate', applied: false, level: 'high', p: 0, thetaMax: 0.5 },
    { rule: 'round-up', applied: false, level: 'high', above: 'xhigh', p: 0.2, threshold: 0.3, blockedByMax: false, thetaMax: 0.5 },
  ]
  const probs = { low: 0, medium: 0.1, high: 0.6, xhigh: 0.2, max: 0.1 }
  const turns = Array.from({ length: 5 }, (_, i) => i + 1)
  const log: LogEntry[] = turns.flatMap((turn) =>
    Array.from({ length: 60 }, (_, j) => ({ n: turn * 1000 + j, turn, at: j, feature: 'dispatched-agents', agent: `a${j}`, tone: 'ok' as const, outcome: 'model sonnet', model: 'sonnet' as const, effort: 'medium' as const, subject: `agent ${j}`, reason: 'pick sonnet: the work is a small review', probs, trace })),
  )
  const mid = (n: number) => ({ n, turn: 5, at: n, feature: 'midturn-effort', agent: 'main', tone: 'ok' as const, outcome: 'effort kept', subject: `step ${n} (every 3 steps)`, reason: 'suggested the same', conf: 0.5, mid: { picked: 'high' as const, current: 'high' as const, result: 'high' as const }, trace: [{ rule: 'suggest', applied: true, picked: 'high', current: 'high', direction: 'same' }] })
  const mids = Array.from({ length: 60 }, (_, i) => mid(9000 + i))
  const board = { turn: 5, starts: [{ turn: 5, at: 0 }], nodes: [{ turn: 5, id: 'main', kind: 'main' as const, name: '主 agent', type: 'main', model: 'opus' as const, effort: 'high' as const, state: 'running' as const, t0: 0, routed: true, decision: 5000 }] }
  const w = world($, on, { seed: { board, log: [...mids, ...log] } })

  const ui = await w.pane({ surface: 'desktop' })
  const seen = inventory(await ui.drawn())
  expect(seen.nodes).toBeLessThan(2000)
  expect(seen.types.has('Raster')).toBe(false)
  expect(shown(await ui.find({ key: 'pane-log-more-5' }))).toMatch(/更早 \d+ 条/)
  expect(await ui.find({ key: 'pane-mid-more' })).toBeDefined()
  // The newest are the ones kept.
  expect(await ui.find({ key: 'pane-entry-5059' })).toBeDefined()
  expect(await ui.find({ key: 'pane-entry-5000' })).toBeUndefined()
  // The terminal draws it all.
  const terminal = await w.pane()
  expect(await terminal.find({ key: 'pane-entry-5000' })).toBeDefined()
  expect(await terminal.find({ key: 'pane-mid-more' })).toBeUndefined()
})

test('entries too big for the usual window (each lists dozens of skills) are drawn in a smaller one, still under 2000 nodes, the newest kept', async ($, on) => {
  const suggest = Array.from({ length: 40 }, (_, i) => ({ name: `skill-${i}`, relevance: 0.9 }))
  const log: LogEntry[] = Array.from({ length: 60 }, (_, j) => ({ n: j + 1, turn: 1, at: j, feature: 'skills', agent: 'main', tone: 'ok' as const, outcome: 'suggested', subject: `request ${j}`, reason: 'relevant', skills: { suggest, try: [] } }))
  const w = world($, on, { seed: { board: { turn: 1, nodes: [] }, log } })
  const ui = await w.pane({ surface: 'desktop' })
  expect(inventory(await ui.drawn()).nodes).toBeLessThan(2000)
  expect(await ui.find({ key: 'pane-entry-60' })).toBeDefined()
  expect(await ui.find({ key: 'pane-entry-1' })).toBeUndefined()
  expect(shown(await ui.find({ key: 'pane-log-more-1' }))).toMatch(/更早 \d+ 条/)
})
