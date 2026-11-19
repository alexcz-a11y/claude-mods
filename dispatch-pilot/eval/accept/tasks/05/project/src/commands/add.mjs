import { STATUSES } from '../book.mjs'
import { UsageError } from '../errors.mjs'

// add --title T --author A --pages N [--status S] [--rating 1-5] [--tags a,b]
export function add(books, { flags }, save) {
  const title = required(flags.title, 'title')
  const author = required(flags.author, 'author')
  const pages = Number(flags.pages)
  if (!Number.isInteger(pages) || pages <= 0) {
    throw new UsageError('--pages has to be a whole number above zero')
  }
  const status = flags.status ?? 'to-read'
  if (!STATUSES.includes(status)) {
    throw new UsageError(`--status has to be one of ${STATUSES.join(', ')}`)
  }
  const book = { title, author, pages, status }
  if (flags.rating !== undefined) {
    const rating = Number(flags.rating)
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new UsageError('--rating has to be a whole number from 1 to 5')
    }
    book.rating = rating
  }
  book.tags = tagList(flags.tags)
  save([...books, book])
  return [`added: ${title}`]
}

function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new UsageError(`--${name} is required`)
  return value.trim()
}

function tagList(value) {
  if (typeof value !== 'string') return []
  return value.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '')
}
