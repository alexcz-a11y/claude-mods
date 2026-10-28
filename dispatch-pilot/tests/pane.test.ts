// The rationale pane (spec #22 「依据面板」, #30): `/dp` (and `/dp log`) opens and closes it; the card of the agent
// picked on the band or paged to with p / n, drawn from the board's data and the rules' own working (never worked out
// again); the decision log grouped by turn, folded with a key; what is switched off at
// its top. Seam 1: engine events and the person's commands and presses in, the pane mounted through the mod
// (`w.pane()`) and the surface's panes (`w.panes`, `w.paneActs`) out. The tests read the drawn tree by key and look for
// the data a person needs, not for whole lines of wording.

import { expect, test } from 'claude-code/testing'
import { type Drawn, inventory, shown } from './support/drawn.ts'
import { runWorld } from './support/workflow-run.ts'
import { jev, KEY, type LogEntry, type Sent, world } from './support/world.ts'

const PANE = 'dp-rationale'

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
  expect(await w.command('dp', 'status')).toContain('effort 锁定：没有。')
  const lines = (await w.command('dp', 'log 1')).split('\n')
  expect(lines[0]).toBe('最近 1 条决定，最新的在最后')
  expect(lines[1]).toContain('#1 main-effort：effort high')
  expect(w.panes).toEqual([])
})

// ---- the card ---------------------------------------------------------------------

type Ui = { find: (query: { key?: string; type?: string }) => Promise<Drawn | undefined>; findAll: (query: { key?: string; type?: string }) => Promise<Drawn[]> }

/** The rows of the rules' working on the card, as they read. */
async function steps(ui: Ui, prefix = 'pane-card-step-'): Promise<string[]> {
  return (await ui.findAll({ type: 'Box' })).filter((box) => box.key?.startsWith(prefix)).map((box) => shown(box))
}

test("the main agent's card: why, the effort's probabilities, the rules' working step by step, the result, and its confidence, which only goes on record", { options: KEY }, async ($, on) => {
  // Position 2.30 rounds to high; the cause of a failure is unknown (a Noul at 0.8): R3 lifts it to xhigh.
  const w = world($, on, { backend: jev([0, 0.05, 0.6, 0.35, 0], { confidence: 0.25, nouls: { 'effort.cause_unknown': 0.8 } }) })
  await w.submit('这个方案往死里挑刺')
  await w.step({ index: 0, model: 'claude-opus-5-5' })

  const ui = await w.pane()
  expect(shown(await ui.find({ key: 'pane-head' }))).toContain('主 agent')
  // Why, in the decision report's own words, as for any agent (spec story 24).
  const reason = (await w.board()).log.find((entry) => entry.feature === 'main-effort')?.reason ?? ''
  expect(reason).toContain('置信度 0.25')
  expect(shown(await ui.find({ key: 'pane-card-reason' }))).toContain(reason)
  expect(shown(await ui.find({ key: 'pane-card-probs' }))).toMatch(/low \.00 medium \.05 high \.60 xhigh \.35 max \.00/)
  expect(await ui.find({ key: 'pane-card-probs-bar' })).toMatchObject({ type: 'Raster' })
  const rules = await steps(ui)
  expect(rules[0]).toMatch(/●.*位置.*2\.30，四舍五入到 high/)
  expect(rules[1]).toMatch(/○.*双峰/)
  expect(rules[3]).toMatch(/○.*要求多想/)
  expect(rules[4]).toMatch(/○.*确认/)
  expect(rules[5]).toMatch(/○.*出错代价/)
  expect(rules[6]).toMatch(/▲.*原因未知/)
  // The base, the second peak and the seven floors of the person's message, in order.
  expect(rules).toHaveLength(9)
  expect(shown(await ui.find({ key: 'pane-card-result' }))).toContain('xhigh')
  expect(shown(await ui.find({ key: 'pane-card-conf' }))).toMatch(/\.25：只记录，不参与定档/)
})

