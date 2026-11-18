import { expect, test } from 'claude-code/testing'
import type { SessionAppendInput } from 'claude-code'
import { applyRow, emptyJournal, kindOf, rowOf, scriptResult } from '../hooks/journal.ts'
import type { TurnJournal } from '../hooks/journal.ts'
import { estimateTokens } from '../hooks/statebuild.ts'
import {
  assistantText,
  assistantToolUse,
  deliveryResult,
  emptyDelivery,
  innerCall,
  innerToolUse,
  pollResult,
  promptRow,
  queueRow,
  replReceipt,
  toolResult,
} from './support/rows.ts'

const kind = (e: SessionAppendInput) => kindOf(rowOf(e))

function feed(rows: SessionAppendInput[], start: TurnJournal = emptyJournal()): TurnJournal {
  return rows.reduce((j, e) => {
    const row = rowOf(e)
    return applyRow(j, row, kindOf(row))
  }, start)
}

/** One Code Mode script from its tool_use to its result on Poll's row, as E13 orders the rows. */
function script(description: string, n: number, inner: SessionAppendInput[], result: SessionAppendInput): SessionAppendInput[] {
  return [assistantToolUse('REPL', { code: '1', description }), assistantToolUse('Poll'), replReceipt(n), ...inner, emptyDelivery(), result]
}

test('认出七种行', () => {
  expect(kind(replReceipt(1))).toBe('receipt')
  expect(kind(pollResult(1, 'ok'))).toBe('script-result-poll')
  expect(kind(deliveryResult(1, 'ok'))).toBe('script-result-delivery')
  expect(kind(innerCall('Bash'))).toBe('inner-call')
  expect(kind(toolResult('Bash', 'ok'))).toBe('tool-result')
  expect(kind(promptRow('also check the docs'))).toBe('new-input')
  expect(kind(assistantText('Next I run the tests.'))).toBe('assistant')
  expect(kind(assistantToolUse('Read', { file_path: '/a' }))).toBe('assistant')
  // A queue record carries the same event text as a result, but is no row of the conversation.
  expect(kind(queueRow(1, 'ok'))).toBe('other')
  expect(kind(emptyDelivery())).toBe('other')
})

test('不是回执的 REPL 结果行（被拒、出错）像普通工具结果一样结束这一步，记为失败', () => {
  const refused = toolResult('REPL', 'Permission to use REPL has been denied.', { error: true })
  expect(kind(refused)).toBe('tool-result')
  const before = feed([assistantToolUse('Read'), toolResult('Read', 'x', { error: true })])
  const j = feed([assistantToolUse('REPL', { description: 'delete the cache' }), refused], before)
  expect(j.steps.at(-1)).toEqual({ did: 'delete the cache', tools: ['REPL'], ok: false, result: 'Permission to use REPL has been denied.' })
  expect(j.open).toBeNull()
  expect(j.workSteps).toBe(2)
  expect(j.failedSteps).toBe(2)
  expect(j.consecutiveFailures).toBe(2)
  expect(j.lastError).toBe('Permission to use REPL has been denied.')
})

test('Code Mode 的一步：回执不算结果，Poll 结果行结束这一步', () => {
  const afterReceipt = feed([assistantToolUse('REPL', { code: 'x', description: 'run the tests' }), replReceipt(1)])
  expect(afterReceipt.steps).toEqual([])
  expect(afterReceipt.workSteps).toBe(0)
  expect(afterReceipt.scriptResults).toBe(0)
  const j = feed([innerCall('Bash'), pollResult(1, '3 failed')], afterReceipt)
  expect(j.steps.at(-1)).toEqual({ did: 'run the tests', tools: ['REPL', 'Bash'], ok: true, result: '3 failed' })
  expect(j.workSteps).toBe(1)
  expect(j.scriptResults).toBe(1)
  expect(j.open).toBeNull()
})

test('结果经 delivery 行到达也结束这一步；空的 delivery 行不算', () => {
  const pending = feed([assistantToolUse('REPL', { description: 'list files' }), replReceipt(1), innerCall('Glob'), emptyDelivery()])
  expect(pending.steps).toEqual([])
  expect(pending.scriptResults).toBe(0)
  expect(pending.open).toEqual({ did: 'list files', tools: ['REPL', 'Glob'], failed: false })
  const j = feed([deliveryResult(1, 'a.ts b.ts')], pending)
  expect(j.steps).toEqual([{ did: 'list files', tools: ['REPL', 'Glob'], ok: true, result: 'a.ts b.ts' }])
  expect(j.workSteps).toBe(1)
  expect(j.scriptResults).toBe(1)
})

