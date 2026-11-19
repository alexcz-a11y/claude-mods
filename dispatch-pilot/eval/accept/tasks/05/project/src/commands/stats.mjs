import { STATUSES } from '../book.mjs'

// stats
export function stats(books) {
  const lines = [`books: ${books.length}`]
  for (const status of STATUSES) {
    lines.push(`${status}: ${books.filter((book) => book.status === status).length}`)
  }
  return lines
}
