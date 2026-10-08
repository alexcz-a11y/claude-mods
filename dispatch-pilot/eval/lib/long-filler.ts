// The ordinary work between the decisive rounds of a long-context item (#44): turns of a person reading and tidying the
// code around the area the item names, written by a seeded generator over templates, the same every time.
//
// What it holds: explanations of what a function does, where a value is passed, test runs that pass, a rename, a
// comment added, a list of recent commits, a pasted log of ordinary lines, a few words of acknowledgement. What it never
// holds: how any attempt at the item's problem went (no failure, no success), a secret, a tool's output beyond what a reply
// says of it. The decisive rounds are the only place the conversation says what was tried.
//
// It is procedural text, not a transcript: the sentences and code come from templates over the item's own words, so a long
// reply is plausible at a glance and repetitive when read closely. The dataset README says so.
//
// Pure: no Node API.

import { estimateTokens } from '../../hooks/decision/context.ts'
import type { ContextEntry, Vocab } from './datasets.ts'

type Random = () => number

/** A seeded generator (FNV-1a of the seed into mulberry32): the same seed, the same numbers, on every machine. */
function random(seed: string): Random {
  let h = 2166136261
  for (const char of seed) h = Math.imul(h ^ char.codePointAt(0)!, 16777619)
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(r: Random, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)] as T
}

/** `n` different members of `list` (all of it when it is shorter), in a random order. */
function some<T>(r: Random, list: readonly T[], n: number): T[] {
  const rest = [...list]
  const out: T[] = []
  while (out.length < n && rest.length > 0) out.push(...rest.splice(Math.floor(r() * rest.length), 1))
  return out
}

function between(r: Random, low: number, high: number): number {
  return low + Math.floor(r() * (high - low + 1))
}

const DUTIES = ['校验入参', '读取缓存', '写入队列', '记录指标', '序列化结果', '拼装请求头', '合并默认配置', '过滤空值', '按时间排序', '去重', '分页拉取', '转换时区', '生成幂等键', '统计耗时', '清理过期条目', '补齐缺省字段', '截断过长的文本', '归一化大小写', '拆分批次', '回写状态']
const RULES = ['调用次数', '时间窗口', '字节数', '条目数', '优先级', '创建时间', '所属租户']
const CONSEQUENCES = ['同一批里的顺序不会变', '相邻两次调用之间没有共享状态', '结果可以直接缓存', '不需要额外加锁', '读的时候不用管写的是谁', '改一处不会牵动另一处', '单测里可以直接构造']
const FIELDS = ['id', 'name', 'status', 'items', 'count', 'offset', 'limit', 'createdAt', 'updatedAt', 'payload', 'headers', 'size', 'tags', 'owner', 'kind', 'value', 'key', 'index', 'label', 'scope']
const VERBS = ['load', 'build', 'merge', 'collect', 'resolve', 'format', 'parse', 'select', 'prepare', 'apply', 'compose', 'normalize']
const NOUNS = ['Options', 'Entries', 'Records', 'Batch', 'Snapshot', 'Summary', 'Config', 'Report', 'Window', 'Cursor']
const NOTES = ['先取出需要的字段', '没有就用默认值', '保持原来的顺序', '只处理当前这一批', '结果交给上层', '这里不做副作用', '边界按左闭右开算', '空数组直接返回']
const LOGS = ['processed batch', 'flushed queue', 'loaded snapshot', 'wrote cursor', 'rebuilt index', 'served request', 'released lease', 'compacted segment', 'refreshed token', 'synced offsets']
const TEST_NAMES = ['returns the default when nothing is given', 'keeps the order of the input', 'skips empty entries', 'handles a single item', 'merges two batches', 'does not change its input', 'rounds the size up', 'reads the newest entry first']
const ASKS_SHORT = ['好的，接着看下一个', '嗯，明白了', '这个先这样，我记一下', '好，往下走', 'ok，你顺着讲', '懂了，那另一块呢', '行，下一步', '哦，原来是这样', '好，那就先按这个理解']
const ACKS = ['好，我记下了，接下来看哪一块？', '明白，这一块就是这样。', '好的，你接着说。', '行，那我们继续往下读。', '嗯，这样就清楚了。']
const COMMIT_SUBJECTS = ['整理目录结构', '补充类型注释', '拆出公共函数', '调整日志格式', '更新依赖版本', '补一条用例', '统一命名', '去掉没用的导入', '把配置挪到单独文件', '补充文档']
const AUTHORS = ['lin', 'chen', 'zhou', 'wu', 'zhao']

