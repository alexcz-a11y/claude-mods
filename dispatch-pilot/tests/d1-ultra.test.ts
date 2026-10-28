// d1-ultra, Liquid's decision model (ADR 0017): its answers read by Liquid's guide, apart from Jev's and pplx's (TypeSafe's):
// a yes/no is yes above 0.8 and no below 0.2, an effort answer with a confidence below 0.5 goes one level up, and a dispatched
// agent's model is one Choice of a tier (`route`), the strongest model allowed when its confidence is below 0.5. The images
// stay with Jev whatever decides the rest; without a Liquid key nothing is sent. Pure modules first, then seam 1.

import { expect, test } from 'claude-code/testing'
import { BACKEND_DEFAULTS, readConfig, setup } from '../hooks/core/setup.ts'
import { failureLine } from '../hooks/decision/backend.ts'
import { decideDispatch, dispatchPart, readRoute, type Dispatch } from '../hooks/decision/dispatched-agent.ts'
import { traceEffort, type EffortReading } from '../hooks/decision/effort.ts'
import { LIQUID_GUIDE, TYPESAFE_GUIDE } from '../hooks/decision/guides.ts'
import { liquidBackend, LIQUID_MODEL, LIQUID_URL } from '../hooks/decision/liquid.ts'
import { decideMessage, type MessageSignals } from '../hooks/decision/message-effort.ts'
import { verdictOf } from '../hooks/decision/nouls.ts'
import type { Answer } from '../hooks/decision/system-one.ts'
import { judgeUnresolved } from '../hooks/decision/unresolved.ts'
import { jev, type Reply, type Sent, world } from './support/world.ts'

const read = (probabilities: number[], confidence: number | null): EffortReading => ({ probabilities, confidence })
const noul = (p: number): Answer => ({ type: 'noul', noul: p })
const score = (probabilities: number[], confidence = 0.9): Answer => ({ type: 'score', score: 0, probabilities: Object.fromEntries(probabilities.map((p, i) => [String(i), p])), confidence })
const route = (probabilities: Record<string, number>, confidence: number): Answer => ({ type: 'choice', choice: '', probabilities, confidence })
const QUIET: MessageSignals = { ultrathink: false, stakes: { undo: 0, live: 0, access: 0 }, causeUnknown: 0, stillFailing: 0, confirm: 0, escalate: 0, lastTurn: null, count: 0, maxAfter: 3, lock: null }
const FREE: Dispatch = { user_message: '', agent_type: 'general-purpose', description: 'Fix it', prompt: 'Fix the bug in src/a.ts.', requested_model: null }
const LIQUID = { guide: LIQUID_GUIDE }
const FABLE = { guide: LIQUID_GUIDE, models: ['haiku', 'sonnet', 'opus', 'fable'] as const }

// ---- the two guides --------------------------------------------------------------------------------

test("a yes/no on each guide's bars: TypeSafe's yes at 0.7 and no at 0.3 count; Liquid's must pass 0.8 and 0.2", () => {
  expect([0.7, 0.69, 0.3, 0.31].map((p) => verdictOf(p, TYPESAFE_GUIDE.noul))).toEqual(['yes', 'band', 'no', 'band'])
  expect([0.81, 0.8, 0.75, 0.2, 0.19].map((p) => verdictOf(p, LIQUID_GUIDE.noul))).toEqual(['yes', 'band', 'band', 'band', 'no'])
})

test("an unsure effort answer: TypeSafe's two peaks, Liquid's confidence below 0.5; each guide reads only its own rule", () => {
  // Position 1.6, high; max holds 0.4: two peaks on TypeSafe's (xhigh), a confident answer on Liquid's (high).
  const torn = read([0.6, 0, 0, 0, 0.4], 0.9)
  expect(traceEffort(torn, {}, TYPESAFE_GUIDE.scoreUnsure).effort).toBe('xhigh')
  expect(traceEffort(torn, {}, LIQUID_GUIDE.scoreUnsure).effort).toBe('high')
  const low = traceEffort(read([0, 1, 0, 0, 0], 0.49), {}, LIQUID_GUIDE.scoreUnsure)
  expect(low.effort).toBe('high')
  expect(low.steps[1]).toEqual({ rule: 'low-confidence', applied: true, level: 'high', confidence: 0.49, threshold: 0.5 })
  expect(traceEffort(read([0, 1, 0, 0, 0], 0.5), {}, LIQUID_GUIDE.scoreUnsure).effort).toBe('medium')
  expect(traceEffort(read([0, 1, 0, 0, 0], null), {}, LIQUID_GUIDE.scoreUnsure).steps[1]).toMatchObject({ applied: false, confidence: null })
  expect(traceEffort(read([0, 0, 0, 0, 1], 0.1), {}, LIQUID_GUIDE.scoreUnsure).effort).toBe('max')
})

