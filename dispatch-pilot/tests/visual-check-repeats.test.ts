// visual_check (#57): a check that fails twice in a row, for the same agent in the same loop, brings a reminder to look at the
// image before going on (the agent may be changing the wrong thing, led by a wrong verdict). Seam 1: the calls in, the answer out.

import { expect, test } from 'claude-code/testing'
import { jev, world } from './support/world.ts'

const JEV = { typesafeApiKey: 'ts-test-key' }
const SHOT = '/shots/home.png'
const FILES = { [SHOT]: { format: 'png', width: 1200, height: 800 } }
const BUTTON = { part: 'the primary button', property: 'has the label Upgrade to Premium' }
const REMINDER = 'Check 1 has now failed twice in a row: look at the image yourself (visual_check with look: true) before you change anything else.'

/** A world whose decision model gives the first check the probabilities of `answers`, one for each call in turn. */
function failing($: Parameters<typeof world>[0], on: Parameters<typeof world>[1], answers: number[]) {
  return world($, on, {
    session: true,
    files: FILES,
    process: true,
    backend: (request, n) => jev([0, 1, 0, 0, 0], { nouls: { 'check.0': answers[Math.min(n, answers.length) - 1] ?? 0.05 } })(request),
  })
}

const text = (answer: { result?: unknown }): string => ((answer.result as { text?: string }[])[0]?.text ?? '')

test('the second FAIL of a check in a row brings the reminder, and so does each one after it; the first does not', { options: JEV }, async ($, on) => {
  const w = failing($, on, [0.05, 0.05, 0.05])
  await w.start()
  const first = text(await w.visualCheck({ images: [SHOT], checks: [BUTTON] }))
  const second = text(await w.visualCheck({ images: [SHOT], checks: [BUTTON] }))
  const third = text(await w.visualCheck({ images: [SHOT], checks: [BUTTON] }))

  expect(first).not.toContain('failed twice')
  expect(second.split('\n').at(-1)).toBe(REMINDER)
  expect(third.split('\n').at(-1)).toBe(REMINDER)
})

test('a check is the same by its part and property, however they are spaced or capitalised; another property is another check', { options: JEV }, async ($, on) => {
  const w = failing($, on, [0.05, 0.05, 0.05])
  await w.start()
  await w.visualCheck({ images: [SHOT], checks: [BUTTON] })
  const again = text(await w.visualCheck({ images: [SHOT], checks: [{ part: ' The primary  button', property: 'has the label  upgrade to premium' }] }))
  const other = text(await w.visualCheck({ images: [SHOT], checks: [{ part: 'the primary button', property: 'is blue' }] }))

  expect(again).toContain(REMINDER)
  expect(other).not.toContain('failed twice')
})

test('a PASS or an UNSURE between two FAILs ends the run', { options: JEV }, async ($, on) => {
  const w = failing($, on, [0.05, 0.95, 0.05, 0.5, 0.05])
  await w.start()
  const answers = []
  for (let i = 0; i < 5; i++) answers.push(text(await w.visualCheck({ images: [SHOT], checks: [BUTTON] })))

  expect(answers.map((answer) => answer.includes('failed twice'))).toEqual([false, false, false, false, false])
})

test('a new turn of the loop starts the count again', { options: JEV }, async ($, on) => {
  const w = failing($, on, [0.05, 0.05, 0.05])
  await w.start()
  await w.visualCheck({ images: [SHOT], checks: [BUTTON] })
  await w.startTurn('next message')
  const afterwards = text(await w.visualCheck({ images: [SHOT], checks: [BUTTON] }))

  expect(afterwards).not.toContain('failed twice')
})

test('an agent woken by a message after it finished (spawn with resume, then its own turn.start) is in a loop of its own: the count starts again', { options: JEV }, async ($, on) => {
  const w = failing($, on, [0.05, 0.05, 0.05])
  await w.start()
  await w.submit('review the change and check the home screen')
  await w.step({ index: 0 })
  const started = await w.spawn({ prompt: 'Check the home screen.', description: 'check home' })
  await $.turn.start({ text: 'Check the home screen.', turnId: 'sub-1', agentId: started.agentId })
  await w.visualCheck({ images: [SHOT], checks: [BUTTON] }, { agentId: started.agentId })
  await w.spawn({ prompt: 'Look again.', description: 'check home again', resume: { agentId: started.agentId ?? '' } })
  await $.turn.start({ text: 'The coordinator sent a message while you were working: look again.', turnId: 'sub-2', agentId: started.agentId })
  const again = text(await w.visualCheck({ images: [SHOT], checks: [BUTTON] }, { agentId: started.agentId }))

  expect(again).not.toContain('failed twice')
})

test('each agent has its own count: the main agent’s FAIL and a dispatched agent’s are not two in a row, and the agent’s own run starts its count', { options: JEV }, async ($, on) => {
  const w = failing($, on, [0.05, 0.05, 0.05, 0.05])
  await w.start()
  await w.visualCheck({ images: [SHOT], checks: [BUTTON] })
  await $.turn.start({ text: '', turnId: 'turn-a1', agentId: 'a1' })
  const agentFirst = text(await w.visualCheck({ images: [SHOT], checks: [BUTTON] }, { agentId: 'a1' }))
  const agentSecond = text(await w.visualCheck({ images: [SHOT], checks: [BUTTON] }, { agentId: 'a1' }))
  // The agent’s turn start did not touch the main agent’s count.
  const mainSecond = text(await w.visualCheck({ images: [SHOT], checks: [BUTTON] }))

  expect(agentFirst).not.toContain('failed twice')
  expect(agentSecond).toContain(REMINDER)
  expect(mainSecond).toContain(REMINDER)
})
