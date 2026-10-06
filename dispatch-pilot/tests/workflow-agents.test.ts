// Workflow agents (#8): when the main agent submits a Workflow, each `agent()`
// of its script gets its own decision on model and effort, written into the
// script before the tool runs it. Seam 1: the Workflow tool call in; out, the
// script that reaches the tool, the decision requests, what the main agent is
// told, the board (`w.board()`), the decision log, `$.state`.

import { expect, test } from 'claude-code/testing'
import { estimateTokens } from '../hooks/decision/context.ts'
import { CLEF_OPTIONS, CLEF_URL, clefInputProblems } from './support/cloudflare.ts'
import type { Reply } from './support/world.ts'
import { clefSiteJev, siteJev, workflowWorld, type SiteAnswer } from './support/workflow.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }

/** Two agents in sequence, each with a label. */
const TIDY = `export const meta = { name: 'tidy-api', description: 'Rename getUser to fetchUser in src/api, then review the diff', phases: [{ title: 'Edit', detail: 'rename and test' }, { title: 'Review', detail: 'check the diff' }] }
phase('Edit')
const edited = await agent('Rename getUser to fetchUser across src/api and run pnpm test api.', { label: 'rename' })
phase('Review')
const review = await agent('Review the diff of src/policies/document.ts for permission regressions and report the risky edge cases.', { label: 'review', schema: { type: 'object', properties: { risky: { type: 'array' } } } })
return { edited, review }
`

test('each agent() of a submitted script is written with the model and effort decided for it, and the main agent is told what was written', { options: KEY }, async ($, on) => {
  // The rename is ordinary work; the review of permission code is not.
  const w = workflowWorld($, on, {
    backend: siteJev((i) =>
      i === 0
        ? { model: { haiku: 0.1, sonnet: 0.8, opus: 0.1 }, effort: [0.1, 0.8, 0.1, 0, 0] }
        : { model: { haiku: 0.02, sonnet: 0.08, opus: 0.9 }, effort: [0, 0, 0.1, 0.8, 0.1] },
    ),
  })
  const result = await w.workflow({ script: TIDY })

  // The tool ran the script with each call's model and effort written in, and nothing else changed.
  expect(w.reached.map((r) => r.script)).toEqual([
    TIDY.replace("{ label: 'rename' }", "{ label: 'rename', model: 'sonnet', effort: 'medium' }").replace("properties: { risky: { type: 'array' } } } }", "properties: { risky: { type: 'array' } } }, model: 'opus', effort: 'xhigh' }"),
  ])
  // One request asked about both agents, each in its own part, each brief in its own state field.
  expect(w.requests).toHaveLength(1)
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['agent-0.model', 'agent-0.effort', 'agent-1.model', 'agent-1.effort'])
  expect(w.requests[0]?.body.state.brief_0).toEqual({
    workflow_description: 'Rename getUser to fetchUser in src/api, then review the diff',
    label: 'rename',
    prompt: 'Rename getUser to fetchUser across src/api and run pnpm test api.',
  })
  expect(w.requests[0]?.body.state.brief_1.label).toBe('review')
  // The main agent reads what was written, per agent.
  const told = (result.context ?? []).join('\n')
  expect(told).toContain('"rename": sonnet medium (model: decided, confidence 0.70; effort: p 0.80)')
  expect(told).toContain('"review": opus xhigh (model: decided, confidence 0.85; effort: p 0.80)')

  // The board has one node for each agent, before any of them starts: its label, and the log entry it came from, with the model and effort decided.
  const board = await w.board()
  expect(board.agents.map((node) => [node.kind, node.name, node.state, node.routed])).toEqual([
    ['wf', 'rename', 'queued', true],
    ['wf', 'review', 'queued', true],
  ])
  expect(board.log.map((entry) => [entry.model, entry.effort])).toEqual([
    ['sonnet', 'medium'],
    ['opus', 'xhigh'],
  ])
  expect(board.agents.map((node) => node.workflow?.name)).toEqual(['tidy-api', 'tidy-api'])
  expect(new Set(board.agents.map((node) => node.workflow?.id)).size).toBe(1)
  expect(new Set(board.agents.map((node) => node.id)).size).toBe(2)
  expect(board.agents.map((node) => board.log.find((entry) => entry.n === node.decision)?.subject)).toEqual(['"rename" (workflow tidy-api)', '"review" (workflow tidy-api)'])
  expect(board.log.map((entry) => [entry.feature, entry.agent === board.agents[0]?.id || entry.agent === board.agents[1]?.id, entry.tone])).toEqual([
    ['workflow-agents', true, 'ok'],
    ['workflow-agents', true, 'ok'],
  ])
  expect(board.log[1]).toMatchObject({ outcome: 'opus xhigh' })
  expect(Math.round((board.log[1]?.conf ?? 0) * 100) / 100).toBe(0.85)
  expect(board.log[1]?.trace?.map((step) => step.rule)).toEqual(['top', 'max-gate', 'round-up', 'model-floor'])
})

test('an agent sent to haiku gets no effort: the one the script wrote is taken out, whatever the effort answer says', { options: KEY }, async ($, on) => {
  const scan = `export const meta = { name: 'scan', description: 'List the files that import legacyAuth', phases: [] }
const files = await agent('List every file under src/ that imports legacyAuth. Report file:line only.', { label: 'scan', effort: 'high' })
return files
`
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { haiku: 0.9, sonnet: 0.08, opus: 0.02 }, effort: [0, 0, 0, 1, 0] })) })
  const result = await w.workflow({ script: scan })

  expect(w.reached.map((r) => r.script)).toEqual([scan.replace("{ label: 'scan', effort: 'high' }", "{ label: 'scan', model: 'haiku' }")])
  expect((result.context ?? []).join('\n')).toContain('"scan": haiku (model: decided, confidence 0.85; haiku takes no effort)')
})

