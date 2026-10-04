// Applying the user's review to a dataset (seam 2's data side): the review
// wizard writes one decision per line (`agree`, `edit` with new answers, or
// `note` to follow up); the last line for an item is the decision.

import { expect, test } from 'claude-code/testing'
import { applyReview } from '../eval/lib/review.ts'

function line(id: string, gold: string, accept: string[], spaced = false): string {
  const item = {
    id,
    zh: { message: `消息 ${id}`, recent_context: [] },
    en: { message: `message ${id}`, recent_context: [] },
    gold,
    accept,
    rationale: '理由',
    difficulty: 'hard',
    tags: ['t'],
  }
  return spaced ? JSON.stringify(item, null, 1).replace(/\n\s*/g, ' ') : JSON.stringify(item)
}

const DATASET = [line('s1', 'low', ['low']), line('s2', 'high', ['high', 'xhigh'], true), line('s3', 'max', ['max']), line('s4', 'medium', ['medium'])].join('\n') + '\n'

const review = (...decisions: object[]) => decisions.map((d) => JSON.stringify({ at: '2026-10-04T20:00:00Z', ...d })).join('\n') + '\n'

test('the last decision for an item is applied: edits change its answers, notes are listed, other lines stay byte for byte', () => {
  const reviewed = applyReview(
    'effort-submit',
    DATASET,
    review(
      { id: 's1', verdict: 'agree' },
      { id: 's1', verdict: 'edit', changes: { gold: 'medium', accept: ['low', 'medium'] }, note: '其实要读一下代码' },
      { id: 's2', verdict: 'note', note: '这题 medium 也说得通？' },
      { id: 's3', verdict: 'edit', changes: { gold: 'xhigh', accept: ['xhigh'] } },
      { id: 's3', verdict: 'agree' },
    ),
  )
  expect(reviewed.errors).toEqual([])
  const lines = reviewed.text.split('\n')
  expect(JSON.parse(lines[0] as string)).toMatchObject({ id: 's1', gold: 'medium', accept: ['low', 'medium'], rationale: '理由' })
  // Untouched items keep their exact text (s2 is written with spaces; s3's edit was taken back).
  expect(lines.slice(1)).toEqual(DATASET.split('\n').slice(1))
  expect(reviewed.edited).toEqual([{ id: 's1', changes: { gold: { from: 'low', to: 'medium' }, accept: { from: ['low'], to: ['low', 'medium'] } } }])
  expect(reviewed.notes).toEqual([
    { id: 's1', verdict: 'edit', note: '其实要读一下代码' },
    { id: 's2', verdict: 'note', note: '这题 medium 也说得通？' },
  ])
  expect(reviewed.verdicts).toEqual({ agree: 1, edit: 1, note: 1 })
  expect(reviewed.unreviewed).toEqual(['s4'])
})

test('a review that cannot apply is refused as a whole: unknown items, fields that are not answers, an edit that breaks the rules', () => {
  const reviewed = applyReview(
    'effort-submit',
    DATASET,
    review(
      { id: 's9', verdict: 'agree' },
      { id: 's1', verdict: 'edit', changes: { rationale: '新理由' } },
      { id: 's2', verdict: 'edit', changes: { gold: 'low', accept: ['low', 'xhigh'] } },
      { id: 's3', verdict: 'maybe' },
    ) + 'not json\n',
  )
  expect(reviewed.errors).toEqual([
    'review line 1: no item s9 in the dataset',
    'review line 2: s1: changes.rationale cannot be edited (gold, accept)',
    'review line 4: verdict must be agree, edit or note',
    'review line 5: not JSON',
    's2: accept ["low","xhigh"] is not contiguous: acceptable levels must be adjacent',
  ])
  expect(reviewed.text).toBe(DATASET)
})
