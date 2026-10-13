// What an agent's decision reads beside its brief and the person's words (ADR 0007): with pplx, the background it was
// written in, the conversation it was dispatched from and, for a Workflow's agents, the script; with Jev neither
// (BACKEND_DEFAULTS agentBackground). And an agent of a Workflow decided as it starts reads what the turn that
// launched its run said, not a message the person sent since. Seam 1: the engine's events in, the requests out.

import { expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import { estimateTokens } from '../hooks/decision/context.ts'
import { SUMMARY_FIELD } from '../hooks/decision/summary.ts'
import { COUNT_FIELD } from '../hooks/decision/unresolved.ts'
import { planBatches, SCRIPT_FIELD } from '../hooks/decision/workflow.ts'
import { parseWorkflow } from '../hooks/decision/workflow-script.ts'
import { dispatchSettings, readConfig } from '../hooks/core/setup.ts'
import { DEFAULT_ASK } from '../hooks/decision/effort.ts'
import { siteJev, workflowWorld, type SiteAnswer } from './support/workflow.ts'
import { runWorld } from './support/workflow-run.ts'
import { jev, pplx, world } from './support/world.ts'

const JEV = { decisionModel: 'jev', typesafeApiKey: 'ts-test-key' }
/** `pplxQps: 50`: these tests are about what is asked, not the rate it is asked at. */
const PPLX = { decisionModel: 'pplx', perplexityApiKey: 'pplx-test-key', pplxQps: 50 }

/** Tokens of a state as it is sent: JSON, field names and escapes counted. */
const sentTokens = (state: unknown) => estimateTokens(JSON.stringify(state))

/** A transcript row as `$.session.messages()` gives it; `calls`, the tool calls an assistant message made (tool and id). */
const row = (role: 'user' | 'assistant', text: string, calls: [string, string][] = []): SessionMessage => ({ role, text, toolUses: calls.map(([tool, tool_use_id]) => ({ tool_use_id, tool, input: {} })) })

/** A script whose one call's prompt is data: its agents are decided as each one starts. */
const ANSWERS = `export const meta = { name: 'answers', description: 'Answer each question', phases: [] }
const found = await parallel(QUESTIONS.map((q) => () => agent(q.prompt, { label: q.label })))
return found
`
const TASK = 'Is every route under src/api/admin checked for the admin role? Cite the file and line of each gap.'

// ---- the defect: a later message is not the launching turn's -------------------------------------------------

test("an agent decided as it starts reads the person's words of the turn that launched its run, not a message they sent while it ran", { options: JEV }, async ($, on) => {
  const w = runWorld($, on, { backend: siteJev((): SiteAnswer => ({ model: { sonnet: 0.9 }, effort: [0, 1, 0, 0, 0], nouls: { 'named.opus': 0.95 } })) })
  await w.submit('这几个安全审查都用 opus 跑')
  await w.workflow({ script: ANSWERS })
  // The Workflow runs in the background; the person, idle, asks about something else.
  await w.submit('顺便帮我看看 README 的排版')
  w.started('wf_test-1', 'wa1', 'q-auth')
  w.transcript('wf_test-1', 'wa1', TASK)
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })

  const sent = w.requests.at(-1)?.body
  expect(sent.state.user_message).toBe('这几个安全审查都用 opus 跑')
  // The model the launching turn named is asked about, and stands.
  expect(Object.keys(sent.questions)).toContain('agent-0.named.opus')
  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-opus-5-5 medium'])
})

test('with pplx, an agent decided as it starts reads the run\'s script and the conversation up to the Workflow call, not what was said after it, within a dispatched agent\'s budget', { options: PPLX }, async ($, on) => {
  const transcript = [
    row('user', '这几个安全审查都并行跑一下'),
    row('assistant', 'I will fan out one agent per question with a Workflow.', [['Workflow', 'toolu_wf']]),
    row('user', '顺便帮我看看 README 的排版'),
    row('assistant', 'README 的标题层级不一致。'),
  ]
  const w = runWorld($, on, { backend: siteJev((): SiteAnswer => ({ model: { sonnet: 0.9 }, effort: [0, 1, 0, 0, 0] })), messages: transcript })
  await w.submit('这几个安全审查都并行跑一下')
  await w.workflow({ script: ANSWERS, tool_use_id: 'toolu_wf' })
  await w.submit('顺便帮我看看 README 的排版')
  w.started('wf_test-1', 'wa1', 'q-auth')
  w.transcript('wf_test-1', 'wa1', TASK)
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })

  const state = w.requests.at(-1)?.body.state
  expect(state.user_message).toBe('这几个安全审查都并行跑一下')
  expect(state[SCRIPT_FIELD]).toBe(ANSWERS)
  expect(String(state.recent_context).split('\n')).toEqual(['user: 这几个安全审查都并行跑一下', 'assistant: [tools: Workflow] I will fan out one agent per question with a Workflow.'])
  expect(state.brief_0.prompt).toBe(TASK)
  expect(sentTokens(state)).toBeLessThanOrEqual(32000)
})