test("the model the script wrote reaches the decision model as a hint, and stands unless it is sure of another one (agentOverride, default 0.6)", { options: KEY }, async ($, on) => {
  const triage = `export const meta = { name: 'triage', description: 'Triage the failing checks', phases: [] }
const failing = await agent('Run \`pnpm test\` and list the failing tests by package. Do not fix anything.', { model: 'opus', label: 'list' })
const lint = await agent('Run \`pnpm lint\` and list the warnings by file. Do not fix anything.', { label: 'lint', model: 'claude-opus-5-5' })
return { failing, lint }
`
  // Of three options, p 0.9 is confidence 0.85, p 0.5 is 0.25.
  const w = workflowWorld($, on, {
    backend: siteJev((i) => (i === 0 ? { model: { haiku: 0.9, sonnet: 0.05, opus: 0.05 } } : { model: { haiku: 0.5, sonnet: 0.3, opus: 0.2 }, effort: [0, 1, 0, 0, 0] })),
  })
  await w.workflow({ script: triage })

  expect(w.requests[0]?.body.questions['agent-0.model'].instructions.requested).toContain('opus')
  expect(w.reached.map((r) => r.script)).toEqual([
    triage.replace("{ model: 'opus', label: 'list' }", "{ model: 'haiku', label: 'list' }").replace("model: 'claude-opus-5-5' }", "model: 'claude-opus-5-5', effort: 'medium' }"),
  ])
})

test("a model the script chooses when it runs is left alone, and the call still gets its effort", { options: KEY }, async ($, on) => {
  const todos = `export const meta = { name: 'todos', description: 'Summarize the open TODOs', phases: [] }
const owners = await agent('Summarize the open TODO comments under src/ by owner.', { model: pickModel(), label: 'todos' })
return owners
`
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { haiku: 0.1, sonnet: 0.8, opus: 0.1 }, effort: [0.1, 0.8, 0.1, 0, 0] })) })
  await w.workflow({ script: todos })

  expect(w.reached.map((r) => r.script)).toEqual([todos.replace("label: 'todos' }", "label: 'todos', effort: 'medium' }")])
})

test('a call site that runs many times is decided once: a pipeline over files has one decision per stage, whatever the label and prompt interpolate', { options: KEY }, async ($, on) => {
  const migrate = `export const meta = { name: 'migrate', description: 'Move each file to the new logger API', phases: [] }
const results = await pipeline(args, (file) => agent(\`Replace the old logger calls in \${file} with the new API; do not change behaviour.\`, { label: \`migrate:\${file}\` }), (done, file) => agent(\`Check \${file} still compiles: run tsc --noEmit and report errors only.\`, { label: \`check:\${file}\` }))
return results
`
  const w = workflowWorld($, on, { backend: siteJev((i): SiteAnswer => (i === 0 ? { model: { sonnet: 0.9 }, effort: [0, 1, 0, 0, 0] } : { model: { haiku: 0.9 }, effort: [1, 0, 0, 0, 0] })) })
  await w.workflow({ script: migrate, args: ['a.ts', 'b.ts', 'c.ts'] })

  expect(w.requests).toHaveLength(1)
  expect(w.requests[0]?.body.state.brief_0.label).toBe('migrate:${file}')
  expect(w.requests[0]?.body.state.brief_0.prompt).toBe('Replace the old logger calls in ${file} with the new API; do not change behaviour.')
  expect(w.reached.map((r) => r.script)).toEqual([
    migrate.replace('{ label: `migrate:${file}` }', "{ label: `migrate:${file}`, model: 'sonnet', effort: 'medium' }").replace('{ label: `check:${file}` }', "{ label: `check:${file}`, model: 'haiku' }"),
  ])
})

test("a call whose prompt the script builds when it runs is left as written, the others are still routed, and the main agent is told which", { options: KEY }, async ($, on) => {
  const mixed = `export const meta = { name: 'mixed', description: 'Two reads', phases: [] }
const a = await agent(buildPrompt(item))
const b = await agent('Read src/index.ts and list the names it exports.', { label: 'static' })
return [a, b]
`
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { haiku: 0.9, sonnet: 0.05, opus: 0.05 } })) })
  const result = await w.workflow({ script: mixed })

  // Only the readable call was asked about; its ids keep its place in the script.
  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['agent-1.model', 'agent-1.effort'])
  expect(w.reached.map((r) => r.script)).toEqual([mixed.replace("{ label: 'static' }", "{ label: 'static', model: 'haiku' }")])
  expect((result.context ?? []).join('\n')).toMatch(/agent\(\) at line 2: left as written \(its prompt is built when the script runs\)/)
  // The call left as written is on the board too, with why.
  expect((await w.board()).agents.map((node) => [node.name, node.routed, node.why, node.decision === undefined])).toEqual([
    ['agent() at line 2', false, 'its prompt is built when the script runs', true],
    ['static', true, undefined, false],
  ])
})

