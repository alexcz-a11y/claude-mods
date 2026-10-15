// visual_check on the band (#58): each agent's row says how many checks it made and how they came out; a failure is a line in the
// band's events. Seam 1: engine events in, the band mounted through the mod out.

import { expect, test } from 'claude-code/testing'
import { jev, world } from './support/world.ts'

const OPTIONS = { decisionModel: 'jev', typesafeApiKey: 'ts-test-key', rejudgeEvery: 0 }
const SHOT = '/shots/home.png'
const FILES = { [SHOT]: { format: 'png', width: 1200, height: 800 } }
const CHECKS = [
  { part: 'the title', property: 'is fully visible' },
  { part: 'the primary button', property: 'is present' },
  { part: 'the tab bar', property: 'has four tabs' },
]
/** The first check holds, the second does not, the third is in between. */
const MIXED = jev([0, 1, 0, 0, 0], { nouls: { 'check.0': 0.97, 'check.1': 0.05, 'check.2': 0.5 } })

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

/** The band's rows an agent each, in order. */
async function agentRows(ui: { findAll: (query: { type?: string }) => Promise<Drawn[]> }): Promise<Drawn[]> {
  return (await ui.findAll({ type: 'Box' })).filter((box) => box.key?.startsWith('band-agent-'))
}

/** A main agent and one dispatched agent, each with its checks done: the main agent's three, the agent's one. */
async function checked(...[$, on]: Parameters<typeof world>) {
  const w = world($, on, { session: true, files: FILES, process: true, backend: MIXED })
  await w.start()
  await w.submit('审查改动并核对首页')
  await w.step({ index: 0 })
  const started = await w.spawn({ prompt: 'Check the home screen against the design.', description: '核对首页' })
  await w.step({ index: 0, turnId: 'sub-1', agentId: started.agentId, model: 'claude-sonnet-5-5', effort: 'medium' })
  await w.visualCheck({ images: [SHOT], checks: CHECKS })
  await w.visualCheck({ images: [SHOT], checks: CHECKS.slice(0, 1) }, { agentId: started.agentId })
  return w
}

test("each agent's row says its count: 核对 N：x 过 · y 不过 · z 没把握, updated in place as the loop goes on", { options: OPTIONS }, async ($, on) => {
  const w = await checked($, on)
  const rows = await agentRows(await w.band({ columns: 180 }))

  expect(rows).toHaveLength(2)
  expect(shown(rows[0])).toContain('核对 3：1 过 · 1 不过 · 1 没把握')
  expect(shown(rows[1])).toContain('核对 1：1 过 · 0 不过 · 0 没把握')

  // The loop goes on: the same two rows, the main agent's count grown.
  await w.visualCheck({ images: [SHOT], checks: CHECKS.slice(0, 2) })
  const later = await agentRows(await w.band({ columns: 180 }))
  expect(later).toHaveLength(2)
  expect(shown(later[0])).toContain('核对 5：2 过 · 2 不过 · 1 没把握')
})

for (const columns of [60, 90, 120, 180]) {
  test(`at ${columns} columns a row with a count is no wider than the band, and its cells keep their widths`, { options: OPTIONS }, async ($, on) => {
    const w = await checked($, on)
    const rows = await agentRows(await w.band({ columns }))

    expect(rows).toHaveLength(2)
    for (const row of rows) {
      const widths = (row.children ?? []).map((cell) => Number((cell as Drawn).props?.width ?? 0))
      expect(widths.reduce((sum, width) => sum + width, 0)).toBeLessThanOrEqual(columns - 5)
      expect((row.children ?? []).every((cell) => (cell as Drawn).props?.flexShrink === 0)).toBe(true)
    }
    // Room enough from 90 columns up for the whole count.
    if (columns >= 90) expect(shown(rows[0])).toContain('核对 3：1 过 · 1 不过 · 1 没把握')
  })
}

test('a new turn counts again: the band draws no count for the main agent until it checks something', { options: OPTIONS }, async ($, on) => {
  const w = await checked($, on)
  await w.complete()
  await w.submit('再看看设置页')
  await w.step({ index: 0 })

  const rows = await agentRows(await w.band({ columns: 180 }))
  expect(shown(rows[0])).not.toContain('核对')
})

test('with the switch off the band draws no count; on again, it is back', { options: OPTIONS }, async ($, on) => {
  const w = await checked($, on)
  await w.command('dp', 'visual-check off')
  expect(shown((await agentRows(await w.band({ columns: 180 })))[0])).not.toContain('核对')
  await w.command('dp', 'visual-check on')
  expect(shown((await agentRows(await w.band({ columns: 180 })))[0])).toContain('核对 3：')
})

test("a failure is a line in the band's events, under the feature's name for people: 看图核对", { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: (request) => (request.body?.questions?.['check.0'] === undefined ? MIXED(request) : { status: 500, body: 'down' }) })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  await w.visualCheck({ images: [SHOT], checks: CHECKS })

  const ui = await w.band({ columns: 180 })
  expect(shown(await ui.drawn())).toContain('看图核对失败')
  expect(w.toasts).toEqual([])
})

test('images the screenshot takeover kept from the agent (#62) are added to its count: 接管 n', { options: OPTIONS }, async ($, on) => {
  const main = { turn: 1, id: 'main', kind: 'main' as const, name: '主 agent', type: 'main', state: 'running' as const, t0: 0, routed: true, visualChecks: { passed: 2, failed: 0, unsure: 1, takeovers: 4 } }
  const w = world($, on, { seed: { board: { turn: 1, starts: [{ turn: 1, at: 0 }], nodes: [main] } } })

  expect(shown((await agentRows(await w.band({ columns: 180 })))[0])).toContain('核对 3：2 过 · 0 不过 · 1 没把握 · 接管 4')
})
