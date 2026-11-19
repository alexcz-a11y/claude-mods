import { column, money } from './format.mjs'

export function renderQuote(quote) {
  const out = []
  out.push(`Quote ${quote.id} for ${quote.customer}`)
  out.push(
    [column('#', 2, 'right'), column('SKU', 7), column('Qty', 5, 'right'), column('Unit', 8, 'right'),
      column('Amount', 10, 'right'), 'Ship to'].join('  '),
  )
  for (const line of quote.lines) {
    out.push(
      [column(line.number, 2, 'right'), column(line.sku, 7), column(line.qty, 5, 'right'),
        column(money(line.unitCents), 8, 'right'), column(money(line.lineCents), 10, 'right'), line.shipTo]
        .join('  ').trimEnd(),
    )
  }
  out.push(`${column('Total', 30)}${column(money(quote.totalCents), 10, 'right')}`)
  return out.join('\n') + '\n'
}
