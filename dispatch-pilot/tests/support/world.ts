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
  ModelCompleteResult,
  On,
  PromptAttachmentInput,
  PromptOrigin,
  RenderSurface,
  SessionAppendInput,
  SessionAppendMessage,
  TurnCompleteInput,
  TurnCompleteReason,
  TurnStepInput,
  TurnStepResult,
  UiPane,
} from 'claude-code'

import type { BoardState } from '../../hooks/board/model.ts'

/** userConfig with the Drex key set (fallback stays off, so only Drex is asked). */
export const KEYS = { drexApiKey: 'k-drex' }

/**
 * userConfigs in which no backend can be asked (canAsk is false): no key at all, or only the other backend's key,
 * with fallback off and on (canAsk is about the chosen backend alone).
 */
export const NO_BACKEND = [
  ['没有密钥', {}],
  ['只有 Jev 的密钥，fallback 关', { jevApiKey: 'k-jev' }],
  ['只有 Jev 的密钥，fallback 开', { jevApiKey: 'k-jev', fallback: true }],
  ['选了 Jev，只有 Drex 的密钥，fallback 开', { backend: 'jev', drexApiKey: 'k-drex', fallback: true }],
] as const

export type WorldOptions = {
  /** Answers each $.http.fetch with a 200 body, or null for a network failure. Left out: HTTP 500. */
  answer?: (req: { url: string; body: any }) => string | null | Promise<string | null>
  /** What $.store holds when the test starts (JSON data, by key). */
  store?: Record<string, unknown>
  /** What $.agent.list() answers. */
  agents?: unknown[]
  /** Mock-clock ms the n-th $.agent.list() call (from 1) waits before it answers; 0 or left out: at once. */
  listDelay?: (call: number) => number
  /**
   * What $.model.complete answers with: a text (an answered call), a whole ModelCompleteResult (an object), or null
   * (or no option) to refuse the call, so it rejects. May wait first (await clock.sleep(...)).
   */
  complete?: (e: ModelCompleteInput) => string | ModelCompleteResult | null | Promise<string | ModelCompleteResult | null>
  /** What $.session.surfaces() answers; ['terminal'] when left out. */
  surfaces?: string[]
  /**
   * $ calls to answer with { deny }, so the mod's call rejects: ui.status, store.get, store.set, command.register,
   * session.surfaces, state.get (every read of the mod's own state), ui.invalidate (the kit swallows that refusal:
   * the mod's call neither throws nor rejects, measured on 2.1.327).
   */
  refuse?: string[]
  /**
   * The board's state (tests/support/scenes.ts): every read of session, turn, recent and skills answers it. The
   * version comes from the kit's own store, so the mod's update()s still land there (a scene that answered a fixed
   * version would make each one miss on every try and give up, measured); later reads answer the scene all the same.
   */
  scene?: BoardState
  /**
   * What $.ui.open answers: placed (shown at once), or, the default, refused as on a terminal too narrow, so the
   * tests that run /dp without caring for the pane get its text version. $.ui.panes and $.ui.close follow it.
   */
  pane?: 'placed' | 'refused'
  /**
   * Runs inside the engine's prompt.submit, before it answers. The engine starts a message's turn there
   * (turn.start inside prompt.submit's next(e), with the text that reached it; measured on 2.1.327), so a
   * test raises turn.start from here. Returning { drop } refuses the prompt.
   */
  onSubmit?: (e: { text: string; turnId: string | undefined }) => unknown
  /**
   * Runs when the mod writes a state key, before the write goes down to the kit's store (whose version check
   * comes after it). A test raises another event from here to land a write in the middle of the mod's update().
   */
  onStateSet?: (e: { key: string; value: unknown }) => unknown
  /**
   * Runs inside the engine's agent.spawn, before it answers with `{ model, agentId }`. The agent's own first
   * turn.step can come before that answer (design 9), so a test raises it from here. Returning an object with
   * `deny` or `model` answers with that instead (no agentId unless it gives one).
   */
  onSpawn?: (e: AgentSpawnInput, agentId: string) => unknown
  /** The text the engine's prompt.attachment answers with; the attachment's own text when left out (null leaves it out). */
  attachmentText?: (e: PromptAttachmentInput) => string | null
  /**
   * Runs inside the engine's turn.step, before it answers, with the step as it reached the engine: where the engine
   * sends the step's model request (design 9), while the mod's turn.step hook is still inside next().
   */
  onStep?: (e: SentStep) => unknown
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
  /** Every $.http.fetch that reached the bottom, as it came: the url, the init untouched, and who raised it (next.origin.plugin). */
  const requests: { url: string; init: unknown; origin: string }[] = []
  const statuses: (string | undefined)[] = []
  const logs: string[] = []
  /** The lines of logs that went to the debug log alone ({ to: 'debug' }). */
  const debugLogs: string[] = []
  const stepsSent: SentStep[] = []
  const appended: SessionAppendInput[] = []
  const spawned: AgentSpawnInput[] = []
  /** How many times the mod called $.agent.list(). */
  const listed = { calls: 0 }
  const submitted: { text: string; context: readonly string[] | undefined; origin: PromptOrigin }[] = []
  const attachments: PromptAttachmentInput[] = []
  const completes: ModelCompleteInput[] = []
  const commands: { name: string; description: string }[] = []
  const storeWrites: { key: string; value: unknown }[] = []
  /** Every $.state.set the mod made, landed or not (isSet false: an ifVersion that missed). */
  const stateWrites: { key: string; id: string | undefined; value: unknown; isSet: boolean }[] = []
  /** The panes open now, as $.ui.panes() lists them; every $.ui.open's argument, and every closed id, in order. */
  const panes: UiPane[] = []
  const opened: { id: string; title?: string }[] = []
  const closed: string[] = []
  /** What each $.ui.invalidate asked to run again. */
  const invalidated: string[] = []
  /** The footer's labels as each drawing of it reached the engine. */
  const footers: string[][] = []

  // The mod races $.clock.sleep against its requests: without a mock clock every sleep rejects at once
  // and reads as a timeout.
  const clock = mock.clock(on)

  // Kept as JSON text, so a read hands back a copy, as $.store does.
  const store = new Map<string, string>(Object.entries(o.store ?? {}).map(([k, v]) => [k, JSON.stringify(v)]))
  let agentNo = 0
  const refused = (name: string): boolean => o.refuse?.includes(name) === true
  const REFUSED = { deny: 'refused by the test' } as const

  // The mod's $ calls.
  on('http.fetch', async (_$, e, next) => {
    requests.push({ url: e.url, init: e.init, origin: next.origin.plugin })
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
  on('agent.list', async () => {
    listed.calls += 1
    const ms = o.listDelay?.(listed.calls) ?? 0
    if (ms > 0) await clock.sleep(ms)
    return { value: (o.agents ?? []) as never }
  })
  on('model.complete', async (_$, e) => {
    completes.push(e)
    const out = o.complete ? await o.complete(e) : null
    if (out === null) return { deny: 'refused by the test' }
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: (typeof out === 'string' ? { isAnswered: true as const, text: out, usage } : out) as never }
  })
  on('session.surfaces', () => (refused('session.surfaces') ? REFUSED : { value: (o.surfaces ?? ['terminal']) as RenderSurface[] }))
  on('ui.open', (_$, e) => {
    opened.push({ id: e.id, ...(e.title === undefined ? {} : { title: e.title }) })
    const isPlaced = o.pane === 'placed'
    const pane = { id: e.id, title: e.title ?? e.id, isShown: isPlaced, isFocused: false, isPlaced }
    const at = panes.findIndex((p) => p.id === e.id)
    if (at === -1) panes.push(pane)
    else panes[at] = pane
    return { value: isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'too narrow' } }
  })
  on('ui.close', (_$, e) => {
    closed.push(e.id)
    const at = panes.findIndex((p) => p.id === e.id)
    if (at !== -1) panes.splice(at, 1)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: panes.map((p) => ({ ...p })) }))
  // Recorded, then passed on: the kit's own invalidate draws a mounted drawing again, as the engine does.
  on('ui.invalidate', (_$, e, next) => {
    if (refused('ui.invalidate')) return REFUSED
    invalidated.push(e.event)
    return next(e)
  })
  // The engine's footer, beneath the mod: the labels the mod passed on.
  on('ui.render', { component: 'SessionMode' }, (_$, e, next) => {
    footers.push([...e.props.modes])
    return next(e)
  })
  if (refused('state.get')) on('state.get', { plugin: 'dispatch-pilot' }, () => REFUSED)
  else if (o.scene !== undefined) {
    const scene: Record<string, unknown> = { ...o.scene }
    on('state.get', { plugin: 'dispatch-pilot' }, async (_$, e, next) => {
      const r = await next(e)
      if (!(e.key in scene) || !('value' in r)) return r
      return { value: { value: scene[e.key], version: r.value?.version ?? 0 } } as never
    })
  }
  // Not a stub: the kit keeps $.state itself. This only watches the writes on their way down; like
  // every $ call's, the answer comes back as { value } or { deny }.
  on('state.set', async (_$, e, next) => {
    await o.onStateSet?.({ key: e.key, value: e.value })
    const r = await next(e)
    stateWrites.push({ key: e.key, id: e.id, value: e.value, isSet: 'value' in r && r.value?.isSet === true })
    return r
  })

  // The engine events, at the bottom of each chain: what arrives here is what the mod passed on.
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', async (_$, e) => {
    submitted.push({ text: e.text, context: e.context, origin: e.origin })
    const r = await o.onSubmit?.({ text: e.text, turnId: e.turnId })
    if (r !== null && typeof r === 'object' && 'drop' in r && typeof r.drop === 'string') return { drop: r.drop }
    return { text: e.text, context: e.context }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e): AsyncGenerator<never, TurnStepResult> {
    const sent = { turnId: e.turnId, index: e.index, effort: e.effort, model: e.model, agentId: e.agentId }
    stepsSent.push(sent)
    await o.onStep?.(sent)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: null }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  // A session.append hook must relay next(e) (one that answers without it is skipped): the kit keeps the row.
  on('session.append', (_$, e, next) => {
    appended.push(e)
    return next(e)
  })
  on('agent.spawn', async (_$, e) => {
    spawned.push(e)
    agentNo += 1
    const agentId = `agent-${agentNo}`
    const r = await o.onSpawn?.(e, agentId)
    if (r !== null && typeof r === 'object' && ('deny' in r || 'model' in r)) return r as never
    return { model: e.model ?? e.parentModel, agentId }
  })
  on('prompt.attachment', (_$, e) => {
    attachments.push(e)
    return { text: o.attachmentText ? o.attachmentText(e) : e.text }
  })
  on('skill.prompt', (_$, e) => ({ text: e.text }))

  return { fetched, requests, statuses, logs, debugLogs, stepsSent, appended, spawned, listed, submitted, attachments, completes, commands, storeWrites, stateWrites, panes, opened, closed, invalidated, footers, clock }
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

