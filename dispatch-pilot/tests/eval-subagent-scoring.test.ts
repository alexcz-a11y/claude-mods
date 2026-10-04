// Scoring the subagent suite (seam 2): each answer graded on its model and
// its effort against the item's acceptable sets, then the run's figures. The
// backend is Jev's own client (jevBackend) over a fake network, so only the
// network is pretend; the expected grades are worked out by hand.

import { expect, test } from 'claude-code/testing'
import type { BackendIo } from '../hooks/decision/backend.ts'
import { jevBackend } from '../hooks/decision/jev.ts'
import type { SubagentItem } from '../eval/lib/datasets.ts'
import { summarize } from '../eval/lib/metrics.ts'
import { runSuite, type Row } from '../eval/lib/runner.ts'
import { subagent } from '../eval/lib/subagent.ts'
import { settingsFrom } from '../eval/lib/suite.ts'

/** An agent item whose message is `<id>（中文）` / `<id> (English)`, so the fake network knows what it is asked about. */
function item(id: string, gold: SubagentItem['gold'], accept: SubagentItem['accept'], more: { requested?: SubagentItem['zh']['requested_model']; tags?: string[]; kind?: 'agent' | 'workflow'; words?: string } = {}): SubagentItem {
  const asked = (message: string): SubagentItem['zh'] => {
    const workflow = more.kind === 'workflow'
    return {
      user_message: message,
      kind: more.kind ?? 'agent',
      agent_type: workflow ? null : 'general-purpose',
      description: workflow ? null : id,
      prompt: `${id}: 按说明处理 \${file}。`,
      requested_model: more.requested ?? null,
      workflow_description: workflow ? '逐个文件处理 → 汇总' : null,
      label: workflow ? `${id}:\${file}` : null,
    }
  }
  return {
    id,
    zh: asked(`${id}（中文）${more.words ?? ''}`),
    en: asked(`${id} (English)${more.words ?? ''}`),
    gold,
    accept,
    rationale: '理由',
    difficulty: 'hard',
    tags: more.tags ?? ['priority:none'],
  }
}

/** What the decision model answers about one agent: the model question, the effort levels (lowest first), yes/no answers by id within the part; a question left out gets no answer. */
type Answers = { model?: Record<string, number>; effort?: readonly number[]; nouls?: Record<string, number> }

/** A fake network: Jev answering each request about `<id> <language>` from `answers`; every reply takes 100 ms of the fake clock. */
function network(answers: Record<string, Answers>) {
  let clock = 0
  const io: BackendIo = {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body))
      const words = String(body.state.user_message)
      const key = words.includes('（中文）') ? `${words.slice(0, words.indexOf('（'))} zh` : `${words.slice(0, words.indexOf(' ('))} en`
      const said = answers[key] ?? {}
      const out: Record<string, unknown> = {}
      for (const [id, question] of Object.entries(body.questions as Record<string, { type: string }>)) {
        const local = id.slice(id.indexOf('.') + 1)
        if (question.type === 'choice') {
          if (said.model) out[id] = { type: 'choice', choice: '', probabilities: said.model, confidence: 0.5 }
        } else if (question.type === 'score') {
          if (said.effort) out[id] = { type: 'score', score: 0, probabilities: Object.fromEntries(said.effort.map((p, i) => [String(i), p])), confidence: 0.6 }
        } else out[id] = { type: 'noul', noul: said.nouls?.[local] ?? 0 }
      }
      clock += 100
      return { status: 200, ok: true, headers: {}, text: JSON.stringify({ model: 'jev-1.13.0', answers: out, usage: { input_tokens: 1600 } }) }
    },
    // The backend's own timeout timer: never fires here; it is aborted once the answer is in.
    sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))),
  }
  return { io, now: () => clock, pause: async () => {} }
}

const HAIKU = { haiku: 0.9, sonnet: 0.05, opus: 0.05 }
const SONNET = { haiku: 0.05, sonnet: 0.9, opus: 0.05 }
const OPUS = { haiku: 0.05, sonnet: 0.05, opus: 0.9 }
const LOW = [1, 0, 0, 0, 0]
const MEDIUM = [0, 1, 0, 0, 0]
const HIGH = [0, 0, 1, 0, 0]
const MAX = [0, 0, 0, 0.2, 0.8]

/** A row as one line: what was decided and how it scored, whole and in parts. */
function line(row: Row<unknown>): string {
  if (!row.ok) return `${row.id} ${row.language}: no answer (${row.failure})`
  const parts = Object.entries(row.parts ?? {}).map(([part, right]) => `${part} ${right ? 'right' : 'wrong'}`).join(', ')
  return `${row.id} ${row.language}: ${row.shown} ${row.correct ? 'right' : `wrong (${row.miss})`}${row.exact ? ', gold' : ''}; ${parts}`
}

