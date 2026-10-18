// Off the terminal (Desktop, VS Code, the mobile app): the band's own fold, the status line under the prompt where the
// band is not drawn (ADR 0011), the prompt hint on that line, the pane's labels without their keys spelled, the
// faces a proportional surface needs, and the presses that must land: a redraw every 5 s rather than 200 ms (a redraw
// loses Desktop the press in flight), the ribbons that grow by themselves in between, the band's 依据 and the pane's 关闭. Seam 1: the person's prompts, steps and presses in; what the surfaces are
// drawn and the status lines the mod sets out.

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptEditInput, PromptEditResult } from 'claude-code'
import { shown } from './support/drawn.ts'
import { runWorld } from './support/workflow-run.ts'
import { jev, KEY, world } from './support/world.ts'

// ---- the band's fold --------------------------------------------------------------------

test('on Desktop the band has its own fold: 收起 makes it the one line with 展开, kept for the next turn; the terminal folds the band itself and gets no button', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0], { choice: 'sonnet' }) })
  await w.submit('派个 agent 审查一下')
  await w.step({ index: 0, model: 'claude-opus-5-5' })
  const one = await w.spawn({ prompt: 'Review the diff.', description: '审查' })
  await w.agentStep(one.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })

  const terminal = await w.band({ rows: 12 })
  expect(await terminal.find({ key: 'band-fold' })).toBeUndefined()
  await terminal.unmount()

  const band = await w.band({ surface: 'desktop', rows: 12 })
  expect(shown(await band.find({ key: 'band-fold' }))).toBe('▾ 收起')
  await band.press({ key: 'band-fold-button' })
  await band.redraw()
  expect(await band.find({ key: 'band' })).toBeUndefined()
  expect(shown(await band.find({ key: 'band-squeezed' }))).toMatch(/第 1 轮.*opus·high.*▸ 展开$/)
  await band.unmount()

  // Kept: the next band drawn is the one line too, until 展开.
  const again = await w.band({ surface: 'desktop', rows: 12 })
  expect(await again.find({ key: 'band-squeezed' })).toBeDefined()
  await again.press({ key: 'band-fold-button' })
  await again.redraw()
  expect(await again.find({ key: 'band' })).toBeDefined()
  expect(shown(await again.find({ key: 'band-fold' }))).toBe('▾ 收起')
})

// ---- the status line --------------------------------------------------------------------

test('in a session that draws on VS Code alone, the status line says the band in words: the turn and the main agent as it starts, how it ended and the agents once it is over', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0], { choice: 'sonnet' }), surfaces: ['vscode'] })
  await w.submit('派个 agent 审查一下')
  await w.step({ index: 0, model: 'claude-opus-5-5' })
  const one = await w.spawn({ prompt: 'Review the diff.', description: '审查' })
  expect(w.statuses.at(-1)).toMatch(/^第 1 轮 · 主 agent opus·high · agent (运行|排队) 1$/)
  await w.agentStep(one.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })
  await w.complete({ agentId: one.agentId ?? '' })
  await w.complete()
  expect(w.statuses.at(-1)).toMatch(/^第 1 轮结束 · 主 agent opus·high · .* · agent 完成 1$/)
  // Set only when it changes.
  const lines = w.statuses.length
  await w.command('dp', 'status')
  expect(w.statuses).toHaveLength(lines)
  await w.command('dp', 'off')
  expect(w.statuses.at(-1)).toBe('dp 已关')
})

for (const surfaces of [['terminal'], ['terminal', 'mobile'], [], ['desktop']] as const) {
  test(`a session that draws on a terminal, on Desktop (or nowhere) gets no status line: the terminal puts it behind a ⚠ (ADR 0004), Desktop's band says it all (${surfaces.join(' + ') || 'none'})`, { options: KEY }, async ($, on) => {
    const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), surfaces })
    await w.submit('改个错别字')
    await w.step({ index: 0, model: 'claude-opus-5-5' })
    await w.complete()
    expect(w.statuses).toEqual([])
  })
}

// ---- the prompt hint on the status line -------------------------------------------------------