test("a template that is only what ${...} fills in says nothing of the work, so its call is left as written; one with words of its own beside the placeholders is asked about", { options: KEY }, async ($, on) => {
  // The shapes real main agents write: a shared context, then the task in a table row or in words of its own.
  const shared = `export const meta = { name: 'review', description: 'Review each lens, then verify', phases: [] }
const CONTEXT = 'Repository rules: ...'
const finds = await parallel(LENSES.map((l) => () => agent(\`\${CONTEXT}\\n\\n\${l.prompt}\`, { label: \`review:\${l.key}\` })))
const verdict = await agent(\`\${CONTEXT}\\n\\nYou are the adversarial verifier. For each finding below, try to refute it and report only what survives.\\n\${JSON.stringify(finds)}\`, { label: 'verify:all' })
return verdict
`
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { sonnet: 1 } })) })
  const result = await w.workflow({ script: shared })

  expect(Object.keys(w.requests[0]?.body.questions)).toEqual(['agent-1.model', 'agent-1.effort'])
  expect(w.reached.map((r) => r.script)).toEqual([shared.replace("{ label: 'verify:all' }", "{ label: 'verify:all', model: 'sonnet', effort: 'high' }")])
  expect((result.context ?? []).join('\n')).toContain('"review:${l.key}": left as written (its prompt is built when the script runs)')
  expect((await w.board()).agents.map((node) => [node.name, node.routed, node.why])).toEqual([
    ['review:${l.key}', false, 'its prompt is built when the script runs'],
    ['verify:all', true, undefined],
  ])
})

test("a short prompt with nothing to fill in is the whole task: it is asked about like any other", { options: KEY }, async ($, on) => {
  const ping = `export const meta = { name: 'ping', description: 'Ping', phases: [] }
const pong = await agent('Reply: pong.', { label: 'ping' })
return pong
`
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { haiku: 1 } })) })
  await w.workflow({ script: ping })

  expect(w.requests).toHaveLength(1)
  expect(w.reached.map((r) => r.script)).toEqual([ping.replace("{ label: 'ping' }", "{ label: 'ping', model: 'haiku' }")])
})

test("a script whose agents all take their prompts from data (a table mapped over) is left as written, nothing is asked, and the main agent is told why", { options: KEY }, async ($, on) => {
  const table = `export const meta = { name: 'table', description: 'Answer each question', phases: [] }
const QUESTIONS = [{ label: 'a', prompt: 'Reply with pong.' }, { label: 'b', prompt: 'Explain what an index is.' }]
const answers = await parallel(QUESTIONS.map((q) => () => agent(q.prompt, { label: q.label })))
return answers
`
  const w = workflowWorld($, on, { backend: siteJev(BOTH_ROUTED) })
  const result = await w.workflow({ script: table })

  expect(w.requests).toHaveLength(0)
  expect(w.reached.map((r) => r.script)).toEqual([table])
  expect((result.context ?? []).join('\n')).toMatch(/agent\(\) at line 3: left as written \(its prompt is built when the script runs\)/)
  expect((await w.board()).agents.map((node) => [node.name, node.routed, node.why])).toEqual([
    ['agent() at line 3', false, 'its prompt is built when the script runs'],
  ])
  expect((await w.board()).log).toEqual([])
})

test("a Workflow given by scriptPath or by name, or resumed from an earlier run, goes through as it is, and nothing is asked", { options: KEY }, async ($, on) => {
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { haiku: 1 } })) })
  await w.workflow({ scriptPath: '/home/u/.claude/projects/p/s1/workflows/scripts/tidy-wf_old.js' })
  await w.workflow({ name: 'review-changes', args: { base: 'main' } })
  await w.workflow({ script: TIDY, resumeFromRunId: 'wf_old' })

  // The board keeps each one, with why, as a node of its own: no agent of theirs is known yet.
  expect((await w.board()).agents.map((node) => [node.kind, node.type, node.name, node.routed, node.why])).toEqual([
    ['wf', 'workflow', 'tidy-wf_old', false, 'given by path'],
    ['wf', 'workflow', 'review-changes', false, 'given by name'],
    ['wf', 'workflow', 'tidy-api', false, 'resumed from an earlier run'],
  ])
  expect(w.requests).toHaveLength(0)
  expect(w.reached).toEqual([
    { scriptPath: '/home/u/.claude/projects/p/s1/workflows/scripts/tidy-wf_old.js', launched: true },
    { name: 'review-changes', launched: true },
    { script: TIDY, resumeFromRunId: 'wf_old', launched: true },
  ])
})

test("a model the person names for the work in this turn's message wins over the decision model and the script", { options: KEY }, async ($, on) => {
  const checks = `export const meta = { name: 'checks', description: 'Run the three checks', phases: [] }
const unit = await agent('Run the unit tests and list the failures.', { label: 'unit', model: 'sonnet' })
return unit
`
  // The decision model would send it to opus; the person's words ask for haiku.
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { haiku: 0.02, sonnet: 0.03, opus: 0.95 }, nouls: { 'named.haiku': 0.93 } })) })
  await w.submit('把这几个检查都用 haiku 跑，省点额度')
  await w.workflow({ script: checks })

  const sent = w.requests[1]?.body
  expect(sent?.state.user_message).toBe('把这几个检查都用 haiku 跑，省点额度')
  expect(Object.keys(sent?.questions)).toEqual(['agent-0.model', 'agent-0.effort', 'agent-0.named.haiku', 'agent-0.banned.haiku'])
  expect(w.reached.map((r) => r.script)).toEqual([checks.replace("model: 'sonnet' }", "model: 'haiku' }")])
})

