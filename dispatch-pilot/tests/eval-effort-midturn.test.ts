// The effort-midturn suite of the eval (seam 2): what it sends for an item is
// what the mod sends mid-turn for that turn (checked against the mod itself,
// through seam 1's world); how it grades an answer and records what the mod
// would do with it; its variants; and what its report adds (keeping the
// current level as a baseline, accuracy by the way the level should move).

import { expect, test } from 'claude-code/testing'
import type { PluginOptions, SessionMessage } from 'claude-code'
import type { BackendIo } from '../hooks/decision/backend.ts'
import type { Effort } from '../hooks/decision/effort.ts'
import { JEV_MODEL, jevBackend } from '../hooks/decision/jev.ts'
import type { EffortMidturnItem } from '../eval/lib/datasets.ts'
import { effortMidturn, midturnRequest } from '../eval/lib/effort-midturn.ts'
import { summarize } from '../eval/lib/metrics.ts'
import { runSuite, type Row } from '../eval/lib/runner.ts'
import { settingsFrom } from '../eval/lib/suite.ts'
import { jev, world, type Sent, type ToolRun, type World } from './support/world.ts'

/** The ids of a request's questions: `effort.level` when a message is sent, `midturn.level` mid-turn. */
function kind(request: Sent | undefined): string {
  // The unresolved question travels in the message's effort request (#39); these tests are about the others.
  return Object.keys(request?.body?.questions ?? {})
    .filter((id) => id !== 'effort.unresolved')
    .join(',')
}

/** A turn as the main agent works it: the person's message, then each step's text and tool calls. */
type Turn = { message: string; steps: { answer: string; tools: ToolRun[] }[] }

/** The same turn in each language: logs read, a file not found, another path tried. */
const TURNS: Record<'zh' | 'en', Turn> = {
  zh: {
    message: '修复登录接口偶发 502 的问题',
    steps: [
      { answer: '先看看日志。', tools: [{ tool: 'Bash', input: { command: 'tail -n 50 logs/app.log', description: '查看最近的日志' } }] },
      { answer: '读一下代理配置。', tools: [{ tool: 'Read', input: { file_path: '/repo/src/server/proxy.ts' }, ends: { error: 'File does not exist.' } }] },
      { answer: '换个路径再读。', tools: [{ tool: 'Read', input: { file_path: '/repo/src/proxy.ts' } }] },
    ],
  },
  en: {
    message: 'Fix the intermittent 502 on the login endpoint',
    steps: [
      { answer: 'Checking the logs first.', tools: [{ tool: 'Bash', input: { command: 'tail -n 50 logs/app.log', description: 'Show the latest log lines' } }] },
      { answer: 'Reading the proxy config.', tools: [{ tool: 'Read', input: { file_path: '/repo/src/server/proxy.ts' }, ends: { error: 'File does not exist.' } }] },
      { answer: 'Trying another path.', tools: [{ tool: 'Read', input: { file_path: '/repo/src/proxy.ts' } }] },
    ],
  },
}

/**
 * The turn above as an item, as the dataset writes it: each call's input (the
 * arguments that say what it worked on) and its result in the dataset's own
 * words, what came of it included. It is what the mod reads when the third
 * step's call starts (the re-decision for step 3, every 3 steps by default).
 * Unlike a dataset row, its latest call is still running ("进行中",
 * "Running"): a live request goes out as a call starts, a dataset row only
 * holds calls that have ended.
 */
const ITEM: EffortMidturnItem = {
  id: 'midturn-900',
  zh: {
    message: '修复登录接口偶发 502 的问题',
    step: 3,
    current_effort: 'high',
    counts: { judgments: 1, changes: 0, failures: 1, hook_blocks: 0 },
    recent_steps: [
      { assistant_text: '先看看日志。', tools: [{ name: 'Bash', result: '成功：最近 50 行里有 3 次 upstream timeout', input: { command: 'tail -n 50 logs/app.log', description: '查看最近的日志' } }] },
      { assistant_text: '读一下代理配置。', tools: [{ name: 'Read', result: '失败：文件不存在', input: { file_path: '/repo/src/server/proxy.ts' } }] },
      { assistant_text: '换个路径再读。', tools: [{ name: 'Read', result: '进行中', input: { file_path: '/repo/src/proxy.ts' } }] },
    ],
  },
  en: {
    message: 'Fix the intermittent 502 on the login endpoint',
    step: 3,
    current_effort: 'high',
    counts: { judgments: 1, changes: 0, failures: 1, hook_blocks: 0 },
    recent_steps: [
      { assistant_text: 'Checking the logs first.', tools: [{ name: 'Bash', result: 'Success: 3 upstream timeouts in the last 50 lines', input: { command: 'tail -n 50 logs/app.log', description: 'Show the latest log lines' } }] },
      { assistant_text: 'Reading the proxy config.', tools: [{ name: 'Read', result: 'Failed: the file does not exist', input: { file_path: '/repo/src/server/proxy.ts' } }] },
      { assistant_text: 'Trying another path.', tools: [{ name: 'Read', result: 'Running', input: { file_path: '/repo/src/proxy.ts' } }] },
    ],
  },
  gold: 'high',
  accept: ['high', 'xhigh'],
  rationale: '还在排查 502 的根因，路径不对，需要继续调试。',
  difficulty: 'hard',
  tags: ['debug'],
}

