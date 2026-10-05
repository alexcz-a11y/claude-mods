// The effort-submit suite of the eval (seam 2): what it sends for an item is
// what the mod sends when the person sends that message after that
// conversation (checked against the mod itself, through seam 1's world).

import { expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import { JEV_MODEL } from '../hooks/decision/jev.ts'
import type { ContextEntry, EffortSubmitItem } from '../eval/lib/datasets.ts'
import { submitRequest } from '../eval/lib/effort-submit.ts'
import { settingsFrom } from '../eval/lib/suite.ts'
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

/**
 * The transcript `$.session.messages()` gives for a conversation the dataset
 * writes as `recent_context`: an assistant reply's tool calls carry their
 * input and output, and each call's result comes back on a user row of its
 * own with no text (Claude Code 2.1.289).
 */
function transcript(context: readonly ContextEntry[]): SessionMessage[] {
  return context.flatMap((entry, i): SessionMessage[] => {
    const tools = entry.tools ?? []
    const uses = tools.map((tool, j) => ({ tool_use_id: `toolu_${i}_${j}`, tool, input: { file_path: '/repo/secret.ts' }, text: 'FILE CONTENT that never travels' }))
    const row: SessionMessage = { role: entry.role, text: entry.text, toolUses: uses }
    if (uses.length === 0) return [row]
    const results: SessionMessage = { role: 'user', text: '', toolUses: [], toolResults: uses.map((use) => ({ tool_use_id: use.tool_use_id, text: use.text, isError: false })) }
    return [row, results]
  })
}

for (const language of ['zh', 'en'] as const) {
  test(`the eval's request for an item is the mod's request for that message after that conversation (${language})`, { options: { typesafeApiKey: 'k' } }, async ($, on) => {
    const w = world($, on, { backend: jev([0, 0, 0.2, 0.7, 0.1]), messages: transcript(ITEM[language].recent_context) })
    await w.submit(ITEM[language].message)

    const { request } = submitRequest(ITEM, language, { language: 'en', primitive: 'score' }, settingsFrom({}))
    expect(w.requests).toHaveLength(1)
    expect(w.requests[0]?.body).toEqual({ model: JEV_MODEL, state: request.state, questions: request.questions })
    // What the request holds, so the equality above is not two empty things.
    expect(request.state.user_message).toContain('[REDACTED]')
    expect(String(request.state.recent_context)).toContain('[tools: Grep, Read x2]')
    expect(String(request.state.recent_context)).not.toContain('FILE CONTENT')
  })
}

// With the skills switch on (its default) the mod's request also asks about the
// session's skills. Questions in one request are answered each on its own, the
// state alone their context (TypeSafe's guide, S1 and Q12), so the eval asks the
// effort question alone: the same state, the same question. Its latency is not
// the message's: the skill eval's first stage is that request.
test("with skills to ask about, the mod's request holds the eval's state and effort question as they are, the skills questions beside them", { options: { typesafeApiKey: 'k' } }, async ($, on) => {
  const skills = {
    commands: [{ name: 'tdd', description: 'Test-driven development.', source: 'user' as const }],
    listed: [{ name: 'tdd', source: 'userSettings', tokens: 20 }],
  }
  const w = world($, on, { backend: jev([0, 0, 0.2, 0.7, 0.1]), messages: transcript(ITEM.zh.recent_context), skills })
  await w.submit(ITEM.zh.message)

  const { request } = submitRequest(ITEM, 'zh', { language: 'en', primitive: 'score' }, settingsFrom({}))
  const sent = w.requests[0]?.body
  expect(Object.keys(sent.questions)).toEqual(['effort.level', 'skills.which'])
  expect(sent.state).toEqual(request.state)
  expect(sent.questions['effort.level']).toEqual(request.questions['effort.level'])
  expect(Object.keys(request.questions)).toEqual(['effort.level'])
})

test("the eval cuts the conversation to the mod's limits as the mod does", { options: { typesafeApiKey: 'k', contextMessages: 2, contextTokens: 100 } }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 0.2, 0.7, 0.1]), messages: transcript(ITEM.zh.recent_context) })
  await w.submit(ITEM.zh.message)

  const { request } = submitRequest(ITEM, 'zh', { language: 'en', primitive: 'score' }, settingsFrom({ contextMessages: 2, contextTokens: 100 }))
  expect(w.requests[0]?.body).toEqual({ model: JEV_MODEL, state: request.state, questions: request.questions })
  expect(String(request.state.recent_context)).not.toContain('登录接口')
})
