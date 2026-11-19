// Tiers are listed from the smallest minQty up. The tier for a quantity is the one with the
// largest minQty that the quantity reaches.
export function tierFor(tiers, qty) {
  for (const tier of tiers) {
    if (qty >= tier.minQty) return tier
  }
  throw new Error(`no price tier for a quantity of ${qty}`)
}
