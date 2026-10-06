// What the model reads stays English, word for word, whatever language the person's screens speak (#32): the
// Workflow notes (rewrite, return, left as written), the note beside a dispatched agent's Agent tool result (#34), the words of a failed request inside them and inside
// find_skill's answer, and the skill relevance block. The person's words (the board, the log, the toasts) are
// Chinese and tested where they are drawn; these pins are the other side of that line. Seam 1: the tool call in,
// what the main agent is told out; seam 2: the pure words the notes are made of.

import { expect, test } from 'claude-code/testing'
import { failureText, type Failure } from '../hooks/decision/backend.ts'
import { dispatchNote, type DispatchDecision } from '../hooks/decision/dispatched-agent.ts'
import { leftText, whyOf } from '../hooks/decision/workflow.ts'
import { siteJev, workflowWorld } from './support/workflow.ts'

const KEY = { typesafeApiKey: 'ts-test-key' }

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
      '- "rename": sonnet medium (model: decided, confidence 0.70; effort: p 0.80)',
      '- "review": opus xhigh (model: decided, confidence 0.85; effort: p 0.80)',
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
    [{ kind: 'config', detail: 'no TypeSafe API key: set typesafeApiKey' }, 'jev: no TypeSafe API key: set typesafeApiKey'],
    [{ kind: 'config', status: 401, detail: 'HTTP 401' }, 'jev: key refused (HTTP 401)'],
    [{ kind: 'timeout', detail: 'no answer in 1500 ms' }, 'jev: no answer in 1500 ms'],
    [{ kind: 'network', detail: 'ENOTFOUND' }, 'jev: unreachable'],
    [{ kind: 'busy', status: 503, detail: 'HTTP 503' }, 'jev: busy (HTTP 503)'],
    [{ kind: 'quota', status: 429, detail: 'HTTP 429' }, 'jev: daily quota used up'],
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
  const decision = { source: 'user', pick: null, effort: 'high', effortSource: 'user', reading: null, model: 'opus' } as unknown as Parameters<typeof whyOf>[0]
  expect(whyOf(decision)).toBe('model: you asked for it; effort: you asked for it')
})

test("the note beside a dispatched agent's Agent tool result is English, word for word (#34)", () => {
  const decided: DispatchDecision = { model: 'sonnet', effort: 'high', source: 'decided', pick: { model: 'sonnet', confidence: 0.85 }, banned: [], reading: null, answered: true, effortSource: 'decided', trace: null }
  const failure: Failure = { kind: 'http', detail: 'HTTP 500', status: 500 }
  expect([
    dispatchNote({ routed: true, decision: decided, started: 'sonnet', requested: 'opus', thetaOverride: 0.6 }),
    dispatchNote({ routed: true, decision: { ...decided, source: 'requested', model: 'opus', effort: 'medium', liftedFrom: 'low' }, started: 'opus', requested: 'opus', thetaOverride: 0.6 }),
    dispatchNote({ routed: true, decision: { ...decided, source: 'user', model: 'haiku', effort: null, effortSource: 'none' }, started: 'haiku', requested: null, thetaOverride: 0.6 }),
    dispatchNote({ routed: false, started: 'sonnet', why: { failure, backend: 'jev' } }),
    dispatchNote({ routed: false, started: 'opus', why: 'off' }),
  ]).toEqual([
    "Dispatch Pilot (the user's routing plugin) started this agent on sonnet at effort high. Model: overrode the opus you asked for: its decision model chose sonnet at confidence 0.85, over the 0.60 it takes to override you. Effort: chosen by its decision model. This is the user's routing policy: only a model the user names in their message is never changed.",
    "Dispatch Pilot (the user's routing plugin) started this agent on opus at effort medium. Model: kept the opus you asked for (its decision model leaned to sonnet at confidence 0.85, under the 0.60 it takes to override you). Effort: low lifted to medium, the floor for opus. This is the user's routing policy: only a model the user names in their message is never changed.",
    "Dispatch Pilot (the user's routing plugin) started this agent on haiku. Model: the user named it. Effort: haiku takes no effort. This is the user's routing policy: only a model the user names in their message is never changed.",
    "Dispatch Pilot (the user's routing plugin) did not route this agent (jev: HTTP 500): it started as you asked, on sonnet, at the session's effort.",
    "Dispatch Pilot (the user's routing plugin) has its dispatched-agents feature switched off, so it did not route this agent: it started as you asked, on opus, at the session's effort.",
  ])
})
