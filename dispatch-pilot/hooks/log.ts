// The decision log and the text form of /dp. Pure functions: no $ calls, so all of it is unit-testable.
// Text for people is Chinese; reason and failure codes are shown as the codes they are.
import type { Answer, Failure } from './backend.ts'
import type { Config } from './config.ts'
import type { Reason, Thresholds } from './decide.ts'
import { LEVELS, isLevel } from './levels.ts'
import type { Level } from './levels.ts'

export type Decision = {
  id: string
  at: number
  kind: 'submit' | 'midrun' | 'agent' | 'skill' | 'progress'
  backend: 'drex' | 'jev' | null
  model: string | null
  ms: number
  raw: Record<string, Answer> | null
  from: string | null
  /** An agent decision's reads `<model alias or inherit> · <effort or —>`. */
  to: string | null
  /** Only submit and midrun decisions have one. */
  reason: Reason | null
  /** For people: an agent's type, a skill's name, what a failure was. */
  detail: string
  turnId: string | null
  /** Work steps the turn had finished when the decision was made (0 at prompt.submit). */
  step: number | null
  bars: Thresholds | null
  failure: Failure | null
  requestId: string | null
  applied: boolean
  /** The level the next request actually carried (Task 11). */
  sent: Level | 'not-sent' | 'unverified' | null
}

/** $.store's log is shared by every session on this machine; the state key recent holds this session's last RECENT_KEEP. */
export const LOG_KEEP = 200
export const RECENT_KEEP = 30
/** How many /dp log lists when no n is given, and how many /dp shows. */
export const LOG_DEFAULT = 10
const SHOWN = 5

const KINDS: readonly string[] = ['submit', 'midrun', 'agent', 'skill', 'progress']

export function pushLog(log: readonly Decision[], d: Decision, keep = LOG_KEEP): Decision[] {
  return [...log, d].slice(-keep)
}