test('the card draws the rules as they were stored with the decision, never working them out again from the probabilities', async ($, on) => {
  // A decision whose stored working does not follow from its probabilities: the card says what was stored.
  const board = { turn: 1, starts: [{ turn: 1, at: 0 }], nodes: [{ turn: 1, id: 'main', kind: 'main' as const, name: '主 agent', type: 'main', model: 'opus' as const, effort: 'low' as const, state: 'running' as const, t0: 0, routed: true, decision: 1 }] }
  const trace: LogEntry['trace'] = [
    { rule: 'position', applied: true, level: 'low', position: 0.41 },
    { rule: 'two-peaked', applied: false, level: 'low', peak: null, p: 0, threshold: 0.3 },
    { rule: 'stakes', applied: false, level: 'low', floor: null, undo: 0.1, undoVerdict: 'no', live: 0, liveVerdict: 'no', access: 0, accessVerdict: 'no', yes: 0.7, no: 0.3 },
  ]
  const entry = { n: 1, turn: 1, at: 0, feature: 'main-effort', agent: 'main', tone: 'ok' as const, outcome: 'effort low', subject: '"改个错别字"', reason: 'stored', probs: { low: 0, medium: 0, high: 1, xhigh: 0, max: 0 }, trace }
  const w = world($, on, { seed: { board, log: [entry] } })

  const rules = await steps(await w.pane())
  expect(rules[0]).toMatch(/位置.*0\.41，四舍五入到 low/)
  expect(rules[2]).toMatch(/○.*出错代价/)
  expect(rules.join('\n')).not.toContain('high 1.0')
})

test("a dispatched agent's card: the model it was given and why, then the rules' working: the Nouls about its brief, the model table, the effort's base and floors with the model's", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0.8, 0.2, 0, 0, 0], { choice: 'sonnet' }) })
  await w.submit('派个 agent 去审查登录模块')
  await w.step({ index: 0 })
  const started = await w.spawn({ prompt: 'Review src/auth/login.ts and list the risks.', description: '审查登录模块' })
  await w.agentStep(started.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })

  const ui = await w.pane()
  await ui.press({ key: 'pane-next' })
  expect(shown(await ui.find({ key: 'pane-head' }))).toContain('审查登录模块')
  expect(shown(await ui.find({ key: 'pane-card-model' }))).toMatch(/sonnet/)
  // Why, in the decision report's own words.
  expect(shown(await ui.find({ key: 'pane-card-reason' }))).toContain('模型表第 5 行 → sonnet')
  const rules = await steps(ui)
  expect(rules[0]).toMatch(/只读查找写入 \.00（否） · 一两步 \.00（否） · 只汇报 \.00（否）/)
  expect(rules[1]).toMatch(/审慎难以挽回 \.00（否）.*科学计算 \.00（否）/)
  expect(rules[2]).toMatch(/模型表.*第 5 行 → sonnet/)
  expect(rules.at(-1)).toMatch(/▲.*模型下限.*sonnet 至少 medium，low 抬到 medium/)
  expect(shown(await ui.find({ key: 'pane-card-result' }))).toContain('medium')
})

test('not routed: the card says why in a few words, then the failure in full (its kind, the decision model, the details) and where to look', { options: { ...KEY, timeoutMs: 800 } }, async ($, on) => {
  const w = world($, on, { backend: () => ({ status: 500, body: 'down' }) })
  await w.submit('看看这个报错')
  await w.step({ index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })

  const ui = await w.pane()
  expect(shown(await ui.find({ key: 'pane-card-state' }))).toContain('未路由 · 决策模型出错')
  expect(shown(await ui.find({ key: 'pane-card-kind' }))).toContain('出错的状态码')
  expect(shown(await ui.find({ key: 'pane-card-backend' }))).toContain('jev')
  expect(shown(await ui.find({ key: 'pane-card-detail' }))).toContain('jev：出错（状态码 500）')
  expect(shown(await ui.find({ key: 'pane-card-where' }))).toContain('debug log')
  // Nothing decided: no probabilities, no rules.
  expect(await ui.find({ key: 'pane-card-probs' })).toBeUndefined()
})

