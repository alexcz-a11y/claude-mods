// Seam 1: the world beneath dispatch-pilot in `claude plugin test`.
//
// Everything registered here sits beneath the mod: it answers the mod's `$`
// calls (the decision backend at `http.fetch`, the disk at `fs.*`, the
// transcript at `session.messages`) and plays the engine at the bottom of the
// events the mod passes on, recording what reached it. Assertions read those
// records: what the mod sent to the backend, what each model request went out
// with, what the status line said.
//
// Not a test file (no `.test.ts`), so `claude plugin test` only runs it through
// the tests that import it. Register it before the test's first `$` call.

import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type {
  CommandInfo,
  CommandSpec,
  ContextSkill,
  ModelCompleteRequest,
  ModelCompleteResult,
  On,
  PromptOrigin,
  SessionContextBreakdown,
  SessionMeasureInput,
  SessionMessage,
  SessionUsage,
  SettingsSource,
  ToolSpec,
} from 'claude-code'

/** One request the mod sent through `$.http.fetch`, its JSON body parsed. */
export type Sent = {
  url: string
  method: string | undefined
  headers: Record<string, string>
  // The body as JSON (what the backend reads); untyped on purpose: tests read
  // the wire format the way the backend would.
  body: any
}

/** How the fake backend answers one request. */
export type Reply =
  /** An HTTP response; a non-string body is sent as JSON. */
  | { status: number; body: unknown }
  /** `$.http.fetch` rejects, as when the network is down. */
  | { reject: string }
  /** The reply, after `after` ms of mock time (`w.clock.advance`). */
  | { after: number; reply: Reply }

/** One model request as it reached the engine, after every hook of the mod. */
export type Step = { turnId: string; index: number; model: string; effort: unknown; agentId: string | undefined }

export type WorldOptions = {
  /** Answers each backend request (`n` counts from 1). Without one, every request gets HTTP 500. */
  backend?: (request: Sent, n: number) => Reply | Promise<Reply>
  /**
   * The transcript `$.session.messages()` returns: as given, or as a function gives it at each call (one that grows
   * as the turn goes), told what was asked: `{ agentId }` for an agent's, which it may refuse with `{ deny }` as the
   * engine refuses a workflow agent's.
   */
  messages?: SessionMessage[] | ((asked: { agentId?: string }) => SessionMessage[] | { deny: string })
  /** Files the mod can read, by absolute path (`$.fs.read`, `$.fs.exists`). */
  disk?: Record<string, string>
  /**
   * The mod's `$.store`, seeded with these values; what the mod writes is read back with `w.stored(key)`.
   * Without it every `$.store` call rejects, as when the store file cannot be read or written.
   */
  store?: Record<string, unknown>
  /**
   * The engine's session around the mod: `w.start()` runs `session.start`, the commands and tools the mod
   * registers are recorded in `w.commands` and `w.tools` (`registerError` refuses both), `w.measure(...)`
   * raises `session.measure`, `w.compact()` and `w.clear()` the person's /compact and /clear
   * (`session.compact`, `session.end`).
   */
  session?: true | { registerError: string }
  /** What the hooks beneath the mod (other plugins, settings hooks) do to a prompt. */
  beneath?: {
    /** The text the turn starts with, when a hook beneath rewrote the prompt. */
    rewrite?: (text: string) => string
    /** A reason to refuse the prompt (it never enters, no turn starts). */
    drop?: (text: string) => string | undefined
  }
  /**
   * The session's skills (#10): what `$.command.list()`, `$.session.usage({ breakdown })`, `$.settings.read`,
   * `$.env.get('HOME')` and `$.session.cwd()` answer, and the engine beneath `prompt.attachment` (`w.listing`).
   * Without it those calls reject, and the skills feature finds no skills.
   */
  skills?: SkillsWorld
  /**
   * The model behind `$.model.complete` (#11 writes skill profiles with it): answers each completion
   * (`n` counts from 1); every one is recorded in `w.completions`. Without it every completion is refused.
   */
  model?: (request: ModelCompleteRequest, n: number) => Completion | Promise<Completion>
}

/** How the model answers one completion. */
export type Completion =
  /** The reply's text. */
  | { text: string }
  /** No text: an API error (with its HTTP status), a reply without text, or the call cut short. */
  | { fails: 'api-error' | 'empty-reply' | 'aborted' }
  /** The engine refuses to send it (a blocked model): `$.model.complete` rejects. */
  | { reject: string }
  /** The answer, after `after` ms of mock time (`w.clock.advance`). */
  | { after: number; reply: Completion }

