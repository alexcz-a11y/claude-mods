// The Workflow fallback (#9): the agents of a Workflow the workflow-agents
// feature (#8) could not rewrite (given by scriptPath or by name, resumed, a
// script it cannot read, calls whose prompt it cannot read) get their model
// and effort when each one starts, by its label. Seam 1: the Workflow tool call
// and the agents' steps in, the run's journal and transcripts on the disk
// beneath `$.fs`; out, the model and effort each step goes out with, the
// decision requests, what the main agent is told, the status line.

import { expect, test } from 'claude-code/testing'
import { CLEF_OPTIONS, clefInputProblems } from './support/cloudflare.ts'
import { clefSiteJev, siteJev, type SiteAnswer } from './support/workflow.ts'
import { persisted, runDir, runWorld } from './support/workflow-run.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }

/** A script the main agent saved earlier and runs again by its path. */
const SAVED = '/work/.claude/workflow-scripts/tidy.js'
const TIDY = `export const meta = { name: 'tidy-api', description: 'Rename getUser to fetchUser in src/api, then review the diff', phases: [] }
const edited = await agent('Rename getUser to fetchUser across src/api and run pnpm test api.', { label: 'rename' })
const review = await agent('Review the diff of src/policies/document.ts for permission regressions and report the risky edge cases.', { label: 'review' })
return { edited, review }
`

test('an agent of a Workflow given by scriptPath goes out, on every step, with the model and effort decided for its call, found by its label in the journal', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, {
    disk: { [SAVED]: TIDY },
    backend: siteJev((i) =>
      i === 0
        ? { model: { haiku: 0.1, sonnet: 0.8, opus: 0.1 }, effort: [0.1, 0.8, 0.1, 0, 0] }
        : { model: { haiku: 0.02, sonnet: 0.08, opus: 0.9 }, effort: [0, 0.1, 0.8, 0.1, 0] },
    ),
  })
  await w.workflow({ scriptPath: SAVED })
  // The script runs as written: the path reaches the tool untouched.
  expect(w.reached).toEqual([{ scriptPath: SAVED, launched: true }])

  w.started('wf_test-1', 'wa1', 'rename')
  await w.agentStep('wa1', { index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })
  await w.agentStep('wa1', { index: 1, model: 'claude-opus-5-5', effort: 'xhigh' })
  w.started('wf_test-1', 'wa2', 'review')
  await w.agentStep('wa2', { index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })

  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual([
    'wa1 claude-sonnet-5-5 medium',
    'wa1 claude-sonnet-5-5 medium',
    'wa2 claude-opus-5-5 high',
  ])
})

test("an agent that takes its first step while its run is still being set up (the run starts before the tool call returns) waits for it, then goes out decided", { options: KEY }, async ($, on) => {
  const answer = siteJev((i): SiteAnswer => (i === 0 ? { model: { sonnet: 0.9 }, effort: [0, 1, 0, 0, 0] } : { model: { opus: 0.9 } }))
  const w = runWorld($, on, { disk: { [SAVED]: TIDY }, backend: (request) => ({ after: 300, reply: answer(request) }) })
  const call = w.workflow({ scriptPath: SAVED })
  await w.clock.settle()
  // The run has started; the decision about its calls is on its way.
  expect(w.reached).toHaveLength(1)
  w.started('wf_test-1', 'wa1', 'rename')
  const step = w.agentStep('wa1', { index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })
  await w.clock.settle()
  expect(w.steps).toHaveLength(0)

  await w.clock.advance(300)
  await call
  await step
  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-sonnet-5-5 medium'])
})

