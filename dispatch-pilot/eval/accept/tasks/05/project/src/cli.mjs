import { parseArgs } from './args.mjs'
import { add } from './commands/add.mjs'
import { list } from './commands/list.mjs'
import { stats } from './commands/stats.mjs'
import { UsageError } from './errors.mjs'
import { loadBooks, resolveFile, saveBooks } from './store.mjs'

// A command gets the books, the parsed command line and a function that writes a new list back
// to the file. It returns the lines to print.
const COMMANDS = { add, list, stats }

export function main(argv, io) {
  const args = parseArgs(argv)
  if (!Object.hasOwn(COMMANDS, args.command ?? '')) {
    io.err(`usage: readlog <${Object.keys(COMMANDS).join('|')}> [options] [--file books.json]`)
    return 1
  }
  const file = resolveFile(args.flags)
  try {
    const lines = COMMANDS[args.command](loadBooks(file), args, (books) => saveBooks(file, books))
    for (const line of lines) io.out(line)
    return 0
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    io.err(`error: ${error.message}`)
    return 1
  }
}
