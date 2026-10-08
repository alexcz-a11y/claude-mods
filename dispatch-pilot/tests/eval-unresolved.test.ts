// The `unresolved` dataset and its suite (seam 2): the format an item must have
// (what `eval/validate.ts` accepts and refuses), and how the suite asks an item
// and scores the answers: the final effort always, the three-way question when
// the mod asks it (it does not yet: spec #36, ticket #37).

import { expect, test } from 'claude-code/testing'
import { validateDataset } from '../eval/lib/datasets.ts'

/** A conversation long enough to overrun a 6000-token budget: pasted logs, ASCII, 4 characters a token. */
const LOG = Array.from({ length: 700 }, (_, i) => `2026-10-05T10:${String(i % 60).padStart(2, '0')}:11Z worker-3 handler.ts:${100 + (i % 40)} retry ${i} of order-${i * 7} failed: ETIMEDOUT`).join('\n')

/** A well-formed `unresolved` item: four rounds on one error, and the person's complaint that it is still there. */
function unresolved(id: string, change: (item: any) => void = () => {}): any {
  const item = {
    id,
    zh: {
      message: '还是报同样的错，已经第四次了',
      recent_context: [
        { role: 'user', text: '`checkout.test.ts` 偶发超时，帮我修一下' },
        { role: 'assistant', text: '给 `waitFor` 加了 5 秒超时。', tools: ['Read', 'Edit'] },
        { role: 'user', text: '还是超时' },
        { role: 'assistant', text: '换成 fake timers。', tools: ['Edit', 'Bash'] },
      ],
    },
    en: {
      message: 'Same error again, the fourth time now',
      recent_context: [
        { role: 'user', text: '`checkout.test.ts` times out now and then; fix it' },
        { role: 'assistant', text: 'Gave `waitFor` a 5 second timeout.', tools: ['Read', 'Edit'] },
        { role: 'user', text: 'Still times out' },
        { role: 'assistant', text: 'Switched to fake timers.', tools: ['Edit', 'Bash'] },
      ],
    },
    gold: 'max',
    accept: ['xhigh', 'max'],
    triage: 'unresolved',
    rationale: 'gold 为 max：同一个超时已经改了三轮都没好，用户第四次提起。xhigh 也可以接受；high 不行，那是把它当成新问题。',
    difficulty: 'hard',
    tags: ['explicit'],
  }
  change(item)
  return item
}

/** The same item with a conversation that overruns the budget (both languages), tagged as such. */
function long(id: string, change: (item: any) => void = () => {}): any {
  return unresolved(id, (item) => {
    for (const language of ['zh', 'en'] as const) item[language].recent_context[3].text += `\n${LOG}`
    item.tags.push('over-budget')
    change(item)
  })
}

test('an unresolved dataset passes when every item is well formed', () => {
  const checked = validateDataset('unresolved', [unresolved('unresolved-001'), long('unresolved-002')])
  expect(checked.errors).toEqual([])
})

test('each broken unresolved rule is reported with the id of the item that breaks it', () => {
  const items = [
    unresolved('unresolved-001', (i) => delete i.triage),
    unresolved('unresolved-002', (i) => (i.triage = 'maybe')),
    unresolved('unresolved-003', (i) => (i.accept = ['high', 'max'])), // a gap
    unresolved('unresolved-004', (i) => i.en.recent_context.pop()), // zh and en differ
    unresolved('unresolved-005', (i) => (i.zh.command = { name: 'debug', description: '排查故障' })), // only one language has the command
    unresolved('unresolved-006', (i) => (i.zh.extra = 1)),
  ]
  const { errors } = validateDataset('unresolved', items)
  const byId = (id: string) => errors.filter((e) => e.startsWith(`${id}:`)).join('\n')
  expect(byId('unresolved-001')).toMatch(/triage is missing/)
  expect(byId('unresolved-002')).toMatch(/triage "maybe"/)
  expect(byId('unresolved-003')).toMatch(/not contiguous/)
  expect(byId('unresolved-004')).toMatch(/recent_context/)
  expect(byId('unresolved-005')).toMatch(/command/)
  expect(byId('unresolved-006')).toMatch(/unknown field extra/)
})

test('a command turn item holds the command as typed and what it is for, in both languages', () => {
  const command = (name: string, description: string) => ({ name, description })
  const turn = (i: any) => {
    i.zh.message = '/debug 订单超时'
    i.en.message = '/debug order timeout'
    i.zh.command = command('debug', '系统地排查一个故障')
    i.en.command = command('debug', 'Investigate a fault systematically')
  }
  expect(validateDataset('unresolved', [unresolved('unresolved-001', turn)]).errors).toEqual([])
  const broken = [
    unresolved('unresolved-002', (i) => {
      turn(i)
      i.en.command.name = 'diagnose'
    }),
    unresolved('unresolved-003', (i) => {
      turn(i)
      i.zh.command.description = ''
    }),
  ]
  const { errors } = validateDataset('unresolved', broken)
  expect(errors.filter((e) => e.startsWith('unresolved-002:')).join('\n')).toMatch(/command\.name differs/)
  expect(errors.filter((e) => e.startsWith('unresolved-003:')).join('\n')).toMatch(/zh\.command\.description/)
})

test('the over-budget tag says what the conversation is: tagged exactly when both languages overrun the 6000 tokens the mod reads today', () => {
  const items = [
    unresolved('unresolved-001', (i) => i.tags.push('over-budget')), // short, tagged
    long('unresolved-002', (i) => (i.tags = i.tags.filter((tag: string) => tag !== 'over-budget'))), // long, untagged
    long('unresolved-003', (i) => (i.en.recent_context[3].text = 'short in English')), // long in Chinese only
  ]
  const { errors } = validateDataset('unresolved', items)
  const byId = (id: string) => errors.filter((e) => e.startsWith(`${id}:`)).join('\n')
  expect(byId('unresolved-001')).toMatch(/over-budget.*fits/)
  expect(byId('unresolved-002')).toMatch(/overruns.*no over-budget tag/)
  expect(byId('unresolved-003')).toMatch(/over-budget.*en/)
})

test('the quotas the drafting rules ask for are warnings: each answer of the three-way question, long conversations, items for the top level', () => {
  const warnings = validateDataset('unresolved', [unresolved('unresolved-001', (i) => ((i.gold = 'xhigh'), (i.accept = ['high', 'xhigh'])))]).warnings.join('\n')
  expect(warnings).toMatch(/triage "resolved"/)
  expect(warnings).toMatch(/triage "new"/)
  expect(warnings).toMatch(/over-budget/)
  expect(warnings).toMatch(/gold max/)
})
