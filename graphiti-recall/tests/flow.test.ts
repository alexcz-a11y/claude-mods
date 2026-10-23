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
  // A recall that answers at once beats the turn's 6-second wait.
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
