// Hidden checks for task 05. Runs the readlog command line on its own book lists; every check is
// one of the four things the request asks for, or that what was there before still works.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2]
const HIDDEN = JSON.parse(readFileSync(join(here, 'books.json'), 'utf8'))
const work = mkdtempSync(join(tmpdir(), 'accept05-'))
const failures = []
let files = 0

function fail(label, message) {
  failures.push(`${label}: ${message}`)
}

// Runs one command on a fresh copy of `books`; reports the exit code, the output and the file afterwards.
function run(args, books = HIDDEN) {
  files += 1
  const file = join(work, `books-${files}.json`)
  writeFileSync(file, JSON.stringify(books, null, 2) + '\n')
  return again(args, file)
}

function again(args, file) {
  const done = spawnSync(process.execPath, ['bin/readlog.mjs', ...args, '--file', file], {
    cwd: target, encoding: 'utf8', timeout: 30000,
  })
  let after = null
  try {
    after = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    after = null
  }
  return { file, code: done.error ? -1 : done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '', after }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const lower = (text) => text.toLowerCase()

// The titles a listing shows, in the order it shows them. A line belongs to the book whose title it carries.
function titlesListed(stdout, books) {
  const titles = []
  for (const line of stdout.split('\n')) {
    const found = books.filter((book) => line.includes(book.title)).map((book) => book.title)
    if (found.length > 0) titles.push(found.sort((a, b) => b.length - a.length)[0])
  }
  return titles
}

function withTags(books, tags, status) {
  return books
    .filter((book) => tags.every((tag) => book.tags.some((own) => lower(own) === lower(tag))))
    .filter((book) => status === undefined || book.status === status)
    .map((book) => book.title)
}

// "key: value" lines of the stats output, keys in lower case.
function statLines(stdout) {
  const stats = new Map()
  for (const line of stdout.split('\n')) {
    const at = line.lastIndexOf(':')
    if (at > 0) stats.set(line.slice(0, at).trim().toLowerCase().replace(/\s+/g, ' '), line.slice(at + 1).trim())
  }
  return stats
}

// --- 0. what was there before -------------------------------------------------------------

{
  const done = run(['list'])
  if (done.code !== 0) fail('list', `exit ${done.code} ${done.stderr.trim()}`)
  else if (!same(titlesListed(done.stdout, HIDDEN), HIDDEN.map((book) => book.title))) fail('list', 'does not print every book in the order of the file')
  const reading = run(['list', '--status', 'reading'])
  if (!same(titlesListed(reading.stdout, HIDDEN), withTags(HIDDEN, [], 'reading'))) fail('list --status reading', 'wrong books')
}

// --- 1. list --tag ------------------------------------------------------------------------

const TAG_CASES = [
  [['sci-fi']],
  [['SCI-FI', 'Favourite']],
  [['favourite', 'sea', 'short']],
  [['sea'], 'done'],
  [['sci']],
  [['nature']],
  [['nothing-has-this']],
  [['poetry', 'long']],
]
for (const [tags, status] of TAG_CASES) {
  const args = ['list', ...tags.flatMap((tag) => ['--tag', tag]), ...(status ? ['--status', status] : [])]
  const label = args.join(' ')
  const done = run(args)
  if (done.code !== 0) {
    fail(label, `exit ${done.code} ${done.stderr.trim()}`)
    continue
  }
  const got = titlesListed(done.stdout, HIDDEN)
  const expected = withTags(HIDDEN, tags, status)
  if (!same(got, expected)) fail(label, `listed ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`)
}

// --- 2. stats -----------------------------------------------------------------------------

const unrated = HIDDEN.map(({ rating, ...book }) => book)
const STAT_CASES = [
  ['the hidden list', HIDDEN, '1911', 3.8],
  ['no book has a rating', unrated, '1911', null],
  ['nothing is finished', unrated.map((book) => ({ ...book, status: 'to-read' })), '0', null],
  ['two ratings', HIDDEN.slice(0, 3), '420', 4.5],
  ['an empty list', [], '0', null],
]
for (const [label, books, pages, average] of STAT_CASES) {
  const done = run(['stats'], books)
  if (done.code !== 0) {
    fail(`stats, ${label}`, `exit ${done.code} ${done.stderr.trim()}`)
    continue
  }
  const stats = statLines(done.stdout)
  if (stats.get('books') !== String(books.length)) fail(`stats, ${label}`, 'the "books:" line is gone or wrong')
  const finished = books.filter((book) => book.status === 'done').length
  if (stats.get('done') !== String(finished)) fail(`stats, ${label}`, 'the "done:" line is gone or wrong')
  if (stats.get('pages read') !== pages) fail(`stats, ${label}`, `"pages read" is ${stats.get('pages read')}, expected ${pages}`)
  const shown = stats.get('average rating')
  if (average === null) {
    if (shown !== '-') fail(`stats, ${label}`, `"average rating" is ${shown}, expected -`)
  } else if (shown === undefined || !/^\d+(\.\d+)?$/.test(shown) || Math.abs(Number(shown) - average) > 1e-9) {
    fail(`stats, ${label}`, `"average rating" is ${shown}, expected ${average.toFixed(1)}`)
  }
}

// --- 3. add refuses a book that is already there ---------------------------------------------

{
  const twice = run(['add', '--title', '  lighthouse ARITHMETIC ', '--author', 'dara voss', '--pages', '100'])
  if (twice.code === 0) fail('add, same title and author', 'exit 0')
  if (!same(twice.after, HIDDEN)) fail('add, same title and author', 'the file changed')

  const exact = run(['add', '--title', 'Scion', '--author', 'Seren Abara', '--pages', '149'])
  if (exact.code === 0 || !same(exact.after, HIDDEN)) fail('add, the very same book', 'was not refused, or the file changed')

  const otherAuthor = run(['add', '--title', 'Lighthouse Arithmetic', '--author', 'Ilan Petrov', '--pages', '100'])
  if (otherAuthor.code !== 0 || otherAuthor.after?.length !== HIDDEN.length + 1) fail('add, same title by another author', `was not added (exit ${otherAuthor.code})`)

  const otherTitle = run(['add', '--title', 'Brand New Book', '--author', 'Dara Voss', '--pages', '77', '--tags', 'a,b'])
  const added = otherTitle.after?.at(-1)
  if (otherTitle.code !== 0 || otherTitle.after?.length !== HIDDEN.length + 1 || added?.title !== 'Brand New Book' || added?.pages !== 77 || !same(added?.tags, ['a', 'b'])) {
    fail('add, a new title by a known author', `was not added as before (exit ${otherTitle.code})`)
  } else {
    const before = otherTitle.after
    const repeat = again(['add', '--title', 'BRAND new book', '--author', ' Dara Voss', '--pages', '77'], otherTitle.file)
    if (repeat.code === 0 || !same(repeat.after, before)) fail('add, the book just added, again', 'was not refused, or the file changed')
  }
}

// --- 4. finish ----------------------------------------------------------------------------

function finished(label, args, title, rating) {
  const done = run(['finish', ...args])
  if (done.code !== 0 || !Array.isArray(done.after)) {
    fail(label, `exit ${done.code} ${done.stderr.trim()}`)
    return
  }
  if (done.after.length !== HIDDEN.length) {
    fail(label, 'the number of books changed')
    return
  }
  done.after.forEach((book, index) => {
    const before = HIDDEN[index]
    if (before.title !== title) {
      if (!same(book, before)) fail(label, `"${before.title}" changed`)
      return
    }
    if (book.title !== title || book.author !== before.author || book.pages !== before.pages || !same(book.tags, before.tags)) fail(label, `"${title}" lost something`)
    if (book.status !== 'done') fail(label, `"${title}" has status ${book.status}`)
    if (rating === null ? book.rating != null : book.rating !== rating) fail(label, `"${title}" has rating ${JSON.stringify(book.rating)}, expected ${rating}`)
  })
}

function refused(label, args) {
  const done = run(['finish', ...args])
  if (done.code === 0) fail(label, 'exit 0')
  if (!same(done.after, HIDDEN)) fail(label, 'the file changed')
}

finished('finish "kelp" --rating 5', ['kelp', '--rating', '5'], 'Kelp Roads', 5)
finished('finish "ENGINES of the low"', ['ENGINES of the low'], 'Engines of the Low Country', null)
finished('finish "The Other Cartographer" --rating 1', ['The Other Cartographer', '--rating', '1'], 'The Other Cartographer', 1)
finished('finish "wint"', ['wint'], 'Winter Ledger', null)
refused('finish "s" (two titles start with it)', ['s'])
refused('finish "zzz" (no title starts with it)', ['zzz'])
refused('finish "roads" (inside a title, not at its start)', ['roads'])
refused('finish "the" --rating 9', ['the', '--rating', '9'])

rmSync(work, { recursive: true, force: true })

if (failures.length > 0) {
  console.log(`FAIL (${failures.length})`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log('PASS')