/** The person sends the turn's message (Jev answers high), then the main agent works its steps. */
async function play(w: World, turn: Turn): Promise<void> {
  await w.submit(turn.message)
  for (const [index, step] of turn.steps.entries()) await w.step({ index, answer: step.answer, tools: step.tools })
}

for (const language of ['zh', 'en'] as const) {
  test(`the eval's request for an item is the mod's mid-turn request for that turn (${language})`, { options: { typesafeApiKey: 'k' } }, async ($, on) => {
    const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
    await play(w, TURNS[language])

    const { request } = midturnRequest(ITEM, language, 'en-score', settingsFrom({}))
    expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level'])
    expect(w.requests[1]?.body).toEqual({ model: JEV_MODEL, state: request.state, questions: request.questions })
    // What the request holds, so the equality above is not two empty things;
    // each call as the mod writes it, from how it ended and what it worked on: never what came of it.
    expect(request.state.current_effort).toBe('high')
    expect((request.state.recent_steps as unknown[]).length).toBe(3)
    expect(Object.keys(request.questions)).toEqual(['midturn.level'])
    expect(JSON.stringify(request)).not.toContain('upstream')
  })
}

test("the raw-results variant sends each call's result as the dataset writes it, what came of it included: the gap to what the mod sends", () => {
  const lines = (variant: string) =>
    (midturnRequest(ITEM, 'zh', variant, settingsFrom({})).request.state.recent_steps as { tools: { result: string }[] }[]).flatMap((step) => step.tools.map((tool) => tool.result))
  expect(lines('en-score')).toEqual(['成功：查看最近的日志', '失败：server/proxy.ts', '进行中：src/proxy.ts'])
  expect(lines('raw-results')).toEqual(['成功：最近 50 行里有 3 次 upstream timeout', '失败：文件不存在', '进行中'])
})

test("the eval reads the re-decision's limits as the mod does: the latest rejudgeSteps steps, within contextTokens", { options: { typesafeApiKey: 'k', rejudgeSteps: 2, contextTokens: 300 } }, async ($, on) => {
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]) })
  await play(w, TURNS.zh)

  const { request } = midturnRequest(ITEM, 'zh', 'en-score', settingsFrom({ rejudgeSteps: 2, contextTokens: 300 }))
  expect(w.requests[1]?.body).toEqual({ model: JEV_MODEL, state: request.state, questions: request.questions })
  expect((request.state.recent_steps as { assistant_text: string }[]).map((step) => step.assistant_text)).toEqual(['读一下代理配置。', '换个路径再读。'])
})

/** Two failed test runs: the point where #7 asks again about a stuck turn, with its trouble. */
const STUCK: EffortMidturnItem = {
  id: 'midturn-901',
  zh: {
    message: '登录后偶尔被踢回登录页，查一下 session 过期的逻辑',
    step: 2,
    current_effort: 'high',
    counts: { judgments: 1, changes: 0, failures: 2, hook_blocks: 0 },
    recent_steps: [
      { assistant_text: '先跑一下测试。', tools: [{ name: 'Bash', result: '失败：session 相关的 2 个用例失败', input: { command: 'npm test', description: '跑单元测试' } }] },
      {
        assistant_text: '改一下过期判断再跑。',
        tools: [
          { name: 'Edit', result: '成功：过期判断改成 >=', input: { file_path: '/repo/src/auth/session.ts' } },
          { name: 'Bash', result: '失败：还是那 2 个用例失败', input: { command: 'npm test', description: '再跑单元测试' } },
        ],
      },
    ],
  },
  en: {
    message: 'Logging in sometimes bounces me back to the login page; look into the session expiry logic',
    step: 2,
    current_effort: 'high',
    counts: { judgments: 1, changes: 0, failures: 2, hook_blocks: 0 },
    recent_steps: [
      { assistant_text: 'Running the tests first.', tools: [{ name: 'Bash', result: 'Failed: 2 session cases fail', input: { command: 'npm test', description: 'Run the unit tests' } }] },
      {
        assistant_text: 'Fixing the expiry check and running them again.',
        tools: [
          { name: 'Edit', result: 'Success: the expiry check is now >=', input: { file_path: '/repo/src/auth/session.ts' } },
          { name: 'Bash', result: 'Failed: the same 2 cases still fail', input: { command: 'npm test', description: 'Run the unit tests again' } },
        ],
      },
    ],
  },
  gold: 'xhigh',
  accept: ['xhigh'],
  rationale: '两次修复都失败，问题没找到根因。',
  difficulty: 'hard',
  tags: ['stuck'],
}

