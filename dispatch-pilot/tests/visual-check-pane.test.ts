// visual_check in the rationale pane (#58): the switch is listed at the top with its state, each call is an entry of the log that
// can be gone over check by check, and the agent's card says its count. Seam 1: engine events in, the pane mounted through the mod out.

import { expect, test } from 'claude-code/testing'
import { type Drawn, shown } from './support/drawn.ts'
import { jev, KEY, world } from './support/world.ts'

const OPTIONS = KEY
const SHOT = '/shots/home.png'
const FILES = { [SHOT]: { format: 'png', width: 1200, height: 800 } }
const CHECKS = [
  { part: 'the title', property: 'is fully visible' },
  { part: 'the primary button', property: 'is present' },
  { part: 'the tab bar', property: 'has four tabs' },
]
/** The first check holds, the second does not, the third is in between. */
const MIXED = jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.97, 'check.1': 0.05, 'check.2': 0.5 } })

async function checked(...[$, on]: Parameters<typeof world>) {
  const w = world($, on, { session: true, files: FILES, process: true, backend: MIXED, store: {} })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  await w.visualCheck({ images: [SHOT], checks: CHECKS })
  return w
}

test('the switch visual-check is listed at the top of the pane with its state: on by default, grey when off', { options: OPTIONS }, async ($, on) => {
  const w = await checked($, on)
  const ui = await w.pane()
  const item = async () => {
    const found = await ui.find({ key: 'pane-switch-visual-check' })
    return { text: shown(found).trim(), color: ((found?.children?.[0] as Drawn | undefined)?.props?.color as string | undefined) }
  }
  expect(await item()).toMatchObject({ text: 'visual-check 开', color: undefined })
  await w.command('dp', 'visual-check off')
  await ui.redraw()
  expect(await item()).toMatchObject({ text: 'visual-check 关', color: 'inactive' })
})

test('a call is an entry of the log: what it was about, the count, and each check with its verdict, probability and whether it was zoomed', { options: OPTIONS }, async ($, on) => {
  const w = await checked($, on)
  const { log } = await w.board()
  const entry = log.find((one) => one.feature === 'visual-check')
  const text = shown(await (await w.pane()).find({ key: `pane-entry-${entry?.n}` }))

  expect(text).toContain('看图核对')
  expect(text).toContain(SHOT)
  expect(text).toContain('核对 3：1 过 · 1 不过 · 1 没把握')
  expect(text).toContain('the title · is fully visible 过 97%（整图）')
  expect(text).toContain('the primary button · is present 不过 5%（整图）')
  expect(text).toContain('the tab bar · has four tabs 没把握 50%（整图）')
})

test("the main agent's card says its count of checks, and the log entry is not taken for its route", { options: OPTIONS }, async ($, on) => {
  const w = await checked($, on)
  const ui = await w.pane()

  expect(shown(await ui.find({ key: 'pane-card-checks' }))).toContain('核对 3：1 过 · 1 不过 · 1 没把握')
  // Its route is still the effort decision.
  expect(shown(await ui.find({ key: 'pane-card-reason' }))).not.toContain('核对')
})