test("the Workflow tool's description tells the main agent to give every agent() call a fixed, unique label, in words that never change, so the prompt cache holds", { options: KEY }, async ($, on) => {
  const w = runWorld($, on)
  const engine = 'Run a workflow script that orchestrates many agents.'
  const first = await w.describeWorkflow(engine)
  const again = await w.describeWorkflow(engine)

  // The engine's own description first, the hint after it.
  expect(first.description.startsWith(`${engine}\n\n`)).toBe(true)
  expect(first.description).toContain('Give every agent() call a label that is fixed and unique within the script')
  expect(first.description).toContain("{ label: 'review-auth' }")
  expect(first.description).toContain('{ label: `audit:${file}` }')
  expect(again.description).toBe(first.description)
})

test("without a decision model to ask, or with workflow-labels off when the tool is first described, the Workflow tool's description is the engine's", async ($, on) => {
  const w = runWorld($, on, { store: {}, session: true })
  await w.start()
  const engine = 'Run a workflow script that orchestrates many agents.'
  // No key: nothing can be routed.
  expect((await w.describeWorkflow(engine)).description).toBe(engine)
})

/** The decisions about TIDY's two calls: the rename to sonnet medium, the review to opus high. */
const TIDY_DECIDED = siteJev((i): SiteAnswer => (i === 0 ? { model: { sonnet: 0.9 }, effort: [0, 1, 0, 0, 0] } : { model: { opus: 0.9 }, effort: [0, 0, 1, 0, 0] }))

test('/dp workflow-labels off: no agent is routed and no run recorded, nothing is asked, its status segment goes, and the Workflow tool is described as the engine has it; on brings it all back', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { disk: { [SAVED]: TIDY }, backend: TIDY_DECIDED })
  expect(await w.command('dp')).toMatch(/\bon +workflow-labels +\S/)
  await w.workflow({ scriptPath: SAVED })
  w.started('wf_test-1', 'wa1', 'rename')
  await w.agentStep('wa1', { index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })
  expect(w.status()).toBe('dp workflow not routed (given by path) | by label: routed 1 agent')

  expect(await w.command('dp', 'workflow-labels off')).toContain('workflow-labels is off')
  expect(w.status()).toBe('dp workflow not routed (given by path)')
  w.started('wf_test-1', 'wa2', 'review')
  await w.agentStep('wa2', { index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })
  await w.workflow({ scriptPath: SAVED })
  expect(w.requests).toHaveLength(1)
  expect((await w.describeWorkflow('Run a workflow script.')).description).toBe('Run a workflow script.')

  await w.command('dp', 'workflow-labels on')
  await w.workflow({ scriptPath: SAVED })
  expect(w.requests).toHaveLength(2)
  w.started('wf_test-3', 'wa3', 'review')
  await w.agentStep('wa3', { index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })
  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-sonnet-5-5 medium', 'wa2 claude-opus-5-5 xhigh', 'wa3 claude-opus-5-5 high'])
})

test('/dp off stands the fallback down too: nothing is asked when a Workflow starts or when its agents do, and every step goes out as the engine made it', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { disk: { [SAVED]: FROZEN }, backend: siteJev(() => ({ model: { opus: 0.9 } })) })
  await w.command('dp', 'off')
  await w.workflow({ scriptPath: SAVED })
  w.started('wf_test-1', 'wa1', 'first')
  w.transcript('wf_test-1', 'wa1', 'Find why the nightly import drops rows, and fix it.')
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })

  expect(w.requests).toHaveLength(0)
  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-sonnet-5-5 medium'])
  expect(w.status()).toBe('dp off')
})

test('a decision request that fails when the run starts leaves its agents as the script has them, and the status line says why', { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { disk: { [SAVED]: TIDY }, backend: () => ({ status: 500, body: 'Internal Server Error' }) })
  const result = await w.workflow({ scriptPath: SAVED })
  expect(result.isError).toBeUndefined()
  expect(w.status()).toBe('dp workflow not routed (given by path) | by label: not routed (jev: HTTP 500)')

  w.started('wf_test-1', 'wa1', 'rename')
  await w.agentStep('wa1', { index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })
  // Nothing more is asked as the agent starts.
  expect(w.requests).toHaveLength(1)
  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-opus-5-5 xhigh'])
})

