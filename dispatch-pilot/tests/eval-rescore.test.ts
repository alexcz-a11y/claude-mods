// Stored answers decided again under the rules of the AA routing (eval/lib/rescore.ts): the effort
// picked with the level above taken at 0.3, the mid-turn gates of 0.3 / 0.75, an agent's effort lifted
// to its model's floor, each against the rule before (0.2.1). Nothing is asked: the figures are worked
// out by hand from the probabilities each stored answer holds. Pure, no `$`.

import { expect, test } from 'claude-code/testing'
import { readConfig } from '../hooks/core/setup.ts'
import { legacyPickEffort, rescoreAgents, rescoreMidturn, rescoreSubmit, scanThetaDown } from '../eval/lib/rescore.ts'
import type { AgentItem, EffortMidturnItem, EffortSubmitItem } from '../eval/lib/datasets.ts'

const submit = (id: string, gold: EffortSubmitItem['gold'], accept: EffortSubmitItem['accept']): EffortSubmitItem => ({
  id,
  zh: { message: `${id} 中文`, recent_context: [] },
  en: { message: `${id} english`, recent_context: [] },
  gold,
  accept,
  rationale: '理由',
  difficulty: 'hard',
  tags: [],
})

/** A stored result file as the rescoring reads it: one answer per language and item, the variant's `p` inside. */
const stored = (variant: string, rows: [id: string, language: 'zh' | 'en', detail: Record<string, unknown>][], settings: { thetaMax: number; options?: Record<string, unknown> } = { thetaMax: 0.5 }) => ({
  settings,
  summary: { variants: [{ variant }] },
  answers: rows.map(([id, language, detail]) => ({ id, language, [variant]: detail })),
})

test('the effort picked, the rule before and the rule now, over the answers a result file holds: accuracy, gold, too high and too low', () => {
  const items = [submit('a', 'high', ['high', 'xhigh']), submit('b', 'low', ['low', 'medium'])]
  const result = stored('zh-score', [
    // high 0.55 with xhigh 0.35 above it: high before (acceptable, gold), xhigh now (acceptable, not gold).
    ['a', 'zh', { p: [0, 0.1, 0.55, 0.35, 0], confidence: 0.6 }],
    // medium 0.6 with high 0.3: medium before (too low for a), high now (gold).
    ['a', 'en', { p: [0, 0.6, 0.3, 0.1, 0], confidence: 0.6 }],
    // medium 0.5 with high 0.4 above it: medium before (acceptable), high now (too high for b).
    ['b', 'zh', { p: [0.1, 0.5, 0.4, 0, 0], confidence: 0.6 }],
    // low 0.9: low both times (gold).
    ['b', 'en', { p: [0.9, 0.1, 0, 0, 0], confidence: 0.6 }],
  ])
  const [row] = rescoreSubmit(result, items)
  expect(row?.variant).toBe('zh-score')
  // Before: a zh high (right, gold), a en medium (too low), b zh medium (right), b en low (right, gold).
  expect(row?.before).toEqual({ n: 4, accuracy: 0.75, gold: 0.5, over: 0, under: 0.25 })
  // Now: a zh xhigh (right), a en high (right, gold), b zh high (too high), b en low (right, gold).
  expect(row?.now).toEqual({ n: 4, accuracy: 0.75, gold: 0.5, over: 0.25, under: 0 })
})

test('the rule before, kept for the comparison: the most likely level, a tie to the higher, max only past thetaMax', () => {
  const read = (probabilities: number[]) => ({ probabilities, confidence: 0.6 })
  expect(legacyPickEffort(read([0, 0.5, 0.3, 0.2, 0]), 0.5)).toBe('medium')
  expect(legacyPickEffort(read([0, 0.5, 0.5, 0, 0]), 0.5)).toBe('high')
  expect(legacyPickEffort(read([0, 0, 0.2, 0.3, 0.5]), 0.6)).toBe('xhigh')
  expect(legacyPickEffort(read([0, 0, 0.2, 0.3, 0.5]), 0.5)).toBe('max')
})

const midturn = (id: string, gold: EffortMidturnItem['gold'], accept: EffortMidturnItem['accept'], current: EffortMidturnItem['gold']): EffortMidturnItem => {
  const asked = { message: id, step: 3, current_effort: current, counts: { judgments: 1, changes: 0, failures: 0, hook_blocks: 0 }, recent_steps: [] }
  return { id, zh: asked, en: asked, gold, accept, rationale: '理由', difficulty: 'hard', tags: [] }
}

test('the level a mid-turn answer sends: the gates of before (0.4 up, 0.6 down) and the gates given (here those of 0.2.2, 0.3 up, 0.75 down), each with its own pick', () => {
  const items = [midturn('a', 'high', ['high'], 'medium'), midturn('b', 'low', ['low', 'medium'], 'high')]
  const result = stored('en-score', [
    // Up to high, confidence 0.35: before it was not sure enough (stays medium), now it is (0.3).
    ['a', 'zh', { p: [0, 0.4, 0.6, 0, 0], confidence: 0.35, sent: 'medium', why: 'unsure' }],
    // Down to low, confidence 0.7: before sure enough (one level, to medium), now not (0.75): stays high.
    ['b', 'zh', { p: [0.6, 0.4, 0, 0, 0], confidence: 0.7, sent: 'medium', why: 'down' }],
  ])
  const [picked, sent] = rescoreMidturn(result, items, { thetaUp: 0.3, thetaDown: 0.75, thetaMax: 0.5, roundUp: 0.3, holdSteps: 5 })
  expect([picked?.what, sent?.what]).toEqual(['picked', 'sent'])
  // Picked before: a high (right), b low (right). Now: a high (right), b low then the level above, medium (right).
  expect(picked?.before).toEqual({ n: 2, accuracy: 1, gold: 1, over: 0, under: 0 })
  expect(picked?.now).toEqual({ n: 2, accuracy: 1, gold: 0.5, over: 0, under: 0 })
  // Sent before: a medium (too low), b medium (right). Now: a high (right, gold), b stays high (too high).
  expect(sent?.before).toEqual({ n: 2, accuracy: 0.5, gold: 0, over: 0, under: 0.5 })
  expect(sent?.now).toEqual({ n: 2, accuracy: 0.5, gold: 0.5, over: 0.5, under: 0 })
})