/** turnId: the running turn a prompt typed over it is delivered into. */
export function submit($: Engine, text: string, origin: PromptOrigin = { kind: 'composer' }, o: { turnId?: string } = {}) {
  return $.prompt.submit({ text, wait: false, origin, ...(o.turnId === undefined ? {} : { turnId: o.turnId }) })
}

export function turnStart($: Engine, turnId: string, text: string, agentId?: string) {
  return $.turn.start({ turnId, text, ...(agentId === undefined ? {} : { agentId }) })
}

/** An agent.spawn input with every field the engine fills in; parentModel opus unless given. */
export function spawnInput(o: Partial<AgentSpawnInput> = {}): AgentSpawnInput {
  return {
    tool_use_id: 'toolu_1',
    prompt: 'Find where the uploader retries.',
    description: 'Find the retry',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    ...o,
  }
}

/** Spawns an agent as the Agent tool does and returns what the chain answered. */
export function spawn($: Engine, o: Partial<AgentSpawnInput> = {}) {
  return $.agent.spawn(spawnInput(o))
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

/**
 * An onSubmit that starts each message's turn as the engine does, inside prompt.submit's next(e) with the text that
 * reached it (measured on 2.1.327): t1, t2, … in order; a prompt delivered into a running turn (turnId set) starts none.
 */
export function turns($: Engine) {
  let n = 0
  return (e: { text: string; turnId: string | undefined }) => (e.turnId === undefined ? turnStart($, `t${++n}`, e.text) : undefined)
}

/** Appends one row (a subagent's with agentId) and returns the row as it reached the engine. */
export async function append($: Engine, row: SessionAppendInput): Promise<SessionAppendMessage> {
  const r = await $.session.append(row)
  if (r.message === undefined) throw new Error(`the row was refused: ${r.deny}`)
  return r.message
}

/** Appends rows one after another, as the engine does, and returns them as they reached the engine. */
export async function appendAll($: Engine, rows: SessionAppendInput[]): Promise<SessionAppendMessage[]> {
  const out: SessionAppendMessage[] = []
  for (const row of rows) out.push(await append($, row))
  return out
}

/** Runs /dp with the given arguments and returns the text it answered with. */
export async function dp($: Engine, args = ''): Promise<string> {
  const r = await $.command.run({ command: 'dp', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  return r.text ?? ''
}