test("an agent whose own decision fails goes out as the engine made it; the status line counts the routed and says why the others were not", { options: KEY }, async ($, on) => {
  const answer = siteJev(() => ({ model: { haiku: 0.9 } }))
  const w = runWorld($, on, { disk: { [SAVED]: FROZEN }, backend: (request, n) => (n === 1 ? { status: 500, body: 'Internal Server Error' } : answer(request)) })
  await w.workflow({ scriptPath: SAVED })
  for (const agentId of ['wa1', 'wa2']) {
    w.started('wf_test-1', agentId, 'first')
    w.transcript('wf_test-1', agentId, `List the files under src/${agentId} and report their sizes.`)
    await w.agentStep(agentId, { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  }

  // The agent sent to haiku goes out without the engine's effort: haiku takes none (spec #32).
  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-sonnet-5-5 medium', 'wa2 claude-haiku-4-5 undefined'])
  expect(w.status()).toBe('dp workflow not routed (given by path) | by label: routed 1 agent (1 not: jev: HTTP 500)')
})

test("an error of the feature's own when the run starts leaves the tool's result as it was, and the status line says to look in the debug log", { options: KEY }, async ($, on) => {
  // workflowWorld watches every state.set; this one refuses only the runs' record.
  on('state.set', { key: 'labelRuns' }, () => ({ deny: 'the state cannot be written' }))
  const w = runWorld($, on, { disk: { [SAVED]: TIDY }, backend: TIDY_DECIDED })
  const result = await w.workflow({ scriptPath: SAVED })

  expect(result.isError).toBeUndefined()
  expect(result.text).toContain('Workflow launched in background')
  expect(w.reached).toEqual([{ scriptPath: SAVED, launched: true }])
  expect(w.status()).toBe('dp workflow not routed (given by path) | by label: not routed (error: see the debug log)')
  expect(w.logs.some((log) => log.to === 'debug' && log.text.includes('the state cannot be written'))).toBe(true)
})

test("an error of the feature's own as an agent starts lets the step go out as the engine made it, and the status line says to look in the debug log", { options: KEY }, async ($, on) => {
  on('state.get', async (_$, e, next) => (e.key === 'labelRuns' ? { deny: 'the state cannot be read' } : next(e)))
  const w = runWorld($, on)
  w.started('wf_test-1', 'wa1', 'rename')
  await w.agentStep('wa1', { index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })

  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-opus-5-5 xhigh'])
  expect(w.status()).toBe('dp by label: not routed (error: see the debug log)')
  expect(w.logs.some((log) => log.to === 'debug' && log.text.includes('the state cannot be read'))).toBe(true)
})

test("each decision is logged with its reason, in the debug log and /dp log, never in the conversation: a call decided when its run starts, and an agent decided from its task as it starts", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, {
    disk: { [SAVED]: TIDY, '/work/.claude/workflow-scripts/frozen.js': FROZEN },
    backend: siteJev((i): SiteAnswer => (i === 0 ? { model: { sonnet: 0.9 }, effort: [0, 1, 0, 0, 0] } : { model: { opus: 0.9 }, effort: [0, 0, 1, 0, 0] })),
  })
  await w.workflow({ scriptPath: SAVED })
  await w.workflow({ scriptPath: '/work/.claude/workflow-scripts/frozen.js' })
  w.started('wf_test-2', 'wa1', 'first')
  w.transcript('wf_test-2', 'wa1', 'Find why the nightly import drops rows, and fix it.')
  await w.agentStep('wa1', { index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })

  const shown = await w.command('dp', 'log')
  expect(shown).toMatch(/workflow-labels: sonnet medium for "rename" \(workflow tidy-api\): decided; pick sonnet, confidence 1\.00; effort p low 0\.00, medium 1\.00/)
  expect(shown).toMatch(/workflow-labels: opus high for "review" \(workflow tidy-api\): decided; pick opus/)
  // (The tool's result names the workflow; this stub's does not, so it is `unnamed` here.)
  expect(shown).toMatch(/workflow-labels: sonnet medium for "first" \(agent wa1, workflow \S+\): from its task as it started; decided; pick sonnet/)
  const debug = w.logs.filter((log) => log.to === 'debug').map((log) => log.text)
  expect(debug.some((line) => line.startsWith('sonnet medium for "rename" (workflow tidy-api): decided'))).toBe(true)
  expect(w.logs.every((log) => log.to === 'debug')).toBe(true)
})

