// Every option, set to another of its choices, changes what the mod does (the user's question of 2026-11-19: does each
// change really take effect?). The manifest check proves each option is read; this proves an effect: for each key, one
// scenario run twice, with the option at its default and at the value tests/support/option-changes.ts names, and the
// two outcomes it observes (a level or model decided, a request sent or not, a note written or not, a time limit
// passed, a pane opened) differ. eval/validate.ts holds that list to the manifest; this file holds its entries to the list.
import { expect, test } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'
import type { On, PluginOptions } from 'claude-code'

import { DREX_URL, JEV_URL } from '../hooks/backend.ts'
import type { Decision } from '../hooks/log.ts'
import { LISTING_NOTE } from '../hooks/skills.ts'
import { optionKeys } from '../eval/lib/manifest.ts'
import { CHANGED } from './support/option-changes.ts'
import { WATCHER, WIRE, viaWire } from './support/plugins.ts'
import { assistantToolUse, scriptByPoll, toolResult } from './support/rows.ts'
import { KEYS, appendAll, complete, dp, drexOk, noul, score, spawn, start, step, submit, turnStart, turns, world } from './support/world.ts'

type Key = keyof typeof CHANGED
type World = ReturnType<typeof world>
type Answers = Record<string, unknown>

const TASK = 'Fix the flaky retry in the uploader'
const PDF = { name: 'pdf', description: 'Fill in, merge and split PDF files.' }
const XLSX = { name: 'anthropic-skills:xlsx', description: 'Read, write and chart spreadsheets.' }
const LISTING = ['The following skills are available for use with the Skill tool:', '', ...[PDF, XLSX].map((s) => `- ${s.name}: ${s.description}`)].join('\n')

const logged = (w: World): Decision[] => (w.storeWrites.filter((s) => s.key === 'log').at(-1)?.value ?? []) as Decision[]
const ofKind = (w: World, kind: Decision['kind']): Decision[] => logged(w).filter((d) => d.kind === kind)
const midrunAsked = (w: World) => w.fetched.filter((f) => 'same_failure' in f.body.questions).length
const agentAsked = (w: World) => w.fetched.filter((f) => 'read_only' in f.body.questions).length
const mainEfforts = (w: World) => w.stepsSent.filter((s) => s.agentId === undefined).map((s) => s.effort)

// Answers that move nothing from where they are read, unless a scenario names others.
const FLAT = { open: score([0.05, 0.3, 0.3, 0.3, 0.05]), mechanical: noul(0.1), unknown_cause: noul(0.1) }
const FLAGS_NO = { same_failure: noul(0.1), cause_found: noul(0.1), only_carrying_out: noul(0.1), contradicts_plan: noul(0.1) }
const MID_HOLD = { open: score([0.05, 0.3, 0.3, 0.3, 0.05]), ...FLAGS_NO }
const AGENT_HOLD = { ...FLAT, read_only: noul(0.1) }
// From medium: 0.90 above it, so the message's level is high.
const RAISE = { ...FLAT, open: score([0.02, 0.08, 0.25, 0.55, 0.1]) }
const SAME_FAILURE = { ...MID_HOLD, same_failure: noul(0.9) }

type Skilled = { gates: { acts: number; procedure: number; prose: number; named: number }; pick: string; fits: number }
/** models: the model each answer names, request by request (past the list, the one asked). */
type Plan = { submit?: Answers; midrun?: Answers; agent?: Answers; skill?: Skilled; refuse?: (url: string) => boolean; models?: string[] }
/** The kind of request a body is: mid-run (same_failure), an agent's (read_only), else a message's. */
const kindOf = (questions: Answers): 'midrun' | 'agent' | 'submit' => ('same_failure' in questions ? 'midrun' : 'read_only' in questions ? 'agent' : 'submit')

