// The rationale pane off the terminal (Desktop, VS Code, the mobile app): clicked, not keyed. A row of agent tabs in
// place of ‹ 上一个 / 下一个 ›, the card's rules as a list without the terminal's rail, the probabilities as a bar with
// its legend under it, the log folded by turn with each entry one line and the rest on hover, and the switches and
// the effort lock at the bottom, changed where they are shown. The terminal's pane is as it was. Seam 1: the person's
// prompts, steps, presses and picks in; the pane drawn, the switches and the lock out.

import { expect, test } from 'claude-code/testing'
import { inventory, shown } from './support/drawn.ts'
import { runWorld } from './support/workflow-run.ts'
import { jev, KEY } from './support/world.ts'

/** Picks an option of a Select on a drawn pane (a surface's own Mounted has `select` where it draws a Select). */
async function choose(pane: unknown, key: string, value: string): Promise<void> {
  await (pane as { select: (target: { key: string; value: string }) => Promise<unknown> }).select({ key, value })
}

/** The element of a drawn tree under a key, as the surface receives it (its `hover` included). */
function keyed(node: unknown, key: string): unknown {
  if (typeof node !== 'object' || node === null) return undefined
  const element = node as { props?: { key?: unknown }; children?: unknown[] }
  if (element.props?.key === key) return element
  for (const child of element.children ?? []) {
    const found = keyed(child, key)
    if (found !== undefined) return found
  }
  return undefined
}

/** A turn of the main agent at high, with one agent sent out on sonnet and running. */
async function oneAgent(w: ReturnType<typeof runWorld>) {
  await w.submit('派个 agent 审查一下')
  await w.step({ index: 0, model: 'claude-opus-5-5' })
  const one = await w.spawn({ prompt: 'Review the diff.', description: '审查' })
  await w.agentStep(one.agentId ?? '', { index: 0, model: 'claude-sonnet-5-5' })
  return one
}

test('off the terminal the pane picks its agent from a row of tabs, the picked one primary; the terminal keeps ‹ 上一个 / 下一个 ›', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0], { choice: 'sonnet' }), surfaces: ['desktop'] })
  await oneAgent(w)

  const terminal = await w.pane()
  expect(await terminal.find({ key: 'pane-prev' })).toBeDefined()
  expect(await terminal.find({ key: 'pane-tab-0' })).toBeUndefined()
  await terminal.unmount()

  const pane = await w.pane({ surface: 'desktop' })
  expect(await pane.find({ key: 'pane-prev' })).toBeUndefined()
  expect(shown(await pane.find({ key: 'pane' }))).not.toMatch(/band 上|0-9|按字母键/)
  expect(await pane.find({ key: 'pane-tab-0' })).toMatchObject({ props: { variant: 'primary' } })
  expect(await pane.find({ key: 'pane-tab-1' })).toMatchObject({ props: { variant: 'secondary' } })
  expect(shown(await pane.find({ key: 'pane-tab-1' }))).toContain('审查')
  await pane.press({ key: 'pane-tab-1' })
  await pane.redraw()
  expect(await pane.find({ key: 'pane-tab-1' })).toMatchObject({ props: { variant: 'primary' } })
  expect(shown(await pane.find({ key: 'pane-card-head' }))).toContain('审查')
})

test("off the terminal the card's rules are a list without the terminal's ├ └ rail, and the probabilities a bar with each level's share on the line under it", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0], { choice: 'sonnet' }), surfaces: ['desktop'] })
  await oneAgent(w)

  const terminal = await w.pane()
  expect(shown(await terminal.find({ key: 'pane-card' }))).toMatch(/[├└]/)
  await terminal.unmount()

  const pane = await w.pane({ surface: 'desktop' })
  const card = await pane.find({ key: 'pane-card' })
  expect(shown(card)).not.toMatch(/[├└]/)
  expect(await pane.find({ key: 'pane-card-step-0' })).toBeDefined()
  expect(await pane.find({ key: 'pane-card-probs-bar' })).toBeDefined()
  expect(shown(await pane.find({ key: 'pane-card-probs-legend' }))).toMatch(/low \.00.*high 1\.0.*max \.00/)
})