export function amendLog(log: readonly Decision[], id: string, patch: Partial<Decision>): Decision[] {
  return log.map((d) => (d.id === id ? { ...d, ...patch, id: d.id } : d))
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// $.store's log is whatever an earlier version of the mod or a hand edit left there: keep the entries
// shaped like a Decision and drop the rest, so nothing that reads the log throws on them.
export function readLog(v: unknown): Decision[] {
  if (!Array.isArray(v)) return []
  return v.filter((d): d is Decision => isRecord(d) && typeof d.id === 'string' && typeof d.at === 'number' && KINDS.includes(String(d.kind)))
}

// The sandbox has no crypto.randomUUID: the clock time and a counter. The counter restarts at a hot
// reload, so an id could repeat only if two decisions fell in the same millisecond across a reload.
let seq = 0

export function decisionId(at: number): string {
  seq += 1
  return `${at.toString(36)}-${seq.toString(36)}`
}

// The text of /dp.

const LEVEL_LIST = LEVELS.join('、')
const KIND_ZH: Record<string, string> = { submit: '发消息', midrun: '中途', agent: 'agent', skill: 'skill', progress: '进展记录' }

const backendName = (b: string): string => (b === 'drex' ? 'Drex' : b === 'jev' ? 'Jev' : b)

function clockText(at: number): string {
  const t = new Date(at)
  return Number.isNaN(t.getTime()) ? '--:--:--' : t.toTimeString().slice(0, 8)
}

const prob = (p: unknown): string => (typeof p === 'number' && Number.isFinite(p) ? p.toFixed(2) : String(p))

// Written defensively: a stored log may hold answers in a shape this version never wrote.
function answerText(id: string, a: unknown): string {
  if (isRecord(a)) {
    if (a.type === 'noul') return `${id} ${prob(a.noul)}`
    if (a.type === 'score' && Array.isArray(a.probabilities)) return `${id} [${a.probabilities.map(prob).join(' ')}]`
    if (a.type === 'choice' && isRecord(a.probabilities)) {
      const ps = Object.entries(a.probabilities).map(([k, p]) => `${k} ${prob(p)}`)
      return `${id} ${String(a.choice)}（${ps.join('，')}）`
    }
  }
  return `${id} ${JSON.stringify(a)}`
}

function rawText(raw: unknown): string {
  if (!isRecord(raw)) return '没有'
  const parts = Object.entries(raw).map(([id, a]) => answerText(id, a))
  return parts.length > 0 ? parts.join(' · ') : '没有'
}

function changeText(d: Decision): string {
  if (d.failure) return `评估失败（${d.failure}），放行`
  let s = '—'
  if (d.from !== null && d.from === d.to) s = `${d.to} 不变`
  else if (d.from !== null || d.to !== null) s = d.from === null ? `→ ${d.to}` : `${d.from} → ${d.to ?? '—'}`
  return d.reason && d.reason !== 'hold' ? `${s} · ${d.reason}` : s
}

function sentText(sent: unknown): string {
  if (sent === 'not-sent') return ' · 未发出'
  if (sent === 'unverified') return ' · 未核对'
  return typeof sent === 'string' ? ` · 实际 ${sent}` : ''
}

function decisionLine(d: Decision): string {
  const kind = KIND_ZH[d.kind] ?? d.kind
  const what = d.detail ? `${kind}（${d.detail}）` : kind
  const by = d.backend ? ` · ${backendName(d.backend)} ${d.ms} ms` : ''
  const unapplied = !d.applied && !d.failure ? ' · 未执行' : ''
  return `${clockText(d.at)} ${what} ${changeText(d)}${by}${unapplied}${sentText(d.sent)}`
}

// Without the chosen backend's key nothing is asked (ask() fails with no-key), whatever the other key.
function backendLine(cfg: Config): string {
  const key = { drex: cfg.drexApiKey, jev: cfg.jevApiKey }
  const model = { drex: cfg.drexModel, jev: cfg.jevModel }
  const first = cfg.backend
  const other = first === 'drex' ? 'jev' : 'drex'
  if (!key[first] && !key[other]) return '没有可用的后端：Drex 和 Jev 都没有密钥，dispatch-pilot 不做任何判断。在 /plugin 里给它填上密钥。'
  if (!key[first]) return `没有可用的后端：选中的 ${backendName(first)} 没有密钥。${backendName(other)} 有密钥，要用它就把「决策模型的后端」改成 ${other}。`
  const fallback = cfg.fallback && key[other] ? `；请求失败时改问 ${backendName(other)}（${model[other]}）` : ''
  return `后端：${backendName(first)}（${model[first]}）· 可用${fallback}`
}

// The level shown is the one the last main-loop request carried; without a reading, the one the mod
// wants, marked unverified; when they differ, both.
function levelLine(want: Level | null, sent: Level | null): string {
  if (sent !== null && want !== null && sent !== want) return `档位：实际发出 ${sent}，mod 要的是 ${want}`
  if (sent !== null) return `档位：${sent}（最近一次主循环请求实际带的）`
  if (want !== null) return `档位：${want}（mod 要的，未核对）`
  return '档位：还不知道（这一轮还没定档，或者模型不收 effort）'
}

export function renderDp(v: { cfg: Config; wanted: Level | null; lastSent: Level | null; lock: Level | null; log: readonly Decision[] }): string {
  const { cfg } = v
  const lines: string[] = []
  if (!cfg.enabled) lines.push('dispatch-pilot 已关闭（「启用」是关的）：不做任何判断，也不改任何东西。')
  lines.push(backendLine(cfg))
  if (cfg.mode === 'shadow') lines.push('运行方式：shadow，只判断和记录，不改档位。')
  lines.push(levelLine(v.lock ?? v.wanted, v.lastSent))
  lines.push(v.lock ? `锁定：${v.lock}（三项 effort 判断都不做；/dp unlock 解锁）` : '锁定：没有')
  const last = v.log.slice(-SHOWN)
  if (last.length === 0) lines.push('本会话还没有决策。')
  else lines.push(`本会话最近 ${last.length} 条决策：`, ...last.map((d) => `  ${decisionLine(d)}`))
  return lines.join('\n')
}

export function renderLog(log: readonly Decision[], n: number): string {
  const last = log.slice(-Math.max(1, Math.floor(n)))
  if (last.length === 0) return '还没有决策记录。'
  const lines = [`本机最近 ${last.length} 条决策记录（各会话共用，最早的在前）：`]
  for (const d of last) {
    lines.push(decisionLine(d), `  原始回答：${rawText(d.raw)}`)
    const where = typeof d.step === 'number' ? (d.step === 0 ? '发消息时' : `第 ${d.step} 步后`) : null
    const meta = [d.model ? `模型 ${d.model}` : null, d.requestId ? `request_id ${d.requestId}` : null, d.turnId ? `轮 ${d.turnId}` : null, where]
    const shown = meta.filter((m): m is string => m !== null)
    if (shown.length > 0) lines.push(`  ${shown.join(' · ')}`)
  }
  return lines.join('\n')
}

// /dp's arguments. Anything it does not know answers with DP_USAGE and changes nothing.

export type DpCommand =
  | { kind: 'show' }
  | { kind: 'lock'; level: Level }
  | { kind: 'bad-level'; word: string }
  | { kind: 'unlock' }
  | { kind: 'log'; n: number }
  | { kind: 'usage' }

export function parseDp(args: string): DpCommand {
  const [verb, arg, ...rest] = args.trim().toLowerCase().split(/\s+/).filter((w) => w !== '')
  if (verb === undefined) return { kind: 'show' }
  if (rest.length > 0) return { kind: 'usage' }
  if (verb === 'lock') return arg !== undefined && isLevel(arg) ? { kind: 'lock', level: arg } : { kind: 'bad-level', word: arg ?? '' }
  if (verb === 'unlock' && arg === undefined) return { kind: 'unlock' }
  if (verb === 'log') {
    if (arg === undefined) return { kind: 'log', n: LOG_DEFAULT }
    if (/^\d+$/.test(arg) && Number(arg) > 0) return { kind: 'log', n: Math.min(Number(arg), LOG_KEEP) }
  }
  return { kind: 'usage' }
}

export const DP_USAGE = [
  '/dp 的用法：',
  `/dp：档位、锁定、后端和本会话最近 ${SHOWN} 条决策`,
  `/dp lock <档位>：本会话锁定档位（${LEVEL_LIST}），锁定时三项 effort 判断都不做`,
  '/dp unlock：解锁',
  `/dp log [n]：本机最近 n 条决策记录，含原始回答（默认 ${LOG_DEFAULT} 条，最多 ${LOG_KEEP} 条）`,
].join('\n')

export function badLevelReply(word: string): string {
  const what = word ? `认不出的档位「${word}」。` : '没有给档位。'
  return `${what}可用的五档：${LEVEL_LIST}，例如 /dp lock high。锁定没有改变。`
}

export function lockReply(level: Level, cfg: Config): string {
  const text = `已锁定：本会话主循环每一步都用 ${level}，三项 effort 判断都不做。/dp unlock 解锁。`
  if (!cfg.enabled) return `${text}\n注意：dispatch-pilot 现在是关的（「启用」），打开之前锁定不起作用。`
  if (cfg.mode === 'shadow') return `${text}\n注意：运行方式是 shadow，锁定的档位不会写出去。`
  return text
}

export function unlockReply(was: Level | null): string {
  return was ? `已解锁（原来锁在 ${was}），恢复按判断定档。` : '没有锁定，不用解锁。'
}
