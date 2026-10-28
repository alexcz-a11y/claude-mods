// Image routing, the second half (#64, ADR 0008): the agents the main agent starts read what the session's reference images read
// as. The state of an `agent.spawn` decision, of a Workflow script's batch requests and of the by-label fallback (an agent
// decided as it starts) carries `reference_complexity`: the latest reading of the session, as text, with no image, within the
// request's budget. Seam 1: the engine's events in, the requests out.

import { expect, test } from 'claude-code/testing'
import { estimateTokens } from '../hooks/decision/context.ts'
import type { PastedImage } from './support/pasted.ts'
import { siteJev } from './support/workflow.ts'
import { runWorld } from './support/workflow-run.ts'
import { jev, KEY, type Reply, type Sent } from './support/world.ts'

const ON = { 'image-routing': true }

const at = (level: number): number[] => [0, 1, 2, 3, 4].map((i) => (i === level ? 1 : 0))

/** The picture the person pastes with their first message: the engine's scaled copy, and the original the row names. */
const SCENE: PastedImage = { path: '/refs/scene.png', shown: { format: 'png', width: 2000, height: 1333, label: 'shown-scene' } }
const FILES = { '/refs/scene.png': { format: 'png' as const, width: 3000, height: 2000, label: 'scene' } }

/** The reading of the images (level 3) and the message's effort from Jev; the agents' questions as `siteJev` answers them. */
const backend = (request: Sent): Reply => {
  const ids = Object.keys(request.body?.questions ?? {})
  return ids.some((id) => id.startsWith('agent')) ? siteJev(() => ({ model: { sonnet: 0.9 }, effort: [0, 1, 0, 0, 0] }))(request) : jev(at(2), { scores: { 'complexity.level': at(3) } })(request)
}

const asksAgent = (request: Sent): boolean => Object.keys(request.body?.questions ?? {}).some((id) => id.startsWith('agent'))
const sentTokens = (state: unknown): number => estimateTokens(JSON.stringify(state))

/** A world in which the person has pasted the reference image with their first message, so the session has a reading. */
async function readSession($: Parameters<typeof runWorld>[0], on: Parameters<typeof runWorld>[1], options: Parameters<typeof runWorld>[2] = {}) {
  const w = runWorld($, on, { switches: ON, files: FILES, process: true, backend, ...options })
  await w.submit('Build the scene in three.js to look like the picture', { images: [SCENE] })
  await w.step({ index: 0 })
  return w
}

// ---- A dispatched agent -----------------------------------------------------------------------------------------------------------

test('an agent the main agent starts is decided with what the latest reference images read as, as text and after its brief and the words', { options: KEY }, async ($, on) => {
  const w = await readSession($, on)
  await w.spawn({ prompt: 'Model the lighthouse from the reference picture in Blender.', description: 'Model the lighthouse' })

  const sent = w.requests.find(asksAgent)
  expect(Object.keys(sent?.body.state)).toEqual(['brief', 'user_message', 'reference_complexity'])
  expect(sent?.body.state.reference_complexity).toMatchObject({ level: 3, images: 1 })
  // Text only: the request carries no image, and the image headers are not sent.
  expect(sent?.body.assets).toBeUndefined()
  expect(sent?.headers['TypeSafe-Danger-Zone-Images']).toBeUndefined()
  expect(JSON.stringify(sent?.body)).not.toContain('data_base64')
})

test('before any reference image has been read, an agent is decided as it always was', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { switches: ON, files: FILES, process: true, backend })
  await w.submit('Rename getUser to fetchUser')
  await w.spawn({ prompt: 'Rename getUser to fetchUser across src/api.', description: 'Rename' })

  expect(Object.keys(w.requests.find(asksAgent)?.body.state)).toEqual(['brief', 'user_message'])
})

test('with the feature off, the readings kept are not given to an agent', { options: KEY }, async ($, on) => {
  const w = await readSession($, on)
  await w.command('dp', 'image-routing off')
  await w.spawn({ prompt: 'Model the lighthouse from the reference picture in Blender.', description: 'Model the lighthouse' })

  expect(Object.keys(w.requests.find(asksAgent)?.body.state)).toEqual(['brief', 'user_message'])
})