test('脚本报错：ok 为 false，failedSteps 加一', () => {
  const j = feed(script('parse the config', 2, [], pollResult(2, 'TypeError: x\n    at main (repl:1:5)', { error: true })))
  expect(j.steps.at(-1)).toEqual({ did: 'parse the config', tools: ['REPL'], ok: false, result: 'TypeError: x\n    at main (repl:1:5)' })
  expect(j.workSteps).toBe(1)
  expect(j.failedSteps).toBe(1)
  expect(j.consecutiveFailures).toBe(1)
  expect(j.lastError).toBe('TypeError: x')
})

test('同一条报错在一次修改之后再出现：sameErrorRepeated', () => {
  const fail = () => toolResult('Bash', 'FAIL test_upload\n  expected 200, got 500', { error: true })
  // The same failure twice with no change in between is not a repeat after a fix.
  const twice = feed([assistantToolUse('Bash', { command: 'npm test' }), fail(), assistantToolUse('Bash', { command: 'npm test' }), fail()])
  expect(twice.lastError).toBe('FAIL test_upload')
  expect(twice.sameErrorRepeated).toBe(false)
  expect(twice.consecutiveFailures).toBe(2)

  const fixed = feed([assistantToolUse('Edit', { file_path: '/up.ts' }), toolResult('Edit', 'ok')], twice)
  expect(fixed.editedSinceError).toBe(true)
  const again = feed([assistantToolUse('Bash', { command: 'npm test' }), fail()], fixed)
  expect(again.sameErrorRepeated).toBe(true)
  expect(again.editedSinceError).toBe(false)

  // In Code Mode a new script counts as a change: the same error from the next script is a repeat.
  const first = feed(script('run the tests', 1, [], pollResult(1, 'Error: boom', { error: true })))
  expect(first.sameErrorRepeated).toBe(false)
  const second = feed(script('fix and rerun', 2, [innerCall('Edit')], pollResult(2, 'Error: boom', { error: true })), first)
  expect(second.sameErrorRepeated).toBe(true)
  // A step that succeeds clears it.
  expect(feed(script('rerun', 3, [], pollResult(3, 'all passed')), second).sameErrorRepeated).toBe(false)
})

test('只等结果的 Poll 不算工作步', () => {
  // A Poll that returns while the script still runs has no result event: it ends nothing.
  const status = '<event nonce="a" kind="repl-status" at="t">#1 still running</event>'
  const running = feed([assistantToolUse('REPL', { description: 'long build' }), assistantToolUse('Poll'), replReceipt(1), toolResult('Poll', status)])
  expect(kind(toolResult('Poll', status))).toBe('other')
  expect(running.steps).toEqual([])
  expect(running.open).toEqual({ did: 'long build', tools: ['REPL'], failed: false })
  // The next step only waits; the result it brings ends the script's one step.
  const done = feed([assistantToolUse('Poll'), pollResult(1, 'built')], running)
  expect(done.workSteps).toBe(1)
  expect(done.steps).toEqual([{ did: 'long build', tools: ['REPL'], ok: true, result: 'built' }])

  // A Poll with no receipt before it brings a result but is no work step.
  const waited = feed([assistantToolUse('Poll'), pollResult(4, 'late result')], done)
  expect(waited.workSteps).toBe(1)
  expect(waited.scriptResults).toBe(2)
  expect(waited.steps.at(-1)).toEqual({ did: 'Poll', tools: ['Poll'], ok: true, result: 'late result' })
})

test('agent 的行不进主循环的记录', () => {
  const agent = (e: SessionAppendInput): SessionAppendInput => ({ ...e, agentId: 'agent-1' })
  const rows = [
    agent(assistantText('I will read the file.')),
    agent(assistantToolUse('Read', { file_path: '/a' })),
    agent(toolResult('Read', 'contents', { error: true })),
    agent(replReceipt(1)),
    agent(pollResult(1, 'x')),
    agent(promptRow('hi')),
  ]
  for (const e of rows) expect(kind(e)).toBe('other')
  expect(feed(rows)).toEqual(emptyJournal())
})