test('not routed with a reason but no failed request: the state row says it, and the card does not say it again', async ($, on) => {
  const main = { turn: 1, id: 'main', kind: 'main' as const, name: '主 agent', type: 'main', state: 'running' as const, t0: 0, routed: false, why: '这一轮没有判断出档位' }
  const w = world($, on, { seed: { board: { turn: 1, starts: [{ turn: 1, at: 0 }], nodes: [main] } } })
  const ui = await w.pane()
  expect(shown(await ui.find({ key: 'pane-card-state' }))).toContain('未路由 · 这一轮没有判断出档位')
  expect(await ui.find({ key: 'pane-card-why' })).toBeUndefined()
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
  expect(shown(await ui.find({ key: 'pane-card-readout' }))).toMatch(/opus.*high/)
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

test("a digit whose pane the surface does not place tells the person so in a toast (why, and where else to look), no more than one within two seconds; the pane is closed again", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 1, 0, 0, 0], { choice: 'sonnet' }), beneath: { unplaced: 'the attached desktop places no panes' } })
  await w.submit('派个 agent')
  await w.step({ index: 0 })
  const one = await w.spawn({ prompt: 'Review the diff.', description: '审查' })
  await w.agentStep(one.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })

  const band = await w.band()
  await band.press({ key: 'band-pick-1' })
  expect(w.panes).toEqual([])
  expect(w.paneActs.map((act) => act.act)).toEqual(['open', 'close'])
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]?.text).toContain('依据面板没有放出来')
  expect(w.toasts[0]?.text).toContain('the attached desktop places no panes')
  expect(w.toasts[0]?.text).toContain('/dp log 10')
  // Pressed again at once: the engine would drop a second toast, so none is raised; later, one is.
  await band.press({ key: 'band-pick-0' })
  expect(w.toasts).toHaveLength(1)
  await w.clock.advance(2500)
  await band.press({ key: 'band-pick-0' })
  expect(w.toasts).toHaveLength(2)
})

test('the decision log is grouped by turn, newest first, each with its letter key; a turn folds and opens again with its key; older turns start folded', { options: KEY }, async ($, on) => {
  // The cheap model writes each turn's summary (no entry of the log: only a write that fails is told).
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), model: () => ({ text: '{"problem": "p", "tried": ["a"], "status": "s"}' }) })
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

test("a turn's header counts its entries by the glyph each row draws: ✔ the decisions made, · the plain records, ⚠ and ✘", async ($, on) => {
  const entry = (n: number, tone: LogEntry['tone']) => ({ n, turn: 1, at: 0, feature: 'escalation', agent: 'a1', tone, outcome: 'model claude-opus-5-5', subject: `第 ${n} 步`, reason: 'x' })
  const w = world($, on, { seed: { board: { turn: 1, nodes: [] }, log: [entry(1, 'ok'), entry(2, 'ok'), entry(3, 'info'), entry(4, 'warn'), entry(5, 'info'), entry(6, 'info')] } })
  const ui = await w.pane()
  const head = shown(((await ui.find({ key: 'pane-turn-1' })) as Drawn).children?.[0])
  expect(head).toContain('6 条 ✔2 ·3 ⚠1')
  expect(head).not.toContain('✘')
  // Each row's own glyph says the same.
  const glyphs = (await ui.findAll({ type: 'Box' })).filter((box) => box.key?.startsWith('pane-entry-')).map((box) => shown(box).slice(0, 1))
  expect(glyphs).toEqual(['✔', '✔', '·', '⚠', '·', '·'])
})