/** The session's skills as the engine reports them to the mod (#10). */
export type SkillsWorld = {
  /** What `$.command.list()` returns. */
  commands?: CommandInfo[]
  /** The main agent's skill listing as `$.session.usage({ breakdown })` counts it (`skillFrontmatter`); `null` to make the call fail. */
  listed?: ContextSkill[] | null
  /** `skillOverrides` per settings source (`$.settings.read({ source })`). */
  overrides?: Partial<Record<SettingsSource, Record<string, string>>>
  /** `$.env.get('HOME')`; `/home/u` by default. */
  home?: string
  /** `$.session.cwd()`; `/work` by default. */
  cwd?: string
}

export type SubmitOptions = {
  /** Where the prompt came from; the person's own Enter by default. */
  origin?: PromptOrigin
  /** Typed while this turn ran (mid-turn): no turn starts for it now. */
  turnId?: string
  /** The person asked it to wait its turn (`chat:queueSubmit`). */
  wait?: boolean
}

export type StepOptions = {
  index: number
  /** The turn the request belongs to; the last turn started by default. */
  turnId?: string
  /** The model the engine resolved for this request. */
  model?: string
  /** The effort the engine asks for; `null` for a model without effort (the field is left out). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number | null
  /** A dispatched or workflow agent's loop; absent on the main agent. */
  agentId?: string
  /** The response's visible text, streamed before its tool calls. */
  answer?: string
  /**
   * The tool calls the response makes. The engine runs each one (`tool.call`)
   * while the response still streams, before the step ends (measured on
   * 2.1.289), so a hook on `tool.call` sees it inside the step.
   */
  tools?: ToolRun[]
}

/** A tool call the model makes in a step, and how it ends. */
export type ToolRun = {
  tool: string
  /** The call's arguments as the model wrote them (`command`, `file_path`, `description`, ...). */
  input?: Record<string, unknown>
  /**
   * How the call ends: the tool's text (default "ok"), an error the tool
   * reported (also how a refusal at the permission prompt reads), or a
   * PreToolUse settings hook's refusal (the tool never runs).
   */
  ends?: { text: string } | { error: string } | { blockedByHook: string }
}

/** One agent.spawn as it reached the engine, after every hook of the mod. */
export type Spawned = { tool_use_id: string; model: string | undefined; subagentType: string; description: string; prompt: string }

export type SpawnOptions = {
  /** The task the main agent wrote for the agent (the Agent tool's `prompt`). */
  prompt: string
  description?: string
  /** `general-purpose` by default. */
  subagentType?: string
  /** The Agent tool's `model` parameter: the main agent's pick; absent leaves it to the engine. */
  model?: string
  /** A fork of the parent (it always inherits the parent's model). */
  fork?: boolean
  /** A teammate of the session's team. */
  isTeammate?: true
}

export type World = ReturnType<typeof world>

