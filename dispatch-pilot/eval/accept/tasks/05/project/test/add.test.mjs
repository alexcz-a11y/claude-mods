import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BOOKS, run } from './helpers.mjs'

test('add puts the book at the end of the file', () => {
  const { code, out, books } = run(['add', '--title', 'Dogwood', '--author', 'Di Dunn', '--pages', '310', '--tags', 'trees, long'])
  assert.equal(code, 0)
  assert.deepEqual(out, ['added: Dogwood'])
  assert.equal(books.length, BOOKS.length + 1)
  assert.deepEqual(books.at(-1), { title: 'Dogwood', author: 'Di Dunn', pages: 310, status: 'to-read', tags: ['trees', 'long'] })
})

test('add keeps a rating and a status', () => {
  const { books } = run(['add', '--title', 'Elm', '--author', 'Ed Eck', '--pages', '90', '--status', 'done', '--rating', '4'])
  assert.equal(books.at(-1).status, 'done')
  assert.equal(books.at(-1).rating, 4)
})

test('add refuses a book with no title, and leaves the file alone', () => {
  const { code, err, books } = run(['add', '--author', 'Di Dunn', '--pages', '310'])
  assert.equal(code, 1)
  assert.match(err[0], /--title is required/)
  assert.deepEqual(books, BOOKS)
})

test('add refuses a rating outside 1 to 5', () => {
  const { code, books } = run(['add', '--title', 'Fir', '--author', 'Flo Fay', '--pages', '12', '--rating', '6'])
  assert.equal(code, 1)
  assert.deepEqual(books, BOOKS)
})
