// A stuck loop's re-decision against the real Jev or Clef, outside Claude Code:
// the same request the mod sends when a loop's tool calls keep failing (the
// mid-turn effort question with the trouble flag, and whether the failures
// were expected), built by the shared decision module and sent from Node. For a
// manual check, and as the starting point of an eval of the question (#14).
//
//   TYPESAFE_API_KEY=... node dispatch-pilot/scripts/decide-stuck.ts <input.json> [--zh] [--steps 4] [--timeout 5000]
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_AUTH_TOKEN=... node dispatch-pilot/scripts/decide-stuck.ts <input.json> --clef
//
// `input.json` is a MidturnInput (decision/midturn.ts): the effort-midturn
// dataset's `zh` or `en` object, with the `trouble` sentence the mod writes
// (`2 tool calls have failed while working on this request`). `--zh` asks the
// questions in Chinese. Prints the probability that the failures are expected,
// the effort levels' probabilities and the latency. Credentials are read from
// the environment and never printed. Node 22.18+ runs .ts as is.

import { readFileSync } from 'node:fs'
import type { Backend, BackendIo } from '../hooks/decision/backend.ts'
import { clefBackend } from '../hooks/decision/clef.ts'
import { expectedFailurePart, readExpected } from '../hooks/decision/escalation.ts'
import { EFFORTS, pickEffort, readEffort } from '../hooks/decision/effort.ts'
import { jevBackend } from '../hooks/decision/jev.ts'
import { MIDTURN_LEVEL, midturnEffortPart, midturnState, type MidturnInput } from '../hooks/decision/midturn.ts'
import { answersFor, mergeParts } from '../hooks/decision/system-one.ts'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const value = (name: string) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const file = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--timeout' && args[i - 1] !== '--steps')
if (!file) {
  console.error('usage: node scripts/decide-stuck.ts <input.json> [--zh] [--clef] [--steps 4] [--timeout ms]')
  process.exit(2)
}
let backend: Backend
if (flag('--clef')) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? ''
  const apiToken = process.env.CLOUDFLARE_AUTH_TOKEN ?? ''
  if (!accountId || !apiToken) {
    console.error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AUTH_TOKEN must both be set')
    process.exit(2)
  }
  backend = clefBackend({ accountId, apiToken })
} else {
  const apiKey = process.env.TYPESAFE_API_KEY ?? ''
  if (!apiKey) {
    console.error('TYPESAFE_API_KEY is not set')
    process.exit(2)
  }
  backend = jevBackend(apiKey)
}

// Node's fetch and timers in place of $.http.fetch and $.clock.sleep.
const io: BackendIo = {
  fetch: async (url, init) => {
    const response = await fetch(url, { method: init.method, headers: init.headers, body: init.body })
    return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers), text: await response.text() }
  },
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      })
    }),
}

const input = JSON.parse(readFileSync(file, 'utf8')) as MidturnInput
const ask = { language: flag('--zh') ? ('zh' as const) : ('en' as const), primitive: 'score' as const }
const effortPart = midturnEffortPart(ask, { trouble: true })
const expectedPart = expectedFailurePart(ask)
const request = mergeParts(midturnState(input, { steps: Number(value('--steps') ?? 4), tokens: 2000 }), [effortPart, expectedPart])
console.log(JSON.stringify({ questions: Object.keys(request.questions), state: request.state }))

const started = performance.now()
const asked = await backend.ask(io, request, Number(value('--timeout') ?? 5000))
const ms = Math.round(performance.now() - started)
if (!asked.ok) {
  console.log(JSON.stringify({ ok: false, backend: backend.name, failure: asked.failure, ms }))
  process.exit(1)
}
const reading = readEffort(answersFor(effortPart, asked.answers)[MIDTURN_LEVEL])
const expected = readExpected(answersFor(expectedPart, asked.answers))
console.log(
  JSON.stringify({
    ok: true,
    backend: backend.name,
    model: asked.model,
    inputTokens: asked.inputTokens,
    ms,
    expected: expected === null ? null : Number(expected.toFixed(3)),
    probabilities: reading === null ? null : Object.fromEntries(EFFORTS.map((level, i) => [level, Number((reading.probabilities[i] ?? 0).toFixed(3))])),
    confidence: reading?.confidence ?? null,
    effort: reading === null ? null : pickEffort(reading, 0.5),
  }),
)