test('引号带反斜杠的 repl-eval 标记也认得', () => {
  const escaped = 'events: <event nonce=\\"n\\" kind=\\"repl-eval\\" eval=\\"3\\">\\n<result>42</result>\\n</event>'
  expect(escaped).toContain('kind=\\"repl-eval\\"')
  expect(scriptResult(escaped)).toEqual({ ok: true, result: '42' })
  expect(kind(toolResult('Poll', escaped))).toBe('script-result-poll')
})

test('scriptResult：<error> 的 ok 为 false，<log> 行不算结果，没有事件时为 null', () => {
  const text = '<event nonce="n" kind="repl-eval" eval="5" status="settled">\n<log>step 1</log>\n<log>step 2</log>\n<error>ReferenceError: y is not defined</error>\n</event>'
  expect(scriptResult(text)).toEqual({ ok: false, result: 'ReferenceError: y is not defined' })
  const withLogs = '<event nonce="n" kind="repl-eval" eval="6">\n<log>noise</log>\n<result>{"a":1}</result>\n</event>'
  expect(scriptResult(withLogs)).toEqual({ ok: true, result: '{"a":1}' })
  expect(scriptResult('(dispatched #1)')).toBeNull()
  expect(scriptResult('')).toBeNull()
})

test('tool_result 的 content 是文字块数组时也读得出文字', () => {
  const e: SessionAppendInput = {
    message: {
      type: 'user',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'line one' }, { type: 'image', source: {} }, { type: 'text', text: 'line two' }] }],
    },
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Read' },
    uuid: 'u1',
  }
  expect(rowOf(e).text).toBe('line one\nline two')
  expect(feed([e]).steps).toEqual([{ did: 'Read', tools: ['Read'], ok: true, result: 'line one\nline two' }])
})

test('普通会话：is_error 的结果记为失败，成功一步清零 consecutiveFailures', () => {
  const failed = feed([assistantToolUse('Bash'), toolResult('Bash', 'exit 1: no such file', { error: true })])
  expect(failed.steps).toEqual([{ did: 'Bash', tools: ['Bash'], ok: false, result: 'exit 1: no such file' }])
  expect(failed.failedSteps).toBe(1)
  expect(failed.consecutiveFailures).toBe(1)
  const twice = feed([assistantToolUse('Bash'), toolResult('Bash', 'exit 2', { error: true })], failed)
  expect(twice.consecutiveFailures).toBe(2)
  const ok = feed([assistantToolUse('Read'), toolResult('Read', 'fine')], twice)
  expect(ok.consecutiveFailures).toBe(0)
  expect(ok.failedSteps).toBe(2)
  expect(ok.workSteps).toBe(3)
})

test('脚本内部的调用出错、脚本结果却是成功：这一步记为失败，工具名不变，报错写进 lastError', () => {
  const running = feed([assistantToolUse('REPL', { description: 'build' }), replReceipt(1), innerCall('Read'), innerCall('Bash', { error: 'Exit code 2\nmake: *** [all] Error 2' })])
  expect(running.open).toEqual({ did: 'build', tools: ['REPL', 'Read', 'Bash'], failed: true })
  const j = feed([pollResult(1, 'done anyway')], running)
  expect(j.steps.at(-1)).toEqual({ did: 'build', tools: ['REPL', 'Read', 'Bash'], ok: false, result: 'done anyway' })
  expect(j.failedSteps).toBe(1)
  expect(j.consecutiveFailures).toBe(1)
  expect(j.lastError).toBe('Exit code 2')
  // The script's own error repeating the inner call's is the same failure, not a second one.
  const k = feed(script('build', 2, [innerCall('Bash', { error: 'Exit code 2' })], pollResult(2, 'Exit code 2', { error: true })))
  expect(k.lastError).toBe('Exit code 2')
  expect(k.sameErrorRepeated).toBe(false)
  expect(k.consecutiveFailures).toBe(1)
})