function camel(r: Random): string {
  return `${pick(r, VERBS)}${pick(r, NOUNS)}`
}

/** A type name from one of the item's symbols: `SchedulerBatch`. */
function typeName(r: Random, v: Vocab): string {
  const base = pick(r, v.symbols)
  return `${base.charAt(0).toUpperCase()}${base.slice(1)}${pick(r, NOUNS)}`
}

/** One pattern of code over the item's names: an interface and a function over it, a class, a test file, a switch, a loop over chunks, a table of settings. */
function snippet(r: Random, v: Vocab): string[] {
  const type = typeName(r, v)
  const [a, b, c, d] = some(r, FIELDS, 4) as [string, string, string, string]
  const sym = pick(r, v.symbols)
  const n = between(r, 2, 90)
  switch (between(r, 0, 5)) {
    case 0:
      return [
        `export interface ${type} {`,
        `  ${a}: string`,
        `  ${b}: number`,
        `  ${c}?: boolean`,
        '}',
        '',
        `export function ${sym}(input: ${type}, ${d} = ${n}): ${type} {`,
        `  // ${pick(r, NOTES)}`,
        `  const ${b} = Math.max(0, input.${b} - ${between(r, 1, 9)})`,
        `  if (input.${c} === true) return { ...input, ${b} }`,
        `  return { ...input, ${a}: input.${a}.trim(), ${b}: Math.min(${b}, ${d}) }`,
        '}',
      ]
    case 1:
      return [
        `export class ${type} {`,
        `  private readonly ${a} = new Map<string, ${pick(r, ['number', 'string', 'Entry'])}>()`,
        '',
        `  constructor(private readonly ${b} = ${n}) {}`,
        '',
        `  ${pick(r, VERBS)}(key: string, value: ${pick(r, ['number', 'string'])}) {`,
        `    if (this.${a}.size >= this.${b}) this.${a}.delete(this.${a}.keys().next().value as string)`,
        `    this.${a}.set(key, value)`,
        '  }',
        '',
        `  ${pick(r, VERBS)}(key: string) {`,
        `    return this.${a}.get(key) ?? null`,
        '  }',
        '}',
      ]
    case 2:
      return [
        `describe('${sym}', () => {`,
        ...some(r, TEST_NAMES, between(r, 2, 4)).map((name) => [`  it('${name}', () => {`, `    const result = ${sym}({ ${a}: '${pick(r, v.terms)}', ${b}: ${between(r, 0, 20)} })`, `    expect(result.${b}).toBe(${between(r, 0, 20)})`, '  })', ''].join('\n')),
        '})',
      ]
    case 3:
      return [
        `export function ${camel(r)}(kind: '${a}' | '${b}' | '${c}', ${d}: number) {`,
        '  switch (kind) {',
        `    case '${a}':`,
        `      return ${d} * ${between(r, 2, 9)}`,
        `    case '${b}':`,
        `      return ${d} + ${between(r, 1, 99)}`,
        '    default:',
        `      return ${n}`,
        '  }',
        '}',
      ]
    case 4:
      return [
        `export async function ${camel(r)}(${a}: string[], chunkSize = ${between(r, 5, 40)}) {`,
        '  const out: unknown[] = []',
        `  for (let i = 0; i < ${a}.length; i += chunkSize) {`,
        `    const chunk = ${a}.slice(i, i + chunkSize)`,
        `    out.push(...(await Promise.all(chunk.map((${b}) => ${sym}(${b})))))`,
        '  }',
        '  return out',
        '}',
      ]
    default:
      return [`export const ${pick(r, ['defaults', 'limits', 'settings'])} = {`, `  ${a}: ${n},`, `  ${b}: ${between(r, 100, 9000)},`, `  ${c}: '${pick(r, v.terms)}',`, `  ${d}: ${r() < 0.5 ? 'true' : 'false'},`, '} as const']
  }
}

