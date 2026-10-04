// One dispatched agent's decision against the real Jev, outside Claude Code:
// the same request the mod sends at agent.spawn (the shared decision module),
// built from an item of the eval set (subagent.jsonl) or from a JSON object
// with the same fields. For a manual check and as the starting point of the
// eval (#15).
//
//   TYPESAFE_API_KEY=... node dispatch-pilot/scripts/decide-agent.ts --file subagent.jsonl --id subagent-011 [--lang en]
//   TYPESAFE_API_KEY=... node dispatch-pilot/scripts/decide-agent.ts '{"user_message":"...","agent_type":"Explore","description":"...","prompt":"...","requested_model":null}'
//
// Variants (eval variables): --zh (questions in Chinese), --work (options
// named by the kind of work), --noul (the main agent's pick asked about on its
// own), --choice (effort as a Choice), --fable (fable among the options).
// Prints the request (question ids, state), the answers that matter, the
// decision and, for an eval item, its gold. The key is read from the
// environment and never printed. Node 22.18+ runs .ts as is.

import { readFileSync } from 'node:fs'
import type { BackendIo } from '../hooks/decision/backend.ts'
import { AGENT_MODELS, DEFAULT_AGENT_MODELS, decideDispatch, dispatchPart, dispatchState, type Dispatch } from '../hooks/decision/dispatched-agent.ts'
import { jevBackend } from '../hooks/decision/jev.ts'
import { answersFor, mergeParts } from '../hooks/decision/system-one.ts'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const value = (name: string) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

let dispatch: Dispatch
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
  dispatch = item[value('--lang') ?? 'zh'] as Dispatch
  gold = { gold: item.gold, accept: item.accept }
} else {
  const json = args.find((arg) => arg.startsWith('{'))
  if (!json) {
    console.error('usage: node scripts/decide-agent.ts (--file <jsonl> --id <id> [--lang en] | <item JSON>) [--zh] [--work] [--noul] [--choice] [--fable] [--timeout ms]')
    process.exit(2)
  }
  dispatch = JSON.parse(json) as Dispatch
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

// The mod's settings: its defaults (agentOverride 0.6, thetaMax 0.5, the context budget 2000).
const settings = {
  models: flag('--fable') ? AGENT_MODELS : DEFAULT_AGENT_MODELS,
  ask: {
    language: flag('--zh') ? ('zh' as const) : ('en' as const),
    primitive: flag('--choice') ? ('choice' as const) : ('score' as const),
    options: flag('--work') ? ('work' as const) : ('models' as const),
    requested: flag('--noul') ? ('noul' as const) : ('hint' as const),
  },
  thetaOverride: 0.6,
  thetaMax: 0.5,
}
const part = dispatchPart(dispatch, settings)
const request = mergeParts(dispatchState(dispatch, 2000), [part])
console.log(JSON.stringify({ questions: Object.keys(request.questions), state: request.state }))

const started = performance.now()
const asked = await jevBackend(apiKey).ask(io, request, Number(value('--timeout') ?? 5000))
const ms = Math.round(performance.now() - started)
if (!asked.ok) {
  console.log(JSON.stringify({ ok: false, failure: asked.failure, ms }))
  process.exit(1)
}
const answers = answersFor(part, asked.answers)
const decision = decideDispatch(answers, dispatch, settings)
const brief = Object.fromEntries(
  Object.entries(answers).map(([id, answer]) => [id, answer.type === 'noul' ? Number(answer.noul.toFixed(3)) : answer.probabilities]),
)
console.log(JSON.stringify({ ok: true, model: asked.model, inputTokens: asked.inputTokens, ms, answers: brief, decision, ...(gold === undefined ? {} : gold) }))
