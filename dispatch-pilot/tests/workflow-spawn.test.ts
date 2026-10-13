// The agents of a Workflow now pass agent.spawn too (2.1.294 on: `workflow` is
// set, and a hook can only refuse the spawn, a change to its model is ignored).
// They are still the Workflow features' (#8 writes the script, #9 decides the
// rest as each agent starts): the dispatched-agents feature (#6) must not take
// them for agents the main agent dispatched. Seam 1: the Workflow tool call, the
// spawns the engine raises for the script's agent() calls, the run's journal and
// transcripts, the agents' steps in; out, the model and effort each step goes out
// with, the decision requests, the board.

import { expect, test } from 'claude-code/testing'
import { siteJev, type SiteAnswer } from './support/workflow.ts'
import { runWorld } from './support/workflow-run.ts'

const KEY = { decisionModel: 'jev', typesafeApiKey: 'ts-test-key' }

/**
 * A script whose agents start one after another, the later one's prompt built
 * from what the earlier returned (so workflow-agents cannot read it when the
 * script is sent): its agent is decided as it starts.
 */
const INVENTORY = `export const meta = { name: 'client-panel-inventory', description: 'Transcribe the panel screenshots, then map each control to its config key', phases: [] }
const shots = await agent('Transcribe every control on the panel screenshots in shots/ into a JSON list of label and value.', { label: 'transcribe' })
const MAP_PROMPT = (client) => \`Map each control of \${client} to the config key it sets:\\n\${JSON.stringify(shots)}\`
const mapped = await agent(MAP_PROMPT('ClashMac'), { label: 'map:clashmac' })
return mapped
`
const MAP_TASK = 'Map each control of ClashMac to the config key it sets:\n[{"label":"TUN","value":"on"}]'

/** The launch's request asks about `transcribe` (sonnet medium); the map agent's, as it starts, about it (sonnet high). */
const DECIDED = (request: Parameters<ReturnType<typeof siteJev>>[0]) => {
  const brief = (request.body?.state as Record<string, { label?: string }> | undefined)?.brief_0
  const answer: SiteAnswer = brief?.label === 'map:clashmac' ? { model: { sonnet: 0.81, opus: 0.19 }, effort: [0, 0, 1, 0, 0] } : { model: { sonnet: 0.9 }, effort: [0, 1, 0, 0, 0] }
  return siteJev(() => answer)(request)
}

test("a Workflow agent the engine spawns, whose call's prompt is built as the script runs, goes out on every step with the model and effort decided as it starts, not as its spawn left it", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: DECIDED })
  await w.workflow({ script: INVENTORY })
  // workflow-agents wrote the transcribe call, and left the map call (its prompt is a call of the script's own).
  expect(w.reached[0]?.script).toContain("{ label: 'transcribe', model: 'sonnet', effort: 'medium' }")
  expect(w.reached[0]?.script).toContain("{ label: 'map:clashmac' })")
  expect(w.requests).toHaveLength(1)

  // The transcribe agent runs first, as the script has it.
  await w.workflowSpawn('toolu_wf', { runId: 'wf_test-1', agentIndex: 1, agentId: 'wa1', label: 'transcribe', prompt: 'Transcribe every control on the panel screenshots in shots/ into a JSON list of label and value.', model: 'sonnet' })
  w.started('wf_test-1', 'wa1', 'transcribe')
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  await w.agentStep('wa1', { index: 1, model: 'claude-sonnet-5-5', effort: 'medium' })

  // Two minutes on, the map agent starts with the task the script built from it, on the session's model.
  await w.clock.advance(120_000)
  await w.workflowSpawn('toolu_wf', { runId: 'wf_test-1', agentIndex: 2, agentId: 'wa2', label: 'map:clashmac', prompt: MAP_TASK })
  w.started('wf_test-1', 'wa2', 'map:clashmac')
  w.transcript('wf_test-1', 'wa2', MAP_TASK)
  await w.agentStep('wa2', { index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })
  await w.agentStep('wa2', { index: 1, model: 'claude-opus-5-5', effort: 'xhigh' })

  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual([
    'wa1 claude-sonnet-5-5 medium',
    'wa1 claude-sonnet-5-5 medium',
    'wa2 claude-sonnet-5-5 high',
    'wa2 claude-sonnet-5-5 high',
  ])
  // Nothing is asked at the spawns: the launch asked about transcribe, the map agent's first step about it.
  expect(w.requests).toHaveLength(2)
  // The spawns reach the engine as it raised them.
  expect(w.spawned.map((s) => [s.description, s.model])).toEqual([
    ['transcribe', 'sonnet'],
    ['map:clashmac', undefined],
  ])

  // The board: each agent is a node of the Workflow in its call's place, the map agent with the model it runs on; no call waits.
  const board = await w.board()
  const agents = board.agents.filter((node) => node.id.startsWith('wa'))
  expect(agents.map((node) => [node.id, node.kind, node.name, node.model, node.effort, node.routed])).toEqual([
    ['wa1', 'wf', 'transcribe', 'sonnet', 'medium', true],
    ['wa2', 'wf', 'map:clashmac', 'sonnet', 'high', true],
  ])
  expect(board.agents.filter((node) => node.state === 'queued')).toEqual([])
  expect(board.log.find((entry) => entry.n === agents[1]?.decision)).toMatchObject({ feature: 'workflow-labels', agent: 'wa2', model: 'sonnet', effort: 'high' })
  expect(board.log.map((entry) => entry.feature)).not.toContain('dispatched-agents')
})

