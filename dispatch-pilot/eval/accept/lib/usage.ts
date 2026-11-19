// What one acceptance run cost, read from its session record (calibration plan, Task 15 Step 2). Pure: run.ts reads the
// record file (JSON lines, parsed) and imports this; the tests import it too, so no node: module here.
type Obj = Record<string, any>

export type Usage = { steps: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; turnMs: number }

const SYNTHETIC = '<synthetic>'

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A record of the main loop: not a subagent's (sidechain, or one that names its agent). */
export function isMain(r: Obj): boolean {
  return r.isSidechain !== true && typeof r.agentId !== 'string'
}

/**
 * A record of a model request the main loop made. A call inside a Code Mode script is recorded as an assistant record
 * too (isVirtual, a synthetic model, zero usage), but it is no request.
 */
export function isMainResponse(r: Obj): boolean {
  return r.type === 'assistant' && isMain(r) && r.isVirtual !== true && isObj(r.message) && r.message.model !== SYNTHETIC
}

/** The record that starts a main-loop turn (a compaction summary carries a position too, but starts nothing). */
export function isTurnStart(r: Obj): boolean {
  return r.type === 'user' && isMain(r) && isObj(r.turnPosition) && r.isCompactSummary !== true
}

export function isTurnDuration(r: Obj): boolean {
  return r.type === 'system' && r.subtype === 'turn_duration' && isMain(r)
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const timeOf = (r: Obj): number | null => {
  const t = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN
  return Number.isNaN(t) ? null : t
}

/**
 * The main loop's requests and tokens, and how long its turn took. The engine writes one record per content block of a
 * response, each with the response's whole usage, so a response counts once (by its message id). inputTokens is the
 * input not read from the cache: input_tokens plus cache_creation_input_tokens. turnMs is the engine's own
 * turn_duration when it wrote one, else from the turn's first record to the last response.
 */
export function usageOf(records: readonly unknown[]): Usage {
  const out: Usage = { steps: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, turnMs: 0 }
  const seen = new Set<string>()
  let durations = 0
  let sawDuration = false
  let first: number | null = null
  let last: number | null = null
  records.forEach((r, i) => {
    if (!isObj(r)) return
    if (isTurnStart(r) && first === null) first = timeOf(r)
    if (isTurnDuration(r)) {
      sawDuration = true
      durations += count(r.durationMs)
      return
    }
    if (!isMainResponse(r)) return
    last = timeOf(r) ?? last
    const id = typeof r.message.id === 'string' ? r.message.id : `#${i}`
    if (seen.has(id)) return
    seen.add(id)
    const u = isObj(r.message.usage) ? r.message.usage : {}
    out.steps += 1
    out.inputTokens += count(u.input_tokens) + count(u.cache_creation_input_tokens)
    out.outputTokens += count(u.output_tokens)
    out.cacheReadTokens += count(u.cache_read_input_tokens)
  })
  if (sawDuration) out.turnMs = durations
  else if (first !== null && last !== null) out.turnMs = Math.max(0, (last as number) - first)
  return out
}
