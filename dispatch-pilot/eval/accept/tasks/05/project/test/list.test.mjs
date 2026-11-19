import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BOOKS, run } from './helpers.mjs'

test('list prints one line per book, in the order of the file', () => {
  const { code, out } = run(['list'])
  assert.equal(code, 0)
  assert.equal(out.length, BOOKS.length)
  assert.equal(out[0], 'Alder / Ann Ames | 100 p. | done | 5/5 | #trees')
  assert.equal(out[1], 'Birch / Bo Barr | 250 p. | reading')
  assert.equal(out[2], 'Cedar / Cy Coe | 80 p. | to-read | #trees #short')
})

test('--status keeps the books in that state', () => {
  const { out } = run(['list', '--status', 'reading'])
  assert.deepEqual(out, ['Birch / Bo Barr | 250 p. | reading'])
})

test('a status that does not exist is refused', () => {
  const { code, out, err } = run(['list', '--status', 'lost'])
  assert.equal(code, 1)
  assert.deepEqual(out, [])
  assert.match(err[0], /^error: --status has to be one of/)
})
