import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { SessionAppendInput } from 'claude-code'

import { boardModel } from '../hooks/board/model.ts'
import { footerLabel } from '../hooks/board/view.ts'
import { readConfig } from '../hooks/config.ts'
import { openStep, readout } from '../hooks/flows/readout.ts'
import { renderDp } from '../hooks/log.ts'
import type { Decision } from '../hooks/log.ts'
import { classify, modelBase, withSent } from '../hooks/readout.ts'
import type { OpenStep } from '../hooks/readout.ts'
import type { SessionState, TurnState } from '../hooks/state.ts'
import { WATCHER, WIRE, viaWire } from './support/plugins.ts'
import { scriptByDelivery, scriptByPoll } from './support/rows.ts'
import { seedOf, standIn } from './support/standin.ts'
import { KEYS, appendAll, complete, dp, drexOk, noul, score, spawn, start, step, submit, turnStart, turns, world } from './support/world.ts'

type World = ReturnType<typeof world>

/** The tests below are about the readout: the progress note (on by default) is off, so its calls record nothing beside it. */
const NO_NOTE = { ...KEYS, progressNote: false }

const OPUS = 'claude-opus-5-5'
const HAIKU = 'claude-haiku-5-5'
const MESSAGES = 'https://api.anthropic.com/v1/messages?beta=true'
/** What the bottom answers a model request with here (the engine's real one streams). */
const STREAM = 'event: message_start'
const TASK = 'Fix the flaky retry in the uploader'
/** Text that stands for the conversation: none of it may leave the request (design 5.12). */
const SECRET = 'PRIVATE-7f3a: the customer list lives in /srv/clients.csv'
const SYSTEM = 'You are Claude Code, working in /srv/acme'
const THREAD = 'thread_7f3a'

/** A request body shaped like the main loop's (E15): the conversation, a thread, and the level at the top when given. */
function body(o: { model?: string; effort?: unknown; thread?: boolean; extra?: Record<string, unknown> } = {}): string {
  return JSON.stringify({
    model: o.model ?? OPUS,
    max_tokens: 32000,
    system: [{ type: 'text', text: SYSTEM }],
    messages: [{ role: 'user', content: [{ type: 'text', text: SECRET }] }],
    ...(o.thread === false ? {} : { thread: { id: THREAD } }),
    ...(o.effort === undefined ? {} : { output_config: { effort: o.effort } }),
    ...o.extra,
  })
}

/** The init of a model request; a credential header reads [redacted] to a hook (E15). */
const init = (b: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': '[redacted]' }, body: b })

// What the mod recorded and wrote in an engine-driven run, and what reached the engine.
const logged = (w: World): Decision[] => (w.storeWrites.filter((s) => s.key === 'log').at(-1)?.value ?? []) as Decision[]
const lastOf = (w: World, key: string): unknown => w.stateWrites.filter((s) => s.key === key && s.isSet).at(-1)?.value
const recent = (w: World): Decision[] => (lastOf(w, 'recent') ?? []) as Decision[]
const midruns = (w: World): Decision[] => logged(w).filter((d) => d.kind === 'midrun')
const turnState = (w: World): TurnState => lastOf(w, 'turn') as TurnState
const efforts = (w: World): unknown[] => w.stepsSent.map((s) => s.effort)
const reached = (w: World, row: SessionAppendInput): SessionAppendInput | undefined => w.appended.find((a) => a.uuid === row.uuid)
const row = (d: Decision) => [d.kind, d.from, d.to, d.applied, d.sent]
/** Every level the mod wrote as the session's current one in an engine-driven run (session writes are made all along). */
const sentLevels = (w: World): unknown[] => w.stateWrites.filter((s) => s.key === 'session' && (s.value as SessionState).lastSent !== null).map((s) => (s.value as SessionState).lastSent)
/** What of a request's text the mod logged, stored or wrote in an engine-driven run; the requests themselves carried it all. */
function leakedIn(w: World): string[] {
  const out = JSON.stringify([w.logs, w.debugLogs, w.statuses, w.storeWrites, w.stateWrites])
  const sent = JSON.stringify(w.requests)
  return [SECRET, SYSTEM, THREAD].filter((s) => out.includes(s) || !sent.includes(s))
}
/** The checks the turn waited on, as each landed turn write left them. */
const checks = (w: World): unknown[] => w.stateWrites.filter((s) => s.key === 'turn' && s.isSet).map((s) => (s.value as TurnState | null)?.unverified ?? null)

const NOTE_HIGH = '[dispatch-pilot] effort is now high: the same failure came back after a fix.'
const NOTE_MEDIUM = '[dispatch-pilot] effort is now medium: the cause is found and what remains is routine.'

// The message's own judgement: from medium, SUBMIT_HOLD holds and SUBMIT_RAISE goes to high.
const SUBMIT_HOLD = { open: score([0.05, 0.3, 0.3, 0.3, 0.05]), mechanical: noul(0.1), unknown_cause: noul(0.2) }
const SUBMIT_RAISE = { open: score([0.02, 0.08, 0.25, 0.55, 0.1]), mechanical: noul(0.1), unknown_cause: noul(0.2) }
// Mid-run answers: HOLD stays put; SAME_FAILURE goes one level up; CAUSE_FOUND goes from high down to medium.
const FLAGS_NO = { same_failure: noul(0.1), cause_found: noul(0.2), only_carrying_out: noul(0.2), contradicts_plan: noul(0.1) }
const HOLD = { open: score([0.05, 0.3, 0.3, 0.3, 0.05]), ...FLAGS_NO }
const SAME_FAILURE = { ...HOLD, same_failure: noul(0.9) }
const CAUSE_FOUND = { open: score([0.1, 0.8, 0.05, 0.05, 0]), ...FLAGS_NO, cause_found: noul(0.9) }
// An agent's task: read-only and mechanical, so haiku at medium.
const LOOKUP = { open: score([0.05, 0.3, 0.3, 0.3, 0.05]), mechanical: noul(0.9), unknown_cause: noul(0.1), read_only: noul(0.9) }

type Answers = Record<string, unknown>

// The decision model's answers: the message's (with continues 0.1 when asked), or the mid-run ones, or what `midrun`
// returns for the state sent. A model request (the wire plugin's) gets STREAM.
function answers(message: Answers, midrun: Answers | ((state: any) => Answers)) {
  return ({ url, body }: { url: string; body: any }) => {
    if (url === MESSAGES) return STREAM
    if ('same_failure' in body.questions) return drexOk(typeof midrun === 'function' ? midrun(body.state) : midrun)
    return drexOk('continues' in body.questions ? { ...message, continues: noul(0.1) } : message)
  }
}

// A turn under way: the session started, the message sent and judged, its first step taken at medium.
async function begin($: Engine) {
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
}

const stepT1 = ($: Engine, index: number) => step($, { turnId: 't1', index, effort: 'medium' })


// The readout of an engine request, driven directly, on support/standin.ts's stand-in $ seeded with the state an
// engine-driven run left (the kit raises no http.fetch as the engine: DEVELOPMENT.md). leaked: where anything of a
// request could have gone (what was logged, stored and written).
function fakeDollar(...args: Parameters<typeof standIn>) {
  const f = standIn(...args)
  return {
    ...f,
    leaked: () => {
      const out = JSON.stringify([f.logs, f.writes, f.stored()])
      return [SECRET, SYSTEM, THREAD].filter((s) => out.includes(s))
    },
  }
}
type Fake = ReturnType<typeof fakeDollar>

/** A seed with the sent values an earlier stand-in's readings left, by Decision id (the engine-driven run never saw them). */
function carried(seed: ReturnType<typeof seedOf>, from: Fake) {
  const sent = new Map(from.log().map((d) => [d.id, d.sent]))
  const take = (ds: Decision[]): Decision[] => ds.map((d) => (sent.has(d.id) ? { ...d, sent: sent.get(d.id)! } : d))
  return { state: { ...seed.state, recent: take((seed.state.recent ?? []) as Decision[]) }, store: { log: take(seed.store.log) } }
}

type Open = { turnId: string; index: number; model?: string; agentId?: string }

/** The engine sending model requests while `open` steps are open (main loop's or agents'), each read by flows/readout.ts's readout. */
async function sendIn(f: Fake, open: Open[], bodies: unknown[], url = MESSAGES): Promise<void> {
  const closers = open.map((s) => openStep({ ...s, model: s.model ?? OPUS }))
  try {
    for (const b of bodies) await readout(f.$, { url, init: init(b) as never }, 'engine')
  } finally {
    for (const close of closers.reverse()) close()
  }
}

const OPEN: OpenStep = { turnId: 't1', index: 0, model: OPUS, matched: false }
/** classify on a request the engine sent to the Messages endpoint during the open step, unless `o` says otherwise. */
const read = (b: unknown, o: Partial<{ originPlugin: string | undefined; url: string; open: OpenStep | null; agentStepsOpen: number }> = {}) =>
  classify({ originPlugin: 'engine', url: MESSAGES, body: b, open: OPEN, agentStepsOpen: 0, ...o })

// The brief's eight.

test('classify：主循环的请求读出顶层的档位', () => {
  const b = JSON.stringify({ model: OPUS, thread: {}, output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'hi' }] })
  expect(read(b)).toEqual({ kind: 'main', effort: 'high' })
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) expect(read(body({ effort: level }))).toEqual({ kind: 'main', effort: level })
  // The endpoint with or without the beta query, and on a host the engine is pointed at (a gateway).
  expect(read(b, { url: 'https://api.anthropic.com/v1/messages' })).toEqual({ kind: 'main', effort: 'high' })
  expect(read(b, { url: 'https://gateway.example.com/anthropic/v1/messages?beta=true' })).toEqual({ kind: 'main', effort: 'high' })
  // Only the level leaves: the rest of output_config stays behind.
  expect(read(body({ extra: { output_config: { effort: 'low', format: { type: 'json_schema' } } } }))).toEqual({ kind: 'main', effort: 'low' })
})

