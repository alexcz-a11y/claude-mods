import { requireInteger, requireText } from './lib/assert.mjs'
import { createPricer } from './pricing.mjs'

export function buildQuote(order, catalog) {
  requireText(order.id, 'order id')
  if (!Array.isArray(order.lines) || order.lines.length === 0) {
    throw new Error(`order ${order.id} has no lines`)
  }
  const pricer = createPricer(catalog)

  const lines = order.lines.map((line, index) => {
    const sku = requireText(line.sku, `sku of line ${index + 1}`)
    const qty = requireInteger(line.qty, `qty of line ${index + 1}`)
    const unitCents = pricer.unitCents(sku, qty)
    return {
      number: index + 1,
      sku,
      name: pricer.nameOf(sku),
      qty,
      unitCents,
      lineCents: unitCents * qty,
      shipTo: line.shipTo ?? '',
    }
  })

  return {
    id: order.id,
    customer: order.customer ?? '',
    lines,
    totalCents: lines.reduce((sum, line) => sum + line.lineCents, 0),
  }
}