/**
 * The turn of STUCK as `$.session.messages()` holds it the moment its second
 * test run has failed (`ids`: the calls' ids, in order): the person's message,
 * then its two steps; the second run has no result in it yet.
 */
function stuckRows(ids: readonly string[]): SessionMessage[] {
  const [first = '', edit = '', second = ''] = ids
  return [
    { role: 'user', text: STUCK.zh.message, toolUses: [] },
    { role: 'assistant', text: '先跑一下测试。', toolUses: [{ tool_use_id: first, tool: 'Bash', input: { command: 'npm test', description: '跑单元测试' }, text: 'FAIL src/auth.test.ts', isError: true }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: first, text: 'FAIL src/auth.test.ts', isError: true }] },
    { role: 'assistant', text: '改一下过期判断再跑。', toolUses: [{ tool_use_id: edit, tool: 'Edit', input: { file_path: '/repo/src/auth/session.ts', old_string: 'a', new_string: 'b' }, text: 'ok' }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: second, tool: 'Bash', input: { command: 'npm test', description: '再跑单元测试' } }] },
  ]
}

test("the trouble variant asks a stuck item exactly what the mod asks a turn whose failures reach escalateAfter: the trouble, the effort question with its flag, and whether the failures were expected", { options: { typesafeApiKey: 'k', rejudgeEvery: 0 } }, async ($, on) => {
  let calls: readonly { id: string }[] = []
  const w = world($, on, { backend: jev([0, 0, 1, 0, 0]), messages: () => stuckRows(calls.map((call) => call.id)) })
  calls = w.toolCalls
  await w.submit(STUCK.zh.message)
  await w.step({ index: 0, answer: '先跑一下测试。', tools: [{ tool: 'Bash', input: { command: 'npm test', description: '跑单元测试' }, ends: { error: 'FAIL src/auth.test.ts' } }] })
  await w.step({
    index: 1,
    answer: '改一下过期判断再跑。',
    tools: [
      { tool: 'Edit', input: { file_path: '/repo/src/auth/session.ts', old_string: 'a', new_string: 'b' } },
      { tool: 'Bash', input: { command: 'npm test', description: '再跑单元测试' }, ends: { error: 'FAIL src/auth.test.ts' } },
    ],
  })

  const { request } = midturnRequest(STUCK, 'zh', 'trouble', settingsFrom({ rejudgeEvery: 0 }))
  // Asked as the second failed run ended, for step 2.
  expect(w.requests.map(kind)).toEqual(['effort.level', 'midturn.level,escalation.expected'])
  expect(w.requests[1]?.body).toEqual({ model: JEV_MODEL, state: request.state, questions: request.questions })
  // What the request holds, so the equality above is not two empty things.
  expect(request.state.trouble).toBe('2 tool calls have failed while working on this request')
  expect(request.state.step).toBe(2)
  expect(Object.keys(request.questions)).toEqual(['midturn.level', 'escalation.expected'])
})

/**
 * A fake network under Jev's own client: `reply` gives each request's level
 * probabilities and confidence (Jev's answer is built by seam 1's `jev`);
 * the bodies sent are recorded.
 */
function network(reply: (body: any) => { levels: number[]; confidence: number }) {
  const bodies: any[] = []
  const io: BackendIo = {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body))
      bodies.push(body)
      const { levels, confidence } = reply(body)
      const answer = jev(levels, { confidence })({ url: '', method: 'POST', headers: {}, body, at: 0 })
      return { status: 200, ok: true, headers: {}, text: JSON.stringify('body' in answer ? answer.body : {}) }
    },
    sleep: (_ms, signal) => new Promise((_done, fail) => signal.addEventListener('abort', () => fail(new Error('aborted')))),
  }
  return { io, bodies }
}

