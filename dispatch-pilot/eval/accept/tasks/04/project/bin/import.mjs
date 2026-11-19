#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parseCsv, toCsv } from '../src/csv.mjs'
import { checkRows } from '../src/runner.mjs'

const DEFAULT_SCHEMA = fileURLToPath(new URL('../data/schema.json', import.meta.url))

function parseArgs(argv) {
  const options = { input: null, schema: DEFAULT_SCHEMA, out: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--schema') options.schema = argv[++i]
    else if (arg === '--out') options.out = argv[++i]
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
    else if (options.input === null) options.input = arg
    else throw new Error(`unexpected argument ${arg}`)
  }
  if (!options.input || !options.schema) {
    throw new Error('usage: import.mjs <members.csv> [--schema <schema.json>] [--out <cleaned.csv>]')
  }
  return options
}

try {
  const options = parseArgs(process.argv.slice(2))
  const schema = JSON.parse(readFileSync(options.schema, 'utf8'))
  const table = parseCsv(readFileSync(options.input, 'utf8'))
  const result = checkRows(table, schema)

  for (const problem of result.problems) {
    process.stdout.write(`row ${problem.row}, column ${problem.column}: ${problem.message}\n`)
  }
  const rejected = table.rows.length - result.accepted.length
  process.stdout.write(`${table.rows.length} rows read, ${result.accepted.length} accepted, ${rejected} rejected\n`)
  if (options.out) writeFileSync(options.out, toCsv(table.header, result.accepted))
  process.exitCode = rejected > 0 ? 1 : 0
} catch (problem) {
  process.stderr.write(`error: ${problem.message}\n`)
  process.exitCode = 2
}