// A choice answer over the options asked: the one named weighs 1, the rest 0.01.
function choiceOf(options: string[], pick: string) {
  const raw = options.map((o) => (o === pick ? 1 : 0.01))
  const sum = raw.reduce((s, x) => s + x, 0)
  const probabilities = Object.fromEntries(options.map((o, i) => [o, raw[i]! / sum]))
  return { type: 'choice', choice: options.includes(pick) ? pick : options[0], probabilities }
}

/** Answers every question a request asks as the plan says; `late` holds one kind of request on the mock clock first. */
function answering(p: Plan, late?: { clock: MockClock | null; kind: 'submit' | 'midrun' | 'agent'; ms: number }) {
  let answered = 0
  return async ({ url, body }: { url: string; body: any }) => {
    if (p.refuse?.(url) === true) return null
    // A model request another plugin sends (verifyEffort's scenario): answered as the engine's stream begins.
    if (body?.questions === undefined) return 'event: message_start'
    const q = body.questions as Record<string, any>
    const kind = kindOf(q)
    const model: string = p.models?.[answered++] ?? body.model
    if (late !== undefined && late.kind === kind) await late.clock!.sleep(late.ms)
    if (kind === 'midrun') return drexOk(p.midrun ?? MID_HOLD, model)
    if (kind === 'agent') return drexOk(p.agent ?? AGENT_HOLD, model)
    const s = p.skill
    const gate: Record<string, number> = s === undefined ? {} : { acts_on_user_system: s.gates.acts, would_follow_documented_procedure: s.gates.procedure, prose_suffices: s.gates.prose, named: s.gates.named }
    const out: Answers = {}
    for (const [id, x] of Object.entries(q)) {
      if (['open', 'mechanical', 'unknown_cause', 'continues'].includes(id)) out[id] = ((p.submit ?? FLAT) as Answers)[id] ?? noul(0.1)
      else if (id.startsWith('skill_') || id === 'which') out[id] = choiceOf(Object.keys(x.criteria), s?.pick ?? '')
      else if (id.startsWith('fits_')) out[id] = noul(/Does the skill '([^']+)'/.exec(x.instructions)?.[1] === s?.pick ? (s?.fits ?? 0.1) : 0.1)
      else out[id] = noul(gate[id] ?? 0.1)
    }
    return drexOk(out, model)
  }
}

// The scenarios. Each returns what it observes.

/** A message sent and its turn's first step at `base`: the levels the main loop's steps carried. */
async function message($: Engine, base = 'medium') {
  await start($)
  await submit($, TASK)
  await step($, { turnId: 't1', index: 0, effort: base })
}

/** A Code Mode turn: the message at `base`, then scripts 1 to n, each with the step after it. */
async function scripts($: Engine, n: number, base = 'medium') {
  await message($, base)
  for (let i = 1; i <= n; i++) {
    await appendAll($, scriptByPoll(i, `script ${i}`, `FAIL test_upload (${i})`))
    await step($, { turnId: 't1', index: i, effort: base })
  }
}

/** The main loop at `level`, then two spawns of one type: the first teaches the type, the second is judged with it known. */
async function agents($: Engine, level = 'high', parentModel?: string) {
  const parent = parentModel === undefined ? {} : { parentModel }
  await start($)
  await turnStart($, 't1', TASK)
  await step($, { turnId: 't1', index: 0, effort: level })
  await spawn($, { tool_use_id: 'toolu_teach', ...parent })
  await spawn($, parent)
}
const lastAgent = (w: World) => ofKind(w, 'agent').at(-1)?.to

/** The listing folded, then a message: the requests sent and whether a skill was suggested beside the message. */
async function skillMessage($: Engine, w: World) {
  await start($)
  await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } })
  await submit($, 'Fill in the tax form in form.pdf')
  return { requests: w.fetched.length, suggested: w.submitted[0]?.context !== undefined }
}

