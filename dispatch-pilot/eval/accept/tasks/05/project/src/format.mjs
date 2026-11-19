// One line per book: "Title / Author | 312 p. | done | 4/5 | #tag #tag".
export function formatBook(book) {
  const parts = [`${book.title} / ${book.author}`, `${book.pages} p.`, book.status]
  if (book.rating != null) parts.push(`${book.rating}/5`)
  if (book.tags.length > 0) parts.push(book.tags.map((tag) => `#${tag}`).join(' '))
  return parts.join(' | ')
}