/** Code as a reply shows it: patterns over the item's own names, `lines` lines or a little more. */
function code(r: Random, v: Vocab, lines: number): string {
  const out: string[] = []
  while (out.length < lines) out.push(...snippet(r, v), '')
  return `\`\`\`ts\n${out.join('\n').trimEnd()}\n\`\`\``
}

/** One sentence of plain explanation about the named code: any of eighteen shapes over the item's words. */
function sentence(r: Random, v: Vocab): string {
  const [file, other] = some(r, v.files, 2) as [string, string]
  const symbol = pick(r, v.symbols)
  const term = pick(r, v.terms)
  switch (between(r, 0, 17)) {
    case 0:
      return `${symbol} 的入口在 ${file}，它先${pick(r, DUTIES)}，再${pick(r, DUTIES)}，最后${pick(r, DUTIES)}。`
    case 1:
      return `值得留意的是，${term}是按${pick(r, RULES)}来算的，所以${pick(r, CONSEQUENCES)}。`
    case 2:
      return `${file} 里有一份很像的逻辑，现在没有抽出来，放着不动也不影响${term}这一块。`
    case 3:
      return `如果以后要改 ${symbol}，建议先在 ${file} 旁边补一条用例，再动实现。`
    case 4:
      return `${symbol} 本身不保存状态，${term}相关的数据都从 ${file} 里取，调用方自己负责${pick(r, DUTIES)}。`
    case 5:
      return `从调用关系看，${file} 依赖 ${other}，反过来没有依赖，所以这一层可以单独拿出来读。`
    case 6:
      return `这里的命名沿用了仓库里的习惯：动词在前，对象在后，${term}相关的函数都带前缀。`
    case 7:
      return `${symbol} 的返回值是一个普通对象，调用方不需要关心它是怎么${pick(r, DUTIES)}的。`
    case 8:
      return `顺带一提，${file} 的头部注释已经过时了，它还在说${term}由调用方${pick(r, DUTIES)}，实际上现在是 ${symbol} 在做。`
    case 9:
      return `我对照了一下 ${file} 的类型定义，字段和这里用到的是对得上的，没有多余的转换。`
    case 10:
      return '这个函数不长，但分支比看上去多：空输入、单条输入、超过上限的输入各走一条路径。'
    case 11:
      return `读这一段的时候可以先忽略 ${symbol} 的最后一个参数，那只是为了兼容旧的调用方式。`
    case 12:
      return `${file} 里的常量是按环境覆盖的，本地和线上的取值不一样，看的时候要对着配置文件。`
    case 13:
      return `这一块的测试覆盖不算高，但是${term}相关的主路径都有用例，边角的目前靠人工检查。`
    case 14:
      return `${symbol} 被 ${between(r, 2, 14)} 个地方调用，其中大部分在 ${file} 里，剩下几处是测试辅助函数。`
    case 15:
      return `如果只想了解整体，读 ${file} 的前 ${between(r, 20, 120)} 行就够了，后面是各个分支的细节。`
    case 16:
      return `${term}的单位在代码里没有统一，有的是毫秒有的是秒，读的时候留意变量名的后缀。`
    default:
      return '这个模块没有外部依赖，只用到标准库，所以可以放心地单独跑它的测试。'
  }
}

/** A paragraph of `n` different sentences (none a reply already holds: `used`). */
function paragraph(r: Random, v: Vocab, used: Set<string>, n = between(r, 2, 4)): string {
  const sentences: string[] = []
  for (let tries = 0; sentences.length < n && tries < 40; tries++) {
    const next = sentence(r, v)
    if (used.has(next)) continue
    used.add(next)
    sentences.push(next)
  }
  return sentences.join('')
}

function bullets(r: Random, v: Vocab, n: number): string {
  return Array.from({ length: n }, () => `- ${pick(r, v.files)}：${pick(r, DUTIES)}，约 ${between(r, 20, 400)} 行，被 ${between(r, 1, 12)} 处引用`).join('\n')
}

