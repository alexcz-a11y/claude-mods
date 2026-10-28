// Stored answers decided again under the base rule of 0.9.0 (eval/lib/rescore.ts, ADR 0014): the position
// rounded, one up when two-peaked, an agent's effort lifted to its model's floor; each against the rule the
// run recorded (the most probable level, max at its thetaMax, the level above at its roundUp). Nothing is
// asked: the figures are worked out by hand from the probabilities each stored answer holds. Pure, no `$`.

import { expect, test } from 'claude-code/testing'
import { legacyPickEffort, rescoreAgents, rescoreSubmit } from '../eval/lib/rescore.ts'
import type { AgentItem, EffortSubmitItem } from '../eval/lib/datasets.ts'

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
const stored = (variant: string, rows: [id: string, language: 'zh' | 'en', detail: Record<string, unknown>][], settings: { thetaMax: number; roundUp?: number; options?: Record<string, unknown> } = { thetaMax: 0.5 }) => ({
  settings,
  summary: { variants: [{ variant }] },
  answers: rows.map(([id, language, detail]) => ({ id, language, [variant]: detail })),
})

test('the effort picked, the rule before and the rule now, over the answers a result file holds: accuracy, gold, too high and too low', () => {
  const items = [submit('a', 'high', ['high', 'xhigh']), submit('b', 'low', ['low', 'medium'])]
  const result = stored('zh-score', [
    // high 0.55 with xhigh 0.35 above it: xhigh before (taken up at 0.3; acceptable, not gold), high now (position 2.25; gold).
    ['a', 'zh', { p: [0, 0.1, 0.55, 0.35, 0], confidence: 0.6 }],
    // medium 0.6 with high 0.3: high before (taken up; gold), high now (position 1.5, half going up; gold).
    ['a', 'en', { p: [0, 0.6, 0.3, 0.1, 0], confidence: 0.6 }],
    // medium 0.5 with high 0.4 above it: high before (too high for b), medium now (position 1.3; acceptable).
    ['b', 'zh', { p: [0.1, 0.5, 0.4, 0, 0], confidence: 0.6 }],
    // low 0.9: low both times (gold).
    ['b', 'en', { p: [0.9, 0.1, 0, 0, 0], confidence: 0.6 }],
  ])
  const [row] = rescoreSubmit(result, items)
  expect(row?.variant).toBe('zh-score')
  // Before: a zh xhigh (right), a en high (right, gold), b zh high (too high), b en low (right, gold).
  expect(row?.before).toEqual({ n: 4, accuracy: 0.75, gold: 0.5, over: 0.25, under: 0 })
  // Now: a zh high (right, gold), a en high (right, gold), b zh medium (right), b en low (right, gold).
  expect(row?.now).toEqual({ n: 4, accuracy: 1, gold: 0.75, over: 0, under: 0 })
})

test('the rule before, kept for the comparison: the most likely level, a tie to the higher, max only past thetaMax', () => {
  const read = (probabilities: number[]) => ({ probabilities, confidence: 0.6 })
  expect(legacyPickEffort(read([0, 0.5, 0.3, 0.2, 0]), 0.5)).toBe('medium')
  expect(legacyPickEffort(read([0, 0.5, 0.5, 0, 0]), 0.5)).toBe('high')
  expect(legacyPickEffort(read([0, 0, 0.2, 0.3, 0.5]), 0.6)).toBe('xhigh')
  expect(legacyPickEffort(read([0, 0, 0.2, 0.3, 0.5]), 0.5)).toBe('max')
})

const agent = (id: string, gold: AgentItem['gold'], accept: AgentItem['accept']): AgentItem => {
  const asked = { user_message: id, kind: 'agent' as const, agent_type: 'general-purpose', description: id, prompt: id, requested_model: null, workflow_description: null, label: null }
  return { id, zh: asked, en: asked, gold, accept, rationale: '理由', difficulty: 'hard', tags: [] }
}

test("a dispatched agent's effort: the rule before against the base rule now with the model's floor (sonnet and opus at medium), the model as the run stored it (its answer)", () => {
  const items = [agent('a', { model: 'sonnet', effort: 'medium' }, { model: ['sonnet'], effort: ['medium', 'high'] }), agent('b', { model: 'opus', effort: 'medium' }, { model: ['opus'], effort: ['medium', 'high'] })]
  const result = stored(
    'models-hint',
    [
      // sonnet, low 1: low before (too low), medium now (the floor; gold).
      ['a', 'zh', { answer: 'sonnet low', source: 'decided', p_model: { haiku: 0, sonnet: 1, opus: 0 }, p_effort: [1, 0, 0, 0, 0], nouls: {} }],
      // opus, low 1: low before (too low), medium now (the floor; gold).
      ['b', 'zh', { answer: 'opus low', source: 'decided', p_model: { haiku: 0, sonnet: 0, opus: 1 }, p_effort: [1, 0, 0, 0, 0], nouls: {} }],
      // No answer stored (a failed request): not rescored.
      ['c', 'zh', { p_effort: [1, 0, 0, 0, 0] }],
    ],
    { thetaMax: 0.5, options: { decisionModel: 'jev' } },
  )
  const [row] = rescoreAgents(result, items)
  expect(row?.before).toEqual({ n: 2, accuracy: 0, gold: 0, over: 0, under: 1, effort: 0 })
  expect(row?.now).toEqual({ n: 2, accuracy: 1, gold: 1, over: 0, under: 0, effort: 1 })
})

// A run with --repeat has a line for each time (`repeat`); its summary counts the first time, so the rescoring reads that one.
test('the lines of the later times of a repeat run are not counted again', () => {
  const items = [submit('a', 'high', ['high'])]
  const result = stored('zh-score', [['a', 'zh', { p: [0, 0, 1, 0, 0], confidence: 0.9 }]])
  const again = { id: 'a', language: 'zh', repeat: 2, 'zh-score': { p: [1, 0, 0, 0, 0], confidence: 0.9 } }
  const first = { ...result.answers[0], repeat: 1 }
  const [row] = rescoreSubmit({ ...result, answers: [first, again] }, items)
  expect(row?.now).toEqual({ n: 1, accuracy: 1, gold: 1, over: 0, under: 0 })
})
