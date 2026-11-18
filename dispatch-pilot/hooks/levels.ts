// Effort levels and model tiers, both in ascending order.
export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Level = (typeof LEVELS)[number]

export const TIERS = ['haiku', 'sonnet', 'opus', 'fable'] as const
export type Tier = (typeof TIERS)[number]

export function isLevel(v: unknown): v is Level {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v)
}

// The family is named in the id (`claude-fable-5-2`, `us.anthropic.claude-opus-4-1-v1:0`, `opus[1m]`).
// Match whole words, so a longer word that merely contains a family name does not count.
export function tierOfModelId(id: string): Tier | null {
  const words = id.toLowerCase().split(/[^a-z0-9]+/)
  return TIERS.find((tier) => words.includes(tier)) ?? null
}
