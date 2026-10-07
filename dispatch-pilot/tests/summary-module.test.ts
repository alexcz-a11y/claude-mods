// The problem summary's pure module (#40, seam 2): what the cheap model is asked, how its reply becomes the
// summary's fixed structure within 500 tokens, how the summary is worded for the decision model, and how the
// effort part of a message's decision request carries it (the eval builds the same part).

import { expect, test } from 'claude-code/testing'
import { estimateTokens, turnStartState, type ContextMessage } from '../hooks/decision/context.ts'
import { markLast, readSummary, renderSummary, summaryPrompt, SUMMARY_FIELD, SUMMARY_SYSTEM, SUMMARY_TOKENS, turnTools, type Summary } from '../hooks/decision/summary.ts'
import { messageRequest, turnStartPart } from '../hooks/decision/turn-start.ts'

test('a reply is read into the fixed structure: the problem in a sentence, what was tried item by item (the marked one flagged), the status', () => {
  const reply = ['Here is the record:', '```json', '{"problem": "登录接口返回 502", "tried": ["把超时调到 30 秒", "换成 fake timers [unresolved]"], "status": "助手改了配置，等用户再试"}', '```'].join('\n')

  expect(readSummary(reply)).toEqual({
    problem: '登录接口返回 502',
    tried: [{ text: '把超时调到 30 秒' }, { text: '换成 fake timers', unresolved: true }],
    status: '助手改了配置，等用户再试',
  } satisfies Summary)
})

test('a reply that is not that structure is no summary: no object, no problem, tried that is not a list, items that are not text', () => {
  expect(readSummary('I could not tell what the problem is.')).toBeNull()
  expect(readSummary('{"problem": "", "tried": [], "status": "x"}')).toBeNull()
  expect(readSummary('{"problem": "p", "tried": "one thing", "status": "x"}')).toBeNull()
  expect(readSummary('{"problem": "p", "tried": [1, 2], "status": "x"}')).toBeNull()
  expect(readSummary('{"problem": "p", "tried": [], "status": 3}')).toBeNull()
  expect(readSummary('{"problem": "p", "tried": ["a"]')).toBeNull()
})