const agent = (id: string, gold: AgentItem['gold'], accept: AgentItem['accept']): AgentItem => {
  const asked = { user_message: id, kind: 'agent' as const, agent_type: 'general-purpose', description: id, prompt: id, requested_model: null, workflow_description: null, label: null }
  return { id, zh: asked, en: asked, gold, accept, rationale: '理由', difficulty: 'hard', tags: [] }
}

test("a dispatched agent's effort: the rule before against the pick, the level above and the model's floor (sonnet and opus at medium), the model decided as it was stored", () => {
  const items = [agent('a', { model: 'sonnet', effort: 'medium' }, { model: ['sonnet'], effort: ['medium', 'high'] }), agent('b', { model: 'opus', effort: 'medium' }, { model: ['opus'], effort: ['medium', 'high'] })]
  const result = stored(
    'models-hint',
    [
      // sonnet, low 1: low before (too low), medium now (the floor; gold).
      ['a', 'zh', { source: 'decided', p_model: { haiku: 0, sonnet: 1, opus: 0 }, p_effort: [1, 0, 0, 0, 0], nouls: {} }],
      // opus, low 1: low before (too low), medium now (the floor; gold).
      ['b', 'zh', { source: 'decided', p_model: { haiku: 0, sonnet: 0, opus: 1 }, p_effort: [1, 0, 0, 0, 0], nouls: {} }],
    ],
    { thetaMax: 0.5, options: { decisionModel: 'jev', agentOverride: 0.6 } },
  )
  const [row] = rescoreAgents(result, items)
  expect(row?.before).toEqual({ n: 2, accuracy: 0, gold: 0, over: 0, under: 1, effort: 0 })
  expect(row?.now).toEqual({ n: 2, accuracy: 1, gold: 1, over: 0, under: 0, effort: 1 })
})

test('a thetaDown scan: the level sent at each gate over the same stored answers, the other rules unchanged, for both languages and for each', () => {
  const items = [midturn('a', 'low', ['low', 'medium'], 'high'), midturn('b', 'high', ['high'], 'medium'), midturn('c', 'low', ['low'], 'medium')]
  const result = stored('zh-score', [
    // Low at 0.75, confidence 0.7, at high: down to medium (right, not gold) when the gate is 0.7 or lower, stays high (too high) at 0.75.
    ['a', 'zh', { p: [0.75, 0.25, 0, 0, 0], confidence: 0.7 }],
    // High at 0.8, confidence 0.9, at medium: a raise, so the gate for a lowering does not touch it (right, gold).
    ['b', 'zh', { p: [0, 0.2, 0.8, 0, 0], confidence: 0.9 }],
    ['b', 'en', { p: [0, 0.2, 0.8, 0, 0], confidence: 0.9 }],
    // Low at 0.8, confidence 0.6, at medium: down to low (gold) from 0.6 down, stays medium (too high) above it.
    ['c', 'en', { p: [0.8, 0.2, 0, 0, 0], confidence: 0.6 }],
  ])
  const scan = scanThetaDown(result, items, [0.55, 0.65, 0.75])
  const at = (language: string, thetaDown: number) => scan.find((row) => row.variant === 'zh-score' && row.language === language && row.thetaDown === thetaDown)?.sent
  expect(scan.length).toBe(9)
  expect(at('both', 0.55)).toEqual({ n: 4, accuracy: 1, gold: 0.75, over: 0, under: 0 })
  expect(at('both', 0.65)).toEqual({ n: 4, accuracy: 0.75, gold: 0.5, over: 0.25, under: 0 })
  expect(at('both', 0.75)).toEqual({ n: 4, accuracy: 0.5, gold: 0.5, over: 0.5, under: 0 })
  expect(at('zh', 0.55)).toEqual({ n: 2, accuracy: 1, gold: 0.5, over: 0, under: 0 })
  expect(at('zh', 0.75)).toEqual({ n: 2, accuracy: 0.5, gold: 0.5, over: 0.5, under: 0 })
  expect(at('en', 0.55)).toEqual({ n: 2, accuracy: 1, gold: 1, over: 0, under: 0 })
  expect(at('en', 0.65)).toEqual({ n: 2, accuracy: 0.5, gold: 0.5, over: 0.5, under: 0 })
})

test('a thetaDown scan: at the gate the mod shipped with, the figures are what rescoreMidturn gives for `sent`', () => {
  const items = [midturn('a', 'low', ['low', 'medium'], 'high')]
  const result = stored('en-score', [['a', 'zh', { p: [0.75, 0.25, 0, 0, 0], confidence: 0.7 }]])
  const [row] = scanThetaDown(result, items, [readConfig({}).midturn.rules.thetaDown])
  const [, sent] = rescoreMidturn(result, items)
  expect(row?.language).toBe('both')
  expect(row?.sent).toEqual(sent?.now)
})