test('classify：没有 thread 的旁路请求、别的插件发的请求、别的地址：ignore', () => {
  const main = body({ effort: 'high' })
  expect(read(main)).toEqual({ kind: 'main', effort: 'high' })
  // A side request (a title, a suggestion, $.model.fork) carries no thread.
  expect(read(body({ effort: 'high', thread: false }))).toEqual({ kind: 'ignore' })
  // A request another plugin, or this one, sends through $.http.fetch.
  for (const originPlugin of ['dispatch-pilot', 'other-mod', 'client', undefined]) expect(read(main, { originPlugin })).toEqual({ kind: 'ignore' })
  // Other addresses: count_tokens and batches under /v1/messages, other endpoints, a URL that does not parse.
  for (const url of [
    'https://api.anthropic.com/v1/messages/count_tokens?beta=true',
    'https://api.anthropic.com/v1/messages/batches',
    'https://api.anthropic.com/v1/complete',
    'https://api.drex.example/v1/answer',
    'not a url',
  ])
    expect(read(main, { url })).toEqual({ kind: 'ignore' })
  // A side request is ignored whatever steps are open.
  expect(read(body({ thread: false }), { open: null, agentStepsOpen: 2 })).toEqual({ kind: 'ignore' })
})

test('classify：只有消息里带 output_config、顶层没有：effort 为 null', () => {
  const inner = JSON.stringify({ model: OPUS, thread: {}, messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }], output_config: { effort: 'xhigh' } }] })
  expect(read(inner)).toEqual({ kind: 'main', effort: null })
  // A level the five do not name, a number, or an output_config that is no object: no level either.
  for (const output_config of [{ effort: 'turbo' }, { effort: 31999 }, { effort: null }, 'high', null, {}]) {
    expect(read(body({ extra: { output_config } }))).toEqual({ kind: 'main', effort: null })
  }
  // The top level is read, whatever a message carries.
  expect(read(body({ effort: 'low', extra: { messages: [{ role: 'user', content: 'x', output_config: { effort: 'max' } }] } }))).toEqual({ kind: 'main', effort: 'low' })
})

test('classify：请求体不是文本或不是 JSON：ignore，不抛错', () => {
  for (const b of [undefined, null, 42, { base64: 'UFJJVkFURS03ZjNh' }, '', '{"model": "claude-opus-5-5", "thread"', 'null', '"thread"', '[{"thread": {}}]', '42', 'true']) {
    expect(read(b)).toEqual({ kind: 'ignore' })
  }
})

test('classify：同模型的 agent 步同时开着，或这一步已经配过请求：unsure', () => {
  const main = body({ effort: 'high' })
  // An agent step open on the main step's model: its request cannot be told from the main loop's.
  expect(read(main, { agentStepsOpen: 1 })).toEqual({ kind: 'unsure' })
  // The step's request was read already (a retry, or another request on the same thread).
  expect(read(main, { open: { ...OPEN, matched: true } })).toEqual({ kind: 'unsure' })
  // A model the step does not name, or none.
  expect(read(body({ model: HAIKU, effort: 'high' }))).toEqual({ kind: 'unsure' })
  expect(read(JSON.stringify({ thread: {}, output_config: { effort: 'high' } }))).toEqual({ kind: 'unsure' })
  // No main step open: between steps (an agent's request, a side request), or lost to a hot reload.
  // No main-loop step open: nothing can be written, so the body is not parsed at all (final review G7).
  expect(read(main, { open: null })).toEqual({ kind: 'ignore' })
  // The same request with none of these is the main loop's.
  expect(read(main, { agentStepsOpen: 0, open: OPEN })).toEqual({ kind: 'main', effort: 'high' })
})

