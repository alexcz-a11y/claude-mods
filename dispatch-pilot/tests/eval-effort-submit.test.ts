// The effort-submit suite of the eval (seam 2): what it sends for an item is
// what the mod sends when the person sends that message after that
// conversation (checked against the mod itself, through seam 1's world).

import { expect, test } from 'claude-code/testing'
import type { EffortAsk } from '../hooks/decision/effort.ts'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import type { EffortSubmitItem } from '../eval/lib/datasets.ts'
import { modVariant, submitRequest, SUBMIT_VARIANTS } from '../eval/lib/effort-submit.ts'
import { settingsFrom } from '../eval/lib/suite.ts'
import { transcriptWithResults } from './support/conversation.ts'
import { jev, world } from './support/world.ts'

/** An item as the dataset writes it: a short follow-up whose meaning is in the conversation before it. */
const ITEM: EffortSubmitItem = {
  id: 'submit-900',
  zh: {
    message: '好，就按你说的第二个方案来，token 是 sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx 别外传',
    recent_context: [
      { role: 'user', text: '登录接口偶发 502，帮我查下 `gateway/` 和 `auth-service/` 的超时配置' },
      { role: 'assistant', text: '两边超时不一致：网关 30s，auth-service 60s。方案一：网关调到 60s；方案二：auth-service 加熔断并把慢查询拆出去。选哪个？', tools: ['Grep', 'Read', 'Read'] },
      { role: 'user', text: '方案二会动哪些文件？' },
      { role: 'assistant', text: '`auth-service/src/client.ts`、`auth-service/src/repo/session.ts` 和对应的测试。', tools: ['Glob'] },
    ],
  },
  en: {
    message: "OK, go with your second option. The token is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx, don't share it",
    recent_context: [
      { role: 'user', text: 'The login endpoint returns 502 now and then; check the timeout settings in `gateway/` and `auth-service/`' },
      { role: 'assistant', text: 'The two disagree: the gateway waits 30s, auth-service 60s. Option one: raise the gateway to 60s; option two: add a circuit breaker to auth-service and split the slow query out. Which one?', tools: ['Grep', 'Read', 'Read'] },
      { role: 'user', text: 'Which files does option two touch?' },
      { role: 'assistant', text: '`auth-service/src/client.ts`, `auth-service/src/repo/session.ts` and their tests.', tools: ['Glob'] },
    ],
  },
  gold: 'xhigh',
  accept: ['high', 'xhigh'],
  rationale: '批准的是加熔断并拆分慢查询的跨文件改动。',
  difficulty: 'hard',
  tags: ['follow-up'],
}

// The mod asks Jev as the `en-score` variant (modVariant: the effort part beside a message is in English, Jev's best
// language, ADR 0014).
const BACKENDS = [
  { name: 'Jev', options: { decisionModel: 'jev', typesafeApiKey: 'k' }, variant: 'en-score', reply: jev([0, 0, 0.2, 0.7, 0.1]), model: JEV_MODEL },
] as const

/** The questions of the person's own message: the effort question and its eight Nouls. */
const OWN = ['effort.level', 'effort.stakes.undo', 'effort.stakes.live', 'effort.stakes.access', 'effort.cause_unknown', 'effort.still_failing', 'effort.solved', 'effort.new_task', 'effort.constraint', 'effort.confirm', 'effort.escalate']

for (const chosen of BACKENDS) {
  for (const language of ['zh', 'en'] as const) {
    test(`with ${chosen.name}, the eval's ${chosen.variant} request for an item is the mod's request for that message after that conversation (${language})`, { options: chosen.options }, async ($, on) => {
      const w = world($, on, { backend: chosen.reply, messages: transcriptWithResults(ITEM[language].recent_context) })
      await w.submit(ITEM[language].message)

      const settings = settingsFrom(chosen.options)
      expect(modVariant(settings)).toBe(chosen.variant)
      const { request } = submitRequest(ITEM, language, SUBMIT_VARIANTS[chosen.variant] as EffortAsk, settings)
      expect(w.requests).toHaveLength(1)
      expect(w.requests[0]?.body).toEqual({ model: chosen.model, state: request.state, questions: request.questions })
      // The whole effort part, as the mod asks it of the person's message.
      expect(Object.keys(w.requests[0]?.body.questions)).toEqual(OWN)
      // What the request holds, so the equality above is not two empty things.
      expect(request.state.user_message).toContain('[REDACTED]')
      expect(String(request.state.recent_context)).toContain('[tools: Grep, Read x2]')
      expect(String(request.state.recent_context)).not.toContain('FILE CONTENT')
    })
  }
}

// With the skills switch on (its default) the mod also asks about the session's
// skills, in a request of its own (ADR 0005): the effort question's request is
// the same with the skills on or off, the eval's whole. Its latency is not the
// message's: the skill eval's first stage is the skills' request.
test("with skills to ask about, the mod's effort request is the eval's as it is, and the skills questions go in another", { options: { decisionModel: 'jev', typesafeApiKey: 'k' } }, async ($, on) => {
  const skills = {
    commands: [{ name: 'tdd', description: 'Test-driven development.', source: 'user' as const }],
    listed: [{ name: 'tdd', source: 'userSettings', tokens: 20 }],
  }
  const w = world($, on, { backend: jev([0, 0, 0.2, 0.7, 0.1]), messages: transcriptWithResults(ITEM.zh.recent_context), skills })
  await w.submit(ITEM.zh.message)

  const { request } = submitRequest(ITEM, 'zh', SUBMIT_VARIANTS['en-score'] as EffortAsk, settingsFrom({ decisionModel: 'jev' }))
  expect(w.requests[0]?.body).toEqual({ model: JEV_MODEL, state: request.state, questions: request.questions })
  expect(Object.keys(request.questions)).toEqual(OWN)
  // One skill: no Choice over it (ADR 0018), only the gate.
  expect(Object.keys(w.withoutEffort[0]?.body.questions)).toEqual(['skills.gate.acts_on_user_system', 'skills.gate.would_follow_documented_procedure', 'skills.gate.prose_suffices'])
})

test("the eval cuts the conversation to the mod's limits as the mod does", { options: { decisionModel: 'jev', typesafeApiKey: 'k', contextMessages: 2, contextTokens: 100 } }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 0.2, 0.7, 0.1]), messages: transcriptWithResults(ITEM.zh.recent_context) })
  await w.submit(ITEM.zh.message)

  const { request } = submitRequest(ITEM, 'zh', SUBMIT_VARIANTS['en-score'] as EffortAsk, settingsFrom({ decisionModel: 'jev', contextMessages: 2, contextTokens: 100 }))
  expect(w.requests[0]?.body).toEqual({ model: JEV_MODEL, state: request.state, questions: request.questions })
  expect(String(request.state.recent_context)).not.toContain('登录接口')
})