test('each answer is graded on its model and on its effort; haiku carries no effort; a miss says which part missed and which way', async () => {
  const items = [
    item('a', { model: 'sonnet', effort: 'high' }, { model: ['sonnet', 'opus'], effort: ['high', 'xhigh'] }),
    item('b', { model: 'haiku', effort: null }, { model: ['haiku'], effort: [null] }),
    item('c', { model: 'haiku', effort: null }, { model: ['haiku', 'sonnet'], effort: [null, 'low'] }),
    item('d', { model: 'opus', effort: 'max' }, { model: ['opus'], effort: ['xhigh', 'max'] }, { requested: 'opus', tags: ['priority:main-kept'] }),
  ]
  const net = network({
    'a zh': { model: OPUS, effort: LOW },
    'a en': { model: SONNET, effort: HIGH },
    'b zh': { model: SONNET, effort: MEDIUM },
    'b en': { model: HAIKU, effort: HIGH },
    'c zh': { model: SONNET, effort: LOW },
    'c en': { model: OPUS, effort: LOW },
    // Sure of haiku (confidence 0.85): the main agent's opus is replaced.
    'd zh': { model: HAIKU, effort: MAX },
    'd en': { model: OPUS, effort: MAX },
  })
  const rows = await runSuite(subagent, items, { backend: jevBackend('k'), ...net, settings: settingsFrom({}), variants: ['models-hint'], timeoutMs: 10_000, retries: 0, concurrency: 1 })

  expect(rows.map(line)).toEqual([
    'a zh: opus low wrong (effort-under); model right, effort wrong',
    'a en: sonnet high right, gold; model right, effort right',
    'b zh: sonnet medium wrong (model-over effort-over); model wrong, effort wrong',
    'b en: haiku right, gold; model right, effort right',
    'c zh: sonnet low right; model right, effort right',
    // accept.effort is one set for every acceptable model: low is acceptable whatever the model.
    'c en: opus low wrong (model-over); model wrong, effort right',
    // Without effort (haiku) where a level is needed: the effort misses too, below.
    'd zh: haiku wrong (model-under effort-under); model wrong, effort wrong',
    'd en: opus max right, gold; model right, effort right',
  ])
})

/**
 * Six items and how each was answered (models-hint, the mod's thresholds),
 * zh | en, with the parts right (model, effort):
 *   a  opus low (model) | sonnet high (both)
 *   b  sonnet medium (none) | haiku (both)
 *   c  sonnet low (both) | opus low (effort)
 *   d  haiku over the main agent's opus, sure at 0.85 (none) | opus max, its pick kept (both)
 *   w  sonnet medium (both) | sonnet high (both)      a workflow's agent
 *   u  sonnet, named at 0.8 (both) | haiku, named at only 0.3 (none)
 */
const SIX = [
  item('a', { model: 'sonnet', effort: 'high' }, { model: ['sonnet', 'opus'], effort: ['high', 'xhigh'] }),
  item('b', { model: 'haiku', effort: null }, { model: ['haiku'], effort: [null] }),
  item('c', { model: 'haiku', effort: null }, { model: ['haiku', 'sonnet'], effort: [null, 'low'] }),
  item('d', { model: 'opus', effort: 'max' }, { model: ['opus'], effort: ['xhigh', 'max'] }, { requested: 'opus', tags: ['priority:main-kept'] }),
  item('w', { model: 'sonnet', effort: 'medium' }, { model: ['sonnet'], effort: ['medium', 'high'] }, { kind: 'workflow', tags: ['priority:none', 'fan-out'] }),
  item('u', { model: 'sonnet', effort: 'low' }, { model: ['sonnet'], effort: ['low', 'medium'] }, { tags: ['priority:user'], words: ' 这次用 sonnet' }),
]

const SIX_ANSWERS: Record<string, Answers> = {
  'a zh': { model: OPUS, effort: LOW },
  'a en': { model: SONNET, effort: HIGH },
  'b zh': { model: SONNET, effort: MEDIUM },
  'b en': { model: HAIKU, effort: HIGH },
  'c zh': { model: SONNET, effort: LOW },
  'c en': { model: OPUS, effort: LOW },
  'd zh': { model: HAIKU, effort: MAX },
  'd en': { model: OPUS, effort: MAX },
  'w zh': { model: SONNET, effort: MEDIUM },
  'w en': { model: SONNET, effort: HIGH },
  'u zh': { model: HAIKU, effort: LOW, nouls: { 'named.sonnet': 0.8 } },
  'u en': { model: HAIKU, effort: LOW, nouls: { 'named.sonnet': 0.3 } },
}

async function runSix() {
  const settings = settingsFrom({})
  const rows = await runSuite(subagent, SIX, { backend: jevBackend('k'), ...network(SIX_ANSWERS), settings, variants: ['models-hint'], timeoutMs: 10_000, retries: 0, concurrency: 1 })
  return summarize(subagent, SIX, rows, { slowMs: 1500, settings })
}

