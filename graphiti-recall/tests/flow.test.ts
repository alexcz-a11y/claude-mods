import type { TestBody } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'
import { register } from '../hooks/graphiti-recall.ts'

const FACT = { uuid: '11111111-1111-1111-1111-111111111111', fact: 'Desktop carries Claude Code 2.1.308', source_node_uuid: 'n1' }

test('a message gets a marked block beside it; an acknowledgement gets none', async ($, on) => {
  // Nothing sits beneath the mod: these hooks stand for the engine and the graphiti server.
  const calls: string[] = []
  on('session.start', { cwd: '/repo' }, (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.309', builtAt: '' } }))
  on('command.register', () => ({ value: { command: 'recall' } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/repo', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: 'graphiti\n' }))
  on('mcp.call', (_, e) => {
    calls.push(e.tool)
    const body = e.tool === 'recall' ? { facts: [FACT], nodes: [] } : { episodes: [] }
    return { value: { content: [{ type: 'text', text: JSON.stringify({ result: body }) }], isError: false } }
  })
  on('prompt.submit', { wait: false }, (_, e) => ({ text: e.text, context: e.context }))
  const lines: string[] = []
  on('ui.log', (_, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  // A recall that answers at once beats the turn's 8-second wait.
  on('clock.sleep', async () => {
    for (let i = 0; i < 200; i++) await Promise.resolve()
    return { value: undefined }
  })
  register(on, {})

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r = await $.prompt.submit({ text: 'Desktop 里的 Claude Code 版本', wait: false, origin: { kind: 'composer' } })
  const block = (r.context ?? []).find(c => c.includes('[graphiti-recall #r1'))
  expect(block?.includes('group_id=graphiti')).toBe(true)
  expect(block?.includes('Desktop carries Claude Code 2.1.308')).toBe(true)

  const ack = await $.prompt.submit({ text: 'ok', wait: false, origin: { kind: 'composer' } })
  expect((ack.context ?? []).some(c => c.includes('graphiti-recall #'))).toBe(false)
  expect(calls.filter(t => t === 'recall').length).toBe(1)
})

test('a failed Bash call is searched with its command and error line, not "Exit code 1"', async ($, on) => {
  const queries: string[] = []
  on('session.start', { cwd: '/repo' }, (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.309', builtAt: '' } }))
  on('command.register', () => ({ value: { command: 'recall' } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/repo', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: 'graphiti\n' }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'recall') queries.push(e.args.query as string)
    const body = e.tool === 'recall' ? { facts: [FACT], nodes: [] } : { episodes: [] }
    return { value: { content: [{ type: 'text', text: JSON.stringify({ result: body }) }], isError: false } }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '' }, text: 'Exit code 1\nnpm ERR! missing script: build', isError: true }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.sleep', async () => {
    for (let i = 0; i < 200; i++) await Promise.resolve()
    return { value: undefined }
  })
  register(on, {})

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: 'Bash', command: 'npm run build' } as never)
  expect(queries).toEqual(['npm run build · npm ERR! missing script: build'])
  expect((r.context ?? []).some(c => c.includes('[graphiti-recall #r1'))).toBe(true)
})

function server(on: Parameters<TestBody>[1], queries: string[], lines: string[]) {
  on('session.start', { cwd: '/repo' }, (_, e) => ({ cwd: e.cwd }))
  on('session.version', () => ({ value: { version: '2.1.309', builtAt: '' } }))
  on('command.register', () => ({ value: { command: 'recall' } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/repo', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: 'graphiti\n' }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'recall') queries.push(e.args.query as string)
    const body = e.tool === 'recall' ? { facts: [FACT], nodes: [] } : { episodes: [] }
    return { value: { content: [{ type: 'text', text: JSON.stringify({ result: body }) }], isError: false } }
  })
  on('prompt.submit', { wait: false }, (_, e) => ({ text: e.text, context: e.context }))
  on('ui.log', (_, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('clock.sleep', async () => {
    for (let i = 0; i < 200; i++) await Promise.resolve()
    return { value: undefined }
  })
}

const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

test('a message is searched with the keywords Haiku rewrote it into, and the line shows them', async ($, on) => {
  const queries: string[] = []
  const lines: string[] = []
  const sent: string[] = []
  server(on, queries, lines)
  on('model.complete', (_, e) => {
    sent.push(typeof e.prompt === 'string' ? e.prompt : '')
    return { value: { isAnswered: true, text: 'Cohere 重排模型 rerank model', usage } }
  })
  register(on, { rewriteModel: 'haiku' })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r = await $.prompt.submit({ text: '<system-reminder>x</system-reminder>你先回忆一下，我们的cohere目前用的是哪一个模型？', wait: false, origin: { kind: 'composer' } })
  expect(queries).toEqual(['Cohere 重排模型 rerank model'])
  expect(sent[0]?.includes('system-reminder')).toBe(false)
  expect((r.context ?? []).some(c => c.includes('查询：Cohere 重排模型 rerank model'))).toBe(true)
})

test('a failed rewrite falls back to the plain query and says so; 无 searches nothing', async ($, on) => {
  const queries: string[] = []
  const lines: string[] = []
  let reply: { isAnswered: false; reason: 'aborted'; usage: typeof usage } | { isAnswered: true; text: string; usage: typeof usage } = { isAnswered: false, reason: 'aborted', usage }
  server(on, queries, lines)
  on('model.complete', () => ({ value: reply }))
  register(on, {})

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r = await $.prompt.submit({ text: 'Desktop 里的 Claude Code 版本', wait: false, origin: { kind: 'composer' } })
  expect(queries).toEqual(['Desktop 里的 Claude Code 版本'])
  expect((r.context ?? []).some(c => c.includes('改写未成：超时'))).toBe(true)

  reply = { isAnswered: true, text: '无', usage }
  await $.prompt.submit({ text: '请待命', wait: false, origin: { kind: 'composer' } })
  expect(queries.length).toBe(1)
  expect(lines.some(l => l.includes('没有可检索的主题'))).toBe(true)
})