/** Runs the suite over `items` through the fake network: no pauses, no clock. */
function run(items: EffortMidturnItem[], net: ReturnType<typeof network>, variants: string[], options: PluginOptions = {}) {
  return runSuite(effortMidturn, items, {
    backend: jevBackend('k'),
    io: net.io,
    now: () => 0,
    pause: async () => {},
    settings: settingsFrom(options),
    variants,
    timeoutMs: 10_000,
    retries: 0,
    concurrency: 1,
  })
}

test('an answer is graded on the level it picks; the level the mod would then go on at is recorded beside it, with each level’s probability and the confidence', async () => {
  // Current level high. In Chinese the answer says xhigh, surely enough to raise;
  // in English low, not surely enough to lower: the mod would stay at high, but the pick is wrong.
  const net = network((body) =>
    String(body.state.user_message).startsWith('修复') ? { levels: [0, 0.1, 0.2, 0.6, 0.1], confidence: 0.7 } : { levels: [0.7, 0.2, 0.1, 0, 0], confidence: 0.5 },
  )
  const rows = await run([ITEM], net, ['en-score'])

  expect(rows.map((r) => `${r.language}: ${r.shown} ${r.correct ? 'right' : `wrong (${r.miss})`}${r.exact ? ', gold' : ''}`)).toEqual(['zh: xhigh right', 'en: low wrong (under)'])
  expect(rows.map((r) => r.detail)).toEqual([
    { p: [0, 0.1, 0.2, 0.6, 0.1], confidence: 0.7, sent: 'xhigh', why: 'up' },
    { p: [0.7, 0.2, 0.1, 0, 0], confidence: 0.5, sent: 'high', why: 'unsure' },
  ])
})

test('the other variants write the question in Chinese, or leave the current level or the counts out of the state', async () => {
  const net = network(() => ({ levels: [0, 0, 1, 0, 0], confidence: 0.7 }))
  const rows = await run([ITEM], net, ['zh-score', 'no-current-effort', 'no-counts'])

  expect(rows.filter((r) => r.language === 'zh').map((r) => `${r.variant}: ${Object.keys(r.state ?? {}).join(', ')}`)).toEqual([
    'zh-score: user_message, step, current_effort, counts, recent_steps',
    'no-current-effort: user_message, step, counts, recent_steps',
    'no-counts: user_message, step, current_effort, recent_steps',
  ])
  // Asked in the order zh-score (zh, en), no-current-effort (zh, en), no-counts (zh, en).
  expect(net.bodies.map((body) => /剩下的工作/.test(JSON.stringify(body.questions['midturn.level'].instructions)))).toEqual([true, true, false, false, false, false])
  expect(rows.every((r) => r.correct)).toBe(true)
})

const LOW = [0.9, 0.1, 0, 0, 0]
const XHIGH = [0, 0, 0.1, 0.8, 0.1]

// The thresholds are read from the options as the mod reads them: the level
// recorded as sent is the level the mod's next step goes out at.
for (const { options, answer, sent } of [
  { options: {}, answer: LOW, sent: 'medium' }, // sure enough to drop, one level down
  { options: { thetaDown: 0.9 }, answer: LOW, sent: 'high' }, // not sure enough to drop
  { options: { thetaUp: 0.9 }, answer: XHIGH, sent: 'high' }, // not sure enough to raise
]) {
  test(`the level the eval records as sent is the one the mod goes on at after the same answer (${JSON.stringify(options)})`, { options: { typesafeApiKey: 'k', ...options } }, async ($, on) => {
    const w = world($, on, { backend: (request) => (kind(request) === 'midturn.level' ? jev(answer, { confidence: 0.8 })(request) : jev([0, 0, 1, 0, 0])(request)) })
    await play(w, TURNS.zh)
    await w.step({ index: 3 })

    const [row] = await run([ITEM], network(() => ({ levels: answer, confidence: 0.8 })), ['en-score'], options)
    expect(w.steps.map((step) => step.effort)).toEqual(['high', 'high', 'high', sent])
    expect(row?.detail?.sent).toBe(sent)
  })
}

/** An item at `current` whose answer is `gold` (any acceptable level in `accept`). */
function at(id: string, current: Effort, gold: Effort, accept: Effort[]): EffortMidturnItem {
  const asked = { ...ITEM.zh, current_effort: current }
  return { ...ITEM, id, zh: asked, en: { ...ITEM.en, current_effort: current }, gold, accept }
}