test("the main agent reads, after the tool's result, what each call's agents get as they start: the choice made for the call, or a decision from each agent's own task", { options: KEY }, async ($, on) => {
  const mixed = `export const meta = { name: 'mixed', description: 'Rename, then answer each question', phases: [] }
const edited = await agent('Rename getUser to fetchUser across src/api and run pnpm test api.', { label: 'rename' })
const found = await parallel(QUESTIONS.map((q) => () => agent(q.prompt, { label: q.label })))
return { edited, found }
`
  const w = runWorld($, on, { disk: { [SAVED]: mixed }, backend: TIDY_DECIDED })
  const told = ((await w.workflow({ scriptPath: SAVED })).context ?? []).join('\n')

  expect(told).toBe(
    [
      "Dispatch Pilot (the user's routing plugin) chose a model and an effort for the agent() calls of this Workflow. The script is unchanged: each agent gets its call's choice as it starts, found by its label.",
      '- "rename": sonnet medium (model: decided, confidence 1.00; effort: p 1.00)',
      '- agent() at line 3: decided as each of its agents starts, from its label and its task',
    ].join('\n'),
  )
})

test("the main agent is told that the agents of a script this cannot read are each decided as they start", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { disk: { [SAVED]: FROZEN }, backend: siteJev(() => ({ model: { opus: 0.9 } })) })
  const told = ((await w.workflow({ scriptPath: SAVED })).context ?? []).join('\n')
  expect(told).toBe("Dispatch Pilot (the user's routing plugin) could not read this script, so it decides each agent's model and effort as the agent starts, from its label and its task.")
})

test("two calls with the same label that were decided differently cannot be told apart: their agents are each decided from their own task as they start", { options: KEY }, async ($, on) => {
  const twice = `export const meta = { name: 'twice', description: 'Check twice', phases: [] }
const quick = await agent('List the TODO comments under src/ by file.', { label: 'check' })
const deep = await agent('Find the race between the cache refresh and the session writer in src/session, and fix it.', { label: 'check' })
return [quick, deep]
`
  const atLaunch = siteJev((i): SiteAnswer => (i === 0 ? { model: { haiku: 0.9 } } : { model: { opus: 0.9 }, effort: [0, 0, 0, 1, 0] }))
  const asStarts = siteJev((): SiteAnswer => ({ model: { opus: 0.9 }, effort: [0, 0, 0, 0, 1] }))
  const w = runWorld($, on, { disk: { [SAVED]: twice }, backend: (request, n) => (n === 1 ? atLaunch(request) : asStarts(request)) })
  await w.workflow({ scriptPath: SAVED })
  w.started('wf_test-1', 'wa1', 'check')
  w.transcript('wf_test-1', 'wa1', 'Find the race between the cache refresh and the session writer in src/session, and fix it.')
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })

  expect(w.requests).toHaveLength(2)
  expect(w.requests[1]?.body.state.brief_0.prompt).toBe('Find the race between the cache refresh and the session writer in src/session, and fix it.')
  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-opus-5-5 max'])
})