test('the band and the pane call each feature by the same GLOSSARY word: 失败升模型, Workflow 兜底', async ($, on) => {
  const board = { turn: 1, starts: [{ turn: 1, at: 0 }], nodes: [{ turn: 1, id: 'main', kind: 'main' as const, name: '主 agent', type: 'main', state: 'running' as const, t0: 0, routed: true }], notes: [{ turn: 1, id: 'wa1', feature: 'escalation', at: 2, after: 2, kind: 'skipped' as const, why: 'error' }] }
  const log: LogEntry[] = [
    { n: 1, turn: 1, at: 1, feature: 'workflow-labels', agent: 'wa1', tone: 'ok', outcome: 'sonnet high', subject: '"audit"（agent wa1，Workflow audit）', reason: 'x' },
    { n: 2, turn: 1, at: 2, feature: 'escalation', agent: 'wa1', tone: 'info', outcome: 'model claude-opus-5-5（保持）', subject: 'agent wa1，第 2 步，工具调用失败 2 次', reason: 'x' },
  ]
  const w = world($, on, { seed: { board, log } })
  const band = shown(await (await w.band()).drawn())
  expect(band).toContain('失败升模型 · 出错了，见 debug log')
  const pane = await w.pane()
  expect(shown(await pane.find({ key: 'pane-entry-2' }))).toContain('失败升模型  agent wa1')
  expect(shown(await pane.find({ key: 'pane-entry-1' }))).toContain('Workflow 兜底')
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

/** The state word and ink a switch is listed with at the pane's top. */
async function listed(ui: Ui, name: string) {
  const item = await ui.find({ key: `pane-switch-${name}` })
  const ink = (item?.children?.[0] as Drawn | undefined)?.props?.color
  return { text: shown(item).trim(), color: ink }
}

test('every feature switch is listed at the top with its state, the ones off in grey (default-off ones included)', { options: KEY }, async ($, on) => {
  const w = world($, on, { store: {} })
  await w.command('dp', 'escalation off')
  const ui = await w.pane()
  expect(await ui.find({ key: 'pane-off' })).toBeUndefined()
  const names = (await ui.findAll({ type: 'Box' })).filter((box) => box.key?.startsWith('pane-switch-')).map((box) => box.key?.slice('pane-switch-'.length))
  expect(names).toEqual(expect.arrayContaining(['main-effort', 'dispatched-agents', 'workflow-agents', 'workflow-labels', 'escalation', 'skills', 'find-skill', 'hook-block-failures', 'signals', 'summary']))
  // The skill profiles went with ADR 0018, and their switch with them.
  expect(names).not.toContain('skill-profiles')
  expect(await listed(ui, 'main-effort')).toMatchObject({ text: 'main-effort 开', color: undefined })
  expect(await listed(ui, 'escalation')).toMatchObject({ text: 'escalation 关', color: 'inactive' })
  expect(await listed(ui, 'hook-block-failures')).toMatchObject({ text: 'hook-block-failures 关', color: 'inactive' })
  // The problem summary is on until the person turns it off (ADR 0014); the count it went with has no switch any more.
  expect(await listed(ui, 'summary')).toMatchObject({ text: 'summary 开', color: undefined })
  expect(names).not.toContain('unresolved')
})

test('with the whole mod off the pane says so, and still lists the switches', { options: KEY }, async ($, on) => {
  const w = world($, on, { store: {} })
  await w.command('dp', 'off')
  const ui = await w.pane()
  expect(shown(await ui.find({ key: 'pane-off' }))).toContain('Dispatch Pilot 已关')
  expect(await ui.find({ key: 'pane-switch-main-effort' })).toBeDefined()
})

// ---- the other surfaces: the same pane in text (#31) -------------------------------

const SURFACES = ['desktop', 'vscode', 'mobile'] as const

test("on a surface other than the terminal the pane is the same pane: the card with the probabilities as a bar (an Svg) and numbers, the rules' working, the log; no Raster", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0.7, 0.3, 0, 0]) })
  await w.submit('这个方案往死里挑刺')
  for (const index of [0, 1, 2, 3, 4, 5]) await w.step({ index, answer: `第 ${index} 步`, tools: [{ tool: 'Read', input: { file_path: `/repo/f${index}.ts` } }] })

  for (const surface of SURFACES) {
    const ui = await w.pane({ surface })
    expect(shown(await ui.find({ key: 'pane-head' })), surface).toContain('主 agent')
    expect(shown(await ui.find({ key: 'pane-card-probs' }))).toMatch(/low \.00 +medium \.70 +high \.30 +xhigh \.00 +max \.00/)
    const rules = await steps(ui)
    expect(rules[0]).toMatch(/●.*位置.*1\.30，四舍五入到 medium/)
    expect(shown(await ui.find({ key: 'pane-log-head' }))).toContain('决策日志')
    // The switches as words and ‹ 上一个 / 下一个 › are the terminal's; here tabs and buttons (desktop-pane.test.ts).
    expect(inventory(await ui.drawn()).types.has('Raster'), surface).toBe(false)
    const svgs = (await ui.findAll({ type: 'Svg' })).map((svg) => String(svg.props.alt))
    expect(svgs, surface).toContain('effort 概率：low .00 medium .70 high .30 xhigh .00 max .00')
    expect(await ui.find({ key: 'pane-card-probs-bar' }), surface).toMatchObject({ type: 'Box' })
    await ui.unmount()
  }
})