test('模型名只差末尾一个方括号后缀（[1m]）时算同一个；别的不同都认不准', () => {
  expect(modelBase('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
  expect(modelBase('claude-opus-5-5')).toBe('claude-opus-5-5')
  // One suffix, at the end only.
  expect(modelBase('claude-opus-5-5[1m][2m]')).toBe('claude-opus-5-5[1m]')
  expect(modelBase('opus[1m]-x')).toBe('opus[1m]-x')
  const main = { kind: 'main', effort: 'high' }
  const unsure = { kind: 'unsure' }
  const pairs: [string, string, unknown][] = [
    ['claude-opus-5-5[1m]', 'claude-opus-5-5', main],
    ['claude-opus-5-5', 'claude-opus-5-5[1m]', main],
    ['claude-opus-5-5[1m]', 'claude-opus-5-5[200k]', main],
    ['claude-opus-5-5', 'claude-opus-5-1', unsure],
    ['claude-opus-5-5', 'claude-opus-5-5x', unsure],
    ['claude-opus-5-5', 'claude-opus-5-5[1m][2m]', unsure],
    ['claude-opus-5-5', 'Claude-Opus-5-5', unsure],
  ]
  for (const [step, sent, want] of pairs) {
    expect([step, sent, read(body({ model: sent, effort: 'high' }), { open: { ...OPEN, model: step } })]).toEqual([step, sent, want])
  }
})

test('请求原样放行：桩收到的 url 和 init 与发出的相同', { options: KEYS, plugins: [WATCHER, WIRE] }, async ($, on) => {
  const COUNT = 'https://api.anthropic.com/v1/messages/count_tokens?beta=true'
  const sent = [
    { url: MESSAGES, init: init(body({ effort: 'low' })) },
    { url: MESSAGES, init: init(body({ effort: 'low', thread: false })) },
    { url: COUNT, init: init(body({ effort: 'low' })) },
    { url: MESSAGES, init: init('{"model": "claude-opus-5-5", "thread"') },
    { url: MESSAGES, init: init({ base64: 'UFJJVkFURS03ZjNh' }) },
    { url: MESSAGES },
  ]
  const answered: Awaited<ReturnType<typeof viaWire>>[] = []
  const w = world(on, {
    onSubmit: turns($),
    answer: ({ url, body }) => (url === MESSAGES || url === COUNT ? STREAM : answers(SUBMIT_RAISE, HOLD)({ url, body })),
    // Sent while the main loop's step 0 is open and the message's decision waits on its check.
    onStep: async () => {
      for (const r of sent) answered.push(await viaWire($, r.url, r.init))
    },
  })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })

  // The kit's own $ has no http, and a plugin's request reaches every hook with next.origin.plugin its own name: no
  // test can send one as the engine (DEVELOPMENT.md).
  expect(($ as unknown as Record<string, unknown>).http).toBeUndefined()
  const wired = w.requests.filter((r) => r.origin !== 'dispatch-pilot')
  expect(wired.map((r) => r.origin)).toEqual(['wire', 'wire', 'wire', 'wire', 'wire', 'wire'])
  // Each reached the bottom as it was sent, and its answer came back as the bottom gave it.
  expect(wired.map(({ url, init }) => ({ url, init }))).toEqual(sent)
  expect(answered).toHaveLength(6)
  for (const a of answered) {
    expect(a).toMatchObject({ status: 200, ok: true, text: STREAM })
    // The mod's hook ran on each, and every link beneath the watcher received the same request.
    expect(a.headers['x-links']!.split(',')).toContain('dispatch-pilot')
    expect(a.headers['x-same']).toBe('true')
  }
  // Another plugin's request is never read: the message's decision still waits, and no level was written.
  const submitted = logged(w)[0]!
  expect(row(submitted)).toEqual(['submit', 'medium', 'high', true, null])
  expect(turnState(w).unverified).toEqual({ id: submitted.id, level: 'high' })
  expect(w.stateWrites.filter((s) => s.key === 'session').length).toBeGreaterThan(0)
  expect(sentLevels(w)).toEqual([])
  expect(w.debugLogs).toEqual([])
  expect(leakedIn(w)).toEqual([])

  // The engine's request, read directly: the request object comes out of readout as it went in.
  const f = fakeDollar(seedOf(w))
  const e = { url: MESSAGES, init: init(body({ effort: 'high' })) }
  const before = JSON.stringify(e)
  const close = openStep({ turnId: 't1', index: 0, model: OPUS })
  try {
    await readout(f.$, Object.freeze({ ...e, init: Object.freeze({ ...e.init, headers: Object.freeze({ ...e.init.headers }) }) }) as never, 'engine')
  } finally {
    close()
  }
  expect(JSON.stringify(e)).toBe(before)
  expect(f.logs).toEqual([])
  expect(f.lastSents()).toEqual(['high'])
  expect(f.leaked()).toEqual([])
})

test('换挡之后的那条决策记录带上实际发出的档位；不一致时是 not-sent', { options: NO_NOTE }, async ($, on) => {
  // Another session's entry in the machine's log: an amendment finds its entry by id and leaves the rest alone.
  const other = { id: 'other-1', at: 1, kind: 'submit', backend: 'drex', model: 'drex-max-v1.1', ms: 5, raw: null, from: 'low', to: 'high', reason: 'more-open', detail: '', turnId: 'x1', step: 0, bars: null, failure: null, requestId: null, applied: true, sent: null }
  const w = world(on, {
    store: { log: [other] },
    onSubmit: turns($),
    answer: answers(SUBMIT_HOLD, (s) => (s.current_level === 'medium' ? SAME_FAILURE : s.steps_so_far >= 4 ? CAUSE_FOUND : HOLD)),
  })
  await begin($)
  await appendAll($, scriptByPoll(1, 'rerun the upload test', 'FAIL test_upload'))
  const up = midruns(w)[0]!
  expect(row(up)).toEqual(['midrun', 'medium', 'high', true, null])
  expect(turnState(w).unverified).toEqual({ id: up.id, level: 'high' })

  // Step 1's request carries high: the shift's Decision gets it, in the log and in recent.
  const a = fakeDollar(seedOf(w))
  await sendIn(a, [{ turnId: 't1', index: 1 }], [body({ effort: 'high' })])
  expect(a.log()[0]).toEqual(other)
  expect(a.log().slice(1).map(row)).toEqual([
    ['submit', 'medium', 'medium', true, null],
    ['midrun', 'medium', 'high', true, 'high'],
  ])
  expect(a.recent()).toEqual(a.log().slice(1))
  expect(a.session().lastSent).toBe('high')
  expect(a.turn()!.unverified).toBe(null)
  expect(a.leaked()).toEqual([])

  // Three steps on, a shift down to medium; step 4's request still carries high.
  for (let n = 1; n <= 4; n++) {
    await stepT1($, n)
    if (n < 4) await appendAll($, scriptByPoll(n + 1, `script ${n + 1}`, `result ${n + 1}`))
  }
  expect(efforts(w)).toEqual(['medium', 'high', 'high', 'high', 'medium'])
  // The results of steps 2 and 3 come within the gap since the shift: not asked (final review G6).
  const down = midruns(w)[1]!
  expect(midruns(w).map(row)).toEqual([
    ['midrun', 'medium', 'high', true, null],
    ['midrun', 'high', 'medium', true, null],
  ])
  // The newer shift took the place of the older one's check; holds are never checked.
  expect(turnState(w).unverified).toEqual({ id: down.id, level: 'medium' })
  const b = fakeDollar(seedOf(w))
  await sendIn(b, [{ turnId: 't1', index: 4 }], [body({ effort: 'high' })])
  expect(b.log().find((d) => d.id === down.id)!.sent).toBe('not-sent')
  expect(b.recent().find((d) => d.id === down.id)!.sent).toBe('not-sent')
  expect(b.log().filter((d) => d.id !== down.id).map((d) => d.sent)).toEqual([null, null, null])
  expect(b.session().lastSent).toBe('high')
  expect(b.leaked()).toEqual([])
})

test('verifyEffort 关着：记录里 sent 为 null，/dp 标未核对', { options: { ...NO_NOTE, verifyEffort: false }, plugins: [WATCHER, WIRE] }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, SAME_FAILURE) })
  await begin($)
  await appendAll($, scriptByPoll(1, 'rerun the upload test', 'FAIL test_upload'))
  await stepT1($, 1)

  expect(efforts(w)).toEqual(['medium', 'high'])
  expect(logged(w).map(row)).toEqual([
    ['submit', 'medium', 'medium', true, null],
    ['midrun', 'medium', 'high', true, null],
  ])
  expect(recent(w).map((d) => d.sent)).toEqual([null, null])
  // No Decision waits on a check, and no level is ever written as sent.
  expect(checks(w).length).toBeGreaterThan(0)
  expect(checks(w).filter((c) => c !== null)).toEqual([])
  expect(sentLevels(w)).toEqual([])
  // The mod registers no http.fetch hook: beneath the watcher run only the test's own and the engine's.
  const r = await viaWire($, MESSAGES, init(body({ effort: 'high' })))
  expect(r).toMatchObject({ status: 200, text: STREAM })
  expect(r.headers['x-links']!.length).toBeGreaterThan(0)
  expect(r.headers['x-links']!.split(',')).not.toContain('dispatch-pilot')

  const text = await dp($)
  expect(text).toContain('档位：high（mod 要的，未核对）')
  expect(text).toContain('发消息 medium 不变 · Drex 0 ms · 未核对')
  expect(text).toContain('中途 medium → high · same-failure · Drex 0 ms · 未核对')
})

// What the eight do not reach.