test("an agent the run's journal does not list (yet), or that started in no run this routes, goes out as the engine made it: nothing is asked, nothing is waited for", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { disk: { [SAVED]: TIDY }, backend: TIDY_DECIDED })
  await w.workflow({ scriptPath: SAVED })
  // The journal has only its first line: no agent has started in it.
  w.disk['/home/u/.claude/projects/p/s1/subagents/workflows/wf_test-1/journal.jsonl'] = '{"type":"launched"}\n'
  await w.agentStep('wa1', { index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })
  // An agent the main agent dispatched, in no Workflow run.
  await w.agentStep('a1', { index: 0, model: 'claude-sonnet-5-5', effort: 'low' })

  expect(w.requests).toHaveLength(1)
  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-opus-5-5 xhigh', 'a1 claude-sonnet-5-5 low'])
  expect(w.status()).toBe('dp workflow not routed (given by path)')
})

test("a resumed run keeps its script as sent, so the cache of each agent() still matches; its agents get their calls' choices as they start", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { disk: { [persisted('wf_test-1')]: TIDY }, backend: TIDY_DECIDED })
  await w.workflow({ script: TIDY, resumeFromRunId: 'wf_earlier' })
  expect(w.reached).toEqual([{ script: TIDY, resumeFromRunId: 'wf_earlier', launched: true }])

  w.started('wf_test-1', 'wa1', 'review')
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-opus-5-5 high'])
})