test("on a surface other than the terminal the agents are picked from tabs (desktop-pane.test.ts), and the log still folds", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 1, 0, 0, 0], { choice: 'sonnet' }) })
  await w.submit('派个 agent')
  await w.step({ index: 0 })
  const one = await w.spawn({ prompt: 'Review the diff.', description: '审查' })
  await w.agentStep(one.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })
  await w.complete()
  const ui = await w.pane({ surface: 'desktop' })
  await ui.press({ key: 'pane-tab-1' })
  await ui.redraw()
  expect(shown(await ui.find({ key: 'pane-card-head' }))).toContain('审查')
  expect(await ui.find({ key: 'pane-entry-1' })).toBeDefined()
  await ui.press({ key: 'pane-fold-1' })
  expect(await ui.find({ key: 'pane-entry-1' })).toBeUndefined()
})

test('a long log does not make the pane a tree of 2000 nodes (Desktop would refuse it): the entries drawn are the latest, and the pane says how many are left out', async ($, on) => {
  const trace: LogEntry['trace'] = [
    { rule: 'position', applied: true, level: 'high', position: 2.3 },
    { rule: 'two-peaked', applied: false, level: 'high', peak: null, p: 0, threshold: 0.3 },
    { rule: 'model-floor', applied: false, level: 'high', from: 'high', model: 'sonnet', floor: 'medium' },
  ]
  const probs = { low: 0, medium: 0.1, high: 0.6, xhigh: 0.2, max: 0.1 }
  const turns = Array.from({ length: 5 }, (_, i) => i + 1)
  const log: LogEntry[] = turns.flatMap((turn) =>
    Array.from({ length: 60 }, (_, j) => ({ n: turn * 1000 + j, turn, at: j, feature: 'dispatched-agents', agent: `a${j}`, tone: 'ok' as const, outcome: 'model sonnet', model: 'sonnet' as const, effort: 'medium' as const, subject: `agent ${j}`, reason: 'pick sonnet: the work is a small review', probs, trace })),
  )
  const board = { turn: 5, starts: [{ turn: 5, at: 0 }], nodes: [{ turn: 5, id: 'main', kind: 'main' as const, name: '主 agent', type: 'main', model: 'opus' as const, effort: 'high' as const, state: 'running' as const, t0: 0, routed: true, decision: 5000 }] }
  const w = world($, on, { seed: { board, log } })

  const ui = await w.pane({ surface: 'desktop' })
  const seen = inventory(await ui.drawn())
  expect(seen.nodes).toBeLessThan(2000)
  expect(seen.types.has('Raster')).toBe(false)
  expect(shown(await ui.find({ key: 'pane-log-more-5' }))).toMatch(/更早 \d+ 条/)
  // The newest are the ones kept.
  expect(await ui.find({ key: 'pane-entry-5059' })).toBeDefined()
  expect(await ui.find({ key: 'pane-entry-5000' })).toBeUndefined()
  // The terminal draws it all.
  const terminal = await w.pane()
  expect(await terminal.find({ key: 'pane-entry-5000' })).toBeDefined()
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

// ---- an agent's transcript in the main view (`$.ui.view`, 2.1.300) ---------------------------------------------------

test("a dispatched agent's card offers its transcript (x): the press puts it in the main view; a view the engine refuses says why in a toast", { options: KEY }, async ($, on) => {
  const views: { agentId?: string }[] = []
  let refuse: string | undefined
  on('ui.view', (_$, e) => {
    views.push(e)
    // The engine's own refusal is its answer, not a hook's deny.
    return { value: refuse === undefined ? {} : { deny: refuse } }
  })
  const w = runWorld($, on, { backend: jev([0, 1, 0, 0, 0], { choice: 'sonnet' }) })
  await w.submit('派个 agent 去审查登录模块')
  await w.step({ index: 0 })
  const started = await w.spawn({ prompt: 'Review src/auth/login.ts and list the risks.', description: '审查登录模块' })
  await w.agentStep(started.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })

  const ui = await w.pane()
  // The main agent's own card: nothing to open.
  expect(await ui.find({ key: 'pane-view-button' })).toBeUndefined()
  await ui.press({ key: 'pane-next' })
  expect(shown(await ui.find({ key: 'pane-view' }))).toContain('看它的对话 (x)')
  await ui.press({ key: 'pane-view-button' })
  expect(views).toEqual([{ agentId: started.agentId }])

  refuse = 'no agent holds the id'
  await ui.press({ key: 'pane-view-button' })
  expect(w.toasts.at(-1)?.text).toBe('没能打开这个 agent 的对话：no agent holds the id')
})

test("while an agent's transcript is in the main view, the pane offers the main conversation back (x), whichever card is picked", { options: KEY }, async ($, on) => {
  const views: { agentId?: string }[] = []
  on('ui.view', (_$, e) => {
    views.push(e)
    return { value: {} }
  })
  const w = runWorld($, on, { backend: jev([0, 1, 0, 0, 0], { choice: 'sonnet' }) })
  await w.submit('派个 agent 去审查登录模块')
  const started = await w.spawn({ prompt: 'Review src/auth/login.ts and list the risks.', description: '审查登录模块' })
  const ui = await w.pane({ view: started.agentId })
  expect(shown(await ui.find({ key: 'pane-view' }))).toContain('↩ 回主对话 (x)')
  await ui.press({ key: 'pane-view-button' })
  expect(views).toEqual([{}])
})

test("a Workflow agent's card offers no transcript: the engine refuses to show a run's agent (2.1.302)", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, {})
  await w.submit('跑一个 workflow')
  await w.workflow({ script: "export const meta = { name: 'audit', description: 'audit', phases: [] }\nconst a = await agent('Audit the auth module.', { label: 'review-auth' })\nreturn a\n" })
  await w.started('wf_test-1', 'wa1', 'review-auth')
  await w.agentStep('wa1', { index: 0 })
  const ui = await w.pane()
  await ui.press({ key: 'pane-next' })
  expect(shown(await ui.find({ key: 'pane-head' }))).toContain('review-auth')
  expect(await ui.find({ key: 'pane-view-button' })).toBeUndefined()
})