export function world($: Engine, on: On, options: WorldOptions = {}) {
  const clock: MockClock = mock.clock(on)
  const requests: Sent[] = []
  const statuses: (string | undefined)[] = []
  const logs: { text: string; to: string | undefined }[] = []
  const steps: Step[] = []
  const prompts: { text: string; context: readonly string[] | undefined; origin: unknown }[] = []
  const turnIds: string[] = []
  const toolCalls: { tool: string; id: string; input: Record<string, unknown>; isError: boolean; text: string | undefined }[] = []
  const spawned: Spawned[] = []
  const completions: ModelCompleteRequest[] = []
  let calls = 0
  const disk = options.disk ?? {}
  const store = new Map(Object.entries(options.store ?? {}).map(([key, value]) => [key, JSON.stringify(value)]))
  const commands: CommandSpec[] = []
  /** The text a command's turn starts with, by the prompt it was submitted as (`/name args`): the engine's command message. */
  const commandTurns = new Map<string, string>()
  const tools: Required<ToolSpec>[] = []
  /** What the step being sent streams and runs (set by `step()`, read by the engine's turn.step below). */
  let streaming: Pick<StepOptions, 'answer' | 'tools'> = {}
  /** How the tool call running now ends (set around each `$.tool.call` below). */
  let ending: ToolRun['ends'] | undefined

  async function answer(reply: Reply): Promise<{ value: { status: number; ok: boolean; headers: Record<string, string>; text: string } } | { deny: string }> {
    if ('after' in reply) {
      await clock.sleep(reply.after)
      return answer(reply.reply)
    }
    if ('reject' in reply) return { deny: reply.reject }
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
    return { value: { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: {}, text } }
  }

  on('http.fetch', async (_$, e) => {
    let body: unknown = e.init?.body
    try {
      body = JSON.parse(String(e.init?.body))
    } catch {
      // not JSON: kept as sent
    }
    const sent: Sent = { url: e.url, method: e.init?.method, headers: { ...(e.init?.headers ?? {}) }, body }
    requests.push(sent)
    const reply = options.backend ? await options.backend(sent, requests.length) : { status: 500, body: 'no backend in this test' }
    return answer(reply)
  })
  const usage = { input_tokens: 1200, output_tokens: 180, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const none = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  async function complete(reply: Completion): Promise<{ value: ModelCompleteResult } | { deny: string }> {
    if ('after' in reply) {
      await clock.sleep(reply.after)
      return complete(reply.reply)
    }
    if ('reject' in reply) return { deny: reply.reject }
    if ('text' in reply) return { value: { isAnswered: true, text: reply.text, usage } }
    if (reply.fails === 'api-error') return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: none } }
    return { value: { isAnswered: false, reason: reply.fails, usage: none } }
  }
  on('model.complete', async (_$, e) => {
    completions.push(e)
    return options.model ? complete(await options.model(e, completions.length)) : { deny: 'no model in this test' }
  })
  on('session.messages', (_$, e) => ({ value: (typeof options.messages === 'function' ? options.messages({ ...(e.agentId === undefined ? {} : { agentId: e.agentId }) }) : (options.messages ?? [])) as never }))
  on('fs.read', (_$, e) => (e.path in disk ? { value: disk[e.path] as string } : { deny: `ENOENT: ${e.path}` }))
  on('fs.exists', (_$, e) => ({ value: e.path in disk || Object.keys(disk).some((path) => path.startsWith(`${e.path}/`)) }))
  // A directory of the disk: what lies directly under it, a file or a directory (one holding files further down).
  on('fs.list', (_$, e) => {
    const under = `${(e.path ?? '').replace(/\/+$/, '')}/`
    const entries = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(disk)) {
      if (!path.startsWith(under)) continue
      const [name = '', ...deeper] = path.slice(under.length).split('/')
      if (name !== '' && entries.get(name) !== 'dir') entries.set(name, deeper.length > 0 ? 'dir' : 'file')
    }
    if (entries.size === 0) return { deny: `ENOENT: ${e.path}` }
    return { value: [...entries].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  if (options.store !== undefined) {
    on('store.get', (_$, e) => ({ value: store.has(e.key) ? JSON.parse(store.get(e.key) as string) : undefined }))
    on('store.set', (_$, e) => {
      store.set(e.key, JSON.stringify(e.value))
      return { value: undefined }
    })
    on('store.delete', (_$, e) => {
      store.delete(e.key)
      return { value: undefined }
    })
    on('store.keys', () => ({ value: [...store.keys()] }))
  }
  if (options.session !== undefined) {
    const refused = options.session === true ? undefined : options.session.registerError
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    on('session.compact', (_$, e) => ({ messages: e.messages }))
    on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
    on('command.register', (_$, e) => {
      if (refused !== undefined) return { deny: refused }
      commands.push(e)
      return { value: { command: e.name } }
    })
    // The model calls a plugin's tool by its full name (`mcp__<plugin>__<name>`).
    on('tool.register', (_$, e) => {
      if (refused !== undefined) return { deny: refused }
      tools.push(e)
      return { value: { tool: `mcp__dispatch-pilot__${e.name}` } }
    })
  }
  if (options.skills !== undefined) {
    const skills = options.skills
    mock.env(on, { HOME: skills.home ?? '/home/u' })
    on('session.cwd', () => ({ value: skills.cwd ?? '/work' }))
    on('command.list', () => ({ value: skills.commands ?? [] }))
    on('session.usage', () => (skills.listed === null ? { deny: 'no session bound' } : { value: usageListing(skills.listed ?? []) }))
    on('settings.read', (_$, e) => ({ value: e?.source === undefined ? {} : { skillOverrides: skills.overrides?.[e.source] ?? {} } }))
    on('prompt.attachment', (_$, e) => ({ text: e.text }))
  }
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    logs.push({ text: e.text, to: e.to })
    return { value: undefined }
  })
  // The engine at the bottom of prompt.submit: a prompt submitted while the
  // session is idle starts its turn inside `next(e)`, as Claude Code does
  // (turn.start fires before prompt.submit's next resolves); one typed during
  // a turn (`turnId`) is queued and starts nothing now.
  on('prompt.submit', async (_$, e) => {
    const dropped = options.beneath?.drop?.(e.text)
    if (dropped !== undefined) return { drop: dropped }
    const text = options.beneath?.rewrite?.(e.text) ?? e.text
    prompts.push({ text, context: e.context, origin: e.origin })
    // A command's turn starts with its command message, not the prompt as typed (measured on 2.1.291).
    const started = commandTurns.get(e.text) ?? text
    commandTurns.delete(e.text)
    if (e.turnId === undefined) {
      const turnId = `t${turnIds.length + 1}`
      turnIds.push(turnId)
      await $.turn.start({ text: started, turnId })
    }
    return { text, context: e.context }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  // The engine's own command beneath `command.run`: a prompt command (a skill, a markdown command) prints nothing.
  on('command.run', () => ({}))
  // The engine at the bottom of agent.spawn: it starts the agent on the model
  // it is handed (the parent's when none) and names it a1, a2, ... in the
  // order the spawns reach it.
  on('agent.spawn', (_$, e) => {
    spawned.push({ tool_use_id: e.tool_use_id, model: e.model, subagentType: e.subagentType, description: e.description, prompt: e.prompt })
    return { model: e.model ?? e.parentModel, agentId: `a${spawned.length}` }
  })
  // The engine at the bottom of turn.step: it records what the request went
  // out with, streams the response's text, and runs each tool call while the
  // response still streams, as Claude Code does.
  on('turn.step', async function* (_$, e) {
    steps.push({ turnId: e.turnId, index: e.index, model: e.model, effort: e.effort, agentId: e.agentId })
    const { answer = '', tools = [] } = streaming
    streaming = {}
    if (answer) yield { kind: 'text' as const, index: 0, text: answer }
    for (const [i, run] of tools.entries()) {
      yield { kind: 'tool' as const, index: i + 1, id: `toolu_${e.turnId}_${e.index}_${i}`, name: run.tool }
      ending = run.ends
      await $.tool.call({ tool: run.tool, ...(run.input ?? {}), ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) } as never)
      ending = undefined
    }
    const toolUses = tools.map((run) => ({ name: run.tool, input: run.input ?? {} }))
    return { turnId: e.turnId, index: e.index, answer, toolUses, stopReason: 'tool_use' as const, usage: null }
  })
  // A PreToolUse settings hook: it refuses the call when the test says so.
  on('classic.PreToolUse', () => (ending !== undefined && 'blockedByHook' in ending ? { deny: ending.blockedByHook } : {}))
  // The tools themselves: each call that reaches them is recorded with its
  // arguments as they arrived (after every hook of the mod) and how it ended.
  on('tool.call', (_$, e) => {
    const { tool, tool_use_id: id, agentId: _agent, ...input } = e as { tool: string; tool_use_id?: string; agentId?: string } & Record<string, unknown>
    const end = ending ?? { text: 'ok' }
    const failed = 'error' in end
    const text = failed ? end.error : 'text' in end ? end.text : 'ok'
    toolCalls.push({ tool, id: id ?? '', input, isError: failed, text })
    return failed ? { result: text, text, isError: true as const } : { result: text, text }
  })

  return {
    clock,
    requests,
    statuses,
    logs,
    steps,
    prompts,
    turnIds,
    spawned,
    commands,
    tools,
    /** What the mod last stored under `key` (JSON as it reads back); `undefined` when it never did. */
    stored: (key: string): unknown => (store.has(key) ? JSON.parse(store.get(key) as string) : undefined),
    /** The keys the store holds now, in the order they were first set. */
    storedKeys: (): string[] => [...store.keys()],
    /** Every completion the mod asked of `$.model.complete`, as it reached the model. */
    completions,
    /** Every tool call that reached the tools, its id, its arguments as they arrived (a hook's rewrite included) and how it ended; a call a hook refused is not in it. */
    toolCalls,
    /** The status line as last set (`undefined` once cleared or never set). */
    status: () => statuses.at(-1),
    /** Submits a prompt the way the engine does; resolves when it entered (or was queued). */
    submit: (text: string, submit: SubmitOptions = {}) =>
      $.prompt.submit({
        text,
        wait: submit.wait ?? false,
        origin: submit.origin ?? { kind: 'composer' },
        ...(submit.turnId !== undefined ? { turnId: submit.turnId } : {}),
      }),
    /** Starts a turn for a prompt that waited in the queue; resolves to its id. */
    startTurn: async (text: string) => {
      const turnId = `t${turnIds.length + 1}`
      turnIds.push(turnId)
      await $.turn.start({ text, turnId })
      return turnId
    },
    /** The main agent calls the Agent tool: resolves to the started agent's `{ model, agentId }`, or `{ deny }`. */
    spawn: (spawn: SpawnOptions) =>
      $.agent.spawn({
        tool_use_id: `toolu_${++calls}`,
        provider: { plugin: 'engine', tier: 'core' },
        parentModel: 'claude-opus-5-5',
        background: false,
        fork: spawn.fork ?? false,
        prompt: spawn.prompt,
        description: spawn.description ?? 'task',
        subagentType: spawn.subagentType ?? 'general-purpose',
        ...(spawn.model !== undefined ? { model: spawn.model } : {}),
        ...(spawn.isTeammate ? { isTeammate: true as const } : {}),
      }),
    /** The session starts (needs `session`): the mod sets itself up and registers its commands. */
    start: () => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true }),
    /** The engine reports the session's context, limits and cost (needs `session`). */
    measure: (input: SessionMeasureInput) => $.session.measure(input),
    /** Runs a slash command as the person types it (`/dp lock max` is `command('dp', 'lock max')`); resolves to the text it printed. */
    command: async (name: string, args = '') =>
      (await $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text ?? '',
    /**
     * The person types a prompt command (a skill, a markdown command): as Claude Code runs one (measured on 2.1.291),
     * `command.run` first, then the prompt as typed (`/name args`) is submitted, and its turn starts with the
     * engine's command message. A local command (`/dp`, `/usage`) is `command(...)`: it submits nothing.
     */
    slash: async (name: string, args = '', submit: SubmitOptions & { as?: string } = {}) => {
      const origin = submit.origin ?? { kind: 'composer' }
      await $.command.run({ command: name, args, origin, presentation: { isFullscreen: false, columns: 80 } })
      // `as`: the name the person typed, when the engine resolves it to another (a plugin's command typed without its plugin's name).
      const typedName = submit.as ?? name
      const typed = args === '' ? `/${typedName}` : `/${typedName} ${args}`
      const message = `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>${args === '' ? '' : `\n<command-args>${args}</command-args>`}`
      commandTurns.set(typed, message)
      return $.prompt.submit({ text: typed, wait: submit.wait ?? false, origin, ...(submit.turnId !== undefined ? { turnId: submit.turnId } : {}) })
    },
    /** The person's `/compact` of the main conversation (needs `session`). */
    compact: () => $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'earlier work', toolUses: [] }] }),
    /** The person's `/clear` (needs `session`): the conversation ends, the process goes on, no session.start follows. */
    clear: () => $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } }),
    /**
     * The model calls the mod's find_skill tool with this query (`agentId`: from a dispatched agent's loop);
     * resolves to the tool's answer, `{ result }`.
     */
    findSkill: (query: unknown, call: { agentId?: string } = {}) =>
      $.tool.call({ tool: 'mcp__dispatch-pilot__find_skill', query, ...(call.agentId !== undefined ? { agentId: call.agentId } : {}) }),
    /** The engine's skill listing as one request of a loop carries it (`agentId`: a dispatched agent's; needs `skills`); resolves to what the model reads. */
    listing: (text: string, agentId?: string) =>
      $.prompt.attachment({ type: 'skill_listing', text, origin: { kind: 'engine' }, ...(agentId !== undefined ? { agentId } : {}) }),
    /** Sends one model request through the mod, drained to its end (its text streamed, its tools run). */
    step: async (step: StepOptions) => {
      streaming = { answer: step.answer, tools: step.tools }
      const effort = step.effort === undefined ? 'xhigh' : step.effort
      const input = {
        turnId: step.turnId ?? turnIds.at(-1) ?? 't0',
        index: step.index,
        model: step.model ?? 'claude-opus-5-5',
        messageCount: 1,
        ...(effort === null ? {} : { effort }),
        ...(step.agentId !== undefined ? { agentId: step.agentId } : {}),
      }
      for await (const _chunk of $.turn.step(input)) {
        // drained: the hooks run as the stream is read
      }
    },
  }
}