test("a step names the model by the id the API knows, never by its alias (the engine sends a step's model as written: `haiku` is a 404), and a step already on the decided family keeps its own", { options: { ...KEY, agentFable: true } }, async ($, on) => {
  const four = `export const meta = { name: 'four', description: 'One of each', phases: [] }
const a = await agent('List the files under src/ and report their sizes.', { label: 'h' })
const b = await agent('Rename getUser to fetchUser across src/api and run pnpm test api.', { label: 's' })
const c = await agent('Design the retry policy for the payment webhooks and write it up.', { label: 'o' })
const d = await agent('Prove the lease protocol in docs/lease.md safe under clock skew, or find the counterexample.', { label: 'f' })
return [a, b, c, d]
`
  const families = ['haiku', 'sonnet', 'opus', 'fable']
  const w = runWorld($, on, { disk: { [SAVED]: four }, backend: siteJev((i): SiteAnswer => ({ model: { [families[i] as string]: 1 }, effort: [0, 0, 1, 0, 0] })) })
  await w.workflow({ scriptPath: SAVED })
  for (const label of ['h', 's', 'o', 'f']) {
    w.started('wf_test-1', `w${label}`, label)
    // The engine's id for a sonnet after a fallback (seen on 2.1.289): a family, not one exact id.
    await w.agentStep(`w${label}`, { index: 0, model: 'claude-sonnet-5', effort: 'medium' })
  }

  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model}`)).toEqual(['wh claude-haiku-4-5', 'ws claude-sonnet-5', 'wo claude-opus-5-5', 'wf claude-fable-5-1'])
})

test('no answer within timeoutMs as an agent starts: it goes out as the engine made it, and the status line says why', { options: { ...KEY, timeoutMs: 800 } }, async ($, on) => {
  const answer = siteJev(() => ({ model: { opus: 0.9 } }))
  const w = runWorld($, on, { disk: { [SAVED]: FROZEN }, backend: (request) => ({ after: 2000, reply: answer(request) }) })
  await w.workflow({ scriptPath: SAVED })
  w.started('wf_test-1', 'wa1', 'first')
  w.transcript('wf_test-1', 'wa1', 'Find why the nightly import drops rows, and fix it.')

  const step = w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  await w.clock.settle()
  await w.clock.advance(800)
  await step
  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-sonnet-5-5 medium'])
  expect(w.status()).toBe('dp workflow not routed (given by path) | by label: not routed (jev: no answer in 800 ms)')
})

test("with Clef as the decision model, the request made as an agent starts passes Clef's input rules", { options: CLEF_OPTIONS }, async ($, on) => {
  const w = runWorld($, on, { disk: { [SAVED]: FROZEN }, backend: clefSiteJev(() => ({ model: { opus: 0.9 }, effort: [0, 0, 1, 0, 0] })) })
  await w.workflow({ scriptPath: SAVED })
  w.started('wf_test-1', 'wa1', 'first')
  w.transcript('wf_test-1', 'wa1', 'Find why the nightly import drops rows, and fix it.')
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })

  expect(w.requests).toHaveLength(1)
  expect(clefInputProblems(w.requests[0]?.body)).toEqual([])
  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-opus-5-5 high'])
})

test("an agent that already has a plan (one the main agent dispatched, or a first step the engine sends again after an error) keeps it: nothing is asked again", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { disk: { [SAVED]: FROZEN }, backend: siteJev(() => ({ model: { opus: 0.9 }, effort: [0, 0, 1, 0, 0] })) })
  await w.workflow({ scriptPath: SAVED })
  w.started('wf_test-1', 'wa1', 'first')
  w.transcript('wf_test-1', 'wa1', 'Find why the nightly import drops rows, and fix it.')
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  // The engine sends the first request again (a retry after an API error).
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })

  expect(w.requests).toHaveLength(1)
  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-opus-5-5 high', 'wa1 claude-opus-5-5 high'])
  expect(w.status()).toBe('dp workflow not routed (given by path) | by label: routed 1 agent')
})

test("an agent of a run this has no work in does not wait while workflow-agents is still deciding about another Workflow", { options: KEY }, async ($, on) => {
  const answer = siteJev((): SiteAnswer => ({ model: { sonnet: 0.9 }, effort: [0, 1, 0, 0, 0] }))
  const w = runWorld($, on, { backend: (request) => ({ after: 300, reply: answer(request) }) })
  // The first run's script is the main agent's own and readable: workflow-agents wrote it, there is nothing to do as its agents start.
  const first = w.workflow({ script: TIDY })
  await w.clock.settle()
  await w.clock.advance(300)
  await first

  // A second Workflow is sent; workflow-agents asks about it before the tool runs it.
  const second = w.workflow({ script: TIDY.replace('tidy-api', 'tidy-api-2') })
  await w.clock.settle()
  w.started('wf_test-1', 'wa1', 'rename')
  const step = w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  await w.clock.settle()
  // The first run's agent went out at once.
  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-sonnet-5-5 medium'])

  await w.clock.advance(300)
  await second
  await step
})

/** A saved workflow: a pipeline over files, each stage's label a template. */
const MIGRATE = `export const meta = { name: 'migrate-logger', description: 'Move each file to the new logger API', phases: [] }
const results = await pipeline(args, (file) => agent(\`Replace the old logger calls in \${file} with the new API; do not change behaviour.\`, { label: \`migrate:\${file}\` }), (done, file) => agent(\`Check \${file} still compiles: run tsc --noEmit and report errors only.\`, { label: \`check:\${file}\` }))
return results
`

test('a Workflow given by name is read from the copy the tool runs, and a template label finds its call for every agent the call starts', { options: KEY }, async ($, on) => {
  // The engine resolves the name and persists the script it runs (the result's scriptPath).
  const w = runWorld($, on, {
    disk: { [persisted('wf_test-1')]: MIGRATE },
    backend: siteJev((i): SiteAnswer => (i === 0 ? { model: { sonnet: 0.9 }, effort: [0, 1, 0, 0, 0] } : { model: { haiku: 0.9 }, effort: [1, 0, 0, 0, 0] })),
  })
  await w.workflow({ name: 'migrate-logger', args: ['src/a.ts', 'src/b.ts'] })
  expect(w.reached).toEqual([{ name: 'migrate-logger', launched: true }])
  // One decision per call, whatever its template fills in.
  expect(w.requests).toHaveLength(1)
  expect(w.requests[0]?.body.state.brief_0.label).toBe('migrate:${file}')

  for (const [agentId, label] of [['wa1', 'migrate:src/a.ts'], ['wa2', 'migrate:src/b.ts'], ['wa3', 'check:src/a.ts']] as const) {
    w.started('wf_test-1', agentId, label)
    await w.agentStep(agentId, { index: 0, model: 'claude-opus-5-5', effort: 'xhigh' })
  }

  // The check agent goes to haiku: without the engine's xhigh, which haiku does not take (spec #32).
  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual([
    'wa1 claude-sonnet-5-5 medium',
    'wa2 claude-sonnet-5-5 medium',
    'wa3 claude-haiku-4-5 undefined',
  ])
})

test("a call without a label is found by the start of its prompt, which is what the engine records for it (whitespace collapsed, 60 characters)", { options: KEY }, async ($, on) => {
  const audit = `export const meta = { name: 'audit', description: 'Audit two modules', phases: [] }
const a = await agent('List every exported function in src/auth/session.ts\\nand report their signatures only.')
const b = await agent(\`Review src/billing/\${args.file} for rounding errors in the invoice totals; explain each one.\`)
return [a, b]
`
  const w = runWorld($, on, {
    disk: { [SAVED]: audit },
    backend: siteJev((i): SiteAnswer => (i === 0 ? { model: { haiku: 0.9 } } : { model: { opus: 0.9 }, effort: [0, 0, 1, 0, 0] })),
  })
  await w.workflow({ scriptPath: SAVED, args: { file: 'invoice.ts' } })

  // As 2.1.289 recorded such agents: the prompt, its line break a space, cut at 60 characters.
  w.started('wf_test-1', 'wa1', 'List every exported function in src/auth/session.ts and repo')
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  w.started('wf_test-1', 'wa2', 'Review src/billing/invoice.ts for rounding errors in the inv')
  await w.agentStep('wa2', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })

  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-haiku-4-5 undefined', 'wa2 claude-opus-5-5 high'])
})

/** A script this feature cannot read: its meta is not an object literal. */
const FROZEN = `export const meta = Object.freeze({ name: 'frozen', description: 'Two reads' })
const a = await agent(TASKS.first, { label: 'first' })
return a
`

test("each agent of a script that cannot be read is decided when it starts, from the task in its transcript, as a workflow agent is", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, {
    disk: { [SAVED]: FROZEN },
    backend: siteJev(() => ({ model: { haiku: 0.05, sonnet: 0.15, opus: 0.8 }, effort: [0, 0, 0.2, 0.8, 0] })),
  })
  await w.workflow({ scriptPath: SAVED })
  // Nothing is asked when the run starts: no call can be read.
  expect(w.requests).toHaveLength(0)

  w.started('wf_test-1', 'wa1', 'first')
  w.transcript('wf_test-1', 'wa1', 'Find why the nightly import drops rows whose\ncurrency is missing, and fix it.')
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })

  expect(w.requests).toHaveLength(1)
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['agent-0.model', 'agent-0.effort'])
  expect(w.requests[0]?.body.state.brief_0).toEqual({ label: 'first', prompt: 'Find why the nightly import drops rows whose\ncurrency is missing, and fix it.' })
  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-opus-5-5 xhigh'])
})

