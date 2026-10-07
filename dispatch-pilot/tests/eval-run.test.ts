// Running a suite (seam 2's runner): every item asked in both languages under
// each variant, through a backend the way the mod asks it, each answer
// graded against the item's accept set. The backend here is Jev's own client
// (jevBackend) over a fake network, so only the network is pretend.

import { expect, test } from 'claude-code/testing'
import type { BackendIo } from '../hooks/decision/backend.ts'
import { EFFORTS } from '../hooks/decision/effort.ts'
import { jevBackend } from '../hooks/decision/jev.ts'
import type { EffortSubmitItem } from '../eval/lib/datasets.ts'
import { effortSubmit } from '../eval/lib/effort-submit.ts'
import { attemptMs, runSuite } from '../eval/lib/runner.ts'
import { optionsFor, optionsFrom, settingsFrom, settingsModel } from '../eval/lib/suite.ts'

function item(id: string, message: string, gold: EffortSubmitItem['gold'], accept: EffortSubmitItem['accept'], tags: string[] = []): EffortSubmitItem {
  return {
    id,
    zh: { message: `${message}（中文）`, recent_context: [] },
    en: { message: `${message} (English)`, recent_context: [] },
    gold,
    accept,
    rationale: '理由',
    difficulty: 'hard',
    tags,
  }
}

/** One HTTP reply of the fake network: a status and a JSON body. */
type Reply = { status: number; body: unknown }

/** A Jev answer putting `p` on the levels, lowest first, for whichever primitive the request asked with. */
function answer(body: any, p: readonly number[]): Reply {
  const [id, question] = Object.entries(body.questions as Record<string, { type: string }>)[0] as [string, { type: string }]
  const probabilities = Object.fromEntries(EFFORTS.map((level, i) => [question.type === 'score' ? String(i) : level, p[i] ?? 0]))
  return { status: 200, body: { model: 'jev-1.13.0', answers: { [id]: { type: question.type, probabilities, confidence: 0.5, score: 0, choice: '' } }, usage: { input_tokens: 700 } } }
}

/** A fake network: `reply` answers each request; every reply takes 120 ms of the fake clock; the runner's pauses are recorded. */
function network(reply: (body: any, n: number) => Reply) {
  let clock = 0
  const bodies: any[] = []
  const pauses: number[] = []
  const pause = async (ms: number) => {
    pauses.push(ms)
  }
  const io: BackendIo = {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body))
      bodies.push(body)
      const { status, body: out } = reply(body, bodies.length)
      clock += 120
      return { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify(out) }
    },
    // The backend's own timeout timer: never fires here; it is aborted once the answer is in.
    sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))),
  }
  return { io, bodies, pauses, pause, now: () => clock }
}

const HIGH = [0, 0.1, 0.6, 0.2, 0.1]
const XHIGH = [0, 0, 0.3, 0.6, 0.1]
const MEDIUM = [0.1, 0.6, 0.2, 0.1, 0]
const LOW = [0.7, 0.2, 0.1, 0, 0]

test('each item is asked in both languages under each variant, as the mod asks it, and graded against its accept set', async () => {
  const items = [item('a', '把登录拆成三层', 'high', ['high', 'xhigh']), item('b', '改个错别字', 'low', ['low'])]
  const net = network((body) => {
    const message = String(body.state.user_message)
    if (message.startsWith('把登录')) return answer(body, message.endsWith('（中文）') ? XHIGH : HIGH)
    return answer(body, message.endsWith('（中文）') ? MEDIUM : LOW)
  })

  const rows = await runSuite(effortSubmit, items, {
    backend: jevBackend('k'),
    io: net.io,
    now: net.now,
    pause: net.pause,
    settings: settingsFrom({}),
    variants: ['en-score', 'zh-choice'],
    timeoutMs: 10_000,
    retries: 2,
    concurrency: 3,
  })

  expect(rows.map((r) => `${r.id} ${r.variant} ${r.language}: ${r.shown} ${r.correct ? 'right' : `wrong (${r.miss})`}${r.exact ? ', gold' : ''}`)).toEqual([
    'a en-score zh: xhigh right',
    'a en-score en: high right, gold',
    'a zh-choice zh: xhigh right',
    'a zh-choice en: high right, gold',
    'b en-score zh: medium wrong (over)',
    'b en-score en: low right, gold',
    'b zh-choice zh: medium wrong (over)',
    'b zh-choice en: low right, gold',
  ])
  // What each answer records: the reading (for calibrating thresholds later), who answered, at what cost.
  expect(rows[0]).toMatchObject({ ok: true, attempts: 1, inputTokens: 700, model: 'jev-1.13.0', failure: null })
  expect(rows[0]?.detail).toEqual({ p: [0, 0, 0.3, 0.6, 0.1], confidence: 0.5 })
  expect(rows[0]?.state).toEqual({ user_message: '把登录拆成三层（中文）', recent_context: '' })
  // The variant decides how the question is written; the person's words go as they are.
  const asked = net.bodies.filter((b) => b.state.user_message === '把登录拆成三层 (English)')
  expect(asked.map((b) => b.questions['effort.level'].type).sort()).toEqual(['choice', 'score'])
  const choice = asked.find((b) => b.questions['effort.level'].type === 'choice')
  expect(JSON.stringify(choice.questions)).toContain('逐步推理')
  expect(Object.keys(choice.questions['effort.level'].criteria)).toEqual([...EFFORTS])
})