test("an effort the person asks for is written into the agent() calls it covers, over the script's own (a level it wrote or works out when it runs) and the decided one; the call it does not cover keeps its decided effort", { options: KEY }, async ($, on) => {
  const scope = `export const meta = { name: 'scope', description: 'Rename, review, then scan', phases: [] }
const a = await agent('Rename getUser to fetchUser across src/api and run pnpm test api.', { label: 'rename', effort: 'low' })
const b = await agent('Review the diff of src/policies/document.ts for permission regressions and report the risky edge cases.', { label: 'review', effort: levelFor(item) })
const c = await agent('Review the diff of src/billing/invoice.ts for rounding errors and report the risky edge cases.', { label: 'billing' })
return [a, b, c]
`
  // The person asked for high on the first two steps (the words say which); the decision model reads that into calls 0 and 1.
  const w = workflowWorld($, on, {
    backend: siteJev((i) => ({
      model: { haiku: 0.02, sonnet: i === 0 ? 0.9 : 0.08, opus: i === 0 ? 0.08 : 0.9 },
      effort: [0, 0, 0.1, 0.8, 0.1],
      namedEffort: i < 2 ? { none: 0.02, high: 0.97 } : { none: 0.95, high: 0.05 },
    })),
  })
  await w.submit('改名和第一个审查都把 effort 开到 high，最后那个按你的判断来')
  const result = await w.workflow({ script: scope })

  expect(Object.keys(w.requests[1]?.body.questions)).toContain('agent-1.named_effort')
  expect(w.reached.map((r) => r.script)).toEqual([
    scope
      .replace("effort: 'low' }", "effort: 'high', model: 'sonnet' }")
      .replace('effort: levelFor(item) }', "effort: 'high', model: 'opus' }")
      .replace("{ label: 'billing' }", "{ label: 'billing', model: 'opus', effort: 'xhigh' }"),
  ])
  const told = (result.context ?? []).join('\n')
  expect(told).toContain('"rename": sonnet high (model: decided, confidence 0.85; effort: you asked for it)')
  expect(told).toContain('"billing": opus xhigh (model: decided, confidence 0.85; effort: p 0.80)')
})

test('a call that goes to haiku takes no effort even when the person asked for one: the script is not given it, and the main agent is told why', { options: KEY }, async ($, on) => {
  const scan = `export const meta = { name: 'scan', description: 'List the files that import legacyAuth', phases: [] }
const files = await agent('List every file under src/ that imports legacyAuth. Report file:line only.', { label: 'scan', effort: 'low' })
return files
`
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { haiku: 0.9, sonnet: 0.08, opus: 0.02 }, effort: [1, 0, 0, 0, 0], namedEffort: { none: 0, xhigh: 1 } })) })
  await w.submit('所有 agent 的 effort 都用 xhigh')
  const result = await w.workflow({ script: scan })

  expect(w.reached.map((r) => r.script)).toEqual([scan.replace("{ label: 'scan', effort: 'low' }", "{ label: 'scan', model: 'haiku' }")])
  expect((result.context ?? []).join('\n')).toContain('"scan": haiku (model: decided, confidence 0.85; haiku takes no effort, so the xhigh you asked for is not set)')
  expect(w.logs.map((log) => log.text)).toContainEqual(expect.stringMatching(/effort xhigh asked for in your message, not set: haiku takes no effort/))
})

test("a model the person rules out is never written into a call, even when the answer puts all its probability on it: the nearest model left is", { options: KEY }, async ($, on) => {
  const checks = `export const meta = { name: 'checks', description: 'Evaluate the queue migration', phases: [] }
const verdict = await agent('Evaluate whether it is worth moving the message queue from RabbitMQ to Kafka; compare three options and give the cost and risks.', { label: 'evaluate', model: 'opus' })
return verdict
`
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { opus: 1 }, effort: [0, 0, 0, 1, 0], nouls: { 'banned.opus': 0.93 } })) })
  await w.submit('这周额度快用完了，别用 opus')
  await w.workflow({ script: checks })

  expect(w.reached.map((r) => r.script)).toEqual([checks.replace("model: 'opus' }", "model: 'sonnet', effort: 'xhigh' }")])
})

test("in return mode the first submission is refused with each agent's recommendation, worded as the instruction it is; the same Workflow submitted again runs as written, and asks nothing",{ options: { ...KEY, workflowMode: 'return' } }, async ($, on) => {
  const w = workflowWorld($, on, {
    backend: siteJev((i) =>
      i === 0
        ? { model: { haiku: 0.1, sonnet: 0.8, opus: 0.1 }, effort: [0.1, 0.8, 0.1, 0, 0] }
        : { model: { haiku: 0.02, sonnet: 0.08, opus: 0.9 }, effort: [0, 0, 0.1, 0.8, 0.1] },
    ),
  })
  const first = await w.workflow({ script: TIDY })

  // Nothing started; the main agent reads what to do, and that the plugin asks it.
  expect(w.reached).toEqual([])
  expect(first.deny).toMatch(/Dispatch Pilot/)
  expect(first.deny).toMatch(/did not start this Workflow/)
  expect(first.deny).toMatch(/"rename": model: 'sonnet', effort: 'medium'/)
  expect(first.deny).toMatch(/"review": model: 'opus', effort: 'xhigh'/)
  expect(first.deny).toMatch(/submit the same script again/i)
  expect(first.deny).toMatch(/plugin's policy.*the user set/i)
  // The decisions are on the board as the recommendations they are: the agents have not started.
  const sent = await w.board()
  expect(sent.agents.map((node) => [node.name, node.state, node.routed])).toEqual([
    ['rename', 'queued', true],
    ['review', 'queued', true],
  ])
  expect(sent.log.map((entry) => [entry.model, entry.effort])).toEqual([
    ['sonnet', 'medium'],
    ['opus', 'xhigh'],
  ])
  expect(sent.log.map((entry) => entry.outcome)).toEqual(['sonnet medium (sent back)', 'opus xhigh (sent back)'])

  // The main agent writes the options in, as told: the prompts are the ones it sent.
  const written = TIDY.replace("{ label: 'rename' }", "{ label: 'rename', model: 'sonnet', effort: 'medium' }")
  const second = await w.workflow({ script: written })
  expect(second.deny).toBeUndefined()
  expect(w.reached.map((r) => r.script)).toEqual([written])
  // The same script again, as it was first sent, also runs as written: a Workflow is sent back once.
  await w.workflow({ script: TIDY })
  expect(w.reached.map((r) => r.script)).toEqual([written, TIDY])
  expect(w.requests).toHaveLength(1)
})

test('in return mode a different Workflow is sent back on its own first submission', { options: { ...KEY, workflowMode: 'return' } }, async ($, on) => {
  const other = `export const meta = { name: 'other', description: 'Something else', phases: [] }
const a = await agent('Read docs/architecture.md and summarize the module boundaries.', { label: 'summary' })
return a
`
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { haiku: 0.1, sonnet: 0.8, opus: 0.1 } })) })
  expect((await w.workflow({ script: TIDY })).deny).toBeDefined()
  expect((await w.workflow({ script: other })).deny).toBeDefined()
  expect((await w.workflow({ script: other })).deny).toBeUndefined()
  expect((await w.workflow({ script: TIDY })).deny).toBeUndefined()
  expect(w.requests).toHaveLength(2)
})

