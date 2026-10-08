// Applies the user's review of a dataset. The review wizard records one
// decision per line, `{ id, verdict, changes?, note?, at }`:
//
// - `agree`: the item stays as it is;
// - `edit`: `changes` holds the item's new answers (`gold`, `accept`; skill
//   items also `must_not`, `user_only_hint`), which replace the old ones;
// - `note`: the answers stay; `note` is for a person or an agent to follow up.
//
// Any decision may carry a note. The last line for an item is its decision.
// A review that cannot apply in full (an unknown item, a field that is not an
// answer, a line that is not a decision, an edit that breaks the dataset's
// rules) is refused as a whole: the dataset text comes back unchanged.
// Only edited items are written anew; every other line keeps its exact text.
//
// Pure: texts in, text out.

import { parseJsonl, validateDataset, type Extra, type Kind } from './datasets.ts'

export type Verdict = 'agree' | 'edit' | 'note'

export type Reviewed = {
  /** The dataset after the review: the input text when there are errors. */
  text: string
  /** Each edited item's changed answers. Its rationale argued for the old ones: it needs rewriting. */
  edited: { id: string; changes: Record<string, { from: unknown; to: unknown }> }[]
  /** Every decision that carries a note, in dataset order. */
  notes: { id: string; verdict: Verdict; note: string }[]
  /** How many items have each decision. */
  verdicts: Record<Verdict, number>
  /** Items with no decision yet. */
  unreviewed: string[]
  errors: string[]
}

/** The fields a review may change, by kind. */
const EDITABLE: Record<Kind, readonly string[]> = {
  'effort-submit': ['gold', 'accept'],
  'effort-midturn': ['gold', 'accept'],
  subagent: ['gold', 'accept'],
  skill: ['gold', 'accept', 'must_not', 'user_only_hint'],
  unresolved: ['gold', 'accept', 'triage'],
  // The file is written from eval/long-context-items.ts: a review's changes are made there, not by apply-review.ts.
  'long-context': [],
}

const VERDICTS: readonly Verdict[] = ['agree', 'edit', 'note']

type Decision = { verdict: Verdict; changes: Record<string, unknown>; note: string | null }

export function applyReview(kind: Kind, datasetText: string, reviewText: string, extra: Extra = {}): Reviewed {
  const errors: string[] = []
  const lines = datasetText.split('\n')
  const at = new Map<string, number>() // item id -> its line
  const items: Record<string, unknown>[] = []
  lines.forEach((text, i) => {
    if (text.trim() === '') return
    const item = parseJsonl(text).items[0]
    if (item === undefined) return errors.push(`dataset line ${i + 1}: not a JSON object`)
    items.push(item)
    if (typeof item.id === 'string') at.set(item.id, i)
  })

  const decisions = new Map<string, Decision>()
  reviewText.split('\n').forEach((text, i) => {
    if (text.trim() === '') return
    const where = `review line ${i + 1}`
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return errors.push(`${where}: not JSON`)
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return errors.push(`${where}: not a JSON object`)
    const { id, verdict, changes, note } = raw as Record<string, unknown>
    if (typeof id !== 'string' || !at.has(id)) return errors.push(`${where}: no item ${String(id)} in the dataset`)
    if (!VERDICTS.includes(verdict as Verdict)) return errors.push(`${where}: verdict must be agree, edit or note`)
    if (note !== undefined && note !== null && typeof note !== 'string') return errors.push(`${where}: ${id}: note must be text`)
    let edits: Record<string, unknown> = {}
    if (verdict === 'edit') {
      if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) return errors.push(`${where}: ${id}: an edit needs changes`)
      const wrong = Object.keys(changes).filter((field) => !EDITABLE[kind].includes(field))
      if (wrong.length > 0) return errors.push(`${where}: ${id}: ${wrong.map((f) => `changes.${f}`).join(', ')} cannot be edited (${EDITABLE[kind].join(', ')})`)
      edits = changes as Record<string, unknown>
    }
    decisions.set(id, { verdict: verdict as Verdict, changes: edits, note: typeof note === 'string' && note.trim() !== '' ? note : null })
  })

  const edited: Reviewed['edited'] = []
  const notes: Reviewed['notes'] = []
  const verdicts: Record<Verdict, number> = { agree: 0, edit: 0, note: 0 }
  const unreviewed: string[] = []
  const out = [...lines]
  for (const item of items) {
    const id = item.id as string
    const decision = decisions.get(id)
    if (decision === undefined) {
      unreviewed.push(id)
      continue
    }
    verdicts[decision.verdict]++
    if (decision.note !== null) notes.push({ id, verdict: decision.verdict, note: decision.note })
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    for (const [field, to] of Object.entries(decision.changes)) {
      if (JSON.stringify(item[field]) === JSON.stringify(to)) continue
      changes[field] = { from: item[field], to }
      item[field] = to
    }
    if (Object.keys(changes).length === 0) continue
    edited.push({ id, changes })
    out[at.get(id) as number] = JSON.stringify(item)
  }

  errors.push(...validateDataset(kind, items, extra).errors)
  return { text: errors.length === 0 ? out.join('\n') : datasetText, edited, notes, verdicts, unreviewed, errors }
}
