// Pure parts of graphiti-recall: the partition rule, what to search for, how a recall reads to the
// model. No `$` here, so tests run them directly.

export type Fact = {
  uuid: string
  fact: string
  source_node_uuid?: string
  valid_at?: string | null
  expired_at?: string | null
  score?: number | null
}
export type Entity = { uuid: string; name: string; summary?: string; score?: number | null }
export type Recalled = { facts: Fact[]; nodes: Entity[] }

const ID = /^[a-zA-Z0-9_-]+$/

export const isGroupId = (id: string) => ID.test(id)

// Rule 2 of the partition: origin URL host + path, lowercased, `.git` stripped, every run outside
// a-z0-9 → `-`. `git@github.com:Acme/App.git` → `repo_github-com-acme-app`.
export function repoSlug(origin: string): string {
  const url = origin.trim().replace(/\.git$/i, '')
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(url)
  let hostPath = url
  if (scp) hostPath = `${scp[1]}/${scp[2]}`
  else {
    try {
      const u = new URL(url)
      hostPath = `${u.hostname}${u.pathname}`
    } catch {
      // a local path or something unusual: slug it as it is
    }
  }
  return `repo_${hostPath.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
}

const ACK = /^(ok|okay|k|好|好的|行|嗯|嗯嗯|对|是|是的|继续|可以|没问题|收到|谢谢|thanks|thank you|yes|y|go|👍)[\s。.!！~]*$/i
const FENCE = /```[\s\S]*?```/g
const PASTED = /<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g

// Identifiers worth searching for even inside pasted text or code: paths, ticket numbers,
// `backticked` names, snake_case and CamelCase words.
export function identifiers(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) found.add(m[1] as string)
  for (const m of text.matchAll(/(?:~|\.{1,2})?\/?[\w.@-]+(?:\/[\w.@-]+)+/g)) found.add(m[0])
  for (const m of text.matchAll(/#\d{1,6}\b/g)) found.add(m[0])
  for (const m of text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g)) found.add(m[0])
  return [...found].slice(0, 12)
}

// What a user message is searched with: its own words; code and pasted blocks give only their
// identifiers. Null for a message that needs no recall (an acknowledgement, nothing left).
export function promptQuery(text: string): string | null {
  const t = text.trim()
  if (!t || ACK.test(t)) return null
  const quoted = [...t.matchAll(FENCE), ...t.matchAll(PASTED)].map(m => m[0]).join('\n')
  const body = t.replace(FENCE, ' ').replace(PASTED, ' ').replace(/\s+/g, ' ').trim()
  const ids = identifiers(quoted).filter(id => !body.includes(id))
  const head = body.length > 300 ? body.slice(0, 300) : body
  const q = [head, ...ids].filter(Boolean).join(' ').slice(0, 400).trim()
  return q.length >= 2 ? q : null
}

const RISKY =
  /\b(ssh|scp|rsync|docker|kubectl|terraform|up\.sh|deploy)\b|\bgit\s+(commit|push|merge|rebase|reset)\b|\bgh\s+(pr|issue|release)\s+(create|merge|edit|close)\b|\brm\s+-[a-zA-Z]*[rf]/

export const isRisky = (command: string) => RISKY.test(command)

const SECRET = /((?:token|key|secret|passw(?:or)?d|auth)[\w-]*\s*[=:]\s*)\S+/gi
// Long runs read as keys; `/` is left out so a long path stays readable.
const LONG = /[A-Za-z0-9+_=-]{32,}/g

const redact = (text: string) => text.replace(SECRET, '$1***').replace(LONG, '***').replace(/\s+/g, ' ').trim()

// A leading `cd <dir> &&` keeps only the folder's name: the rest of the path says nothing.
const CD = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/

export function commandQuery(command: string): string {
  const cd = CD.exec(command.trim())
  const dir = cd ? (cd[1] as string).replace(/^["']|["']$/g, '').replace(/\/+$/, '').split('/').at(-1) : ''
  const rest = cd ? command.trim().slice(cd[0].length) : command
  return redact(`${dir ? `${dir}: ` : ''}${rest}`).slice(0, 120)
}

// Lines a failed tool's output opens or pads with that say nothing about what went wrong.
const NOISE = /^(exit code -?\d+|errors?:?|traceback \(most recent call last\):|shell cwd was reset to .*)$/i
const EXCEPTION = /^[\w.$]*(error|exception)\b[^:]*:\s*\S/i
const FAILURE =
  /\b(error|fail(ed|ure)?|fatal|denied|refused|not found|no such|cannot|can't|unable|timed? ?out|invalid|unknown|missing|blocked)\b|错误|失败|拒绝|超时|找不到/i

// The line of a failed tool's output that says what went wrong: an exception line, else the first
// line naming a failure, else the first line that is not noise.
export function errorLine(text: string): string | null {
  const lines = text
    .replace(/<\/?tool_use_error>/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 3 && !NOISE.test(l))
  const line = lines.find(l => EXCEPTION.test(l)) ?? lines.find(l => FAILURE.test(l)) ?? lines[0]
  return line ? redact(line).slice(0, 120) : null
}

// What a failed tool call is searched with: what ran (the command, the file, the MCP tool), then
// the line saying what went wrong. `Exit code 1` alone finds nothing.
export function failureQuery(
  tool: string,
  input: { command?: string; file_path?: string; notebook_path?: string },
  text: string,
  cwd: string,
): string | null {
  const path = input.file_path ?? input.notebook_path
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  const subject =
    tool === 'Bash' && input.command
      ? commandQuery(input.command)
      : path
        ? path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
        : mcp
          ? `${mcp[1]} ${mcp[2]}`
          : tool
  const q = [subject, errorLine(text)].filter(Boolean).join(' · ')
  return q.length >= 2 ? q : null
}

const SKIP_PATH = /(^|\/)(node_modules|\.git|\.claude-plugin\/types)(\/|$)|^\/private\/tmp\/|^\/tmp\/|\/\.claude\/plugins\//

// A file the session reads or edits for the first time: its path relative to the project, its
// name, its folder. Null for files no memory is about (dependencies, scratch, caches).
export function fileQuery(path: string, cwd: string): string | null {
  if (SKIP_PATH.test(path)) return null
  const rel = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
  const parts = rel.split('/')
  const name = parts.at(-1) ?? rel
  const dir = parts.at(-2)
  return [rel, name.replace(/\.[^.]+$/, ''), dir].filter(Boolean).join(' ')
}

// The topic a later recall can follow up on with a center node: a file, else the first ticket or
// identifier of the query.
export function topicOf(query: string): string | null {
  return identifiers(query)[0] ?? null
}

export function parseToolText(text: string): unknown {
  try {
    const body = JSON.parse(text) as Record<string, unknown>
    return 'result' in body && body.result && typeof body.result === 'object' ? body.result : body
  } catch {
    return null
  }
}

export function parseRecall(text: string): Recalled | { error: string } {
  const body = parseToolText(text) as Record<string, unknown> | null
  if (!body) return { error: `unreadable reply: ${text.slice(0, 120)}` }
  if (typeof body.error === 'string') return { error: body.error }
  const facts = Array.isArray(body.facts) ? (body.facts as Fact[]) : []
  const nodes = Array.isArray(body.nodes) ? (body.nodes as Entity[]) : []
  return { facts, nodes }
}

const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : '')

// The block the model reads. Every line is whole; lines that would pass `budget` characters are
// left out, facts before entities.
export function renderBlock(id: string, groupId: string, query: string, r: Recalled, budget: number): string {
  const head = `[graphiti-recall #${id} · group_id=${groupId} · 查询：${query.slice(0, 120)}]`
  const lines = [head, '自动召回的记忆，按相关度排列（已作废的标出，保留作历史）：']
  let used = lines.join('\n').length
  const push = (line: string) => {
    if (used + line.length + 1 > budget) return false
    lines.push(line)
    used += line.length + 1
    return true
  }
  for (const f of r.facts) {
    const when = day(f.valid_at)
    const gone = f.expired_at ? ` [已作废 ${day(f.expired_at)}]` : ''
    if (!push(`- ${f.fact}${when ? `（${when}）` : ''}${gone}`)) break
  }
  if (r.nodes.length && push('实体：')) {
    for (const n of r.nodes) {
      const summary = (n.summary ?? '').split('\n')[0]?.slice(0, 160) ?? ''
      if (!push(`- ${n.name}${summary ? ` — ${summary}` : ''}`)) break
    }
  }
  return lines.join('\n')
}

export function renderDirectory(groupId: string, episodes: { name: string; at?: string }[]): string {
  const lines = [`[graphiti-recall 目录 · group_id=${groupId}] 近期记忆（标题与日期，内容需要时再查）：`]
  for (const e of episodes) lines.push(`- ${day(e.at)} ${e.name}`)
  return lines.join('\n')
}

// `a` at least `b`, both dotted version numbers.
export function atLeast(a: string, b: string): boolean {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return true
}

export const MARK = /graphiti-recall #(r\d+)/g
export const idsIn = (text: string) => [...text.matchAll(MARK)].map(m => m[1] as string)
export const uuidsIn = (text: string) => [...text.matchAll(/"uuid"\s*:\s*"([0-9a-f-]{36})"/g)].map(m => m[1] as string)
