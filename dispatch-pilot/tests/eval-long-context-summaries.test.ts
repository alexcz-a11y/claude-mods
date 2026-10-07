// The problem summary a real flow would hold at the end of an item's deep conversation (#44): the mod's own prompt and
// reading (decision/summary.ts) run turn by turn over the conversation, as the mod runs them after each of the person's turns,
// with the cheap model's completion handed in. The count's moves (a message that says "unresolved" marks the last try; a
// resolved or new problem clears the record) are the dataset's `says`, as the mod's own bars would have it.

import { expect, test } from 'claude-code/testing'
import type { LongContextItem } from '../eval/lib/datasets.ts'
import { conversationOf } from '../eval/lib/long-conversation.ts'
import { writeSummary } from '../eval/lib/long-summaries.ts'

function item(change: (item: LongContextItem) => void = () => {}): LongContextItem {
  const result: LongContextItem = {
    id: 'long-001',
    zh: {
      message: '回到重连那个问题',
      decisive: [
        { role: 'user', text: 'FIRST 重连一直掉线，帮我修', says: 'new' },
        { role: 'assistant', text: '调了退避。', tools: ['Edit'] },
        { role: 'user', text: '还是掉线', says: 'unresolved' },
        { role: 'assistant', text: '加了心跳抖动。', tools: ['Edit', 'Bash'] },
        { role: 'user', text: '先看看周围的代码' },
        { role: 'assistant', text: '好。' },
      ],
      vocab: { area: 'WebSocket 重连', files: ['ws/a.ts', 'ws/b.ts'], symbols: ['reconnect', 'nextDelay', 'Heartbeat'], terms: ['心跳', '会话'] },
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

/** A cheap model that writes the record it is shown plus a line for the latest turn: so the record in the prompt tells what the flow did. */
function writer(replies: (string | null)[] = []) {
  const prompts: string[] = []
  const complete = async (prompt: string): Promise<string | null> => {
    prompts.push(prompt)
    if (replies.length > 0) return replies.shift() ?? null
    const previous = /Record so far:\n(\{.*\})/.exec(prompt)
    const record = previous === null ? { problem: '重连一直掉线', tried: [] as string[], status: '' } : JSON.parse(previous[1] as string)
    const person = /The person wrote:\n<<<\n([\s\S]*?)\n>>>/.exec(prompt)?.[1] ?? ''
    return JSON.stringify({ ...record, tried: [...record.tried, `第 ${record.tried.length + 1} 步：${person.slice(0, 12)}`], status: `做完第 ${record.tried.length + 1} 步` })
  }
  return { complete, prompts }
}

test('one request to the cheap model for each turn of the deep conversation, each with the record so far: the mod\'s prompt, the person\'s words, the reply, the tools', async () => {
  const base = item()
  const turns = conversationOf(base, 'deep').length / 2
  const w = writer()
  const written = await writeSummary(base, w.complete)
  expect(w.prompts).toHaveLength(turns)
  expect(written.turns).toBe(turns)
  expect(written.failed).toBe(0)
  expect(w.prompts[0]).toContain('Record so far: none yet.')
  expect(w.prompts[0]).toContain('FIRST 重连一直掉线，帮我修')
  expect(w.prompts[0]).toContain('The assistant called: Edit')
  expect(w.prompts[0]).toContain('调了退避。')
  expect(w.prompts[1]).toContain('Record so far:\n{"problem":"重连一直掉线"')
  expect(w.prompts[1]).toContain('The assistant called: Edit, Bash')
  expect(w.prompts[2]).toContain('The assistant called: no tools')
})

test("a message that says the problem is unresolved marks the record's last try, a new problem starts a record over, and a message that says nothing leaves it", async () => {
  const w = writer()
  await writeSummary(item(), w.complete)
  // Turn 2 is the person's "still failing": the try in the record is marked unresolved before the turn is written about.
  expect(w.prompts[1]).toContain('第 1 步：FIRST 重连一直掉线 [unresolved]')
  // Turn 3 says nothing of the problem: the record goes on as it was, no new mark.
  expect(w.prompts[2]).not.toMatch(/第 2 步：[^"]*\[unresolved\]/)

  const again = writer()
  await writeSummary(item((i) => (i.zh.decisive[2] = { role: 'user', text: '好了，换个问题', says: 'new' })), again.complete)
  expect(again.prompts[1]).toContain('Record so far: none yet.')
})

test('the summary at the end is the last record written, within the mod\'s reading; a reply that is no record keeps the old one and is counted, after three tries', async () => {
  const good = JSON.stringify({ problem: '重连一直掉线', tried: ['调了退避'], status: '助手在等日志' })
  const base = item((i) => (i.depth = 30000))
  const turns = conversationOf(base, 'deep').length / 2
  // The first turn is answered, the second never is (three replies of nonsense), the rest answered with the same record.
  const replies: (string | null)[] = [good, 'not json', null, 'still not', ...Array.from({ length: turns - 2 }, () => good)]
  const w = writer(replies)
  const written = await writeSummary(base, w.complete)
  expect(written.failed).toBe(1)
  expect(w.prompts).toHaveLength(turns + 2)
  // The same prompt each time: the record of turn 1, its last try marked by the person's "still failing" of turn 2.
  expect(w.prompts.slice(1, 4)).toEqual([w.prompts[1], w.prompts[1], w.prompts[1]])
  expect(w.prompts[1]).toContain('"tried":["调了退避 [unresolved]"')
  expect(written.summary).toEqual({ problem: '重连一直掉线', tried: [{ text: '调了退避' }], status: '助手在等日志' })
})

test('nothing is made up: when no reply ever was a record there is no summary', async () => {
  const written = await writeSummary(item(), async () => 'no')
  expect(written.summary).toBeNull()
  expect(written.failed).toBe(written.turns)
})
