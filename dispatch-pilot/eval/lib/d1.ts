// d1-ultra, Liquid AI's decision model, as the eval's `--backend d1` asks it (DEVELOPMENT.md 「d1-ultra 核验」, 2026-10-16): the
// mod's own backend (hooks/decision/liquid.ts), named `d1` as those runs were. Such a run reads Jev's row of the defaults (its
// questions, thresholds and budgets), so its requests are the ones Jev is asked; it is not the mod's d1-ultra (ADR 0017), whose
// answers are read by Liquid's guide and whose agents are routed by one Choice. That one has no eval: the person's choice.
//
// Pure: the network is handed in.

import type { Backend } from '../../hooks/decision/backend.ts'
import { liquidBackend, LIQUID_MODEL, LIQUID_URL } from '../../hooks/decision/liquid.ts'

export const D1_URL = LIQUID_URL
export const D1_MODEL = LIQUID_MODEL
/** Input price per million tokens; output is free (liquid.ai/pricing, 2026-10-15). */
export const D1_PRICE = 0.042

export function d1Backend(apiKey: string, options: { url?: string; model?: string } = {}): Backend {
  return liquidBackend(apiKey, { ...options, name: 'd1' })
}