/** Where a key went: in the authorization header of a request, and anywhere else the mod writes or sends. */
function keyTrail(w: World, key: string) {
  const elsewhere = JSON.stringify([w.fetched.map((f) => [f.url, f.body]), w.storeWrites, w.stateWrites, w.logs, w.statuses])
  return { asked: w.fetched.length, inHeader: w.fetched.some((f) => f.headers.authorization === `Bearer ${key}`), elsewhere: elsewhere.includes(key) }
}

type Ctx = { $: Engine; on: On }
type Entry = {
  /** The options both runs start from (KEYS when left out); the entry's key is set on top in the second run. */
  base?: PluginOptions
  plugins?: Plugin[]
  observe: (c: Ctx) => Promise<unknown>
  byDefault: unknown
  /** What the second run observes. */
  changed: unknown
}

/** A world whose answers follow the plan and a scenario on it. */
const run = (o: { plan?: Plan; pane?: 'placed' }, go: ($: Engine, w: World) => Promise<unknown>) => async ({ $, on }: Ctx) => {
  const w = world(on, { onSubmit: turns($), answer: answering(o.plan ?? {}), ...(o.pane === undefined ? {} : { pane: o.pane }) })
  return go($, w)
}

/** As run, with one kind of request held `ms` on the mock clock while the scenario's first move waits. */
const timed = (kind: 'submit' | 'midrun' | 'agent', ms: number, plan: Plan, go: ($: Engine, w: World, held: () => Promise<void>) => Promise<unknown>) => async ({ $, on }: Ctx) => {
  const late: { clock: MockClock | null; kind: typeof kind; ms: number } = { clock: null, kind, ms }
  const w = world(on, { onSubmit: turns($), answer: answering(plan, late) })
  late.clock = w.clock
  return go($, w, async () => {
    await w.clock.settle()
    await w.clock.advance(ms)
  })
}