test('排着的说明：放上行之前读到的请求不核对它，放上之后的第一次请求才核对', { options: NO_NOTE }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, (s) => (s.current_level === 'medium' ? SAME_FAILURE : HOLD)) })
  await begin($)
  const submitted = logged(w)[0]!
  await appendAll($, scriptByDelivery(1, 'run the upload test', 'FAIL test_upload'))
  const shift = midruns(w)[0]!
  expect(row(shift)).toEqual(['midrun', 'medium', 'high', true, null])
  // Judged on a delivery row: the note is queued, its check waits beside it, and the turn still waits on the message's.
  expect(turnState(w)).toMatchObject({
    wanted: 'high',
    pendingNote: NOTE_HIGH,
    unverified: { id: submitted.id, level: 'medium' },
    queuedCheck: { id: shift.id, level: 'high', note: NOTE_HIGH },
  })

  // Step 1's request goes before the note is on a row, still at medium (E13): it checks the message's Decision.
  await stepT1($, 1)
  const a = fakeDollar(seedOf(w))
  await sendIn(a, [{ turnId: 't1', index: 1 }], [body({ effort: 'medium' })])
  expect(a.log().map(row)).toEqual([
    ['submit', 'medium', 'medium', true, 'medium'],
    ['midrun', 'medium', 'high', true, null],
  ])
  expect(a.recent().map((d) => d.sent)).toEqual(['medium', null])
  expect(a.turn()).toMatchObject({ unverified: null, queuedCheck: { id: shift.id, level: 'high', note: NOTE_HIGH } })
  expect(a.session().lastSent).toBe('medium')

  // The next receipt carries the note: from the next request on, the shift's level is checked.
  const second = scriptByPoll(2, 'fix the retry and rerun', '3 passed')
  await appendAll($, second)
  const receipt = second.find((r) => r.door === 'tool-result' && r.origin.kind === 'tool' && r.origin.tool === 'REPL')!
  expect(reached(w, receipt)!.message.content.at(-1)).toEqual({ type: 'text', text: NOTE_HIGH })
  expect(turnState(w)).toMatchObject({ pendingNote: null, unverified: { id: shift.id, level: 'high' }, queuedCheck: null })

  await stepT1($, 2)
  const b = fakeDollar(seedOf(w))
  await sendIn(b, [{ turnId: 't1', index: 2 }], [body({ effort: 'high' })])
  // The second script's result came within the gap since the shift: not asked (final review G6).
  expect(b.log().map(row)).toEqual([
    ['submit', 'medium', 'medium', true, null],
    ['midrun', 'medium', 'high', true, 'high'],
  ])
  expect(b.recent()).toEqual(b.log())
  expect(b.turn()!.unverified).toBe(null)
  expect(efforts(w)).toEqual(['medium', 'high', 'high'])
})

test('排着的换挡不占待核对的位置：前一条留着 unverified，说明放上行之前的主循环请求给它记实际档位；放上之后才核对排着的那条', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, (s) => (s.current_level === 'medium' ? SAME_FAILURE : s.steps_so_far >= 4 ? CAUSE_FOUND : HOLD)) })
  await begin($)
  await appendAll($, scriptByPoll(1, 'rerun the upload test', 'FAIL test_upload'))
  const up = midruns(w)[0]!
  expect(turnState(w).unverified).toEqual({ id: up.id, level: 'high' })
  // Step 1: an unsure reading in the open step (another model) leaves the shift up unverified, its check kept.
  const a = fakeDollar(seedOf(w))
  await sendIn(a, [{ turnId: 't1', index: 1 }], [body({ model: HAIKU, effort: 'high' })])
  expect(a.log().find((d) => d.id === up.id)!.sent).toBe('unverified')
  expect(a.turn()!.unverified).toEqual({ id: up.id, level: 'high' })

  // Three steps on, a shift down to medium is judged on a delivery row: its note is queued, and so is its check.
  for (let n = 1; n <= 3; n++) {
    await stepT1($, n)
    await appendAll($, n < 3 ? scriptByPoll(n + 1, `script ${n + 1}`, `result ${n + 1}`) : scriptByDelivery(4, 'run the suite', '2 failed'))
  }
  // Steps 2 and 3 come within the gap since the shift and are not asked; step 4's delivery is (final review G6).
  const down = midruns(w)[1]!
  expect(row(down)).toEqual(['midrun', 'high', 'medium', true, null])
  expect(turnState(w)).toMatchObject({ pendingNote: NOTE_MEDIUM, unverified: { id: up.id, level: 'high' }, queuedCheck: { id: down.id, level: 'medium', note: NOTE_MEDIUM } })

  // Step 4's request goes before the note is on a row, at high: it checks the shift up, not the queued one.
  await stepT1($, 4)
  const b = fakeDollar(carried(seedOf(w), a))
  expect(b.log().find((d) => d.id === up.id)!.sent).toBe('unverified')
  await sendIn(b, [{ turnId: 't1', index: 4 }], [body({ effort: 'high' })])
  expect(b.log().filter((d) => d.kind === 'midrun').map((d) => [d.id === up.id ? 'up' : d.id === down.id ? 'down' : 'hold', d.sent])).toEqual([
    ['up', 'high'],
    ['down', null],
  ])
  expect(b.recent().find((d) => d.id === up.id)!.sent).toBe('high')
  expect(b.turn()).toMatchObject({ unverified: null, queuedCheck: { id: down.id, level: 'medium', note: NOTE_MEDIUM } })

  // The next receipt carries the note: the queued shift's check is the turn's now, and the next request settles it.
  await appendAll($, scriptByPoll(5, 'rerun the suite', '2 failed'))
  expect(turnState(w)).toMatchObject({ pendingNote: null, unverified: { id: down.id, level: 'medium' }, queuedCheck: null })
  await stepT1($, 5)
  const c = fakeDollar(seedOf(w))
  await sendIn(c, [{ turnId: 't1', index: 5 }], [body({ effort: 'medium' })])
  expect(c.log().find((d) => d.id === down.id)!.sent).toBe('medium')
  expect(c.recent().find((d) => d.id === down.id)!.sent).toBe('medium')
  expect(c.turn()!.unverified).toBe(null)
})

test('发消息时定的档：由第 0 步的请求核对；引擎发出的不是它时记 not-sent', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_RAISE, HOLD) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  const decided = logged(w)[0]!
  expect(row(decided)).toEqual(['submit', 'medium', 'high', true, null])
  // Set at step 0, before the step's request goes.
  expect(turnState(w).unverified).toEqual({ id: decided.id, level: 'high' })
  expect(efforts(w)).toEqual(['high'])

  const sent = fakeDollar(seedOf(w))
  await sendIn(sent, [{ turnId: 't1', index: 0 }], [body({ effort: 'high' })])
  expect(sent.log().map(row)).toEqual([['submit', 'medium', 'high', true, 'high']])
  expect(sent.recent().map(row)).toEqual([['submit', 'medium', 'high', true, 'high']])
  expect(sent.session().lastSent).toBe('high')

  const kept = fakeDollar(seedOf(w))
  await sendIn(kept, [{ turnId: 't1', index: 0 }], [body({ effort: 'medium' })])
  expect(kept.log().map(row)).toEqual([['submit', 'medium', 'high', true, 'not-sent']])
  expect(kept.recent().map(row)).toEqual([['submit', 'medium', 'high', true, 'not-sent']])
  expect(kept.session().lastSent).toBe('medium')
  // A request that carries no level at all did not carry the one decided either.
  const none = fakeDollar(seedOf(w))
  await sendIn(none, [{ turnId: 't1', index: 0 }], [body()])
  expect(none.log()[0]!.sent).toBe('not-sent')
})