test('in return mode a Workflow whose agents need nothing written is not sent back', { options: { ...KEY, workflowMode: 'return' } }, async ($, on) => {
  const kept = `export const meta = { name: 'kept', description: 'Already as it should be', phases: [] }
const a = await agent('Read docs/architecture.md and summarize the module boundaries.', { label: 'summary', model: 'haiku' })
return a
`
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { haiku: 0.9, sonnet: 0.05, opus: 0.05 } })) })
  expect((await w.workflow({ script: kept })).deny).toBeUndefined()
  expect(w.reached.map((r) => r.script)).toEqual([kept])
})

test('in return mode a Workflow is not sent back when the decision model did not answer: it runs as written', { options: { ...KEY, workflowMode: 'return' } }, async ($, on) => {
  const w = workflowWorld($, on, { backend: () => ({ status: 500, body: 'Internal Server Error' }) })
  expect((await w.workflow({ script: TIDY })).deny).toBeUndefined()
  expect(w.reached.map((r) => r.script)).toEqual([TIDY])
  expect((await w.board()).agents.map((node) => [node.name, node.routed, node.why])).toEqual([
    ['rename', false, 'jev: HTTP 500'],
    ['review', false, 'jev: HTTP 500'],
  ])
})

/** A script with `count` agent() calls in one parallel(), each its own call site. */
function manyAgents(count: number, prompt: (i: number) => string = (i) => `Check package ${i}: run its unit tests and list the failures by file.`): string {
  const calls = Array.from({ length: count }, (_, i) => `  () => agent(${JSON.stringify(prompt(i))}, { label: 'pkg-${i}' }),`)
  return `export const meta = { name: 'many', description: 'Check every package', phases: [] }\nconst results = await parallel([\n${calls.join('\n')}\n])\nreturn results\n`
}

/** How many tokens the text in a request's state takes. */
function stateTokens(state: Record<string, unknown>): number {
  return Object.values(state).reduce((sum: number, value) => sum + (typeof value === 'string' ? estimateTokens(value) : estimateTokens(Object.values(value as Record<string, string>).join(' '))), 0)
}

test('a script with many agent() calls is asked about in several requests sent together, each call once under its own place in the script', { options: KEY }, async ($, on) => {
  const w = workflowWorld($, on, { backend: (request) => ({ after: 1000, reply: siteJev(() => ({ model: { sonnet: 1 } }))(request) }) })
  const running = w.workflow({ script: manyAgents(20) })
  await w.clock.settle()
  // Every request is out before any answer is in.
  expect(w.requests).toHaveLength(3)
  await w.clock.advance(1000)
  await running

  const ids = w.requests.map((request) => Object.keys(request.body.questions))
  expect(ids.map((list) => list.length)).toEqual([16, 16, 8])
  expect(ids.flat().sort()).toEqual(Array.from({ length: 20 }, (_, i) => [`agent-${i}.effort`, `agent-${i}.model`]).flat().sort())
  expect((w.reached[0]?.script ?? '').match(/\{ label: 'pkg-\d+', model: 'sonnet', effort: 'high' \}/g)).toHaveLength(20)
  // Every one of the 20 has its own node and its own entry in the log.
  const board = await w.board()
  expect(board.agents).toHaveLength(20)
  expect(board.agents.every((node) => node.routed)).toBe(true)
  expect(board.log).toHaveLength(20)
  expect(board.log.every((entry) => entry.model === 'sonnet' && entry.effort === 'high')).toBe(true)
  expect(new Set(board.agents.map((node) => node.decision)).size).toBe(20)
})

test("a request holds at most 64 questions: the models the person's words mention add questions to each call, so fewer calls share a request", { options: KEY }, async ($, on) => {
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { sonnet: 1 } })) })
  // Four models mentioned: a yes/no question each for "named" and for "banned" beside the model and the effort, ten per call.
  await w.submit('这周额度紧张：别用 opus 和 fable，haiku 和 sonnet 看着用')
  await w.workflow({ script: manyAgents(12) })

  expect(w.requests.slice(1).map((request) => Object.keys(request.body.questions).length)).toEqual([60, 60])
  expect((await w.board()).agents.filter((node) => node.routed)).toHaveLength(12)
})