// ---- a dispatched agent ------------------------------------------------------------------------------------

const DISPATCHING = [
  row('user', 'the cache refresh and the session writer race somewhere; find out where'),
  row('assistant', 'I will send an Explore agent to map who writes the session, then fix it myself.', [['Agent', 'toolu_1']]),
]

test('with pplx, a dispatched agent\'s request carries the conversation it was dispatched from, after its brief and the person\'s words', { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: pplx([0, 1, 0, 0, 0]), messages: DISPATCHING })
  await w.submit('the cache refresh and the session writer race somewhere; find out where')
  await w.spawn({ prompt: 'List every function in src/session that writes the session file.', description: 'Map session writers', subagentType: 'Explore' })

  const state = w.requests.find((request) => 'agent.model' in request.body.questions)?.body.state
  expect(Object.keys(state)).toEqual(['brief', 'user_message', 'recent_context'])
  expect(String(state.recent_context).split('\n')).toEqual([
    'user: the cache refresh and the session writer race somewhere; find out where',
    'assistant: [tools: Agent] I will send an Explore agent to map who writes the session, then fix it myself.',
  ])
  // The debug log says what the request held: each field's size, never its content.
  expect(w.logs.map((log) => log.text)).toContainEqual(expect.stringMatching(/for agent .*; state \d+ tokens \(brief \d+, user_message \d+, recent_context \d+\)$/))
})

test('with pplx, an agent a subagent dispatches reads the subagent\'s own conversation', { options: PPLX }, async ($, on) => {
  const messages = (asked: { agentId?: string }) => (asked.agentId === 'sub-1' ? [row('user', 'Audit src/payments for unchecked refunds.'), row('assistant', 'Splitting the audit: one agent per module.', [['Agent', 'toolu_1']])] : DISPATCHING)
  const w = world($, on, { backend: pplx([0, 1, 0, 0, 0]), messages })
  await w.spawn({ prompt: 'Audit src/payments/refund.ts for refunds issued without a check.', parentAgentId: 'sub-1' })

  const state = w.requests.find((request) => 'agent.model' in request.body.questions)?.body.state
  expect(String(state.recent_context)).toContain('Splitting the audit: one agent per module.')
  expect(String(state.recent_context)).not.toContain('session writer')
})

test("with Jev, a dispatched agent's request is its brief and the person's words: no conversation", { options: JEV }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 1, 0, 0, 0]), messages: DISPATCHING })
  await w.submit('the cache refresh and the session writer race somewhere; find out where')
  await w.spawn({ prompt: 'List every function in src/session that writes the session file.', subagentType: 'Explore' })
  const state = w.requests.find((request) => 'agent.model' in request.body.questions)?.body.state
  expect(Object.keys(state)).toEqual(['brief', 'user_message'])
})

// ---- a Workflow's agents decided when the script is sent ------------------------------------------------------

const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'
const TIDY = `export const meta = { name: 'tidy-api', description: 'Rename getUser to fetchUser in src/api, then review the diff', phases: [] }
const TOKEN = '${SECRET}'
const edited = await agent('Rename getUser to fetchUser across src/api and run pnpm test api.', { label: 'rename' })
const review = await agent('Review the diff of src/policies/document.ts for permission regressions and report the risky edge cases.', { label: 'review' })
return { edited, review }
`

test('with pplx, the requests about a script\'s calls carry the script (secrets masked) and the conversation up to the Workflow call', { options: PPLX }, async ($, on) => {
  const transcript = [row('user', '把 getUser 改名，再审一下 diff'), row('assistant', 'Two steps in one Workflow: rename, then review.', [['Workflow', 'toolu_wf']]), row('user', 'later words')]
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { sonnet: 0.9 } })), messages: transcript })
  await w.submit('把 getUser 改名，再审一下 diff')
  await w.workflow({ script: TIDY, tool_use_id: 'toolu_wf' })

  const state = w.requests.find((request) => 'agent-0.model' in request.body.questions)?.body.state
  expect(Object.keys(state)).toEqual(['brief_0', 'brief_1', 'user_message', SCRIPT_FIELD, 'recent_context'])
  expect(String(state[SCRIPT_FIELD])).toContain("label: 'review'")
  expect(String(state[SCRIPT_FIELD])).toContain('[REDACTED]')
  expect(JSON.stringify(state)).not.toContain(SECRET)
  expect(String(state.recent_context)).not.toContain('later words')
})