test('off the terminal each log entry is one line and the rest of it (the probabilities, why) shows on hover; a turn folds by its title, no letter keys', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0], { choice: 'sonnet' }), surfaces: ['desktop'] })
  await oneAgent(w)
  const pane = await w.pane({ surface: 'desktop' })

  const fold = await pane.find({ key: 'pane-fold-1' })
  expect(fold?.props.hotkey).toBeUndefined()
  const entry = await pane.find({ key: 'pane-entry-1' })
  const more = await pane.find({ key: 'pane-entry-1-more' })
  expect(more).toMatchObject({ props: { display: 'none' } })
  // The hover itself is in the drawn tree, not in what `find` answers.
  const drawn = await pane.drawn()
  expect(keyed(drawn, 'pane-entry-1-more')).toMatchObject({ hover: { display: 'flex', scope: 'dp-entry-1' } })
  expect(keyed(drawn, 'pane-entry-1')).toMatchObject({ hover: { scope: 'dp-entry-1' } })
  expect(shown(more)).toMatch(/high 1\.0/)
  expect(shown(entry)).toMatch(/#1/)

  await pane.press({ key: 'pane-fold-1' })
  await pane.redraw()
  expect(await pane.find({ key: 'pane-entry-1' })).toBeUndefined()
})

test('off the terminal the switches are buttons at the bottom of the pane, folded at first: a press flips one and keeps it as /dp <name> off would', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0], { choice: 'sonnet' }), surfaces: ['desktop'], store: {} })
  await oneAgent(w)
  const pane = await w.pane({ surface: 'desktop' })

  const head = await pane.find({ key: 'pane-switches-toggle' })
  expect(shown(head)).toMatch(/功能开关 · \d+\/\d+ 开 · effort 未锁定/)
  expect(await pane.find({ key: 'pane-switch-skills' })).toBeUndefined()
  await pane.press({ key: 'pane-switches-toggle' })
  await pane.redraw()

  expect(await pane.find({ key: 'pane-switch-skills' })).toMatchObject({ props: { label: 'skills' } })
  await pane.press({ key: 'pane-switch-skills' })
  await w.clock.settle()
  await pane.redraw()
  expect(w.stored('switches')).toEqual({ skills: false })
  expect(await w.command('dp', 'status')).toMatch(/ {2}关 {2}skills/)
  expect(await pane.find({ key: 'pane-switch-skills' })).toMatchObject({ props: { dimColor: true } })

  // The whole of Dispatch Pilot is the first button.
  await pane.press({ key: 'pane-switch-master' })
  await w.clock.settle()
  expect(w.stored('switches')).toEqual({ skills: false, master: false })
})

test('off the terminal the effort lock is a picker beside the switches: a pick locks the main agent as /dp lock would, 不锁定 releases it', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0], { choice: 'sonnet' }), surfaces: ['desktop'] })
  await oneAgent(w)
  const pane = await w.pane({ surface: 'desktop' })
  await pane.press({ key: 'pane-switches-toggle' })
  await pane.redraw()

  expect(await pane.find({ key: 'pane-lock' })).toMatchObject({ props: { value: 'none' } })
  await choose(pane, 'pane-lock', 'max')
  expect(await w.command('dp', 'status')).toContain('effort 锁定：max')
  await pane.redraw()
  expect(shown(await pane.find({ key: 'pane-switches-toggle' }))).toContain('effort 锁在 max')
  await choose(pane, 'pane-lock', 'none')
  expect(await w.command('dp', 'status')).toContain('effort 锁定：没有')
})

test('the pane off the terminal stays short of the 2000 nodes Desktop refuses with a long log open', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: jev([0, 0, 1, 0, 0], { choice: 'sonnet' }), surfaces: ['desktop'] })
  for (let i = 0; i < 12; i++) {
    await w.submit(`第 ${i + 1} 件事`)
    await w.step({ index: 0, model: 'claude-opus-5-5' })
    await w.complete()
  }
  const pane = await w.pane({ surface: 'desktop' })
  await pane.press({ key: 'pane-switches-toggle' })
  await pane.redraw()
  expect(inventory(await pane.find({ key: 'pane' })).nodes).toBeLessThan(2000)
})