/** The engine beneath the prompt box: an edit spliced as the editor does. */
function box($: Engine, on: On) {
  const prompt = $.prompt as unknown as { edit: (e: PromptEditInput) => Promise<PromptEditResult> }
  on('prompt.edit', (_$, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  return {
    type: (draft: string, typed: string) => prompt.edit({ origin: { kind: 'composer' }, text: draft, cursor: draft.length, start: draft.length, end: draft.length, inputText: typed }),
  }
}

test('where the session uses the status line, the prompt hint goes on it while the person writes, and the band\'s line comes back once the turn starts', { options: KEY }, async ($, on) => {
  const b = box($, on)
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), surfaces: ['vscode'] })
  await w.submit('先开个头')
  await w.step({ index: 0, model: 'claude-opus-5-5' })
  await w.complete()
  expect(w.statuses.at(-1)).toMatch(/^第 1 轮结束/)
  const typed = await b.type('这几个审查都用 opus 跑', '吧')
  // The box draws it too, as on the terminal.
  expect(typed.decorations?.[0]?.virtualText).toBe('  dp · 识别 agent 点名：opus')
  expect(w.statuses.at(-1)).toBe('dp · 识别 agent 点名：opus')
  // A draft with nothing to say gives the line back to the turn.
  await b.type('把错别字改了', '吧')
  expect(w.statuses.at(-1)).toMatch(/^第 1 轮结束/)
  await b.type('用 opus 跑', '吧')
  await w.submit('用 opus 跑吧')
  expect(w.statuses.at(-1)).toMatch(/^第 2 轮/)
})

test('in a terminal\'s session the prompt hint never goes on the status line', { options: KEY }, async ($, on) => {
  const b = box($, on)
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), surfaces: ['terminal'] })
  await w.submit('先开个头')
  await b.type('这几个审查都用 opus 跑', '吧')
  expect(w.statuses).toEqual([])
})

// ---- the pane's labels and the faces -------------------------------------------------------

test("the pane's buttons spell their keys on the terminal only: Desktop draws the key beside the label itself", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 1, 0, 0, 0], { choice: 'sonnet' }) })
  await w.submit('派个 agent')
  await w.step({ index: 0 })
  const one = await w.spawn({ prompt: 'Review the diff.', description: '审查' })
  await w.agentStep(one.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })

  const terminal = await w.pane()
  expect((await terminal.find({ key: 'pane-prev' }))?.props.label).toBe('‹ 上一个 (p)')
  await terminal.unmount()

  // Desktop picks from tabs (desktop-pane.test.ts); its 看它的对话 has the key beside it, not in its label.
  const desktop = await w.pane({ surface: 'desktop' })
  await desktop.press({ key: 'pane-tab-1' })
  await desktop.redraw()
  expect(await desktop.find({ key: 'pane-view-button' })).toMatchObject({ props: { label: '看它的对话', hotkey: 'x' } })
})

test('the chips and the pips are drawn mono and the times tabular, so the band\'s columns line up on a proportional face', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0], { choice: 'sonnet' }) })
  await w.submit('派个 agent 审查一下')
  await w.step({ index: 0, model: 'claude-opus-5-5' })
  const one = await w.spawn({ prompt: 'Review the diff.', description: '审查' })
  await w.agentStep(one.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })
  const band = await w.band({ surface: 'desktop', rows: 12 })
  const texts = await band.findAll({ type: 'Text' })
  const chips = texts.filter((text) => text.props.backgroundColor !== undefined)
  expect(chips.length).toBeGreaterThanOrEqual(2)
  for (const chip of chips) expect(chip.props.mono).toBe(true)
  // Off the terminal the effort is its word, without the pips.
  expect(texts.some((text) => /▰/.test(shown(text)))).toBe(false)
  expect(texts.some((text) => text.props.tabular === true && /\d:\d\d/.test(shown(text)))).toBe(true)
})

// ---- presses that land: the redraw pace, the ribbons that move by themselves, the pane's own buttons ----------------

/** The redraws the mod asks for (`$.ui.invalidate("ui.render")`), when on the mock clock. */
function redraws(on: On, now: () => number): number[] {
  const at: number[] = []
  on('ui.invalidate', (_$, e) => {
    if (e.event === 'ui.render') at.push(now())
    return { value: undefined }
  })
  return at
}