test("with Jev, the requests about a script's calls hold their briefs and the person's words: no script, no conversation", { options: JEV }, async ($, on) => {
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { sonnet: 0.9 } })), messages: DISPATCHING })
  await w.submit('把 getUser 改名，再审一下 diff')
  await w.workflow({ script: TIDY })
  const state = w.requests.find((request) => 'agent-0.model' in request.body.questions)?.body.state
  expect(Object.keys(state)).toEqual(['brief_0', 'brief_1', 'user_message'])
})

test("a call's prompt is sent whole when it fits its share of the budget: a script of one call gives it all of it, not 400 tokens", { options: JEV }, async ($, on) => {
  const steps = Array.from({ length: 120 }, (_, i) => `Step ${i + 1}: migrate the handler in src/api/routes/r${i}.ts to the new router and keep its tests green.`).join(' ')
  const script = `export const meta = { name: 'migrate', description: 'Move every route to the new router', phases: [] }
await agent(${JSON.stringify(steps)}, { label: 'migrate' })
`
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { sonnet: 0.9 } })) })
  await w.workflow({ script })
  const brief = w.requests.find((request) => 'agent-0.model' in request.body.questions)?.body.state.brief_0
  expect(estimateTokens(steps)).toBeGreaterThan(2500)
  expect(brief.prompt).toBe(steps)
})

test("a script's requests carry the problem summary and the unresolved count while the unresolved switch is on, as a dispatched agent's do", { options: JEV }, async ($, on) => {
  const summary = { problem: '导出的 CSV 缺行', tried: [{ text: '改了编码', unresolved: true as const }], status: '还在查', turn: 't1' }
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { sonnet: 0.9 } })), switches: { unresolved: true }, seed: { unresolved: { count: 2, summary } } })
  // The session starts first: the switches are read there.
  await w.start()
  await w.workflow({ script: TIDY })
  const state = w.requests.find((request) => 'agent-0.model' in request.body.questions)?.body.state
  expect(String(state[SUMMARY_FIELD])).toContain('导出的 CSV 缺行')
  expect(state[COUNT_FIELD]).toBe(2)
})

// ---- a run given by path: decided as it launches -----------------------------------------------------------

test('with pplx, a run given by path is asked about with the script it runs and the conversation up to its call', { options: PPLX }, async ($, on) => {
  const saved = '/work/.claude/workflow-scripts/tidy.js'
  const transcript = [row('user', 'rerun the tidy script'), row('assistant', 'Running it again from its file.', [['Workflow', 'toolu_wf']])]
  const w = runWorld($, on, { disk: { [saved]: TIDY }, backend: siteJev(() => ({ model: { sonnet: 0.9 } })), messages: transcript })
  await w.submit('rerun the tidy script')
  await w.workflow({ scriptPath: saved, tool_use_id: 'toolu_wf' })
  const state = w.requests.find((request) => 'agent-0.model' in request.body.questions)?.body.state
  expect(String(state[SCRIPT_FIELD])).toContain("label: 'rename'")
  expect(String(state.recent_context)).toContain('Running it again from its file.')
})

// ---- the budgets (seam 2) -----------------------------------------------------------------------------------

test('a script whose calls take several requests, sent together, keeps each within the budget for several at once; one request takes the larger one', () => {
  const settings = dispatchSettings({ config: readConfig(PPLX), ask: DEFAULT_ASK })
  const prompt = (i: number) => `Audit module m${i}: ${Array.from({ length: 900 }, (_, k) => `check the handler h${k} for unchecked input;`).join(' ')}`
  const scriptOf = (n: number) =>
    `export const meta = { name: 'audit', description: 'Audit every module', phases: [] }\n${Array.from({ length: n }, (_, i) => `await agent(${JSON.stringify(prompt(i))}, { label: 'audit-${i}' })`).join('\n')}\n`
  const budgets = { one: 48000, each: 32000 }

  const many = planBatches(parseWorkflow(scriptOf(10)) as NonNullable<ReturnType<typeof parseWorkflow>>, 'audit everything', settings, budgets)
  expect(many.batches.length).toBe(2)
  for (const batch of many.batches) expect(sentTokens(batch.request.state)).toBeLessThanOrEqual(32000)

  const one = planBatches(parseWorkflow(scriptOf(6)) as NonNullable<ReturnType<typeof parseWorkflow>>, 'audit everything', settings, budgets)
  expect(one.batches.length).toBe(1)
  expect(sentTokens(one.batches[0]?.request.state)).toBeGreaterThan(32000)
  expect(sentTokens(one.batches[0]?.request.state)).toBeLessThanOrEqual(48000)
})
