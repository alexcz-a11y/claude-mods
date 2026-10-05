// One dispatched agent's decision against the real Jev or Clef, outside Claude
// Code: the request the mod sends at agent.spawn (the shared decision module),
// with the mod's settings as the manifest's defaults and the chosen decision
// model's give them (core/setup.ts BACKEND_DEFAULTS), built from an
// item of the eval set (subagent.jsonl) or from a JSON object with the same
// fields, and sent from Node. For a manual check.
//
//   TYPESAFE_API_KEY=... node dispatch-pilot/scripts/decide-agent.ts --file subagent.jsonl --id subagent-011 [--lang en]
//   TYPESAFE_API_KEY=... node dispatch-pilot/scripts/decide-agent.ts '{"user_message":"...","agent_type":"Explore","description":"...","prompt":"...","requested_model":null}'
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_AUTH_TOKEN=... node dispatch-pilot/scripts/decide-agent.ts --file subagent.jsonl --id subagent-011 --clef
//
// Jev unless `--clef`. Variants (eval variables): --zh (questions in
// Chinese), --work (options named by the kind of work), --noul (the main
// agent's pick asked about on its own), --choice (effort as a Choice), --fable
// (fable among the options, as agentFable does). The person's words are kept
// as the mod keeps them for the turn (masked, cut to contextTokens). Prints
// the request (question ids, state), the answers that matter, the decision
// and, for an eval item, its gold. `--timeout` defaults to the mod's
// timeoutMs for the decision model asked. Credentials come from the environment or
// ~/.config/dispatch-pilot/eval.env and are never printed. A Workflow item is
// asked about on its own here; the eval asks it with its script's other calls.

import { readFileSync } from 'node:fs'
import { dispatchSettings } from '../hooks/core/setup.ts'
import { messageText } from '../hooks/decision/context.ts'
import { decideDispatch, dispatchPart, dispatchState, type Dispatch } from '../hooks/decision/dispatched-agent.ts'
import { DEFAULT_ASK } from '../hooks/decision/effort.ts'
import { answersFor, mergeParts } from '../hooks/decision/system-one.ts'
import { optionsFor, settingsFrom } from '../eval/lib/suite.ts'
import { backendFor, nodeIo, readManifest } from '../eval/node.ts'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const value = (name: string) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

let written: Dispatch
let gold: unknown = undefined
const file = value('--file')
if (file !== undefined) {
  const id = value('--id')
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
  const item = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => entry.id === id)
  if (!item) {
    console.error(`no item ${id} in ${file}`)
    process.exit(2)
  }
  written = item[value('--lang') ?? 'zh'] as Dispatch
  gold = { gold: item.gold, accept: item.accept }
} else {
  const json = args.find((arg) => arg.startsWith('{'))
  if (!json) {
    console.error('usage: node scripts/decide-agent.ts (--file <jsonl> --id <id> [--lang en] | <item JSON>) [--zh] [--work] [--noul] [--choice] [--fable] [--clef] [--timeout ms]')
    process.exit(2)
  }
  written = JSON.parse(json) as Dispatch
}
// The manifest's defaults and the decision model's, as the engine and the mod give them; --fable turns agentFable on.
const chosen = flag('--clef') ? 'clef' : 'jev'
const settings = settingsFrom(optionsFor(chosen, readManifest().userConfig ?? {}, flag('--fable') ? ['agentFable=true'] : []))
let backend
try {
  backend = backendFor(chosen).backend
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}

const shape = dispatchSettings(
  { config: settings, ask: DEFAULT_ASK },
  {
    language: flag('--zh') ? 'zh' : 'en',
    primitive: flag('--choice') ? 'choice' : 'score',
    options: flag('--work') ? 'work' : 'models',
    requested: flag('--noul') ? 'noul' : 'hint',
  },
)
const dispatch: Dispatch = { ...written, user_message: messageText(written.user_message, settings.context.tokens) }
const part = dispatchPart(dispatch, shape)
const request = mergeParts(dispatchState(dispatch, settings.context.tokens), [part])
console.log(JSON.stringify({ questions: Object.keys(request.questions), state: request.state }))

const started = performance.now()
const asked = await backend.ask(nodeIo, request, Number(value('--timeout') ?? settings.timeoutMs))
const ms = Math.round(performance.now() - started)
if (!asked.ok) {
  console.log(JSON.stringify({ ok: false, backend: backend.name, failure: asked.failure, ms }))
  process.exit(1)
}
const answers = answersFor(part, asked.answers)
const decision = decideDispatch(answers, dispatch, shape)
const brief = Object.fromEntries(
  Object.entries(answers).map(([id, answer]) => [id, answer.type === 'noul' ? Number(answer.noul.toFixed(3)) : answer.probabilities]),
)
console.log(JSON.stringify({ ok: true, backend: backend.name, model: asked.model, inputTokens: asked.inputTokens, ms, answers: brief, decision, ...(gold === undefined ? {} : gold) }))
