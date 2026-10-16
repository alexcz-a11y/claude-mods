// Two runs over the same items compared item by item (eval/paired.ts): how many each got right, how many only one got
// right, and the exact McNemar test of those (the two-sided binomial test of the pairs only one run got right). An
// item one run has no answer for counts wrong there. And a scan of the effort rules' thresholds over stored answers.
//
// Pure: no Node API.

/** Each item's grade in one run, by `<id> <language>` (ctx30: by id). */
export type Outcomes = ReadonlyMap<string, boolean>

export type Paired = { n: number; rightA: number; rightB: number; onlyA: number; onlyB: number; p: number }

/** The paired figures of two runs over every item either has. */
export function paired(a: Outcomes, b: Outcomes): Paired {
  const keys = new Set([...a.keys(), ...b.keys()])
  let rightA = 0
  let rightB = 0
  let onlyA = 0
  let onlyB = 0
  for (const key of keys) {
    const inA = a.get(key) === true
    const inB = b.get(key) === true
    if (inA) rightA++
    if (inB) rightB++
    if (inA && !inB) onlyA++
    if (inB && !inA) onlyB++
  }
  return { n: keys.size, rightA, rightB, onlyA, onlyB, p: mcnemar(onlyA, onlyB) }
}

export type Rules = { thetaMax: number; roundUp: number }

/** The grid the scan goes over: thetaMax 0.3-0.8 and roundUp 0.15-0.6, by 0.05. */
export function rulesGrid(): Rules[] {
  const steps = (from: number, to: number) => Array.from({ length: Math.round((to - from) / 0.05) + 1 }, (_, i) => Math.round((from + i * 0.05) * 100) / 100)
  return steps(0.3, 0.8).flatMap((thetaMax) => steps(0.15, 0.6).map((roundUp) => ({ thetaMax, roundUp })))
}

/** Every rule of the grid with its accuracy (`accuracy(rules)`: say, the mean over the runs scanned), best first; a tie goes to the rule nearer `prefer`. */
export function scanRules(accuracy: (rules: Rules) => number, prefer: Rules): { rules: Rules; accuracy: number }[] {
  const distance = (rules: Rules) => Math.abs(rules.thetaMax - prefer.thetaMax) + Math.abs(rules.roundUp - prefer.roundUp)
  return rulesGrid()
    .map((rules) => ({ rules, accuracy: accuracy(rules) }))
    .sort((x, y) => y.accuracy - x.accuracy || distance(x.rules) - distance(y.rules))
}

/** The exact two-sided binomial test of the pairs only one run got right (McNemar's, exact). */
export function mcnemar(onlyA: number, onlyB: number): number {
  const n = onlyA + onlyB
  if (n === 0) return 1
  const k = Math.min(onlyA, onlyB)
  let tail = 0
  for (let i = 0; i <= k; i++) tail += choose(n, i)
  return Math.min(1, (2 * tail) / 2 ** n)
}

function choose(n: number, k: number): number {
  let out = 1
  for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i
  return out
}
