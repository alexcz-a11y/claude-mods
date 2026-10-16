// The screenshot takeover on the board and in the log (#62, spec #55): every image kept from an agent is an entry in the decision
// log (the path, the size), and all of them are counted on the agent's row, beside the checks' count: 接管 n. Seam 1: engine
// events in; the board data, the band and the pane mounted through the mod out.

import { expect, test } from 'claude-code/testing'
import { type Drawn, shown } from './support/drawn.ts'
import { base64, screenshotContent } from './support/images.ts'
import { jev, KEY, world } from './support/world.ts'

const OPTIONS = { ...KEY, rejudgeEvery: 0 }
const SHOT = '/shots/home.png'
const IMAGE = { format: 'png', width: 1200, height: 800 }
const TOOL = 'mcp__chrome-devtools__take_screenshot'
const BACKEND = jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.97 } })

/** The band's rows an agent each, in order. */
async function agentRows(ui: { findAll: (query: { type?: string }) => Promise<Drawn[]> }): Promise<Drawn[]> {
  return (await ui.findAll({ type: 'Box' })).filter((box) => box.key?.startsWith('band-agent-'))
}

/** A session at the first step of a turn, the takeover on, a file the agent has saved and a screenshot tool that returns an image. */
async function taken(...[$, on]: Parameters<typeof world>) {
  const w = world($, on, { session: true, process: { programs: { base64 } }, switches: { 'screenshot-takeover': true }, env: { TMPDIR: '/var/T' }, backend: BACKEND, store: {} })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  w.save(SHOT, IMAGE)
  await w.read(SHOT)
  await w.callTool(TOOL, { ends: { returns: screenshotContent({ format: 'png', width: 800, height: 600 }) } })
  return w
}

test('each image taken over is an entry in the log, beside the agent\'s route: its path and its size, and no image', { options: OPTIONS }, async ($, on) => {
  const w = await taken($, on)
  const { log, main } = await w.board()
  const entries = log.filter((entry) => entry.feature === 'screenshot-takeover')

  expect(entries).toHaveLength(2)
  expect(entries[0]).toMatchObject({ agent: 'main', subject: SHOT, outcome: '接管截图', tone: 'ok' })
  expect(entries[0]?.reason).toContain('1200×800')
  expect(entries[1]?.subject).toMatch(/^\/var\/T\/dispatch-pilot\/s1\/image-[\w-]+\.png$/)
  expect(entries[1]?.reason).toContain('800×600')
  // Beside the route: the main agent's own decision is the one its node links to.
  expect(log.find((one) => one.n === main?.decision)?.feature).toBe('main-effort')
  expect(JSON.stringify(await w.board())).not.toContain('base64')
})

test('the agent\'s row counts them: 接管 n; a new turn counts again', { options: OPTIONS }, async ($, on) => {
  const w = await taken($, on)
  expect((await w.board()).main?.visualChecks).toEqual({ passed: 0, failed: 0, unsure: 0, takeovers: 2 })

  await w.complete()
  await w.submit('再看看设置页')
  await w.step({ index: 0 })
  expect((await w.board()).main?.visualChecks).toBeUndefined()
})

test('the band says 接管 n on the row, with the checks\' count when the agent made checks too, and nothing of 核对 when it made none', { options: OPTIONS }, async ($, on) => {
  const w = await taken($, on)
  const rows = await agentRows(await w.band({ columns: 180 }))
  expect(shown(rows[0])).toContain('接管 2')
  expect(shown(rows[0])).not.toContain('核对')

  // The same image, now checked: the checks' count first, then the takeover's.
  w.save('/shots/other.png', IMAGE)
  await w.visualCheck({ images: ['/shots/other.png'], checks: [{ part: 'the title', property: 'is fully visible' }] })
  expect(shown((await agentRows(await w.band({ columns: 180 })))[0])).toContain('核对 1：1 过 · 0 不过 · 0 没把握 · 接管 2')
})

test('the pane lists the entry as taken over, and the card has the count', { options: OPTIONS }, async ($, on) => {
  const w = await taken($, on)
  const { log } = await w.board()
  const entry = log.find((one) => one.feature === 'screenshot-takeover')
  const ui = await w.pane()
  const text = shown(await ui.find({ key: `pane-entry-${entry?.n}` }))

  expect(text).toContain('截图接管')
  expect(text).toContain('已接管')
  expect(text).toContain(SHOT)
  expect(shown(await ui.find({ key: 'pane-card-checks' }))).toContain('接管 2')
})

test('the switch screenshot-takeover is listed at the top of the pane: off by default, on once the person turns it on', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, process: true, backend: BACKEND, store: {} })
  await w.start()
  const ui = await w.pane()
  const item = async () => shown(await ui.find({ key: 'pane-switch-screenshot-takeover' })).trim()

  expect(await item()).toBe('screenshot-takeover 关')
  await w.command('dp', 'screenshot-takeover on')
  await ui.redraw()
  expect(await item()).toBe('screenshot-takeover 开')
})

test('no image taken, nothing counted and nothing logged', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, process: true, switches: { 'screenshot-takeover': true }, backend: BACKEND })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  await w.callTool('mcp__chrome-devtools__list_pages', { ends: { returns: [{ type: 'text', text: 'one page' }] } })

  const { log, main } = await w.board()
  expect(log.filter((entry) => entry.feature === 'screenshot-takeover')).toEqual([])
  expect(main?.visualChecks).toBeUndefined()
})
