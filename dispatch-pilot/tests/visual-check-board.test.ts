// visual_check on the board (#58): each agent's row counts its checks (passed, failed, unsure), updated in place for the length
// of its loop and started again on the next turn; a dispatched agent's count is on its own row; a failure is a note on the
// board and never a toast. Seam 1: engine events in; the board data (`w.board()`), the toasts and the screens mounted through
// the mod out.

import { expect, test } from 'claude-code/testing'
import { report, type Board, type LogEntry, type ReportIo } from '../hooks/core/report.ts'
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

test('the main agent\'s row counts the checks of its loop by verdict, in place; the next turn counts again from nothing', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: MIXED })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })

  await w.visualCheck({ images: [SHOT], checks: CHECKS })
  expect((await w.board()).main?.visualChecks).toEqual({ passed: 1, failed: 1, unsure: 1 })
  await w.visualCheck({ images: [SHOT], checks: CHECKS.slice(0, 1) })
  const board = await w.board()
  // One node, updated in place: the second call added its check to the first call's.
  expect(board.nodes.filter((node) => node.id === 'main' && node.turn === board.turn)).toHaveLength(1)
  expect(board.main?.visualChecks).toEqual({ passed: 2, failed: 1, unsure: 1 })

  await w.complete()
  await w.submit('再看看设置页')
  await w.step({ index: 0 })
  expect((await w.board()).main?.visualChecks).toBeUndefined()
  await w.visualCheck({ images: [SHOT], checks: CHECKS.slice(0, 2) })
  expect((await w.board()).main?.visualChecks).toEqual({ passed: 1, failed: 1, unsure: 0 })
})

test('a dispatched agent\'s checks are counted on its own row, not on the main agent\'s', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: MIXED })
  await w.start()
  await w.submit('审查改动并核对首页')
  await w.step({ index: 0 })
  const started = await w.spawn({ prompt: 'Check the home screen against the design.', description: '核对首页' })
  await w.step({ index: 0, turnId: 'sub-1', agentId: started.agentId })

  await w.visualCheck({ images: [SHOT], checks: CHECKS }, { agentId: started.agentId })
  await w.visualCheck({ images: [SHOT], checks: CHECKS.slice(0, 1) }, { agentId: started.agentId })
  await w.visualCheck({ images: [SHOT], checks: CHECKS.slice(0, 2) })

  const { main, agents } = await w.board()
  expect(agents.find((node) => node.id === started.agentId)?.visualChecks).toEqual({ passed: 2, failed: 1, unsure: 1 })
  expect(main?.visualChecks).toEqual({ passed: 1, failed: 1, unsure: 0 })
})

test('each call is one decision in the log, beside the caller\'s route: the checks, the verdicts and probabilities, the image, the zoom, the time; nothing of the image or the key', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, {
    session: true,
    files: FILES,
    process: true,
    backend: (request) => (request.body?.questions?.['check.0'] === undefined ? MIXED(request) : { after: 250, reply: MIXED(request) }),
  })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  const call = w.visualCheck({ images: [SHOT], spec: 'Home: a title, a primary button and a tab bar.', checks: CHECKS })
  await w.clock.advance(250)
  await call

  const { log, main } = await w.board()
  const entries = log.filter((entry) => entry.feature === 'visual-check')
  expect(entries).toHaveLength(1)
  const entry = entries[0]
  expect(entry).toMatchObject({ agent: 'main', tone: 'warn', subject: SHOT, outcome: '核对 3：1 过 · 1 不过 · 1 没把握' })
  expect(entry?.visualCheck).toEqual({
    image: SHOT,
    against: { kind: 'spec', paths: [] },
    backend: 'jev',
    zoomed: false,
    ms: 250,
    checks: [
      { part: 'the title', property: 'is fully visible', verdict: 'pass', probability: 0.97, zoomed: false },
      { part: 'the primary button', property: 'is present', verdict: 'fail', probability: 0.05, zoomed: false },
      { part: 'the tab bar', property: 'has four tabs', verdict: 'unsure', probability: 0.5, zoomed: false, why: 'the decision model is not sure either way' },
    ],
  })
  expect(entry?.reason).toContain('the primary button · is present 不过 5%（整图）')
  expect(entry?.reason).toContain('没有放大复核，用时 0.3 秒')
  // Beside the route: the main agent's own decision is the one its node links to.
  expect(log.find((one) => one.n === main?.decision)?.feature).toBe('main-effort')
  // No image content, no key, and not the specification's text.
  const written = JSON.stringify(await w.board())
  expect(written).not.toContain('data_base64')
  expect(written).not.toContain('ts-test-key')
  expect(written).not.toContain('a tab bar.')
})