function logLines(r: Random, v: Vocab, n: number): string {
  return Array.from({ length: n }, (_, i) => {
    const minute = String((i * 7 + between(r, 0, 6)) % 60).padStart(2, '0')
    return `2026-10-0${between(r, 1, 6)}T09:${minute}:${String(between(r, 0, 59)).padStart(2, '0')}Z INFO worker-${between(r, 1, 4)} ${pick(r, v.files)}:${between(r, 20, 400)} ${pick(r, LOGS)} batch=${between(r, 1, 90)} items=${between(r, 10, 900)} took=${between(r, 3, 120)}ms`
  }).join('\n')
}

type Turn = { user: string; assistant: string; tools: string[] }

/** What a reply is being written: the random source, the item's words, and the sentences it already holds. */
type Draft = { r: Random; v: Vocab; used: Set<string> }

/** A block that makes a reply longer, whatever the reply is about: code, a paragraph, or a list; never two paragraphs in a row. */
function more(draft: Draft, after: 'code' | 'text' | 'start'): { text: string; kind: 'code' | 'text' } {
  const { r, v, used } = draft
  const x = r()
  // After a paragraph, code or a list; after code or at the start, a paragraph most often.
  if (after === 'text') return x < 0.6 ? { text: code(r, v, between(r, 14, 40)), kind: 'code' } : { text: bullets(r, v, between(r, 3, 6)), kind: 'text' }
  if (x < 0.3) return { text: code(r, v, between(r, 14, 40)), kind: 'code' }
  if (x < 0.5) return { text: bullets(r, v, between(r, 3, 6)), kind: 'text' }
  return { text: paragraph(r, v, used), kind: 'text' }
}

/** Grows `text` with blocks until it has `target` estimated tokens (the last block may go a little over). */
function grow(draft: Draft, text: string, target: number): string {
  const parts = [text]
  let size = estimateTokens(text)
  let after: 'code' | 'text' | 'start' = text.endsWith('```') ? 'code' : 'start'
  while (size < target) {
    const block = more(draft, after)
    parts.push(block.text)
    after = block.kind
    size += estimateTokens(block.text) + 1
  }
  return parts.join('\n\n')
}

/** One ordinary turn of work around the item's area, a reply of about `target` tokens. */
function turn(r: Random, v: Vocab, target: number): Turn {
  const draft: Draft = { r, v, used: new Set() }
  const [file, other] = some(r, v.files, 2) as [string, string]
  const symbol = pick(r, v.symbols)
  const term = pick(r, v.terms)
  const say = (n?: number) => paragraph(r, v, draft.used, n)
  switch (between(r, 0, 11)) {
    case 0:
      return { user: `${file} 里的 ${symbol} 是干什么的？我看了一圈没太看懂`, assistant: grow(draft, `${say()}\n${bullets(r, v, 3)}`, target), tools: ['Read'] }
    case 1:
      return { user: `帮我看一下 ${file} 和 ${other} 之间是怎么传${term}的`, assistant: grow(draft, `读了这两个文件。${say()}`, target), tools: ['Read', 'Grep'] }
    case 2:
      return { user: `跑一下 ${file} 对应的测试，看看现在的情况`, assistant: grow(draft, `跑了 \`npm test -- ${file.replace(/\.ts$/, '')}\`：${between(r, 8, 60)} 个用例，全部通过，${between(r, 0, 3)} 个跳过，耗时 ${between(r, 1, 9)}.${between(r, 0, 9)} 秒。\n${bullets(r, v, 4)}`, target), tools: ['Bash'] }
    case 3:
      return { user: `${symbol} 这个名字不太好，有没有更清楚的叫法？`, assistant: grow(draft, `可以考虑 ${camel(r)}、${camel(r)} 或 ${camel(r)}：${say()}`, target), tools: [] }
    case 4:
      return { user: `给 ${symbol} 补一段注释，说明入参和返回值`, assistant: grow(draft, `补好了，改动如下：\n${code(r, v, between(r, 10, 24))}\n${say()}`, target), tools: ['Read', 'Edit'] }
    case 5:
      return { user: `列一下最近改过 ${file} 的几个提交`, assistant: grow(draft, `最近的提交：\n${Array.from({ length: between(r, 5, 8) }, () => `- ${between(r, 1000, 9999)}ab${pick(r, AUTHORS)} ${pick(r, COMMIT_SUBJECTS)}（${file}）`).join('\n')}`, target), tools: ['Bash'] }
    case 6:
      return { user: `这是我本地跑出来的日志，你看看这几行是干嘛的：\n${logLines(r, v, between(r, 4, 12))}`, assistant: grow(draft, `这些都是例行的日志：每行是一批${term}处理完之后写的，\`batch\` 是批号，\`items\` 是这一批的条目数，\`took\` 是耗时（毫秒）。${say()}`, target), tools: [] }
    case 7:
      return { user: `${term}这块现在在哪里配置？有哪些可调的项`, assistant: grow(draft, `配置在 ${file} 里，可调的项有：\n${bullets(r, v, between(r, 3, 6))}\n${say()}`, target), tools: ['Grep', 'Read'] }
    case 8:
      return { user: `帮我把 ${symbol} 里重复的部分整理一下，先别动行为`, assistant: grow(draft, `整理好了，行为没变，抽出了一个小函数：\n${code(r, v, between(r, 12, 30))}`, target), tools: ['Read', 'Edit'] }
    case 9:
      return { user: `给 ${symbol} 写几条单测，先照现在的行为写`, assistant: grow(draft, `写好了，放在 ${file.replace(/\.ts$/, '')}.test.ts 里：\n${code(r, v, between(r, 14, 30))}\n跑过一遍，都通过。`, target), tools: ['Read', 'Edit', 'Bash'] }
    case 10:
      return { user: `${file} 和 ${other} 的职责怎么划分的？讲一下`, assistant: grow(draft, `${say()}\n${bullets(r, v, between(r, 2, 4))}`, target), tools: ['Read'] }
    default:
      return { user: `${v.area}这一块一共有哪些文件，各自多大`, assistant: grow(draft, `按目录扫了一遍：\n${bullets(r, v, between(r, 4, 8))}\n${say()}`, target), tools: ['Glob', 'Read'] }
  }
}