test("an agent's transcript that relays the person's request before its task (as earlier engines write it) is decided from its task, not the relayed request", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { disk: { [SAVED]: FROZEN }, backend: siteJev(() => ({ model: { opus: 0.9 }, effort: [0, 0, 0, 1, 0] })) })
  await w.workflow({ scriptPath: SAVED })
  w.started('wf_test-1', 'wa1', 'first')
  w.transcript('wf_test-1', 'wa1', 'Find why the nightly import drops rows, and fix it.')
  const path = `${runDir('wf_test-1')}/agent-wa1.jsonl`
  const relayed = { type: 'user', message: { role: 'user', content: '[Workflow harness — user request] The harness relays, verbatim and indented below, the user request.\n  look at the importer' } }
  w.disk[path] = `${JSON.stringify(relayed)}\n${w.disk[path] ?? ''}`
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })

  expect(w.requests[0]?.body.state.brief_0.prompt).toBe('Find why the nightly import drops rows, and fix it.')
})

test("an agent's task is not on disk yet when its first step begins: the step waits for the engine to write it (50-110 ms on 2.1.289), then goes out decided", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { disk: { [SAVED]: FROZEN }, backend: siteJev(() => ({ model: { opus: 0.9 }, effort: [0, 0, 0, 1, 0] })) })
  await w.workflow({ scriptPath: SAVED })
  w.started('wf_test-1', 'wa1', 'first')

  const step = w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  await w.clock.settle()
  await w.clock.advance(50)
  // Nothing has gone out while the step waits.
  expect(w.steps).toHaveLength(0)
  w.transcript('wf_test-1', 'wa1', 'Find why the nightly import drops rows, and fix it.')
  await w.clock.advance(50)
  await step

  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-opus-5-5 xhigh'])
})