test('主循环步开着时认不准（模型不同、同模型的 agent 步开着）：记 unverified，留着待核对；之后的主循环请求换成实际档位', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_RAISE, HOLD) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  const waiting = turnState(w).unverified
  const id = logged(w)[0]!.id
  expect(waiting).toEqual({ id, level: 'high' })
  const cases: [string, Open[], string][] = [
    ['the request names another model than the step', [{ turnId: 't1', index: 0 }], HAIKU],
    ['an agent step open on the same model', [{ turnId: 'a1', index: 0, agentId: 'agent-x' }, { turnId: 't1', index: 0 }], OPUS],
    ['an agent step open on the same model, with a bracket suffix', [{ turnId: 'a1', index: 0, agentId: 'agent-x', model: `${OPUS}[1m]` }, { turnId: 't1', index: 0 }], OPUS],
  ]
  for (const [what, open, model] of cases) {
    const f = fakeDollar(seedOf(w))
    await sendIn(f, open, [body({ model, effort: 'high' })])
    expect([what, f.log().map((d) => [d.id, d.sent])]).toEqual([what, [[id, 'unverified']]])
    expect([what, f.recent().map((d) => d.sent)]).toEqual([what, ['unverified']])
    // The check stays: a clean reading may still come.
    expect([what, f.turn()!.unverified]).toEqual([what, waiting])
    expect([what, f.lastSents()]).toEqual([what, []])
    // The main loop's next request replaces it with the level it carried, and the check is done.
    await sendIn(f, [{ turnId: 't1', index: 1 }], [body({ effort: 'high' })])
    expect([what, f.log().map((d) => [d.id, d.sent])]).toEqual([what, [[id, 'high']]])
    expect([what, f.recent().map((d) => d.sent)]).toEqual([what, ['high']])
    expect([what, f.turn()!.unverified]).toEqual([what, null])
    expect([what, f.lastSents()]).toEqual([what, ['high']])
  }
  // An agent step open on another model: the request with the step's model is the main loop's at once.
  const f = fakeDollar(seedOf(w))
  await sendIn(f, [{ turnId: 'a1', index: 0, agentId: 'agent-y', model: HAIKU }, { turnId: 't1', index: 0 }], [body({ effort: 'high' })])
  expect(f.log().map((d) => [d.id, d.sent])).toEqual([[id, 'high']])
  expect(f.lastSents()).toEqual(['high'])
})

test('主循环步开着时认不准，之后再没有干净的读数：留下 unverified', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_RAISE, HOLD) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  const id = logged(w)[0]!.id
  const f = fakeDollar(seedOf(w))
  await sendIn(f, [{ turnId: 't1', index: 0 }], [body({ model: HAIKU, effort: 'high' }), body({ model: HAIKU, effort: 'low' })])
  expect(f.log().map((d) => [d.id, d.sent])).toEqual([[id, 'unverified']])
  // The second unsure reading of the step changes nothing: one write of recent and one of the log.
  expect(f.writes.filter((x) => x.key === 'recent')).toHaveLength(1)
  // Requests between steps do nothing to it.
  const before = f.writes.length
  await sendIn(f, [], [body({ effort: 'high' })])
  await sendIn(f, [{ turnId: 'a1', index: 0, agentId: 'agent-x', model: HAIKU }], [body({ model: HAIKU, effort: 'low' })])
  expect(f.writes).toHaveLength(before)
  expect(f.log().map((d) => [d.id, d.sent])).toEqual([[id, 'unverified']])
  expect(f.recent().map((d) => d.sent)).toEqual(['unverified'])
  expect(f.lastSents()).toEqual([])
})

test('没有开着的主循环步时认不准（agent 的请求、旁路请求）：待核对的不动，什么都不写', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_RAISE, HOLD) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  const waiting = turnState(w).unverified
  const f = fakeDollar(seedOf(w))
  // Between steps (what a hot reload also leaves): the same model and level as the main loop's, an agent's on its own model.
  await sendIn(f, [], [body({ effort: 'high' }), body({ effort: 'low' })])
  await sendIn(f, [{ turnId: 'a1', index: 0, agentId: 'agent-x', model: HAIKU }], [body({ model: HAIKU, effort: 'medium' })])
  expect(f.writes).toEqual([])
  expect(f.log().map((d) => d.sent)).toEqual([null])
  expect(f.turn()!.unverified).toEqual(waiting)
  // The step's own request is read as usual afterwards.
  await sendIn(f, [{ turnId: 't1', index: 0 }], [body({ effort: 'high' })])
  expect(f.log().map((d) => d.sent)).toEqual(['high'])
})

test('Code Mode：说明放在回执行上，脚本里 agent 的请求先到（没有开着的主循环步），主循环下一次请求才核对：记实际档位', { options: NO_NOTE }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, (s) => (s.current_level === 'medium' ? SAME_FAILURE : HOLD)) })
  await begin($)
  await appendAll($, scriptByDelivery(1, 'run the upload test', 'FAIL test_upload'))
  await stepT1($, 1)
  // The next script's receipt carries the queued note; the script then runs, with no main-loop step open.
  const second = scriptByPoll(2, 'spawn a reader and rerun', '3 passed')
  await appendAll($, second)
  const shift = midruns(w)[0]!
  const receipt = second.find((r) => r.door === 'tool-result' && r.origin.kind === 'tool' && r.origin.tool === 'REPL')!
  expect(reached(w, receipt)!.message.content.at(-1)).toEqual({ type: 'text', text: NOTE_HIGH })
  expect(turnState(w).unverified).toEqual({ id: shift.id, level: 'high' })

  const f = fakeDollar(seedOf(w))
  // Agents the script started: one on haiku, one on the main loop's own model; both carry a thread.
  await sendIn(f, [{ turnId: 'a1', index: 0, agentId: 'agent-1', model: HAIKU }], [body({ model: HAIKU, effort: 'medium' })])
  await sendIn(f, [{ turnId: 'a2', index: 0, agentId: 'agent-2', model: OPUS }], [body({ model: OPUS, effort: 'low' })])
  expect(f.writes).toEqual([])
  expect(f.turn()!.unverified).toEqual({ id: shift.id, level: 'high' })
  // The main loop's next step: its request carries high.
  await sendIn(f, [{ turnId: 't1', index: 2 }], [body({ effort: 'high' })])
  // The second script's result came within the gap since the shift: not asked (final review G6).
  expect(f.log().map(row)).toEqual([
    ['submit', 'medium', 'medium', true, null],
    ['midrun', 'medium', 'high', true, 'high'],
  ])
  expect(f.recent()).toEqual(f.log())
  expect(f.turn()!.unverified).toBe(null)
  expect(f.lastSents()).toEqual(['high'])
})

test('同一步的第二次请求：不覆盖当前档位，也不改已经核对过的记录', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_RAISE, HOLD) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  const f = fakeDollar(seedOf(w))
  await sendIn(f, [{ turnId: 't1', index: 0 }], [body({ effort: 'high' }), body({ effort: 'low' })])
  expect(f.log().map(row)).toEqual([['submit', 'medium', 'high', true, 'high']])
  expect(f.recent().map((d) => d.sent)).toEqual(['high'])
  expect(f.lastSents()).toEqual(['high'])
  // The next step's first request is read again.
  await sendIn(f, [{ turnId: 't1', index: 1 }], [body({ effort: 'low' })])
  expect(f.lastSents()).toEqual(['high', 'low'])
  expect(f.log()[0]!.sent).toBe('high')
})

/** A row of $.agent.list() for one agent, with its last request when given. */
function info(id: string, lastRequest?: { at: number; model: string; effort?: string }) {
  return {
    id,
    description: 'Find the retry',
    type: 'general-purpose',
    status: 'running',
    kind: 'local_agent',
    taskStatus: 'running',
    label: 'Find the retry',
    startTime: 0,
    cwd: '/work',
    model: HAIKU,
    tokenCount: 0,
    tokenSamples: [],
    ...(lastRequest === undefined ? {} : { lastRequest }),
  }
}

