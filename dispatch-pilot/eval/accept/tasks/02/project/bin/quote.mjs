#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { loadCatalog } from '../src/catalog.mjs'
import { buildQuote } from '../src/quote.mjs'
import { renderQuote } from '../src/render.mjs'

const DEFAULT_CATALOG = fileURLToPath(new URL('../data/catalog.json', import.meta.url))

function parseArgs(argv) {
  const options = { orderPath: null, catalogPath: DEFAULT_CATALOG, json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--catalog') options.catalogPath = argv[++i]
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
    else if (options.orderPath === null) options.orderPath = arg
    else throw new Error(`unexpected argument ${arg}`)
  }
  if (!options.orderPath || !options.catalogPath) {
    throw new Error('usage: quote.mjs <order.json> [--catalog <catalog.json>] [--json]')
  }
  return options
}

try {
  const options = parseArgs(process.argv.slice(2))
  const order = JSON.parse(readFileSync(options.orderPath, 'utf8'))
  const quote = buildQuote(order, loadCatalog(options.catalogPath))
  process.stdout.write(options.json ? JSON.stringify(quote, null, 2) + '\n' : renderQuote(quote))
} catch (problem) {
  process.stderr.write(`error: ${problem.message}\n`)
  process.exitCode = 1
}
