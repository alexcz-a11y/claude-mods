import type { EngineInterface, Register } from 'claude-code'
import {
  atLeast,
  commandQuery,
  errorQuery,
  fileQuery,
  idsIn,
  isGroupId,
  isRisky,
  parseRecall,
  parseToolText,
  promptQuery,
  type Recalled,
  renderBlock,
  renderDirectory,
  repoSlug,
  topicOf,
  uuidsIn,
} from './core.ts'

// Searches Graphiti for the model through the server's `recall` tool and injects what clears its
// relevance floor: beside the user's message, after some tool results, and into a subagent's task.
// Each recall gets one dim transcript line (`$.ui.log`, which the model never reads) naming the
// query and whether the block really reached the model's request.

const SERVER = 'graphiti'
const MIN_VERSION = '2.1.304'
const TURN_WAIT_MS = 6_000 // the turn starts without the block after this; it rides on the next tool result
const TOOL_GRACE_MS = 3_000 // how long a finished tool waits for its recall
const SLOW_MS = 8_000 // a recall slower than this, or failing, pauses recall
const PAUSE_MS = 5 * 60_000
const MAX_FAILS = 3
const MID_TURN_MAX = 3
const BUDGET = { turn: 3_000, tool: 1_200, agent: 1_200 }
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit'])
const QUIET_TOOLS = /^(mcp__graphiti__|mcp__ccd_|mcp__graphiti-recall__)|^(ToolSearch|TodoWrite|Skill|AskUserQuestion|EnterPlanMode|ExitPlanMode)$/

type Where = 'turn' | 'tool' | 'agent'
type Gate = {
  id: string
  where: Where
  label: string
  query: string
  agentId?: string
  stored: boolean
  steps: number
  done: boolean
  summary: string
  block: string
}

let cwd = ''
let groupId: string | null = null
let disabledWhy: string | null = null
let enabled = true
let pausedUntil = 0
let fails = 0
let seq = 0
let directory: string | null = null
let midTurn = 0
let step = -1
let lastInjectStep = -2
let carried: { id: string; block: string; summary: string; label: string; query: string } | null = null
let calls = 0
let injectedItems = 0
const seen = new Set<string>()
const filesSeen = new Set<string>()
const topics = new Map<string, string>() // topic → source_node_uuid of the last recall's top fact
const gates = new Map<string, Gate>()
const last: Gate[] = []

const now = () => Date.now()
const label = (where: Where, what: string) => `${{ turn: '轮首', tool: '工具后', agent: '子代理' }[where]}${what ? ` · ${what}` : ''}`

function line($: EngineInterface, text: string) {
  $.ui.log(`记忆召回 ${text}`)
}

function status($: EngineInterface) {
  $.ui.status(enabled && !disabledWhy ? `记忆 ↻ ${calls} 次 / ${injectedItems} 条` : undefined)
}

async function partition($: EngineInterface, cwd: string): Promise<string | null> {
  const git = async (...args: string[]) => {
    const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 5_000 })
    return r.exitCode === 0 ? r.stdout.trim() : null
  }
  const top = await git('rev-parse', '--show-toplevel')
  const fileAt = async (dir: string) => {
    const p = `${dir}/.graphiti-group-id`
    return (await $.fs.exists(p)) ? (await $.fs.read(p)).trim() : null
  }
  if (top) {
    const pinned = await fileAt(top)
    if (pinned) return pinned
    const origin = await git('remote', 'get-url', 'origin')
    if (origin) return repoSlug(origin)
    disabledWhy = '这个仓库没有 origin，按规则要先建 .graphiti-group-id'
    return null
  }
  for (let dir = cwd; dir && dir !== '/'; dir = dir.slice(0, dir.lastIndexOf('/')) || '/') {
    const pinned = await fileAt(dir)
    if (pinned) return pinned
  }
  return 'life'
}

function ready(): boolean {
  return enabled && !disabledWhy && groupId !== null && now() >= pausedUntil
}