const agentStep = ($: Engine, agentId: string, index: number) => step($, { turnId: `a-${agentId}`, index, effort: 'high', model: HAIKU, agentId })

test('agent：第二步开始时读 $.agent.list() 的 lastRequest；只有一步的在 turn.complete 读；读不到记 unverified', { options: KEYS }, async ($, on) => {
  const w = world(on, {
    answer: () => drexOk(LOOKUP),
    agents: [info('agent-1', { at: 0, model: HAIKU, effort: 'medium' }), info('agent-2', { at: 0, model: HAIKU, effort: 'high' }), info('agent-3')],
  })
  await start($)
  await turnStart($, 't1', TASK)
  await step($, { turnId: 't1', index: 0, effort: 'high' })
  for (const id of ['toolu_1', 'toolu_2', 'toolu_3']) await spawn($, { tool_use_id: id })
  // The first of the type is given no model (design 5.5: whether it follows the parent's is not known yet).
  expect(logged(w).map((d) => [d.kind, d.to, d.applied, d.sent])).toEqual([
    ['agent', 'inherit · medium', true, null],
    ['agent', 'haiku · medium', true, null],
    ['agent', 'haiku · medium', true, null],
  ])
  const ids = logged(w).map((d) => d.id)

  // agent-1: its first step asks whether its effort is its own (Task 9); its second reads what the first carried.
  await agentStep($, 'agent-1', 0)
  expect(w.listed.calls).toBe(1)
  expect(logged(w)[0]!.sent).toBe(null)
  await agentStep($, 'agent-1', 1)
  expect(w.listed.calls).toBe(2)
  expect(logged(w)[0]!.sent).toBe('medium')
  // Once: the third step reads nothing.
  await agentStep($, 'agent-1', 2)
  expect(w.listed.calls).toBe(2)

  // agent-2 takes one step and ends: read at its turn.complete. Its request carried high, not the medium decided.
  await agentStep($, 'agent-2', 0)
  expect(w.listed.calls).toBe(3)
  await complete($, 'a-agent-2', { agentId: 'agent-2' })
  expect(w.listed.calls).toBe(4)

  // agent-3's row has no lastRequest.
  await agentStep($, 'agent-3', 0)
  await agentStep($, 'agent-3', 1)
  expect(w.listed.calls).toBe(6)

  expect(efforts(w)).toEqual(['high', 'medium', 'medium', 'medium', 'medium', 'medium', 'medium'])
  const d = logged(w)
  expect(d.map((x) => [x.id, x.sent])).toEqual([
    [ids[0], 'medium'],
    [ids[1], 'not-sent'],
    [ids[2], 'unverified'],
  ])
  expect(recent(w)).toEqual(d)
  const text = await dp($)
  expect(text).toContain('agent（general-purpose · 模型没动：还不知道这个类型是否沿用主 agent 的模型） ? · high → inherit · medium · mechanical · Drex 0 ms · 实际 medium')
  expect(text).toContain('agent（general-purpose） opus · high → haiku · medium · mechanical · Drex 0 ms · 未发出')
  expect(text).toContain('agent（general-purpose） opus · high → haiku · medium · mechanical · Drex 0 ms · 未核对')
})

test('agent 的核对不拖住它的第二步：$.agent.list() 晚回来时，这一步已经到了引擎', { options: KEYS }, async ($, on) => {
  const w = world(on, {
    answer: () => drexOk(LOOKUP),
    agents: [info('agent-1', { at: 0, model: HAIKU, effort: 'medium' })],
    // The first call (whether the effort is the agent's own) answers at once; the readout's comes 500 ms late.
    listDelay: (call) => (call === 2 ? 500 : 0),
  })
  await start($)
  await turnStart($, 't1', TASK)
  await step($, { turnId: 't1', index: 0, effort: 'high' })
  await spawn($)
  await agentStep($, 'agent-1', 0)
  expect(w.listed.calls).toBe(1)

  const second = agentStep($, 'agent-1', 1)
  await w.clock.settle()
  // The second step reached the engine at the decided level while the readout's list call is still out.
  expect(w.stepsSent.filter((s) => s.agentId === 'agent-1').map((s) => [s.index, s.effort])).toEqual([
    [0, 'medium'],
    [1, 'medium'],
  ])
  expect(w.listed.calls).toBe(2)
  expect(logged(w)[0]!.sent).toBe(null)
  await w.clock.advance(500)
  await second
  expect(logged(w)[0]!.sent).toBe('medium')
  expect(recent(w)[0]!.sent).toBe('medium')
})

test('enabled 关着（verifyEffort 开着）：读数什么都不做：hook 不在链上，不写当前档位，没有状态和记录的写入', { options: { ...KEYS, enabled: false }, plugins: [WATCHER, WIRE] }, async ($, on) => {
  const during: { state: number; store: number; links: string }[] = []
  const w = world(on, {
    // A request sent while the main loop's step is open, as the engine sends the step's own.
    onStep: async () => {
      const s0 = w.stateWrites.length
      const t0 = w.storeWrites.length
      const r = await viaWire($, MESSAGES, init(body({ effort: 'high' })))
      during.push({ state: w.stateWrites.length - s0, store: w.storeWrites.length - t0, links: r.headers['x-links'] ?? '' })
    },
  })
  await start($)
  await turnStart($, 't1', TASK)
  await step($, { turnId: 't1', index: 0, effort: 'high' })

  expect(w.stepsSent.map((s) => s.effort)).toEqual(['high'])
  expect(during).toHaveLength(1)
  expect(during[0]!.links.length).toBeGreaterThan(0)
  expect(during[0]!.links.split(',')).not.toContain('dispatch-pilot')
  expect([during[0]!.state, during[0]!.store]).toEqual([0, 0])
  // The switch off writes no state at all, on steps or anywhere (final review G4).
  expect(w.stateWrites).toEqual([])
  expect(sentLevels(w)).toEqual([])
  expect(w.storeWrites).toEqual([])
})

test('读数的两处写各自出错：当前档位写不进去时照样核对，记录写不进去时当前档位照写；readout 不抛，请求的内容哪里都没去', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_RAISE, HOLD) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  const id = logged(w)[0]!.id
  /** Throws the first time `hit` matches, and never again. */
  const once = <A extends unknown[]>(hit: (...a: A) => boolean) => {
    const left = { n: 1 }
    return (...a: A) => (hit(...a) && left.n-- > 0)
  }

  // The session's current level throws once: the Decision is checked all the same, in both copies.
  const f = fakeDollar(seedOf(w), { refuse: once((key: string, value: unknown) => key === 'session' && (value as SessionState).lastSent !== null) })
  const e = { url: MESSAGES, init: init(body({ effort: 'high' })) }
  const close = openStep({ turnId: 't1', index: 0, model: OPUS })
  let settled: unknown = 'not settled'
  try {
    settled = await readout(f.$, e as never, 'engine')
  } finally {
    close()
  }
  expect(settled).toBe(null)
  expect(e).toEqual({ url: MESSAGES, init: init(body({ effort: 'high' })) })
  expect(f.logs).toHaveLength(1)
  expect(f.logs[0]).toContain('http.fetch failed open')
  expect(f.logs[0]).toContain('refused by the test')
  expect(f.lastSents()).toEqual([])
  expect(f.log().map((d) => [d.id, d.sent])).toEqual([[id, 'high']])
  expect(f.recent().map((d) => d.sent)).toEqual(['high'])
  expect(f.turn()!.unverified).toBe(null)
  expect(f.leaked()).toEqual([])

  // $.store's log throws once: the level and recent are written all the same.
  const g = fakeDollar(seedOf(w), { refuseStore: once((key: string) => key === 'log') })
  await sendIn(g, [{ turnId: 't1', index: 0 }], [body({ effort: 'high' })])
  expect(g.lastSents()).toEqual(['high'])
  expect(g.recent().map((d) => d.sent)).toEqual(['high'])
  expect(g.log().map((d) => [d.id, d.sent])).toEqual([[id, null]])
  expect(g.logs).toHaveLength(1)
  expect(g.logs[0]).toContain('amend failed open')
  expect(g.leaked()).toEqual([])

  // Nothing to read, nothing to throw: an ignored request returns null at once, with no write and no line.
  expect(readout(f.$, { url: MESSAGES, init: init(body({ thread: false })) } as never, 'engine')).toBe(null)
  expect(readout(f.$, e as never, 'wire')).toBe(null)
  expect(f.logs).toHaveLength(1)
})

