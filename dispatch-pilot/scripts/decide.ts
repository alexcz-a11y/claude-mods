// One message's effort decision against the real Jev, outside Claude Code:
// the same request the mod sends (the shared decision module), sent from
// Node. For a manual check and as the starting point of the eval (#4).
//
//   TYPESAFE_API_KEY=... node dispatch-pilot/scripts/decide.ts '把登录模块重构成三层' [--zh] [--choice] [--timeout 5000]
//
// Prints the request (questions, state) and the answer: each level's
// probability, the confidence, the picked level, the latency. The key is
// read from the environment and never printed. Node 22.18+ runs .ts as is.

import type { BackendIo } from '../hooks/decision/backend.ts'
import { turnStartState } from '../hooks/decision/context.ts'
import { EFFORTS, LEVEL, pickEffort, readEffort, turnStartEffortPart } from '../hooks/decision/effort.ts'
import { jevBackend } from '../hooks/decision/jev.ts'
import { answersFor, mergeParts } from '../hooks/decision/system-one.ts'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const value = (name: string) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const prompt = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--timeout')
if (!prompt) {
  console.error('usage: node scripts/decide.ts <message> [--zh] [--choice] [--timeout ms]')
  process.exit(2)
}
const apiKey = process.env.TYPESAFE_API_KEY ?? ''
if (!apiKey) {
  console.error('TYPESAFE_API_KEY is not set')
  process.exit(2)
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

const part = turnStartEffortPart({ language: flag('--zh') ? 'zh' : 'en', primitive: flag('--choice') ? 'choice' : 'score' })
const request = mergeParts(turnStartState({ prompt, messages: [], limits: { messages: 0, tokens: 2000 } }), [part])
console.log(JSON.stringify({ questions: Object.keys(request.questions), state: request.state }))

const started = performance.now()
const asked = await jevBackend(apiKey).ask(io, request, Number(value('--timeout') ?? 5000))
const ms = Math.round(performance.now() - started)
if (!asked.ok) {
  console.log(JSON.stringify({ ok: false, failure: asked.failure, ms }))
  process.exit(1)
}
const reading = readEffort(answersFor(part, asked.answers)[LEVEL])
if (reading === null) {
  console.log(JSON.stringify({ ok: false, failure: 'no effort answer', answers: asked.answers, ms }))
  process.exit(1)
}
console.log(
  JSON.stringify({
    ok: true,
    model: asked.model,
    inputTokens: asked.inputTokens,
    ms,
    probabilities: Object.fromEntries(EFFORTS.map((level, i) => [level, Number((reading.probabilities[i] ?? 0).toFixed(3))])),
    confidence: reading.confidence,
    effort: pickEffort(reading, 0.5),
  }),
)
