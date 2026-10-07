// The eval v2 generator (seam 2, #45): how `buildEvalV2` assembles each item's conversation from the pool, and that the
// depth bins are what the mod's own state builder reads at the budgets the test groups use (24000, 48000, 135000).

import { expect, test } from 'claude-code/testing'
import { estimateTokens, messageText, recentLines, said, turnStartState } from '../hooks/decision/context.ts'
import { BINS, buildEvalV2, evalV2Jsonl, generatedFile, type Segment, type V2Item, type V2Record } from '../eval/lib/eval-v2.ts'

/** `n` tokens of Chinese prose (one a character) that says `mark` first, so a state can be searched for it. */
function prose(mark: string, n: number): string {
  const sentence = '我把这一层的入参和返回值又对了一遍，顺手记下了调用方各自传的默认值。'
  const body = sentence.repeat(Math.ceil(n / sentence.length) + 1)
  return `${mark}${body}`.slice(0, n)
}

/** About `n` tokens of code whose every line has quotes and backslashes: the state is sent as JSON, where each of them is escaped. */
function code(mark: string, n: number): string {
  const line = 'const pattern = new RegExp("\\\\d+\\\\.\\\\d+"); settings["path"] = "C:\\\\logs\\\\app"; label = "say \\"hi\\""\n'
  return `${mark}\n${line.repeat(Math.ceil(n / 25))}`
}

/** A pool of `n` segments of a domain and relation, 3000 to 5000 tokens each, every one its own text; every third one is code. */
function pool(domain: string, relation: 'same-problem' | 'unrelated', n: number): Segment[] {
  return Array.from({ length: n }, (_, i) => {
    const id = `${domain}-${relation}-${String(i + 1).padStart(2, '0')}`
    const size = 3100 + ((i * 397) % 1600)
    const user = relation === 'same-problem' ? `${id}：{{FEATURE}} 先别改，帮我看看 {{FILE}} 里 {{SYMBOL}} 的调用方` : `${id}：帮我整理一下 src/utils 里的工具函数`
    const body = i % 3 === 2 ? code(`【${id}】`, size * 0.8) : prose(`【${id}】`, size)
    const text = relation === 'same-problem' ? `{{SYMBOL}} ${body}` : body
    return { id, domain, relation, user, assistant: { text, tools: ['Read', 'Grep'] } } as Segment
  })
}

const VALUES = {
  FEATURE: '订单列表的分页',
  SYMPTOM: '翻到第二页时列表是空的',
  ERROR: "TypeError: Cannot read properties of undefined (reading 'items')",
  FILE: 'src/pages/orders/OrderList.tsx',
  FILE2: 'src/api/orders.ts',
  SYMBOL: 'useOrderPagination',
  COMMAND: 'npx vitest run src/pages/orders',
}

/** An item of a bin and a relation: three decisive rounds (each message marked), one final message. */
function item(id: string, bin: V2Item['bin'], relation: V2Item['relation'], change: (item: V2Item) => void = () => {}): V2Item {
  const result: V2Item = {
    id,
    category: id.replace(/-\d+$/, '') as V2Item['category'],
    domain: 'frontend',
    bin,
    relation,
    placeholders: relation === 'same-problem' ? { ...VALUES } : {},
    opening: [
      { role: 'user', text: `OPENING ${id}：先说一下背景，这个列表是运营每天都要看的` },
      { role: 'assistant', text: '明白，我先记下。', tools: ['Read'] },
    ],
    decisive: [
      { role: 'user', msg: 'd1', text: `DECISIVE-d1 ${id}：订单列表第二页是空的，在 ${VALUES.FILE}` },
      { role: 'assistant', text: `DECISIVE-a1 ${id}：我把 offset 改成 (page - 1) * size。`, tools: ['Read', 'Edit'] },
      { role: 'user', msg: 'd2', text: `DECISIVE-d2 ${id}：还是空的` },
      { role: 'assistant', text: `DECISIVE-a2 ${id}：补上了请求里的 page 参数。`, tools: ['Edit'] },
      { role: 'user', msg: 'd3', text: `DECISIVE-d3 ${id}：还是不行，先放一放` },
      { role: 'assistant', text: `DECISIVE-a3 ${id}：好，先不动。` },
    ],
    final: [{ role: 'user', text: `FINAL ${id}：回到分页那个问题，第二页还是空的` }],
    middle_hint: '中间轮次的说明',
  }
  change(result)
  return result
}