test('a busy backend is asked again after a pause; a refused key is not; an unanswered item counts as wrong and says why', async () => {
  const items = [item('a', '把登录拆成三层', 'high', ['high', 'xhigh']), item('b', '改个错别字', 'low', ['low'])]
  const net = network((body, n) => {
    if (String(body.state.user_message).startsWith('改个')) return { status: 401, body: { detail: 'bad key' } }
    return n === 1 ? { status: 529, body: { detail: 'overloaded' } } : answer(body, HIGH)
  })

  const rows = await runSuite(effortSubmit, items, {
    backend: jevBackend('k'),
    io: net.io,
    now: net.now,
    pause: net.pause,
    settings: settingsFrom({}),
    variants: ['en-score'],
    languages: ['zh'],
    timeoutMs: 10_000,
    retries: 2,
    concurrency: 1,
  })

  // Only the answered attempt's time is its latency (each reply takes 120 ms here).
  expect(rows[0]).toMatchObject({ id: 'a', ok: true, shown: 'high', correct: true, attempts: 2, ms: 120 })
  expect(rows[1]).toMatchObject({ id: 'b', ok: false, shown: null, correct: false, exact: false, attempts: 1, ms: null })
  expect(rows[1]?.failure).toMatch(/^config: HTTP 401/)
  // One pause of a second before the second attempt.
  expect(net.pauses).toEqual([1000])
})

// The options a run asks with: what the engine hands the mod (the manifest's
// defaults), then each `--option name=value`, read by the type the manifest
// gives the option.
const USER_CONFIG = {
  contextTokens: { type: 'number', default: 2000 },
  agentFable: { type: 'boolean', default: false },
  workflowMode: { type: 'string', default: 'rewrite' },
  skillsNeverSuggested: { type: 'string', multiple: true, default: [] },
}

test('a run reads each --option by the type the manifest gives it: a number, true or false, or the text; the rest keep their defaults', () => {
  const options = optionsFrom(USER_CONFIG, ['agentFable=true', 'contextTokens=4000', 'skillsNeverSuggested=tdd,pdf'])
  expect(options).toEqual({ contextTokens: 4000, agentFable: true, workflowMode: 'rewrite', skillsNeverSuggested: 'tdd,pdf' })
  // Read as the mod reads them: fable offered, the two skills never suggested.
  const settings = settingsFrom(options)
  expect(settings.agents.models).toContain('fable')
  expect(settings.skills.neverSuggested).toEqual(['tdd', 'pdf'])
  expect(optionsFrom(USER_CONFIG, ['agentFable=false']).agentFable).toBe(false)
})

test('an --option the manifest does not have, or a value its type cannot take, is refused with the reason', () => {
  expect(() => optionsFrom(USER_CONFIG, ['contextToken=4000'])).toThrow('no option "contextToken" in the manifest')
  expect(() => optionsFrom(USER_CONFIG, ['agentFable=yes'])).toThrow('agentFable takes true or false, not "yes"')
  expect(() => optionsFrom(USER_CONFIG, ['contextTokens=lots'])).toThrow('contextTokens takes a number, not "lots"')
  expect(() => optionsFrom(USER_CONFIG, ['contextTokens'])).toThrow('--option takes name=value, not contextTokens')
})

// Perplexity's decision model (#43) is not one of the mod's two choices (`decisionModel`), so a run on it reads the
// mod's settings as Jev's: the same budgets, the same timeout, the same question language. Then a comparison with
// Jev differs in the model alone.
test("a run on Perplexity asks with Jev's settings: the budgets, the timeout and the question language", () => {
  const userConfig = {}
  const pplx = settingsFrom(optionsFor(settingsModel('pplx'), userConfig))
  const jevSettings = settingsFrom(optionsFor(settingsModel('jev'), userConfig))
  expect(pplx).toEqual(jevSettings)
  expect([pplx.backend, pplx.timeoutMs, pplx.context.tokens, pplx.turnStartLanguage]).toEqual(['jev', 1500, 6000, 'zh'])
  expect(settingsModel('clef')).toBe('clef')
})

// How long the eval (and scripts/decide*.ts) gives one attempt unless told: four times the mod's timeoutMs, at least
// 10 s, so a slow answer is still measured and a cold connection's first request does not fail outright.
test("an attempt may take four times the mod's timeoutMs, at least 10 s: Jev's 1500 ms gives 10 s, Clef's 3000 ms 12 s", () => {
  expect([attemptMs(settingsFrom({}).timeoutMs), attemptMs(settingsFrom({ decisionModel: 'clef' }).timeoutMs), attemptMs(5000)]).toEqual([10_000, 12_000, 20_000])
})