/** An answer as the runner records it, graded by the suite on the level picked, with the level the mod would send; null when there was none. */
function answered(item: EffortMidturnItem, language: 'zh' | 'en', picked: Effort | null, sent?: Effort): Row<Effort> {
  const grade = picked === null ? { correct: false, exact: false } : effortMidturn.grade(item, picked)
  const failure = picked === null ? 'timeout: no answer in 10000 ms' : null
  const detail = picked === null ? null : { sent: sent ?? picked }
  return { id: item.id, language, variant: 'en-score', ok: picked !== null, prediction: picked, shown: picked, correct: grade.correct, exact: grade.exact, miss: grade.miss ?? null, failure, detail, ms: 300, attempts: 1, inputTokens: 900, model: 'jev-1.13.0', state: null }
}

test('the report scores keeping the current level as a baseline, and gives the accuracy by the way the level should move and of the level the mod would send', () => {
  const items = [
    at('a', 'medium', 'high', ['high', 'xhigh']), // up
    at('b', 'high', 'high', ['medium', 'high']), // keep
    at('c', 'xhigh', 'low', ['low', 'medium']), // down
    at('d', 'low', 'medium', ['low', 'medium']), // up
  ]
  const [a, b, c, d] = items as [EffortMidturnItem, EffortMidturnItem, EffortMidturnItem, EffortMidturnItem]
  const rows = [
    answered(a, 'zh', 'high'), // right; the mod raises to it
    answered(a, 'en', 'medium'), // wrong
    answered(b, 'zh', 'high'), // right
    answered(b, 'en', 'high'), // right
    answered(c, 'zh', 'medium', 'high'), // right, but the mod drops one level only: high, wrong
    answered(c, 'en', 'high'), // wrong
    answered(d, 'zh', 'high'), // wrong
    answered(d, 'en', null), // no answer
  ]
  const summary = summarize(effortMidturn, items, rows, { slowMs: 1500, settings: settingsFrom({}) })

  // Keeping the current level is right on b (gold) and d (acceptable), wrong on a and c.
  expect(summary.constants.find((c) => c.answer === 'current')).toEqual({ answer: 'current', accuracy: 0.5, exact: 0.25 })
  const variant = summary.variants[0]
  expect(variant?.breakdown).toEqual({
    directions: [
      { direction: 'up', items: 2, accuracy: { zh: 0.5, en: 0 } },
      { direction: 'down', items: 1, accuracy: { zh: 1, en: 0 } },
      { direction: 'keep', items: 1, accuracy: { zh: 1, en: 1 } },
    ],
    sent: { zh: 0.5, en: 0.25 },
  })
  expect(variant && effortMidturn.report?.(variant)).toEqual([
    'en-score: right by the way the level should move (zh/en of n): up 50.0%/0.0% of 2, down 100.0%/0.0% of 1, keep 100.0%/100.0% of 1',
    'en-score: the level the mod would go on at (sent) right: zh 50.0%, en 25.0%',
  ])
})

test('below escalateAfter the trouble variant asks as the mod does every N steps; escalateAfter is read as the mod reads it', () => {
  const settings = settingsFrom({})
  expect(ITEM.zh.counts.failures).toBe(1)
  expect(midturnRequest(ITEM, 'zh', 'trouble', settings)).toEqual(midturnRequest(ITEM, 'zh', 'en-score', settings))
  expect(midturnRequest(STUCK, 'zh', 'trouble', settings)).not.toEqual(midturnRequest(STUCK, 'zh', 'en-score', settings))
  // With escalateAfter 3, two failures are not yet a stuck turn.
  const later = settingsFrom({ escalateAfter: 3 })
  expect(midturnRequest(STUCK, 'zh', 'trouble', later)).toEqual(midturnRequest(STUCK, 'zh', 'en-score', later))
})

test("under the trouble variant a stuck item's answer about whether its failures were expected is recorded beside the effort it picked (not graded)", async () => {
  const net = network(() => ({ levels: [0, 0, 0, 1, 0], confidence: 0.8 }))
  const rows = await run([STUCK], net, ['trouble'])

  expect(Object.keys(net.bodies[0]?.questions)).toEqual(['midturn.level', 'escalation.expected'])
  // Seam 1's Jev answers every yes/no question 0.5.
  expect(rows.map((row) => `${row.language} ${row.shown} expected ${String(row.detail?.expected)}`)).toEqual(['zh xhigh expected 0.5', 'en xhigh expected 0.5'])
})