/** One item of each bin and relation, over a pool big enough for all of them. */
function built(seed = 'test') {
  const items = (['d1', 'd2', 'd3', 'd4'] as const).flatMap((bin, n) => [item(`explicit-unresolved-0${n + 1}`, bin, 'same-problem'), item(`new-topic-0${n + 1}`, bin, 'unrelated')])
  return buildEvalV2({ segments: [...pool('frontend', 'same-problem', 48), ...pool('frontend', 'unrelated', 60)], items, seed })
}

/** Which of the decisive messages (both sides) the mod's state holds at a budget, the message limit lifted as the test groups lift it. */
function held(record: V2Record, tokens: number): 'all' | 'some' | 'none' {
  const last = record.turns.at(-1)!
  const messages = record.turns.slice(0, -1).map((turn) => ({ role: turn.role, text: turn.text, toolUses: (turn.tools ?? []).map((tool) => ({ tool })) }))
  const state = turnStartState({ prompt: last.text, messages, limits: { messages: 100000, tokens } })
  const context = String(state.recent_context)
  const decisive = record.turns.filter((turn) => turn.part === 'decisive')
  const seen = decisive.filter((turn) => context.includes(said(turn.text).slice(0, 24))).length
  return seen === decisive.length ? 'all' : seen === 0 ? 'none' : 'some'
}

test('each conversation is lead, opening, decisive, middle, final in that order, alternating from the person, and ends with the item\'s message', { timeoutMs: 30000 }, () => {
  const { records, errors } = built()
  expect(errors).toEqual([])
  expect(records.map((record) => record.id)).toEqual([...records.map((record) => record.id)].sort())
  for (const record of records) {
    const parts = record.turns.map((turn) => turn.part).filter((part, i, all) => i === 0 || all[i - 1] !== part)
    expect(parts.filter((part) => part !== 'lead')).toEqual(['opening', 'decisive', 'middle', 'final'])
    expect(record.turns.every((turn, i) => turn.role === (i % 2 === 0 ? 'user' : 'assistant'))).toBe(true)
    expect(record.turns.at(-1)?.text).toBe(`FINAL ${record.id}：回到分页那个问题，第二页还是空的`)
    expect(record.segments.middle.length).toBeGreaterThan(0)
  }
})

test('the decisive rounds lie whole in the bin\'s depth range, so the mod\'s state reads them at the budgets the bin is cut at and not below', { timeoutMs: 60000 }, () => {
  const { records } = built()
  const expected: Record<string, ['all' | 'none', 'all' | 'none', 'all' | 'none']> = { d1: ['all', 'all', 'all'], d2: ['none', 'all', 'all'], d3: ['none', 'none', 'all'], d4: ['none', 'none', 'none'] }
  for (const record of records) {
    expect(record.depth).toBeLessThanOrEqual(BINS[record.bin].most)
    expect(record.depth_end).toBeGreaterThanOrEqual(BINS[record.bin].least)
    const want = expected[record.bin]!
    // The plain request, and one whose state gives up 700 tokens to a problem summary and a count (the flow groups).
    expect([held(record, 24000), held(record, 48000), held(record, 135000)]).toEqual(want)
    expect([held(record, 24000 - 700), held(record, 48000 - 700), held(record, 135000 - 700)]).toEqual(want)
  }
})

test('a same-problem middle is the domain\'s same-problem segments with the item\'s values filled in; an unrelated middle and every lead are its unrelated segments', { timeoutMs: 30000 }, () => {
  const { records } = built()
  for (const record of records) {
    const middle = record.turns.filter((turn) => turn.part === 'middle')
    const lead = record.turns.filter((turn) => turn.part === 'lead')
    expect(middle.every((turn) => turn.segment?.startsWith(`frontend-${record.relation}-`))).toBe(true)
    expect(lead.every((turn) => turn.segment?.startsWith('frontend-unrelated-'))).toBe(true)
    expect(record.turns.some((turn) => /\{\{[A-Z0-9_]+\}\}/.test(turn.text))).toBe(false)
    if (record.relation === 'same-problem') expect(middle.filter((turn) => turn.role === 'user').every((turn) => turn.text.includes('src/pages/orders/OrderList.tsx') && turn.text.includes('useOrderPagination'))).toBe(true)
    // A segment's two messages stay together, the person's first.
    for (let i = 0; i < record.turns.length; i++) {
      const turn = record.turns[i]!
      if (turn.segment !== undefined && turn.role === 'user') expect(record.turns[i + 1]?.segment).toBe(turn.segment)
    }
  }
})

