// What the model reads stays English, word for word, whatever language the person's screens speak (#32): the
// Workflow notes (rewrite, return, left as written), the note beside a dispatched agent's Agent tool result
// (#34), the words of a failed request inside them and inside
// find_skill's answer, and the skill relevance block. The person's words (the board, the log, the toasts) are
// Chinese and tested where they are drawn; these pins are the other side of that line. Seam 1: the tool call in,
// what the main agent is told out; seam 2: the pure words the notes are made of.

import { expect, test } from 'claude-code/testing'
import { failureText, type Failure } from '../hooks/decision/backend.ts'
import { dispatchNote, type DispatchDecision } from '../hooks/decision/dispatched-agent.ts'
import { leftText, whyOf } from '../hooks/decision/workflow.ts'
import { siteJev, workflowWorld } from './support/workflow.ts'
import { KEY } from './support/world.ts'

const TIDY = `export const meta = { name: 'tidy-api', description: 'Rename getUser to fetchUser in src/api, then review the diff', phases: [{ title: 'Edit', detail: 'rename and test' }, { title: 'Review', detail: 'check the diff' }] }
phase('Edit')
const edited = await agent('Rename getUser to fetchUser across src/api and run pnpm test api.', { label: 'rename' })
phase('Review')
const review = await agent('Review the diff of src/policies/document.ts for permission regressions and report the risky edge cases.', { label: 'review', schema: { type: 'object', properties: { risky: { type: 'array' } } } })
return { edited, review }
`

const decisions = siteJev((i) =>
  i === 0 ? { model: { haiku: 0.1, sonnet: 0.8, opus: 0.1 }, effort: [0.1, 0.8, 0.1, 0, 0] } : { model: { haiku: 0.02, sonnet: 0.08, opus: 0.9 }, effort: [0, 0, 0.1, 0.8, 0.1] },
)

test('the note the main agent reads after a rewritten Workflow is English, with the decision model\'s numbers', { options: KEY }, async ($, on) => {
  const w = workflowWorld($, on, { backend: decisions })
  const told = ((await w.workflow({ script: TIDY })).context ?? []).join('\n')
  expect(told).toBe(
    [
      "Dispatch Pilot (the user's routing plugin) decided a model and an effort for each agent() call of this Workflow and wrote them into the script before it ran:",
      '- "rename": sonnet medium (model: its rules read the brief as ordinary work, which gets sonnet; effort: p 0.80)',
      '- "review": opus xhigh (model: its rules read the brief as work that needs careful judgment (design_open), which gets opus; effort: p 0.80)',
      'The script file named above holds these changes. To change one, edit its model or effort there and run that file with scriptPath.',
    ].join('\n'),
  )
})

test('the Workflow sent back in return mode tells the main agent in English what to write into each call', { options: { ...KEY, workflowMode: 'return' } }, async ($, on) => {
  const w = workflowWorld($, on, { backend: decisions })
  const first = await w.workflow({ script: TIDY })
  expect(first.deny).toBe(
    [
      "Dispatch Pilot (the user's routing plugin) did not start this Workflow. It hands the choice of each agent()'s model and effort back to you, and these are what its decision model chose:",
      '- "rename": model: \'sonnet\', effort: \'medium\'',
      '- "review": model: \'opus\', effort: \'xhigh\'',
      'Submit the same script again with these written into the options of those agent() calls (add them to the options object the call has, or give the call one). The other agent() calls need no change. The second submission runs as you write it, whatever it says.',
      "This is the routing plugin's policy, which the user set; it is not part of the script's task.",
    ].join('\n'),
  )
})

test('a failed decision request is worded in English wherever the model reads it', () => {
  const words: [Failure, string][] = [
    [{ kind: 'config', detail: 'no TypeSafe API key: set typesafeApiKey or TYPESAFE_API_KEY' }, 'jev: no TypeSafe API key: set typesafeApiKey or TYPESAFE_API_KEY'],
    [{ kind: 'config', status: 401, detail: 'HTTP 401' }, 'jev: key refused (HTTP 401)'],
    [{ kind: 'timeout', detail: 'no answer in 1500 ms' }, 'jev: no answer in 1500 ms'],
    [{ kind: 'network', detail: 'ENOTFOUND' }, 'jev: unreachable'],
    [{ kind: 'busy', status: 503, detail: 'HTTP 503' }, 'jev: busy (HTTP 503)'],
    [{ kind: 'quota', status: 402, detail: 'HTTP 402' }, 'jev: out of credits (HTTP 402)'],
    [{ kind: 'http', status: 500, detail: 'HTTP 500' }, 'jev: HTTP 500'],
    [{ kind: 'parse', detail: 'not JSON' }, 'jev: unreadable answer'],
    [{ kind: 'request', detail: 'bad' }, 'jev: bad request (see debug log)'],
  ]
  for (const [failure, text] of words) expect(failureText('jev', failure)).toBe(text)
})

