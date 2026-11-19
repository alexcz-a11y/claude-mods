import { expect, test } from 'claude-code/testing'
import { usageOf } from '../eval/accept/lib/usage.ts'

const usage = (input: number, output: number, read: number, created = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: created })
const prompt = { type: 'user', isSidechain: false, turnPosition: { promptIndex: 1, turnIndex: 1 }, timestamp: '2031-01-01T00:00:00.000Z', message: { role: 'user', content: 'fix it' } }
function response(id: string, at: string, u: object, block = 'text', extra: object = {}) {
  return { type: 'assistant', isSidechain: false, timestamp: at, message: { id, model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: block }], usage: u }, ...extra }
}

test('两步主循环各带 usage 都算；子 agent 的记录不算', () => {
  const records = [
    prompt,
    response('msg_1', '2031-01-01T00:00:02.000Z', usage(10, 20, 300, 5), 'tool_use'),
    { type: 'user', isSidechain: false, timestamp: '2031-01-01T00:00:03.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    response('msg_sub', '2031-01-01T00:00:04.000Z', usage(1000, 1000, 1000), 'text', { isSidechain: true, agentId: 'a1' }),
    response('msg_2', '2031-01-01T00:00:09.000Z', usage(7, 8, 400)),
  ]
  expect(usageOf(records)).toEqual({ steps: 2, inputTokens: 22, outputTokens: 28, cacheReadTokens: 700, turnMs: 9000 })
})

test('同一个回答分成几条记录（每个块一条）只算一次', () => {
  const u = usage(10, 20, 30)
  const records = [prompt, response('msg_1', '2031-01-01T00:00:01.000Z', u, 'thinking'), response('msg_1', '2031-01-01T00:00:01.000Z', u, 'text'), response('msg_1', '2031-01-01T00:00:02.000Z', u, 'tool_use')]
  expect(usageOf(records)).toEqual({ steps: 1, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, turnMs: 2000 })
})

test('Code Mode 脚本里的调用（isVirtual、synthetic 模型）不是请求，不算', () => {
  const virtual = { type: 'assistant', isSidechain: false, isVirtual: true, timestamp: '2031-01-01T00:00:05.000Z', message: { id: 'v1', model: '<synthetic>', content: [{ type: 'tool_use' }], usage: usage(0, 0, 0) } }
  const records = [prompt, response('msg_1', '2031-01-01T00:00:01.000Z', usage(1, 2, 3)), virtual]
  expect(usageOf(records).steps).toBe(1)
})

test('有 turn_duration 时 turnMs 取它；认不出的行跳过', () => {
  const records = [prompt, 'not an object', null, response('msg_1', '2031-01-01T00:00:01.000Z', usage(1, 2, 3)), { type: 'system', subtype: 'turn_duration', isSidechain: false, durationMs: 4321, timestamp: '2031-01-01T00:00:05.000Z' }]
  expect(usageOf(records)).toEqual({ steps: 1, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, turnMs: 4321 })
})

test('没有记录：全是 0', () => {
  expect(usageOf([])).toEqual({ steps: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turnMs: 0 })
})
