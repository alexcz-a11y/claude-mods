// Jev 1.14 (2026-10-15, DEVELOPMENT.md 「Jev 1.14」): every Jev decision is asked of the pinned jev-1.14.0, not of the
// `jev-latest` alias, so the thresholds stay those the eval measured; and an agent's questions, a dispatched agent's and a
// Workflow's alike, are asked in Chinese with Jev (the eval's models-hint-zh, as good as or better than models-hint on 1.14),
// in English with pplx. Seam 1: engine events in, the request the decision model got out.

import { expect, test } from 'claude-code/testing'
import { dispatchPart, dispatchState, type Dispatch } from '../hooks/decision/dispatched-agent.ts'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import { mergeParts } from '../hooks/decision/system-one.ts'
import { jev, KEY, pplx, world, type Reply, type Sent } from './support/world.ts'

const PPLX = { decisionModel: 'pplx', perplexityApiKey: 'pplx-test-key' }

const MESSAGE = '这个改动涉及权限判断，帮我审一下'
const PROMPT = '审查当前分支相对 main 的 diff，列出权限扩大的边界情况。'
const ITEM: Dispatch = { user_message: MESSAGE, kind: 'agent', agent_type: 'general-purpose', description: '审查权限改动', prompt: PROMPT, requested_model: null, workflow_description: null, label: null }

/** A decision model that answers every question it is asked: the effort one in the middle, the model one with sonnet. */
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

test('every Jev decision is asked of jev-1.14.0, the version the eval measured, not of the jev-latest alias', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  await w.submit(MESSAGE)

  expect(JEV_MODEL).toBe('jev-1.14.0')
  expect(w.requests[0]?.body.model).toBe('jev-1.14.0')
})

test('with Jev, an agent the main agent dispatches is asked about in Chinese: the questions the eval asked as models-hint-zh', { options: KEY }, async ($, on) => {
  const w = world($, on, { backend: answering })
  await w.submit(MESSAGE)
  await w.spawn({ prompt: PROMPT, description: '审查权限改动', subagentType: 'general-purpose' })

  const built = mergeParts(dispatchState(ITEM, 2000), [dispatchPart(ITEM, { ask: { language: 'zh' } })])
  expect(w.requests[1]?.body.questions).toEqual(built.questions)
  expect(JSON.stringify(w.requests[1]?.body.questions)).toMatch(/[一-鿿]/)
})

test('with pplx, an agent is still asked about in English', { options: PPLX }, async ($, on) => {
  const w = world($, on, { backend: pplx([0, 0, 1, 0, 0], { choice: 'sonnet' }) })
  await w.submit(MESSAGE)
  await w.spawn({ prompt: PROMPT, description: '审查权限改动', subagentType: 'general-purpose' })

  const agentRequest = w.requests.find((request) => JSON.stringify(request.body).includes('agent.model'))
  expect(agentRequest).toBeDefined()
  expect(JSON.stringify(agentRequest?.body.questions ?? {})).not.toMatch(/[一-鿿]/)
})