test("an agent's state with the reading stays within the budget for an agent: a long brief is cut, the reading is not", { options: KEY }, async ($, on) => {
  const w = await readSession($, on)
  await w.spawn({ prompt: `${'Model every plank of the hull, every rope and every sail. '.repeat(8000)}`, description: 'Model the ship' })

  const state = w.requests.find(asksAgent)?.body.state
  expect(state.reference_complexity).toMatchObject({ level: 3 })
  expect(sentTokens(state)).toBeLessThanOrEqual(24000)
  expect(sentTokens(state)).toBeGreaterThan(23000)
})

// ---- A Workflow's agents ----------------------------------------------------------------------------------------------------------------

const TIDY = `export const meta = { name: 'tidy-api', description: 'Model the lighthouse, then review the model', phases: [] }
const modelled = await agent('Model the lighthouse from the reference picture in Blender and export it.', { label: 'model' })
const review = await agent('Review the exported lighthouse model for gaps against the picture and report them.', { label: 'review' })
return { modelled, review }
`

test('the batch request for a Workflow script carries the reading once, as text, for every call', { options: KEY }, async ($, on) => {
  const w = await readSession($, on)
  await w.workflow({ script: TIDY })

  const sent = w.requests.filter(asksAgent)
  expect(sent).toHaveLength(1)
  expect(Object.keys(sent[0]?.body.state)).toEqual(['brief_0', 'brief_1', 'user_message', 'reference_complexity', 'workflow_script'])
  expect(sent[0]?.body.state.reference_complexity).toMatchObject({ level: 3, images: 1 })
  expect(sent[0]?.body.assets).toBeUndefined()
})

test("a script's batch with the reading stays within its budget, and so does each batch of a script that takes several", { options: KEY }, async ($, on) => {
  const calls = Array.from({ length: 12 }, (_, i) => `agent('Model part ${i} of the lighthouse: ${'plank and rope and sail, '.repeat(900)}', { label: 'part-${i}' })`).join('\n')
  const script = `export const meta = { name: 'parts', description: 'Model the parts', phases: [] }\n${calls}\nreturn 1\n`
  const w = await readSession($, on)
  await w.workflow({ script })

  const sent = w.requests.filter(asksAgent)
  expect(sent.length).toBeGreaterThan(1)
  for (const request of sent) {
    expect(request.body.state.reference_complexity).toMatchObject({ level: 3 })
    expect(sentTokens(request.body.state)).toBeLessThanOrEqual(96000)
  }
})

test('with the feature off, a Workflow script is asked about as it always was', { options: KEY }, async ($, on) => {
  const w = await readSession($, on)
  await w.command('dp', 'image-routing off')
  await w.workflow({ script: TIDY })

  expect(Object.keys(w.requests.find(asksAgent)?.body.state)).toEqual(['brief_0', 'brief_1', 'user_message', 'workflow_script'])
})

const SAVED = '/work/.claude/workflow-scripts/tidy.js'

test('the requests for a script run by its path (decided by label as the run starts) carry the reading, and so does an agent decided as it starts', { options: KEY }, async ($, on) => {
  const w = await readSession($, on, { disk: { [SAVED]: TIDY } })
  await w.workflow({ scriptPath: SAVED })
  const launch = w.requests.filter(asksAgent)
  expect(launch).toHaveLength(1)
  expect(launch[0]?.body.state.reference_complexity).toMatchObject({ level: 3, images: 1 })

  // An agent whose label is none of the script's calls: decided as it starts, from its task.
  await w.started('wf_test-1', 'wa3', 'summarize', { prompt: 'Summarize the rename and the review in five bullet points.' })
  await w.agentStep('wa3', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  const start = w.requests.filter(asksAgent).at(-1)
  expect(start?.body.state.reference_complexity).toMatchObject({ level: 3, images: 1 })
})