test('没执行的决策不检查：shadow、请求失败；当前档位照读', { options: { ...NO_NOTE, mode: 'shadow' } }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_RAISE, SAME_FAILURE) })
  await begin($)
  await appendAll($, scriptByPoll(1, 'rerun the upload test', 'FAIL test_upload'))
  await stepT1($, 1)
  expect(efforts(w)).toEqual(['medium', 'medium'])
  expect(logged(w).map(row)).toEqual([
    ['submit', 'medium', 'high', false, null],
    ['midrun', 'high', 'xhigh', false, null],
  ])
  expect(turnState(w).unverified).toBe(null)
  const f = fakeDollar(seedOf(w))
  await sendIn(f, [{ turnId: 't1', index: 1 }], [body({ effort: 'medium' })])
  expect(f.log().map((d) => d.sent)).toEqual([null, null])
  expect(f.lastSents()).toEqual(['medium'])
})

test('没执行的决策不检查：请求失败时 sent 留空，当前档位照读', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: () => null })
  await begin($)
  expect(logged(w).map((d) => [d.kind, d.failure, d.applied, d.sent])).toEqual([['submit', 'network', false, null]])
  expect(turnState(w).unverified).toBe(null)
  const f = fakeDollar(seedOf(w))
  await sendIn(f, [{ turnId: 't1', index: 0 }], [body({ effort: 'medium' })])
  expect(f.log().map((d) => d.sent)).toEqual([null])
  expect(f.lastSents()).toEqual(['medium'])
})

test('一轮结束时还没核对：sent 留空，下一轮的请求只核对下一轮的', { options: NO_NOTE }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, (s) => (s.current_level === 'medium' ? SAME_FAILURE : HOLD)) })
  await begin($)
  await appendAll($, scriptByPoll(1, 'rerun the upload test', 'FAIL test_upload'))
  const shift = midruns(w)[0]!
  expect(turnState(w).unverified).toEqual({ id: shift.id, level: 'high' })
  // The turn ends with no further request: nothing waits on a check any more.
  await complete($, 't1', { answer: 'Stopped here.' })
  expect(lastOf(w, 'turn')).toBe(null)
  const ended = fakeDollar(seedOf(w))
  await sendIn(ended, [], [body({ effort: 'high' })])
  expect(ended.log().map((d) => d.sent)).toEqual([null, null])

  await submit($, 'Now the downloader')
  await step($, { turnId: 't2', index: 0, effort: 'medium' })
  const next = fakeDollar(seedOf(w))
  await sendIn(next, [{ turnId: 't2', index: 0 }], [body({ effort: 'medium' })])
  expect(next.log().map((d) => [d.kind, d.turnId, d.to, d.applied, d.sent])).toEqual([
    ['submit', 't1', 'medium', true, null],
    ['midrun', 't1', 'high', true, null],
    ['submit', 't2', 'medium', true, 'medium'],
  ])
})

test('withSent：unverified 不盖掉已经读到的档位或 not-sent；没变化时不写', () => {
  const at = (sent: Decision['sent']): Decision[] => [{ id: 'a', at: 0, kind: 'midrun', backend: null, model: null, ms: 0, raw: null, from: 'medium', to: 'high', reason: null, detail: '', turnId: 't1', step: 1, bars: null, failure: null, requestId: null, applied: true, sent }]
  expect(withSent(at(null), 'a', 'unverified')?.[0]!.sent).toBe('unverified')
  expect(withSent(at('unverified'), 'a', 'high')?.[0]!.sent).toBe('high')
  expect(withSent(at('unverified'), 'a', 'not-sent')?.[0]!.sent).toBe('not-sent')
  // A main reading that landed first is not undone by an unsure one read beside it.
  expect(withSent(at('high'), 'a', 'unverified')).toBe(null)
  expect(withSent(at('not-sent'), 'a', 'unverified')).toBe(null)
  expect(withSent(at('unverified'), 'a', 'unverified')).toBe(null)
  expect(withSent(at(null), 'other', 'high')).toBe(null)
})

test('/dp 的当前档位取最近一次主循环请求实际带的；读不到时是 mod 要的并标未核对；每条决策写出核对结果', () => {
  const cfg = readConfig(KEYS)
  const d = (over: Partial<Decision>): Decision => ({ id: 'd', at: 0, kind: 'midrun', backend: 'drex', model: 'drex-max-v1.1', ms: 12, raw: null, from: 'medium', to: 'high', reason: 'same-failure', detail: '', turnId: 't1', step: 1, bars: null, failure: null, requestId: null, applied: true, sent: null, ...over })
  const log = [d({ sent: 'high' }), d({ sent: 'not-sent' }), d({ sent: 'unverified' }), d({ sent: null }), d({ applied: false, to: 'medium', from: 'medium', reason: 'hold' })]
  const shown = renderDp({ cfg, wanted: 'high', lastSent: 'medium', lock: null, log })
  expect(shown).toContain('档位：实际发出 medium，mod 要的是 high')
  const lines = shown.split('\n').filter((l) => l.includes('中途'))
  expect(lines.map((l) => l.slice(l.indexOf('中途')))).toEqual([
    '中途 medium → high · same-failure · Drex 12 ms · 实际 high',
    '中途 medium → high · same-failure · Drex 12 ms · 未发出',
    '中途 medium → high · same-failure · Drex 12 ms · 未核对',
    '中途 medium → high · same-failure · Drex 12 ms · 未核对',
    '中途 medium 不变 · Drex 12 ms · 未执行',
  ])
  // An agent's Decision reads out whatever the mod set, the model as much as the effort (final review I2).
  const agents = renderDp({
    cfg,
    wanted: null,
    lastSent: null,
    lock: null,
    log: [
      d({ kind: 'agent', detail: 'Explore', from: 'opus · high', to: 'haiku · medium', reason: 'mechanical' }),
      d({ kind: 'agent', detail: 'Plan', from: 'fable · high', to: 'opus · —', reason: null, backend: null }),
      d({ kind: 'agent', detail: 'Plan', from: 'fable · high', to: 'opus · —', reason: null, backend: null, sent: 'unverified' }),
    ],
  })
  expect(agents.split('\n').filter((l) => l.includes('agent（')).map((l) => l.slice(l.indexOf('agent（')))).toEqual([
    'agent（Explore） opus · high → haiku · medium · mechanical · Drex 12 ms · 未核对',
    'agent（Plan） fable · high → opus · — · 未核对',
    'agent（Plan） fable · high → opus · — · 未核对',
  ])
  expect(renderDp({ cfg, wanted: 'high', lastSent: 'high', lock: null, log: [] })).toContain('档位：high（最近一次主循环请求实际带的）')
  expect(renderDp({ cfg, wanted: 'high', lastSent: null, lock: null, log: [] })).toContain('档位：high（mod 要的，未核对）')
})

// Final review I2.

