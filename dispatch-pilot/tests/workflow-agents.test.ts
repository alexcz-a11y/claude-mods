// Workflow agents (#8): when the main agent submits a Workflow, each `agent()`
// of its script gets its own decision on model and effort, written into the
// script before the tool runs it. Seam 1: the Workflow tool call in; out, the
// script that reaches the tool, the decision requests, what the main agent is
// told, the status line, the decision log, `$.state`.

import { expect, test } from 'claude-code/testing'
import { siteJev, workflowWorld } from './support/workflow.ts'

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
  expect(told).toMatch(/"rename".*sonnet.*medium/)
  expect(told).toMatch(/"review".*opus.*xhigh/)
  expect(w.status()).toBe('dp workflow routed 2 agents')
})

test('an agent sent to haiku gets no effort: the one the script wrote is taken out, whatever the effort answer says', { options: KEY }, async ($, on) => {
  const scan = `export const meta = { name: 'scan', description: 'List the files that import legacyAuth', phases: [] }
const files = await agent('List every file under src/ that imports legacyAuth. Report file:line only.', { label: 'scan', effort: 'high' })
return files
`
  const w = workflowWorld($, on, { backend: siteJev(() => ({ model: { haiku: 0.9, sonnet: 0.08, opus: 0.02 }, effort: [0, 0, 0, 1, 0] })) })
  const result = await w.workflow({ script: scan })

  expect(w.reached.map((r) => r.script)).toEqual([scan.replace("{ label: 'scan', effort: 'high' }", "{ label: 'scan', model: 'haiku' }")])
  expect((result.context ?? []).join('\n')).toMatch(/"scan".*haiku/)
  expect((result.context ?? []).join('\n')).not.toMatch(/"scan".*haiku.*(low|medium|high|max)/)
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