/** `$.session.usage({ breakdown: 'summary' })` whose context lists these skills for the main agent (the rest of the breakdown left out). */
function usageListing(listed: readonly ContextSkill[]): SessionUsage {
  const skills = { totalSkills: listed.length, includedSkills: listed.length, tokens: 60 * listed.length, skillFrontmatter: [...listed] }
  const breakdown = { skills } as unknown as SessionContextBreakdown
  return { startedAt: 0, context: { window: 200_000, breakdown }, rateLimits: [] }
}

/**
 * A Jev answer to every question of the request it replies to: each `score`
 * question gets `levels` as its probabilities (lowest level first) and
 * `confidence` (0.7 by default), each `choice` the option named in `choice`
 * (or its first), or the probabilities `shares` gives for its question id
 * (options it leaves out get 0), each `noul` the value `nouls` gives for its
 * question id, else 0.5.
 */
export function jev(
  levels: readonly number[],
  extra: { status?: number; choice?: string; confidence?: number | null; shares?: Record<string, Record<string, number>>; nouls?: Record<string, number> } = {},
) {
  return (request: Sent): Reply => {
    const answers: Record<string, unknown> = {}
    const questions = (request.body?.questions ?? {}) as Record<string, { type: string; criteria?: unknown }>
    for (const [id, question] of Object.entries(questions)) {
      if (question.type === 'score') {
        const probabilities = Object.fromEntries(levels.map((p, i) => [String(i), p]))
        const score = levels.reduce((sum, p, i) => sum + p * i, 0)
        answers[id] = { type: 'score', score, legend: {}, probabilities, confidence: extra.confidence === undefined ? 0.7 : extra.confidence }
      } else if (question.type === 'choice' && extra.shares?.[id] !== undefined) {
        const shares = extra.shares[id] as Record<string, number>
        const options = Object.keys((question.criteria ?? {}) as Record<string, unknown>)
        const probabilities = Object.fromEntries(options.map((o) => [o, shares[o] ?? 0]))
        const pick = options.reduce((best, o) => ((probabilities[o] ?? 0) > (probabilities[best] ?? 0) ? o : best), options[0] ?? '')
        answers[id] = { type: 'choice', choice: pick, probabilities, confidence: 0.5 }
      } else if (question.type === 'choice') {
        const options = Object.keys((question.criteria ?? {}) as Record<string, unknown>)
        const pick = extra.choice ?? options[0] ?? ''
        answers[id] = { type: 'choice', choice: pick, probabilities: Object.fromEntries(options.map((o) => [o, o === pick ? 1 : 0])), confidence: 1 }
      } else {
        answers[id] = { type: 'noul', noul: extra.nouls?.[id] ?? 0.5 }
      }
    }
    return { status: extra.status ?? 200, body: { model: 'jev-1.13.0', answers, usage: { input_tokens: 300, output_tokens: 0 } } }
  }
}

