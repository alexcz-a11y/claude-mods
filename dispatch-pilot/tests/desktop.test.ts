// Off the terminal (Desktop, VS Code, the mobile app): the band's own fold, the status line under the prompt where the
// band is not drawn (ADR 0011), the prompt hint on that line, the pane's labels without their keys spelled, and the
// faces a proportional surface needs. Seam 1: the person's prompts, steps and presses in; what the surfaces are
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

test('in a session that draws on Desktop alone, the status line says the band in words: the turn and the main agent as it starts, how it ended and the agents once it is over', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0], { choice: 'sonnet' }), surfaces: ['desktop'] })
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

for (const surfaces of [['terminal'], ['terminal', 'mobile'], []] as const) {
  test(`a session that draws on a terminal (or nowhere) gets no status line: the terminal puts it behind a ⚠ (ADR 0004) (${surfaces.join(' + ') || 'none'})`, { options: KEY }, async ($, on) => {
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

  const desktop = await w.pane({ surface: 'desktop' })
  expect(await desktop.find({ key: 'pane-prev' })).toMatchObject({ props: { label: '‹ 上一个', hotkey: 'p' } })
  expect(await desktop.find({ key: 'pane-next' })).toMatchObject({ props: { label: '下一个 ›', hotkey: 'n' } })
  await desktop.press({ key: 'pane-next' })
  expect(await desktop.find({ key: 'pane-view-button' })).toMatchObject({ props: { label: '看它的对话', hotkey: 'x' } })
  expect(shown(await desktop.find({ key: 'pane-nav' }))).toContain('band 上点 agent 直接选')
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
  expect(texts.some((text) => text.props.mono === true && /▰/.test(shown(text)))).toBe(true)
  expect(texts.some((text) => text.props.tabular === true && /\d:\d\d/.test(shown(text)))).toBe(true)
})
