// Hidden checks for task 02. Runs the crateline command line on its own catalogs and orders.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2]

// [label, catalog file, lines as [sku, qty], expected unit price in cents per line]
const CASES = [
  ['the reported order ORD-1187', 'catalog-reported.json', [['P-100', 5], ['L-015', 2], ['P-100', 60]], [800, 1250, 720]],
  ['one line in a higher tier', 'catalog-reported.json', [['C-310', 120]], [82]],
  ['one line in the top tier', 'catalog-reported.json', [['C-310', 800], ['T-220', 6]], [74, 185]],
  ['same SKU, small then large', 'catalog-hidden.json', [['A-1', 2], ['C-3', 1], ['A-1', 150]], [1000, 1999, 750]],
  ['same SKU, large then small', 'catalog-hidden.json', [['A-1', 100], ['A-1', 9]], [750, 1000]],
  ['same SKU four times', 'catalog-hidden.json', [['B-2', 1], ['B-2', 24], ['B-2', 23], ['B-2', 240]], [250, 220, 250, 220]],
  ['quantities at the tier edges', 'catalog-hidden.json', [['A-1', 9], ['A-1', 10], ['A-1', 99], ['A-1', 100]], [1000, 900, 900, 750]],
  ['four tiers', 'catalog-hidden.json', [['D-4', 1], ['D-4', 2], ['D-4', 3], ['D-4', 999], ['D-4', 1000], ['D-4', 2]], [31, 29, 27, 27, 11, 29]],
  ['no tier reached twice', 'catalog-hidden.json', [['C-3', 4], ['B-2', 3], ['C-3', 400]], [1999, 250, 1999]],
]

const work = mkdtempSync(join(tmpdir(), 'accept02-'))
const failures = []

function quote(orderPath, catalogPath) {
  const done = spawnSync(process.execPath, ['bin/quote.mjs', orderPath, '--catalog', catalogPath, '--json'], {
    cwd: target, encoding: 'utf8', timeout: 30000,
  })
  return done
}

try {
  CASES.forEach(([label, catalogFile, lines, expected], index) => {
    const orderPath = join(work, `order-${index}.json`)
    writeFileSync(orderPath, JSON.stringify({
      id: `H-${index}`,
      customer: 'Hidden',
      lines: lines.map(([sku, qty]) => ({ sku, qty, shipTo: 'Somewhere' })),
    }))
    const done = quote(orderPath, join(here, catalogFile))
    if (done.error || done.status !== 0) {
      failures.push(`${label}: the command failed (${done.error?.message ?? 'exit ' + done.status}) ${(done.stderr ?? '').trim()}`)
      return
    }
    let result
    try {
      result = JSON.parse(done.stdout)
    } catch {
      failures.push(`${label}: --json did not print JSON`)
      return
    }
    const units = (result.lines ?? []).map((line) => line.unitCents)
    if (JSON.stringify(units) !== JSON.stringify(expected)) {
      failures.push(`${label}: unit prices ${JSON.stringify(units)}, expected ${JSON.stringify(expected)}`)
      return
    }
    const total = lines.reduce((sum, [, qty], i) => sum + qty * expected[i], 0)
    const amounts = result.lines.map((line) => line.lineCents)
    const wanted = lines.map(([, qty], i) => qty * expected[i])
    if (JSON.stringify(amounts) !== JSON.stringify(wanted) || result.totalCents !== total) {
      failures.push(`${label}: amounts ${JSON.stringify(amounts)} total ${result.totalCents}, expected ${JSON.stringify(wanted)} total ${total}`)
    }
  })

  // The printed quote of the reported order.
  const reported = join(work, 'reported.json')
  writeFileSync(reported, JSON.stringify({
    id: 'ORD-1187',
    customer: 'Halvorsen Freight',
    lines: [
      { sku: 'P-100', qty: 5, shipTo: 'Dock office' },
      { sku: 'L-015', qty: 2, shipTo: 'Dock office' },
      { sku: 'P-100', qty: 60, shipTo: 'Warehouse 2' },
    ],
  }))
  const printed = spawnSync(process.execPath, ['bin/quote.mjs', reported, '--catalog', join(here, 'catalog-reported.json')], {
    cwd: target, encoding: 'utf8', timeout: 30000,
  })
  const totalLine = (printed.stdout ?? '').split('\n').find((line) => /^Total\b/.test(line)) ?? ''
  if (printed.status !== 0 || !/\b497\.00\s*$/.test(totalLine)) {
    failures.push(`printed quote of ORD-1187: total line ${JSON.stringify(totalLine.trim())}, expected 497.00`)
  }

  // An unknown SKU is still refused.
  const unknown = join(work, 'unknown.json')
  writeFileSync(unknown, JSON.stringify({ id: 'H-x', customer: 'Hidden', lines: [{ sku: 'NOPE', qty: 1 }] }))
  const refused = quote(unknown, join(here, 'catalog-hidden.json'))
  if (refused.status === 0) failures.push('an order with an unknown SKU was quoted')
} finally {
  rmSync(work, { recursive: true, force: true })
}

for (const line of failures) console.log('FAIL ' + line)
const count = CASES.length + 2
console.log(failures.length ? `${count - failures.length} of ${count} checks passed` : 'all checks passed')
process.exit(failures.length ? 1 : 0)