test("an agent whose task does not reach the disk within 400 ms goes out as the engine made it, with nothing asked, and the status line says why", { options: KEY }, async ($, on) => {
  const w = runWorld($, on, { disk: { [SAVED]: FROZEN }, backend: siteJev(() => ({ model: { opus: 0.9 } })) })
  await w.workflow({ scriptPath: SAVED })
  w.started('wf_test-1', 'wa1', 'first')

  const step = w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  await w.clock.settle()
  await w.clock.advance(500)
  await step

  expect(w.requests).toHaveLength(0)
  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-sonnet-5-5 medium'])
  expect(w.status()).toBe('dp workflow not routed (given by path) | by label: not routed (task not on disk in time)')
})

test("in a script the main agent sends, the calls workflow-agents left as written (their prompt is data) are decided as each agent starts; the agents of the calls it wrote into are left alone", { options: KEY }, async ($, on) => {
  const answers = `export const meta = { name: 'answers', description: 'Answer each question, then summarize', phases: [] }
const found = await parallel(QUESTIONS.map((q) => () => agent(q.prompt, { label: q.label })))
const summary = await agent('Summarize the three answers in five bullet points for the release notes.', { label: 'summary' })
return summary
`
  // Part agent-1 is the summary, asked about by workflow-agents when the script is sent; agent-0 is an agent asked about as it starts.
  const w = runWorld($, on, {
    backend: siteJev((i): SiteAnswer => (i === 1 ? { model: { haiku: 0.9 } } : { model: { opus: 0.9 }, effort: [0, 0, 0, 0.2, 0.8] })),
  })
  const result = await w.workflow({ script: answers })
  // workflow-agents wrote the summary's model into the script, and left the data-driven call as it was.
  expect(w.reached[0]?.script).toContain("{ label: 'summary', model: 'haiku' }")
  expect(w.requests).toHaveLength(1)
  // The main agent is told those agents are decided as they start.
  expect((result.context ?? []).join('\n')).toContain("Dispatch Pilot (the user's routing plugin) sets the model and effort of the agents of the agent() calls it leaves as written, as each one starts, from its label and its task.")

  w.started('wf_test-1', 'wa1', 'q-auth')
  w.transcript('wf_test-1', 'wa1', 'Is every route under src/api/admin checked for the admin role? Cite the file and line of each gap.')
  await w.agentStep('wa1', { index: 0, model: 'claude-sonnet-5-5', effort: 'medium' })
  w.started('wf_test-1', 'wa2', 'summary')
  await w.agentStep('wa2', { index: 0, model: 'claude-haiku-4-5', effort: null })

  expect(w.requests).toHaveLength(2)
  expect(w.requests[1]?.body.state.brief_0).toEqual({
    workflow_description: 'Answer each question, then summarize',
    label: 'q-auth',
    prompt: 'Is every route under src/api/admin checked for the admin role? Cite the file and line of each gap.',
  })
  expect(w.steps.map((s) => `${String(s.agentId)} ${s.model} ${String(s.effort)}`)).toEqual(['wa1 claude-opus-5-5 max', 'wa2 claude-haiku-4-5 undefined'])
})