test("with Clef as the decision model, every request about a script's agents passes Clef's input rules", { options: CLEF_OPTIONS }, async ($, on) => {
  const w = workflowWorld($, on, { backend: clefSiteJev(() => ({ model: { sonnet: 1 } })) })
  await w.submit('别用 opus 了，haiku 和 sonnet 看着用')
  await w.workflow({ script: manyAgents(14) })

  expect(w.requests.length).toBeGreaterThan(2)
  expect(w.requests.flatMap((request) => clefInputProblems(request.body))).toEqual([])
  expect(w.requests.every((request) => request.url === CLEF_URL)).toBe(true)
  expect((await w.board()).agents.filter((node) => node.routed)).toHaveLength(14)
})

test('the agents beyond the first 24 are left as written, and the main agent is told', { options: KEY }, async ($, on) => {
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { sonnet: 1 } })) })
  const result = await w.workflow({ script: manyAgents(30) })

  expect(w.requests).toHaveLength(3)
  const script = w.reached[0]?.script ?? ''
  expect(script.match(/model: 'sonnet'/g)).toHaveLength(24)
  expect(script).toContain("{ label: 'pkg-24' }")
  expect((result.context ?? []).join('\n')).toMatch(/"pkg-24": left as written \(the script has more agent\(\) calls than are asked about\)/)
  const board = await w.board()
  expect(board.agents.filter((node) => node.routed)).toHaveLength(24)
  expect(board.agents.filter((node) => !node.routed).map((node) => node.why)).toEqual(Array(6).fill('the script has more agent() calls than are asked about'))
})

test("a request that fails leaves only its own calls as written: the others are routed, and the board says why", { options: KEY }, async ($, on) => {
  const w = workflowWorld($, on, { backend: (request, n) => (n === 2 ? { status: 500, body: 'Internal Server Error' } : siteJev(() => ({ model: { sonnet: 1 } }))(request)) })
  await w.workflow({ script: manyAgents(20) })

  const script = w.reached[0]?.script ?? ''
  expect(script.match(/model: 'sonnet'/g)).toHaveLength(12)
  expect(script).toContain("{ label: 'pkg-8' }")
  expect(script).toContain("model: 'sonnet', effort: 'high' }")
  const board = await w.board()
  expect(board.agents.filter((node) => node.routed)).toHaveLength(12)
  expect(board.agents.filter((node) => !node.routed).map((node) => node.why)).toEqual(Array(8).fill('jev: HTTP 500'))
  expect(board.agents.find((node) => !node.routed)?.failure).toMatchObject({ backend: 'jev', kind: 'http', status: 500 })
  // Only the calls decided are in the log.
  expect(board.log).toHaveLength(12)
})

test("the state of each request stays within the context budget: long prompts are cut, and fewer calls share a request", { options: { ...KEY, contextTokens: 900 } }, async ($, on) => {
  const long = (i: number) => `Package ${i}: ${'read every test file and describe what it covers, with the edge cases. '.repeat(120)}Report as a table.`
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { sonnet: 1 } })) })
  await w.workflow({ script: manyAgents(4, long) })

  expect(w.requests).toHaveLength(2)
  expect(w.requests.map((request) => stateTokens(request.body.state))).toEqual([expect.any(Number), expect.any(Number)])
  for (const request of w.requests) expect(stateTokens(request.body.state)).toBeLessThanOrEqual(900)
  // The end of a prompt is kept with its start.
  expect(w.requests[0]?.body.state.brief_0.prompt.endsWith('Report as a table.')).toBe(true)
})

const BOTH_ROUTED = (i: number) => (i === 0 ? { model: { haiku: 0.1, sonnet: 0.8, opus: 0.1 } } : { model: { haiku: 0.02, sonnet: 0.08, opus: 0.9 } })

test("a rewritten script the tool cannot parse is started as the main agent wrote it, once, and the main agent is told", { options: KEY }, async ($, on) => {
  // The tool parses the script before anything starts, and says so at once (measured on 2.1.289).
  const w = workflowWorld($, on, { backend: siteJev(BOTH_ROUTED), parseError: (script) => (script.includes("model: 'sonnet'") ? 'Script parse error: Unexpected token (3:12)' : undefined) })
  const result = await w.workflow({ script: TIDY })

  expect(w.reached.map((r) => [r.launched, r.script === TIDY])).toEqual([
    [false, false],
    [true, true],
  ])
  expect(result.isError).toBeUndefined()
  expect((result.context ?? []).join('\n')).toMatch(/could not use.*started it as you wrote it/s)
  // What was decided did not take effect: the board says the Workflow ran as written, and nothing was logged as decided.
  expect((await w.board()).agents.map((node) => [node.kind, node.routed, node.why])).toEqual([['wf', false, 'the rewritten script did not parse']])
  expect((await w.board()).log).toEqual([])
})

test("a script the tool refuses for a reason that is not the rewrite's goes back to the main agent as the tool said it, with no second try", { options: KEY }, async ($, on) => {
  const w = workflowWorld($, on, { backend: siteJev(BOTH_ROUTED), fails: () => 'Workflow needs permission to run' })
  const result = await w.workflow({ script: TIDY })

  expect(w.reached).toHaveLength(1)
  expect(result.isError).toBe(true)
  expect(result.text).toContain('Workflow needs permission to run')
})

test("an error in the mod itself lets the script through as the main agent wrote it, and the board says to look in the debug log", { options: KEY }, async ($, on) => {
  on('state.get', async (_$, e, next) => (e.key === 'said' ? { deny: 'the state cannot be read' } : next(e)))
  const w = workflowWorld($, on, { backend: siteJev(BOTH_ROUTED) })
  const result = await w.workflow({ script: TIDY })

  expect(result.deny).toBeUndefined()
  expect(w.reached.map((r) => r.script)).toEqual([TIDY])
  expect((await w.board()).agents.map((node) => [node.kind, node.routed, node.why])).toEqual([['wf', false, 'error: see the debug log']])
  expect(w.logs.some((log) => log.to === 'debug' && log.text.includes('the state cannot be read'))).toBe(true)
})

