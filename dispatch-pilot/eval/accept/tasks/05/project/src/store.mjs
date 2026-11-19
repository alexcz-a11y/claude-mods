import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'books.json')

export function resolveFile(flags) {
  return typeof flags.file === 'string' ? flags.file : DEFAULT_FILE
}

export function loadBooks(file) {
  const books = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(books)) throw new Error(`${file}: expected a list of books`)
  return books
}

export function saveBooks(file, books) {
  writeFileSync(file, JSON.stringify(books, null, 2) + '\n')
}
