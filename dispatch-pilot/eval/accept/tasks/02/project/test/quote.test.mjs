import assert from 'node:assert/strict'
import { test } from 'node:test'

import { money } from '../src/format.mjs'
import { memo } from '../src/lib/memo.mjs'
import { buildQuote } from '../src/quote.mjs'
import { renderQuote } from '../src/render.mjs'

const CATALOG = {
  'X-1': { name: 'Thing one', tiers: [{ minQty: 1, unitCents: 250 }] },
  'X-2': { name: 'Thing two', tiers: [{ minQty: 1, unitCents: 1099 }] },
}

test('a quote adds up its lines', () => {
  const quote = buildQuote(
    { id: 'T-1', customer: 'Test', lines: [{ sku: 'X-1', qty: 4 }, { sku: 'X-2', qty: 2 }] },
    CATALOG,
  )
  assert.deepEqual(quote.lines.map((line) => line.lineCents), [1000, 2198])
  assert.equal(quote.totalCents, 3198)
})

test('an unknown SKU is an error', () => {
  assert.throws(() => buildQuote({ id: 'T-2', lines: [{ sku: 'NOPE', qty: 1 }] }, CATALOG), /unknown SKU NOPE/)
})

test('a quantity has to be a whole number above zero', () => {
  assert.throws(() => buildQuote({ id: 'T-3', lines: [{ sku: 'X-1', qty: 0 }] }, CATALOG), /qty of line 1/)
})

test('money prints two decimals', () => {
  assert.equal(money(54500), '545.00')
  assert.equal(money(5), '0.05')
})

test('memo runs the function once per key', () => {
  let calls = 0
  const double = memo((n) => { calls += 1; return n * 2 })
  assert.equal(double(4), 8)
  assert.equal(double(4), 8)
  assert.equal(double(5), 10)
  assert.equal(calls, 2)
})

test('the printed quote ends with the total', () => {
  const quote = buildQuote({ id: 'T-4', customer: 'Test', lines: [{ sku: 'X-1', qty: 2, shipTo: 'Shop' }] }, CATALOG)
  const text = renderQuote(quote)
  assert.match(text, /^Quote T-4 for Test\n/)
  assert.match(text, /Total\s+5\.00\n$/)
})