test('a run reports the model, the effort and the whole answer right in each language, by tag, and for each constant answer', async () => {
  const summary = await runSix()
  const [v] = summary.variants
  // zh: model a c w u, effort c w u, both c w u; en: model a b d w, effort all but u, both a b d w.
  expect(v?.zh.parts).toEqual({ model: 0.6667, effort: 0.5 })
  expect(v?.zh.accuracy).toBe(0.5)
  expect(v?.en.parts).toEqual({ model: 0.6667, effort: 0.8333 })
  expect(v?.en.accuracy).toBe(0.6667)
  expect(v?.tags).toEqual([
    { tag: 'priority:none', items: 4, wrong: { zh: 2, en: 1 }, parts: { model: { zh: 1, en: 1 }, effort: { zh: 2, en: 0 } } },
    { tag: 'priority:main-kept', items: 1, wrong: { zh: 1, en: 0 }, parts: { model: { zh: 1, en: 0 }, effort: { zh: 1, en: 0 } } },
    { tag: 'priority:user', items: 1, wrong: { zh: 0, en: 1 }, parts: { model: { zh: 0, en: 1 }, effort: { zh: 0, en: 1 } } },
    { tag: 'fan-out', items: 1, wrong: { zh: 0, en: 0 }, parts: { model: { zh: 0, en: 0 }, effort: { zh: 0, en: 0 } } },
  ])
  // Always haiku: right on b and c. Always sonnet high: sonnet is acceptable on a c w u, high on a w.
  expect(summary.constants.find((c) => c.answer === 'haiku')).toEqual({ answer: 'haiku', accuracy: 0.3333, exact: 0.3333, parts: { model: 0.3333, effort: 0.3333 } })
  expect(summary.constants.find((c) => c.answer === 'sonnet high')).toEqual({ answer: 'sonnet high', accuracy: 0.3333, exact: 0.1667, parts: { model: 0.6667, effort: 0.3333 } })
})

test("the suite's own figures: each part agreed on in both languages, each kind of agent, where the model came from in each priority case", async () => {
  const [v] = (await runSix()).variants
  expect(v?.breakdown).toMatchObject({
    // Answered in both languages: all six; the same model only for w, the same effort only for c.
    agreement: { items: 6, model: 0.1667, effort: 0.1667 },
    kinds: [
      { kind: 'agent', items: 5, wrong: { zh: 3, en: 2 }, parts: { model: { zh: 2, en: 2 }, effort: { zh: 3, en: 1 } } },
      { kind: 'workflow', items: 1, wrong: { zh: 0, en: 0 }, parts: { model: { zh: 0, en: 0 }, effort: { zh: 0, en: 0 } } },
    ],
    // d: overridden in zh, the main agent's pick kept in en; u: named in zh only.
    sources: {
      'priority:none': { zh: { decided: 4 }, en: { decided: 4 } },
      'priority:main-kept': { zh: { decided: 1 }, en: { requested: 1 } },
      'priority:user': { zh: { user: 1 }, en: { decided: 1 } },
    },
  })
})

type Rates = { model: number; effort: number; joint: number }
type Swept = { value: number; current?: true; zh: Rates; en: Rates }

test("thresholds are swept over the answers already given, nothing asked again; at the run's own values the sweep is the run", async () => {
  const [v] = (await runSix()).variants
  const sweeps = v?.breakdown?.sweeps as Record<string, Swept[]>
  const at = (name: string, value: number) => sweeps[name]?.find((swept) => swept.value === value)

  expect(at('thetaOverride', 0.6)).toEqual({ value: 0.6, current: true, zh: { model: 0.6667, effort: 0.5, joint: 0.5 }, en: { model: 0.6667, effort: 0.8333, joint: 0.6667 } })
  // At 0.9 the main agent's opus stands on d in zh (haiku was 0.85 sure), and opus max is right.
  expect(at('thetaOverride', 0.9)).toEqual({ value: 0.9, zh: { model: 0.8333, effort: 0.6667, joint: 0.6667 }, en: { model: 0.6667, effort: 0.8333, joint: 0.6667 } })
  expect(sweeps.thetaOverride?.map((swept) => swept.value)).toEqual([0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1])
  // At 0.3 sonnet counts as named on u in en (0.3) as well; at 0.9 not even in zh (0.8).
  expect(at('thetaNamed', 0.5)?.current).toBe(true)
  expect(at('thetaNamed', 0.3)?.en).toEqual({ model: 0.8333, effort: 1, joint: 0.8333 })
  expect(at('thetaNamed', 0.9)?.zh).toEqual({ model: 0.5, effort: 0.3333, joint: 0.3333 })
  expect(sweeps.thetaMax?.find((swept) => swept.current)?.value).toBe(0.5)
  // requested_fits is asked only when the main agent's pick is a question of its own (noul).
  expect(sweeps.thetaFit).toBeUndefined()
})

