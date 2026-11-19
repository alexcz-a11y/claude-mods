// Hidden checks for task 04. Runs the rollcall import on two files and compares what it rejects and what it stores.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2]
const expected = JSON.parse(readFileSync(join(here, 'expected.json'), 'utf8'))

function parseCsv(text) {
  const records = []
  let record = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1 } else if (char === '"') quoted = false
      else cell += char
    } else if (char === '"') quoted = true
    else if (char === ',') { record.push(cell); cell = '' } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      record.push(cell); records.push(record); record = []; cell = ''
    } else cell += char
  }
  if (cell !== '' || record.length > 0) { record.push(cell); records.push(record) }
  return records.filter((cells) => cells.some((value) => value !== ''))
}

const work = mkdtempSync(join(tmpdir(), 'accept04-'))
const failures = []

try {
  for (const [label, file] of [['reported', 'reported.csv'], ['hidden', 'hidden.csv']]) {
    const want = expected[label]
    const out = join(work, `${label}-cleaned.csv`)
    const done = spawnSync(process.execPath, ['bin/import.mjs', join(here, file), '--schema', join(here, 'schema.json'), '--out', out], {
      cwd: target, encoding: 'utf8', timeout: 30000,
    })
    if (done.error || done.status === null || done.status > 1) {
      failures.push(`${label} file: the import failed (${done.error?.message ?? 'exit ' + done.status}) ${(done.stderr ?? '').trim().split('\n').pop()}`)
      continue
    }
    const reportedProblems = [...done.stdout.matchAll(/^row (\d+), column (\w+)/gm)].map((match) => `${match[1]}:${match[2]}`).sort()
    const wrongly = reportedProblems.filter((problem) => !want.problems.includes(problem))
    const missed = want.problems.filter((problem) => !reportedProblems.includes(problem))
    if (wrongly.length > 0) {
      const columns = [...new Set(wrongly.map((problem) => problem.split(':')[1]))]
      failures.push(`${label} file: ${wrongly.length} good values reported as bad, in ${columns.length} columns (${columns.join(', ')}); first: row ${wrongly[0].replace(':', ', column ')}`)
    }
    if (missed.length > 0) failures.push(`${label} file: bad values not reported: ${missed.join(' ')}`)
    if (want.problems.length > 0 && done.status !== 1) failures.push(`${label} file: exit code ${done.status} although rows were rejected`)

    if (!existsSync(out)) {
      failures.push(`${label} file: --out wrote nothing`)
      continue
    }
    const [, ...stored] = parseCsv(readFileSync(out, 'utf8'))
    if (stored.length !== want.accepted.length) {
      failures.push(`${label} file: ${stored.length} rows stored, expected ${want.accepted.length} of ${want.rows}`)
    } else {
      const differing = []
      stored.forEach((cells, r) => cells.forEach((value, c) => {
        if (value !== want.accepted[r][c]) differing.push(`stored row ${r + 1}, cell ${c + 1}: ${JSON.stringify(value)}, expected ${JSON.stringify(want.accepted[r][c])}`)
      }))
      if (differing.length > 0) failures.push(`${label} file: ${differing.length} stored values differ; first: ${differing[0]}`)
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

for (const line of failures) console.log('FAIL ' + line)
console.log(failures.length ? `${failures.length} checks failed` : 'all checks passed')
process.exit(failures.length ? 1 : 0)