async function recall($: EngineInterface, query: string, center?: string): Promise<Recalled | { error: string }> {
  const t = now()
  try {
    const r = await $.mcp.call(SERVER, 'recall', {
      query,
      group_ids: [groupId],
      max_facts: 8,
      max_nodes: 3,
      ...(center ? { center_node_uuid: center } : {}),
    })
    const text = r.content.map(b => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('')
    const out = r.isError ? { error: text.slice(0, 160) || 'error' } : parseRecall(text)
    const slow = now() - t > SLOW_MS
    if ('error' in out || slow) fail($, 'error' in out ? out.error : `检索用了 ${Math.round((now() - t) / 1000)} 秒`)
    else fails = 0
    return out
  } catch (err) {
    fail($, String(err).slice(0, 160))
    return { error: String(err).slice(0, 160) }
  }
}

function fail($: EngineInterface, why: string) {
  fails += 1
  pausedUntil = now() + PAUSE_MS
  if (fails >= MAX_FAILS) {
    disabledWhy = `连续 ${fails} 次失败（${why}）`
    line($, `· 本会话已停用：${disabledWhy}`)
  } else line($, `· 暂停 5 分钟：${why}`)
  status($)
}

// Drops what this session already injected or the model already read in its own searches.
function fresh(r: Recalled): Recalled {
  return { facts: r.facts.filter(f => !seen.has(f.uuid)), nodes: r.nodes.filter(n => !seen.has(n.uuid)) }
}

function prepare(where: Where, what: string, query: string, r: Recalled, agentId?: string): Gate | null {
  const kept = fresh(r)
  if (!kept.facts.length && !kept.nodes.length) return null
  const id = `r${++seq}`
  const block = renderBlock(id, groupId as string, query, kept, BUDGET[where])
  const shown = { facts: kept.facts.filter(f => block.includes(f.fact)), nodes: kept.nodes.filter(n => block.includes(`- ${n.name}`)) }
  for (const x of [...shown.facts, ...shown.nodes]) seen.add(x.uuid)
  const summary = `${shown.facts.length} 条事实${shown.nodes.length ? `、${shown.nodes.length} 个实体` : ''}`
  const gate: Gate = { id, where, label: label(where, what), query, agentId, stored: false, steps: 0, done: false, summary, block }
  gates.set(id, gate)
  last.push(gate)
  if (last.length > 20) last.shift()
  return gate
}

function settle($: EngineInterface, gate: Gate, verdict: string, injected: boolean) {
  if (gate.done) return
  gate.done = true
  if (injected) injectedItems += Number(gate.summary.match(/\d+/g)?.reduce((a, b) => a + Number(b), 0) ?? 0)
  line($, `#${gate.id} · ${gate.label} · 查询「${gate.query.slice(0, 60)}」 · ${verdict}`)
  status($)
}

function nothing($: EngineInterface, where: Where, what: string, query: string, r: Recalled | { error: string }) {
  const verdict = 'error' in r ? `检索失败：${r.error.slice(0, 80)}` : '无相关记忆，未注入'
  line($, `· ${label(where, what)} · 查询「${query.slice(0, 60)}」 · ${verdict}`)
}

function topFact(r: Recalled | { error: string }) {
  return 'error' in r ? undefined : r.facts[0]?.source_node_uuid
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    cwd = e.cwd
    const version = (await $.session.version()).version
    if (!atLeast(version, MIN_VERSION)) {
      disabledWhy = `Claude Code ${version} 低于 ${MIN_VERSION}`
      $.ui.toast(`graphiti-recall 未启用：${disabledWhy}`)
      return r
    }
    await $.command.register({ name: 'recall', description: '记忆召回：on / off / last（最近几次注入了什么）', argumentHint: 'on|off|last' })
    try {
      const id = await partition($, e.cwd)
      if (id && isGroupId(id)) groupId = id
      else if (!disabledWhy) disabledWhy = `分区判定得到不合法的 id「${id}」`
    } catch (err) {
      disabledWhy = `分区判定失败：${String(err).slice(0, 120)}`
    }
    if (disabledWhy) {
      line($, `· 未启用：${disabledWhy}`)
      return r
    }
    try {
      const res = await $.mcp.call(SERVER, 'get_episodes', { group_ids: [groupId], max_episodes: 20 })
      const text = res.content.map(b => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('')
      const body = parseToolText(text) as { episodes?: { name: string; valid_at?: string; created_at?: string }[] } | null
      const eps = (body?.episodes ?? []).map(x => ({ name: x.name, at: x.valid_at ?? x.created_at }))
      if (eps.length) directory = renderDirectory(groupId as string, eps)
    } catch {
      // the first recall reports an unreachable server
    }
    status($)
    return r
  })

  on('command.run', { command: 'recall' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off') enabled = false
    if (arg === 'on') {
      enabled = true
      pausedUntil = 0
    }
    status($)
    if (arg === 'last') {
      const text = last.length
        ? last.slice(-5).map(g => `#${g.id} ${g.label} 「${g.query.slice(0, 60)}」\n${g.block}`).join('\n\n')
        : '本会话还没有注入过记忆。'
      return { text }
    }
    const state = disabledWhy ? `未启用：${disabledWhy}` : enabled ? `开启（group_id=${groupId}）` : '已关闭'
    return { text: `记忆召回：${state}。本会话 ${calls} 次检索，注入 ${injectedItems} 条。` }
  })

  on('prompt.submit', async ($, e, next) => {
    midTurn = 0
    if (e.command || e.isMeta) return next(e)
    const context = [...(e.context ?? [])]
    if (directory) {
      context.push(directory)
      directory = null
    }
    const query = ready() ? promptQuery(e.text) : null
    if (!query) return context.length === (e.context ?? []).length ? next(e) : next({ ...e, context })
    calls += 1
    const topic = topicOf(query)
    const pending = recall($, query, topic ? topics.get(topic) : undefined)
    const early = await Promise.race([pending, $.clock.sleep(TURN_WAIT_MS).then(() => null)])
    if (early === null) {
      // Too slow for the turn's start: it goes on the first tool result it is ready for.
      pending.then(r => {
        if (topic && topFact(r)) topics.set(topic, topFact(r) as string)
        if ('error' in r) return nothing($, 'turn', '', query, r)
        const gate = prepare('turn', '超时后补上', query, r)
        if (!gate) return nothing($, 'turn', '', query, r)
        carried = { id: gate.id, block: gate.block, summary: gate.summary, label: gate.label, query }
      })
      line($, `· 轮首 · 查询「${query.slice(0, 60)}」 · 6 秒内未返回，结果到了再附在下一个工具结果后`)
      return next({ ...e, context })
    }
    if (topic && topFact(early)) topics.set(topic, topFact(early) as string)
    const gate = 'error' in early ? null : prepare('turn', '', query, early)
    if (!gate) {
      nothing($, 'turn', '', query, early)
      return next({ ...e, context })
    }
    const r = await next({ ...e, context: [...context, gate.block] })
    if (r.drop !== undefined) settle($, gate, '未注入：消息被拦下', false)
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const tool = e.tool
    // The model's own searches: what it read there is not injected again.
    if (/^mcp__graphiti__search_/.test(tool)) {
      const ran = await next(e)
      if (ran.deny === undefined && ran.text) for (const u of uuidsIn(ran.text)) seen.add(u)
      return ran
    }
    if (QUIET_TOOLS.test(tool) || e.agentId !== undefined || !ready()) return attachCarried(await next(e))

    let what = ''
    let query: string | null = null
    const input = e as unknown as { file_path?: string; notebook_path?: string; command?: string }
    const path = input.file_path ?? input.notebook_path
    if (FILE_TOOLS.has(tool) && path && !filesSeen.has(path)) {
      filesSeen.add(path)
      query = fileQuery(path, cwd)
      what = `${tool} ${path.split('/').at(-1)}`
    } else if (tool === 'Bash' && input.command && isRisky(input.command)) {
      query = commandQuery(input.command)
      what = 'Bash'
    }
    const budgetLeft = midTurn < MID_TURN_MAX && lastInjectStep !== step
    const topic = path ?? (query ? topicOf(query) : null)
    const pending = query && budgetLeft ? recall($, query, topic ? topics.get(topic) : undefined) : null
    if (pending) calls += 1

    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    // A tool that failed: search with its error unless something is already on the way.
    let errorPending: Promise<Recalled | { error: string }> | null = null
    let errorQ: string | null = null
    if (!pending && ran.isError && budgetLeft && ran.text) {
      errorQ = errorQuery(ran.text)
      if (errorQ) {
        calls += 1
        what = `${tool} 报错`
        errorPending = recall($, errorQ)
      }
    }
    const waiting = pending ?? errorPending
    const q = (pending ? query : errorQ) as string
    if (!waiting) return attachCarried(ran)
    const got = await Promise.race([waiting, $.clock.sleep(errorPending ? TURN_WAIT_MS : TOOL_GRACE_MS).then(() => null)])
    if (got === null) {
      line($, `· 工具后 · ${what} · 查询「${q.slice(0, 60)}」 · 超时，未注入`)
      return attachCarried(ran)
    }
    if (topic && topFact(got)) topics.set(topic, topFact(got) as string)
    const gate = 'error' in got ? null : prepare('tool', what, q, got)
    if (!gate) {
      nothing($, 'tool', what, q, got)
      return attachCarried(ran)
    }
    midTurn += 1
    lastInjectStep = step
    return attachCarried({ ...ran, context: [...(ran.context ?? []), gate.block] })
  }).catch(($, e, next) => next(e))

  function attachCarried<T extends { context?: readonly string[] }>(ran: T): T {
    if (!carried) return ran
    const block = carried.block
    carried = null
    return { ...ran, context: [...(ran.context ?? []), block] }
  }

  on('agent.spawn', async ($, e, next) => {
    if (!ready()) return next(e)
    const query = promptQuery(`${e.description} ${e.prompt.slice(0, 300)}`)
    if (!query) return next(e)
    calls += 1
    const got = await Promise.race([recall($, query), $.clock.sleep(TURN_WAIT_MS).then(() => null)])
    const gate = got && !('error' in got) ? prepare('agent', e.description, query, got) : null
    if (!gate) {
      if (got) nothing($, 'agent', e.description, query, got)
      else line($, `· 子代理 · ${e.description} · 查询「${query.slice(0, 60)}」 · 超时，未注入`)
      return next(e)
    }
    const r = await next({ ...e, prompt: `${e.prompt}\n\n${gate.block}` })
    if (r.deny === undefined && r.agentId) gate.agentId = r.agentId
    else settle($, gate, '未注入：子代理没有启动', false)
    return r
  }).catch(($, e, next) => next(e))

  // Gate 2: the block is stored in the conversation. A compaction starts the bookkeeping over.
  on('session.append', async ($, e, next) => {
    const r = await next(e)
    if (e.door === 'compaction') {
      seen.clear()
      filesSeen.clear()
    }
    const text = JSON.stringify(e.message.content)
    for (const id of idsIn(text)) {
      const gate = gates.get(id)
      if (gate && !gate.stored && (e.door === 'hook-context' || e.door === 'prompt')) gate.stored = true
    }
    return r
  }).catch(($, e, next) => next(e))

  // Gate 3: the block rides in a request the model receives, kept by every hook beneath.
  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    for (const id of idsIn(e.text)) {
      const gate = gates.get(id)
      if (!gate || gate.done || e.origin.kind !== 'plugin') continue
      const kept = r.text !== null && r.text.includes(`#${id}`)
      settle($, gate, kept ? `已注入 ${gate.summary}` : '未注入：被拦下', kept)
    }
    return r
  })

  // Gate 4: a request went out. A subagent's task is its first prompt, so its first step settles
  // it; a block seen stored but never sent within two steps of its loop is reported unconfirmed.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) step = e.index
    for (const gate of gates.values()) {
      if (gate.done) continue
      if (gate.where === 'agent') {
        if (gate.agentId && gate.agentId === e.agentId && gate.stored) settle($, gate, `已注入子代理任务 ${gate.summary}`, true)
        continue
      }
      if (e.agentId !== undefined) continue
      gate.steps += 1
      if (gate.steps >= 2) settle($, gate, gate.stored ? '未确认：已存进对话，没看到随请求发出' : '未确认：没看到存进对话', false)
    }
    return yield* next(e)
  })
}
