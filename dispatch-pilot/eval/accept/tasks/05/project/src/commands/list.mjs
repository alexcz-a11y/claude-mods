import { STATUSES } from '../book.mjs'
import { UsageError } from '../errors.mjs'
import { formatBook } from '../format.mjs'

// list [--status to-read|reading|done]
export function list(books, { flags }) {
  let shown = books
  if (flags.status !== undefined) {
    if (!STATUSES.includes(flags.status)) {
      throw new UsageError(`--status has to be one of ${STATUSES.join(', ')}`)
    }
    shown = shown.filter((book) => book.status === flags.status)
  }
  return shown.map(formatBook)
}