test('why a Workflow call was left as written, and why a call got its model and effort, read in English', () => {
  const describe = (failure: Failure) => failureText('jev', failure)
  expect(leftText({ kind: 'left', reason: 'unreadable' }, describe)).toBe('its prompt is built when the script runs')
  expect(leftText({ kind: 'left', reason: 'capped' }, describe)).toBe('the script has more agent() calls than are asked about')
  expect(leftText({ kind: 'left', reason: 'failed' }, describe)).toBe('no answer from the decision model')
  expect(leftText({ kind: 'left', reason: 'failed', failure: { kind: 'busy', status: 503, detail: 'HTTP 503' } }, describe)).toBe('jev: busy (HTTP 503)')
  const decision = { source: 'user', table: null, requested: null, effort: 'high', effortSource: 'user', reading: null, model: 'opus' } as unknown as Parameters<typeof whyOf>[0]
  expect(whyOf(decision)).toBe('model: you asked for it; effort: you asked for it')
})

test("the note beside a dispatched agent's Agent tool result is English, word for word (#34)", () => {
  const opus = { row: '3' as const, wanted: 'opus' as const, model: 'opus' as const, why: ['cause_unknown' as const] }
  const haiku = { row: '4' as const, wanted: 'haiku' as const, model: 'haiku' as const, why: ['writes' as const, 'few_steps' as const, 'report_only' as const] }
  const decided: DispatchDecision = { model: 'opus', effort: 'high', source: 'table', table: opus, route: null, requested: null, banned: [], signs: {}, reading: null, answered: true, namedEffort: null, effortSource: 'decided', steps: [] }
  const failure: Failure = { kind: 'http', detail: 'HTTP 500', status: 500 }
  const routed = (decision: DispatchDecision, started: string, requested: 'haiku' | 'sonnet' | 'opus' | null) => dispatchNote({ routed: true, decision, started, requested })
  const policy = " This is the user's routing policy: a model the user names is used as named, and a model you ask for is kept unless the work calls for a stronger one."
  expect([
    routed({ ...decided, requested: { model: 'sonnet', outcome: 'upgraded' } }, 'claude-opus-5-5', 'sonnet'),
    routed({ ...decided, model: 'sonnet', banned: ['opus'], table: { ...opus, model: 'sonnet' } }, 'claude-sonnet-5-5', 'opus'),
    routed(decided, 'claude-opus-5-5', null),
    routed({ ...decided, source: 'requested', model: 'opus', effort: 'medium', table: haiku, requested: { model: 'opus', outcome: 'kept' }, lifted: { from: 'low', by: 'model-floor' } }, 'opus', 'opus'),
    routed({ ...decided, source: 'requested', requested: { model: 'opus', outcome: 'kept' } }, 'opus', 'opus'),
    routed({ ...decided, effort: 'xhigh', lifted: { from: 'medium', by: 'cause-unknown' } }, 'opus', null),
    routed({ ...decided, source: 'user', model: 'haiku', effort: 'low', table: { row: '1', wanted: 'haiku', model: 'haiku', why: [] } }, 'haiku', null),
    routed({ ...decided, source: 'none', model: null, table: null, effort: null, effortSource: 'none' }, 'claude-opus-5-5', null),
    dispatchNote({ routed: false, started: 'claude-sonnet-5-5', why: { failure, backend: 'jev' } }),
    dispatchNote({ routed: false, started: 'opus', why: 'off' }),
  ]).toEqual([
    "Dispatch Pilot (the user's routing plugin) started this agent on opus at effort high. Model: raised from the sonnet you asked for: its rules read the brief as work that needs careful judgment (cause_unknown), which gets opus. Effort: chosen by its decision model." + policy,
    "Dispatch Pilot (the user's routing plugin) started this agent on sonnet at effort high. Model: the user ruled out the opus you asked for; its rules read the brief as work that needs careful judgment (cause_unknown), which gets opus; the user ruled opus out, so sonnet. Effort: chosen by its decision model." + policy,
    "Dispatch Pilot (the user's routing plugin) started this agent on opus at effort high. Model: its rules read the brief as work that needs careful judgment (cause_unknown), which gets opus. Effort: chosen by its decision model." + policy,
    "Dispatch Pilot (the user's routing plugin) started this agent on opus at effort medium. Model: kept the opus you asked for (its rules read the brief as a read-only lookup of a step or two whose result is only reported (writes, few_steps, report_only), which gets haiku, which is not stronger). Effort: low lifted to medium, as the floor for opus." + policy,
    "Dispatch Pilot (the user's routing plugin) started this agent on opus at effort high. Model: kept the opus you asked for. Effort: chosen by its decision model." + policy,
    "Dispatch Pilot (the user's routing plugin) started this agent on opus at effort xhigh. Model: its rules read the brief as work that needs careful judgment (cause_unknown), which gets opus. Effort: medium lifted to xhigh, as the work includes finding a cause nobody has named." + policy,
    "Dispatch Pilot (the user's routing plugin) started this agent on haiku at effort low. Model: the user named it. Effort: chosen by its decision model." + policy,
    "Dispatch Pilot (the user's routing plugin) started this agent on opus. Model: the engine's. Effort: the session's." + policy,
    "Dispatch Pilot (the user's routing plugin) did not route this agent (jev: HTTP 500): it started as you asked, on sonnet, at the session's effort.",
    "Dispatch Pilot (the user's routing plugin) has its dispatched-agents feature switched off, so it did not route this agent: it started as you asked, on opus, at the session's effort.",
  ])
})
