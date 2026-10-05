// One message's effort decision against the real Jev or Clef, outside Claude
// Code: the request the mod sends when the person sends that message with no
// conversation before it (the shared decision module), with the mod's settings
// as the manifest's defaults and the chosen decision model's give them
// (core/setup.ts BACKEND_DEFAULTS), sent from Node. For a manual check.
//
//   TYPESAFE_API_KEY=... node dispatch-pilot/scripts/decide.ts '把登录模块重构成三层' [--zh] [--choice] [--timeout 5000]
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_AUTH_TOKEN=... node dispatch-pilot/scripts/decide.ts '把登录模块重构成三层' --clef
//
// Jev unless `--clef`. `--zh` and `--choice` ask as the eval's variants do.
// Prints the request (questions, state) and the answer: each level's
// probability, the confidence, the level the mod picks (the mod's thetaMax),
// the latency. `--timeout` defaults to the mod's timeoutMs for the decision
// model asked (Jev's or Clef's).
// Credentials come from the environment or ~/.config/dispatch-pilot/eval.env
// (as the eval reads them) and are never printed. Node 22.18+ runs .ts as is.

import { turnStartState } from '../hooks/decision/context.ts'
import { EFFORTS, LEVEL, pickEffort, readEffort, turnStartEffortPart } from '../hooks/decision/effort.ts'
import { answersFor, mergeParts } from '../hooks/decision/system-one.ts'
import { optionsFor, settingsFrom } from '../eval/lib/suite.ts'
import { backendFor, nodeIo, readManifest } from '../eval/node.ts'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const value = (name: string) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const prompt = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--timeout')
if (!prompt) {
  console.error('usage: node scripts/decide.ts <message> [--zh] [--choice] [--clef] [--timeout ms]')
  process.exit(2)
}
const chosen = flag('--clef') ? 'clef' : 'jev'
const settings = settingsFrom(optionsFor(chosen, readManifest().userConfig ?? {}))
let backend
try {
  backend = backendFor(chosen).backend
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}

const part = turnStartEffortPart({ language: flag('--zh') ? 'zh' : 'en', primitive: flag('--choice') ? 'choice' : 'score' })
const request = mergeParts(turnStartState({ prompt, messages: [], limits: settings.context }), [part])
console.log(JSON.stringify({ questions: Object.keys(request.questions), state: request.state }))

const started = performance.now()
const asked = await backend.ask(nodeIo, request, Number(value('--timeout') ?? settings.timeoutMs))
const ms = Math.round(performance.now() - started)
if (!asked.ok) {
  console.log(JSON.stringify({ ok: false, backend: backend.name, failure: asked.failure, ms }))
  process.exit(1)
}
const reading = readEffort(answersFor(part, asked.answers)[LEVEL])
if (reading === null) {
  console.log(JSON.stringify({ ok: false, backend: backend.name, failure: 'no effort answer', answers: asked.answers, ms }))
  process.exit(1)
}
console.log(
  JSON.stringify({
    ok: true,
    backend: backend.name,
    model: asked.model,
    inputTokens: asked.inputTokens,
    ms,
    probabilities: Object.fromEntries(EFFORTS.map((level, i) => [level, Number((reading.probabilities[i] ?? 0).toFixed(3))])),
    confidence: reading.confidence,
    effort: pickEffort(reading, settings.thetaMax),
  }),
)
