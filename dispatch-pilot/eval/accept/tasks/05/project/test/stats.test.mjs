import assert from 'node:assert/strict'
import { test } from 'node:test'

import { run } from './helpers.mjs'

test('stats counts the books, in all and per state', () => {
  const { code, out } = run(['stats'])
  assert.equal(code, 0)
  for (const line of ['books: 3', 'to-read: 1', 'reading: 1', 'done: 1']) {
    assert.ok(out.includes(line), `missing "${line}" in ${JSON.stringify(out)}`)
  }
})

test('stats on an empty list', () => {
  const { out } = run(['stats'], [])
  assert.ok(out.includes('books: 0'))
})