/** Whether a request is a message's second skills request (#11): the shortlist re-read, one `skills.fits.<i>` each. */
export function isSecondSkillsRequest(request: Sent): boolean {
  return Object.keys(request.body?.questions ?? {}).some((id) => id.startsWith('skills.fits.'))
}

/**
 * Jev answering both requests a message's skills take (#11): the first (each
 * Score `levels`, effort medium by default; `skills.which`, the skills the
 * main agent can load, and `skills.hint`, those only the person can start,
 * each these `shares` of its own options), and the second, where each
 * `skills.fits.<i>` is the fit `fits` gives the skill its instructions name
 * (0 when left out) and `skills.best` puts all on the best-fitting one.
 */
export function rates(shares: Record<string, number>, fits: Record<string, number> = {}, levels: readonly number[] = [0, 1, 0, 0, 0]) {
  return (request: Sent): Reply => {
    if (!isSecondSkillsRequest(request)) return jev(levels, { shares: { 'skills.which': shares, 'skills.hint': shares } })(request)
    const questions = request.body.questions as Record<string, { instructions?: { skill?: { name?: string } } }>
    const nouls: Record<string, number> = {}
    for (const [id, question] of Object.entries(questions)) {
      if (id.startsWith('skills.fits.')) nouls[id] = fits[question.instructions?.skill?.name ?? ''] ?? 0
    }
    const named = Object.values(questions).flatMap((question) => question.instructions?.skill?.name ?? [])
    const best = named.reduce((top, name) => ((fits[name] ?? 0) > (fits[top] ?? 0) ? name : top), named[0] ?? '')
    return jev(levels, { nouls, shares: { 'skills.best': { [best]: 1 } } })(request)
  }
}
