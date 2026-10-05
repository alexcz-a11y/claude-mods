// One message's effort decision against the real Jev or Clef, outside Claude
// Code: the request the mod sends when the person sends that message with no
// conversation before it (the shared decision module), with the mod's settings
// as the manifest's defaults and the chosen decision model's give them
// (core/setup.ts BACKEND_DEFAULTS), sent from Node. For a manual check.
//
//   TYPESAFE_API_KEY=... node dispatch-pilot/scripts/decide.ts '把登录模块重构成三层' [--zh | --en] [--choice] [--timeout 5000]
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_AUTH_TOKEN=... node dispatch-pilot/scripts/decide.ts '把登录模块重构成三层' --clef
//
// Jev unless `--clef`. The question is written as the mod writes it for the
// decision model asked (Chinese with Jev, English with Clef: turnStartLanguage);
// `--zh` or `--en` writes it in that language, `--choice` asks a Choice, as the
// eval's variants do. Prints the request (questions, state) and the answer:
// each level's probability, the confidence, the level the mod picks (the mod's
// thetaMax), the latency. `--timeout` defaults to what the eval gives one
// attempt: four times the mod's timeoutMs, at least 10 s (eval/lib/runner.ts
// attemptMs), so a cold connection's first request does not fail outright.
// Credentials come from the environment or ~/.config/dispatch-pilot/eval.env
// (as the eval reads them) and are never printed. Node 22.18+ runs .ts as is.

import { turnStartState } from '../hooks/decision/context.ts'
import { EFFORTS, LEVEL, pickEffort, readEffort, turnStartEffortPart } from '../hooks/decision/effort.ts'
import { answersFor, mergeParts } from '../hooks/decision/system-one.ts'
import { attemptMs } from '../eval/lib/runner.ts'
import { nodeIo, scriptArgs, scriptDecision } from '../eval/node.ts'

const USAGE = 'node scripts/decide.ts <message> [--zh | --en] [--choice] [--clef] [--timeout ms]'
const { values, positionals } = scriptArgs(USAGE, { zh: { type: 'boolean' }, en: { type: 'boolean' }, choice: { type: 'boolean' } })
const prompt = positionals[0]
if (!prompt) {
  console.error(`usage: ${USAGE}`)
  process.exit(2)
}
const { settings, backend } = scriptDecision(values.clef === true)

const language = values.zh === true ? 'zh' : values.en === true ? 'en' : settings.turnStartLanguage
const part = turnStartEffortPart({ language, primitive: values.choice === true ? 'choice' : 'score' })
const request = mergeParts(turnStartState({ prompt, messages: [], limits: settings.context }), [part])
console.log(JSON.stringify({ questions: Object.keys(request.questions), language, state: request.state }))

const started = performance.now()
const asked = await backend.ask(nodeIo, request, Number(values.timeout ?? attemptMs(settings.timeoutMs)))
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
