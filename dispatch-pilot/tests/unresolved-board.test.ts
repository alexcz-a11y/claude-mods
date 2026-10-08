// What the unresolved count shows (#39): the decision log keeps each change, the
// rationale card shows the count and the conclusion of the message's answer, the
// band draws nothing more. Seam 1: the board data and the screens mounted through
// the mod.

import { expect, test } from 'claude-code/testing'
import { jev, world, type Sent } from './support/world.ts'

const KEY = { decisionModel: 'jev', typesafeApiKey: 'ts-test-key' }
/** The switch is off until the person turns it on (#48): these tests are about what it does when on. */
const UNRESOLVED_ON = { unresolved: true }

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

const STILL = { still_unresolved: 0.62, resolved: 0.05, new_or_unrelated: 0.33 }
const SOLVED = { still_unresolved: 0.1, resolved: 0.8, new_or_unrelated: 0.1 }
const UNSURE = { still_unresolved: 0.3, resolved: 0.4, new_or_unrelated: 0.3 }

/** Jev answering the effort question as `high` and the unresolved question with the shares `said.now` holds. */
function backend(said: { now: Record<string, number> }) {
  return (request: Sent) => jev([0.05, 0.1, 0.7, 0.1, 0.05], { shares: { 'effort.unresolved': said.now } })(request)
}

test('a count that moves is a decision in the log, beside the effort decision; one that stays is not, and the main agent\'s node keeps the effort decision as its own', { options: KEY }, async ($, on) => {
  const said = { now: STILL }
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(said) })

  await w.submit('登录接口还是 502')
  await w.step({ index: 0 })
  said.now = UNSURE
  await w.submit('嗯')
  said.now = SOLVED
  await w.submit('好了，谢谢')

  const { log, main } = await w.board()
  const counted = log.filter((entry) => entry.feature === 'unresolved')
  // Two moves: 0 → 1 and 1 → 0; the message that left the count alone made none.
  expect(counted.map((entry) => ({ turn: entry.turn, agent: entry.agent, outcome: entry.outcome, tone: entry.tone }))).toEqual([
    { turn: 1, agent: 'main', outcome: '次数 0 → 1', tone: 'ok' },
    { turn: 3, agent: 'main', outcome: '次数 1 → 0', tone: 'ok' },
  ])
  expect(counted[0]?.unresolved).toMatchObject({ before: 0, count: 1, change: 'add', top: 'still_unresolved', thresholds: { add: 0.5, reset: 0.7 }, conf: 0.5 })
  expect(Number((counted[0]?.unresolved?.probs.still_unresolved ?? 0).toFixed(2))).toBe(0.62)
  expect(counted[0]?.reason).toContain('仍未解决 62%')
  expect(counted[0]?.reason).toContain('加一门槛 50%')
  expect(counted[1]?.reason).toContain('已经解决 80% ≥ 清零门槛 70%')
  // Every answered message has its conclusion with its effort decision, moved or not: that is what the card draws.
  const efforts = log.filter((entry) => entry.feature === 'main-effort')
  expect(efforts.map((entry) => entry.unresolved?.change)).toEqual(['add', 'keep', 'reset'])
  expect(efforts[1]?.unresolved).toMatchObject({ before: 1, count: 1, change: 'keep', top: 'resolved' })
  // The node's decision is the effort's, as before: it is no entry of the count's.
  const node = (await w.board()).nodes.find((one) => one.turn === 3 && one.id === 'main')
  expect(log.find((entry) => entry.n === node?.decision)?.feature).toBe('main-effort')
  expect(main).toMatchObject({ routed: true })
  // /dp log lists it, and the debug log has the same line.
  expect(await w.command('dp', 'log 10')).toMatch(/unresolved：次数 1 → 0 · "好了，谢谢"：/)
  expect(w.logs.some((entry) => entry.to === 'debug' && entry.text.startsWith('次数 0 → 1 · "登录接口还是 502"：'))).toBe(true)
})