test('no segment twice in one item, and none in more items than the cap allows', { timeoutMs: 30000 }, () => {
  const items = [1, 2, 3].map((n) => item(`explicit-unresolved-0${n}`, 'd2', 'same-problem'))
  const { records, errors, uses } = buildEvalV2({ segments: [...pool('frontend', 'same-problem', 16), ...pool('frontend', 'unrelated', 60)], items, seed: 'cap', maxUses: 2 })
  expect(errors).toEqual([])
  for (const record of records) {
    const used = [...record.segments.lead, ...record.segments.middle]
    expect(new Set(used).size).toBe(used.length)
  }
  expect(Math.max(...Object.values(uses))).toBeLessThanOrEqual(2)
  const counted = new Map<string, number>()
  for (const record of records) for (const id of [...record.segments.lead, ...record.segments.middle]) counted.set(id, (counted.get(id) ?? 0) + 1)
  expect(Object.fromEntries([...counted].filter(([, n]) => n > 0))).toEqual(Object.fromEntries(Object.entries(uses).filter(([, n]) => n > 0)))
})

test('the same seed builds the same file, another seed another', { timeoutMs: 30000 }, () => {
  const once = evalV2Jsonl(built('alpha').records)
  expect(evalV2Jsonl(built('alpha').records)).toBe(once)
  expect(evalV2Jsonl(built('beta').records)).not.toBe(once)
  expect(once.split('\n').filter(Boolean).every((line) => JSON.parse(line).turns.length > 0)).toBe(true)
})

test('every message of the person has an id by part, p o d m f, the decisive ones the item\'s own, each with its place in the conversation', { timeoutMs: 30000 }, () => {
  const { records } = built()
  for (const record of records) {
    const people = record.turns.filter((turn) => turn.role === 'user')
    expect(people.every((turn) => typeof turn.msg === 'string')).toBe(true)
    expect(record.turns.filter((turn) => turn.role === 'assistant').some((turn) => 'msg' in turn)).toBe(false)
    const ids = people.map((turn) => turn.msg as string)
    const byPart = (prefix: string) => ids.filter((id) => id.startsWith(prefix))
    expect(byPart('o')).toEqual(['o1'])
    expect(byPart('d')).toEqual(['d1', 'd2', 'd3'])
    expect(byPart('f')).toEqual(['f1'])
    expect(byPart('m')).toEqual(record.segments.middle.map((_, n) => `m${n + 1}`))
    expect(byPart('p')).toEqual(record.segments.lead.map((_, n) => `p${n + 1}`))
    expect(record.decisive.map((d) => d.msg)).toEqual(['d1', 'd2', 'd3'])
    for (const d of record.decisive) expect(record.turns[d.at]?.text.startsWith(`DECISIVE-${d.msg} `)).toBe(true)
  }
})

test('a message\'s depth is where the mod\'s state starts to hold it: a budget under it never does, one that fits the state as sent (JSON escapes and all) does', { timeoutMs: 60000 }, () => {
  const { records } = built()
  for (const record of records) {
    const prompt = record.turns.at(-1)!.text
    const messages = record.turns.slice(0, -1).map((turn) => ({ role: turn.role, text: turn.text, toolUses: (turn.tools ?? []).map((tool) => ({ tool })) }))
    const lines = recentLines(messages, prompt, 100000)
    const holds = (at: number, tokens: number) => String(turnStartState({ prompt, messages, limits: { messages: 100000, tokens } }).recent_context).includes(said(record.turns[at]!.text).slice(0, 24))
    for (const d of record.decisive) {
      // The state as sent if it held this message and everything after it: the mod's own pieces, put together here.
      const sent = estimateTokens(JSON.stringify({ user_message: messageText(prompt, 1e9), recent_context: lines.slice(d.at).join('\n') }))
      expect(holds(d.at, d.depth - 1)).toBe(false)
      expect(holds(d.at, Math.ceil(sent * 1.02) + 60)).toBe(true)
      expect(sent).toBeGreaterThan(d.depth * 0.95)
    }
    expect(record.depth).toBe(record.decisive[0]!.depth)
    expect(record.depth_end).toBeLessThan(record.depth)
    expect(record.tokens).toBeGreaterThan(record.depth)
  }
})

