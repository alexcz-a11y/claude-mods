// The calibration's private data directory as the runner reads and writes it: every raw answer, one JSON line each,
// and what has been spent (calibration plan, Task 6). Imports node: modules: neither the tests nor hooks/ import it.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Answer } from '../../hooks/backend.ts'
import type { Spent } from './budget.ts'
import type { Stored } from './read.ts'

/** What came back: the answers, or why there are none (the service's request id kept, its error body never). */
export type Result = { ok: true; model: string; answers: Record<string, Answer> } | { ok: false; reason: string; status?: number; requestId?: string }
/** One line of answers.jsonl. hash: the request as built, without request_uid; request: what was sent. */
export type Line = {
  hash: string
  repeat: number
  caseId: string
  category: string
  variant: string
  at: string
  ms: number
  request: { state: unknown; questions: unknown }
  result: Result
}

/** The variant name the smoke request is stored under (amendment A4); no lookup ever reads it. */
export const SMOKE = 'smoke'
/** The HTTP status of a rate limit: such a reply is neither an answer nor a failure. */
export const RATE_LIMITED = 429

const ANSWERS = 'answers.jsonl'
const SPENT = 'spent.json'
const key = (hash: string, repeat: number): string => `${hash}:${repeat}`

export class Store {
  private readonly lines = new Map<string, Line[]>()
  readonly dir: string

  // Node runs this file with its types stripped, which takes no parameter property.
  constructor(dir: string) {
    this.dir = dir
    const path = join(dir, ANSWERS)
    if (!existsSync(path)) return
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((text: string, i: number) => {
        if (text.trim() === '') return
        let line: Line
        try {
          line = JSON.parse(text) as Line
        } catch {
          // The line itself stays out of the message: it holds a request.
          throw new Error(`${ANSWERS} line ${i + 1} is not JSON`)
        }
        this.index(line)
      })
  }

  private index(line: Line): void {
    // The smoke request repeats a tuning case's default request; it must not stand in for that case's answer.
    if (line.variant === SMOKE) return
    // A rate limit is neither an answer nor a failure (the runner stores none; a line of one is passed over).
    if (!line.result.ok && line.result.status === RATE_LIMITED) return
    const k = key(line.hash, line.repeat)
    this.lines.set(k, [...(this.lines.get(k) ?? []), line])
  }

  /** The nth answer to a request: the latest usable one, else the latest failure; undefined when never asked. */
  get(hash: string, repeat: number): Stored | undefined {
    const all = this.lines.get(key(hash, repeat)) ?? []
    const line = all.findLast((l) => l.result.ok) ?? all.at(-1)
    return line?.result
  }

  /** How many times the nth asking of a request was sent and failed. */
  failures(hash: string, repeat: number): number {
    return (this.lines.get(key(hash, repeat)) ?? []).filter((l) => !l.result.ok).length
  }

  /** The repeats of a request that have any line, in order. */
  repeats(hash: string): number[] {
    const out: number[] = []
    for (const [k, all] of this.lines) if (all.length > 0 && k.startsWith(hash + ':')) out.push(Number(k.slice(hash.length + 1)))
    return out.sort((a, b) => a - b)
  }

  add(line: Line): void {
    appendFileSync(join(this.dir, ANSWERS), JSON.stringify(line) + '\n', { mode: 0o600 })
    this.index(line)
  }

  spent(): Spent {
    const path = join(this.dir, SPENT)
    if (!existsSync(path)) return { requests: 0, tokens: 0 }
    const s = JSON.parse(readFileSync(path, 'utf8')) as Partial<Spent>
    if (typeof s.requests !== 'number' || typeof s.tokens !== 'number') throw new Error(`${SPENT} is not { requests, tokens }`)
    return { requests: s.requests, tokens: s.tokens }
  }

  setSpent(s: Spent): void {
    writeFileSync(join(this.dir, SPENT), JSON.stringify(s) + '\n', { mode: 0o600 })
  }
}
