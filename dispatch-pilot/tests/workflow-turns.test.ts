// A Workflow runs in the background: the person sends more messages while its
// agents are still running, and each message starts a main turn. Seam 1: the
// Workflow tool call, the main turns, the run's journal and the agents' steps
// in; out, the board.

import { expect, test } from 'claude-code/testing'
import { siteJev } from './support/workflow.ts'
import { runWorld } from './support/workflow-run.ts'

const KEY = { decisionModel: 'jev', typesafeApiKey: 'ts-test-key' }

/** A script the main agent saved earlier and runs again by its path; its call already names the model and effort that will be decided for it. */
const SAVED = '/work/.claude/workflow-scripts/research.js'
const RESEARCH = `export const meta = { name: 'research', description: 'Research whether IPv6 leaks past the proxy', phases: [] }
const found = await agent('Research whether IPv6 traffic can leak past the proxy on macOS and report the evidence.', { label: 'research:ipv6', model: 'sonnet', effort: 'xhigh' })
const checked = await agent('Verify the IPv6 leak findings against the mihomo config and list what does not hold.', { label: 'verify:ipv6', model: 'sonnet', effort: 'xhigh' })
return checked
`

test("a Workflow agent decided to run as its script has it stays routed on the board while the person sends two more messages", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { disk: { [SAVED]: RESEARCH }, backend: siteJev(() => ({ model: { sonnet: 0.9 }, effort: [0, 0, 0, 1, 0] })) })
  await w.startTurn('重开一下你的workflow')
  await w.workflow({ scriptPath: SAVED })
  w.started('wf_test-1', 'wa1', 'research:ipv6')
  const routedOf = async () => (await w.board()).nodes.filter((node) => node.id === 'wa1').map((node) => [node.turn, node.state, node.routed])

  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'xhigh' })
  expect(await routedOf()).toEqual([[1, 'running', true]])

  await w.startTurn('关掉 IPv6 会不会漏？')
  await w.agentStep('wa1', { index: 1, model: 'claude-sonnet-5-5', effort: 'xhigh' })
  expect(await routedOf()).toEqual([[1, 'running', true]])

  await w.startTurn('STUN 和 WebRTC 不是已经拦了吗？')
  await w.agentStep('wa1', { index: 2, model: 'claude-sonnet-5-5', effort: 'xhigh' })
  expect(await routedOf()).toEqual([[1, 'running', true]])
})

type Drawn = { key?: string; children?: unknown[]; props?: { children?: unknown; label?: unknown } }

/** The text a drawn element shows. */
function shown(element: unknown): string {
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (element === null || typeof element !== 'object') return ''
  const { children = [], props = {} } = element as Drawn
  const kids = Array.isArray(props.children) ? props.children : children
  return (typeof props.label === 'string' ? props.label : '') + kids.map(shown).join('')
}

test("the band shows a Workflow agent of an earlier turn while it runs, routed, and no longer once a stop ended it", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { disk: { [SAVED]: RESEARCH }, backend: siteJev(() => ({ model: { sonnet: 0.9 }, effort: [0, 0, 0, 1, 0] })) })
  const agentRows = async () => ((await (await w.band({ columns: 180, rows: 12 })).findAll({ type: 'Box' })) as Drawn[]).filter((box) => box.key?.startsWith('band-agent-')).map((box) => shown(box))
  await w.startTurn('重开一下你的workflow')
  await w.workflow({ scriptPath: SAVED })
  w.started('wf_test-1', 'wa1', 'research:ipv6')
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'xhigh' })
  await w.startTurn('关掉 IPv6 会不会漏？')
  await w.startTurn('STUN 和 WebRTC 不是已经拦了吗？')
  await w.agentStep('wa1', { index: 1, model: 'claude-sonnet-5-5', effort: 'xhigh' })

  const research = (await agentRows()).filter((row) => row.includes('research:ipv6'))
  expect(research).toHaveLength(1)
  expect(research[0]).not.toContain('未路由')

  // TaskStop: the agent's loop ends aborted (measured on 2.1.296); a turn later it is gone from the band.
  await w.complete({ agentId: 'wa1', turnId: 'turn-wa1', reason: 'aborted' })
  await w.startTurn('S2 的 Chrome 策略怎么设置')
  expect((await agentRows()).filter((row) => row.includes('research:ipv6'))).toEqual([])
  expect((await w.board()).nodes.filter((node) => node.id === 'wa1')).toEqual([])
})

test("a Workflow agent that starts after the person sent two more messages is routed by the decision made for its call", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { disk: { [SAVED]: RESEARCH }, backend: siteJev(() => ({ model: { sonnet: 0.9 }, effort: [0, 0, 0, 1, 0] })) })
  await w.startTurn('重开一下你的workflow')
  await w.workflow({ scriptPath: SAVED })
  await w.startTurn('关掉 IPv6 会不会漏？')
  await w.startTurn('STUN 和 WebRTC 不是已经拦了吗？')
  w.started('wf_test-1', 'wa2', 'verify:ipv6')
  await w.agentStep('wa2', { index: 0, model: 'claude-sonnet-5-5', effort: 'xhigh' })
  expect((await w.board()).nodes.filter((node) => node.id === 'wa2').map((node) => [node.state, node.routed, node.decision !== undefined])).toEqual([['running', true, true]])
})