test('with a pool big enough, every conversation is 80000 to 200000 tokens long; a deep one needs no lead', { timeoutMs: 30000 }, () => {
  const { records, warnings } = built()
  expect(warnings).toEqual([])
  for (const record of records) {
    expect(record.tokens).toBeGreaterThanOrEqual(80000)
    expect(record.tokens).toBeLessThanOrEqual(200000)
  }
  expect(records.filter((record) => record.bin === 'd1').every((record) => record.segments.lead.length > 10)).toBe(true)
})

test('an item its pool cannot fill is an error that names it, and nothing is built', { timeoutMs: 30000 }, () => {
  const items = [item('explicit-unresolved-04', 'd4', 'same-problem'), item('new-topic-01', 'd1', 'unrelated')]
  const { records, errors } = buildEvalV2({ segments: [...pool('frontend', 'same-problem', 10), ...pool('frontend', 'unrelated', 60)], items, seed: 'short' })
  expect(errors.join('\n')).toMatch(/explicit-unresolved-04: the frontend same-problem pool cannot fill its middle: d4 needs/)
  expect(errors.join('\n')).not.toMatch(/new-topic-01/)
  expect(records).toEqual([])
  const none = buildEvalV2({ segments: pool('frontend', 'unrelated', 60), items: [item('explicit-unresolved-01', 'd1', 'same-problem')], seed: 'none' })
  expect(none.errors.join('\n')).toMatch(/explicit-unresolved-01: the frontend same-problem pool cannot fill its middle: .*the pool has 0/)
})

test('the record of a build names its seed, the hash and size of the file it made, and each item\'s depths and length on a line of its own', { timeoutMs: 30000 }, () => {
  const build = built('alpha')
  const text = generatedFile({ seed: 'alpha', records: build.records, uses: build.uses, sha256: 'f'.repeat(64), bytes: 1234 })
  const record = JSON.parse(text)
  expect(record.seed).toBe('alpha')
  expect(record.jsonl).toEqual({ sha256: 'f'.repeat(64), bytes: 1234, items: 8 })
  expect(record.pool.segments).toBe(108)
  expect(record.items.map((entry: { id: string }) => entry.id)).toEqual(build.records.map((r) => r.id))
  expect(record.items[0]).toEqual({ id: build.records[0]!.id, bin: build.records[0]!.bin, relation: build.records[0]!.relation, domain: 'frontend', depth: build.records[0]!.depth, depth_end: build.records[0]!.depth_end, tokens: build.records[0]!.tokens, lead: build.records[0]!.segments.lead.length, middle: build.records[0]!.segments.middle.length })
  expect(text.split('\n').filter((line) => line.trimStart().startsWith('{"id":')).length).toBe(8)
  expect(generatedFile({ seed: 'alpha', records: build.records, uses: build.uses, sha256: 'f'.repeat(64), bytes: 1234 })).toBe(text)
})

test('when the unrelated pool runs short, the items of its domain share what is left of it for their leads', { timeoutMs: 30000 }, () => {
  const items = [1, 2, 3].map((n) => item(`explicit-unresolved-0${n}`, 'd1', 'same-problem'))
  const { records, errors, warnings } = buildEvalV2({ segments: [...pool('frontend', 'same-problem', 20), ...pool('frontend', 'unrelated', 20)], items, seed: 'share', maxUses: 1 })
  expect(errors).toEqual([])
  const leads = records.map((record) => record.segments.lead.length)
  expect(leads.reduce((a, b) => a + b, 0)).toBe(20)
  expect(Math.max(...leads) - Math.min(...leads)).toBeLessThanOrEqual(1)
  expect(warnings.join('\n')).toMatch(/explicit-unresolved-0\d: \d+ tokens in all, outside 80000 to 200000/)
})