test('off the terminal the screens redraw every 5 s while an agent runs, not every 200 ms: a redraw gives every Button a new handle, and Desktop loses a press that still carries the old one', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0], { choice: 'sonnet' }), surfaces: ['desktop'] })
  const at = redraws(on, () => w.clock.now())
  await w.submit('派个 agent 审查一下')
  await w.step({ index: 0, model: 'claude-opus-5-5' })
  const one = await w.spawn({ prompt: 'Review the diff.', description: '审查' })
  await w.agentStep(one.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })
  const band = await w.band({ surface: 'desktop', rows: 12 })
  at.length = 0
  await w.clock.advance(4900)
  expect(at).toEqual([])
  await w.clock.advance(100)
  expect(at).toHaveLength(1)
  await band.unmount()
})

test('on the terminal the screens still redraw every 200 ms while an agent runs: the spinner turns', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0], { choice: 'sonnet' }) })
  const at = redraws(on, () => w.clock.now())
  await w.submit('派个 agent 审查一下')
  await w.step({ index: 0, model: 'claude-opus-5-5' })
  const one = await w.spawn({ prompt: 'Review the diff.', description: '审查' })
  await w.agentStep(one.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })
  const band = await w.band({ rows: 12 })
  at.length = 0
  await w.clock.advance(200)
  expect(at).toHaveLength(1)
  await band.unmount()
})

test("on Desktop a running agent's ribbon grows by itself until the next redraw (an interactive Svg animating its bar), a finished one is a still image, and no glyph spins", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0], { choice: 'sonnet' }), surfaces: ['desktop'] })
  await w.submit('派两个 agent')
  await w.step({ index: 0, model: 'claude-opus-5-5' })
  const one = await w.spawn({ prompt: 'Review the diff.', description: '审查' })
  await w.agentStep(one.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })
  await w.complete({ agentId: one.agentId ?? '' })
  const two = await w.spawn({ prompt: 'Read the docs.', description: '读文档' })
  await w.agentStep(two.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })
  const band = await w.band({ surface: 'desktop', rows: 12 })
  const svgs = await band.findAll({ type: 'Svg' })
  const moving = svgs.filter((svg) => svg.props.isInteractive === true)
  const still = svgs.filter((svg) => svg.props.isInteractive !== true)
  // The main agent and 读文档 run; 审查 is done.
  expect(moving).toHaveLength(2)
  for (const svg of moving) expect(String(svg.props.source)).toMatch(/<animate attributeName="width" from="[\d.]+" to="[\d.]+" dur="5s" fill="freeze"\/>/)
  expect(still).toHaveLength(1)
  expect(String(still[0]?.props.source)).not.toContain('<animate')
  const texts = await band.findAll({ type: 'Text' })
  expect(texts.some((text) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(shown(text)))).toBe(false)
  await band.unmount()
})

for (const [surfaces, keys] of [[['desktop'], false], [['terminal'], true]] as const) {
  test(`/dp opens the pane ${keys ? 'taking the keyboard, its answer naming the keys, where the session has a terminal' : 'without taking the keyboard, its answer naming no keys, where the session has no terminal'} (${surfaces.join(' + ')})`, { options: KEY }, async ($, on) => {
    const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), surfaces })
    const text = await w.command('dp')
    expect(w.paneActs.at(-1)).toEqual({ act: 'open', id: 'dp-rationale', focus: keys })
    if (keys) expect(text).toContain('p / n')
    else expect(text).toBe('依据面板已打开')
  })
}

test("off the terminal the pane has its own 关闭 (a dismiss button) that closes it; the terminal's closes with Esc and has none", { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), surfaces: ['desktop'] })
  await w.submit('先开个头')
  await w.step({ index: 0, model: 'claude-opus-5-5' })
  await w.command('dp')
  const terminal = await w.pane()
  expect(await terminal.find({ key: 'pane-close' })).toBeUndefined()
  await terminal.unmount()
  const pane = await w.pane({ surface: 'desktop' })
  expect(await pane.find({ key: 'pane-close' })).toMatchObject({ props: { label: '关闭', role: 'dismiss' } })
  await pane.press({ key: 'pane-close' })
  expect(w.paneActs.at(-1)).toMatchObject({ act: 'close', id: 'dp-rationale' })
  expect(w.panes).toEqual([])
})

