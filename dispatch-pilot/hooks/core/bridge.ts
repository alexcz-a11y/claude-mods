// The bridge (ADR 0028): the hooks of the events Claude Code's Code Mode refuses a mod for (`tool.call`, `agent.spawn`,
// `classic.PreToolUse`; 2.1.325 does not start Code Mode beside a mod that hooks them) are not registered by this
// plugin. A feature writes such a hook as the body of a hook on this plugin's own noun (`$.dispatchPilot.start`, added
// to `$` by the entry's `engine.create`), under the hook's name:
//
//   on('dispatchPilot.start', { name: 'agents.spawn' }, async ($, started) => ({ value: await bridgeStart<HookGiven<typeof on<'agent.spawn', { tool_use_id: RegExp }>>>(started, async (e, next) => {
//     ... the hook's body, as it was under on('agent.spawn', { tool_use_id: /(?:)/ }, async ($, e, next) => { ... })
//   }) }))
//
// The second plugin, dispatch-pilot-extras, registers a few lines on the event itself that call the noun with that
// name. So everything a hook reads and writes (the plan table, the board, the decision model and its keys) stays in
// this plugin, and with the second plugin loaded every hook runs as it did when this one registered it. Without it (a
// Code Mode session) none of them runs, and the features that have another way to their facts take it.
//
// A hook calls `next` in the middle; functions do not cross from one plugin to another, so the hook runs here in two
// halves. `bridgeStart` runs it up to its `next(input)` and answers `{ kind: 'next', input }`; the other plugin calls
// the engine's `next` with that input and hands what came back to `bridgeResume`, which lets the hook go on and
// answers with what it returned (`done`), or with its next `next`. A hook that never calls `next` is `done` at once.
//
// The body sits inside the noun's hook because that is where `$` is: `plugin validate` follows `$` only into a
// function declared at the top of a file, so the hooks are neither kept in a table nor handed `$` from here.
//
// The hooks in flight are kept in the module: a hot reload while one waits for its `next` loses it, and the other
// plugin then returns what the engine's `next` gave it, as if the hook had passed the event on.

import { errorText } from '../decision/backend.ts'

/** What one half of a bridged hook comes to. `pass`: no hook of that name here (an older or newer plugin beside this one). */
export type BridgeStep = { kind: 'next'; input: unknown } | { kind: 'done'; result: unknown } | { kind: 'error'; message: string } | { kind: 'pass' }

/** The start of a bridged hook: its name, an id the caller mints for this run of it, the event's input, and who raised it (`next.origin`). */
export type BridgeCall = { name: string; id: string; e: unknown; origin?: { plugin?: string } }

/** What the engine's `next` came to, for the hook waiting on it. */
export type BridgeAnswer = { id: string; result?: unknown; error?: string }

/** The hook `on` would take for these type arguments: `HookGiven<typeof on<'tool.call', { tool: 'Read' }>>`, so a bridged hook's body has its event's `e` and `next`. */
export type HookGiven<F> = F extends (...args: infer A) => unknown ? (A extends [...unknown[], infer H] ? H : never) : never

type AnyHook = (...args: never[]) => unknown

type Waiting = { settle: (step: BridgeStep) => void; next?: { resolve: (result: unknown) => void; reject: (error: unknown) => void } }

/** The hooks running now, by the caller's id. */
const waiting = new Map<string, Waiting>()

/** Runs a bridged hook's body (`run`, typed as the hook `H` is, less its `$`) for `call`, up to its first `next` or to its end. */
export function bridgeStart<H extends AnyHook>(call: BridgeCall, run: (e: Parameters<H>[1], next: Parameters<H>[2]) => ReturnType<H>): Promise<BridgeStep> {
  return new Promise<BridgeStep>((first) => {
    const state: Waiting = { settle: first }
    waiting.set(call.id, state)
    const next = Object.assign(
      (input: unknown) =>
        new Promise((resolve, reject) => {
          next.called = true
          state.next = { resolve, reject }
          state.settle({ kind: 'next', input })
        }),
      { origin: { plugin: 'engine', ...call.origin }, called: false },
    )
    Promise.resolve()
      .then(() => run(call.e as never, next as never))
      .then(
        (result) => {
          waiting.delete(call.id)
          state.settle({ kind: 'done', result })
        },
        (error: unknown) => {
          waiting.delete(call.id)
          state.settle({ kind: 'error', message: errorText(error) })
        },
      )
  })
}

/** Hands the hook waiting under `answer.id` what the engine's `next` came to, and runs it to its next `next` or its end. */
export function bridgeResume(answer: BridgeAnswer): Promise<BridgeStep> {
  const state = waiting.get(answer.id)
  const pending = state?.next
  if (state === undefined || pending === undefined) return Promise.resolve({ kind: 'pass' })
  return new Promise<BridgeStep>((then) => {
    state.next = undefined
    state.settle = then
    if (answer.error !== undefined) pending.reject(new Error(answer.error))
    else pending.resolve(answer.result)
  })
}

/** Whether dispatch-pilot-extras is loaded, as this load of the module found it; undefined before it asked. */
let extras: boolean | undefined

/**
 * Whether dispatch-pilot-extras is loaded beside this plugin: it adds a noun of its own to `$`, and a call on a noun
 * nobody added throws. `present` is that call, made where `$` is (`() => $.dispatchPilotExtras.present()`). Asked once
 * a load: both plugins hook `engine.create`, so a plugin switched on or off reloads every module (and this one's answer
 * with it). With it, the bridged hooks run; without it (a Code Mode session) the features read tool calls and starting
 * agents another way.
 */
export async function hasExtras(present: () => Promise<boolean>): Promise<boolean> {
  if (extras === undefined) {
    try {
      extras = (await present()) === true
    } catch {
      extras = false
    }
  }
  return extras
}
