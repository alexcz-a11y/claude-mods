// The engine beneath the mod in every engine test. Everything registered on the test's `on` sits below the
// mod: it answers the mod's $ calls ({ value } or { deny }) and ends the engine events the mod passes on.
//
// A test's `on` may register each event only once (a second one fails the whole test with "registered
// twice"), so world() owns every stub and takes behaviour through its options. Add an option here rather
// than a stub in a test. Every array it returns is what reached the engine, so a test can assert on what
// the mod actually did: assert a positive product in every test, never only that something did not change
// (a missing stub makes a mod call reject, the mod fails open, and "nothing changed" passes for nothing).
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type {
  AgentSpawnInput,
  ModelCompleteInput,
  On,
  PromptAttachmentInput,
  PromptOrigin,
  RenderSurface,
  SessionAppendInput,
  TurnCompleteInput,
  TurnCompleteReason,
  TurnStepInput,
  TurnStepResult,
} from 'claude-code'

/** userConfig with the Drex key set (fallback stays off, so only Drex is asked). */
export const KEYS = { drexApiKey: 'k-drex' }

export type WorldOptions = {
  /** Answers each $.http.fetch with a 200 body, or null for a network failure. Left out: HTTP 500. */
  answer?: (req: { url: string; body: any }) => string | null | Promise<string | null>
  /** What $.store holds when the test starts (JSON data, by key). */
  store?: Record<string, unknown>
  /** What $.agent.list() answers. */
  agents?: unknown[]
  /** The text $.model.complete answers with; null (or no option) refuses the call, so it rejects. */
  complete?: (e: any) => string | null
  /** What $.session.surfaces() answers; ['terminal'] when left out. */
  surfaces?: string[]
  /** $ calls to answer with { deny }, so the mod's call rejects: ui.status, store.get, store.set, command.register, session.surfaces. */
  refuse?: string[]
}

export type SentStep = { turnId: string; index: number; effort: unknown; model: string; agentId: string | undefined }

function parseBody(body: unknown): any {
  if (typeof body !== 'string') return body
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

export function world(on: On, o: WorldOptions = {}) {
  const fetched: { url: string; headers: Record<string, string>; body: any }[] = []
  const statuses: (string | undefined)[] = []
  const logs: string[] = []
  /** The lines of logs that went to the debug log alone ({ to: 'debug' }). */
  const debugLogs: string[] = []
  const stepsSent: SentStep[] = []
  const appended: SessionAppendInput[] = []
  const spawned: AgentSpawnInput[] = []
  const submitted: { text: string; context: readonly string[] | undefined; origin: PromptOrigin }[] = []
  const attachments: PromptAttachmentInput[] = []
  const completes: ModelCompleteInput[] = []
  const commands: { name: string; description: string }[] = []
  const storeWrites: { key: string; value: unknown }[] = []
  /** Every $.state.set the mod made, landed or not (isSet false: an ifVersion that missed). */
  const stateWrites: { key: string; id: string | undefined; value: unknown; isSet: boolean }[] = []

  // The mod races $.clock.sleep against its requests: without a mock clock every sleep rejects at once
  // and reads as a timeout.
  const clock = mock.clock(on)

  // Kept as JSON text, so a read hands back a copy, as $.store does.
  const store = new Map<string, string>(Object.entries(o.store ?? {}).map(([k, v]) => [k, JSON.stringify(v)]))
  let agentNo = 0
  const refused = (name: string): boolean => o.refuse?.includes(name) === true
  const REFUSED = { deny: 'refused by the test' } as const

  // The mod's $ calls.
  on('http.fetch', async (_$, e) => {
    const body = parseBody(e.init?.body)
    fetched.push({ url: e.url, headers: e.init?.headers ?? {}, body })
    if (!o.answer) return { value: { status: 500, ok: false, headers: {}, text: '' } }
    const text = await o.answer({ url: e.url, body })
    return text === null ? { deny: 'network down' } : { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('ui.status', (_$, e) => {
    if (refused('ui.status')) return REFUSED
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    if (e.to === 'debug') debugLogs.push(e.text)
    return { value: undefined }
  })
  on('store.get', (_$, e) => {
    if (refused('store.get')) return REFUSED
    const text = store.get(e.key)
    return { value: text === undefined ? undefined : JSON.parse(text) }
  })
  on('store.set', (_$, e) => {
    if (refused('store.set')) return REFUSED
    const text = JSON.stringify(e.value)
    store.set(e.key, text)
    storeWrites.push({ key: e.key, value: JSON.parse(text) })
    return { value: undefined }
  })
  on('command.register', (_$, e) => {
    if (refused('command.register')) return REFUSED
    commands.push({ name: e.name, description: e.description })
    return { value: { command: e.name } }
  })
  on('agent.list', () => ({ value: (o.agents ?? []) as never }))
  on('model.complete', (_$, e) => {
    completes.push(e)
    const text = o.complete ? o.complete(e) : null
    if (text === null) return { deny: 'refused by the test' }
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: { isAnswered: true as const, text, usage } as never }
  })
  on('session.surfaces', () => (refused('session.surfaces') ? REFUSED : { value: (o.surfaces ?? ['terminal']) as RenderSurface[] }))
  // Not a stub: the kit keeps $.state itself. This only watches the writes on their way down; like
  // every $ call's, the answer comes back as { value } or { deny }.
  on('state.set', async (_$, e, next) => {
    const r = await next(e)
    stateWrites.push({ key: e.key, id: e.id, value: e.value, isSet: 'value' in r && r.value?.isSet === true })
    return r
  })

  // The engine events, at the bottom of each chain: what arrives here is what the mod passed on.
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$, e) => {
    submitted.push({ text: e.text, context: e.context, origin: e.origin })
    return { text: e.text, context: e.context }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e): AsyncGenerator<never, TurnStepResult> {
    stepsSent.push({ turnId: e.turnId, index: e.index, effort: e.effort, model: e.model, agentId: e.agentId })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: null }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.append', (_$, e) => {
    appended.push(e)
    return { message: e.message, uuid: e.uuid }
  })
  on('agent.spawn', (_$, e) => {
    spawned.push(e)
    agentNo += 1
    return { model: e.model ?? e.parentModel, agentId: `agent-${agentNo}` }
  })
  on('prompt.attachment', (_$, e) => {
    attachments.push(e)
    return { text: e.text }
  })
  on('skill.prompt', (_$, e) => ({ text: e.text }))

  return { fetched, statuses, logs, debugLogs, stepsSent, appended, spawned, submitted, attachments, completes, commands, storeWrites, stateWrites, clock }
}

