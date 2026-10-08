// The long-context dataset's conversations (seam 2): what `conversationOf` builds for an item in each version, so that the
// three versions of one question differ in where the decisive rounds are and nothing else (#44).

import { expect, test } from 'claude-code/testing'
import { estimateTokens, recentLines, type ContextMessage } from '../hooks/decision/context.ts'
import { conversationOf, conversationTokens, NEAR_TAIL, unresolvedCount, type LongItem } from '../eval/lib/long-conversation.ts'

/** A well-formed item: three decisive rounds about a reconnect problem, 30000 tokens deep. */
function item(id: string, change: (item: LongItem) => void = () => {}): LongItem {
  const result: LongItem = {
    id,
    zh: {
      message: '回到重连那个问题，我又试了一次，还是掉线',
      decisive: [
        { role: 'user', text: '`ws/reconnect.ts` 里的重连在弱网下会一直掉线，帮我修一下 DECISIVE-START', says: 'new' },
        { role: 'assistant', text: '把退避的上限从 5 秒调到 30 秒。', tools: ['Read', 'Edit'] },
        { role: 'user', text: '还是掉线', says: 'unresolved' },
        { role: 'assistant', text: '给心跳加了抖动。', tools: ['Edit', 'Bash'] },
        { role: 'user', text: '先别改了，我想把周围的代码先看一遍' },
        { role: 'assistant', text: '好，我先不动代码。', tools: [] },
      ],
      vocab: { area: 'WebSocket 重连', files: ['ws/reconnect.ts', 'ws/heartbeat.ts', 'ws/session.ts', 'ws/backoff.ts'], symbols: ['reconnect', 'scheduleRetry', 'Heartbeat', 'SessionStore', 'nextDelay', 'resumeFrom'], terms: ['心跳', '会话', '退避', '帧'] },
    },
    depth: 30000,
    gold: 'max',
    accept: ['xhigh', 'max'],
    triage: 'unresolved',
    without: { gold: 'high', accept: ['high', 'xhigh'] },
    rationale: '理由',
    difficulty: 'hard',
    tags: ['repeated-failure'],
  }
  change(result)
  return result
}

/** The messages the way the mod reads a transcript. */
function messages(entries: ReturnType<typeof conversationOf>): ContextMessage[] {
  return entries.map((entry) => ({ role: entry.role, text: entry.text, toolUses: (entry.tools ?? []).map((tool) => ({ tool })) }))
}

test('the deep version starts with the decisive rounds and is as deep as the item says, within a few percent', () => {
  const deep = conversationOf(item('long-001'), 'deep')
  expect(deep[0]?.text).toContain('DECISIVE-START')
  expect(deep.slice(0, 6)).toEqual(item('long-001').zh.decisive.map(({ says: _says, ...entry }) => entry))
  const tokens = conversationTokens(deep)
  expect(tokens).toBeGreaterThan(30000 * 0.97)
  expect(tokens).toBeLessThan(30000 * 1.04)
})

test('a conversation alternates the person and the assistant, from the person to the assistant, and the filler reads as ordinary work: no secret masked, no word of a failure', () => {
  for (const version of ['deep', 'near', 'none'] as const) {
    const entries = conversationOf(item('long-001'), version)
    expect(entries.map((entry) => entry.role).every((role, i) => role === (i % 2 === 0 ? 'user' : 'assistant'))).toBe(true)
    expect(entries.length % 2).toBe(0)
    const lines = recentLines(messages(entries), 'unused', 1_000_000)
    expect(lines.join('\n')).not.toContain('REDACTED')
  }
  const filler = conversationOf(item('long-001'), 'none').map((entry) => entry.text).join('\n')
  expect(filler).not.toMatch(/失败|报错|没好|还是不行|超时/)
})

test('the same item builds the same conversation every time, and another item another one', () => {
  expect(conversationOf(item('long-001'), 'deep')).toEqual(conversationOf(item('long-001'), 'deep'))
  expect(conversationOf(item('long-002'), 'none')).not.toEqual(conversationOf(item('long-001'), 'none'))
})

test('the three versions share one filler: the none version is the deep one without the decisive rounds, the near version has them near the end', () => {
  const base = item('long-001')
  const decisive = base.zh.decisive.length
  const deep = conversationOf(base, 'deep')
  const near = conversationOf(base, 'near')
  const none = conversationOf(base, 'none')

  expect(deep.slice(decisive)).toEqual(none)
  expect(deep.length).toBe(near.length)
  expect(near.length).toBe(none.length + decisive)

  // Near: the decisive rounds are the last of the conversation but a few thousand tokens of filler, and the filler around them is the none version's, in order.
  const at = near.findIndex((entry) => entry.text.includes('DECISIVE-START'))
  expect(at).toBeGreaterThan(0)
  expect([...near.slice(0, at), ...near.slice(at + decisive)]).toEqual(none)
  const after = conversationTokens(near.slice(at + decisive))
  expect(after).toBeGreaterThanOrEqual(NEAR_TAIL.least)
  expect(after).toBeLessThanOrEqual(NEAR_TAIL.most)

  // None: nothing of the decisive rounds.
  expect(none.some((entry) => entry.text.includes('DECISIVE-START'))).toBe(false)
  // All three are as long as each other but for the decisive rounds.
  expect(Math.abs(conversationTokens(near) - conversationTokens(deep))).toBeLessThan(estimateTokens('x'.repeat(8)))
})

test('the filler is about the item: its files and symbols are named, its tools are the ordinary ones', () => {
  const none = conversationOf(item('long-001'), 'none')
  const text = none.map((entry) => entry.text).join('\n')
  expect(text).toContain('ws/reconnect.ts')
  expect(text).toMatch(/scheduleRetry|nextDelay|resumeFrom/)
  const tools = new Set(none.flatMap((entry) => entry.tools ?? []))
  expect([...tools].every((tool) => ['Read', 'Grep', 'Glob', 'Edit', 'Bash'].includes(tool))).toBe(true)
  // Sizes vary: short replies and long ones.
  const sizes = none.filter((entry) => entry.role === 'assistant').map((entry) => estimateTokens(entry.text))
  expect(Math.min(...sizes)).toBeLessThan(600)
  expect(Math.max(...sizes)).toBeGreaterThan(1200)
})

test('the count of times the problem was said to be unresolved is the decisive rounds\' own: one more for each, back to none at a resolved or new problem', () => {
  const says = (...marks: (string | undefined)[]) => (i: LongItem) => {
    i.zh.decisive = marks.flatMap((mark, n) => [
      { role: 'user' as const, text: `message ${n}`, ...(mark === undefined ? {} : { says: mark as 'unresolved' }) },
      { role: 'assistant' as const, text: `reply ${n}` },
    ])
  }
  expect(unresolvedCount(item('a', says('new', 'unresolved', 'unresolved', 'unresolved')))).toBe(3)
  expect(unresolvedCount(item('b', says('new', 'unresolved', 'resolved', 'unresolved')))).toBe(1)
  expect(unresolvedCount(item('c', says('new', 'unresolved', undefined, 'unresolved')))).toBe(2) // a message that says nothing leaves it
  expect(unresolvedCount(item('d', says('new')))).toBe(0)
})

test('depth is the length of the conversation from the start of the decisive rounds: a deeper item is longer', () => {
  const shallow = conversationTokens(conversationOf(item('long-003', (i) => (i.depth = 30000)), 'deep'))
  const deeper = conversationTokens(conversationOf(item('long-003', (i) => (i.depth = 60000)), 'deep'))
  expect(deeper).toBeGreaterThan(shallow * 1.9)
})