test("a message's floors at Liquid's bars: 0.75 is a yes on TypeSafe's and the band on Liquid's", () => {
  const base = read([0, 1, 0, 0, 0], 0.9)
  const stakes = { ...QUIET, stakes: { undo: 0.75, live: 0, access: 0 } }
  expect(decideMessage(base, stakes).effort).toBe('xhigh')
  expect(decideMessage(base, stakes, LIQUID_GUIDE).effort).toBe('high')
  expect(decideMessage(base, { ...QUIET, stakes: { undo: 0.85, live: 0.9, access: 0 } }, LIQUID_GUIDE).effort).toBe('max')
  expect(decideMessage(base, { ...QUIET, causeUnknown: 0.81 }, LIQUID_GUIDE).effort).toBe('xhigh')
  expect(decideMessage(base, { ...QUIET, causeUnknown: 0.5 }, LIQUID_GUIDE).effort).toBe('high')
  // R4 and R5 read still_failing at the same bars.
  expect(decideMessage(base, { ...QUIET, stillFailing: 0.78, lastTurn: { effort: 'high', stuck: true } }, LIQUID_GUIDE).effort).toBe('medium')
  expect(decideMessage(base, { ...QUIET, stillFailing: 0.9, lastTurn: { effort: 'high', stuck: true } }, LIQUID_GUIDE).effort).toBe('xhigh')
  expect(decideMessage(base, { ...QUIET, stillFailing: 0.9, count: 3 }, LIQUID_GUIDE).effort).toBe('max')
  const step = decideMessage(base, stakes, LIQUID_GUIDE).steps.find((one) => one.rule === 'stakes')
  expect(step).toMatchObject({ undoVerdict: 'band', yes: 0.8, no: 0.2, inclusive: false })
})

test("the unresolved count at Liquid's bars: 0.8 is no yes, and the record keeps the bars", () => {
  const at = (still: number, solved: number) => judgeUnresolved({ probabilities: { still_failing: still, solved, new_task: 0 } }, LIQUID_GUIDE.noul)
  expect(at(0.8, 0).change).toBe('keep')
  expect(at(0.85, 0).change).toBe('add')
  expect(at(0.1, 0.81)).toMatchObject({ change: 'reset', thresholds: { yes: 0.8, no: 0.2, inclusive: false } })
})

// ---- the route -------------------------------------------------------------------------------------

test("d1-ultra's request about an agent: the route and the Nouls the effort's floors read, no table; frontier only with fable", () => {
  const ids = Object.keys(dispatchPart(FREE, LIQUID).questions)
  expect(ids).toEqual(['route', 'stakes.undo', 'stakes.live', 'stakes.access', 'cause_unknown', 'effort'])
  const question = dispatchPart(FREE, LIQUID).questions.route
  expect(question?.type === 'choice' && Object.keys(question.criteria)).toEqual(['fast', 'standard', 'powerful'])
  const withFable = dispatchPart(FREE, FABLE).questions.route
  expect(withFable?.type === 'choice' && Object.keys(withFable.criteria)).toEqual(['fast', 'standard', 'powerful', 'frontier'])
  expect(JSON.stringify(question)).toContain('Which model tier should handle the work in `brief.prompt`?')
  // Jev's keeps its table.
  expect(Object.keys(dispatchPart(FREE).questions)).toContain('writes')
})