const EFFECTS: Record<Key, Entry> = {
  enabled: { observe: run({}, async ($, w) => (await message($), w.fetched.length)), byDefault: 1, changed: 0 },
  board: { observe: run({ pane: 'placed' }, async ($, w) => (await start($), await dp($), w.opened.length)), byDefault: 1, changed: 0 },
  mode: { observe: run({ plan: { submit: RAISE } }, async ($, w) => (await message($), mainEfforts(w))), byDefault: ['high'], changed: ['medium'] },
  backend: { base: { drexApiKey: 'k-drex', jevApiKey: 'k-jev' }, observe: run({}, async ($, w) => (await message($), w.fetched.map((f) => f.url))), byDefault: [DREX_URL], changed: [JEV_URL] },
  drexApiKey: {
    base: {},
    observe: run({}, async ($, w) => (await message($), keyTrail(w, CHANGED.drexApiKey))),
    byDefault: { asked: 0, inHeader: false, elsewhere: false },
    changed: { asked: 1, inHeader: true, elsewhere: false },
  },
  jevApiKey: {
    base: { backend: 'jev' },
    observe: run({}, async ($, w) => (await message($), keyTrail(w, CHANGED.jevApiKey))),
    byDefault: { asked: 0, inHeader: false, elsewhere: false },
    changed: { asked: 1, inHeader: true, elsewhere: false },
  },
  // Two messages, answered first by drex-v2.0, then by drex-max-v1.1: the model asked for, and each answer's failure.
  // The option names the model sent and the one an answer must come from, so the answer accepted moves with it.
  drexModel: {
    observe: run({ plan: { models: [CHANGED.drexModel, 'drex-max-v1.1'] } }, async ($, w) => {
      await message($)
      await complete($, 't1')
      await submit($, 'Now the downloader')
      await step($, { turnId: 't2', index: 0, effort: 'medium' })
      return [w.fetched.map((f) => f.body.model), ofKind(w, 'submit').map((d) => d.failure)]
    }),
    byDefault: [['drex-max-v1.1', 'drex-max-v1.1'], ['model-mismatch', null]],
    changed: [['drex-v2.0', 'drex-v2.0'], [null, 'model-mismatch']],
  },
  // Jev is asked by the name given and answers with the version it resolved to; it is not held to it.
  jevModel: {
    base: { backend: 'jev', jevApiKey: 'k-jev' },
    observe: run({ plan: { models: ['jev-1.13.2'] } }, async ($, w) => (await message($), [w.fetched.map((f) => f.body.model), ofKind(w, 'submit').map((d) => d.failure)])),
    byDefault: [['jev-latest'], [null]],
    changed: [['jev-1.14.0'], [null]],
  },
  fallback: {
    base: { drexApiKey: 'k-drex', jevApiKey: 'k-jev' },
    observe: run({ plan: { submit: RAISE, refuse: (url) => url === DREX_URL } }, async ($, w) => (await message($), [w.fetched.map((f) => f.url), mainEfforts(w)])),
    byDefault: [[DREX_URL], ['medium']],
    changed: [[DREX_URL, JEV_URL], ['high']],
  },
  submitShift: { observe: run({ plan: { submit: RAISE } }, async ($, w) => (await message($), [w.fetched.length, mainEfforts(w)])), byDefault: [1, ['high']], changed: [0, ['medium']] },
  midrunShift: { observe: run({ plan: { midrun: SAME_FAILURE } }, async ($, w) => (await scripts($, 1), [midrunAsked(w), mainEfforts(w)])), byDefault: [1, ['medium', 'high']], changed: [0, ['medium', 'medium']] },
  agentShift: { observe: run({}, async ($, w) => (await agents($), agentAsked(w))), byDefault: 2, changed: 0 },
  skills: {
    observe: run({}, async ($, w) => (await start($), (await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } })).text === LISTING_NOTE)),
    byDefault: true,
    changed: false,
  },
  progressNote: { observe: run({}, async ($, w) => (await scripts($, 1), w.completes.length)), byDefault: 1, changed: 0 },
  progressNoteModel: { observe: run({}, async ($, w) => (await scripts($, 1), w.completes.map((c) => c.model))), byDefault: ['haiku'], changed: ['sonnet'] },
  verifyEffort: {
    plugins: [WATCHER, WIRE],
    observe: run({}, async ($) => {
      await start($)
      const r = await viaWire($, 'https://api.anthropic.com/v1/messages?beta=true', { method: 'POST', body: '{}' })
      return r.headers['x-links']!.split(',').includes('dispatch-pilot')
    }),
    byDefault: true,
    changed: false,
  },
  midrunEverySteps: {
    observe: run({}, async ($, w) => {
      await message($)
      await appendAll($, [assistantToolUse('Read', { file_path: 'upload.ts' }), toolResult('Read', 'upload.ts')])
      return midrunAsked(w)
    }),
    byDefault: 0,
    changed: 1,
  },
  midrunEveryScripts: { observe: run({}, async ($, w) => (await scripts($, 1), midrunAsked(w))), byDefault: 1, changed: 0 },
  midrunShiftGap: { observe: run({ plan: { midrun: SAME_FAILURE } }, async ($, w) => (await scripts($, 2), midrunAsked(w))), byDefault: 1, changed: 2 },
  midrunMaxNotes: { observe: run({ plan: { midrun: SAME_FAILURE } }, async ($, w) => (await scripts($, 1), [midrunAsked(w), mainEfforts(w)])), byDefault: [1, ['medium', 'high']], changed: [0, ['medium', 'medium']] },
  agentModels: {
    observe: run({ plan: { agent: { ...AGENT_HOLD, mechanical: noul(0.9), read_only: noul(0.9) } } }, async ($, w) => (await agents($), lastAgent(w))),
    byDefault: 'haiku · medium',
    changed: 'sonnet · medium',
  },
  fableAgents: { observe: run({}, async ($, w) => (await agents($, 'high', 'claude-fable-5-2'), lastAgent(w))), byDefault: 'opus · high', changed: 'inherit · high' },
  // The answer comes 3000 ms after the message: within the default 4000, past 2000.
  submitTimeoutMs: {
    observe: timed('submit', 3000, { submit: RAISE }, async ($, w, held) => {
      await start($)
      const sent = submit($, TASK)
      await held()
      await sent
      await step($, { turnId: 't1', index: 0, effort: 'medium' })
      return [ofKind(w, 'submit')[0]?.failure ?? null, mainEfforts(w)]
    }),
    byDefault: [null, ['high']],
    changed: ['timeout', ['medium']],
  },
  // 1500 ms: within the default 2000, past 1000.
  midrunTimeoutMs: {
    observe: timed('midrun', 1500, { midrun: SAME_FAILURE }, async ($, w, held) => {
      await message($)
      const rows = appendAll($, scriptByPoll(1, 'script 1', 'FAIL test_upload'))
      await held()
      await rows
      return ofKind(w, 'midrun')[0]?.failure ?? null
    }),
    byDefault: null,
    changed: 'timeout',
  },
  // 2500 ms: within the default 3000, past 2000.
  agentTimeoutMs: {
    observe: timed('agent', 2500, {}, async ($, w, held) => {
      await start($)
      await turnStart($, 't1', TASK)
      await step($, { turnId: 't1', index: 0, effort: 'high' })
      const spawned = spawn($)
      await held()
      await spawned
      return ofKind(w, 'agent')[0]?.failure ?? null
    }),
    byDefault: null,
    changed: 'timeout',
  },
  // The message's level from the session's own: 0.90 above medium.
  submitUp: { observe: run({ plan: { submit: RAISE } }, async ($, w) => (await message($), mainEfforts(w))), byDefault: ['high'], changed: ['medium'] },
  // From high: 0.80 above it, into xhigh.
  submitUpHigh: { observe: run({ plan: { submit: { ...FLAT, open: score([0, 0, 0.2, 0.75, 0.05]) } } }, async ($, w) => (await message($, 'high'), mainEfforts(w))), byDefault: ['xhigh'], changed: ['high'] },
  // From medium: 0.75 below it.
  submitDown: { observe: run({ plan: { submit: { ...FLAT, open: score([0.75, 0.1, 0.1, 0.05, 0]) } } }, async ($, w) => (await message($), mainEfforts(w))), byDefault: ['low'], changed: ['medium'] },
  // From xhigh, open holds it; mechanical at 0.75 caps it at medium when read as yes.
  submitYes: {
    observe: run({ plan: { submit: { ...FLAT, open: score([0, 0, 0.1, 0.8, 0.1]), mechanical: noul(0.75) } } }, async ($, w) => (await message($, 'xhigh'), mainEfforts(w))),
    byDefault: ['medium'],
    changed: ['xhigh'],
  },
  midrunUp: { observe: run({ plan: { midrun: { ...MID_HOLD, open: score([0.05, 0.2, 0.6, 0.1, 0.05]) } } }, async ($, w) => (await scripts($, 1), mainEfforts(w))), byDefault: ['medium', 'high'], changed: ['medium', 'medium'] },
  midrunUpHigh: {
    observe: run({ plan: { submit: RAISE, midrun: { ...MID_HOLD, open: score([0, 0.05, 0.1, 0.8, 0.05]) } } }, async ($, w) => (await scripts($, 1), ofKind(w, 'midrun').map((d) => d.to))),
    byDefault: ['xhigh'],
    changed: ['high'],
  },
  midrunDown: {
    observe: run({ plan: { submit: RAISE, midrun: { ...MID_HOLD, open: score([0.05, 0.7, 0.2, 0.05, 0]), cause_found: noul(0.9) } } }, async ($, w) => (await scripts($, 1), ofKind(w, 'midrun').map((d) => d.to))),
    byDefault: ['medium'],
    changed: ['high'],
  },
  midrunYes: { observe: run({ plan: { midrun: { ...MID_HOLD, same_failure: noul(0.75) } } }, async ($, w) => (await scripts($, 1), mainEfforts(w))), byDefault: ['medium', 'high'], changed: ['medium', 'medium'] },
  // An agent from the main loop's medium: 0.75 above it.
  agentUp: { observe: run({ plan: { agent: { ...AGENT_HOLD, open: score([0.1, 0.15, 0.5, 0.2, 0.05]) } } }, async ($, w) => (await agents($, 'medium'), lastAgent(w))), byDefault: 'inherit · high', changed: 'inherit · medium' },
  agentUpHigh: { observe: run({ plan: { agent: { ...AGENT_HOLD, open: score([0, 0.05, 0.1, 0.8, 0.05]) } } }, async ($, w) => (await agents($), lastAgent(w))), byDefault: 'inherit · xhigh', changed: 'inherit · high' },
  // The lowest level at 0.90 (the two lowest take sonnet either way): held at the default 0.95, down at 0.70.
  agentDown: { observe: run({ plan: { agent: { ...AGENT_HOLD, open: score([0.9, 0, 0.1, 0, 0]) } } }, async ($, w) => (await agents($), lastAgent(w))), byDefault: 'sonnet · high', changed: 'sonnet · low' },
  agentYes: {
    observe: run({ plan: { agent: { ...AGENT_HOLD, open: score([0, 0, 0.8, 0.15, 0.05]), mechanical: noul(0.75) } } }, async ($, w) => (await agents($), lastAgent(w))),
    byDefault: 'inherit · medium',
    changed: 'inherit · high',
  },
  agentModelDown: {
    observe: run({ plan: { agent: { ...AGENT_HOLD, open: score([0, 0.1, 0.8, 0.1, 0]), mechanical: noul(0.85), read_only: noul(0.85) } } }, async ($, w) => (await agents($), lastAgent(w))),
    byDefault: 'haiku · medium',
    changed: 'inherit · medium',
  },
  // The action answers' mean 0.50: past the default 0.30, short of 0.60.
  skillAction: {
    observe: run({ plan: { skill: { gates: { acts: 0.5, procedure: 0.5, prose: 0.5, named: 0.1 }, pick: 'pdf', fits: 0.9 } } }, async ($, w) => skillMessage($, w)),
    byDefault: { requests: 2, suggested: true },
    changed: { requests: 1, suggested: false },
  },
  skillNamed: {
    observe: run({ plan: { skill: { gates: { acts: 0.1, procedure: 0.2, prose: 0.6, named: 0.75 }, pick: 'pdf', fits: 0.9 } } }, async ($, w) => skillMessage($, w)),
    byDefault: { requests: 2, suggested: true },
    changed: { requests: 1, suggested: false },
  },
  skillFits: {
    observe: run({ plan: { skill: { gates: { acts: 0.8, procedure: 0.6, prose: 0.2, named: 0.1 }, pick: 'pdf', fits: 0.4 } } }, async ($, w) => skillMessage($, w)),
    byDefault: { requests: 2, suggested: true },
    changed: { requests: 2, suggested: false },
  },
}

test('每个选项都有一项，没有多出的：和 option-changes.ts 一致，也和 readConfig 读的选项一致', () => {
  const keys = Object.keys(EFFECTS).sort()
  expect(keys).toEqual(Object.keys(CHANGED).sort())
  expect(keys).toEqual([...optionKeys()].sort())
})

for (const [key, e] of Object.entries(EFFECTS) as [Key, Entry][]) {
  const options: PluginOptions = { ...(e.base ?? KEYS) }
  const extra = e.plugins === undefined ? {} : { plugins: e.plugins }
  test(`${key}：默认值`, { options, ...extra }, async ($, on) => {
    expect(await e.observe({ $, on })).toEqual(e.byDefault)
  })
  const value = CHANGED[key]
  const changedOptions: PluginOptions = { ...options, [key]: value }
  test(`${key}：改成 ${String(value)}，结果不同`, { options: changedOptions, ...extra }, async ($, on) => {
    expect(e.changed).not.toEqual(e.byDefault)
    expect(await e.observe({ $, on })).toEqual(e.changed)
  })
}
