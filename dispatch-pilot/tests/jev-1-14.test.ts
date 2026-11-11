// Jev's version (DEVELOPMENT.md 「Jev 1.14」, ADR 0021): every Jev decision is asked of the `jev-latest` alias since
// 2026-11-10 (jev-1.14.0 was pinned from 2026-10-15), and the debug log names the version that answered. An agent's
// questions, a dispatched agent's and a Workflow's alike, are asked in English with either
// decision model since 0.9.0 (ADR 0014: TypeSafe names English as the language Jev is most accurate in; before it Jev was
// asked in Chinese, the eval's models-hint-zh). Seam 1: engine events in, the request the decision model got out.

import { expect, test } from 'claude-code/testing'
import { dispatchPart, dispatchState, type Dispatch } from '../hooks/decision/dispatched-agent.ts'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import { mergeParts } from '../hooks/decision/system-one.ts'
import { KEY, pplx, world, type Reply, type Sent } from './support/world.ts'

const PPLX = { decisionModel: 'pplx', perplexityApiKey: 'pplx-test-key' }

const MESSAGE = '这个改动涉及权限判断，帮我审一下'
const PROMPT = '审查当前分支相对 main 的 diff，列出权限扩大的边界情况。'
const ITEM: Dispatch = { user_message: MESSAGE, kind: 'agent', agent_type: 'general-purpose', description: '审查权限改动', prompt: PROMPT, requested_model: null, workflow_description: null, label: null }

/** A decision model that answers every question it is asked: the effort one in the middle, the model one with sonnet; as the real Jev, its `model` is the version that answered. */
function answering(request: Sent): Reply {
  const answers: Record<string, unknown> = {}
  for (const [id, question] of Object.entries((request.body?.questions ?? {}) as Record<string, { type: string; criteria?: Record<string, unknown> }>)) {
    if (question.type === 'choice') {
      const options = Object.keys(question.criteria ?? {})
      const choice = options.find((option) => option === 'sonnet') ?? options[0] ?? ''
      answers[id] = { type: 'choice', choice, probabilities: Object.fromEntries(options.map((option) => [option, option === choice ? 1 : 0])), confidence: 1 }
    } else if (question.type === 'score') answers[id] = { type: 'score', score: 2, legend: {}, probabilities: { 0: 0, 1: 0, 2: 1, 3: 0, 4: 0 }, confidence: 1 }
    else answers[id] = { type: 'noul', noul: 0 }
  }
  return { status: 200, body: { model: 'jev-1.14.0', answers, usage: { input_tokens: 100, output_tokens: 0 } } }
}

test('every Jev decision is asked of the jev-latest alias (ADR 0021), and the debug log names the version that answered', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: answering })
  await w.submit(MESSAGE)

  expect(JEV_MODEL).toBe('jev-latest')
  expect(w.requests[0]?.body.model).toBe('jev-latest')
  expect(w.logs.map((log) => log.text)).toContainEqual(expect.stringMatching(/^request \[effort\.level, .*\] to jev: answered in \d+ ms by jev-1\.14\.0 \(100 input tokens\)$/))
})

test('with Jev, an agent the main agent dispatches is asked about in English, as the decision module builds it', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: answering })
  await w.submit(MESSAGE)
  await w.spawn({ prompt: PROMPT, description: '审查权限改动', subagentType: 'general-purpose' })

  const built = mergeParts(dispatchState(ITEM, 2000), [dispatchPart(ITEM, { ask: { language: 'en' } })])
  expect(w.requests[1]?.body.questions).toEqual(built.questions)
  expect(JSON.stringify(w.requests[1]?.body.questions)).not.toMatch(/[一-鿿]/)
})

test('with pplx, an agent is still asked about in English', { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: pplx([0, 0, 1, 0, 0], { choice: 'sonnet' }) })
  await w.submit(MESSAGE)
  await w.spawn({ prompt: PROMPT, description: '审查权限改动', subagentType: 'general-purpose' })

  const agentRequest = w.requests.find((request) => JSON.stringify(request.body).includes('agent.effort'))
  expect(agentRequest).toBeDefined()
  expect(JSON.stringify(agentRequest?.body.questions ?? {})).not.toMatch(/[一-鿿]/)
})