test(`what the reply holds is cut to ${SUMMARY_TOKENS} tokens: the earliest tries are merged into one and the newest stay as written`, () => {
  const tries = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 次：${'把配置里的某一项改成另一个值再重启服务，'.repeat(3)}`)
  const summary = readSummary(JSON.stringify({ problem: '服务启动后立刻退出', tried: tries, status: '助手在等日志' }))

  expect(summary).not.toBeNull()
  const kept = summary as Summary
  expect(estimateTokens(renderSummary(kept, 'zh'))).toBeLessThanOrEqual(SUMMARY_TOKENS)
  expect(kept.problem).toBe('服务启动后立刻退出')
  // The newest tries are untouched; what came before them is one item.
  expect(kept.tried.at(-1)?.text).toBe(tries.at(-1))
  expect(kept.tried.length).toBeLessThan(tries.length)
  expect(kept.tried[0]?.text).toContain('第 1 次')
})

const SUMMARY: Summary = {
  problem: '登录接口返回 502',
  tried: [{ text: '把超时调到 30 秒', unresolved: true }, { text: '换成 fake timers' }],
  status: '助手在等日志',
}

test('the decision model reads the summary as text in the language of its questions: the problem, the tries numbered with the unresolved one said so, the status', () => {
  expect(renderSummary(SUMMARY, 'zh')).toBe(['问题：登录接口返回 502', '试过：', '1. 把超时调到 30 秒（未解决）', '2. 换成 fake timers', '状态：助手在等日志'].join('\n'))
  expect(renderSummary({ problem: 'Login returns 502', tried: [{ text: 'raised the timeout', unresolved: true }], status: 'waiting for the log' }, 'en')).toBe(
    ['Problem: Login returns 502', 'Tried:', '1. raised the timeout (unresolved)', 'Status: waiting for the log'].join('\n'),
  )
})

test('the cheap model is given the record so far (as it must answer, the unresolved try marked), the person\'s words, the assistant\'s final reply and its tools, with secrets masked first', () => {
  const prompt = summaryPrompt({
    previous: SUMMARY,
    person: '还是 502，我的 token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
    reply: '我把 DB_PASSWORD=hunter2hunter2 的配置查了一遍，没发现问题',
    tools: 'Bash x3 (1 failed), Edit',
  })

  expect(prompt).toContain('把超时调到 30 秒 [unresolved]')
  expect(prompt).toContain('还是 502')
  expect(prompt).toContain('没发现问题')
  expect(prompt).toContain('Bash x3 (1 failed), Edit')
  expect(prompt).not.toContain('sk-ant-api03')
  expect(prompt).not.toContain('hunter2hunter2')
  expect(prompt).toContain('[REDACTED]')
  // No record yet: it says so, and the model starts one.
  expect(summaryPrompt({ previous: null, person: '开始', reply: '好', tools: '' })).toMatch(/none yet/i)
  // The standing instructions fix the length and keep results out of it.
  expect(SUMMARY_SYSTEM).toContain(String(SUMMARY_TOKENS))
})

test('a long turn is cut before it is sent: the person\'s words and the reply keep their beginning and end', () => {
  const log = `${'start of the reply. '}${'ETIMEDOUT retry 7 of order-49 failed '.repeat(8000)}the end of the reply.`
  const prompt = summaryPrompt({ previous: null, person: '看一下', reply: log, tools: 'Bash' })

  expect(estimateTokens(prompt)).toBeLessThan(6000)
  expect(prompt).toContain('start of the reply.')
  expect(prompt).toContain('the end of the reply.')
})

test('the tools of the turn that just ended are the ones called after the person\'s last message, worded as the decision model reads tools', () => {
  const rows: ContextMessage[] = [
    { role: 'user', text: '先看看这个' },
    { role: 'assistant', text: '看过了', toolUses: [{ tool: 'Read' }] },
    { role: 'user', text: '还是 502' },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Bash' }, { tool: 'Bash', isError: true }] },
    { role: 'user', text: '' }, // the tool results come as a row of the person's with no words
    { role: 'assistant', text: '改好了', toolUses: [{ tool: 'Edit' }, { tool: 'Bash' }] },
  ]

  expect(turnTools(rows)).toBe('Bash x3 (1 failed), Edit')
  // A turn of words alone called none; a transcript of nothing, none either.
  expect(turnTools([{ role: 'user', text: '你好' }, { role: 'assistant', text: '你好' }])).toBe('')
  expect(turnTools([])).toBe('')
})

test('the effort part of a message\'s request is the effort question; the unresolved question joins it when asked, and the command and the summary are fields of the state', () => {
  const plain = turnStartPart({ ask: { language: 'zh' } })
  expect(plain.part).toBe('effort')
  expect(Object.keys(plain.questions)).toEqual(['level'])
  expect(plain.state).toBeUndefined()

  const full = turnStartPart({ ask: { language: 'zh' }, unresolved: true, command: { name: 'debug', description: '系统地排查一个故障' }, summary: SUMMARY })
  // Still the effort part: it goes in the request of its own, with the state of 24000 tokens.
  expect(full.part).toBe('effort')
  expect(Object.keys(full.questions)).toEqual(['level', 'unresolved'])
  expect(full.state).toEqual({ command: { name: 'debug', description: '系统地排查一个故障' }, [SUMMARY_FIELD]: renderSummary(SUMMARY, 'zh') })

  // In English (Clef) the summary is worded in English, like the questions.
  const english = turnStartPart({ ask: { language: 'en' }, summary: SUMMARY })
  expect(english.state).toEqual({ [SUMMARY_FIELD]: renderSummary(SUMMARY, 'en') })
  expect(Object.keys(english.questions)).toEqual(['level'])
})

test('the fields a part adds to the state are counted in the state\'s budget: the conversation gives way to them, so the whole state still fits (Clef reads only the head of a long state, and sorts its keys)', () => {
  const messages: ContextMessage[] = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 === 0 ? ('user' as const) : ('assistant' as const), text: `第 ${i} 轮：${'把配置里的某一项改成另一个值再重启服务。'.repeat(6)}` }))
  const part = turnStartPart({ ask: { language: 'en' }, summary: { ...SUMMARY, tried: Array.from({ length: 6 }, (_, i) => ({ text: `第 ${i} 次：${'把配置里的某一项改成另一个值再重启服务，'.repeat(3)}` })) } })
  const limits = { messages: 32, tokens: 2000 }
  const withSummary = messageRequest({ prompt: '还是不行', messages, limits, parts: [part] })
  const without = messageRequest({ prompt: '还是不行', messages, limits, parts: [turnStartPart({ ask: { language: 'en' } })] })

  expect(estimateTokens(JSON.stringify(withSummary.state))).toBeLessThanOrEqual(2000)
  expect(estimateTokens(JSON.stringify(without.state))).toBeLessThanOrEqual(2000)
  // The summary is whole, the message too; the conversation is what gave way.
  expect(withSummary.state.user_message).toBe('还是不行')
  expect(String(withSummary.state[SUMMARY_FIELD])).toContain('第 5 次')
  expect(estimateTokens(String(withSummary.state.recent_context))).toBeLessThan(estimateTokens(String(without.state.recent_context)))
  // A part with no fields leaves the budget as it was.
  expect(without.state).toEqual(turnStartState({ prompt: '还是不行', messages, limits }))
})

test('"still unresolved" marks the last try, and only that one; a summary with no tries has none to mark', () => {
  const marked = markLast({ ...SUMMARY, tried: [{ text: 'a' }, { text: 'b' }] })
  expect(marked.tried).toEqual([{ text: 'a' }, { text: 'b', unresolved: true }])
  expect(markLast({ problem: 'p', tried: [], status: 's' }).tried).toEqual([])
})