test("the card of the main agent shows the count and the conclusion of this message's answer; the band draws nothing of it", { options: KEY }, async ($, on) => {
  const said = { now: STILL }
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(said) })
  await w.submit('登录接口还是 502')
  await w.complete()
  await w.submit('还是不行')
  await w.complete()
  said.now = UNSURE
  await w.submit('嗯，再看看')
  await w.step({ index: 0 })

  const ui = await w.pane()
  const card = shown(await ui.find({ key: 'pane-card-unresolved' }))
  // The count the message left (it stayed at 2), the options' probabilities, and what that did.
  expect(card).toContain('次数 2')
  expect(card).toContain('不变')
  const odds = shown(await ui.find({ key: 'pane-card-unresolved-odds' }))
  expect(odds).toContain('仍未解决 30%')
  expect(odds).toContain('已经解决 40%')
  expect(odds).toContain('新问题或无关 30%')
  expect(odds).toContain('都没到')

  // The band says nothing more for it (story 34): not a row, not an event of the stream.
  const band = await w.band()
  const text = (await band.findAll({ type: 'Box' })).map(shown).join('\n')
  expect(text).not.toContain('未解决')
})

test('the card says how the count moved: from and to', { options: KEY }, async ($, on) => {
  const said = { now: STILL }
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(said) })
  await w.submit('登录接口还是 502')
  await w.step({ index: 0 })
  const ui = await w.pane()
  expect(shown(await ui.find({ key: 'pane-card-unresolved' }))).toContain('次数 0 → 1')
  expect(shown(await ui.find({ key: 'pane-card-unresolved' }))).toContain('加一')
})

test('the log row of a count that moved says what it did, in the pane', { options: KEY }, async ($, on) => {
  const said = { now: STILL }
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend(said) })
  await w.submit('登录接口还是 502')
  const ui = await w.pane()
  const rows = (await ui.findAll({ type: 'Box' })).filter((box) => box.key?.startsWith('pane-entry-'))
  const row = rows.map(shown).find((text) => text.includes('未解决次数'))
  expect(row).toContain('次数加一')
  expect(row).toContain('次数 0 → 1')
})

test('the pane shows the problem summary in full: the problem, every try with the unresolved ones said so, the status; nothing while there is none', { options: KEY }, async ($, on) => {
  const tries = Array.from({ length: 8 }, (_, i) => ({ text: `第 ${i + 1} 次：${'把配置里的某一项改成另一个值再重启服务，'.repeat(2)}`, ...(i < 3 ? { unresolved: true as const } : {}) }))
  const summary = { problem: '服务启动后立刻退出，日志里只有一行 ETIMEDOUT', tried: tries, status: '助手在等新的日志', turn: 't9' }
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend({ now: UNSURE }), seed: { unresolved: { count: 3, summary } } })

  const ui = await w.pane()
  const text = shown(await ui.find({ key: 'pane-summary' }))
  expect(text).toContain('问题摘要')
  expect(text).toContain(summary.problem)
  for (const attempt of tries) expect(text).toContain(attempt.text)
  expect(text).toContain(summary.status)
  // The ones the person said did not work are marked, and only those.
  const marked = (await ui.findAll({ type: 'Box' })).filter((box) => box.key?.startsWith('pane-summary-try-')).map((box) => shown(box).includes('未解决'))
  expect(marked).toEqual([true, true, true, false, false, false, false, false])
})

test('the pane has no summary block while there is no summary', { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: backend({ now: UNSURE }) })
  await w.submit('登录接口还是 502')
  expect(await (await w.pane()).find({ key: 'pane-summary' })).toBeUndefined()
})

test('a message that leaves no answer to the question has no conclusion on its card', { options: KEY }, async ($, on) => {
  const w = world($, on, { switches: UNRESOLVED_ON, backend: (request) => jev([0.05, 0.1, 0.7, 0.1, 0.05])(request) })
  await w.submit('改个错别字')
  await w.step({ index: 0 })
  const ui = await w.pane()
  // Answered "new or unrelated" at 100%: reset at a count of 0, so nothing moved and the conclusion says so.
  expect(shown(await ui.find({ key: 'pane-card-unresolved' }))).toContain('次数 0')
  expect((await w.board()).log.filter((entry) => entry.feature === 'unresolved')).toEqual([])
})