/** Reply sizes in estimated tokens: a quarter short, nearly half middling, a third long. */
function replySize(r: Random): number {
  const x = r()
  if (x < 0.25) return between(r, 120, 450)
  if (x < 0.7) return between(r, 500, 1200)
  return between(r, 1300, 2800)
}

/** The longest reply a turn is asked for. */
const MOST = 3400

/** What a pair of messages costs the state: each as a line of `recent_context` (the estimate of the line and its newline). */
function pairTokens(pair: readonly ContextEntry[]): number {
  return pair.reduce((sum, entry) => sum + estimateTokens(`${entry.role}: ${entry.tools !== undefined && entry.tools.length > 0 ? `[tools: ${entry.tools.join(', ')}] ` : ''}${entry.text.replace(/\s+/g, ' ').trim()}`) + 1, 0)
}

/**
 * About `tokens` estimated tokens of ordinary work in the area `vocab` names, as person and assistant turns (the person
 * first, the assistant last): the same turns for the same `seed` and `vocab`, so every version of an item builds the
 * same filler. The last turns are sized to what is left, so the total lands near the target.
 */
export function fillerTurns(vocab: Vocab, seed: string, tokens: number): ContextEntry[] {
  const r = random(`${seed}\u0000${vocab.area}`)
  const entries: ContextEntry[] = []
  let left = tokens
  let after = 'work'
  while (left > 30) {
    // One turn in six is a short exchange with no work in it, never two in a row.
    const chatter = r() < 1 / 6 && left > 400 && after === 'work' && entries.length > 0
    after = chatter ? 'chatter' : 'work'
    const made: Turn = chatter ? { user: pick(r, ASKS_SHORT), assistant: pick(r, ACKS), tools: [] } : turn(r, vocab, Math.min(left < MOST ? left - 40 : replySize(r), MOST))
    const pair: ContextEntry[] = [
      { role: 'user', text: made.user },
      { role: 'assistant', text: made.assistant, ...(made.tools.length > 0 ? { tools: made.tools } : {}) },
    ]
    left -= pairTokens(pair)
    entries.push(...pair)
  }
  return entries
}
