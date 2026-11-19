import { memo } from './lib/memo.mjs'
import { tierFor } from './tiers.mjs'

// A pricer answers "what does one unit cost on this line". Large orders repeat the same lookups
// many times, so answers are kept for the length of one quote.
export function createPricer(catalog) {
  const unitCents = memo((sku, qty) => {
    const product = catalog[sku]
    if (!product) throw new Error(`unknown SKU ${sku}`)
    return tierFor(product.tiers, qty).unitCents
  })

  const nameOf = memo((sku) => catalog[sku]?.name ?? sku)

  return { unitCents, nameOf }
}
