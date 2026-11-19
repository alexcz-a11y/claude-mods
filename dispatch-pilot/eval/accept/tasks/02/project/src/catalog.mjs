import { readFileSync } from 'node:fs'

import { requireInteger, requireText } from './lib/assert.mjs'
import { memo } from './lib/memo.mjs'

function checkProduct(sku, product) {
  requireText(product.name, `name of ${sku}`)
  if (!Array.isArray(product.tiers) || product.tiers.length === 0) {
    throw new Error(`${sku} has no price tiers`)
  }
  let previous = 0
  for (const tier of product.tiers) {
    requireInteger(tier.minQty, `minQty of ${sku}`)
    requireInteger(tier.unitCents, `unitCents of ${sku}`)
    if (tier.minQty <= previous) throw new Error(`tiers of ${sku} are not in ascending order`)
    previous = tier.minQty
  }
}

// One read per catalog file, however many quotes are built from it.
export const loadCatalog = memo((path) => {
  const catalog = JSON.parse(readFileSync(path, 'utf8'))
  for (const [sku, product] of Object.entries(catalog)) checkProduct(sku, product)
  return catalog
})