test('the route takes its top tier; below a confidence of 0.5 the strongest model allowed; a tier ruled out gives way to the allowed one rated highest', () => {
  const all = ['haiku', 'sonnet', 'opus'] as const
  expect(readRoute(route({ fast: 0.7, standard: 0.2, powerful: 0.1 }, 0.6), all, all, 0.5)).toMatchObject({ tier: 'fast', wanted: 'haiku', model: 'haiku', fellBack: false })
  expect(readRoute(route({ fast: 0.45, standard: 0.4, powerful: 0.15 }, 0.3), all, all, 0.5)).toMatchObject({ tier: 'fast', wanted: 'opus', model: 'opus', fellBack: true })
  expect(readRoute(route({ fast: 0.45, standard: 0.4, powerful: 0.15 }, 0.3), [...all, 'fable'], [...all, 'fable'], 0.5)).toMatchObject({ wanted: 'fable', model: 'fable' })
  // The strongest ruled out on a fall back: the next strongest allowed.
  expect(readRoute(route({ fast: 0.45, standard: 0.4, powerful: 0.15 }, 0.3), all, ['haiku', 'sonnet'], 0.5)).toMatchObject({ wanted: 'opus', model: 'sonnet', fellBack: true })
  // The top tier's model ruled out: the allowed tier the route rates highest.
  expect(readRoute(route({ fast: 0.1, standard: 0.3, powerful: 0.6 }, 0.7), all, ['haiku', 'sonnet'], 0.5)).toMatchObject({ wanted: 'opus', model: 'sonnet', replaced: 'standard' })
  expect(readRoute(route({ fast: 0.1, standard: 0.3, powerful: 0.6 }, 0.7), all, [], 0.5)).toMatchObject({ model: null, replaced: null })
  // A frontier share is not read while fable is not offered.
  expect(readRoute(route({ standard: 0.3, frontier: 0.7 }, 0.9), all, all, 0.5)).toMatchObject({ tier: 'standard', model: 'sonnet' })
  expect(readRoute(noul(0.9), all, all, 0.5)).toBeNull()
})

test("the main agent's pick is raised, never lowered; the person's named model comes first, read at Liquid's 0.8", () => {
  const answers = (tier: Record<string, number>, confidence = 0.9) => ({ route: route(tier, confidence), effort: score([0, 1, 0, 0, 0]) })
  const kept = decideDispatch(answers({ fast: 1 }), { ...FREE, requested_model: 'sonnet' }, LIQUID)
  expect(kept).toMatchObject({ model: 'sonnet', source: 'requested', requested: { model: 'sonnet', outcome: 'kept' }, route: { wanted: 'haiku' } })
  const raised = decideDispatch(answers({ powerful: 1 }), { ...FREE, requested_model: 'sonnet' }, LIQUID)
  expect(raised).toMatchObject({ model: 'opus', source: 'route', requested: { model: 'sonnet', outcome: 'upgraded' } })
  expect(raised.steps.find((step) => step.rule === 'main-pick')).toMatchObject({ by: 'route', table: 'opus', outcome: 'upgraded' })
  const words = { ...FREE, user_message: 'use haiku for this' }
  expect(decideDispatch({ ...answers({ powerful: 1 }), 'named.haiku': noul(0.9) }, words, LIQUID)).toMatchObject({ model: 'haiku', source: 'user', route: null })
  expect(decideDispatch({ ...answers({ powerful: 1 }), 'named.haiku': noul(0.8) }, words, LIQUID)).toMatchObject({ model: 'opus', source: 'route' })
  // Ruled out at the same bar: 0.8 is no ban.
  expect(decideDispatch({ ...answers({ powerful: 1 }), 'banned.opus': noul(0.8) }, { ...FREE, user_message: 'no opus' }, LIQUID).model).toBe('opus')
  expect(decideDispatch({ ...answers({ powerful: 0.9, standard: 0.1 }), 'banned.opus': noul(0.9) }, { ...FREE, user_message: 'no opus' }, LIQUID)).toMatchObject({ model: 'sonnet', banned: ['opus'] })
})

