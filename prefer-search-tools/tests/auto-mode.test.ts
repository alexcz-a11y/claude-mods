import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { register, SEARCH_CLAUSE, SEARCH_STEER } from '../hooks/prefer-search-tools.ts'

// Stand-ins for the reminder: the clause the mod looks for, between words of our own (the engine's text is not copied here).
const REMINDER = `Before the clause: read files one way, ${SEARCH_CLAUSE}and edit them another. After it, more advice.`
const OTHER = 'A reminder of the same type that never mentions searching.'

const engine = (on: On) => on('prompt.attachment', (_$, e) => ({ text: e.text }))

test('only the search clause of the auto-mode reminder is replaced; the rest is the engine\'s, word for word', async ($, on) => {
  engine(on)
  register(on)
  const out = (await $.prompt.attachment({ type: 'auto_mode', text: REMINDER, origin: { kind: 'engine' } })).text
  expect(out).toBe(`Before the clause: read files one way, and edit them another. After it, more advice.\n\n${SEARCH_STEER}`)
})

test('a reminder without the clause, and attachments of other types, go on unchanged', async ($, on) => {
  engine(on)
  register(on)
  expect((await $.prompt.attachment({ type: 'auto_mode', text: OTHER, origin: { kind: 'engine' } })).text).toBe(OTHER)
  expect((await $.prompt.attachment({ type: 'todo_reminder', text: REMINDER, origin: { kind: 'engine' } })).text).toBe(REMINDER)
})