test('off the terminal the band opens the pane with its own 依据 button (on the full band, its folded line and the finished turn\'s line) instead of the /dp and digit-key hints', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0], { choice: 'sonnet' }), surfaces: ['desktop'] })
  await w.submit('派个 agent 审查一下')
  await w.step({ index: 0, model: 'claude-opus-5-5' })
  const one = await w.spawn({ prompt: 'Review the diff.', description: '审查' })
  await w.agentStep(one.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })

  const terminal = await w.band({ rows: 12 })
  expect(await terminal.find({ key: 'band-open-button' })).toBeUndefined()
  expect(shown(await terminal.find({ key: 'band-strip' }))).toContain('/dp log 看依据')
  await terminal.unmount()

  const band = await w.band({ surface: 'desktop', rows: 12 })
  expect(shown(await band.find({ key: 'band-strip' }))).not.toMatch(/\/dp log|0-9 选中/)
  await band.press({ key: 'band-open-button' })
  expect(w.paneActs.at(-1)).toEqual({ act: 'open', id: 'dp-rationale', focus: false })
  await band.press({ key: 'band-fold-button' })
  await band.redraw()
  expect(await band.find({ key: 'band-open-button' })).toBeDefined()
  expect(shown(await band.find({ key: 'band-squeezed' }))).not.toContain('/dp log')
  await band.unmount()

  await w.complete({ agentId: one.agentId ?? '' })
  await w.complete()
  const idle = await w.band({ surface: 'desktop', rows: 12, isWorking: false })
  expect(shown(await idle.find({ key: 'band-idle' }))).not.toContain('/dp log')
  expect(await idle.find({ key: 'band-open-button' })).toBeDefined()
})

// ---- the band's rows and the prompt hint on Desktop ---------------------------------------------

test("off the terminal the band's agent names are buttons without digit keys and the effort is its word without pips; the terminal keeps both", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0], { choice: 'sonnet' }), surfaces: ['desktop'] })
  await w.submit('派个 agent 审查一下')
  await w.step({ index: 0, model: 'claude-opus-5-5' })
  const one = await w.spawn({ prompt: 'Review the diff.', description: '审查' })
  await w.agentStep(one.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })

  const terminal = await w.band({ rows: 12 })
  expect((await terminal.find({ key: 'band-pick-1' }))?.props.hotkey).toBe('1')
  expect(shown(await terminal.find({ key: 'band-agent-0' }))).toMatch(/▰/)
  await terminal.unmount()

  const band = await w.band({ surface: 'desktop', rows: 12 })
  const pick = await band.find({ key: 'band-pick-1' })
  expect(pick?.props.hotkey).toBeUndefined()
  expect(shown(pick)).toBe('审查')
  expect(shown(await band.find({ key: 'band-agent-0' }))).not.toMatch(/▰|▱/)
  expect(shown(await band.find({ key: 'band-agent-0' }))).toContain('high')
})

test("on Desktop the prompt hint takes the band's idle line while the person writes (no status line there), and the turn's line comes back with a draft that has none and once the next turn starts", { options: KEY }, async ($, on) => {
  const b = box($, on)
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), surfaces: ['desktop'] })
  await w.submit('先开个头')
  await w.step({ index: 0, model: 'claude-opus-5-5' })
  await w.complete()
  await b.type('这几个审查都用 opus 跑', '吧')
  const idle = await w.band({ surface: 'desktop', isWorking: false })
  expect(shown(await idle.find({ key: 'band-hint' }))).toContain('dp · 识别 agent 点名：opus')
  expect(await idle.find({ key: 'band-open-button' })).toBeDefined()
  await b.type('把错别字改了', '吧')
  await idle.redraw()
  expect(await idle.find({ key: 'band-hint' })).toBeUndefined()
  expect(shown(await idle.find({ key: 'band-idle' }))).toContain('第 1 轮')
  await b.type('用 opus 跑', '吧')
  await idle.redraw()
  expect(await idle.find({ key: 'band-hint' })).toBeDefined()
  await w.submit('用 opus 跑吧')
  await idle.redraw()
  expect(await idle.find({ key: 'band-hint' })).toBeUndefined()
  expect(w.statuses).toEqual([])
})

test("in a terminal's session the prompt hint stays in the prompt box: the band never takes it", { options: KEY }, async ($, on) => {
  const b = box($, on)
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), surfaces: ['terminal'] })
  await w.submit('先开个头')
  await w.step({ index: 0, model: 'claude-opus-5-5' })
  await w.complete()
  await b.type('这几个审查都用 opus 跑', '吧')
  const band = await w.band({ isWorking: false })
  expect(await band.find({ key: 'band-hint' })).toBeUndefined()
})