test("an agent's effort on d1-ultra: the floors at Liquid's bars, no row 3b, and a fall back adds no floor of its own", () => {
  const unsure = decideDispatch({ route: route({ standard: 0.5, powerful: 0.5 }, 0.2), effort: score([1, 0, 0, 0, 0]), 'stakes.undo': noul(0.75) }, FREE, LIQUID)
  // The stakes in the band: high; opus from the fall back; nothing lifts to max.
  expect(unsure).toMatchObject({ model: 'opus', effort: 'high', route: { fellBack: true } })
  expect(unsure.steps.map((step) => step.rule)).not.toContain('unsure')
  expect(decideDispatch({ route: route({ standard: 1 }, 0.9), effort: score([1, 0, 0, 0, 0]), cause_unknown: noul(0.9) }, FREE, LIQUID)).toMatchObject({ model: 'sonnet', effort: 'xhigh' })
  // An unsure effort answer goes one level up, as a message's does.
  expect(decideDispatch({ route: route({ fast: 1 }, 0.9), effort: score([0, 1, 0, 0, 0], 0.3) }, FREE, LIQUID)).toMatchObject({ model: 'haiku', effort: 'high' })
})

// ---- setup and the backend -------------------------------------------------------------------------

test("decisionModel d1-ultra: Liquid's guide and defaults; the images still go to Jev with a TypeSafe key, and never to d1-ultra", () => {
  const ctx = setup({ decisionModel: 'd1-ultra', liquidApiKey: 'liquid_k', typesafeApiKey: 'ts-k' })
  expect(ctx.config).toMatchObject({ backend: 'd1-ultra', guide: { name: 'liquid' }, timeoutMs: BACKEND_DEFAULTS['d1-ultra'].timeoutMs, longWaitMs: null })
  expect(ctx.backend.name).toBe('d1-ultra')
  expect(ctx.images?.name).toBe('jev')
  expect(setup({ decisionModel: 'd1-ultra', liquidApiKey: 'liquid_k' }).images).toBeNull()
  expect(readConfig({}).guide.name).toBe('typesafe')
  // The key is not enumerable: a config written out carries none.
  expect(JSON.stringify(readConfig({ liquidApiKey: 'liquid_secret' }))).not.toContain('liquid_secret')
})

const io = (reply: (url: string, body: string) => { status: number; text: string; headers?: Record<string, string> }) => {
  const sent: { url: string; headers: Record<string, string>; body: string }[] = []
  return {
    sent,
    io: {
      fetch: async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
        sent.push({ url, headers: init.headers ?? {}, body: init.body ?? '' })
        const answer = reply(url, init.body ?? '')
        return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, headers: answer.headers ?? {}, text: answer.text }
      },
      sleep: () => new Promise<void>(() => {}),
    },
  }
}

