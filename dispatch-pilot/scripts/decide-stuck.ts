// A stuck loop's re-decision against the real Jev, outside Claude Code:
// the request the mod sends when a loop's tool calls keep failing
// (`stuckRequest`: the mid-turn effort question with the trouble flag, and
// whether the failures were expected), with the mod's settings as the
// manifest's defaults and Jev's give them (core/setup.ts BACKEND_DEFAULTS),
// sent from Node. Always Jev: the script has no choice of decision model
// (eval/node.ts scriptDecision fixes `decisionModel` to jev). For a manual check.
//
//   TYPESAFE_API_KEY=... node dispatch-pilot/scripts/decide-stuck.ts <input.json> [--zh] [--steps 4] [--timeout 5000]
//
// `input.json` is a MidturnInput (decision/midturn.ts) with the `trouble`
// sentence the mod writes (`troubleText`: `2 tool calls have failed while
// working on this request`), each tool's line as the mod writes it. `--zh`
// asks the questions in Chinese; `--steps` overrides rejudgeSteps. Prints the
// probability that the failures are expected, the effort levels'
// probabilities and the latency. `--timeout` defaults to what the eval gives
// one attempt (four times the mod's timeoutMs, at least 10 s).
// Credentials come from the environment or ~/.config/dispatch-pilot/eval.env
// and are never printed. Node 22.18+ runs .ts as is.

import { readFileSync } from 'node:fs'
import { readExpected, stuckRequest } from '../hooks/decision/escalation.ts'
import { EFFORTS, pickEffort, readEffort } from '../hooks/decision/effort.ts'
import { MIDTURN_LEVEL, type MidturnInput } from '../hooks/decision/midturn.ts'
import { answersFor, type Part } from '../hooks/decision/system-one.ts'
import { attemptMs } from '../eval/lib/runner.ts'
import { nodeIo, scriptArgs, scriptDecision } from '../eval/node.ts'

const USAGE = 'node scripts/decide-stuck.ts <input.json> [--zh] [--steps 4] [--timeout ms]'
const { values, positionals } = scriptArgs(USAGE, { zh: { type: 'boolean' }, steps: { type: 'string' } })
const file = positionals[0]
if (!file) {
  console.error(`usage: ${USAGE}`)
  process.exit(2)
}
const { settings, backend } = scriptDecision(typeof values.steps === 'string' ? [`rejudgeSteps=${values.steps}`] : [])

const input = JSON.parse(readFileSync(file, 'utf8')) as MidturnInput
const { request, effortPart, expectedPart } = stuckRequest(input, {
  limits: settings.midturn.limits,
  ask: { language: values.zh === true ? 'zh' : settings.ask.other.language, primitive: settings.ask.other.primitive },
  effort: true,
})
console.log(JSON.stringify({ questions: Object.keys(request.questions), state: request.state }))

const started = performance.now()
const asked = await backend.ask(nodeIo, request, Number(values.timeout ?? attemptMs(settings.timeoutMs)))
const ms = Math.round(performance.now() - started)
if (!asked.ok) {
  console.log(JSON.stringify({ ok: false, backend: backend.name, failure: asked.failure, ms }))
  process.exit(1)
}
const reading = readEffort(answersFor(effortPart as Part, asked.answers)[MIDTURN_LEVEL])
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
    effort: reading === null ? null : pickEffort(reading, settings),
  }),
)