test('editedSinceError：Edit、Write、NotebookEdit 和新的 REPL 置上，Read 不置', () => {
  const failed = feed([assistantToolUse('Bash'), toolResult('Bash', 'boom', { error: true })])
  expect(failed.editedSinceError).toBe(false)
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'REPL']) {
    expect(feed([assistantToolUse(tool, { description: 'x' })], failed).editedSinceError).toBe(true)
  }
  expect(feed([assistantToolUse('Read'), toolResult('Read', 'text')], failed).editedSinceError).toBe(false)
  // Inside a script: an inner Edit sets it, an inner Read does not.
  const scriptFailed = feed(script('try', 1, [], pollResult(1, 'boom', { error: true })))
  // The receipt itself is a new REPL; clear the flag to see what the inner calls alone do.
  const open = { ...feed([replReceipt(2)], scriptFailed), editedSinceError: false }
  expect(open.open?.tools).toEqual(['REPL'])
  expect(feed([innerCall('Read')], open).editedSinceError).toBe(false)
  expect(feed([innerCall('Edit')], open).editedSinceError).toBe(true)
})

test('steps 只留最后 6 条', () => {
  const rows = Array.from({ length: 8 }, (_, i) => [assistantToolUse('Read'), toolResult('Read', `r${i}`)]).flat()
  const j = feed(rows)
  expect(j.workSteps).toBe(8)
  expect(j.steps.map((s) => s.result)).toEqual(['r2', 'r3', 'r4', 'r5', 'r6', 'r7'])
})

test('statedNext 取最近的文字，截到 200 token', () => {
  const j = feed([assistantText('First I look.'), assistantToolUse('Read')])
  expect(j.statedNext).toBe('First I look.')
  const long = 'Next I will rewrite the parser. '.repeat(100)
  const k = feed([assistantText(long)], j)
  expect(estimateTokens(k.statedNext)).toBeLessThanOrEqual(200)
  expect(k.statedNext.startsWith('Next I will rewrite the parser.')).toBe(true)
  // A thinking-only response is the assistant's, but says nothing.
  const thinking: SessionAppendInput = { ...assistantText(''), message: { type: 'assistant', role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } }
  expect(kind(thinking)).toBe('assistant')
  expect(feed([thinking], k).statedNext).toBe(k.statedNext)
})

test('queue 行、新输入、脚本内部调用的回复行都不改记录', () => {
  const j = feed([assistantToolUse('REPL', { description: 'scan' }), replReceipt(1)])
  // The response row of a call inside a script has no role: it opens no step of the main loop.
  expect(kind(innerToolUse('Read', { file_path: '/a' }))).toBe('other')
  const notice: SessionAppendInput = { ...emptyDelivery(), message: { type: 'attachment', role: 'user', isMeta: true, content: [{ type: 'text', text: '<task-notification>agent done</task-notification>' }] } }
  expect(kind(notice)).toBe('new-input')
  const k = feed([innerToolUse('Read', { file_path: '/a' }), queueRow(1, 'x'), promptRow('also the docs'), notice], j)
  expect(k).toEqual(j)
})

test('不合常规的行不抛错，归为 other', () => {
  const odd: unknown[] = [
    {},
    { door: 'tool-result' },
    { door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, message: { type: 'user' } },
    { door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, message: { type: 'user', role: 'user', content: 'not an array' } },
    { door: 'response', origin: null, message: { type: 'assistant', content: [null, 5, { type: 'mystery' }] } },
    { door: 'delivery', origin: { kind: 'engine' }, message: { type: 'attachment', role: 'user', content: [{ type: 'tool_result', content: { a: 1 } }] } },
    null,
  ]
  for (const e of odd) {
    const row = rowOf(e as never)
    expect(kindOf(row)).toBe('other')
    expect(applyRow(emptyJournal(), row, kindOf(row))).toEqual(emptyJournal())
  }
})

test('applyRow 不改它收到的记录', () => {
  const before = feed(script('one', 1, [innerCall('Bash')], pollResult(1, 'ok')))
  const copy = JSON.parse(JSON.stringify(before))
  const rows = [assistantText('next'), ...script('two', 2, [innerCall('Edit', { error: 'denied' })], pollResult(2, 'bad', { error: true }))]
  let j = before
  for (const e of rows) {
    const row = rowOf(e)
    const next = applyRow(j, row, kindOf(row))
    expect(next).not.toBe(j)
    j = next
  }
  expect(before).toEqual(copy)
})