test("the backend posts TypeSafe's request to Liquid, pinned to d1-ultra; no key sends nothing; a 429 is busy, with its Retry-After", async () => {
  const request = { state: { user_message: 'hi' }, questions: { q: { type: 'noul' as const, instructions: 'Is it a greeting?' } } }
  const ok = io(() => ({ status: 200, text: JSON.stringify({ model: 'd1-ultra', answers: { q: { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 40 } }) }))
  const asked = await liquidBackend('liquid_k').ask(ok.io as never, request, 1000)
  expect(asked).toMatchObject({ ok: true, model: 'd1-ultra', inputTokens: 40 })
  expect(ok.sent[0]?.url).toBe(LIQUID_URL)
  expect(JSON.parse(ok.sent[0]?.body ?? '{}')).toEqual({ model: LIQUID_MODEL, state: request.state, questions: request.questions })
  expect(ok.sent[0]?.headers.authorization).toBe('Bearer liquid_k')

  const none = await liquidBackend('').ask(ok.io as never, request, 1000)
  expect(none).toEqual({ ok: false, failure: { kind: 'config', detail: 'no Liquid API key: set liquidApiKey or LIQUID_API_KEY' } })
  expect(failureLine('d1-ultra', (none as unknown as { failure: never }).failure)).toBe('d1-ultra：没有填 liquidApiKey 或 LIQUID_API_KEY')
  expect(ok.sent).toHaveLength(1)

  const busy = io(() => ({ status: 429, text: '{"error":"rate limited"}', headers: { 'retry-after': '1' } }))
  const limited = await liquidBackend('liquid_k').ask(busy.io as never, request, 1000)
  expect(limited).toMatchObject({ ok: false, failure: { kind: 'busy', status: 429, retryAfterMs: 1000 } })
  expect(failureLine('d1-ultra', (limited as unknown as { failure: never }).failure)).toBe('d1-ultra：被限速（状态码 429）')

  const pictured = await liquidBackend('liquid_k').ask(ok.io as never, { ...request, images: [{ name: 'a', format: 'png', base64: 'AA==', width: 1, height: 1 }] }, 1000)
  expect(pictured).toMatchObject({ ok: false, failure: { kind: 'request' } })
})

// ---- seam 1 ----------------------------------------------------------------------------------------

const D1 = { decisionModel: 'd1-ultra', liquidApiKey: 'liquid_test' }

/** Liquid answering as the fake Jev does, and each route question as `tiers` says with `confidence`. */
const liquid = (levels: number[], extra: { nouls?: Record<string, number>; tiers?: Record<string, number>; confidence?: number } = {}) => (request: Sent): Reply => {
  const base = jev(levels, { nouls: extra.nouls ?? {}, confidence: 0.9 })(request) as { status: number; body: { answers: Record<string, unknown> } }
  for (const id of Object.keys(request.body?.questions ?? {})) {
    if (id.endsWith('.route')) base.body.answers[id] = { type: 'choice', choice: '', probabilities: extra.tiers ?? { standard: 1 }, confidence: extra.confidence ?? 0.9 }
  }
  return base
}

test("with d1-ultra a message goes to Liquid, its answers read at Liquid's bars: a stake at 0.75 is the band, so high, not xhigh", { options: D1 }, async ($, on) => {
  const w = world($, on, { backend: liquid([0, 1, 0, 0, 0], { nouls: { 'effort.stakes.undo': 0.75 } }) })
  await w.submit('把这张表的数据迁过去')
  await w.step({ index: 0 })
  expect(w.requests[0]?.url).toBe(LIQUID_URL)
  expect(w.requests[0]?.body.model).toBe('d1-ultra')
  expect(w.steps.map((s) => s.effort)).toEqual(['high'])
  const entry = (await w.board()).log.find((one) => one.feature === 'main-effort')
  expect(entry?.trace?.find((step) => step.rule === 'stakes')).toMatchObject({ undoVerdict: 'band', yes: 0.8, no: 0.2, inclusive: false })
  // The confidence is read by a rule here, so the log does not say it only goes on record.
  expect(entry?.reason).not.toContain('只记录')
})

test('with d1-ultra a dispatched agent is routed by its tier: powerful raises the main agent\'s sonnet to opus', { options: D1 }, async ($, on) => {
  const w = world($, on, { backend: liquid([0, 0, 1, 0, 0], { tiers: { fast: 0.05, standard: 0.15, powerful: 0.8 } }) })
  await w.spawn({ prompt: 'Find why the payment webhook charges twice and fix it.', model: 'sonnet' })
  expect(Object.keys(w.requests[0]?.body.questions ?? {}).some((id) => id.endsWith('.route'))).toBe(true)
  expect(w.spawned.map((s) => s.model)).toEqual(['opus'])
})

test('d1-ultra without a Liquid key in the options or the environment: nothing is sent, and the board names both places', { options: { decisionModel: 'd1-ultra' } }, async ($, on) => {
  const w = world($, on, { session: true, env: {}, backend: liquid([0, 0, 1, 0, 0]) })
  await w.start()
  await w.submit('解释一下这个函数做了什么')
  await w.step({ index: 0, effort: 'medium' })
  expect(w.requests).toHaveLength(0)
  expect((await w.board()).main).toMatchObject({ routed: false, why: 'd1-ultra：没有填 liquidApiKey 或 LIQUID_API_KEY', failure: { backend: 'd1-ultra', kind: 'config' } })
  expect(w.logs.filter((log) => log.text.startsWith('d1-ultra key:')).map((log) => log.text)).toEqual(['d1-ultra key: not set'])
})

test('d1-ultra takes its key from LIQUID_API_KEY when the option is empty', { options: { decisionModel: 'd1-ultra' } }, async ($, on) => {
  const w = world($, on, { session: true, env: { LIQUID_API_KEY: 'liquid_env' }, backend: liquid([0, 0, 1, 0, 0]) })
  await w.start()
  await w.submit('解释一下这个函数做了什么')
  expect(w.requests.map((request) => request.headers.authorization)).toEqual(['Bearer liquid_env'])
})