test('a reference or another screenshot is named in the record by its path', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, files: { ...FILES, '/design/home.png': { format: 'png', width: 1200, height: 800 } }, process: true, backend: MIXED })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  await w.visualCheck({ images: [SHOT], reference: ['/design/home.png'], checks: CHECKS.slice(0, 1) })
  await w.visualCheck({ images: [SHOT], compare_to: '/design/home.png', checks: CHECKS.slice(0, 1) })

  const against = (await w.board()).log.filter((entry) => entry.feature === 'visual-check').map((entry) => entry.visualCheck?.against)
  expect(against).toEqual([
    { kind: 'reference', paths: ['/design/home.png'] },
    { kind: 'compare_to', paths: ['/design/home.png'] },
  ])
})

test('a request that fails is a note on the board and an unsure count, never a toast; the entry says so', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: (request) => (request.body?.questions?.['check.0'] === undefined ? MIXED(request) : { status: 500, body: 'down' }) })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  await w.visualCheck({ images: [SHOT], checks: CHECKS })

  const { notes, main, log } = await w.board()
  expect(w.toasts).toEqual([])
  expect(notes.filter((note) => note.feature === 'visual-check')).toMatchObject([{ id: 'main', kind: 'failed' }])
  expect(main?.visualChecks).toEqual({ passed: 0, failed: 0, unsure: 3 })
  expect(log.find((entry) => entry.feature === 'visual-check')).toMatchObject({ tone: 'fail', outcome: '核对 3：0 过 · 0 不过 · 3 没把握' })
  // The node itself is not marked failed: it is still routed as it was decided.
  expect(main?.failure).toBeUndefined()
})

test('images that cannot be read are a note on the board too, without a toast', { options: OPTIONS }, async ($, on) => {
  const w = world($, on, { session: true, files: FILES, process: true, backend: MIXED })
  await w.start()
  await w.submit('把首页做成设计稿那样')
  await w.step({ index: 0 })
  await w.visualCheck({ images: ['/shots/missing.png'], checks: CHECKS.slice(0, 1) })

  const { notes, main } = await w.board()
  expect(w.toasts).toEqual([])
  expect(notes.filter((note) => note.feature === 'visual-check')).toMatchObject([{ id: 'main', kind: 'skipped', why: 'error' }])
  expect(main?.visualChecks).toEqual({ passed: 0, failed: 0, unsure: 1 })
  expect(w.logs.some((log) => log.to === 'debug' && log.text.startsWith('visual_check could not use its images:'))).toBe(true)
})

// ---- for the screenshot takeover (#62) ----------------------------------------------------

/** A `$.state` value held in memory, as the report module is handed it. */
function cell<T>(initial?: T) {
  let held = { value: initial, version: initial === undefined ? 0 : 1 }
  return {
    get: async () => held,
    set: async (value: T, options: { ifVersion: number }) => {
      if (options.ifVersion !== held.version) return { isSet: false, version: held.version }
      held = { value, version: held.version + 1 }
      return { isSet: true, version: held.version }
    },
    read: () => held.value,
  }
}

test('the takeover\'s images are counted on the same row as the checks, beside them: the tally adds to what the node has', async () => {
  const board = cell<Board>({ turn: 1, starts: [{ turn: 1, at: 0 }], nodes: [{ turn: 1, id: 'main', kind: 'main', name: '主 agent', type: 'main', state: 'running', t0: 0, routed: true }] })
  const io: ReportIo = { board, decisions: cell<LogEntry[]>(), debug: () => {}, now: async () => 0, toast: () => {} }
  await report(io, { tally: { feature: 'visual-check', agent: 'main', passed: 1, failed: 0, unsure: 0 } })
  await report(io, { tally: { feature: 'visual-check', agent: 'main', passed: 0, failed: 0, unsure: 0, takeovers: 1 } })
  await report(io, { tally: { feature: 'visual-check', agent: 'main', passed: 0, failed: 1, unsure: 0, takeovers: 2 } })

  expect(board.read()?.nodes[0]?.visualChecks).toEqual({ passed: 1, failed: 1, unsure: 0, takeovers: 3 })
})
