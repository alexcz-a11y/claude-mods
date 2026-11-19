import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main } from '../src/cli.mjs'

export const BOOKS = [
  { title: 'Alder', author: 'Ann Ames', pages: 100, status: 'done', rating: 5, tags: ['trees'] },
  { title: 'Birch', author: 'Bo Barr', pages: 250, status: 'reading', tags: [] },
  { title: 'Cedar', author: 'Cy Coe', pages: 80, status: 'to-read', tags: ['trees', 'short'] },
]

// Runs the command line on a throwaway copy of `books` and reports what it printed and left behind.
export function run(argv, books = BOOKS) {
  const file = join(mkdtempSync(join(tmpdir(), 'readlog-')), 'books.json')
  writeFileSync(file, JSON.stringify(books))
  const out = []
  const err = []
  const code = main([...argv, '--file', file], { out: (line) => out.push(line), err: (line) => err.push(line) })
  return { code, out, err, books: JSON.parse(readFileSync(file, 'utf8')) }
}