// Answers in the shapes the decision models send (backend.ts reads them).

export function drexOk(answers: Record<string, unknown>, model = 'drex-max-v1.1'): string {
  return JSON.stringify({ model, answers, usage: { input_tokens: 100, output_tokens: 5 }, request_id: 'req_test' })
}

/** A score answer; probabilities are keyed by level number, as the services send them. */
export function score(probs: number[]) {
  const expected = probs.reduce((s, p, i) => s + p * i, 0)
  return { type: 'score', score: expected, probabilities: Object.fromEntries(probs.map((p, i) => [String(i), p])) }
}

export function noul(p: number) {
  return { type: 'noul', noul: p }
}

// Drivers. Each sends one engine event through the mod; give origin explicitly, the kit fills in nothing.

export function start($: Engine) {
  return $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

export function submit($: Engine, text: string, origin: PromptOrigin = { kind: 'composer' }) {
  return $.prompt.submit({ text, wait: false, origin })
}

export function turnStart($: Engine, turnId: string, text: string, agentId?: string) {
  return $.turn.start({ turnId, text, ...(agentId === undefined ? {} : { agentId }) })
}

/** Runs one step to its end (a stream not read to the end never reaches the engine) and returns its result. */
export async function step($: Engine, i: { turnId: string; index: number; effort?: unknown; model?: string; agentId?: string }) {
  const input = {
    turnId: i.turnId,
    index: i.index,
    model: i.model ?? 'claude-opus-5-5',
    messageCount: 1,
    ...(i.effort === undefined ? {} : { effort: i.effort }),
    ...(i.agentId === undefined ? {} : { agentId: i.agentId }),
  } as TurnStepInput
  const stream = $.turn.step(input)
  for await (const _chunk of stream) {
    // read to the end
  }
  return stream.result
}

/** Ends a turn: answered unless isAborted or reason says otherwise; agentId ends a subagent's turn. */
export function complete($: Engine, turnId: string, o: { answer?: string; isAborted?: boolean; reason?: TurnCompleteReason; agentId?: string } = {}) {
  const isAborted = o.isAborted ?? o.reason === 'aborted'
  const reason = o.reason ?? (isAborted ? 'aborted' : 'answer')
  const ending = reason === 'refusal' ? { reason, refusal: { category: null, explanation: null } } : { reason }
  const input = { turnId, answer: o.answer ?? '', durationMs: 1000, isAborted, ...ending, ...(o.agentId === undefined ? {} : { agentId: o.agentId }) }
  return $.turn.complete(input as TurnCompleteInput)
}

/** Runs /dp with the given arguments and returns the text it answered with. */
export async function dp($: Engine, args = ''): Promise<string> {
  const r = await $.command.run({ command: 'dp', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  return r.text ?? ''
}
