// The `long-context` dataset (seam 2): the format an item must have (what `eval/validate.ts` accepts and refuses) (#44).

import { expect, test } from 'claude-code/testing'
import { validateDataset } from '../eval/lib/datasets.ts'
import { conversationOf } from '../eval/lib/long-conversation.ts'

/** A well-formed item, as the dataset file holds it: three decisive rounds about a reconnect problem, 30000 tokens deep. */
function item(id: string, change: (item: any) => void = () => {}): any {
  const result = {
    id,
    zh: {
      message: '回到重连那个问题，我又试了一次，还是掉线',
      decisive: [
        { role: 'user', text: `\`ws/reconnect.ts\` 里的重连在弱网下会一直掉线（${id}），帮我修一下`, says: 'new' },
        { role: 'assistant', text: '把退避的上限从 5 秒调到 30 秒。', tools: ['Read', 'Edit'] },
        { role: 'user', text: '还是掉线', says: 'unresolved' },
        { role: 'assistant', text: '给心跳加了抖动。', tools: ['Edit', 'Bash'] },
        { role: 'user', text: '先别改了，我想把周围的代码先看一遍' },
        { role: 'assistant', text: '好，我先不动代码。' },
      ],
      vocab: { area: 'WebSocket 重连', files: ['ws/reconnect.ts', 'ws/heartbeat.ts', 'ws/session.ts'], symbols: ['reconnect', 'scheduleRetry', 'Heartbeat', 'nextDelay'], terms: ['心跳', '会话', '退避'] },
    },
    depth: 30000,
    gold: 'max',
    accept: ['xhigh', 'max'],
    triage: 'unresolved',
    without: { gold: 'high', accept: ['high', 'xhigh'] },
    rationale: 'gold 为 max：重连问题已经按两种思路改了两轮，用户第三次提起。',
    difficulty: 'hard',
    tags: ['repeated-failure'],
  }
  change(result)
  return result
}

test('a long-context dataset passes when every item is well formed', () => {
  expect(validateDataset('long-context', [item('long-001'), item('long-002')]).errors).toEqual([])
})

test('each broken long-context rule is reported with the id of the item that breaks it', () => {
  const items = [
    item('long-001', (i) => delete i.without),
    item('long-002', (i) => (i.depth = 45000)), // not one of the depths
    item('long-003', (i) => (i.zh.decisive = i.zh.decisive.slice(0, 5))), // ends with the person
    item('long-004', (i) => (i.zh.decisive[2].role = 'assistant')), // does not alternate
    item('long-005', (i) => (i.zh.decisive[1].says = 'unresolved')), // an assistant message that says something of the problem
    item('long-006', (i) => (i.zh.decisive[0].says = 'maybe')),
    item('long-007', (i) => (i.accept = ['high', 'max'])), // a gap
    item('long-008', (i) => (i.without.accept = ['low'])), // gold not in it
    item('long-009', (i) => (i.triage = 'perhaps')),
    item('long-010', (i) => (i.en = { message: 'x', decisive: [] })), // only Chinese
    item('long-011', (i) => (i.zh.vocab.files = ['only-one.ts'])),
    item('long-012', (i) => (i.zh.extra = 1)),
    item('long-013', (i) => (i.tags = ['something-else'])), // no category
    item('long-014', (i) => (i.zh.decisive[1].text = '这个问题到此为止了。'.repeat(6000))), // longer than the depth it claims
  ]
  const { errors } = validateDataset('long-context', items)
  const byId = (id: string) => errors.filter((e) => e.startsWith(`${id}:`)).join('\n')
  expect(byId('long-001')).toMatch(/without is missing/)
  expect(byId('long-002')).toMatch(/depth 45000 is not one of 30000, 60000, 120000/)
  expect(byId('long-003')).toMatch(/decisive.*end with the assistant/)
  expect(byId('long-004')).toMatch(/decisive\[2\].*user/)
  expect(byId('long-005')).toMatch(/decisive\[1\].*only a message of the person says/)
  expect(byId('long-006')).toMatch(/decisive\[0\].says "maybe"/)
  expect(byId('long-007')).toMatch(/not contiguous/)
  expect(byId('long-008')).toMatch(/without.*gold "high" is not in accept/)
  expect(byId('long-009')).toMatch(/triage "perhaps"/)
  expect(byId('long-010')).toMatch(/unknown field en/)
  expect(byId('long-011')).toMatch(/vocab.files/)
  expect(byId('long-012')).toMatch(/unknown field extra/)
  expect(byId('long-013')).toMatch(/category tag/)
  expect(byId('long-014')).toMatch(/conversation is \d+ tokens, not within a few percent of its depth 30000/)
})

test('the first message of the decisive rounds is what a state is searched for, so no filler may hold it', () => {
  const filler = conversationOf(item('long-001'), 'none')[0]?.text as string // the filler's first message of the person
  const clash = item('long-001', (i) => (i.zh.decisive[0].text = filler))
  expect(validateDataset('long-context', [clash]).errors.join('\n')).toMatch(/first decisive message is in the filler/)
})

test('the quotas the drafting rules ask for are warnings: each depth, the top level, rounds that change the answer', () => {
  const warnings = validateDataset('long-context', [item('long-001', (i) => ((i.gold = 'xhigh'), (i.accept = ['high', 'xhigh']), (i.without = { gold: 'xhigh', accept: ['high', 'xhigh'] })))]).warnings.join('\n')
  expect(warnings).toMatch(/60000/)
  expect(warnings).toMatch(/120000/)
  expect(warnings).toMatch(/gold max/)
  expect(warnings).toMatch(/change the answer/)
})