test('/dp workflow-agents off lets Workflows through as the main agent wrote them, with nothing asked; on brings the decisions back', { options: KEY }, async ($, on) => {
  const w = workflowWorld($, on, { backend: siteJev(BOTH_ROUTED) })
  expect(await w.command('dp')).toMatch(/\bon +workflow-agents +\S/)
  await w.workflow({ script: TIDY })
  expect((await w.board()).agents).toHaveLength(2)

  expect(await w.command('dp', 'workflow-agents off')).toContain('workflow-agents is off')
  const result = await w.workflow({ script: TIDY })
  expect((await w.board()).agents).toHaveLength(2)
  expect(w.requests).toHaveLength(1)
  expect(w.reached.map((r) => r.script === TIDY)).toEqual([false, true])
  expect(result.context).toBeUndefined()

  await w.command('dp', 'workflow-agents on')
  await w.workflow({ script: TIDY })
  expect(w.requests).toHaveLength(2)
})

test('/dp off stands Workflow routing down too: nothing is asked, and the script runs as written', { options: KEY }, async ($, on) => {
  const w = workflowWorld($, on, { backend: siteJev(BOTH_ROUTED) })
  await w.command('dp', 'off')
  await w.workflow({ script: TIDY })

  expect(w.requests).toHaveLength(0)
  expect(w.reached.map((r) => r.script)).toEqual([TIDY])
  expect((await w.board()).agents).toEqual([])
})

test("each agent's decision is logged with its reason: in the debug log, never in the conversation, and in /dp log", { options: KEY }, async ($, on) => {
  const w = workflowWorld($, on, { backend: siteJev(BOTH_ROUTED) })
  await w.workflow({ script: TIDY })

  expect(w.logs.length).toBeGreaterThan(0)
  expect(w.logs.every((log) => log.to === 'debug')).toBe(true)
  expect(w.logs.map((log) => log.text)).toContainEqual(expect.stringMatching(/^request \[agent-0\.model, agent-0\.effort, agent-1\.model, agent-1\.effort\] to jev for workflow "tidy-api": answered in \d+ ms/))
  const log = (await w.command('dp', 'log')).split('\n')
  expect(log[0]).toBe('the last 2 decisions, newest last')
  expect(log[1]).toMatch(/^#1 workflow-agents: sonnet high for "rename" \(workflow tidy-api\): decided; pick sonnet, confidence 0\.70; effort p /)
  expect(log[2]).toMatch(/^#2 workflow-agents: opus high for "review" \(workflow tidy-api\): decided; pick opus, confidence 0\.85; effort p /)
})

test("the person's terms for each call are kept, before the tool runs, for the plans of the call's agents (read beneath, in the same call, by the label fallback)", { options: KEY }, async ($, on) => {
  const w = workflowWorld($, on, { backend: siteJev((i): SiteAnswer => (i === 0 ? { model: { haiku: 0.9 }, nouls: { 'named.haiku': 0.9 } } : { model: { opus: 0.9 }, effort: [0, 0, 1, 0, 0] })) })
  await w.submit('rename 那步用 haiku 就行')
  await w.workflow({ script: TIDY })

  const kept = w.stateWrites.filter((write) => write.key === 'workflowTerms')
  expect(kept).toHaveLength(1)
  expect(kept[0]?.value).toEqual([{ model: 'haiku', effort: null, banned: [] }, null])
  // Written before anything reached the tool.
  expect(w.stateWrites.findIndex((write) => write.key === 'workflowTerms')).toBeLessThan(w.stateWrites.findIndex((write) => write.key === 'labelRuns'))
})

test('a Workflow with nothing the person asked of its calls keeps no terms', { options: KEY }, async ($, on) => {
  const w = workflowWorld($, on, { backend: siteJev(BOTH_ROUTED) })
  await w.workflow({ script: TIDY })

  expect(w.reached[0]?.script).toContain("model: 'sonnet'")
  expect(w.stateWrites.filter((write) => write.key === 'workflowTerms')).toEqual([])
})

test("when the script already has what the decisions say, nothing is written, and the main agent is not told it was", { options: KEY }, async ($, on) => {
  const kept = `export const meta = { name: 'kept', description: 'Already as it should be', phases: [] }
const a = await agent('Read docs/architecture.md and summarize the module boundaries.', { label: 'summary', model: 'haiku' })
return a
`
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { haiku: 0.9, sonnet: 0.05, opus: 0.05 } })) })
  const result = await w.workflow({ script: kept })

  expect(w.reached.map((r) => r.script)).toEqual([kept])
  const told = (result.context ?? []).join('\n')
  expect(told).toMatch(/"summary": kept as written \(haiku\)/)
  expect(told).not.toMatch(/wrote them into the script/)
})