/** What a drawn element reads as, its text and its children's in order. */
function shown(element: unknown): string {
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (element === null || typeof element !== 'object') return ''
  const { children = [], props = {} } = element as { props?: Record<string, unknown>; children?: unknown[] }
  const kids = Array.isArray(props.children) ? props.children : children
  return kids.map(shown).join('')
}

/** A call that runs once per batch, its label a template: one decision for every agent it starts. */
const BATCHES = `export const meta = { name: 'transcribe-batches', description: 'Transcribe each batch of panel screenshots', phases: [] }
const BATCH_IDS = ['cm1', 'cm2', 'cm3']
const shots = await parallel(BATCH_IDS.map((id) => () => agent(\`Transcribe every control on the screenshots of batch \${id} into a JSON list.\`, { label: \`transcribe:\${id}\` })))
return shots
`

test("a call whose label is a template stands for every agent it starts: each one takes its call's decision, and the call no longer waits on the board once they have started", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { backend: siteJev(() => ({ model: { sonnet: 0.9 }, effort: [0, 0, 1, 0, 0] })) })
  await w.submit('把这几批截图都转录一遍')
  await w.workflow({ script: BATCHES })
  expect(w.reached[0]?.script).toContain("label: `transcribe:${id}`, model: 'sonnet', effort: 'high' }")

  for (const [i, id] of ['cm1', 'cm2'].entries()) {
    const agentId = `wa${i + 1}`
    await w.workflowSpawn('toolu_wf', { runId: 'wf_test-1', agentIndex: i + 1, agentId, label: `transcribe:${id}`, prompt: `Transcribe every control on the screenshots of batch ${id} into a JSON list.`, model: 'sonnet' })
    w.started('wf_test-1', agentId, `transcribe:${id}`)
    await w.agentStep(agentId, { index: 0, model: 'claude-sonnet-5-5', effort: 'high' })
  }

  const board = await w.board()
  const agents = board.agents.filter((node) => node.id.startsWith('wa'))
  const entry = board.log.find((e) => e.feature === 'workflow-agents')
  // Both agents went out as their call's decision says, and point at it.
  expect(agents.map((node) => [node.id, node.name, node.model, node.effort, node.routed, node.decision])).toEqual([
    ['wa1', 'transcribe:cm1', 'sonnet', 'high', true, entry?.n],
    ['wa2', 'transcribe:cm2', 'sonnet', 'high', true, entry?.n],
  ])
  // The call's node stays, started, for the batch still to come; the band shows the agents, not a waiting call.
  expect(board.agents.filter((node) => node.name === 'transcribe:${id}').map((node) => node.state)).toEqual(['running'])
  const ui = await w.band({ columns: 180, rows: 20 })
  const rows = (await ui.findAll({ type: 'Box' })).filter((box) => box.key?.startsWith('band-agent-')).map((box) => shown(box))
  // The main agent and the two agents: no row for the call.
  expect(rows).toHaveLength(3)
  expect(rows.join('\n')).not.toContain('排队')

  // The third batch's agent finds the same call.
  await w.workflowSpawn('toolu_wf', { runId: 'wf_test-1', agentIndex: 3, agentId: 'wa3', label: 'transcribe:cm3', prompt: 'Transcribe every control on the screenshots of batch cm3 into a JSON list.', model: 'sonnet' })
  w.started('wf_test-1', 'wa3', 'transcribe:cm3')
  await w.agentStep('wa3', { index: 0, model: 'claude-sonnet-5-5', effort: 'high' })
  expect((await w.board()).agents.find((node) => node.id === 'wa3')).toMatchObject({ routed: true, decision: entry?.n })
})