test('同一模型的 agent 在跑、这一步主循环的请求认不准：状态是未核对（档位是步上的），不拿上一步的读数', { options: KEYS }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_RAISE, HOLD) })
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: 'medium' })
  const f = fakeDollar(seedOf(w))
  // Step 0's own request read clean: high, as decided.
  await sendIn(f, [{ turnId: 't1', index: 0 }], [body({ effort: 'high' })])
  const board = () => boardModel(readConfig(KEYS), { session: f.session(), turn: f.turn(), recent: f.recent(), skills: [] })
  expect([board().status, board().sent]).toEqual([{ kind: 'sent', text: '已发出' }, 'high'])
  // Step 1 opens a cell of its own (as the engine's turn.step does); an agent on the same model sends beside it.
  const t = f.turn()!
  const g = fakeDollar({
    state: { session: f.session(), recent: f.recent(), turn: { ...t, stepNo: 2, journal: { ...t.journal, workSteps: 1 }, track: [...t.track, { level: 'high', sent: null, mark: null }] } },
    store: { log: f.log() },
  })
  await sendIn(g, [{ turnId: 'a1', index: 0, agentId: 'agent-x' }, { turnId: 't1', index: 1 }], [body({ effort: 'medium' })])
  // The session's last known reading stays high; the status is this step's: not read, so unverified at the steps' level.
  expect(g.session().lastSent).toBe('high')
  const m = boardModel(readConfig(KEYS), { session: g.session(), turn: g.turn(), recent: g.recent(), skills: [] })
  expect([m.level, m.sent, m.status]).toEqual(['high', null, { kind: 'unverified', text: '未核对' }])
  expect(footerLabel(m)).toBe('dp high –')
})

test('agent 的模型也读回：mod 给了模型的，lastRequest 的模型层级不一样记 not-sent；只给了模型、读到一样的算已发出', { options: KEYS }, async ($, on) => {
  const w = world(on, {
    answer: (req) => (req.url === MESSAGES ? STREAM : drexOk('read_only' in req.body.questions ? LOOKUP : SUBMIT_HOLD)),
    agents: [
      info('agent-2', { at: 0, model: 'claude-sonnet-5-5', effort: 'medium' }),
      info('agent-3', { at: 0, model: HAIKU, effort: 'medium' }),
    ],
  })
  await start($)
  await turnStart($, 't1', TASK)
  await step($, { turnId: 't1', index: 0, effort: 'high' })
  // The first of the type teaches; the next two are given haiku at medium.
  for (const id of ['toolu_1', 'toolu_2', 'toolu_3']) await spawn($, { tool_use_id: id })
  for (const id of ['agent-2', 'agent-3']) for (const index of [0, 1]) await agentStep($, id, index)
  const d = logged(w)
  expect(d.map((x) => [x.to, x.sent])).toEqual([
    ['inherit · medium', null],
    // It ran on sonnet: the model the mod gave did not go out.
    ['haiku · medium', 'not-sent'],
    ['haiku · medium', 'medium'],
  ])
  const m = boardModel(readConfig(KEYS), { session: lastOf(w, 'session') as SessionState, turn: turnState(w), recent: recent(w), skills: [] })
  expect(m.agents.map((a) => a.reading)).toEqual(['unverified', 'not-sent', 'sent'])
})

test('只有上限改了模型的 agent（没有密钥）：模型读回一样就是已发出，不一样是 not-sent', { options: {} }, async ($, on) => {
  const FABLE = 'claude-fable-5-2'
  const w = world(on, { agents: [info('agent-2', { at: 0, model: OPUS, effort: 'high' }), info('agent-4', { at: 0, model: FABLE, effort: 'high' })] })
  await start($)
  await turnStart($, 't1', TASK)
  await step($, { turnId: 't1', index: 0, effort: 'high' })
  for (const id of ['toolu_1', 'toolu_2', 'toolu_3', 'toolu_4']) await spawn($, { tool_use_id: id, parentModel: FABLE })
  for (const id of ['agent-2', 'agent-4']) for (const index of [0, 1]) await agentStep($, id, index)
  // The first teaches and records nothing; the three after it are capped, and agent-3 takes no step to be read.
  const d = logged(w)
  expect(d.map((x) => [x.to, x.sent])).toEqual([
    ['opus · —', 'high'],
    ['opus · —', null],
    ['opus · —', 'not-sent'],
  ])
})

// Final review minors.

test('shadow：/dp 的档位是步上的（引擎自己的），不把只记录的升档写成 mod 要的（G1）', { options: { ...KEYS, mode: 'shadow', board: false } }, async ($, on) => {
  world(on, { onSubmit: turns($), answer: answers(SUBMIT_RAISE, HOLD) })
  await begin($)
  const shown = await dp($)
  expect(shown).toContain('档位：medium')
  expect(shown).not.toContain('mod 要的是 high')
  expect(shown).not.toContain('档位：high')
})

test('没有主循环的一步开着：请求体不解析，状态不读（G7）', () => {
  const body = JSON.stringify({ model: OPUS, thread: [], output_config: { effort: 'high' } })
  expect(classify({ originPlugin: 'engine', url: MESSAGES, body, open: null, agentStepsOpen: 0 })).toEqual({ kind: 'ignore' })
  // Nothing to write, so nothing read: no promise comes back.
  const f = fakeDollar({ state: {}, store: { log: [] } })
  expect(readout(f.$, { url: MESSAGES, init: init(body) } as never, 'engine')).toBe(null)
})


const CODE_TOOLS = [{ name: 'REPL', input_schema: {} }, { name: 'Poll', input_schema: {} }]
const PLAIN_TOOLS = [{ name: 'Bash', input_schema: {} }, { name: 'Read', input_schema: {} }]

test('classify：请求体的 tools 里有 REPL 是 Code Mode，没有是普通会话；没有 tools 时不说', () => {
  expect(read(body({ effort: 'high', extra: { tools: CODE_TOOLS } }))).toEqual({ kind: 'main', effort: 'high', codeMode: true })
  expect(read(body({ effort: 'high', extra: { tools: PLAIN_TOOLS } }))).toEqual({ kind: 'main', effort: 'high', codeMode: false })
  expect(read(body({ effort: 'high', extra: { tools: [] } }))).toEqual({ kind: 'main', effort: 'high', codeMode: false })
  expect('codeMode' in (read(body({ effort: 'high' })) as object)).toBe(false)
  expect('codeMode' in (read(body({ effort: 'high', extra: { tools: 'REPL' } })) as object)).toBe(false)
})

test('会话种类：第一次主循环请求的 tools 定下来；之后普通会话的请求不把 Code Mode 改回去', { options: NO_NOTE }, async ($, on) => {
  const w = world(on, { onSubmit: turns($), answer: answers(SUBMIT_HOLD, HOLD) })
  await begin($)
  expect((lastOf(w, 'session') as SessionState).codeModeKnown).toBe(false)
  const plain = fakeDollar(seedOf(w))
  await sendIn(plain, [{ turnId: 't1', index: 0 }], [body({ effort: 'medium', extra: { tools: PLAIN_TOOLS } })])
  expect([plain.session().codeMode, plain.session().codeModeKnown]).toEqual([false, true])
  const code = fakeDollar(seedOf(w))
  await sendIn(code, [{ turnId: 't1', index: 0 }], [body({ effort: 'medium', extra: { tools: CODE_TOOLS } })])
  expect([code.session().codeMode, code.session().codeModeKnown]).toEqual([true, true])
  await sendIn(code, [{ turnId: 't1', index: 1 }], [body({ effort: 'medium', extra: { tools: PLAIN_TOOLS } })])
  expect(code.session().codeMode).toBe(true)
  // A body with no tools list says nothing of the kind.
  const none = fakeDollar(seedOf(w))
  await sendIn(none, [{ turnId: 't1', index: 0 }], [body({ effort: 'medium' })])
  expect(none.session().codeModeKnown).toBe(false)
  expect([plain.leaked(), code.leaked(), none.leaked()]).toEqual([[], [], []])
})