test('a script that cannot be read, one with no agent() call, and one given by path with its text beside it all go through as they are', { options: KEY }, async ($, on) => {
  const w = workflowWorld($, on, { backend: siteJev(BOTH_ROUTED) })
  const broken = `${TIDY}const oops = await agent('never closed\n`
  const none = `export const meta = { name: 'none', description: 'Only a sub-workflow', phases: [] }\nreturn await workflow('review-changes')\n`
  await w.workflow({ script: broken })
  await w.workflow({ script: none })
  await w.workflow({ script: TIDY, scriptPath: '/home/u/.claude/projects/p/s1/workflows/scripts/tidy-wf_old.js' })

  // The unreadable and the path-given ones are on the board with why; one with no agent() call has nothing to show.
  expect((await w.board()).agents.map((node) => [node.routed, node.why])).toEqual([
    [false, 'script not readable'],
    [false, 'given by path'],
  ])

  expect(w.requests).toHaveLength(0)
  expect(w.reached.map((r) => r.script)).toEqual([broken, none, TIDY])
  expect(w.logs.map((log) => log.text).filter((text) => text.startsWith('workflow let through as it is'))).toEqual([
    'workflow let through as it is: unreadable',
    'workflow let through as it is: no agents',
    'workflow let through as it is: scriptPath',
  ])
})

test("the decision model reads each agent as a dispatched agent: its prompt (secrets masked), label, agent type and the workflow's description, with fable among the options when agentFable is on", { options: { ...KEY, agentFable: true } }, async ($, on) => {
  const careful = `export const meta = { name: 'careful', description: 'Prove the lease protocol', phases: [] }
const proof = await agent('Prove that the lease-renewal protocol keeps mutual exclusion under clock drift. The test token is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx.', { label: 'proof', agentType: 'general-purpose' })
return proof
`
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { fable: 1 }, effort: [0, 0, 0, 0.3, 0.7] })) })
  await w.workflow({ script: careful })

  const sent = w.requests[0]?.body
  expect(sent.state.brief_0).toEqual({
    agent_type: 'general-purpose',
    workflow_description: 'Prove the lease protocol',
    label: 'proof',
    prompt: 'Prove that the lease-renewal protocol keeps mutual exclusion under clock drift. The test token is [REDACTED].',
  })
  expect(Object.keys(sent.questions['agent-0.model'].criteria)).toEqual(['haiku', 'sonnet', 'opus', 'fable'])
  expect(w.reached.map((r) => r.script)).toEqual([careful.replace("agentType: 'general-purpose' }", "agentType: 'general-purpose', model: 'fable', effort: 'max' }")])
})

test("the person's words go to the decision model once for the whole script, masked and cut to a third of the context budget, keeping their end", { options: { ...KEY, contextTokens: 900 } }, async ($, on) => {
  const w = workflowWorld($, on, { backend: siteJev(BOTH_ROUTED) })
  await w.submit(`${'这个重构牵涉的面很广，先把方案想清楚。'.repeat(80)}最后：测试用 haiku 就行，密钥 sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx 别外传`)
  await w.workflow({ script: TIDY })

  const words = w.requests[1]?.body.state.user_message as string
  expect(estimateTokens(words)).toBeLessThanOrEqual(300)
  expect(words.endsWith('别外传')).toBe(true)
  expect(words).toContain('[REDACTED]')
  expect(Object.keys(w.requests[1]?.body.state)).toEqual(['brief_0', 'brief_1', 'user_message'])
})

test('no answer within timeoutMs: the script goes through as written, the tool answers as it always does, and the board says why', { options: { ...KEY, timeoutMs: 800 } }, async ($, on) => {
  const w = workflowWorld($, on, { backend: (request) => ({ after: 60_000, reply: siteJev(() => ({ model: { haiku: 1 } }))(request) }) })
  const running = w.workflow({ script: TIDY })
  await w.clock.settle()
  await w.clock.advance(800)
  const result = await running

  expect(w.reached.map((r) => r.script)).toEqual([TIDY])
  expect(result.context).toBeUndefined()
  expect((await w.board()).agents.map((node) => [node.name, node.routed, node.why, node.failure?.kind])).toEqual([
    ['rename', false, 'jev: no answer in 800 ms', 'timeout'],
    ['review', false, 'jev: no answer in 800 ms', 'timeout'],
  ])
})

const failures: { name: string; reply: Reply; why: string }[] = [
  { name: 'the key is refused (401)', reply: { status: 401, body: { detail: 'Invalid API key' } }, why: 'jev: key refused (HTTP 401)' },
  { name: 'a server error (500)', reply: { status: 500, body: 'Internal Server Error' }, why: 'jev: HTTP 500' },
  { name: 'the network is down', reply: { reject: 'getaddrinfo ENOTFOUND api.typesafe.ai' }, why: 'jev: unreachable' },
  { name: "an answer without the agents' questions", reply: { status: 200, body: { model: 'jev-1.13.0', answers: {} } }, why: 'jev: unreadable answer' },
]

for (const failure of failures) {
  test(`${failure.name}: the script goes through as written, and the board says why`, { options: KEY }, async ($, on) => {
    const w = workflowWorld($, on, { backend: () => failure.reply })
    const result = await w.workflow({ script: TIDY })

    expect(w.requests).toHaveLength(1)
    expect(w.reached.map((r) => r.script)).toEqual([TIDY])
    expect(result.context).toBeUndefined()
    expect((await w.board()).agents.map((node) => [node.name, node.routed, node.why])).toEqual([
      ['rename', false, failure.why],
      ['review', false, failure.why],
    ])
  })
}

test('no TypeSafe key: nothing is sent, the script goes through as written, and the board says to set the key', async ($, on) => {
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { haiku: 1 } })) })
  await w.workflow({ script: TIDY })

  expect(w.requests).toHaveLength(0)
  expect(w.reached.map((r) => r.script)).toEqual([TIDY])
  expect((await w.board()).agents.map((node) => [node.name, node.routed, node.why, node.failure?.kind])).toEqual([
    ['rename', false, 'jev: no TypeSafe API key: set typesafeApiKey', 'config'],
    ['review', false, 'jev: no TypeSafe API key: set typesafeApiKey', 'config'],
  ])
})
