import { expect, test } from 'claude-code/testing'
import { commandQuery, errorLine, failureQuery, fileQuery, isRisky, parseRecall, promptQuery, renderBlock, repoSlug } from '../hooks/core.ts'

test('the partition slug follows the rule for scp-style and https remotes', () => {
  expect(repoSlug('git@github.com:Acme/App.git')).toBe('repo_github-com-acme-app')
  expect(repoSlug('https://github.com/alexcz-a11y/claude-mods.git')).toBe('repo_github-com-alexcz-a11y-claude-mods')
})

test('acknowledgements are not searched; a message is searched with its own words', () => {
  expect(promptQuery('ok')).toBe(null)
  expect(promptQuery('继续')).toBe(null)
  expect(promptQuery('graphiti 检索分数线 中心节点')).toBe('graphiti 检索分数线 中心节点')
})

test('code and pasted text give only their identifiers', () => {
  const q = promptQuery('为什么报错？\n```\nFile "ops/scripts/bulk_add.py", line 3\nNameError: graphiti_service\n```') as string
  expect(q.startsWith('为什么报错？')).toBe(true)
  expect(q.includes('ops/scripts/bulk_add.py')).toBe(true)
  expect(q.includes('line 3')).toBe(false)
})

test('risky commands are recognised and their secrets masked', () => {
  expect(isRisky('git push origin main')).toBe(true)
  expect(isRisky('ls -la')).toBe(false)
  expect(commandQuery('curl -H token=abcd1234 https://x')).toBe('curl -H token=*** https://x')
  expect(commandQuery('cd /Users/a/Documents/claude-mods && git push')).toBe('claude-mods: git push')
  expect(commandQuery('cat /Users/alexnear/Documents/claude-mods/graphiti-recall/README.md')).toBe('cat /Users/alexnear/Documents/claude-mods/graphiti-recall/README.md')
  expect(commandQuery(`curl -d ${'a1'.repeat(20)} x`)).toBe('curl -d *** x')
})

test('a failed tool is searched with what ran and the line saying what went wrong, not its exit code', () => {
  expect(errorLine('Exit code 1\n')).toBe(null)
  expect(failureQuery('Bash', { command: 'ssh Gragh docker restart graphiti-mcp' }, 'Exit code 255\nssh: connect to host gragh port 22: Connection refused', '/r'))
    .toBe('ssh Gragh docker restart graphiti-mcp · ssh: connect to host gragh port 22: Connection refused')
  expect(failureQuery('Bash', { command: 'python3 ops/x.py' }, 'Exit code 1\nTraceback (most recent call last):\n  File "ops/x.py", line 1, in <module>\n    import neo4j\nModuleNotFoundError: No module named \'neo4j\'', '/r'))
    .toBe("python3 ops/x.py · ModuleNotFoundError: No module named 'neo4j'")
  expect(failureQuery('Read', { file_path: '/r/ops/A.md' }, '<tool_use_error>File does not exist.</tool_use_error>', '/r')).toBe('ops/A.md · File does not exist.')
  expect(failureQuery('mcp__graphiti__get_status', {}, 'Exit code 1', '/r')).toBe('graphiti get_status')
})

test('files under dependencies and scratch are not searched', () => {
  expect(fileQuery('/r/node_modules/a/index.js', '/r')).toBe(null)
  expect(fileQuery('/r/ops/OPS-NOTES.md', '/r')).toBe('ops/OPS-NOTES.md OPS-NOTES ops')
})

test('a recall reply is read whether or not it is wrapped in result', () => {
  const r = parseRecall('{"result":{"facts":[{"uuid":"u1","fact":"A"}],"nodes":[]}}')
  expect('facts' in r && r.facts.length).toBe(1)
  expect('error' in parseRecall('{"error":"boom"}')).toBe(true)
})

test('the block marks superseded facts and keeps to its budget', () => {
  const block = renderBlock('r1', 'graphiti', 'q', {
    facts: [
      { uuid: 'u1', fact: 'current fact', valid_at: '2026-10-20T00:00:00Z' },
      { uuid: 'u2', fact: 'old fact', expired_at: '2026-10-21T00:00:00Z' },
      { uuid: 'u3', fact: 'x'.repeat(500) },
    ],
    nodes: [],
  }, 300)
  expect(block.includes('[graphiti-recall #r1 · group_id=graphiti')).toBe(true)
  expect(block.includes('old fact [已作废 2026-10-21]')).toBe(true)
  expect(block.includes('x'.repeat(500))).toBe(false)
})