test("in the noul variants the main agent's pick goes only when the work is also outside it (requested_fits under thetaFit), swept as well", async () => {
  const items = [SIX[3] as SubagentItem]
  const settings = settingsFrom({ agentOverride: 0.7 })
  const net = network({ 'd zh': { model: HAIKU, effort: MAX, nouls: { requested_fits: 0.4 } }, 'd en': { model: HAIKU, effort: MAX, nouls: { requested_fits: 0.6 } } })
  const rows = await runSuite(subagent, items, { backend: jevBackend('k'), ...net, settings, variants: ['models-noul'], timeoutMs: 10_000, retries: 0, concurrency: 1 })
  const [v] = summarize(subagent, items, rows, { slowMs: 1500, settings }).variants
  const sweeps = v?.breakdown?.sweeps as Record<string, Swept[]>

  // Sure of haiku (0.85 over agentOverride 0.7); the opus pick goes only where it is said not to fit (zh 0.4).
  expect(rows.map((row) => `${row.language} ${row.shown}`)).toEqual(['zh haiku', 'en opus max'])
  expect(sweeps.thetaFit?.map((swept) => `${swept.value}${swept.current ? ' (now)' : ''}: zh ${swept.zh.joint}, en ${swept.en.joint}`)).toEqual(['0.3: zh 1, en 1', '0.5 (now): zh 0, en 1', '0.7: zh 0, en 0'])
  // The run's own agentOverride is among the values swept, marked as the run's.
  expect(sweeps.thetaOverride?.filter((swept) => swept.current).map((swept) => swept.value)).toEqual([0.7])
})

test('what an answer records: where its model came from, the pick and its confidence, and the raw answers to decide again from', async () => {
  const items = [item('d', { model: 'opus', effort: 'max' }, { model: ['opus'], effort: ['xhigh', 'max'] }, { requested: 'opus', tags: ['priority:main-kept'], words: ' 别用 sonnet' })]
  const net = network({ 'd zh': { model: { haiku: 0.9, sonnet: 0.02, opus: 0.08 }, effort: MAX, nouls: { 'named.sonnet': 0.1, 'banned.sonnet': 0.95 } } })
  const [row] = await runSuite(subagent, items, { backend: jevBackend('k'), ...net, settings: settingsFrom({}), variants: ['models-hint'], languages: ['zh'], timeoutMs: 10_000, retries: 0, concurrency: 1 })

  expect(row?.shown).toBe('haiku')
  // Among the models not ruled out (haiku, opus): p 0.9 / 0.98 is confidence 0.84.
  expect(row?.detail).toEqual({
    source: 'decided',
    pick: 'haiku',
    confidence: 0.837,
    p_model: { haiku: 0.9, sonnet: 0.02, opus: 0.08 },
    p_effort: [0, 0, 0, 0.2, 0.8],
    nouls: { 'named.sonnet': 0.1, 'banned.sonnet': 0.95 },
  })
})

test('no decision is a failure that says why: no answer about the agent, every model offered ruled out, or no probability left on the rest', async () => {
  const items = [
    item('e', { model: 'sonnet', effort: 'low' }, { model: ['sonnet'], effort: ['low'] }, { words: ' 别用 haiku、sonnet 和 opus' }),
    item('f', { model: 'sonnet', effort: 'low' }, { model: ['sonnet'], effort: ['low'] }),
    // The main agent's opus is ruled out, and the answer puts everything on opus: no model is left.
    item('g', { model: 'sonnet', effort: 'low' }, { model: ['sonnet'], effort: ['low'] }, { requested: 'opus', words: ' 别用 opus', tags: ['priority:main-overridden'] }),
  ]
  const net = network({
    'e zh': { model: SONNET, effort: LOW, nouls: { 'banned.haiku': 0.9, 'banned.sonnet': 0.9, 'banned.opus': 0.9 } },
    'f zh': {},
    'g zh': { model: { haiku: 0, sonnet: 0, opus: 1 }, effort: LOW, nouls: { 'banned.opus': 0.9 } },
  })
  const rows = await runSuite(subagent, items, { backend: jevBackend('k'), ...net, settings: settingsFrom({}), variants: ['models-hint'], languages: ['zh'], timeoutMs: 10_000, retries: 0, concurrency: 1 })

  expect(rows.map(line)).toEqual([
    'e zh: no answer (none: every model offered was ruled out: haiku, sonnet, opus)',
    'f zh: no answer (parse: no answer about the agent)',
    'g zh: no answer (none: opus was ruled out, and the answer gives the other models no probability)',
  ])
})
